import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { MediaV2Client, type MediaV2Account, type MediaV2UploadInput } from '../src/media-v2-client.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const MiB = 1024 * 1024, id = 'e645d657-5bf1-4425-8b1a-b62b1899dd7e'
const signal = (): AbortSignal => new AbortController().signal
const response = (data: unknown): Response => Response.json({ success: true, data })
async function fixture(options: {
  ceiling?: number
  server?: number
  fieldBytes?: number
  lost?: boolean
  uploadTimeoutMs?: number
  waitForAbort?: boolean
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'media-v2-stream-upload-')); directories.push(directory)
  const calls: { path: string; method: string }[] = []
  let uploaded = 0, largest = 0, wireHash = '', wireBytes = 0, catalogAvailable = true
  const model = { id: 'native-mixed', display_name: 'Image/video/audio processor', kind: 'audio', model_version: 'native-1', enabled: true,
    parameters_schema: {}, conditions: { reference_required: true },
    asset_fields: [
      { name: 'images', media_kind: 'image', native_shape: 'multiple', min_items: 0, max_items: 2, mime_types: ['image/png'], constraints: { max_bytes: 5 * MiB } },
      { name: 'videos', media_kind: 'video', native_shape: 'single', min_items: 0, max_items: 1, mime_types: ['video/mp4'], constraints: { max_bytes: options.fieldBytes ?? 80 * MiB } },
      { name: 'audio', media_kind: 'audio', native_shape: 'single', min_items: 0, max_items: 1, mime_types: ['audio/wav'], constraints: { max_bytes: 12 * MiB } },
    ], intents: [{ id: 'transform', label: 'Process', requires_assets: true }], pricing: { display: 'exact quote', quote_required: true } }
  let asset: unknown
  const account: MediaV2Account = { owner: 'synthetic-only', async fetch(path, init) {
    calls.push({ path, method: init.method ?? 'GET' })
    if (path.endsWith('/models')) {
      if (!catalogAvailable) throw new Error('Catalog unavailable after original upload')
      return response({ capabilities: { media_generation_v2: true, quote_required: true, durable_operation_receipt: true,
        all_artifacts: true, ...options.server === undefined ? {} : { max_upload_bytes: options.server } }, models: [model] })
    }
    if (path.includes('/assets/by-client-id/')) return response(asset)
    if (path !== '/v1/media-v2/assets' || init.method !== 'POST') throw new Error('Unexpected synthetic route')
    uploaded += 1
    if (!(init.body instanceof ReadableStream)) throw new Error('A bounded multipart stream is required')
    const reader = init.body.getReader(), header = await reader.read()
    if (header.done || !(header.value instanceof Uint8Array)) throw new Error('Missing multipart header')
    const prefix = Buffer.from(header.value).toString('utf8')
    expect(prefix).toContain('name="model"\r\n\r\nnative-mixed')
    expect(prefix).toContain(`name="client_asset_id"\r\n\r\n${id}`)
    expect(prefix).toContain('name="file"; filename="source.mp4"')
    const boundary = new Headers(init.headers).get('content-type')?.split('boundary=')[1]
    if (boundary === undefined) throw new Error('Missing multipart boundary')
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
    const total = Number(new Headers(init.headers).get('content-length'))
    const expected = total - header.value.byteLength - tail.byteLength
    const hash = createHash('sha256'); let remaining = expected, suffix = ''
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        const bytes: unknown = chunk.value
        if (!(bytes instanceof Uint8Array)) throw new Error('Unexpected multipart chunk')
        largest = Math.max(largest, bytes.byteLength)
        const length = Math.min(remaining, bytes.byteLength)
        hash.update(bytes.subarray(0, length)); wireBytes += length; remaining -= length
        suffix += Buffer.from(bytes.subarray(length)).toString('utf8')
      }
    } finally { reader.releaseLock() }
    expect(remaining).toBe(0); expect(suffix).toBe(tail.toString('utf8'))
    wireHash = hash.digest('hex')
    asset = { asset_id: 'ma2-exact-original', client_asset_id: id, model: model.id, state: 'ready', media_kind: 'video',
      mime_type: 'video/mp4', bytes: expected, sha256: wireHash, expires_at: 2000000000 }
    if (options.waitForAbort) {
      const cancellation = init.signal
      if (cancellation === null || cancellation === undefined) throw new Error('Missing upload deadline')
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void => { reject(new Error('Synthetic upload deadline exceeded', { cause: cancellation.reason })) }
        if (cancellation.aborted) abort(); else cancellation.addEventListener('abort', abort, { once: true })
      })
    }
    if (options.lost) throw new Error('Lost original upload response')
    return response(asset)
  } }
  const client = new MediaV2Client({ baseUrl: 'https://synthetic.invalid', directory, timeoutMs: 1000, uploadTimeoutMs: options.uploadTimeoutMs ?? 10000,
    creditsPerYuan: 1000, ...options.ceiling === undefined ? {} : { maxUploadBytes: options.ceiling } })
  const input = (size: number): MediaV2UploadInput => ({ model: model.id, clientAssetId: id, filename: 'source.mp4', mime: 'video/mp4', size,
    stream: (async function* () {
      for (let offset = 0; offset < size; offset += MiB) yield Buffer.alloc(Math.min(MiB, size - offset), 7)
    })() })
  const files = async (): Promise<string[]> => (await Promise.all((await readdir(directory)).map(async folder =>
    (await readdir(join(directory, folder))).map(file => join(folder, file))))).flat()
  return { account, client, calls, directory, input, files, model, stopCatalog: () => { catalogAvailable = false },
    observed: () => ({ uploaded, largest, wireHash, wireBytes }) }
}

it('streams above 50 MiB only with declared server and deployment limits, preserving exact multipart SHA', async () => {
  const f = await fixture({ ceiling: 100 * MiB, server: 90 * MiB })
  const size = 51 * MiB + 17, expected = createHash('sha256')
  for (let offset = 0; offset < size; offset += MiB) expected.update(Buffer.alloc(Math.min(MiB, size - offset), 7))
  const asset = await f.client.upload(f.account, f.input(size), signal())
  expect(asset).toMatchObject({ bytes: size, sha256: expected.digest('hex') })
  expect(f.observed()).toMatchObject({ uploaded: 1, wireBytes: size, wireHash: asset.sha256 })
  expect(f.observed().largest).toBeLessThanOrEqual(MiB)
  expect((await f.files()).filter(path => path.endsWith('.tmp'))).toEqual([])
  const receipt = (await f.files()).find(path => path.endsWith('.upload.json'))
  if (receipt === undefined) throw new Error('Missing original upload receipt')
  expect(JSON.parse(await readFile(join(f.directory, receipt), 'utf8'))).toMatchObject({ client_asset_id: id, sha256: asset.sha256, bytes: size })
})

it('keeps 50 MiB without a server declaration and intersects selected role, MIME and deployment caps', async () => {
  const old = await fixture({ ceiling: 100 * MiB })
  expect((await old.client.catalog(old.account, signal())).capabilities.max_upload_bytes).toBe(50 * MiB)
  expect(await old.client.uploadLimit(old.account, old.model.id, signal())).toBe(50 * MiB)
  await expect(old.client.upload(old.account, old.input(51 * MiB), signal())).rejects.toMatchObject({ status: 413 })
  expect(old.observed().uploaded).toBe(0)
  const f = await fixture({ ceiling: 70 * MiB, server: 90 * MiB })
  expect((await f.client.catalog(f.account, signal())).capabilities.max_upload_bytes).toBe(70 * MiB)
  expect(await f.client.uploadLimit(f.account, f.model.id, signal())).toBe(70 * MiB)
  expect(await f.client.uploadLimit(f.account, f.model.id, signal(), 'images')).toBe(5 * MiB)
  expect(await f.client.uploadLimit(f.account, f.model.id, signal(), undefined, 'audio/wav')).toBe(12 * MiB)
  expect(await f.client.uploadLimit(f.account, f.model.id, signal(), undefined, 'video/mp4')).toBe(70 * MiB)
  await expect(f.client.uploadLimit(f.account, f.model.id, signal(), 'images', 'video/mp4')).rejects.toMatchObject({ code: 'invalid_parameters' })
  await expect(f.client.upload(f.account, { ...f.input(20), field: 'images' }, signal()))
    .rejects.toMatchObject({ code: 'invalid_parameters' })
  expect(f.observed().uploaded).toBe(0)
})

it('rejects a lying stream length and an overflowing unknown-length stream before any upload receipt or POST', async () => {
  const f = await fixture({ ceiling: MiB, server: 2 * MiB })
  await expect(f.client.upload(f.account, { ...f.input(20), size: 21 }, signal())).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(f.client.upload(f.account, { model: f.model.id, clientAssetId: id, filename: 'source.mp4', mime: 'video/mp4',
    stream: (async function* () { yield Buffer.alloc(MiB); yield Uint8Array.from([7]) })() }, signal()))
    .rejects.toMatchObject({ status: 413 })
  expect(f.observed().uploaded).toBe(0)
  expect(await f.files()).toEqual([])
})

it('cleans aborted staging, then recovers a lost upload after restart with one original POST and no catalog dependency', async () => {
  const f = await fixture({ ceiling: 2 * MiB, server: 2 * MiB, lost: true })
  const abort = new AbortController()
  await expect(f.client.upload(f.account, { model: f.model.id, clientAssetId: id, filename: 'source.mp4', mime: 'video/mp4',
    stream: (async function* () { yield Uint8Array.from([7]); abort.abort(); yield Uint8Array.from([7]) })() }, abort.signal))
    .rejects.toThrow()
  expect(f.observed().uploaded).toBe(0); expect(await f.files()).toEqual([])
  await expect(f.client.upload(f.account, f.input(19), signal())).rejects.toThrow('Lost original upload response')
  f.stopCatalog()
  const restarted = new MediaV2Client({ baseUrl: 'https://synthetic.invalid', directory: f.directory, timeoutMs: 1000, creditsPerYuan: 1000 })
  const recovered = await restarted.upload(f.account, f.input(19), signal())
  expect(recovered).toMatchObject({ client_asset_id: id, bytes: 19 })
  expect(f.observed().uploaded).toBe(1)
  expect(f.calls.filter(call => call.path.includes('/by-client-id/'))).toHaveLength(1)
  expect((await f.files()).filter(path => path.endsWith('.tmp'))).toEqual([])
})


it('bounds the upload deadline, cleans its spool and keeps a timed-out original POST queryable without a replay', async () => {
  const f = await fixture({ ceiling: MiB, server: MiB, uploadTimeoutMs: 100, waitForAbort: true })
  await expect(f.client.upload(f.account, f.input(19), signal())).rejects.toThrow()
  expect(f.observed().uploaded).toBe(1)
  expect((await f.files()).filter(path => path.endsWith('.tmp'))).toEqual([])
  expect(await f.client.assetByClientId(f.account, id, f.model.id, signal())).toMatchObject({ client_asset_id: id, bytes: 19 })
  expect(f.observed().uploaded).toBe(1)
})

it('joins simultaneous original-upload claims and reuses one immutable receipt without another multipart POST', async () => {
  const f = await fixture({ ceiling: MiB, server: MiB })
  const assets = await Promise.all([f.client.upload(f.account, f.input(19), signal()), f.client.upload(f.account, f.input(19), signal())])
  expect(assets[0]).toEqual(assets[1])
  expect(f.observed().uploaded).toBe(1)
  expect((await f.files()).filter(path => path.endsWith('.tmp'))).toEqual([])
})

it('passes the upload deadline into a blocked source factory and awaits its closure before removing the spool', async () => {
  const f = await fixture({ ceiling: MiB, server: MiB, uploadTimeoutMs: 100 })
  let closed = false, captured: AbortSignal | undefined
  await expect(f.client.upload(f.account, { model: f.model.id, clientAssetId: id, filename: 'source.mp4', mime: 'video/mp4', size: 2,
    stream: uploadSignal => (async function* () {
      captured = uploadSignal
      try {
        yield Uint8Array.from([7])
        await new Promise<void>((resolve) => {
          if (uploadSignal.aborted) resolve(); else uploadSignal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        uploadSignal.throwIfAborted()
        yield Uint8Array.from([7])
      } finally { closed = true }
    })() }, signal())).rejects.toThrow()
  expect(captured?.aborted).toBe(true); expect(closed).toBe(true)
  expect(f.observed().uploaded).toBe(0)
  expect(await f.files()).toEqual([])
})
