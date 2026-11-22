import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MediaV2Client, type MediaV2Account } from '../src/media-v2-client.ts'
import { parseMediaV2Request, parseMediaV2Task } from '../src/media-v2-protocol.ts'

const id = '821072d0-b470-4ab8-ae42-98ef7668f925'
const request = { client_operation_id: id, model: 'model-image', model_version: 'version-1', intent: 'reference',
  parameters: { prompt: '只改变背景', features: ['a', 'b'] }, assets: { images: ['ma2-first', 'ma2-second'] } }
const task = { id: 'task-first', model: request.model, kind: 'image', status: 'succeeded', is_final: true,
  created_at: 1, updated_at: 2, artifacts: [
    { key: 'layer-1', type: 'image', mime_type: 'image/png', role: 'layer', order: 0, content_url: '/v1/tasks/task-first/artifacts/layer-1/content' },
    { key: 'animation', type: 'image', mime_type: 'image/gif', role: 'main', order: 1, content_url: '/v1/tasks/task-first/artifacts/animation/content' },
    { key: 'vector', type: 'file', mime_type: 'image/svg+xml', order: 2, content_url: '/v1/tasks/task-first/artifacts/vector/content' },
  ] }
const quote = { ...request, quote_id: 'quote-1', request_sha256: 'a'.repeat(64), retail_cny: '0.30', credits: 300,
  credits_per_yuan: 1000, expires_at: Math.floor(Date.now() / 1000) + 3600, operation_state: 'quoted' }
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup(taskReply = task) {
  const directory = await mkdtemp(join(tmpdir(), 'media-v2-')); directories.push(directory)
  const calls: { path: string; method: string; body: unknown }[] = []
  const send = vi.fn(async (path: string, init: RequestInit) => {
    calls.push({ path, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
    let data: unknown
    if (path.endsWith('/quotes')) data = quote
    else if (path.endsWith('/operations/' + id)) data = { client_operation_id: id, state: 'accepted', quote_id: quote.quote_id, task: taskReply }
    else if (path.endsWith('/tasks/' + encodeURIComponent(taskReply.id))) data = { task: taskReply }
    else if (path.endsWith('/tasks')) data = { task: taskReply, replayed: false }
    return new Response(JSON.stringify({ success: true, data }), { headers: { 'content-type': 'application/json' } })
  })
  const account: MediaV2Account = { owner: 'synthetic-owner', fetch: send }
  const client = new MediaV2Client({ baseUrl: 'http://127.0.0.1:1/harness', directory, timeoutMs: 1000, creditsPerYuan: 1000 })
  return { directory, client, account, calls, send }
}

describe('V2 original-operation generation', () => {
  it('persists exact ordered references before quote and sends one task even for concurrent clicks', async () => {
    const { client, account, calls, directory } = await setup()
    const first = await client.quote(account, request, new AbortController().signal)
    expect(first.request.assets.images).toEqual(['ma2-first', 'ma2-second'])
    expect(first.quote?.credits).toBe(300)
    await Promise.all(Array.from({ length: 4 }, () => client.submit(account, id, new AbortController().signal)))
    expect(calls.filter(call => call.path.endsWith('/tasks') && call.method === 'POST')).toHaveLength(1)
    expect(calls.find(call => call.path.endsWith('/tasks') && call.method === 'POST')?.body).toEqual({ quote_id: 'quote-1', client_operation_id: id, request_sha256: 'a'.repeat(64) })
    const restarted = new MediaV2Client({ baseUrl: 'http://127.0.0.1:1/harness', directory, timeoutMs: 1000, creditsPerYuan: 1000 })
    const record = await restarted.query(account, id, new AbortController().signal)
    expect(record.task?.artifacts).toHaveLength(3)
    expect(record.task?.artifacts.map(item => item.key)).toEqual(['layer-1', 'animation', 'vector'])
    expect(calls.filter(call => call.path.endsWith('/tasks') && call.method === 'POST')).toHaveLength(1)
    const records = await restarted.records(account)
    expect(records).toHaveLength(1)
    expect(JSON.stringify(records)).not.toContain('Bearer')
    const folders = await import('node:fs/promises').then(fs => fs.readdir(directory))
    const file = join(directory, folders[0]!, id + '.json')
    // Windows owns file ACL semantics rather than POSIX permission bits.
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    const stored: unknown = JSON.parse(await readFile(file, 'utf8'))
    expect(stored).toMatchObject({ request })
  })

  it('keeps a lost submit receipt and recovers by GET without sending another task', async () => {
    const { client, account, calls, send } = await setup()
    await client.quote(account, request, new AbortController().signal)
    send.mockImplementationOnce(async (path, init) => {
      calls.push({ path, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
      throw new Error('synthetic lost response after acceptance')
    })
    await expect(client.submit(account, id, new AbortController().signal)).rejects.toThrow('synthetic lost response')
    expect((await client.records(account))[0]?.state).toBe('unknown')
    const recovered = await client.submit(account, id, new AbortController().signal)
    expect(recovered.task?.id).toBe('task-first')
    expect(calls.filter(call => call.path.endsWith('/tasks') && call.method === 'POST')).toHaveLength(1)
  })

  it('recovers a lost quote with its original full receipt using GET only', async () => {
    const { client, account, send, calls } = await setup()
    send.mockImplementationOnce(async (path, init) => { calls.push({ path, method: init.method ?? 'GET', body: undefined }); throw new Error('lost quote') })
    await expect(client.quote(account, request, new AbortController().signal)).rejects.toThrow('lost quote')
    send.mockImplementationOnce(async (path, init) => {
      calls.push({ path, method: init.method ?? 'GET', body: undefined })
      return new Response(JSON.stringify({ success: true, data: { client_operation_id: id, state: 'quoted', quote_id: quote.quote_id,
        quote: { ...quote, credits: undefined, credits_per_yuan: undefined } } }))
    })
    const recovered = await client.query(account, id, new AbortController().signal)
    expect(recovered.state).toBe('quoted')
    expect(recovered.quote).toMatchObject({ request_sha256: quote.request_sha256, credits: 300, credits_per_yuan: 1000 })
    expect(calls.map(call => call.method)).toEqual(['POST', 'GET'])
  })

  it('rejects changed bodies and silently modified quote materials before submission', async () => {
    const { client, account, send, calls } = await setup()
    await client.quote(account, request, new AbortController().signal)
    await expect(client.quote(account, { ...request, assets: { images: ['ma2-second'] } }, new AbortController().signal)).rejects.toMatchObject({ code: 'operation_conflict' })
    const changed = { ...request, client_operation_id: '2a1ca40d-96a7-4072-a9a6-e7f80c098edb' }
    send.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { ...quote, ...changed, assets: { images: ['ma2-first'] } } })))
    await expect(client.quote(account, changed, new AbortController().signal)).rejects.toMatchObject({ code: 'quote_changed' })
    expect(calls.some(call => call.path.endsWith('/tasks') && call.method === 'POST')).toBe(false)
  })

  it('keeps unknown after a 404 original read, never treating it as permission to retry', async () => {
    const { client, account, send, calls } = await setup()
    await client.quote(account, request, new AbortController().signal)
    send.mockRejectedValueOnce(new Error('lost'))
    await expect(client.submit(account, id, new AbortController().signal)).rejects.toThrow('lost')
    send.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: { code: 'operation_unknown', message: '未知' } }), { status: 404 }))
    await expect(client.submit(account, id, new AbortController().signal)).rejects.toMatchObject({ code: 'operation_unknown' })
    expect((await client.records(account))[0]?.state).toBe('unknown')
    expect(calls.filter(call => call.path.endsWith('/tasks') && call.method === 'POST')).toHaveLength(0)
  })
})

it('rejects lost reference intent, reference-to-text coercion and nested parameter objects', () => {
  expect(() => parseMediaV2Request({ ...request, assets: {} })).toThrow()
  expect(() => parseMediaV2Request({ ...request, intent: 'text' })).toThrow()
  expect(() => parseMediaV2Request({ ...request, parameters: { prompt: { source: 'bad' } } })).toThrow()
  expect(parseMediaV2Request(request).parameters.features).toEqual(['a', 'b'])
})

it('retains all output types but never treats unknown as a final result', () => {
  expect(parseMediaV2Task(task).artifacts).toHaveLength(3)
  expect(() => parseMediaV2Task({ ...task, status: 'unknown' })).toThrow()
  expect(() => parseMediaV2Task({ ...task, artifacts: [task.artifacts[0], task.artifacts[0]] })).toThrow()
})

it('recovers one immutable lost upload, never repeating its multipart POST or rebinding its bytes', async () => {
  const { client, account, send, calls, directory } = await setup()
  const input = { model: request.model, clientAssetId: '37f2db36-f4aa-47cc-a7db-9d9233c3ca4c', filename: 'source.png', mime: 'image/png', bytes: Buffer.from('exact original synthetic bytes') }
  const asset = { asset_id: 'ma2-original', client_asset_id: input.clientAssetId, model: input.model, state: 'ready', media_kind: 'image',
    mime_type: input.mime, bytes: input.bytes.length, sha256: createHash('sha256').update(input.bytes).digest('hex'), expires_at: 2000000000 }
  send.mockImplementationOnce(async (path, init) => { calls.push({ path, method: init.method ?? 'GET', body: undefined }); throw new Error('lost upload receipt') })
  await expect(client.upload(account, input, new AbortController().signal)).rejects.toThrow('lost upload receipt')
  const restarted = new MediaV2Client({ baseUrl: 'http://127.0.0.1:1/harness', directory, timeoutMs: 1000, creditsPerYuan: 1000 })
  send.mockImplementationOnce(async (path, init) => { calls.push({ path, method: init.method ?? 'GET', body: undefined }); return new Response(JSON.stringify({ success: true, data: asset })) })
  expect(await restarted.upload(account, input, new AbortController().signal)).toEqual(asset)
  expect(calls.filter(call => call.path.endsWith('/assets') && call.method === 'POST')).toHaveLength(1)
  expect(calls.filter(call => call.path.includes('/by-client-id/') && call.method === 'GET')).toHaveLength(1)
  await expect(restarted.upload(account, { ...input, bytes: Buffer.from('different') }, new AbortController().signal)).rejects.toMatchObject({ code: 'asset_binding_mismatch' })
})

it('saves every original layer/GIF/vector and restores deleted outputs without generation', async () => {
  const { client, account, send, calls, directory } = await setup({ ...task, id: 'task:original',
    artifacts: task.artifacts.map(item => ({ ...item, key: item.key === 'layer-1' ? 'layer:1' : item.key })) })
  await client.quote(account, request, new AbortController().signal)
  await client.submit(account, id, new AbortController().signal)
  const original = send.getMockImplementation()!
  const content: Record<string, { mime: string; bytes: Buffer }> = {
    'layer:1': { mime: 'image/png', bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]) },
    animation: { mime: 'image/gif', bytes: Buffer.from('GIF89a original animated data') },
    vector: { mime: 'image/svg+xml', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') },
  }
  send.mockImplementation(async (path, init) => {
    if (path.endsWith('/content')) {
      calls.push({ path, method: init.method ?? 'GET', body: undefined })
      const key = decodeURIComponent(path.split('/').at(-2)!), item = content[key]!
      return new Response(new Uint8Array(item.bytes), { headers: { 'content-type': item.mime } })
    }
    return await original(path, init)
  })
  const saving = new MediaV2Client({ baseUrl: 'http://127.0.0.1:1/harness', directory, timeoutMs: 1000, creditsPerYuan: 1000,
    output: async () => ({ write: async (filename, bytes) => {
      expect(filename).not.toMatch(/[<>:"/\\|?*]/u)
      const path = join(directory, filename); await writeFile(path, bytes, { flag: 'wx' }); return { path }
    },
    publish: async () => { throw new Error('unused') } }) })
  const first = await saving.saveArtifacts(account, id, new AbortController().signal)
  expect(first.saved?.map(item => item.path.split('.').at(-1))).toEqual(['png', 'gif', 'svg'])
  expect(first.saved).toHaveLength(3)
  await rm(first.saved![1]!.path)
  const changedVector = first.saved![2]!.path
  await writeFile(changedVector, 'user edited local vector')
  const restored = await saving.saveArtifacts(account, id, new AbortController().signal)
  expect(restored.saved).toHaveLength(3)
  expect(await readFile(changedVector, 'utf8')).toBe('user edited local vector')
  expect(restored.saved!.find(item => item.key === 'vector')!.path).not.toBe(changedVector)
  expect(await readFile(restored.saved!.find(item => item.key === 'animation')!.path)).toEqual(content.animation!.bytes)
  expect(calls.filter(call => call.path.endsWith('/tasks') && call.method === 'POST')).toHaveLength(1)
  expect(calls.filter(call => call.path.endsWith('/content'))).toHaveLength(5)
})


it('retains a confirmed free quote rejection without a task submission and permits a new explicit draft', async () => {
  const { client, account, calls, send } = await setup()
  send.mockImplementationOnce(async () => new Response(JSON.stringify({ success: false, error: { code: 'invalid_parameters', message: '素材组合无效' } }), { status: 422 }))
  await expect(client.quote(account, request, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_parameters' })
  const rejected = (await client.records(account))[0]!
  expect(rejected.state).toBe('quote-rejected'); expect(rejected.quote_failure?.message).toBe('素材组合无效')
  expect((await client.query(account, id, new AbortController().signal)).state).toBe('quote-rejected')
  expect(rejected.request).toEqual(request)
  expect(calls.filter(call => call.method === 'POST' && call.path.endsWith('/tasks'))).toHaveLength(0)
})


it('binds an accepted recovery quote only to its matching outer original task', async () => {
  const { client, account, calls, send } = await setup()
  await client.quote(account, request, new AbortController().signal)
  await client.submit(account, id, new AbortController().signal)
  const original = send.getMockImplementation()!
  send.mockImplementation(async (path, init) => path.endsWith('/operations/' + id)
    ? new Response(JSON.stringify({ success: true, data: { client_operation_id: id, state: 'accepted', quote_id: quote.quote_id, task, quote: { ...quote, operation_state: 'accepted' } } }))
    : original(path, init))
  const recovered = await client.query(account, id, new AbortController().signal)
  expect(recovered.task?.artifacts).toHaveLength(3)
  expect(calls.filter(call => call.path.endsWith('/tasks') && call.method === 'POST')).toHaveLength(1)
  send.mockImplementationOnce(async () => new Response(JSON.stringify({ success: true, data: { client_operation_id: id, state: 'accepted', quote_id: quote.quote_id, task, quote: { ...quote, model: 'other', operation_state: 'accepted' } } })))
  await expect(client.query(account, id, new AbortController().signal)).rejects.toMatchObject({ code: 'operation_conflict' })
})
