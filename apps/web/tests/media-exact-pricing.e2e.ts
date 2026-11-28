/** Built finite choices and exact units with local synthetic browser responses, never supplier qualification. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import type { MediaV2Record, MediaV2Request } from '../../../packages/client/ui-primitives/src/media-v2-types.ts'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const prefix = '/credits/api/media-v2', account = 'synthetic-exact-price-owner', owner = 'a'.repeat(64)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', 'base64')
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const revision = 'b'.repeat(64)
const parameters = { mode: 'reference', duration: 30, resolution: '768P' }
const combination = (duration: number, resolution: string) => ({ parameters: {
  duration: { allowed_values: [duration] }, resolution: { allowed_values: [resolution] },
}, required_parameters: ['duration', 'resolution'] })
const model = { id: 'synthetic-finite-video', display_name: 'Synthetic finite video', kind: 'video', enabled: true,
  model_version: 'synthetic-v1', parameters_schema: { type: 'object', properties: {
    prompt: { type: 'string' }, mode: { type: 'string', enum: ['reference'], default: 'reference' },
    duration: { type: 'integer', enum: [15, 30], default: 30 },
    resolution: { type: 'string', enum: ['768P', '1080P'], default: '1080P' }, images: { type: 'array' },
  } }, asset_fields: [{ name: 'images', media_kind: 'image', native_shape: 'multiple', min_items: 0, max_items: 2,
    mime_types: ['image/png'], constraints: { max_bytes: 1048576 } }],
  intents: [{ id: 'reference', label: 'Reference generation', requires_assets: true }],
  pricing: { display: 'Synthetic per-work reference', credits_per_yuan: 1000, quote_required: true,
    currency: 'CNY', policy_revision: revision, specification_rows: [{ id: 'c'.repeat(64), parameters,
      billing_unit: 'per_video', quantity: 1, unit_price_cny: '1.25', total_cny: '1.25', quote_required: true, policy_revision: revision }] },
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected synthetic JSON object')
  return value as Record<string, unknown>
}
function selected(value: unknown): MediaV2Request {
  const row = object(value), values = object(row.parameters), assets = object(row.assets)
  if (typeof row.client_operation_id !== 'string' || row.model !== model.id || row.model_version !== model.model_version
    || row.intent !== 'reference' || values.mode !== 'reference' || values.duration !== 30 || values.resolution !== '768P'
    || !Array.isArray(assets.images) || assets.images.length !== 1 || assets.images[0] !== 'synthetic-original-image') {
    throw new Error('Unexpected quotation or lost original draft/material')
  }
  return { client_operation_id: row.client_operation_id, model: row.model, model_version: row.model_version,
    intent: row.intent, parameters: { mode: 'reference', duration: 30, resolution: '768P' }, assets: { images: [assets.images[0]] } }
}

it('retains an unsupported 30-second draft and references, then uses one exact per-video price and explicit original requote', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-exact-price-browser-'))
  const output = process.env.DSH_EXACT_PRICING_BROWSER_EVIDENCE ?? join(process.cwd(), '.artifacts')
  await mkdir(output, { recursive: true })
  const evidence = await mkdtemp(join(output, 'exact-price-'))
  const cleanup: { scaffold?: WebScaffold; browser?: Browser; page?: Page } = {}
  const external: string[] = [], unexpected: string[] = [], sentinelCalls: string[] = []
  const uploads: { id: string; bytes: number; sha256: string }[] = []
  const quotes: { request: MediaV2Request; requote: string | undefined }[] = [], submissions: string[] = []
  let narrowed = false, operation: MediaV2Record | undefined
  const sentinel = createServer((incoming, response) => {
    sentinelCalls.push(`${incoming.method ?? 'GET'} ${incoming.url ?? ''}`)
    response.setHeader('content-type', 'application/json')
    if (incoming.method !== 'GET') { response.statusCode = 405; response.end('{"success":false}'); return }
    if (incoming.url === '/harness/api/status') { response.end('{"success":true,"data":{}}'); return }
    if (incoming.url === '/harness/v1/models') { response.end('{"object":"list","data":[]}'); return }
    if (incoming.url === '/harness/api/pricing') { response.end('{"success":true,"data":[]}'); return }
    response.statusCode = 404; response.end('{"success":false}')
  })
  onTestFinished(async ({ task }) => {
    try {
      if (task.result?.state === 'fail' && cleanup.page !== undefined && !cleanup.page.isClosed()) {
        await cleanup.page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true, animations: 'disabled' })
        await writeFile(join(evidence, 'failure-aria.txt'), await cleanup.page.locator('body').ariaSnapshot())
      }
      await writeFile(join(evidence, 'observed.json'), JSON.stringify({ narrowed, uploads, quotes, submissions,
        operation, unexpected, external, sentinelCalls }, null, 2) + '\n')
    } finally {
      try { await cleanup.browser?.close() } finally {
        try { await cleanup.scaffold?.close() } finally {
          try {
            if (sentinel.listening) await new Promise<void>((resolve, reject) => {
              sentinel.close((error) => { if (error === undefined) resolve(); else reject(error) }); sentinel.closeAllConnections()
            })
          } finally { await rm(root, { recursive: true, force: true }) }
        }
      }
    }
  })
  await new Promise<void>((resolve, reject) => { sentinel.once('error', reject); sentinel.listen(0, '127.0.0.1', resolve) })
  const address = sentinel.address()
  if (address === null || typeof address === 'string') throw new Error('Expected owned loopback sentinel')
  const overlay = join(root, 'exact-pricing.patch.yml')
  await writeFile(overlay, JSON.stringify([{ id: 'credits-index', config: { newApiBaseUrl: `http://127.0.0.1:${address.port}/harness`,
    baseUrl: '', bridgeBaseUrl: '', stateDir: join(root, 'credits') } }]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay }); cleanup.scaffold = scaffold
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath }); cleanup.browser = browser
  const page = await newEnglishPage(browser); cleanup.page = page; page.setDefaultTimeout(15_000)
  const tripwire = watchConsole(page), origin = new URL(scaffold.baseUrl).origin
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin) {
      external.push(url.origin); await route.abort('blockedbyclient'); return
    }
    await route.continue()
  })
  await page.route('**/artifacts/api/list', route => route.fulfill({ status: 200, json: { items: [] } }))
  await page.route('**/credits/api/**', async (route) => {
    const incoming = route.request(), url = new URL(incoming.url()), method = incoming.method()
    const mediaReply = async (data: unknown): Promise<void> => route.fulfill({ status: 200, json: { success: true, data } })
    const reply = async (payload: unknown): Promise<void> => route.fulfill({ status: 200,
      json: { ok: true, payload, account: { id: account }, accountOwner: owner } })
    if (url.pathname === `${prefix}/models` && method === 'GET') {
      const combinations = [combination(30, '768P'), combination(15, '1080P'), ...narrowed ? [] : [combination(30, '1080P')]]
      await mediaReply({ capabilities: { exact_specification_pricing_v1: true, explicit_requote_v1: true, selection_constraints_v1: true,
        max_upload_bytes: 1048576 },
      models: [{ ...model, selection_constraints: { schema_version: 1, combinations } }], credits_per_yuan: 1000 }); return
    }
    if (url.pathname === `${prefix}/operations` && method === 'GET') {
      await mediaReply({ operations: operation === undefined ? [] : [operation] }); return
    }
    if (url.pathname === `${prefix}/assets` && method === 'POST') {
      const bytes = incoming.postDataBuffer(), id = url.searchParams.get('client_asset_id')
      if (bytes === null || id === null || url.searchParams.get('field') !== 'images' || url.searchParams.get('model') !== model.id) {
        throw new Error('Unexpected synthetic reference upload')
      }
      uploads.push({ id, bytes: bytes.length, sha256: sha(bytes) })
      await mediaReply({ asset_id: 'synthetic-original-image', client_asset_id: id, model: model.id, state: 'ready', media_kind: 'image',
        mime_type: 'image/png', bytes: bytes.length, sha256: sha(bytes), expires_at: Date.now() / 1000 + 600, width: 1, height: 1 }); return
    }
    if (url.pathname === `${prefix}/quotes` && method === 'POST') {
      const request = selected(incoming.postDataJSON()), requote = incoming.headers()['x-yunshu-media-requote']
      if (!narrowed || quotes.length >= 2 || (quotes.length === 0 ? requote !== undefined
        : requote !== '1' || request.client_operation_id !== quotes[0]?.request.client_operation_id)) throw new Error('Unexpected quote/header/identity')
      quotes.push({ request, requote })
      operation = { version: 1, owner: account, request, state: 'quoted', updated_at: Date.now() / 1000,
        quote: { quote_id: `synthetic-price-${quotes.length}`, client_operation_id: request.client_operation_id, request_sha256: 'd'.repeat(64),
          retail_cny: '1.25', credits: 1250, credits_per_yuan: 1000, expires_at: Date.now() / 1000 + 600 } }
      await mediaReply(operation); return
    }
    if (url.pathname.startsWith(`${prefix}/operations/`) && method === 'GET' && operation !== undefined) {
      if (url.pathname !== `${prefix}/operations/${operation.request.client_operation_id}`) throw new Error('Unexpected recovery UUID')
      await mediaReply(operation); return
    }
    if (url.pathname === `${prefix}/tasks` && method === 'POST') {
      submissions.push(incoming.postData() ?? ''); throw new Error('This inspection never authorizes generation')
    }
    if (url.pathname.startsWith(prefix)) { unexpected.push(`${method} ${url.pathname}`); await mediaReply({}); return }
    if (url.pathname === '/credits/api/session') { await reply({ signedIn: true, creditsPerYuan: 1000,
      accountOwner: owner, account: { id: account, phone: '' } }); return }
    if (url.pathname === '/credits/api/summary') { await reply({ balance_points: 10000 }); return }
    if (url.pathname === '/credits/api/media/catalog') { await reply({ image: [], video: [], audio: [] }); return }
    if (url.pathname === '/credits/api/creation/content') {
      const empty = { title: { en: '', zh: '' }, description: { en: '', zh: '' }, promptPlaceholder: { en: '', zh: '' }, categories: [], templates: [], presets: [] }
      await reply({ schemaVersion: 1, revision: 'synthetic-only', image: empty, video: empty }); return
    }
    if (url.pathname === '/credits/api/media/preferences') { await reply({ schema_version: 1, scope: owner,
      revision: 'e'.repeat(64), image: null, video: null }); return }
    if (url.pathname === '/credits/api/creative/projects') { await reply({ accountId: account, projects: [] }); return }
    if (url.pathname === '/credits/api/announcement-banner') { await reply({ enabled: false, scope: '0'.repeat(64), revision: '1'.repeat(64), announcements: [] }); return }
    if (url.pathname === '/credits/api/chat-usage') { await reply({ scope: 'chat-model', status: 'unavailable', settledRequests: 0,
      totalRequests: 0, accountId: account }); return }
    if (url.pathname === '/credits/api/usage') { await reply({ rows: [], asOf: new Date().toISOString(), delayMinutes: 0 }); return }
    if (method !== 'GET') unexpected.push(`${method} ${url.pathname}`)
    await route.fulfill({ status: 404, json: { ok: false, code: 'SYNTHETIC_ROUTE_UNAVAILABLE' } })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' }); await connectFreshWorkspace(page, scaffold.workspaceCwd)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('tab', { name: 'Videos', exact: true }).click()
  await page.getByRole('button', { name: 'Models and processing', exact: true }).click()
  const composer = page.getByRole('region', { name: 'Models and processing', exact: true })
  await composer.getByRole('combobox', { name: 'Input workflow', exact: true }).selectOption('reference')
  expect(await composer.getByRole('combobox', { name: 'Input workflow', exact: true }).inputValue()).toBe('reference')
  await composer.getByLabel('Add media: images', { exact: true }).setInputFiles({ name: 'original.png', mimeType: 'image/png', buffer: png })
  await expect.poll(() => uploads.length).toBe(1)
  const duration = composer.getByRole('combobox', { name: 'duration', exact: true })
  expect(await duration.inputValue()).toBe('30')
  const savedDrafts = await page.evaluate(() => Object.keys(sessionStorage)
    .filter(key => key.startsWith('dsh:media-v2:draft-v1:video:')).map(key => sessionStorage.getItem(key)))
  expect(savedDrafts).toHaveLength(1)
  const savedDraft: unknown = JSON.parse(savedDrafts[0] ?? 'null')
  expect(object(savedDraft).intent).toBe('reference')
  narrowed = true; await composer.getByRole('button', { name: 'Refresh models', exact: true }).click()
  const retained = duration.getByRole('option', { name: '30', exact: true })
  await expect.poll(() => retained.evaluate(option => option instanceof HTMLOptionElement && option.disabled)).toBe(true)
  expect(await duration.inputValue()).toBe('30'); expect(await retained.getAttribute('disabled')).not.toBeNull()
  expect(await composer.getByRole('combobox', { name: 'resolution', exact: true }).inputValue()).toBe('1080P')
  expect(await composer.getByText('original.png', { exact: true }).count()).toBe(1)
  expect(await composer.getByRole('combobox', { name: 'Input workflow', exact: true }).inputValue()).toBe('reference')
  expect(await composer.getByRole('button', { name: 'Get exact credits', exact: true }).isDisabled()).toBe(true)
  expect(quotes).toEqual([]); expect(submissions).toEqual([])
  const screenshots: string[] = []
  const blocked = join(evidence, 'blocked-30s-original-material.png')
  await page.screenshot({ path: blocked, fullPage: true, animations: 'disabled' }); screenshots.push(blocked)
  await composer.getByRole('combobox', { name: 'resolution', exact: true }).selectOption('768P')
  expect(await duration.inputValue()).toBe('30')
  // References need a fresh authoritative quote; they are never priced by local multiplication.
  await composer.getByRole('button', { name: 'Get exact credits', exact: true }).click()
  await composer.getByText('This request: 1,250 credits', { exact: true }).waitFor()
  await expect.poll(() => quotes.length).toBe(1)
  expect(quotes[0]?.requote).toBeUndefined()
  await composer.getByRole('button', { name: 'Get exact credits', exact: true }).click()
  await expect.poll(() => quotes.length).toBe(2)
  expect(quotes[1]?.requote).toBe('1'); expect(quotes[1]?.request).toEqual(quotes[0]?.request)
  expect(uploads).toEqual([{ id: uploads[0]!.id, bytes: png.length, sha256: sha(png) }])
  expect(submissions).toEqual([]); expect(external).toEqual([]); expect(unexpected).toEqual([])
  for (const [theme, width] of [['light', 1440], ['dark', 780]] as const) {
    await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height: 1100 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    const path = join(evidence, `exact-price-${theme}-${width}.png`)
    await page.screenshot({ path, fullPage: true, animations: 'disabled' }); screenshots.push(path)
  }
  expect(sentinelCalls.filter(item => !item.startsWith('GET '))).toEqual([])
  expect(tripwire.pageErrors).toEqual([]); expect(tripwire.warnings).toEqual([])
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ status: 'passed', mode: 'built UI synthetic responses only',
    quotes, uploads, submissions, external, unexpected, sentinelCalls, screenshots, console: tripwire }, null, 2) + '\n')
})
