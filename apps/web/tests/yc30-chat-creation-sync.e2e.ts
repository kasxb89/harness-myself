/** One keyless built Chat -> real list_video_models -> AI catalog check, with no media quotation or submission. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import type { MediaPreferencesCatalog } from '../../../packages/host/credits-index/src/media-preferences-types.ts'
import { launchWebScaffold, readPersistedEvents, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const chatModel = 'synthetic-yc30-chat', sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const nativeRow = z.object({ id: z.string(), display_name: z.string(), pricing: z.object({ specification_rows: z.array(z.object({
  billing_unit: z.enum(['per_video', 'per_second']), parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  unit_price_cny: z.string(), total_cny: z.string(),
})) }) })

it('shares the actual Go eleven-model catalog across saved chat30 defaults, the real tool and native creation units', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-yc30-chat-sync-'))
  const output = process.env.DSH_YC30_CHAT_BROWSER_EVIDENCE ?? join(process.cwd(), '.artifacts')
  await mkdir(output, { recursive: true })
  const evidence = await mkdtemp(join(output, 'chat-creation-sync-'))
  const cleanup: { scaffold?: WebScaffold; browser?: Browser; page?: Page; upstream?: () => Promise<void> } = {}
  const requests: { method: string; path: string; authenticated: boolean }[] = [], forbidden: string[] = [], external: string[] = []
  let chatCalls = 0
  onTestFinished(async ({ task }) => {
    try {
      if (task.result?.state === 'fail' && cleanup.page !== undefined && !cleanup.page.isClosed()) {
        await cleanup.page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true })
        await writeFile(join(evidence, 'failure-aria.txt'), await cleanup.page.locator('body').ariaSnapshot())
      }
      await writeFile(join(evidence, 'observed.json'), JSON.stringify({ requests, forbidden, external, chatCalls }, null, 2) + '\n')
    } finally {
      try { await cleanup.browser?.close() } finally {
        try { await cleanup.scaffold?.close() } finally {
          try { await cleanup.upstream?.() } finally { await rm(root, { recursive: true, force: true }) }
        }
      }
    }
  })
  const raw = await readFile(new URL('../../../packages/client/ui-primitives/tests/fixtures/yc30-r02-20261128/ACTUAL-GO-HTTP-CATALOG-BASELINE-R04.json', import.meta.url))
  expect(sha(raw)).toBe('6ab94b1ca32d94561aec4d45b523b23b742d59748d6fdd4d35487eee9a6a5986')
  const directory = z.object({ data: z.object({ models: z.array(nativeRow) }) }).parse(JSON.parse(raw.toString('utf8')))
  expect(directory.data.models).toHaveLength(11)
  const perVideo = directory.data.models.find(model => model.pricing.specification_rows[0]?.billing_unit === 'per_video')!
  const perSecond = directory.data.models.find(model => model.pricing.specification_rows[0]?.billing_unit === 'per_second')!
  expect(perVideo).toBeDefined(); expect(perSecond).toBeDefined()
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      const method = request.method ?? 'GET', chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      requests.push({ method, path, authenticated: request.headers.authorization !== undefined })
      response.setHeader('content-type', 'application/json')
      const answer = (data: unknown): void => { response.end(JSON.stringify({ success: true, data })) }
      if (method !== 'GET' && path !== '/harness/v1/chat/completions' && !path.endsWith('/client-activity/heartbeat')) forbidden.push(`${method} ${path}`)
      if (path === '/harness/v1/media-v2/models') { response.end(raw); return }
      if (path === '/harness/api/pricing') { answer([{ model_name: chatModel, supported_endpoint_types: ['openai'] }]); return }
      if (path === '/harness/v1/models') { response.end(JSON.stringify({ data: [{ id: chatModel, kind: 'text' }] })); return }
      if (path === '/harness/api/status') {
        answer({ quota_per_unit: 500000, usd_exchange_rate: 6.7138,
          client_model_config: { schema_version: 1, default_chat_model: chatModel, model_order: [] },
          client_media_defaults: { schema_version: 1, default_image_model: '', default_video_model: perVideo.id } }); return
      }
      if (path === '/harness/api/user/self') { answer({ id: 7, group: 'default', quota: 500000 }); return }
      if (path.endsWith('/client-activity/heartbeat')) { answer({ server_time: Math.floor(Date.now() / 1000), heartbeat_interval_seconds: 60 }); return }
      if (path === '/harness/api/log/self') { answer({ total: 0, items: [] }); return }
      if (path === '/harness/v1/chat/completions') {
        chatCalls += 1
        if (chatCalls > 2 || chunks.length === 0) throw new Error('Unexpected additional synthetic assistant request')
        const first = chatCalls === 1
        const delta = first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'synthetic-list-video-models', type: 'function',
          function: { name: 'list_video_models', arguments: '{}' } }] } : { role: 'assistant', content: 'YC30_CHAT_DIRECTORY_READY' }
        response.setHeader('content-type', 'text/event-stream')
        response.end([`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 10 } })}`, 'data: [DONE]', ''].join('\n\n')); return
      }
      response.statusCode = 404; answer({})
    })().catch((error: unknown) => { forbidden.push(String(error)); response.destroy() })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.upstream = () => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) }); server.closeAllConnections()
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected owned loopback supplier')
  const state = join(root, 'credits'); await mkdir(state)
  await writeFile(join(state, 'session.json'), JSON.stringify({ token: 'synthetic-yc30-product', expiresAt: '9999-01-01T00:00:00Z',
    account: { id: '7', phone: '13800000000' }, upstream: { token: 'synthetic-yc30-access', expiresAt: '9999-01-01T00:00:00Z' },
    relay: { key: 'sk-synthetic-yc30-relay', id: 7 } }), { mode: 0o600 })
  const base = `http://127.0.0.1:${address.port}/harness`, overlay = join(root, 'chat-sync.patch.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'credits-index', config: { newApiBaseUrl: base, baseUrl: '', bridgeBaseUrl: '', stateDir: state, creditsPerYuan: 1250 } },
    { id: 'llm-pi-ai', config: { providers: { 'yunshu-local': { displayName: 'Synthetic chat', api: 'openai-completions',
      baseURL: `${base}/v1`, apiKeyEnv: 'YUNSHU_RELAY_TOKEN', models: [{ id: chatModel }] } } } },
    { id: 'agent-default-model', config: { provider: 'yunshu-local', model: chatModel, followPolicy: true } },
    ...['dsh-market', 'dsh-skin-market'].map(id => ({ id, disabled: true })),
  ]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay, toolsMode: 'native' }); cleanup.scaffold = scaffold
  const catalog = await (await scaffold.hostFetch('/credits/api/media/preferences/catalog')).json() as { ok: boolean; payload: MediaPreferencesCatalog }
  expect(catalog.ok).toBe(true); expect(catalog.payload.catalog.video).toHaveLength(11)
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
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' }); await connectFreshWorkspace(page, scaffold.workspaceCwd)
  await page.getByRole('button', { name: 'Image/video defaults', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Creation preferences', exact: true })
  await editor.getByRole('tab', { name: 'Video', exact: true }).click()
  const preferenceWitnesses: unknown[] = []
  for (const [native, unit] of [[perVideo, 'points/video'], [perSecond, 'points/second']] as const) {
    const projected = catalog.payload.catalog.video.find(model => model.id === native.id)!
    const button = editor.getByRole('button', { name: `${projected.displayName} ${projected.id}`, exact: true })
    await button.click(); expect(await button.innerText()).toContain(unit)
    const priceRow = native.pricing.specification_rows[0]
    if (priceRow === undefined) throw new Error('Missing retained actual Go price row')
    const values = priceRow.parameters
    for (const [field, label] of [['duration', 'Default video duration'], ['resolution', 'Resolution'], ['aspect_ratio', 'Aspect ratio'],
      ['quality', 'Quality'], ['mode', 'Generation mode']] as const) {
      const select = editor.getByRole('combobox', { name: label, exact: true })
      if (values[field] !== undefined && await select.count() > 0 && await select.isEnabled()) {
        await select.selectOption(JSON.stringify(field === 'duration' ? 30 : values[field]))
      }
    }
    const seconds = editor.getByRole('combobox', { name: 'Default video duration', exact: true })
    if (await seconds.isEnabled()) expect(await seconds.inputValue()).toBe('30')
    else expect(await seconds.locator('option:checked').innerText()).toBe('Fixed: 30')
    preferenceWitnesses.push({ model: native.id, unit, display: await button.innerText() })
  }
  const save = page.waitForResponse(response => new URL(response.url()).pathname === '/credits/api/media/preferences'
    && response.request().method() === 'PUT')
  await editor.getByRole('button', { name: 'Save', exact: true }).click(); expect((await save).ok()).toBe(true)
  await editor.waitFor({ state: 'detached' })
  const saved = await (await scaffold.hostFetch('/credits/api/media/preferences')).json() as { payload: MediaPreferencesCatalog }
  expect(saved.payload.video).toMatchObject({ model: perSecond.id, parameters: { seconds: 30 } })
  const settled = scaffold.whenTurnSettled(30000)
  const input = page.locator('[data-composer-input][contenteditable="true"]').last()
  await input.fill('List the video models with my saved30-second preference; do not quote or generate anything.'); await input.press('Enter')
  const sessionId = await settled, events = await readPersistedEvents(scaffold, sessionId)
  await writeFile(join(evidence, 'events.private.json'), JSON.stringify(events, null, 2) + '\n', { mode: 0o600 })
  const calls = events.filter(row => row.type === 'tool/call')
  expect(calls.map(row => row.data.name)).toEqual(['list_video_models'])
  const toolEvent = events.find(row => row.type === 'tool/result')
  if (toolEvent?.type !== 'tool/result') throw new Error('Missing real list_video_models tool receipt')
  expect(toolEvent.data.message.isError).not.toBe(true)
  await writeFile(join(evidence, 'list-video-models.private.txt'),
    toolEvent.data.message.content.filter(block => block.type === 'text').map(block => block.text).join(''), { mode: 0o600 })
  const listed = z.object({ default_model_id: z.string(),
    selected_parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    models: z.array(z.object({ id: z.string(), execution: z.string(), durations: z.array(z.number()),
      read_details: z.object({ tool: z.literal('list_media_models_v2'), model: z.string() }) })) }).loose()
    .parse(JSON.parse(toolEvent.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')))
  expect(listed.default_model_id).toBe(perSecond.id); expect(listed.selected_parameters.seconds).toBe(30)
  expect(listed.selected_parameters).toEqual(saved.payload.video?.parameters)
  expect(listed).not.toHaveProperty('default_error_code')
  expect(listed.models).toHaveLength(11)
  expect(listed.models.every(row => row.execution === 'media-v2' && row.durations.includes(30))).toBe(true)
  expect(listed.models.every(row => row.read_details.model === row.id)).toBe(true)
  expect(events.find(row => row.type === 'media/request-selection')?.data).toMatchObject({ state: 'selected', video: saved.payload.video })
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('tab', { name: 'Videos', exact: true }).click()
  await page.getByRole('button', { name: 'Models and processing', exact: true }).click()
  const composer = page.getByRole('region', { name: 'Models and processing', exact: true }), creationWitnesses: unknown[] = []
  const screenshots: string[] = []
  for (const native of [perVideo, perSecond]) {
    await composer.getByRole('combobox', { name: 'Model', exact: true }).selectOption(native.id)
    await composer.getByRole('combobox', { name: 'Input workflow', exact: true }).selectOption('text')
    const priceRow = native.pricing.specification_rows[0]
    if (priceRow === undefined) throw new Error('Missing retained actual Go price row')
    const values = priceRow.parameters
    for (const [field, label] of [['mode', 'Mode'], ['quality', 'Version tier'], ['resolution', 'Resolution'],
      ['aspect_ratio', 'Aspect ratio'], ['duration', 'Duration']] as const) {
      const control = composer.getByRole('combobox', { name: label, exact: true })
      if (values[field] !== undefined && await control.count() > 0) await control.selectOption(String(values[field]))
    }
    await composer.getByRole('textbox', { name: 'Description', exact: true }).fill('Synthetic thirty-second clouds; inspection only.')
    expect(await composer.getByRole('combobox', { name: 'Duration', exact: true }).inputValue()).toBe('30')
    expect(await composer.getByRole('combobox', { name: 'Model', exact: true }).inputValue()).toBe(native.id)
    const unit = priceRow.billing_unit === 'per_video' ? 'video' : 'second'
    expect(await composer.innerText()).toContain(`Reference unit price: ¥${priceRow.unit_price_cny}/${unit}`)
    expect(await composer.innerText()).toContain(`Reference total: ¥${priceRow.total_cny}`)
    expect(await composer.getByRole('button', { name: 'Get exact credits', exact: true }).isEnabled()).toBe(true)
    await composer.getByText(`Reference unit price: ¥${priceRow.unit_price_cny}/${unit} · Reference total: ¥${priceRow.total_cny}`, { exact: true }).scrollIntoViewIfNeeded()
    const priceScreenshot = join(evidence, `native-price-per-${unit}.png`)
    await page.screenshot({ path: priceScreenshot, fullPage: true, animations: 'disabled' }); screenshots.push(priceScreenshot)
    creationWitnesses.push({ model: native.id, selectedNativeParameters: values, text: await composer.innerText() })
  }
  const before = requests.length
  await composer.getByRole('combobox', { name: 'Resolution', exact: true }).selectOption('1080p')
  const thirty = composer.getByRole('combobox', { name: 'Duration', exact: true })
  expect(await thirty.inputValue()).toBe('30')
  // Seedance promo1080p is valid; an explicitly unsupported native count is kept and blocks before quotation.
  const count = composer.getByRole('spinbutton', { name: 'Count', exact: true })
  await count.fill('2')
  expect(await count.inputValue()).toBe('2'); expect(await thirty.inputValue()).toBe('30')
  expect(await composer.getByRole('button', { name: 'Get exact credits', exact: true }).isDisabled()).toBe(true)
  expect(requests.slice(before).filter(row => row.method !== 'GET')).toEqual([])
  expect(forbidden).toEqual([]); expect(external).toEqual([]); expect(chatCalls).toBe(2)
  expect(requests.filter(row => row.path === '/harness/v1/media-v2/models').every(row => row.authenticated)).toBe(true)
  expect(tripwire.pageErrors).toEqual([])
  const screenshot = join(evidence, 'chat30-native-shared-units-blocked.png')
  await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' })
  await writeFile(join(evidence, 'events.private.json'), JSON.stringify(events, null, 2) + '\n', { mode: 0o600 })
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ status: 'passed', actualBuiltHostAndClient: true,
    sourceFixtureSHA: sha(raw), catalogModels: 11, preferenceWitnesses, saved: saved.payload, tool: listed, creationWitnesses,
    requests, forbidden, external, chatCalls, mediaQuotes: 0, mediaSubmissions: 0, screenshot, screenshots, console: tripwire,
    limits: 'Retained actualGo synthetic directory plus loopback assistant/account; no supplier or paid qualification.' }, null, 2) + '\n')
}, 120000)
