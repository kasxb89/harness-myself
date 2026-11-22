import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { MediaV2Client } from '../src/media-v2-client.ts'
import { createMediaV2Proxy } from '../src/media-v2-proxy.ts'

const servers: Server[] = [], cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(close => close()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() }); server.closeIdleConnections()
  })))
})
const model = { id: 'native-processor', display_name: '复刻处理', kind: 'video', model_version: 'schema-1', enabled: true,
  description: '保留主体\n迁移参考动作',
  parameters_schema: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string', enum: ['pro'] } } },
  asset_fields: [{ name: 'videos', media_kind: 'video', native_shape: 'single', min_items: 1, max_items: 1, mime_types: ['video/mp4'], constraints: {} }],
  intents: [{ id: 'transform', label: '复刻', requires_assets: true }], pricing: { display: '按原素材秒数计费', quote_required: true } }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'media-v2-proxy-'))
  let requests = 0
  const client = new MediaV2Client({ baseUrl: 'https://synthetic.invalid/harness', directory, timeoutMs: 1000, creditsPerYuan: 2500 })
  const proxy = createMediaV2Proxy({ client, requestRejection: req => req.headers['x-local-test'] === 'connected' ? undefined : 403,
    capture: async () => ({ owner: 'synthetic-only', isCurrent: async () => true,
      fetch: async (path, init) => {
        requests += 1
        expect(path.startsWith('/v1/')).toBe(true)
        if (path.endsWith('/models')) return new Response(JSON.stringify({ success: true, data: { models: [model], capabilities: {
          media_generation_v2: true, quote_required: true, durable_operation_receipt: true, all_artifacts: true } } }))
        if (path.includes('/artifacts/vector/')) return new Response(init.method === 'HEAD' ? null : '<svg></svg>', { headers: { 'content-type': 'image/svg+xml' } })
        if (path.includes('/content')) return new Response(init.method === 'HEAD' ? null : Uint8Array.from([1, 2, 3, 4]), {
          status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/20', 'content-length': '4', 'accept-ranges': 'bytes' } })
        throw new Error('Unexpected synthetic route')
      } }) })
  cleanup.push(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }) })
  const server = createServer((req, res) => { void proxy.handle(req, res, new URL(req.url ?? '/', 'http://localhost').pathname.slice('/credits'.length), req.method ?? 'GET') })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No loopback port')
  return { base: `http://127.0.0.1:${address.port}/credits/api/media-v2`, requests: () => requests }
}
it('bridges the real HTTP wrapper and injects the existing Host product scale without exposing credentials', async () => {
  const { base } = await fixture()
  const response = await fetch(base + '/models', { headers: { 'x-local-test': 'connected' } })
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  expect(body).toMatchObject({ success: true, data: { credits_per_yuan: 2500,
    models: [{ id: model.id, pricing: { credits_per_yuan: 2500 } }] } })
  expect(JSON.stringify(body)).not.toMatch(/Bearer|synthetic-only/u)
})
it('rejects unconnected requests before contacting the gateway and preserves real Range/HEAD', async () => {
  const { base, requests } = await fixture()
  expect((await fetch(base + '/models')).status).toBe(403)
  expect(requests()).toBe(0)
  const response = await fetch(base + '/tasks/original/artifacts/main/content', { headers: { 'x-local-test': 'connected', range: 'bytes=0-3' } })
  expect(response.status).toBe(206)
  expect(response.headers.get('content-range')).toBe('bytes 0-3/20')
  expect(await response.arrayBuffer()).toEqual(Uint8Array.from([1, 2, 3, 4]).buffer)
  const head = await fetch(base + '/tasks/original/artifacts/main/content', { method: 'HEAD', headers: { 'x-local-test': 'connected' } })
  expect(head.status).toBe(206)
  expect(await head.text()).toBe('')
  const opaque = await fetch(base + '/tasks/original%3Aid/artifacts/main%3Alayer/content', {
    headers: { 'x-local-test': 'connected', range: 'bytes=0-3' },
  })
  expect(opaque.status).toBe(206)
  await opaque.body?.cancel()
})
it('serves vectors only as sandboxed downloads, never a document in the application origin', async () => {
  const { base } = await fixture()
  const response = await fetch(base + '/tasks/original/artifacts/vector/content', { headers: { 'x-local-test': 'connected' } })
  expect(response.headers.get('content-disposition')).toBe('attachment')
  expect(response.headers.get('content-security-policy')).toContain('sandbox')
  expect(await response.text()).toBe('<svg></svg>')
})
