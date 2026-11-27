/** Built parameter/batch UI with a neutral synthetic carrier, local preview bytes and no provider generation. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import type { MediaV2Record, MediaV2Request } from '../../../packages/client/ui-primitives/src/media-v2-types.ts'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const prefix = '/credits/api/media-v2', account = 'synthetic-parameter-batch-owner', owner = 'c'.repeat(64)
const policyRevision = 'd'.repeat(64), prompt = 'Keep the exact original reference and camera movement'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', 'base64')
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
const parameterConditions = { schema_version: 2, rules: [
  { id: 'niji-explicit-version', when: { bot_type: ['NIJI_JOURNEY'] }, parameter: 'version',
    disallowed_values: ['8.2', '8.1', '6.1', '5.2', '5.1'], message: 'This explicit version is unavailable for the selected engine' },
  { id: 'extra-native-flags', parameter: 'extra', text_flags: { profile: 'reviewed-native-flags-v1',
    allowed_names: ['sameseed', 'fast', 'turbo', 'relax'], forbidden_names: ['repeat', 'r', 'video', 'bs', 'edit'],
    reserved_aliases: { aspect: 'aspect_ratio', ar: 'aspect_ratio', chaos: 'chaos', c: 'chaos', quality: 'quality', q: 'quality',
      stylize: 'stylize', s: 'stylize', version: 'version', v: 'version', weird: 'weird', w: 'weird', seed: 'seed',
      no: 'negative_prompt', raw: 'style', style: 'style', sref: 'sref', tile: 'tile', draft: 'draft', iw: 'iw', niji: 'bot_type',
      sw: 'sw', hd: 'hd', sd: 'hd', stop: 'stop', cref: 'cref', cw: 'cw' }, require_double_dash: true },
  message: 'Use the declared controls or supported zero-argument advanced flags' },
  { id: 'prompt-native-flags', parameter: 'prompt', text_flags: { profile: 'text-no-native-parameter-token-v1' },
    message: 'Use the declared controls and advanced-parameter field instead of native flags in the prompt' },
  { id: 'negative-prompt-content', parameter: 'negative_prompt', text_flags: { profile: 'text-no-native-parameter-token-v1' },
    message: 'Enter unwanted content without native parameter tokens' },
] }
const quantity = { schema_version: 1, parameter: 'count', minimum: 1, maximum: 3, default: 1,
  semantics: 'native_operation_main_outputs', meter: 'output_count', admission_unit: 'native_operation', admission_weight: 1,
  partial_policy: 'retain_reservation_until_complete', policy_revision: policyRevision, modes: ['first-frame'] }
const model = { id: 'synthetic-ui-parameter-batch-carrier', display_name: 'Synthetic parameter and batch carrier', kind: 'video',
  description: 'UI-only combination of independently tested parameter and batch contracts; this is not an upstream MJ video model.',
  enabled: true, model_version: 'synthetic-v2', quantity, parameter_conditions: parameterConditions,
  parameters_schema: { type: 'object', additionalProperties: false, properties: {
    prompt: { type: 'string' }, extra: { type: 'string' }, negative_prompt: { type: 'string' },
    bot_type: { type: 'string', enum: ['MID_JOURNEY', 'NIJI_JOURNEY'], default: 'MID_JOURNEY' },
    version: { type: 'string', enum: ['8.2', '8.1', '6.1', '5.2', '5.1', '6', '7'], default: '8.2' },
    mode: { type: 'string', enum: ['first-frame'], default: 'first-frame' },
    count: { type: 'integer', minimum: 1, maximum: 3, default: 1 }, duration: { type: 'integer', minimum: 5, maximum: 5, default: 5 },
    images: { type: 'array' },
  } }, asset_fields: [{ name: 'images', media_kind: 'image', native_shape: 'multiple', min_items: 0, max_items: 1,
    mime_types: ['image/png'], constraints: { max_bytes: 1048576 } }],
  intents: [{ id: 'frames', label: 'Frame generation', requires_assets: true }],
  pricing: { display: 'Synthetic aggregate quote only', credits_per_yuan: 1000, quote_required: true },
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected synthetic JSON object')
  return value as Record<string, unknown>
}
function chosen(value: unknown): MediaV2Request {
  const row = object(value), parameters = object(row.parameters), assets = object(row.assets)
  if (typeof row.client_operation_id !== 'string' || row.model !== model.id || row.model_version !== model.model_version
    || row.intent !== 'frames') throw new Error('Unexpected synthetic operation identity')
  const expected = { bot_type: 'NIJI_JOURNEY', version: '7', mode: 'first-frame', count: 3, duration: 5,
    prompt, extra: '--fast', negative_prompt: 'watermark' }
  expect(parameters).toEqual(expected)
  expect(assets).toEqual({ images: ['synthetic-original-source'] })
  return { client_operation_id: row.client_operation_id, model: row.model, model_version: row.model_version,
    intent: row.intent, parameters: expected, assets: { images: ['synthetic-original-source'] } }
}

it('keeps engine rules, aggregate batch pricing and original partial-to-complete delivery separate from retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-parameter-batch-browser-'))
  const output = process.env.DSH_PARAMETER_BATCH_BROWSER_EVIDENCE ?? join(process.cwd(), '.artifacts')
  await mkdir(output, { recursive: true })
  const evidence = await mkdtemp(join(output, 'parameter-batch-'))
  const cleanup: { scaffold?: WebScaffold; browser?: Browser; page?: Page } = {}
  const sentinelCalls: string[] = [], external: string[] = [], unexpected: string[] = []
  const quoteAttempts: unknown[] = [], submissions: unknown[] = [], queries: string[] = [], saves: string[] = []
  const uploads: { id: string; bytes: number; sha256: string }[] = [], contentReads: { key: string; method: string; status: number }[] = []
  const screenshots: string[] = [], decoder: Record<string, unknown> = {}, versions: Record<string, boolean> = {}
  let record: MediaV2Record | undefined, schemaVersion = 2, complete = false
  const saved: { key: string; path: string; bytes: number; sha256: string }[] = []
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
      await writeFile(join(evidence, 'observed.json'), JSON.stringify({ schemaVersion, complete, versions, uploads, quoteAttempts,
        submissions, queries, saves, saved, contentReads, record, decoder, external, unexpected, sentinelCalls }, null, 2) + '\n')
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
  const clipPath = join(root, 'owned-preview.mp4')
  await promisify(execFile)(process.env.DSH_PARAMETER_BATCH_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'color=c=0x4b70a0:s=96x96:r=6', '-t', '5', '-an', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clipPath], { timeout: 30000, maxBuffer: 1048576 })
  const clip = await readFile(clipPath), auxiliary = Buffer.from('Synthetic batch UI auxiliary file\n')
  const artifacts = [1, 2, 3].map((n, order) => ({ key: `main-${n}`, type: 'video' as const, mime_type: 'video/mp4', role: 'main',
    output_id: `main-${n}`, output_index: order, order, filename: `main-${n}.mp4` }))
  const outputs = [...artifacts,
    { ...artifacts[0]!, key: 'duplicate-1', role: 'duplicate', order: 3, filename: 'duplicate-1.mp4' },
    { key: 'preview-1', type: 'image' as const, mime_type: 'image/png', role: 'preview', output_id: 'main-2', output_index: 1, order: 4, filename: 'preview-1.png' },
    { key: 'notes', type: 'file' as const, mime_type: 'text/plain', role: 'auxiliary', output_id: 'main-3', output_index: 2, order: 5, filename: 'notes.txt' },
  ]
  const bytesFor = (key: string): Buffer => key === 'preview-1' ? png : key === 'notes' ? auxiliary : clip
  const task = (): NonNullable<MediaV2Record['task']> => {
    const batch = { schema_version: 1, requested_output_count: 3, expected_main_output_count: 3, output_duration_seconds: 5,
      total_output_seconds: 15, meter: 'output_count', admission_unit: 'native_operation', admission_weight: 1,
      partial_policy: 'retain_reservation_until_complete', policy_revision: policyRevision,
      received_main_output_count: complete ? 3 : 1, completeness: complete ? 'complete' : 'partial',
      ...complete ? {} : { failure_reason: 'main_outputs_missing' } }
    return { id: 'synthetic-one-native-task', model: model.id, kind: 'video', status: complete ? 'succeeded' : 'unknown',
      is_final: complete, batch, artifacts: complete ? outputs : [] }
  }
  await new Promise<void>((resolve, reject) => { sentinel.once('error', reject); sentinel.listen(0, '127.0.0.1', resolve) })
  const address = sentinel.address()
  if (address === null || typeof address === 'string') throw new Error('Expected owned sentinel listener')
  const overlay = join(root, 'parameter-batch.patch.yml')
  await writeFile(overlay, JSON.stringify([{ id: 'credits-index', config: { newApiBaseUrl: `http://127.0.0.1:${address.port}/harness`,
    baseUrl: '', bridgeBaseUrl: '', stateDir: join(root, 'credits') } }]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay }); cleanup.scaffold = scaffold
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath }); cleanup.browser = browser
  const page = await newEnglishPage(browser); cleanup.page = page; page.setDefaultTimeout(15000)
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
      await mediaReply({ capabilities: { parameter_conditions_v1: true, native_video_batch_v1: true, max_upload_bytes: 1048576 },
        models: [{ ...model, parameter_conditions: { ...parameterConditions, schema_version: schemaVersion } }],
        credits_per_yuan: 1000 }); return
    }
    if (url.pathname === `${prefix}/operations` && method === 'GET') {
      await mediaReply({ operations: record === undefined ? [] : [{ ...record, saved }] }); return
    }
    if (url.pathname === `${prefix}/assets` && method === 'POST') {
      const bytes = incoming.postDataBuffer(), id = url.searchParams.get('client_asset_id')
      if (bytes === null || id === null || url.searchParams.get('field') !== 'images' || url.searchParams.get('model') !== model.id) {
        throw new Error('Unexpected synthetic source upload')
      }
      expect(bytes).toEqual(png); uploads.push({ id, bytes: bytes.length, sha256: hash(bytes) })
      await mediaReply({ asset_id: 'synthetic-original-source', client_asset_id: id, model: model.id, state: 'ready', media_kind: 'image',
        mime_type: 'image/png', bytes: bytes.length, sha256: hash(bytes), expires_at: Date.now() / 1000 + 600, width: 1, height: 1 }); return
    }
    if (url.pathname === `${prefix}/quotes` && method === 'POST') {
      quoteAttempts.push(incoming.postDataJSON())
      if (quoteAttempts.length !== 1 || schemaVersion !== 2) throw new Error('Unexpected quote or quote under unknown policy')
      const request = chosen(incoming.postDataJSON())
      record = { version: 1, owner: account, request, state: 'quoted', updated_at: Date.now() / 1000,
        quote: { quote_id: 'synthetic-one-quote', client_operation_id: request.client_operation_id, request_sha256: 'b'.repeat(64),
          retail_cny: '1.37', credits: 1370, credits_per_yuan: 1000, expires_at: Date.now() / 1000 + 600,
          batch: { schema_version: 1, requested_output_count: 3, expected_main_output_count: 3, output_duration_seconds: 5,
            total_output_seconds: 15, meter: 'output_count', admission_unit: 'native_operation', admission_weight: 1,
            partial_policy: 'retain_reservation_until_complete', policy_revision: policyRevision } } }
      await mediaReply(record); return
    }
    if (url.pathname === `${prefix}/tasks` && method === 'POST') {
      const body = object(incoming.postDataJSON()); submissions.push(body)
      if (record === undefined || body.client_operation_id !== record.request.client_operation_id || Object.keys(body).length !== 1
        || submissions.length !== 1) throw new Error('Unexpected or repeated synthetic task submission')
      record = { ...record, state: 'accepted', task: task() }; await mediaReply(record); return
    }
    if (url.pathname.startsWith(`${prefix}/operations/`) && method === 'GET') {
      const id = url.pathname.slice(`${prefix}/operations/`.length)
      if (record === undefined || record.request.client_operation_id !== id) throw new Error('Expected exact original operation query')
      queries.push(id); record = { ...record, task: task() }; await mediaReply({ ...record, saved }); return
    }
    if (url.pathname === `${prefix}/save` && method === 'POST') {
      const id = object(incoming.postDataJSON()).client_operation_id
      if (!complete || record === undefined || id !== record.request.client_operation_id || saves.length !== 0) throw new Error('Unexpected save of incomplete or different operation')
      saves.push(id); await mkdir(join(root, 'simulated-host-saves'), { recursive: true })
      for (const artifact of outputs) {
        const path = join(root, 'simulated-host-saves', artifact.filename), bytes = bytesFor(artifact.key)
        await writeFile(path, bytes); saved.push({ key: artifact.key, path, bytes: bytes.length, sha256: hash(bytes) })
      }
      await mediaReply({ ...record, saved }); return
    }
    const content = /^\/credits\/api\/media-v2\/tasks\/synthetic-one-native-task\/artifacts\/([a-z0-9-]+)\/content$/u.exec(url.pathname)
    if (content !== null && (method === 'GET' || method === 'HEAD')) {
      const key = content[1]!, artifact = outputs.find(item => item.key === key)
      if (!complete || artifact === undefined) throw new Error('Unexpected incomplete original artifact read')
      const bytes = bytesFor(key), range = /^bytes=(\d+)-(\d*)$/u.exec(incoming.headers().range ?? '')
      const start = range === null ? 0 : Number(range[1]), end = range?.[2] === '' || range === null ? bytes.length - 1 : Math.min(Number(range[2]), bytes.length - 1)
      if (start < 0 || start > end || start >= bytes.length) throw new Error('Unexpected synthetic byte range')
      const headers = { 'content-type': artifact.mime_type, 'accept-ranges': 'bytes', 'content-length': String(end - start + 1),
        ...range === null ? {} : { 'content-range': `bytes ${start}-${end}/${bytes.length}` } }
      contentReads.push({ key, method, status: range === null ? 200 : 206 })
      await route.fulfill({ status: range === null ? 200 : 206, headers, body: method === 'HEAD' ? Buffer.alloc(0) : bytes.subarray(start, end + 1) }); return
    }
    if (url.pathname.startsWith(prefix)) {
      unexpected.push(`${method} ${url.pathname}`); await route.fulfill({ status: 404, json: { success: false } }); return
    }
    if (url.pathname === '/credits/api/session') { await reply({ signedIn: true, creditsPerYuan: 1000,
      accountOwner: owner, account: { id: account, phone: '' } }); return }
    if (url.pathname === '/credits/api/summary') { await reply({ balance_points: 10000 }); return }
    if (url.pathname === '/credits/api/media/catalog') { await reply({ image: [], video: [], audio: [] }); return }
    if (url.pathname === '/credits/api/creation/content') {
      const mode = { title: { en: '', zh: '' }, description: { en: '', zh: '' }, promptPlaceholder: { en: '', zh: '' }, categories: [], templates: [], presets: [] }
      await reply({ schemaVersion: 1, revision: 'synthetic-parameter-batch', image: mode, video: mode }); return
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
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' }); await connectFreshWorkspace(page, scaffold.workspaceCwd)
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await page.getByRole('tab', { name: 'Videos', exact: true }).click()
  await page.getByRole('button', { name: 'Models and processing', exact: true }).click()
  const composer = page.getByRole('region', { name: 'Models and processing', exact: true })
  const quoteButton = composer.getByRole('button', { name: 'Get exact credits', exact: true })
  await composer.getByRole('combobox', { name: 'Input workflow', exact: true }).selectOption('frames')
  await composer.getByRole('textbox', { name: 'Description', exact: true }).fill(prompt)
  await composer.getByLabel('Add media: images', { exact: true }).setInputFiles({ name: 'owned-source.png', mimeType: 'image/png', buffer: png })
  await expect.poll(() => uploads.length).toBe(1)
  await composer.getByRole('combobox', { name: 'bot type', exact: true }).selectOption('NIJI_JOURNEY')
  const version = composer.getByRole('combobox', { name: 'version', exact: true })
  expect(await version.inputValue()).toBe('8.2')
  for (const value of ['8.2', '8.1', '6.1', '5.2', '5.1']) {
    const option = version.locator(`option[value="${value}"]`)
    await expect.poll(async () => await option.evaluate(element => element instanceof HTMLOptionElement
      && element.disabled && element.matches(':disabled'))).toBe(true)
    versions[value] = await option.evaluate(element => element instanceof HTMLOptionElement
      && element.disabled && element.matches(':disabled'))
  }
  for (const value of ['6', '7']) {
    expect(await version.locator(`option[value="${value}"]`).evaluate(element => element instanceof HTMLOptionElement
      && !element.disabled && !element.matches(':disabled'))).toBe(true)
  }
  await expect.poll(async () => await quoteButton.isDisabled()).toBe(true)
  expect(quoteAttempts).toEqual([]); expect(submissions).toEqual([])
  expect(await composer.getByText('owned-source.png', { exact: true }).count()).toBe(1)
  await version.selectOption('6'); expect(await version.inputValue()).toBe('6')
  await expect.poll(async () => await quoteButton.isEnabled()).toBe(true)
  await version.selectOption('7')
  await composer.getByRole('textbox', { name: 'extra', exact: true }).fill('--repeat 2')
  await expect.poll(async () => await quoteButton.isDisabled()).toBe(true); expect(quoteAttempts).toEqual([])
  expect(await composer.getByRole('textbox', { name: 'extra', exact: true }).inputValue()).toBe('--repeat 2')
  await composer.getByRole('textbox', { name: 'extra', exact: true }).fill('--fast')
  await composer.getByRole('textbox', { name: 'Description', exact: true }).fill(`${prompt}\u0085--video`)
  await expect.poll(async () => await quoteButton.isDisabled()).toBe(true); expect(quoteAttempts).toEqual([])
  expect(await composer.getByRole('textbox', { name: 'Description', exact: true }).inputValue()).toBe(`${prompt}\u0085--video`)
  await composer.getByRole('textbox', { name: 'Description', exact: true }).fill(prompt)
  await composer.getByRole('textbox', { name: 'negative prompt', exact: true }).fill('watermark,--video')
  await expect.poll(async () => await quoteButton.isDisabled()).toBe(true); expect(quoteAttempts).toEqual([])
  await composer.getByRole('textbox', { name: 'negative prompt', exact: true }).fill('watermark')
  await composer.getByRole('spinbutton', { name: 'count', exact: true }).fill('3')
  await expect.poll(async () => await quoteButton.isEnabled()).toBe(true)
  const blockedPath = join(evidence, 'valid-parameters-before-free-quote.png')
  await page.screenshot({ path: blockedPath, fullPage: true, animations: 'disabled' }); screenshots.push(blockedPath)
  await quoteButton.click(); await expect.poll(() => quoteAttempts.length).toBe(1)
  await composer.getByText('This request: 1,370 credits', { exact: true }).waitFor({ state: 'visible' })
  expect(await composer.getByText('¥1.37', { exact: true }).count()).toBe(1)
  expect(await composer.getByText('¥4.11', { exact: true }).count()).toBe(0)
  await composer.getByRole('button', { name: 'Confirm generation', exact: true }).click()
  await expect.poll(() => submissions.length).toBe(1)
  if (record === undefined) throw new Error('Expected synthetic original record')
  const originalId = record.request.client_operation_id, frozenRequest = JSON.stringify(record.request)
  const originalCard = composer.locator('article').filter({ hasText: originalId })
  await originalCard.getByRole('status').filter({ hasText: 'Main videos received: 1 / 3' }).waitFor({ state: 'visible' })
  expect(await originalCard.getByText('Completed', { exact: true }).count()).toBe(0)
  expect(await originalCard.getByRole('button', { name: 'Save every artifact', exact: true }).count()).toBe(0)
  expect(await originalCard.locator('video').count()).toBe(0); expect(saves).toEqual([])
  complete = true
  await originalCard.getByRole('button', { name: 'Update original operation', exact: true }).click()
  await expect.poll(() => queries).toEqual([originalId])
  await originalCard.getByRole('status').filter({ hasText: 'Main videos received: 3 / 3' }).waitFor({ state: 'visible' })
  expect(await originalCard.getByText('Completed', { exact: true }).count()).toBe(1)
  expect(await originalCard.getByRole('link', { name: 'Download original', exact: true }).count()).toBe(outputs.length)
  const captions = [
    ['main-1.mp4', 'Output 1 · Main video'], ['main-2.mp4', 'Output 2 · Main video'], ['main-3.mp4', 'Output 3 · Main video'],
    ['duplicate-1.mp4', 'Output 1 · Duplicate'], ['preview-1.png', 'Output 2 · Preview'], ['notes.txt', 'Output 3 · Auxiliary'],
  ] as const
  for (const [filename, caption] of captions) {
    const figure = originalCard.locator('figure').filter({ has: page.locator('figcaption').getByText(filename, { exact: true }) })
    expect(await figure.count()).toBe(1)
    expect(await figure.locator('figcaption').getByText(caption, { exact: true }).count()).toBe(1)
  }
  expect(await originalCard.locator('video').count()).toBe(4)
  const video = originalCard.locator('video').first()
  await expect.poll(async () => await video.evaluate(element => element instanceof HTMLVideoElement ? element.readyState : 0))
    .toBeGreaterThanOrEqual(1)
  decoder.duration_seconds = await video.evaluate(element => element instanceof HTMLVideoElement ? element.duration : 0)
  expect(decoder.duration_seconds).toBeCloseTo(5, 1)
  const preview = originalCard.getByRole('img', { name: 'preview-1.png', exact: true })
  await expect.poll(async () => await preview.evaluate(element => element instanceof HTMLImageElement ? element.naturalWidth : 0)).toBe(1)
  decoder.preview_width = 1
  for (const artifact of outputs) {
    const path = `${prefix}/tasks/synthetic-one-native-task/artifacts/${artifact.key}/content`
    const received = await page.evaluate(async url => Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())), path)
    expect(hash(Buffer.from(received))).toBe(hash(bytesFor(artifact.key)))
  }
  await originalCard.getByRole('button', { name: 'Save every artifact', exact: true }).click()
  await expect.poll(() => saved.length).toBe(outputs.length)
  expect(saves).toEqual([originalId])
  for (const entry of saved) {
    expect(await originalCard.getByText(entry.path, { exact: true }).count()).toBe(1)
    expect(hash(await readFile(entry.path))).toBe(entry.sha256)
  }
  const completePath = join(evidence, 'complete-original-all-artifacts.png')
  await page.screenshot({ path: completePath, fullPage: true, animations: 'disabled' }); screenshots.push(completePath)
  await originalCard.getByRole('button', { name: 'Edit a new draft', exact: true }).click()
  schemaVersion = 999
  await composer.getByRole('button', { name: 'Refresh models', exact: true }).click()
  await composer.getByText('This parameter rule requires a newer client. Quoting is blocked.', { exact: true }).waitFor({ state: 'visible' })
  await expect.poll(async () => await quoteButton.isDisabled()).toBe(true)
  expect(await composer.getByText('owned-source.png', { exact: true }).count()).toBe(1)
  await originalCard.getByRole('button', { name: 'Update original operation', exact: true }).click()
  await expect.poll(() => queries).toEqual([originalId, originalId])
  expect(JSON.stringify(record.request)).toBe(frozenRequest)
  expect(submissions).toEqual([{ client_operation_id: originalId }]); expect(quoteAttempts).toHaveLength(1); expect(uploads).toHaveLength(1)
  expect(saves).toEqual([originalId]); expect(saved).toHaveLength(outputs.length)
  expect(external).toEqual([]); expect(unexpected).toEqual([]); expect(sentinelCalls.filter(call => !call.startsWith('GET '))).toEqual([])
  expect(tripwire.pageErrors).toEqual([]); expect(tripwire.warnings).toEqual([])
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ status: 'passed',
    evidence_scope: 'Built UI and owned five-second FFmpeg preview/PNG; supplier/quote/save responses are synthetic browser intercepts.',
    limits: 'No actual supplier qualification, API ledger or Host send-fence proof; those belong to separate actual-Go/Host tests. Simulated save writes are test-driver receipts.',
    decoder, versions, captions, originalId, frozenRequest, uploads, quoteAttempts, submissions, queries, saves, saved,
    files: outputs.map(artifact => ({ key: artifact.key, sha256: hash(bytesFor(artifact.key)), bytes: bytesFor(artifact.key).length })),
    contentReads, external, unexpected, sentinelCalls, screenshots, console: tripwire }, null, 2) + '\n')
})
