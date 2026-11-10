/** Personal media choices through the production Loader and authenticated HTTP carrier. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Credits from '../src/index.ts'
import type { MediaPreferences, MediaPreferencesCatalog } from '../src/media-preferences-types.ts'

type Success<T> = { ok: true; account: { id: string }; accountOwner: string; payload: T }
let context: Context | undefined
let root: string | undefined
let upstream: Server | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (upstream !== undefined) await new Promise<void>((resolve, reject) => {
    upstream?.close((error) => { if (error === undefined) resolve(); else reject(error) })
    upstream?.closeAllConnections()
  })
  upstream = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

it.each([
  { directoryTool: 'list_image_models', freePrice: false },
  { directoryTool: 'list_video_models', freePrice: false },
  { directoryTool: 'list_image_models', freePrice: true },
])('initializes $directoryTool pricing (free=$freePrice) before relay authorization, then saves only public choices', async ({ directoryTool, freePrice }) => {
  const calls: { path: string; method: string }[] = []
  let visible = ['image-a', 'MiniMax-H3']
  let readPricing = false
  upstream = createServer((request, response) => {
    const path = request.url ?? ''
    calls.push({ path, method: request.method ?? 'GET' })
    response.setHeader('content-type', 'application/json')
    const answer = (data: unknown): void => { response.end(JSON.stringify({ success: true, data })) }
    if (path === '/harness/api/status') { answer({ client_media_defaults: {
      schema_version: 1, default_image_model: 'image-a', default_video_model: 'MiniMax-H3',
    } }); return }
    if (path === '/harness/api/pricing') {
      readPricing = true
      answer([{ model_name: 'image-a', supported_endpoint_types: ['image-generation'], supplier_cost: 'private-cost', lane: 'private-lane',
        parameters: { size: { enum: ['1:1'] }, resolution: { enum: ['1k'] },
          oneOf: [{ size: { const: '1:1' }, resolution: { const: '1k' } }] },
        retail_price_rows: [{ params: { size: '1:1', resolution: '1k', count: 1, mode: 'text-to-image' },
          retail_cny: freePrice ? '0' : '0.19912', unit: 'CNY / image', supplier_token: 'sk-private-price',
          ...freePrice ? { is_free: true } : {} }] },
      { model_name: 'image-hidden', supported_endpoint_types: ['image-generation'] },
      { model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] }]); return
    }
    if (path === '/harness/v1/models') {
      expect(readPricing).toBe(true)
      expect(request.headers.authorization).toBe('Bearer sk-private-relay')
      response.end(JSON.stringify({ data: visible.map(id => ({ id,
        supported_endpoint_types: [id.startsWith('image') ? 'image-generation' : 'openai-video'] })) })); return
    }
    if (path === '/harness/api/user/self') {
      expect(request.headers.authorization).toBe('Bearer private-access')
      answer({ id: 7, group: 'default', quota: 1000000 }); return
    }
    response.writeHead(404); response.end('{}')
  })
  await new Promise<void>(resolve => upstream?.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('Expected local fixture address')
  root = await mkdtemp(join(tmpdir(), 'dsh-media-preferences-loader-'))
  const stateDir = join(root, 'credits')
  await mkdir(stateDir)
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({ token: 'private-product-token', expiresAt: '9999-01-01T00:00:00.000Z',
    account: { id: '7', phone: 'fixture' }, relay: { key: 'sk-private-relay' }, upstream: { token: 'private-access',
      expiresAt: '9999-01-01T00:00:00.000Z' } }), { mode: 0o600 })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, ["- name: 'fixture:credentials'", "- name: '@deepseek-ai/dsh-host-webserver'", '  config:',
    "    host: '127.0.0.1'", '    port: 0', "- name: '@deepseek-ai/dsh-client-connection'", "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'", "- name: '@deepseek-ai/dsh-credits-index'", '  config:', `    stateDir: '${stateDir}'`,
    `    newApiBaseUrl: 'http://127.0.0.1:${String(address.port)}/harness'`, '    timeoutMs: 1000', '    creditsPerYuan: 1250', '    accountReadMinIntervalMs: 0', ''].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  let credential: CredentialRecord | undefined
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-client-connection', Connection],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools], ['@deepseek-ai/dsh-credits-index', Credits],
    ['fixture:credentials', { apply(ctx: Context) { ctx.provide('credentials', {
      resolve: async () => undefined, set: async () => {}, unset: async () => {},
      modifyRecord: async (...[_key, modify]: Parameters<CredentialProvider['modifyRecord']>) => {
        credential = await modify(credential) ?? credential
        return credential
      },
    }) } }],
  ])
  context.loader.internal = { version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
    if (!modules.has(specifier)) throw new Error(`Unexpected fixture module ${specifier}`)
    return modules.get(specifier)
  } } as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  const base = `http://127.0.0.1:${String(context.webServer.port)}`
  const login = new URL(context.connection.authenticatedUrl(base))
  const headers: Record<string, string> = {}
  context.connection.authorizeIndex({ method: 'GET', url: login.pathname + login.search, headers: { host: login.host } }, {
    writeHead(_status, value) { Object.assign(headers, value) }, end() {},
  })
  const cookie = headers['set-cookie']?.split(';')[0]
  if (cookie === undefined) throw new Error('Expected authenticated fixture cookie')
  const read = async <T>(path = ''): Promise<Success<T>> => (await fetch(`${base}/credits/api/media/preferences${path}`,
    { headers: { cookie } })).json() as Promise<Success<T>>
  expect((await fetch(`${base}/credits/api/media/preferences`)).status).toBe(401)
  const initial = await read<MediaPreferences>()
  expect(initial.ok).toBe(true)
  expect(calls).toHaveLength(0)
  const listed = await context.tools.execute({ name: directoryTool, callId: ToolCallId('cold-directory'),
    arguments: {}, signal: new AbortController().signal })
  expect(listed.isError).toBe(false)
  const catalog = await read<MediaPreferencesCatalog>('/catalog')
  expect(catalog.ok).toBe(true)
  expect(catalog.payload.catalog.image.map(model => model.id)).toEqual(['image-a'])
  expect(catalog.payload.catalog.video.map(model => model.id)).toEqual(['MiniMax-H3'])
  expect(catalog.payload.catalog.image[0]?.pricing).toEqual({ schema_version: 1, status: 'available', basis: 'default',
    source: 'public-retail', unit: 'points/image', credits_per_yuan: '1250', coverage: 'complete',
    rows: [{ parameters: { size: '1:1', resolution: '1k', count: 1 }, points: freePrice ? '0' : '248.9', input: 'text',
      ...freePrice ? { is_free: true } : {} }] })
  expect(catalog.payload.catalog.video[0]?.pricing)
    .toMatchObject({ status: 'unavailable', unit: 'points/second', rows: [] })
  expect(JSON.stringify((await read<MediaPreferences>()).payload)).not.toMatch(/pricing|248\.9|retail|credits_per_yuan|is_free/u)

  expect(catalog.payload.defaults).toEqual({ image: { model: 'image-a', configured: true, available: true },
    video: { model: 'MiniMax-H3', configured: true, available: true } })
  expect(JSON.stringify(catalog))
    .not.toMatch(/private-(?:cost|lane|access|product)|sk-private|supplier_token|supplier_cost|"route"|"groups"/u)
  const put = async (body: unknown) => (await fetch(`${base}/credits/api/media/preferences`, { method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<Success<MediaPreferences>>
  const body = { schema_version: 1, expected_account_owner: initial.accountOwner, expected_revision: initial.payload.revision,
    image: { model: 'image-a', parameters: { size: '1:1', resolution: '1k' } }, video: { model: 'MiniMax-H3', parameters: {} } }
  const saved = await put(body)
  expect(saved.ok).toBe(true)
  expect(saved.payload.image).toEqual(body.image)
  expect(JSON.stringify(saved.payload)).not.toMatch(/pricing|is_free|credits_per_yuan/u)
  expect(await put(body)).toMatchObject({ ok: false, code: 'MEDIA_PREFERENCES_CONFLICT' })
  expect(await put({ ...body, expected_revision: saved.payload.revision, expected_account_owner: 'b'.repeat(64) }))
    .toMatchObject({ ok: false, code: 'ACCOUNT_CHANGED' })
  visible = ['MiniMax-H3']
  const reduced = await read<MediaPreferencesCatalog>('/catalog')
  expect(reduced.payload.image).toEqual(body.image)
  expect(reduced.payload.catalog.image).toEqual([])
  const cleared = await put({ ...body, expected_revision: saved.payload.revision, image: null })
  expect(cleared.ok).toBe(true)
  expect(cleared.payload.image).toBeNull()
  expect((await fetch(`${base}/credits/api/media/preferences/catalog`, { method: 'PUT', headers: { cookie } })).status).toBe(405)
  expect(calls.every(call => call.method === 'GET')).toBe(true)
  expect(calls.some(call => /generations|quote|tasks/u.test(call.path))).toBe(false)
  expect({ account: catalog.account, catalog: {
    image: catalog.payload.catalog.image.map(model => ({ id: model.id, sizes: model.kind === 'image' ? model.params.sizes : [] })),
    video: catalog.payload.catalog.video.map(model => ({ id: model.id, resolutions: model.kind === 'video' ? model.params.resolutions : [] })),
  }, defaults: catalog.payload.defaults, saved: { image: saved.payload.image, video: saved.payload.video } })
    .toMatchInlineSnapshot(`
      {
        "account": {
          "id": "7",
        },
        "catalog": {
          "image": [
            {
              "id": "image-a",
              "sizes": [
                "1:1",
              ],
            },
          ],
          "video": [
            {
              "id": "MiniMax-H3",
              "resolutions": [
                "768P",
                "2K",
              ],
            },
          ],
        },
        "defaults": {
          "image": {
            "available": true,
            "configured": true,
            "model": "image-a",
          },
          "video": {
            "available": true,
            "configured": true,
            "model": "MiniMax-H3",
          },
        },
        "saved": {
          "image": {
            "model": "image-a",
            "parameters": {
              "resolution": "1k",
              "size": "1:1",
            },
          },
          "video": {
            "model": "MiniMax-H3",
            "parameters": {},
          },
        },
      }
    `)
})
