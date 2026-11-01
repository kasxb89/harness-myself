/** Saved composer choices traverse the built Host and current authorized media directory. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import pricing from '../../../packages/host/credits-index/tests/fixtures/official-price-comparison-api.json' with { type: 'json' }
import models from '../../../packages/host/credits-index/tests/fixtures/official-price-comparison-models-api.json' with { type: 'json' }
import referencePoints from './fixtures/chat-media-preferences-price-1250.json' with { type: 'json' }
import type { MediaPreferencesCatalog } from '../../../packages/host/credits-index/src/media-preferences-types.ts'
import { launchWebScaffold, readPersistedEvents, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh } from './support.ts'

it('saves personal image and video defaults, restores them after reload and marks a downlisted model unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-chat-media-preferences-browser-'))
  const cleanup: { scaffold?: () => Promise<void>; browser?: () => Promise<void>; upstream?: () => Promise<void> } = {}
  onTestFinished(async () => {
    try { await cleanup.browser?.() } finally {
      try { await cleanup.scaffold?.() } finally {
        try { await cleanup.upstream?.() } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  })
  const requests: { method: string; path: string; authenticated: boolean }[] = [], forbidden: string[] = []
  let hidden = '', chatCalls = 0
  const imageCalls: Record<string, unknown>[] = []
  const firstImage = models.data.find(model => model.kind === 'image')?.id
  const firstVideo = models.data.find(model => model.kind === 'video')?.id
  const chatModel = models.data.find(model => model.kind === 'text')?.id
  if (firstImage === undefined || firstVideo === undefined || chatModel === undefined) throw new Error('Actual API fixture requires text and both media kinds')
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      const chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      requests.push({ path, method: request.method ?? 'GET', authenticated: request.headers.authorization !== undefined })
      response.setHeader('content-type', 'application/json')
      const answer = (data: unknown): void => { response.end(JSON.stringify({ success: true, data })) }
      if (request.method !== 'GET' && !path.endsWith('/client-activity/heartbeat')
        && path !== '/harness/v1/chat/completions' && path !== '/harness/v1/images/generations') forbidden.push(path)
      if (path === '/harness/api/pricing') { response.end(JSON.stringify(pricing)); return }
      if (path === '/harness/v1/models') {
        if (request.headers.authorization !== 'Bearer sk-synthetic-media-preferences-relay') { response.statusCode = 403; response.end('{}'); return }
        response.end(JSON.stringify({ ...models, data: models.data.filter(model => model.id !== hidden) })); return
      }
      if (path === '/harness/api/status') {
        answer({ quota_per_unit: 500_000, usd_exchange_rate: 6.7138,
          client_model_config: { schema_version: 1, default_chat_model: chatModel, model_order: [] },
          client_media_defaults: { schema_version: 1, default_image_model: firstImage, default_video_model: firstVideo } }); return
      }
      if (path === '/harness/v1/chat/completions') {
        chatCalls++
        const delta = chatCalls === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'synthetic-media-preference-image', type: 'function',
          function: { name: 'generate_image', arguments: JSON.stringify({ prompt: 'A blue circle on a white background' }) } }] }
          : { role: 'assistant', content: 'MEDIA_PREFERENCES_CHAIN_READY' }
        response.setHeader('content-type', 'text/event-stream')
        response.end([`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: chatCalls === 1 ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 10 } })}`, 'data: [DONE]', ''].join('\n\n')); return
      }
      if (path === '/harness/v1/images/generations') {
        imageCalls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
        response.end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: [{ b64_json:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }] })); return
      }
      if (path === '/harness/api/user/self') { answer({ id: 7, username: 'media-preferences-browser', group: 'default', quota: 500_000 }); return }
      if (path === '/harness/api/client-activity/heartbeat') { answer({ server_time: Math.floor(Date.now() / 1000), heartbeat_interval_seconds: 60 }); return }
      if (path === '/harness/api/log/self') { answer({ total: 0, items: [] }); return }
      if (/chat\/completions|images\/generations|videos|recharge|payment/u.test(path)) forbidden.push(path)
      response.statusCode = 404; response.end(JSON.stringify({ success: false }))
    })().catch((error: unknown) => { forbidden.push(String(error)); response.destroy() })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.upstream = () => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) }); server.closeAllConnections()
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected loopback media catalog')
  const state = join(root, 'credits'); await mkdir(state)
  await writeFile(join(state, 'session.json'), JSON.stringify({ token: 'synthetic-media-preferences-product-session',
    expiresAt: '9999-01-01T00:00:00.000Z', account: { id: '7', phone: '13800000000' },
    upstream: { token: 'synthetic-media-preferences-access', refresh: 'synthetic-media-preferences-refresh', expiresAt: '9999-01-01T00:00:00.000Z' },
    relay: { key: 'sk-synthetic-media-preferences-relay', id: 7 },
  }), { mode: 0o600 })
  const overlay = join(root, 'media-preferences.patch.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'credits-index', config: { newApiBaseUrl: `http://127.0.0.1:${String(address.port)}/harness`, baseUrl: '', bridgeBaseUrl: '', stateDir: state, creditsPerYuan: 1250 } },
    { id: 'llm-pi-ai', config: { providers: { 'yunshu-local': { displayName: '云枢', api: 'openai-completions',
      baseURL: `http://127.0.0.1:${String(address.port)}/harness/v1`, apiKeyEnv: 'YUNSHU_RELAY_TOKEN', models: [{ id: chatModel }] } } } },
    { id: 'agent-default-model', config: { provider: 'yunshu-local', model: chatModel, followPolicy: true } },
    ...['dsh-market', 'dsh-skin-market'].map(id => ({ id, disabled: true })),
  ]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay, toolsMode: 'native' })
  cleanup.scaffold = () => scaffold.close()
  const initial = await (await scaffold.hostFetch('/credits/api/media/preferences/catalog')).json() as { ok: boolean; payload: MediaPreferencesCatalog }
  expect(initial.ok).toBe(true)
  expect(initial.payload.catalog.image.length).toBeGreaterThan(0); expect(initial.payload.catalog.video.length).toBeGreaterThan(0)
  const chosen = {
    image: initial.payload.catalog.image.find(model => model.id !== firstImage && model.pricing?.status === 'available' && model.pricing.coverage === 'complete')!,
    video: initial.payload.catalog.video.find(model => model.id !== firstVideo && model.pricing?.status === 'available' && model.pricing.coverage === 'complete')!,
  }
  expect(chosen.image).toBeDefined(); expect(chosen.video).toBeDefined()
  expect(chosen.image.id).not.toBe(firstImage)
  const expectedPoints: Readonly<Record<string, readonly { points: string; display: string }[]>> = referencePoints.models
  const priceWitnesses: unknown[] = []
  const browser = await chromium.launch(); cleanup.browser = () => browser.close()
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 }, colorScheme: 'light' })
  const tripwire = watchConsole(page)
  const evidenceBase = fileURLToPath(new URL('../../../.artifacts/', import.meta.url)); await mkdir(evidenceBase, { recursive: true })
  const evidence = await mkdtemp(join(evidenceBase, 'chat-media-preferences-'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  const settings = page.getByRole('button', { name: '图片/视频默认偏好', exact: true })
  expect(await settings.count()).toBe(1)
  expect(await page.getByRole('button', { name: '图片生成偏好', exact: true }).count()).toBe(0)
  expect(await page.getByRole('button', { name: '视频生成偏好', exact: true }).count()).toBe(0)
  await settings.click()
  const editor = page.getByRole('dialog', { name: '创作偏好', exact: true })
  const draftPrices: { image?: string; video?: string } = {}
  for (const [kind, tab] of [['image', '图片'], ['video', '视频']] as const) {
    const candidate = chosen[kind]
    const unit = kind === 'image' ? '积分/张' : '积分/秒'
    expect(candidate.pricing?.credits_per_yuan).toBe('1250')
    for (const row of candidate.pricing?.rows ?? []) {
      expect(expectedPoints[candidate.id]?.some(point => point.points === row.points)).toBe(true)
    }
    await editor.getByRole('tab', { name: tab, exact: true }).click()
    await editor.getByRole('textbox', { name: '搜索型号', exact: true }).fill(candidate.id)
    const model = editor.getByRole('button', { name: `${candidate.displayName} ${candidate.id}`, exact: true })
    await model.click()
    expect(await model.innerText()).toContain(unit)
    const spec = candidate.params.specifications?.[0]
    for (const [field, label] of [['size', '尺寸'], ['resolution', '分辨率'], ['ratio', '画幅'],
      ['seconds', '单段时长'], ['quality', '质量'], ['mode', '模式']] as const) {
      if (spec?.[field] === undefined) continue
      const select = editor.getByRole('combobox', { name: label, exact: true })
      if (await select.count() > 0 && await select.isEnabled()) await select.selectOption(JSON.stringify(spec[field]))
    }
    await expect.poll(() => editor.getByRole('button', { name: '保存', exact: true }).isEnabled(), { timeout: 10_000 }).toBe(true)
    const draftPrice = await editor.getByRole('status').filter({ hasText: unit }).innerText()
    expect(draftPrice).not.toContain('待核价')
    draftPrices[kind] = draftPrice
    await page.screenshot({ path: join(evidence, `${kind}-light.png`), animations: 'disabled' })
  }
  await editor.getByRole('tab', { name: '图片', exact: true }).click()
  expect(await editor.getByRole('button', { name: `${chosen.image.displayName} ${chosen.image.id}`, exact: true })
    .getAttribute('aria-pressed')).toBe('true')
  const beforeSave = await (await scaffold.hostFetch('/credits/api/media/preferences')).json() as { payload: MediaPreferencesCatalog }
  expect(beforeSave.payload.image).toBe(null); expect(beforeSave.payload.video).toBe(null)
  const save = page.waitForResponse(response => new URL(response.url()).pathname === '/credits/api/media/preferences'
    && response.request().method() === 'PUT')
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  expect((await save).ok()).toBe(true)
  await editor.waitFor({ state: 'detached' })
  const saved = await (await scaffold.hostFetch('/credits/api/media/preferences')).json() as { payload: MediaPreferencesCatalog }
  expect(saved.payload.image?.model).toBe(chosen.image.id)
  expect(saved.payload.video?.model).toBe(chosen.video.id)
  for (const kind of ['image', 'video'] as const) {
    const candidate = chosen[kind], fields = saved.payload[kind]!.parameters
    const matches = candidate.pricing!.rows.filter(row => Object.entries(fields).every(([field, value]) =>
      row.parameters[field] === undefined || row.parameters[field] === value))
    const displays = new Set(matches.flatMap(row =>
      expectedPoints[candidate.id]?.filter(point => point.points === row.points).map(point => point.display) ?? []))
    const draftPrice = draftPrices[kind]!
    const displayedNumbers = draftPrice.match(/[0-9][0-9,]*(?:\.[0-9]+)?/gu) ?? []
    expect(displayedNumbers.length).toBeGreaterThan(0)
    for (const amount of displayedNumbers) expect(displays.has(amount)).toBe(true)
    priceWitnesses.push({ kind, model: candidate.id, parameters: fields, draftPrice, displayedNumbers })
  }
  const textModel = page.getByRole('button', { name: /^(?:请选择模型|选择模型)/u })
  expect(await textModel.evaluate(element => element.closest('[data-model-compact]') === null)).toBe(true)
  expect((await settings.boundingBox())!.width).toBeLessThanOrEqual(90)
  const settled = scaffold.whenTurnSettled(30_000)
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.fill('生成一张蓝色圆形的图片，使用我保存的默认参数')
  await composer.press('Enter')
  const sessionId = await settled
  await expect.poll(() => imageCalls.length, { timeout: 15_000 }).toBe(1)
  expect(imageCalls[0]?.model).toBe(saved.payload.image!.model)
  const recorded = await readPersistedEvents(scaffold, sessionId)
  const selection = recorded.find(row => row.type === 'media/request-selection')?.data
  const human = recorded.find(row => row.type === 'user/message')?.data
  const sourceRpcId = human?.source.kind === 'user' && 'rpcId' in human.source ? human.source.rpcId : undefined
  expect(sourceRpcId).toBeTypeOf('string')
  expect(selection?.requestId).toBe(sourceRpcId)
  if (selection?.state !== 'selected') throw new Error('Submitted media choices were not persisted')
  expect(selection.image).toEqual(saved.payload.image)
  expect(selection.video).toEqual(saved.payload.video)
  await page.reload({ waitUntil: 'load' })
  await settings.waitFor()
  await settings.click()
  const restored = page.getByRole('dialog', { name: '创作偏好', exact: true })
  await restored.getByRole('tab', { name: '视频', exact: true }).click()
  await expect.poll(() => restored.getByRole('button', { name: `${chosen.video.displayName} ${chosen.video.id}`, exact: true })
    .getAttribute('aria-pressed'), { timeout: 10_000 }).toBe('true')
  await restored.getByRole('button', { name: '取消', exact: true }).click()
  await restored.waitFor({ state: 'detached' })
  const collapsePreview = page.getByRole('button', { name: '收起右侧边栏', exact: true })
  if (await collapsePreview.count() > 0) await collapsePreview.click()
  await page.screenshot({ path: join(evidence, 'composer-saved.png'), animations: 'disabled' })
  const geometry: unknown[] = []
  for (const [theme, width] of [['dark', 1440], ['light', 580]] as const) {
    await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height: 900 })
    await settings.click()
    const dialog = page.getByRole('dialog', { name: '创作偏好', exact: true }); await dialog.waitFor()
    await dialog.getByRole('tab', { name: '视频', exact: true }).click()
    await expect.poll(() => dialog.evaluate(element => getComputedStyle(element).visibility), { timeout: 10_000 }).toBe('visible')
    const rect = await dialog.boundingBox()
    expect(rect).not.toBe(null)
    expect(rect!.x).toBeGreaterThanOrEqual(0); expect(rect!.x + rect!.width).toBeLessThanOrEqual(width)
    expect(rect!.y).toBeGreaterThanOrEqual(0); expect(rect!.y + rect!.height).toBeLessThanOrEqual(900)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    geometry.push({ theme, width, rect }); await page.screenshot({ path: join(evidence, `${theme}-${String(width)}.png`), animations: 'disabled' })
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' })
    if (width === 580) await page.screenshot({ path: join(evidence, 'composer-580-closed.png'), animations: 'disabled' })
  }
  hidden = saved.payload.video!.model
  await settings.click()
  const dialog = page.getByRole('dialog', { name: '创作偏好', exact: true })
  await dialog.getByRole('tab', { name: '视频', exact: true }).click()
  await expect.poll(() => dialog.innerText(), { timeout: 10_000 }).toContain('不可用')
  await dialog.getByRole('button').filter({ hasText: '跟随平台默认' }).click()
  await dialog.getByRole('button', { name: '保存', exact: true }).click(); await dialog.waitFor({ state: 'detached' })
  const reset = await (await scaffold.hostFetch('/credits/api/media/preferences')).json() as { payload: MediaPreferencesCatalog }
  expect(reset.payload.video).toBe(null); expect(reset.payload.image).toEqual(saved.payload.image)
  expect(forbidden).toEqual([]); expect(tripwire.pageErrors).toEqual([])
  expect(requests.filter(request => request.path.endsWith('/v1/models')).every(request => request.authenticated)).toBe(true)
  await writeFile(join(evidence, 'evidence.json'), JSON.stringify({ actualBuiltHostAndClient: true,
    fixture: 'Existing actual API pricing/models fixtures; loopback account and model disable are synthetic',
    requests, forbidden, geometry, saved: saved.payload, reset: reset.payload, chatCalls, imageCalls, priceWitnesses,
    admittedSelection: selection, sourceRpcId, pageErrors: tripwire.pageErrors }, null, 2) + '\n')
}, 120_000)
