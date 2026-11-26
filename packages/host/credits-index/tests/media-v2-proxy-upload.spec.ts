import { createHash } from 'node:crypto'
import { getEventListeners } from 'node:events'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { MediaV2Client } from '../src/media-v2-client.ts'
import { createMediaV2Proxy } from '../src/media-v2-proxy.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
it('passes a bounded raw browser upload to the multipart stream without starting an HTTP server', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'media-v2-direct-proxy-'))
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
  const id = 'e645d657-5bf1-4425-8b1a-b62b1899dd7e', bytes = Buffer.from('original synthetic video bytes')
  let posts = 0
  const client = new MediaV2Client({ baseUrl: 'https://synthetic.invalid', directory, timeoutMs: 1000, uploadTimeoutMs: 100, creditsPerYuan: 1000 })
  const proxy = createMediaV2Proxy({ client, requestRejection: () => undefined,
    capture: async () => ({ owner: 'synthetic-only', isCurrent: async () => true, fetch: async (path, init) => {
      if (path.endsWith('/models')) return Response.json({ success: true, data: { capabilities: {
        media_generation_v2: true, quote_required: true, durable_operation_receipt: true, all_artifacts: true }, models: [{
        id: 'native-video', display_name: 'Synthetic video', model_version: 'native-1', kind: 'video', enabled: true,
        parameters_schema: {}, asset_fields: [{ name: 'videos', media_kind: 'video', native_shape: 'single', min_items: 1,
          max_items: 1, mime_types: ['video/mp4'], constraints: { max_bytes: 1000 } }],
        intents: [{ id: 'transform', label: 'Process', requires_assets: true }], pricing: { display: 'quote', quote_required: true } }] } })
      if (path !== '/v1/media-v2/assets') throw new Error('Unexpected synthetic route')
      posts += 1
      if (!(init.body instanceof ReadableStream)) throw new Error('Expected bounded multipart stream')
      const form = await new Request('https://synthetic.invalid/assets', init).formData(), file = form.get('file')
      if (!(file instanceof File)) throw new Error('Missing original file')
      expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes)
      expect(form.get('client_asset_id')).toBe(id)
      return Response.json({ success: true, data: { asset_id: 'ma2-browser-original', client_asset_id: id, model: 'native-video',
        state: 'ready', media_kind: 'video', mime_type: 'video/mp4', bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), expires_at: 2000000000 } })
    } }) })
  cleanups.push(async () => { await proxy.close() })
  const socket = new Socket(), request = new IncomingMessage(socket), response = new ServerResponse(request)
  cleanups.push(async () => { response.destroy(); request.destroy(); socket.destroy() })
  request.url = `/api/media-v2/assets?model=native-video&client_asset_id=${id}&field=videos`
  request.headers = { 'x-file-name': 'source.mp4', 'content-type': 'video/mp4', 'content-length': String(bytes.length) }
  request.push(bytes.subarray(0, 7)); request.push(bytes.subarray(7)); request.push(null)
  let result = ''
  vi.spyOn(response, 'end').mockImplementation((chunk: unknown) => { result = String(chunk); return response })
  expect(await proxy.handle(request, response, '/api/media-v2/assets', 'POST')).toBe(true)
  expect(JSON.parse(result)).toMatchObject({ success: true, data: { asset_id: 'ma2-browser-original', client_asset_id: id } })
  expect(posts).toBe(1)
  const folders = await readdir(directory)
  expect((await readdir(join(directory, folders[0]!))).filter(file => file.endsWith('.tmp'))).toEqual([])
  const pendingSocket = new Socket(), pending = new IncomingMessage(pendingSocket), pendingResponse = new ServerResponse(pending)
  pendingSocket.on('error', () => {})
  cleanups.push(async () => { pendingResponse.destroy(); pending.destroy(); pendingSocket.destroy() })
  pending.url = request.url; pending.headers = request.headers
  pending.push(bytes.subarray(0, 1))
  let pendingResult = '', transferSignal: AbortSignal | undefined
  vi.spyOn(pendingResponse, 'end').mockImplementation((chunk: unknown) => { pendingResult = String(chunk); return pendingResponse })
  const upload = client.upload.bind(client)
  vi.spyOn(client, 'upload').mockImplementationOnce(async (account, input, cancel) => {
    if ('bytes' in input || typeof input.stream !== 'function') throw new Error('Proxy must pass a cancellable source factory')
    const source = input.stream
    return await upload(account, { ...input,
      stream: (ownedSignal) => { transferSignal = ownedSignal; return source(ownedSignal) } }, cancel)
  })
  expect(await proxy.handle(pending, pendingResponse, '/api/media-v2/assets', 'POST')).toBe(true)
  expect(JSON.parse(pendingResult)).toMatchObject({ success: false })
  expect(pending.destroyed).toBe(true); expect(posts).toBe(1)
  if (transferSignal === undefined) throw new Error('Missing captured upload deadline')
  expect(getEventListeners(transferSignal, 'abort')).toHaveLength(0)
  expect((await readdir(join(directory, folders[0]!))).filter(file => file.endsWith('.tmp'))).toEqual([])
})
