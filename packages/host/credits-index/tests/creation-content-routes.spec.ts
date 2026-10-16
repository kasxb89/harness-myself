import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Credits from '../src/index.ts'

let context: Context | undefined
let root: string | undefined
let source: Server | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (source !== undefined) await new Promise<void>((resolve, reject) => {
    source?.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
    source?.closeAllConnections()
  })
  source = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('published creation HTTP routes through the real Loader', () => {
  it('reads public content and real media without credentials and removes routes on disposal', async () => {
    const calls: { path: string; authorization: string | undefined; range: string | undefined }[] = []
    const assetId = 'cc_' + 'a'.repeat(64)
    let mode = 'success'
    source = createServer((request, response) => {
      calls.push({ path: request.url ?? '', authorization: request.headers.authorization, range: request.headers.range })
      if (mode === 'redirect') { response.writeHead(302, { location: 'https://untrusted.example' }); response.end(); return }
      if (mode === 'error') { response.writeHead(500); response.end('private upstream diagnostic'); return }
      if (mode === 'range-error') { response.writeHead(416, { 'content-range': 'bytes */12' }); response.end(); return }
      if (request.url === '/api/creation/content') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ success: true, data: {
          schemaVersion: 1, revision: 'publication-one', image: { templates: mode === 'large-content'
            ? Array.from({ length: 500 }, (_, index) => ({
              id: `template-${String(index)}`, categoryId: null, title: { zh: '发布的模板' },
              description: { zh: '管理员编写' }, prompt: { zh: '字'.repeat(1500) },
              coverAssetId: null, demoVideoAssetId: null, status: 'published', sortOrder: index,
            })) : [] },
        } }))
        return
      }
      if (request.url === '/api/creation/assets/' + assetId) {
        response.writeHead(request.headers.range === undefined ? 200 : 206, {
          'content-type': 'video/mp4', 'content-length': '4', 'accept-ranges': 'bytes',
          ...(request.headers.range === undefined ? {} : { 'content-range': 'bytes 0-3/12' }),
        })
        response.end(Buffer.from([0, 1, 2, 3]))
        return
      }
      response.writeHead(404); response.end()
    })
    await new Promise<void>(resolve => source?.listen(0, '127.0.0.1', resolve))
    const address = source.address()
    if (address === null || typeof address === 'string') throw new Error('missing source port')
    root = await mkdtemp(join(tmpdir(), 'dsh-creation-loader-'))
    const stateDir = join(root, 'credits')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-host-webserver'", '  config:', "    host: '127.0.0.1'", '    port: 0',
      "- name: '@deepseek-ai/dsh-system-prompt'", "- name: '@deepseek-ai/dsh-tools'", "- name: '@deepseek-ai/dsh-credits-index'",
      '  config:', `    stateDir: '${stateDir}'`, `    newApiBaseUrl: 'http://127.0.0.1:${String(address.port)}'`, '    timeoutMs: 1000', '',
    ].join('\n'))
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', Tools], ['@deepseek-ai/dsh-credits-index', Credits],
    ])
    context.loader.internal = {
      version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    const base = `http://127.0.0.1:${String(context.webServer.port)}`
    const route = base + '/credits/api/creation/content'
    const content = await fetch(route)
    expect(content.headers.get('cache-control')).toBe('no-store')
    expect(await content.json()).toMatchObject({ ok: true, payload: { revision: 'publication-one' } })
    const assetRoute = base + '/credits/api/creation/assets/' + assetId
    const media = await fetch(assetRoute, { headers: { range: 'bytes=0-3' } })
    expect(media.status).toBe(206)
    expect(media.headers.get('content-range')).toBe('bytes 0-3/12')
    expect(media.headers.get('x-content-type-options')).toBe('nosniff')
    expect([...new Uint8Array(await media.arrayBuffer())]).toEqual([0, 1, 2, 3])
    const head = await fetch(assetRoute, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('4')
    expect(await head.text()).toBe('')
    expect(calls.every(call => call.authorization === undefined)).toBe(true)
    expect(calls[1]?.range).toBe('bytes=0-3')
    mode = 'large-content'
    const largePublication = await fetch(route)
    expect(largePublication.status).toBe(200)
    expect((await largePublication.arrayBuffer()).byteLength).toBeGreaterThan(2 * 1024 * 1024)
    expect((await fetch(route, { headers: { origin: 'https://untrusted.example' } })).status).toBe(403)
    expect((await fetch(base + '/credits/api/creation/assets/invalid')).status).toBe(400)
    expect((await fetch(assetRoute, { headers: { range: 'bytes=-' } })).status).toBe(400)
    mode = 'range-error'
    const unsatisfiable = await fetch(assetRoute, { headers: { range: 'bytes=20-' } })
    expect(unsatisfiable.status).toBe(416)
    expect(unsatisfiable.headers.get('content-range')).toBe('bytes */12')
    mode = 'error'
    expect(await (await fetch(route)).json()).toEqual({ ok: false, code: 'CREATION_CONTENT_UNAVAILABLE' })
    mode = 'redirect'
    expect((await fetch(route)).status).toBe(502)
    const fiber = [...context.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-credits-index')?.fiber
    await fiber?.dispose()
    expect((await fetch(route)).status).toBe(404)
  })
})
