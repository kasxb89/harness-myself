/** Built generic material rules with synthetic account/media responses and no generation. */
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

const prefix = '/credits/api/media-v2', account = 'synthetic-material-policy-owner', owner = 'a'.repeat(64)
const originalId = '10000000-0000-4000-8000-000000000077'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', 'base64')
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const model = { id: 'synthetic-conditional-source', display_name: 'Synthetic source modes', kind: 'video', enabled: true,
  model_version: 'synthetic-v1', parameters_schema: { type: 'object', properties: {
    prompt: { type: 'string' }, mode: { type: 'string', enum: ['reference', 'first-frame'], default: 'reference' },
    images: { type: 'array' },
  } }, asset_fields: [{ name: 'images', media_kind: 'image', native_shape: 'multiple', min_items: 0, max_items: 4,
    mime_types: ['image/png'], constraints: { max_bytes: 1048576 } }],
  intents: [{ id: 'reference', label: 'Reference generation', requires_assets: true }],
  pricing: { display: 'Synthetic only', credits_per_yuan: 1000, quote_required: true },
}
const materialConditions = { schema_version: 1, rules: [{ id: 'source-count', when: { mode: ['reference'] },
  asset_field: 'images', disallowed_counts: [1], message: 'One source image needs an explicit first-frame choice' }] }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected synthetic JSON object')
  return value as Record<string, unknown>
}
function request(value: unknown): MediaV2Request {
  const row = object(value), parameters = object(row.parameters), assets = object(row.assets)
  if (typeof row.client_operation_id !== 'string' || row.model !== model.id || row.model_version !== model.model_version
    || row.intent !== 'reference' || parameters.prompt !== 'Retain my exact source and draft' || parameters.mode !== 'first-frame'
    || !Array.isArray(assets.images) || assets.images.length !== 1 || assets.images[0] !== 'synthetic-original-upload') {
    throw new Error('Unexpected synthetic quotation or lost material')
  }
  return { client_operation_id: row.client_operation_id, model: row.model, model_version: row.model_version,
    intent: row.intent, parameters: { prompt: parameters.prompt, mode: parameters.mode }, assets: { images: [assets.images[0]] } }
}

it('blocks a material rule before quote, preserves explicit mode and recovers an original operation under unknown rules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-material-rule-browser-'))
  const output = process.env.DSH_MATERIAL_CONDITIONS_BROWSER_EVIDENCE ?? join(process.cwd(), '.artifacts')
  await mkdir(output, { recursive: true })
  const evidence = await mkdtemp(join(output, 'material-rule-'))
  const cleanup: { scaffold?: WebScaffold; browser?: Browser; page?: Page } = {}
  const sentinelCalls: string[] = [], external: string[] = [], unexpected: string[] = [], submissions: string[] = []
  const queries: string[] = [], quotes: MediaV2Request[] = [], uploads: { sha256: string; bytes: number; id: string }[] = []
  let newOperation: MediaV2Record | undefined, schemaVersion = 1
  const originalRequest: MediaV2Request = { client_operation_id: originalId, model: model.id, model_version: 'old-v0',
    intent: 'reference', parameters: { mode: 'reference', count: 2 }, assets: { videos: ['original-video-a', 'original-video-b'] } }
  const frozenOriginal = JSON.stringify(originalRequest)
  const original: MediaV2Record = { version: 1, owner: account, request: originalRequest, state: 'accepted', updated_at: 1,
    task: { id: 'original-accepted-task', model: model.id, kind: 'video', status: 'pending', is_final: false, artifacts: [] } }
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
      await writeFile(join(evidence, 'final-observed.json'), JSON.stringify({ schemaVersion, uploads, quotes, queries,
        submissions, external, unexpected, sentinelCalls, originalRequest }, null, 2) + '\n')
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
  if (address === null || typeof address === 'string') throw new Error('Expected owned sentinel listener')
  const overlay = join(root, 'material-policy.patch.yml')
  await writeFile(overlay, JSON.stringify([{ id: 'credits-index', config: { newApiBaseUrl: `http://127.0.0.1:${address.port}/harness`,
    baseUrl: '', bridgeBaseUrl: '', stateDir: join(root, 'credits') } }]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay }); cleanup.scaffold = scaffold
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath }); cleanup.browser = browser
  const page = await newEnglishPage(browser); cleanup.page = page
  page.setDefaultTimeout(15_000)
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
      await mediaReply({ capabilities: { material_conditions_v1: true, max_upload_bytes: 1048576 },
        models: [{ ...model, conditions: { ...materialConditions, schema_version: schemaVersion } }], credits_per_yuan: 1000 }); return
    }
    if (url.pathname === `${prefix}/operations` && method === 'GET') {
      await mediaReply({ operations: [original, ...newOperation === undefined ? [] : [newOperation]] }); return
    }
    if (url.pathname === `${prefix}/assets` && method === 'POST') {
      const bytes = incoming.postDataBuffer(), id = url.searchParams.get('client_asset_id')
      if (bytes === null || id === null || url.searchParams.get('field') !== 'images' || url.searchParams.get('model') !== model.id) {
        throw new Error('Unexpected synthetic material upload')
      }
      uploads.push({ id, bytes: bytes.length, sha256: digest(bytes) })
      await mediaReply({ asset_id: 'synthetic-original-upload', client_asset_id: id, model: model.id, state: 'ready',
        media_kind: 'image', mime_type: 'image/png', bytes: bytes.length, sha256: digest(bytes),
        expires_at: Date.now() / 1000 + 600, width: 1, height: 1 }); return
    }
    if (url.pathname === `${prefix}/quotes` && method === 'POST') {
      const chosen = request(incoming.postDataJSON()), now = Date.now() / 1000
      if (schemaVersion !== 1 || quotes.length > 0) throw new Error('Unexpected quote under unsupported policy or repeated quote')
      quotes.push(chosen)
      newOperation = { version: 1, owner: account, request: chosen, state: 'quoted', updated_at: now,
        quote: { quote_id: 'synthetic-only-quote', client_operation_id: chosen.client_operation_id, request_sha256: 'b'.repeat(64),
          retail_cny: '0.25', credits: 250, credits_per_yuan: 1000, expires_at: now + 600 } }
      await mediaReply(newOperation); return
    }
    if (url.pathname === `${prefix}/operations/${originalId}` && method === 'GET') {
      queries.push(originalId); await mediaReply(original); return
    }
    if (url.pathname === `${prefix}/tasks` && method === 'POST') submissions.push(incoming.postData() ?? '')
    if (url.pathname.startsWith(prefix)) {
      unexpected.push(`${method} ${url.pathname}`)
      await route.fulfill({ status: 404, json: { success: false, error: { code: 'synthetic_unavailable', message: 'Synthetic route unavailable' } } }); return
    }
    if (url.pathname === '/credits/api/session') { await reply({ signedIn: true, creditsPerYuan: 1000,
      accountOwner: owner, account: { id: account, phone: '' } }); return }
    if (url.pathname === '/credits/api/summary') { await reply({ balance_points: 10000 }); return }
    if (url.pathname === '/credits/api/media/catalog') { await reply({ image: [], video: [], audio: [] }); return }
    if (url.pathname === '/credits/api/creation/content') {
      const mode = { title: { en: '', zh: '' }, description: { en: '', zh: '' }, promptPlaceholder: { en: '', zh: '' }, categories: [], templates: [], presets: [] }
      await reply({ schemaVersion: 1, revision: 'synthetic-policy-only', image: mode, video: mode }); return
    }
    if (url.pathname === '/credits/api/media/preferences') { await reply({ schema_version: 1, scope: owner,
      revision: 'e'.repeat(64), image: null, video: null }); return }
    if (url.pathname === '/credits/api/creative/projects') { await reply({ accountId: account, projects: [] }); return }
    if (url.pathname === '/credits/api/announcement-banner') { await reply({ enabled: false, scope: '0'.repeat(64),
      revision: '1'.repeat(64), announcements: [] }); return }
    if (url.pathname === '/credits/api/chat-usage') { await reply({ scope: 'chat-model', status: 'unavailable',
      settledRequests: 0, totalRequests: 0, accountId: account }); return }
    if (url.pathname === '/credits/api/usage') { await reply({ rows: [], asOf: new Date().toISOString(), delayMinutes: 0 }); return }
    if (method !== 'GET') unexpected.push(`${method} ${url.pathname}`)
    await route.fulfill({ status: 404, json: { ok: false, code: 'SYNTHETIC_ROUTE_UNAVAILABLE' } })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('tab', { name: 'Videos', exact: true }).click()
  await page.getByRole('button', { name: 'Models and processing', exact: true }).click()
  const composer = page.getByRole('region', { name: 'Models and processing', exact: true })
  await composer.getByRole('combobox', { name: 'Input workflow', exact: true }).selectOption('reference')
  await composer.getByRole('textbox', { name: 'Description', exact: true }).fill('Retain my exact source and draft')
  await composer.getByLabel('Add media: images', { exact: true }).setInputFiles({ name: 'original.png', mimeType: 'image/png', buffer: png })
  await expect.poll(() => uploads.length).toBe(1)
  const conditionText = 'This media combination does not meet the selected mode requirements. Adjust the media or mode; your files are retained.'
  await composer.getByText(conditionText, { exact: true }).waitFor({ state: 'visible' })
  expect(await composer.getByRole('button', { name: 'Get exact credits', exact: true }).isDisabled()).toBe(true)
  expect(quotes).toEqual([]); expect(submissions).toEqual([])
  const screenshots: string[] = []
  for (const [theme, width] of [['light', 1440], ['dark', 780]] as const) {
    await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height: 1100 })
    await composer.getByText(conditionText, { exact: true }).scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    const path = join(evidence, `blocked-${theme}-${width}.png`)
    await page.screenshot({ path, fullPage: true, animations: 'disabled' }); screenshots.push(path)
  }
  await composer.getByRole('combobox', { name: 'mode', exact: true }).selectOption('first-frame')
  expect(await composer.getByText('original.png', { exact: true }).count()).toBe(1)
  expect(await composer.getByRole('textbox', { name: 'Description', exact: true }).inputValue()).toBe('Retain my exact source and draft')
  expect(await composer.getByRole('button', { name: 'Get exact credits', exact: true }).isDisabled()).toBe(false)
  await composer.getByRole('button', { name: 'Get exact credits', exact: true }).click()
  await expect.poll(() => quotes.length).toBe(1)
  const quotedId = quotes[0]!.client_operation_id
  expect(quotedId).not.toBe(originalId)
  expect(uploads).toEqual([{ id: uploads[0]!.id, bytes: png.length, sha256: digest(png) }])
  schemaVersion = 999
  await composer.getByRole('button', { name: 'Refresh models', exact: true }).click()
  await composer.getByText('This parameter rule requires a newer client. Quoting is blocked.', { exact: true }).waitFor({ state: 'visible' })
  expect(await composer.getByRole('button', { name: 'Get exact credits', exact: true }).isDisabled()).toBe(true)
  expect(await composer.getByText('original.png', { exact: true }).count()).toBe(1)
  expect(await composer.getByRole('textbox', { name: 'Description', exact: true }).inputValue()).toBe('Retain my exact source and draft')
  expect(await composer.getByRole('combobox', { name: 'mode', exact: true }).inputValue()).toBe('first-frame')
  await composer.locator('article').filter({ hasText: originalId }).getByRole('button', { name: 'Update original operation', exact: true }).click()
  await expect.poll(() => queries).toEqual([originalId])
  await expect.poll(() => composer.locator('article').filter({ hasText: originalId })
    .getByRole('button', { name: 'Update original operation', exact: true }).isEnabled()).toBe(true)
  expect(await composer.getByRole('button', { name: 'Refresh models', exact: true }).isEnabled()).toBe(true)
  expect(JSON.stringify(original.request)).toBe(frozenOriginal)
  expect(newOperation?.request.client_operation_id).toBe(quotedId)
  expect(quotes).toHaveLength(1); expect(submissions).toEqual([]); expect(external).toEqual([]); expect(unexpected).toEqual([])
  expect(sentinelCalls.filter(call => !call.startsWith('GET '))).toEqual([])
  expect(tripwire.pageErrors).toEqual([]); expect(tripwire.warnings).toEqual([])
  const finalPath = join(evidence, 'unsupported-rule-original-recovery.png')
  await page.screenshot({ path: finalPath, fullPage: true, animations: 'disabled' }); screenshots.push(finalPath)
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ status: 'passed',
    mode: 'real built UI, synthetic local transport only, no provider or production qualification',
    uploads, quotes, queries, quotedId, originalRequest: original.request,
    originalRequestUnchanged: JSON.stringify(original.request) === frozenOriginal,
    submissions, external, unexpected, sentinelCalls, screenshots, console: tripwire }, null, 2) + '\n')
})
