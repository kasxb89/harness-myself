/** One-shot batched Office rendering with optional verified-font, content-addressed disk reuse. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import type { Converter, ConverterOptions, RenderImagesRequest, RenderImagesResult } from '@deepseek-ai/libreoffice-kit'

/** Every cache setting is supplied by the deployment; zero TTL or byte budget disables reuse. */
export interface OfficeRenderCacheConfig {
  readonly kitCli: string
  readonly cacheDirectory: string
  readonly ttlMs: number
  readonly maxCacheBytes: number
  /** Complete trusted inventory: schemaVersion=1, platform, complete=true, absolute roots and files[{path,sha256}]. */
  readonly fontInventoryPath?: string
  readonly converterOptions?: ConverterOptions
}
/** Local cache state does not certify layout, font availability, or a visual inspection. */
export type OfficeBatchRenderResult = RenderImagesResult & {
  readonly cacheHit: boolean
  readonly cacheStatus: 'hit' | 'rendered' | 'unverified-fonts' | 'disabled'
}
/** External engine seam used by the one-shot runner and deterministic tests. */
export interface OfficeRenderRuntime {
  readonly engineIdentity: string
  create(options?: ConverterOptions): Promise<Pick<Converter, 'renderImages' | 'dispose'>>
}
interface Batch { readonly result: RenderImagesResult; readonly bytes: readonly Buffer[] }
interface StoredBatch { readonly created: number; readonly result: RenderImagesResult; readonly hashes: readonly string[] }
const entryName = /^[a-f0-9]{64}$/u
const fontSuffix = /\.(?:ttf|otf|ttc|otc|dfont)$/iu
const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const codeOf = (error: unknown): unknown => record(error) ? error.code : undefined

/** Failed cache coordination never starts another engine while its own producer is still running. */
export class OfficeRenderCacheError extends Error {
  /** Local coordination or validation failure; never a provider/server error classification. */
  readonly code: 'CACHE_BUSY' | 'INVALID_CONFIG' | 'SOURCE_CHANGED' | 'INVALID_RESULT'
  constructor(code: OfficeRenderCacheError['code']) {
    super(`Office render: ${code}`)
    this.code = code
    this.name = 'OfficeRenderCacheError'
  }
}

function validate(config: OfficeRenderCacheConfig, request?: RenderImagesRequest): void {
  if (![config.kitCli, config.cacheDirectory, ...config.fontInventoryPath === undefined ? [] : [config.fontInventoryPath],
    ...request === undefined ? [] : [request.inputPath, request.outputDir]].every(isAbsolute)
    || !Number.isSafeInteger(config.ttlMs) || config.ttlMs < 0 || !Number.isSafeInteger(config.maxCacheBytes) || config.maxCacheBytes < 0) {
    throw new OfficeRenderCacheError('INVALID_CONFIG')
  }
}

/**
 * Resolve only the configured bundled kit; no PATH lookup, download, fallback, or persistent engine.
 * @param kitCli - Absolute CLI path whose adjacent public API owns engine discovery and conversion.
 * @returns Content-identified one-shot runtime factory for the configured Kit installation.
 */
export async function officeRenderRuntime(kitCli: string): Promise<OfficeRenderRuntime> {
  if (!isAbsolute(kitCli)) throw new OfficeRenderCacheError('INVALID_CONFIG')
  const api = join(dirname(kitCli), 'index.js')
  if (!(await lstat(kitCli)).isFile() || !(await lstat(api)).isFile()) throw new OfficeRenderCacheError('INVALID_CONFIG')
  const kit = await import(pathToFileURL(api).href) as typeof import('@deepseek-ai/libreoffice-kit')
  const discovered = await kit.discoverRuntime()
  const engineIdentity = hash(JSON.stringify([discovered.version, discovered.backend, kit.ENGINE_VERSION, kit.ENGINE_VERSIONS,
    hash(await readFile(api)), hash(await readFile(kitCli))]))
  return { engineIdentity, create: options => kit.createConverter(options) }
}

async function readBounded(path: string, maximum: number, signal: AbortSignal): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const status = await file.stat()
    if (!status.isFile() || status.size > maximum) throw new OfficeRenderCacheError('INVALID_CONFIG')
    const parts: Buffer[] = []
    let size = 0
    while (true) {
      signal.throwIfAborted()
      const part = Buffer.alloc(Math.min(64 * 1024, maximum - size + 1))
      const { bytesRead } = await file.read(part)
      if (bytesRead === 0) return Buffer.concat(parts, size)
      size += bytesRead
      if (size > maximum) throw new OfficeRenderCacheError('INVALID_CONFIG')
      parts.push(part.subarray(0, bytesRead))
    }
  } finally { await file.close() }
}

async function inventoryIdentity(path: string | undefined, options: ConverterOptions | undefined,
  signal: AbortSignal): Promise<string | undefined> {
  if (path === undefined) return undefined
  try {
    const value: unknown = JSON.parse(await readFile(path, { encoding: 'utf8', signal }))
    if (!record(value) || value.schemaVersion !== 1 || value.platform !== process.platform || value.complete !== true
      || !Array.isArray(value.roots) || !value.roots.every((root: unknown) => typeof root === 'string' && isAbsolute(root))
      || !Array.isArray(value.files) || value.roots.length === 0) return undefined
    const roots = (value.roots as unknown[]).filter((root): root is string => typeof root === 'string')
    if (options?.fontDirectories?.some(root => !roots.includes(root)) === true) return undefined
    const expected = new Map<string, string>()
    for (const file of value.files as unknown[]) {
      if (!record(file) || typeof file.path !== 'string' || !isAbsolute(file.path) || typeof file.sha256 !== 'string'
        || !entryName.test(file.sha256) || expected.has(file.path)) return undefined
      expected.set(file.path, file.sha256)
    }
    const actual = new Map<string, string>()
    const visit = async (source: string): Promise<void> => {
      signal.throwIfAborted()
      let status
      try { status = await lstat(source) } catch (error: unknown) { if (codeOf(error) === 'ENOENT') return; throw error }
      if (status.isSymbolicLink()) throw new OfficeRenderCacheError('INVALID_CONFIG')
      if (status.isDirectory()) {
        for (const name of (await readdir(source)).sort()) await visit(join(source, name))
      } else if (status.isFile() && fontSuffix.test(source)) {
        actual.set(source, hash(await readFile(source, { signal })))
      }
    }
    for (const root of roots) await visit(root)
    if (actual.size !== expected.size || [...actual].some(([name, digest]) => expected.get(name) !== digest)) return undefined
    return hash(JSON.stringify([roots.toSorted(), [...actual].sort(([a], [b]) => a.localeCompare(b))]))
  } catch (error: unknown) {
    signal.throwIfAborted()
    // An incomplete inventory disables reuse, while the usable document can still be rendered.
    if (error instanceof Error) return undefined
    throw error
  }
}

async function lock(directory: string, signal: AbortSignal, timeoutMs: number): Promise<() => Promise<void>> {
  const deadline = performance.now() + timeoutMs
  while (true) {
    signal.throwIfAborted()
    try {
      await mkdir(directory, { mode: 0o700 })
      return async () => { await rm(directory, { recursive: true, force: true }) }
    } catch (error: unknown) { if (codeOf(error) !== 'EEXIST') throw error }
    if (performance.now() >= deadline) throw new OfficeRenderCacheError('CACHE_BUSY')
    await delay(Math.min(25, Math.max(1, deadline - performance.now())), undefined, { signal })
  }
}

function cacheUnavailable(error: unknown): boolean {
  const code = codeOf(error)
  return error instanceof OfficeRenderCacheError && error.code === 'CACHE_BUSY'
    || typeof code === 'string' && /^(?:E[A-Z]+|ERR_FS_)/u.test(code)
}

async function generation(root: string): Promise<string> {
  const path = join(root, 'generation')
  try { await writeFile(path, randomUUID(), { flag: 'wx', mode: 0o600 }) }
  catch (error: unknown) { if (codeOf(error) !== 'EEXIST') throw error }
  return await readFile(path, 'utf8')
}

function stored(value: unknown): value is StoredBatch {
  if (!record(value) || typeof value.created !== 'number' || !Number.isFinite(value.created) || !record(value.result)
    || !Array.isArray(value.hashes) || !value.hashes.every((digest: unknown) => typeof digest === 'string' && entryName.test(digest))) return false
  const result = value.result
  return result.schemaVersion === 1 && (result.backend === 'native' || result.backend === 'wasm')
    && (result.rasterEngine === 'libreoffice' || result.rasterEngine === 'pdfium') && result.source === 'saved'
    && typeof result.sourceSha256 === 'string' && entryName.test(result.sourceSha256)
    && typeof result.inputPath === 'string' && typeof result.dpi === 'number' && Number.isSafeInteger(result.pageCount)
    && Array.isArray(result.images) && result.images.length > 0 && result.images.length === value.hashes.length
    && result.images.every((image: unknown) => record(image) && Number.isSafeInteger(image.index)
      && typeof image.path === 'string' && typeof image.byteLength === 'number' && image.byteLength > 0
      && typeof image.width === 'number' && image.width > 0
      && typeof image.height === 'number' && image.height > 0 && record(image.rectangle))
    && Array.isArray(result.missingFonts) && result.missingFonts.every((font: unknown) => typeof font === 'string')
}

async function load(root: string, key: string, source: string, config: OfficeRenderCacheConfig,
  signal: AbortSignal): Promise<Batch | undefined> {
  try {
    const path = join(root, key)
    const metadata = await readBounded(join(path, 'manifest.json'), config.maxCacheBytes, signal)
    if (metadata.length > config.maxCacheBytes) return undefined
    const value: unknown = JSON.parse(metadata.toString('utf8'))
    const now = Date.now()
    if (!stored(value) || now < value.created || now - value.created >= config.ttlMs
      || value.result.sourceSha256 !== source) return undefined
    const bytes: Buffer[] = []
    let total = metadata.length
    for (const [index, image] of value.result.images.entries()) {
      const file = await readBounded(join(path, `${String(index)}.png`), config.maxCacheBytes - total, signal)
      total += file.length
      if (total > config.maxCacheBytes || image.byteLength !== file.length || value.hashes[index] !== hash(file)) return undefined
      bytes.push(file)
    }
    return { result: value.result, bytes }
  } catch (error: unknown) {
    signal.throwIfAborted()
    if (error instanceof Error) return undefined
    throw error
  }
}

async function render(request: RenderImagesRequest, source: Buffer, runtime: OfficeRenderRuntime,
  options: ConverterOptions | undefined, signal: AbortSignal): Promise<Batch> {
  const scratch = await mkdtemp(join(tmpdir(), 'office-render-'))
  let converter: Pick<Converter, 'renderImages' | 'dispose'> | undefined
  try {
    const inputPath = join(scratch, `source${extname(request.inputPath)}`)
    await writeFile(inputPath, source, { flag: 'wx', mode: 0o600, signal })
    signal.throwIfAborted()
    converter = await runtime.create(options)
    const result = await converter.renderImages({ ...request, inputPath, outputDir: join(scratch, 'images') }, signal)
    signal.throwIfAborted()
    if (result.sourceSha256 !== hash(source) || result.images.length === 0) throw new OfficeRenderCacheError('SOURCE_CHANGED')
    const bytes: Buffer[] = []
    for (const image of result.images) {
      if (resolve(dirname(image.path)) !== join(scratch, 'images') || !(await lstat(image.path)).isFile()) {
        throw new OfficeRenderCacheError('INVALID_RESULT')
      }
      const file = await readFile(image.path, { signal })
      if (file.length === 0 || file.length !== image.byteLength) throw new OfficeRenderCacheError('INVALID_RESULT')
      bytes.push(file)
    }
    return { result: { ...result, inputPath: request.inputPath }, bytes }
  } finally {
    try { await converter?.dispose() } finally { await rm(scratch, { recursive: true, force: true }) }
  }
}

async function publish(batch: Batch, request: RenderImagesRequest, status: OfficeBatchRenderResult['cacheStatus'],
  signal: AbortSignal): Promise<OfficeBatchRenderResult> {
  signal.throwIfAborted()
  await mkdir(request.outputDir, { mode: 0o700 })
  try {
    const images = []
    for (const [index, image] of batch.result.images.entries()) {
      const path = join(request.outputDir, `${String(index + 1).padStart(4, '0')}.png`)
      const bytes = batch.bytes[index]
      if (bytes === undefined) throw new OfficeRenderCacheError('INVALID_RESULT')
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600, signal })
      images.push({ ...image, path })
    }
    const result: OfficeBatchRenderResult = { ...batch.result, inputPath: request.inputPath, images, cacheHit: status === 'hit', cacheStatus: status }
    signal.throwIfAborted()
    await writeFile(join(request.outputDir, 'manifest.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600, signal })
    signal.throwIfAborted()
    return result
  } catch (error: unknown) {
    await rm(request.outputDir, { recursive: true, force: true })
    throw error
  }
}

async function save(root: string, key: string, epoch: string, batch: Batch, config: OfficeRenderCacheConfig,
  signal: AbortSignal): Promise<void> {
  const metadata = Buffer.from(JSON.stringify({ created: Date.now(), result: batch.result, hashes: batch.bytes.map(hash) }))
  const size = metadata.length + batch.bytes.reduce((sum, bytes) => sum + bytes.length, 0)
  if (size > config.maxCacheBytes) return
  const release = await lock(join(root, 'write.lock'), signal, config.converterOptions?.timeoutMs ?? 120_000)
  const temporary = join(root, `pending-${randomUUID()}`)
  try {
    if (await generation(root) !== epoch) return
    await mkdir(temporary, { mode: 0o700 })
    await writeFile(join(temporary, 'manifest.json'), metadata, { flag: 'wx', mode: 0o600, signal })
    for (const [index, bytes] of batch.bytes.entries()) await writeFile(join(temporary, `${String(index)}.png`), bytes, { flag: 'wx', mode: 0o600, signal })
    const entries = []
    for (const name of await readdir(root)) {
      if (!entryName.test(name)) continue
      const path = join(root, name)
      const files = await readdir(path)
      const bytes = await Promise.all(files.map(async file => (await lstat(join(path, file))).size))
      entries.push({ path, bytes: bytes.reduce((sum, value) => sum + value, 0), modified: (await lstat(path)).mtimeMs })
    }
    let retained = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    for (const entry of entries.sort((a, b) => a.modified - b.modified)) {
      if (retained + size <= config.maxCacheBytes && entry.path !== join(root, key)) break
      await rm(entry.path, { recursive: true, force: true }); retained -= entry.bytes
    }
    signal.throwIfAborted()
    await rm(join(root, key), { recursive: true, force: true })
    await rename(temporary, join(root, key))
  } finally {
    await rm(temporary, { recursive: true, force: true })
    await release()
  }
}

/**
 * Render all selected pages in one public Kit call, then publish a new complete output directory.
 * Cache reuse requires exact source bytes, settings, engine identity and a freshly verified complete font inventory.
 * Concurrent identical cacheable requests share one complete batch through an exclusive disk lock.
 * Cancelling a waiting reader never cancels another owner.
 * @param request - Absolute source/output paths; output must not exist. Source is snapshotted and never modified.
 * @param config - Deployment-owned kit, bounded disk reuse and optional trusted font inventory.
 * @param signal - Cancels queue waits, rendering and publication; every started engine is disposed before settlement.
 * @param suppliedRuntime - Test/environment implementation of the same one-shot public Kit interface.
 * @returns New manifest and saved paths; cached PNGs are verified before reuse. No result certifies visual QA.
 */
export async function renderOfficeBatch(request: RenderImagesRequest, config: OfficeRenderCacheConfig,
  signal: AbortSignal = new AbortController().signal, suppliedRuntime?: OfficeRenderRuntime): Promise<OfficeBatchRenderResult> {
  validate(config, request)
  signal.throwIfAborted()
  if (!(await lstat(request.inputPath)).isFile()) throw new OfficeRenderCacheError('INVALID_CONFIG')
  const maximum = config.converterOptions?.maxInputBytes ?? 64 * 1024 * 1024
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new OfficeRenderCacheError('INVALID_CONFIG')
  const source = await readBounded(request.inputPath, maximum, signal)
  try { await access(request.outputDir, constants.F_OK); throw new OfficeRenderCacheError('INVALID_CONFIG') }
  catch (error: unknown) { if (codeOf(error) !== 'ENOENT') throw error }
  const runtime = suppliedRuntime ?? await officeRenderRuntime(config.kitCli)
  const fonts = await inventoryIdentity(config.fontInventoryPath, config.converterOptions, signal)
  if (fonts === undefined || config.ttlMs === 0 || config.maxCacheBytes === 0) {
    return await publish(await render(request, source, runtime, config.converterOptions, signal), request,
      fonts === undefined ? 'unverified-fonts' : 'disabled', signal)
  }
  let epoch: string
  let key: string
  let release: () => Promise<void>
  try {
    await mkdir(config.cacheDirectory, { recursive: true, mode: 0o700 })
    epoch = await generation(config.cacheDirectory)
    const { inputPath: _input, outputDir: _output, ...settings } = request
    key = hash(JSON.stringify([epoch, hash(source), settings, config.converterOptions ?? {}, runtime.engineIdentity, fonts]))
    release = await lock(join(config.cacheDirectory, `${key}.lock`), signal, config.converterOptions?.timeoutMs ?? 120_000)
  } catch (error: unknown) {
    signal.throwIfAborted()
    if (!cacheUnavailable(error)) throw error
    return await publish(await render(request, source, runtime, config.converterOptions, signal), request, 'disabled', signal)
  }
  try {
    const cached = await load(config.cacheDirectory, key, hash(source), config, signal)
    if (cached !== undefined) return await publish(cached, request, 'hit', signal)
    const batch = await render(request, source, runtime, config.converterOptions, signal)
    // Validate the inventory again after rendering before allowing any subsequent call to reuse it.
    if (await inventoryIdentity(config.fontInventoryPath, config.converterOptions, signal) === fonts) {
      try { await save(config.cacheDirectory, key, epoch, batch, config, signal) }
      catch (error: unknown) { signal.throwIfAborted(); if (!cacheUnavailable(error)) throw error }
    }
    return await publish(batch, request, 'rendered', signal)
  } finally { await release() }
}

/**
 * Invalidate only this private cache. Advancing its generation prevents already-running old renders repopulating it.
 * @param config - Same deployment-owned private cache and budgets used for rendering.
 * @param signal - Cancellation before the invalidation commit; source documents and caller outputs are never removed.
 */
export async function invalidateOfficeRenderCache(config: OfficeRenderCacheConfig,
  signal: AbortSignal = new AbortController().signal): Promise<void> {
  validate(config)
  signal.throwIfAborted()
  await mkdir(config.cacheDirectory, { recursive: true, mode: 0o700 })
  const release = await lock(join(config.cacheDirectory, 'write.lock'), signal, config.converterOptions?.timeoutMs ?? 120_000)
  const next = join(config.cacheDirectory, `generation-${randomUUID()}`)
  try {
    await writeFile(next, randomUUID(), { flag: 'wx', mode: 0o600, signal })
    signal.throwIfAborted()
    await rename(next, join(config.cacheDirectory, 'generation'))
    for (const name of await readdir(config.cacheDirectory)) {
      if (entryName.test(name)) await rm(join(config.cacheDirectory, name), { recursive: true, force: true })
    }
  } finally { await rm(next, { force: true }); await release() }
}
