#!/usr/bin/env node
/** Fixed one-shot runner for the bundled public Office batch renderer. */
import { parseArgs } from 'node:util'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const integer = (value, fallback, name) => {
  if (value === undefined) return fallback
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid ${name}`)
  return Number(value)
}

const controller = new AbortController()
const stop = () => { controller.abort(new Error('Office render stopped')) }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
try {
  const { values } = parseArgs({ options: Object.fromEntries([
    'input', 'output-dir', 'pages', 'dpi', 'sheet', 'range', 'max-pages', 'max-pixels', 'max-dimension',
    'cli', 'api', 'cache-dir', 'cache-ttl-ms', 'cache-max-bytes', 'font-inventory', 'timeout-ms',
  ].map(name => [name, { type: 'string' }]).concat([['invalidate-cache', { type: 'boolean' }]])), strict: true, allowPositionals: false })
  for (const key of ['cli', 'api', 'input', 'output-dir', 'cache-dir', 'font-inventory']) {
    if (values[key] !== undefined && !isAbsolute(values[key])) throw new Error(`${key} must be an absolute path`)
  }
  if (values.cli === undefined || (!values['invalidate-cache'] && (values.input === undefined || values['output-dir'] === undefined))) {
    throw new Error('Supply --cli, --input and a new --output-dir; invalidation requires --cli and --cache-dir')
  }
  if (values['invalidate-cache'] && values['cache-dir'] === undefined) throw new Error('Invalidation requires --cache-dir')
  const timeoutMs = integer(values['timeout-ms'], 120000, 'timeout-ms')
  if (timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('Invalid timeout-ms')
  const config = {
    kitCli: values.cli,
    cacheDirectory: values['cache-dir'] ?? join(dirname(values['output-dir']), '.office-render-cache'),
    ttlMs: integer(values['cache-ttl-ms'], 0, 'cache-ttl-ms'),
    maxCacheBytes: integer(values['cache-max-bytes'], 0, 'cache-max-bytes'),
    converterOptions: { timeoutMs },
    ...(values['font-inventory'] === undefined ? {} : { fontInventoryPath: values['font-inventory'] }),
  }
  const lifetime = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
  const api = await import(values.api === undefined
    ? new URL('../../lib/render-cache.js', import.meta.url).href : pathToFileURL(values.api).href)
  if (values['invalidate-cache']) {
    if (values['cache-dir'] === undefined) throw new Error('Invalidation requires --cache-dir')
    await api.invalidateOfficeRenderCache(config, lifetime)
    process.stdout.write(`${JSON.stringify({ ok: true, invalidated: true })}\n`)
  } else {
    const request = { inputPath: values.input, outputDir: values['output-dir'] }
    if (values.pages !== undefined) {
      if (values.pages !== 'all' && !/^[1-9]\d*(?:,[1-9]\d*)*$/u.test(values.pages)) throw new Error('Invalid pages')
      request.pages = values.pages === 'all' ? 'all' : values.pages.split(',').map(Number)
    }
    for (const [flag, field] of [['dpi', 'dpi'], ['max-pages', 'maxPages'], ['max-pixels', 'maxPixels'], ['max-dimension', 'maxDimension']]) {
      if (values[flag] !== undefined) request[field] = integer(values[flag], undefined, flag)
    }
    if (values.sheet !== undefined) request.sheet = values.sheet
    if (values.range !== undefined) request.range = values.range
    const result = await api.renderOfficeBatch(request, config, lifetime)
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, code: typeof error?.code === 'string' ? error.code : 'OFFICE_RENDER_FAILED',
    message: 'Office preview was not completed. The source file is unchanged; check the selected pages and bundled renderer.' })}\n`)
  process.exitCode = 1
} finally {
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
}
