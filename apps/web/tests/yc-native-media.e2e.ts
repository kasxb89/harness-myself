/** Built native-media UI with synthetic browser routes; no supplier, billing or production qualification. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import type { ModelCapability } from '../../../packages/host/credits-index/src/media.ts'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const PREFIX = '/credits/api/media-v2'
const ACCOUNT = 'synthetic-yc-native-browser-account'
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', 'base64')
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
interface Request {
  client_operation_id: string
  model: string
  model_version: string
  intent: string
  parameters: Record<string, unknown>
  assets: Record<string, string[]>
}
interface Operation {
  version: 1
  owner: string
  request: Request
  state: 'quoted' | 'accepted'
  quote: {
    quote_id: string
    client_operation_id: string
    request_sha256: string
    retail_cny: string
    credits: number
    credits_per_yuan: number
    expires_at: number
  }
  updated_at: number
  task?: {
    id: string
    model: string
    kind: 'image'
    status: 'pending' | 'succeeded'
    is_final: boolean
    artifacts: { key: string; type: 'image'; mime_type: string; order: number; filename: string }[]
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected synthetic object')
  return value as Record<string, unknown>
}
function request(value: unknown): Request {
  const row = object(value), parameters = object(row.parameters), assets = object(row.assets)
  if (typeof row.client_operation_id !== 'string' || typeof row.model !== 'string' || typeof row.model_version !== 'string' || typeof row.intent !== 'string') throw new Error('Missing original request identity')
  const selected: Record<string, string[]> = {}
  for (const [field, values] of Object.entries(assets)) {
    if (!Array.isArray(values) || !values.every((value): value is string => typeof value === 'string')) throw new Error('Expected ordered reference IDs')
    selected[field] = values
  }
  return { client_operation_id: row.client_operation_id, model: row.model, model_version: row.model_version,
    intent: row.intent, parameters, assets: selected }
}
const ordinary: ModelCapability = { id: 'synthetic-ordinary-image', displayName: 'Synthetic ordinary model', kind: 'image', groups: [], route: '/v1/images/generations', verified: true, source: 'newapi', notes: [],
  params: { sizes: ['1024x1024'], maxCount: 1, maxEdits: 0, resolutions: [], qualities: [], backgrounds: [], formats: [], moderations: [], seed: false } }
const native = {
  id: 'synthetic-native-i2i', display_name: 'Synthetic native image editing', kind: 'image', model_version: 'synthetic-native-v1', enabled: true,
  parameters_schema: { type: 'object', additionalProperties: false, properties: {
    prompt: { type: 'string' }, mode: { type: 'string', enum: ['image-edit'], default: 'image-edit' },
    images: { type: 'array', items: { type: 'string' } },
  } }, asset_fields: [{ name: 'images', media_kind: 'image', native_shape: 'multiple', min_items: 1, max_items: 2,
    mime_types: ['image/png'], constraints: { max_bytes: 1048576 } }],
  intents: [{ id: 'reference', label: 'Reference generation', requires_assets: true }],
  pricing: { display: 'Synthetic quote only', credits_per_yuan: 1000, quote_required: true },
}
const textOnly = { ...native, id: 'synthetic-native-text', display_name: 'Synthetic text-only model',
  parameters_schema: { type: 'object', additionalProperties: false, properties: { prompt: { type: 'string' } } },
  asset_fields: [], intents: [{ id: 'text', label: 'Text generation', requires_assets: false }] }

it('preserves native reference bytes and order, blocks incompatible switching and recovers one unknown operation in the built UI', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-yc-native-browser-'))
  const evidenceRoot = process.env.DSH_YC_NATIVE_BROWSER_EVIDENCE ?? join(process.cwd(), '.artifacts')
  await mkdir(evidenceRoot, { recursive: true })
  const evidence = await mkdtemp(join(evidenceRoot, 'yc-native-media-'))
  const cleanup: { scaffold?: WebScaffold; browser?: Browser; page?: Page } = {}
  const sentinelCalls: string[] = []
  const sentinel = createServer((request, response) => {
    sentinelCalls.push(`${request.method ?? 'GET'} ${request.url ?? ''}`)
    response.setHeader('content-type', 'application/json')
    if (request.method !== 'GET') { response.statusCode = 405; response.end('{"success":false}'); return }
    if (request.url === '/harness/api/status') { response.end('{"success":true,"data":{}}'); return }
    if (request.url === '/harness/v1/models') { response.end('{"object":"list","data":[]}'); return }
    if (request.url === '/harness/api/pricing') { response.end('{"success":true,"data":[]}'); return }
    response.statusCode = 404; response.end('{"success":false}')
  })
  onTestFailed(async () => { if (cleanup.page !== undefined && !cleanup.page.isClosed()) await cleanup.page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }) })
  onTestFinished(async () => {
    try { await cleanup.browser?.close() } finally {
      try { await cleanup.scaffold?.close() } finally {
        try {
          if (sentinel.listening) await new Promise<void>((resolve, reject) => {
            sentinel.close((error) => { if (error === undefined) resolve(); else reject(error) }); sentinel.closeAllConnections()
          })
        } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  })
  await new Promise<void>((resolve, reject) => { sentinel.once('error', reject); sentinel.listen(0, '127.0.0.1', resolve) })
  const address = sentinel.address()
  if (address === null || typeof address === 'string') throw new Error('Expected owned loopback sentinel')
  const overlay = join(root, 'native-media.patch.yml')
  await writeFile(overlay, JSON.stringify([{ id: 'credits-index', config: {
    newApiBaseUrl: `http://127.0.0.1:${address.port}/harness`, baseUrl: '', bridgeBaseUrl: '', stateDir: join(root, 'credits'),
  } }]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay }); cleanup.scaffold = scaffold
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  cleanup.browser = browser
  const page = await newEnglishPage(browser); cleanup.page = page
  page.setDefaultTimeout(15_000)
  const tripwire = watchConsole(page)
  const uploads: { field: string; clientId: string; assetId: string; bytes: number; sha256: string; name: string }[] = []
  const quotes: Request[] = [], submissions: string[] = [], queries: string[] = [], saves: string[] = [], unexpected: string[] = []
  let operation: Operation | undefined
  await page.route('**/artifacts/api/list', route => route.fulfill({ status: 200, json: { items: [] } }))
  await page.route('**/credits/api/**', async (route) => {
    const incoming = route.request(), url = new URL(incoming.url()), method = incoming.method()
    const ordinaryReply = async (payload: unknown): Promise<void> => route.fulfill({ status: 200, json: { ok: true, payload } })
    const mediaReply = async (data: unknown): Promise<void> => route.fulfill({ status: 200, json: { success: true, data } })
    if (url.pathname === `${PREFIX}/models` && method === 'GET') {
      await mediaReply({ capabilities: { max_upload_bytes: 1048576 }, models: [native, textOnly], credits_per_yuan: 1000 }); return
    }
    if (url.pathname === `${PREFIX}/operations` && method === 'GET') { await mediaReply({ operations: operation === undefined ? [] : [operation] }); return }
    if (url.pathname === `${PREFIX}/assets` && method === 'POST') {
      const bytes = incoming.postDataBuffer(), field = url.searchParams.get('field'), clientId = url.searchParams.get('client_asset_id')
      if (bytes === null || field !== 'images' || clientId === null || url.searchParams.get('model') !== native.id) throw new Error('Unexpected material request')
      const assetId = `synthetic-asset-${uploads.length + 1}`, name = decodeURIComponent(incoming.headers()['x-file-name'] ?? '')
      uploads.push({ field, clientId, assetId, bytes: bytes.length, sha256: sha(bytes), name })
      await mediaReply({ asset_id: assetId, client_asset_id: clientId, model: native.id, state: 'ready', media_kind: 'image', mime_type: 'image/png',
        bytes: bytes.length, sha256: sha(bytes), expires_at: Math.floor(Date.now() / 1000) + 600, width: 1, height: 1 }); return
    }
    if (url.pathname === `${PREFIX}/quotes` && method === 'POST') {
      const original = request(incoming.postDataJSON()), now = Math.floor(Date.now() / 1000)
      quotes.push(original)
      operation = { version: 1, owner: ACCOUNT, request: original, state: 'quoted', updated_at: now,
        quote: { quote_id: 'synthetic-quote', client_operation_id: original.client_operation_id, request_sha256: 'a'.repeat(64), retail_cny: '0.25', credits: 250, credits_per_yuan: 1000, expires_at: now + 600 } }
      await mediaReply(operation); return
    }
    if (url.pathname === `${PREFIX}/tasks` && method === 'POST') {
      const body = object(incoming.postDataJSON()), id = body.client_operation_id
      if (typeof id !== 'string' || operation === undefined || operation.request.client_operation_id !== id || submissions.length > 0) throw new Error('Repeated or unowned submission')
      submissions.push(id)
      operation = { ...operation, state: 'accepted', task: { id: 'synthetic-original-task', model: native.id, kind: 'image', status: 'pending', is_final: false, artifacts: [] } }
      // The server accepted this one synthetic operation; the browser loses only its response.
      await route.abort('failed'); return
    }
    if (url.pathname.startsWith(`${PREFIX}/operations/`) && method === 'GET') {
      const id = url.pathname.slice(`${PREFIX}/operations/`.length)
      if (operation === undefined || id !== operation.request.client_operation_id) throw new Error('Unexpected recovery identity')
      queries.push(id)
      operation = { ...operation, task: { id: 'synthetic-original-task', model: native.id, kind: 'image', status: 'succeeded', is_final: true,
        artifacts: ['first', 'second'].map((key, order) => ({ key, type: 'image', mime_type: 'image/png', order, filename: `${key}.png` })) } }
      await mediaReply(operation); return
    }
    if (url.pathname === `${PREFIX}/save` && method === 'POST') {
      const body = object(incoming.postDataJSON()), id = body.client_operation_id
      if (operation === undefined || id !== operation.request.client_operation_id) throw new Error('Unexpected save identity')
      saves.push(id); await mediaReply({ ...operation, saved: operation.task?.artifacts.map(item => ({ key: item.key, path: `/synthetic-saved/${item.filename}` })) }); return
    }
    if (url.pathname.startsWith(`${PREFIX}/tasks/synthetic-original-task/artifacts/`) && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'image/png', body: image }); return
    }
    if (url.pathname.startsWith(PREFIX)) {
      unexpected.push(`${method} ${url.pathname}`); await route.fulfill({ status: 404, json: { success: false, error: { code: 'model_not_available', message: 'Synthetic route unavailable' } } }); return
    }
    if (url.pathname === '/credits/api/session') { await ordinaryReply({ signedIn: true, creditsPerYuan: 1000, account: { id: ACCOUNT, phone: '' } }); return }
    if (url.pathname === '/credits/api/summary') { await ordinaryReply({ balance_points: 10000 }); return }
    if (url.pathname === '/credits/api/media/catalog') { await ordinaryReply({ image: [ordinary], video: [], audio: [] }); return }
    if (url.pathname === '/credits/api/creation/content') { await ordinaryReply({ schemaVersion: 1, revision: 'synthetic-ui-only', image: { title: { en: '', zh: '' }, description: { en: '', zh: '' }, promptPlaceholder: { en: '', zh: '' }, categories: [], templates: [], presets: [] }, video: { title: { en: '', zh: '' }, description: { en: '', zh: '' }, promptPlaceholder: { en: '', zh: '' }, categories: [], templates: [], presets: [] } }); return }
    if (url.pathname === '/credits/api/creative/projects') { await ordinaryReply({ accountId: ACCOUNT, projects: [] }); return }
    if (url.pathname === '/credits/api/announcement-banner') { await ordinaryReply({ enabled: false, scope: '0'.repeat(64), revision: '1'.repeat(64), announcements: [] }); return }
    if (url.pathname === '/credits/api/chat-usage') { await ordinaryReply({ scope: 'chat-model', status: 'unavailable', settledRequests: 0, totalRequests: 0, accountId: ACCOUNT }); return }
    if (url.pathname === '/credits/api/usage') { await ordinaryReply({ rows: [], asOf: new Date().toISOString(), delayMinutes: 0 }); return }
    if (method !== 'GET') unexpected.push(`${method} ${url.pathname}`)
    await route.fulfill({ status: 404, json: { ok: false, code: 'SYNTHETIC_ROUTE_UNAVAILABLE' } })
  })
  const openNative = async (): Promise<void> => {
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.getByRole('button', { name: 'Models and processing', exact: true }).click()
    await page.getByRole('region', { name: 'Models and processing', exact: true }).waitFor()
  }
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  await openNative()
  const composer = page.getByRole('region', { name: 'Models and processing', exact: true })
  await composer.getByRole('combobox', { name: 'Input workflow', exact: true }).selectOption('reference')
  await composer.getByLabel('Add media: images', { exact: true }).setInputFiles([{ name: 'first.png', mimeType: 'image/png', buffer: image }, { name: 'second.png', mimeType: 'image/png', buffer: image }])
  await expect.poll(() => uploads.length).toBe(2)
  await composer.getByRole('button', { name: 'Move up: second.png', exact: true }).click()
  await composer.getByRole('combobox', { name: 'Model', exact: true }).selectOption(textOnly.id)
  expect(await composer.getByText('first.png', { exact: true }).count()).toBe(1)
  expect(await composer.getByText('second.png', { exact: true }).count()).toBe(1)
  expect(await composer.getByRole('combobox', { name: 'Input workflow', exact: true }).inputValue()).toBe('reference')
  expect(await composer.getByRole('button', { name: 'Get exact credits', exact: true }).isDisabled()).toBe(true)
  expect(quotes).toHaveLength(0); expect(submissions).toHaveLength(0)
  await composer.getByRole('combobox', { name: 'Model', exact: true }).selectOption(native.id)
  await composer.getByRole('button', { name: 'Get exact credits', exact: true }).click()
  await expect.poll(() => quotes.length).toBe(1)
  expect(quotes[0]?.assets.images).toEqual([uploads[1]?.assetId, uploads[0]?.assetId])
  expect(quotes[0]?.intent).toBe('reference'); expect(quotes[0]?.parameters.mode).toBe('image-edit')
  expect(uploads.map(item => item.sha256)).toEqual([sha(image), sha(image)])
  expect(uploads.map(item => item.bytes)).toEqual([image.length, image.length])
  await composer.getByRole('button', { name: 'Confirm generation', exact: true }).click()
  await composer.getByRole('alert').waitFor()
  expect(submissions).toEqual([quotes[0]!.client_operation_id])
  const warningStart = tripwire.warnings.length
  await page.reload({ waitUntil: 'load' }); acknowledgeReloadConnectionLoss(tripwire, warningStart)
  await openNative()
  await composer.getByRole('button', { name: 'Update original operation', exact: true }).click()
  await expect.poll(() => queries.length).toBe(1)
  await composer.getByRole('button', { name: 'Save every artifact', exact: true }).click()
  await composer.getByText('/synthetic-saved/second.png', { exact: true }).waitFor()
  expect(await composer.getByRole('link', { name: 'Download original', exact: true }).count()).toBe(2)
  expect(await composer.getByRole('img').count()).toBe(2)
  expect(quotes).toHaveLength(1); expect(submissions).toHaveLength(1); expect(saves).toEqual(submissions)
  expect(queries).toEqual(submissions)
  const screenshots: string[] = []
  for (const [theme, width] of [['light', 1440], ['dark', 780]] as const) {
    await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height: 1100 })
    await composer.getByRole('button', { name: 'Save every artifact', exact: true }).scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    const path = join(evidence, `native-media-${theme}-${width}.png`)
    await page.screenshot({ path, fullPage: true, animations: 'disabled' }); screenshots.push(path)
  }
  expect(unexpected).toEqual([])
  expect(sentinelCalls.filter(item => !item.startsWith('GET '))).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ status: 'passed', mode: 'built UI with synthetic browser media/account responses, not API or supplier qualification',
    uploads, quotes, submissions, queries, saves, screenshots, unexpected, sentinelCalls, console: tripwire }, null, 2) + '\n')
})
