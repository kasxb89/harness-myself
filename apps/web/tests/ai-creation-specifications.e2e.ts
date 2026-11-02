/** Built AI creation uses complete public specifications and confirms independent speech estimates. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import publicPricing from '../../../packages/host/credits-index/tests/fixtures/official-price-comparison-api.json' with { type: 'json' }
import publicModels from '../../../packages/host/credits-index/tests/fixtures/official-price-comparison-models-api.json' with { type: 'json' }
import type { ModelCapability, ImageParams, VideoParams, AudioParams } from '../../../packages/host/credits-index/src/media.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

const ACCOUNT = 'creation-specifications-qa'
const disabledBannerPayload = { enabled: false, scope: '0'.repeat(64), revision: '1'.repeat(64), announcements: [] }
const imageModel: ModelCapability = { id: 'ycapi-image-qa', displayName: '图片完整规格', kind: 'image',
  groups: [], route: '/v1/images/generations', verified: true, source: 'newapi', notes: [],
  params: { sizes: ['1024x1024'], resolutions: ['1k', '2k'], maxCount: 1, maxEdits: 0,
    qualities: ['pro', 'max'], backgrounds: [], formats: [], moderations: [], seed: false,
    specifications: [{ size: '1024x1024', resolution: '1k', quality: 'pro' },
      { size: '1024x1024', resolution: '2k', quality: 'max' }] } }
const videoModel: ModelCapability = { id: 'ycapi-video-qa', displayName: '视频完整规格', kind: 'video',
  groups: [], route: '/v1/videos', verified: true, source: 'newapi', notes: [],
  params: { durations: [5, 10], minDuration: 5, maxDuration: 10, resolutions: ['720p', '1080p'], ratios: ['16:9'],
    maxFrameImages: 0, frameSlots: 0, maxReferenceImages: 0, maxReferenceVideos: 0, maxReferenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: false, watermark: false, mixFramesAndReferences: true,
    qualities: ['mini', 'fast', 'standard'], strictReferences: true,
    specifications: [{ resolution: '720p', seconds: 5, ratio: '16:9', quality: 'mini' },
      { resolution: '720p', seconds: 5, ratio: '16:9', quality: 'fast' },
      { resolution: '1080p', seconds: 10, ratio: '16:9', quality: 'standard' }] } }
const audioModel: ModelCapability = { id: 'ycapi-speech-qa', displayName: '语音合成测试', kind: 'audio',
  groups: [], route: '/v1/audio/speech', verified: true, source: 'newapi', notes: [],
  params: { voices: ['calm', 'bright'], formats: ['wav', 'mp3'], maxCharacters: 2000, instructions: true,
    speedRange: { minimum: 0.5, maximum: 2 }, execution: {
      protocol: 'openai-speech-v1', quoteRoute: '/v1/audio/quote', taskRoute: '/v1/tasks',
    } } }
const emptyMode = { title: { zh: '' }, description: { zh: '' }, promptPlaceholder: { zh: '' },
  categories: [], templates: [], presets: [] }

/** A short local PCM fixture exercises real native audio loading without a provider. */
function wave(): Buffer {
  const samples = 2205
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(22050, 24); bytes.writeUInt32LE(44100, 28); bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40)
  return bytes
}
function body(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected fixture JSON object')
  return value as Record<string, unknown>
}
async function visibleBox(locator: Locator, width: number): Promise<object> {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (box === null) throw new Error('Visible creation control must have geometry')
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(width + 1)
  expect(box.width).toBeGreaterThan(20)
  return box
}

it('keeps complete image/video specifications and speech confirmation usable in built light and dark UI', async () => {
  const scaffold = await launchWebScaffold({})
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, colorScheme: 'dark',
        viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
      page.setDefaultTimeout(15_000)
      const tripwire = watchConsole(page)
      const directory = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
      await mkdir(directory, { recursive: true })
      const evidence = await mkdtemp(join(directory, 'ai-creation-specifications-'))
      const imageRequests: Record<string, unknown>[] = [], videoRequests: Record<string, unknown>[] = []
      const audioQuotes: Record<string, unknown>[] = [], audioRequests: Record<string, unknown>[] = []
      const audioRecoveries: Record<string, unknown>[] = []
      const unexpected: string[] = [], geometry: object[] = []
      const clip = await readFile(fileURLToPath(new URL('./fixtures/sidebar-media/preview.mp4', import.meta.url)))
      const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', 'base64')
      let quoteSequence = 0
      await page.route('**/artifacts/api/list', route => route.fulfill({ status: 200, json: { items: [] } }))
      await page.route('**/artifacts/api/raw?**', route => route.fulfill({ status: 200,
        contentType: route.request().url().includes('spec-image') ? 'image/png' : 'video/mp4',
        body: route.request().url().includes('spec-image') ? image : clip }))
      await page.route('**/credits/api/**', async (route) => {
        const request = route.request(), url = new URL(request.url())
        const json = async (payload: object): Promise<void> => route.fulfill({ status: 200, json: { ok: true, payload } })
        if (url.pathname === '/credits/api/announcement-banner' && request.method() === 'GET') await json(disabledBannerPayload)
        else if (url.pathname === '/credits/api/session') await json({ signedIn: true, creditsPerYuan: 1000, account: { id: ACCOUNT, phone: '+86 130 0000 0000' } })
        else if (url.pathname === '/credits/api/summary') await json({ balance_points: 10000 })
        else if (url.pathname === '/credits/api/media/catalog') await json({ image: [imageModel], video: [videoModel], audio: [audioModel] })
        else if (url.pathname === '/credits/api/creation/content') await json({ schemaVersion: 1, revision: 'specifications-qa',
          image: emptyMode, video: emptyMode })
        else if (url.pathname === '/credits/api/creative/projects') await json({ accountId: ACCOUNT, projects: [] })
        else if (url.pathname === '/credits/api/chat-usage') await json({ scope: 'chat-model', status: 'unavailable',
          settledRequests: 0, totalRequests: 0, accountId: ACCOUNT })
        else if (url.pathname === '/credits/api/usage') await json({ rows: [], asOf: new Date().toISOString(), delayMinutes: 0 })
        else if (url.pathname === '/credits/api/image/generate' && request.method() === 'POST') {
          imageRequests.push(body(request.postDataJSON()))
          await json({ path: '/mock/spec-image.png' })
        } else if (url.pathname === '/credits/api/video/tasks' && request.method() === 'POST') {
          videoRequests.push(body(request.postDataJSON()))
          await json({ path: '/mock/spec-video.mp4' })
        } else if (url.pathname === '/credits/api/audio/models') await route.fulfill({ status: 200,
          json: { ok: true, accountId: ACCOUNT, models: [audioModel] } })
        else if (url.pathname === '/credits/api/audio/submissions') await route.fulfill({ status: 200,
          json: { ok: true, submissions: [] } })
        else if (url.pathname === '/credits/api/audio/quote' && request.method() === 'POST') {
          const value = body(request.postDataJSON())
          audioQuotes.push(value); quoteSequence += 1
          const parameters = { model: value.model, input: value.input, voice: value.voice, response_format: value.response_format,
            ...value.speed === undefined ? {} : { speed: value.speed },
            ...value.instructions === undefined ? {} : { instructions: value.instructions } }
          const now = Math.floor(Date.now() / 1000)
          await route.fulfill({ status: 200, json: { ok: true, quote: { object: 'audio.quote', schema_version: 1,
            quote_id: `quote-${String(quoteSequence)}`, account_binding: 'fixture-owner', model: audioModel.id,
            request_fingerprint: createHash('sha256').update(JSON.stringify(parameters)).digest('hex'),
            estimated_total: '0.012', total_quota: 12, currency: 'CNY', pricing_revision: 'fixture-r1',
            created_at: now, expires_at: now + 60, estimate_only: true, charged: false, submitted: false, reserved: false } } })
        } else if (url.pathname === '/credits/api/audio/generate' && request.method() === 'POST') {
          const value = body(request.postDataJSON())
          audioRequests.push(value)
          if (typeof value.session_id !== 'string' || typeof value.submission_id !== 'string') throw new Error('Missing speech ownership')
          await route.fulfill({ status: 200, json: { ok: true, submissionId: value.submission_id, model: audioModel.id,
            status: 'completed', code: 'AUDIO_SAVE_PENDING', filename: '测试朗读.wav', mediaUrl: `/credits/api/audio/content?${new URLSearchParams({
              session_id: value.session_id, submission_id: value.submission_id })}` } })
        } else if (url.pathname === '/credits/api/audio/recover' && request.method() === 'POST') {
          const value = body(request.postDataJSON())
          audioRecoveries.push(value)
          if (typeof value.session_id !== 'string' || typeof value.submission_id !== 'string') throw new Error('Missing original speech ownership')
          await route.fulfill({ status: 200, json: { ok: true, submissionId: value.submission_id, model: audioModel.id,
            status: 'completed', filename: '测试朗读.wav', mediaUrl: `/credits/api/audio/content?${new URLSearchParams({
              session_id: value.session_id, submission_id: value.submission_id })}` } })
        } else if (url.pathname === '/credits/api/audio/content' && request.method() === 'GET') {
          await route.fulfill({ status: 200, contentType: 'audio/wav', body: wave() })
        } else {
          unexpected.push(`${request.method()} ${url.pathname}`)
          await route.fulfill({ status: 404, json: { ok: false, code: 'UNEXPECTED_FIXTURE_REQUEST' } })
        }
      })
      try {
        await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
        await page.getByRole('button', { name: 'AI 创作', exact: true }).click()
        const images = page.locator('#imagegen')
        const imageSpecification = images.getByRole('combobox', { name: '完整规格', exact: true })
        await imageSpecification.selectOption('1')
        expect(await imageSpecification.inputValue()).toBe('1')
        expect(await images.getByRole('combobox', { name: '质量', exact: true }).count()).toBe(0)
        expect(await images.getByRole('combobox', { name: '张数', exact: true }).count()).toBe(0)
        await images.getByRole('textbox', { name: '画面描述', exact: true }).fill('固定完整规格的图片')
        const imageSubmit = images.getByRole('button', { name: '生成图片', exact: true })
        await expect.poll(() => imageSubmit.isEnabled()).toBe(true)
        await page.screenshot({ path: join(evidence, 'image-complete-specification.png'), animations: 'disabled' })
        await imageSubmit.click()
        await expect.poll(() => imageRequests.length).toBe(1)
        expect(imageRequests[0]).toMatchObject({ model: imageModel.id, size: '1024x1024', resolution: '2k', quality: 'max',
          count: 1, references: [] })
        await images.getByRole('tab', { name: '视频', exact: true }).click()
        const videos = page.locator('#videogen')
        const offers = videos.getByRole('group', { name: '完整规格', exact: true })
        const fast = offers.getByRole('button', { name: '16:9 · 720p · 5 秒 · fast', exact: true })
        await fast.click()
        expect(await fast.getAttribute('aria-pressed')).toBe('true')
        expect(await videos.getByRole('group', { name: '分辨率', exact: true }).count()).toBe(0)
        expect(await videos.getByRole('group', { name: '时长', exact: true }).count()).toBe(0)
        await videos.getByRole('textbox', { name: '画面描述', exact: true }).fill('完整规格的五秒镜头')
        const videoSubmit = videos.getByRole('button', { name: '生成视频', exact: true })
        await expect.poll(() => videoSubmit.isEnabled()).toBe(true)
        for (const [theme, width] of [['dark', 1440], ['light', 900]] as const) {
          await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height: 1000 })
          geometry.push({ mode: 'video', theme, width, specification: await visibleBox(offers, width), submit: await visibleBox(videoSubmit, width) })
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
          await page.screenshot({ path: join(evidence, `video-specifications-${theme}-${String(width)}.png`), animations: 'disabled' })
        }
        await videoSubmit.click()
        await expect.poll(() => videoRequests.length).toBe(1)
        expect(videoRequests[0]).toMatchObject({ model: videoModel.id, resolution: '720p', durationSeconds: 5,
          ratio: '16:9', quality: 'fast', frameImages: [], referenceImages: [], referenceVideos: [], referenceAudios: [] })
        await videos.getByRole('tab', { name: '音频', exact: true }).click()
        const audio = page.locator('main').filter({ has: page.getByText('音频创作', { exact: true }) }).last()
        const input = page.getByRole('textbox', { name: '朗读文本（最多 2000 字）', exact: true })
        await input.fill('第一次估价')
        const voice = page.getByRole('button', { name: '音色', exact: true })
        await voice.click()
        const bright = page.getByRole('menuitem', { name: 'bright', exact: true })
        geometry.push({ mode: 'voice-menu', item: await visibleBox(bright, 900) })
        await page.screenshot({ path: join(evidence, 'audio-voice-menu.png'), animations: 'disabled' })
        await bright.click()
        await page.getByRole('button', { name: '格式', exact: true }).click()
        await page.getByRole('menuitem', { name: 'mp3', exact: true }).click()
        expect(await page.getByRole('button', { name: '格式', exact: true }).innerText()).toContain('mp3')
        await page.getByRole('button', { name: '格式', exact: true }).click()
        await page.getByRole('menuitem', { name: 'wav', exact: true }).click()
        await page.getByRole('spinbutton', { name: '语速（可选）', exact: true }).fill('1.25')
        await page.getByRole('textbox', { name: '语气要求（可选）', exact: true }).fill('温和叙述')
        await page.getByRole('button', { name: '免费估价', exact: true }).click()
        const confirm = page.getByRole('button', { name: '确认生成 · 0.012 CNY', exact: true })
        await confirm.waitFor()
        expect(audioQuotes).toHaveLength(1)
        expect(audioRequests).toHaveLength(0)
        await input.fill('新的文本要重新估价')
        await expect.poll(() => page.getByRole('button', { name: '生成音频', exact: true }).isDisabled()).toBe(true)
        await page.getByRole('button', { name: '免费估价', exact: true }).click()
        await confirm.waitFor()
        expect(audioQuotes).toHaveLength(2)
        for (const [theme, width] of [['light', 900], ['dark', 1440]] as const) {
          await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height: 1000 })
          geometry.push({ mode: 'audio', theme, width, form: await visibleBox(audio, width), confirm: await visibleBox(confirm, width) })
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
          await page.screenshot({ path: join(evidence, `audio-confirmation-${theme}-${String(width)}.png`), animations: 'disabled' })
        }
        await confirm.click()
        await expect.poll(() => audioRequests.length).toBe(1)
        expect(audioRequests[0]).toMatchObject({ account_id: ACCOUNT, model: audioModel.id, input: '新的文本要重新估价',
          voice: 'bright', response_format: 'wav', speed: 1.25, instructions: '温和叙述', quote_id: 'quote-2' })
        const player = page.getByLabel('播放生成的音频', { exact: true })
        await player.waitFor()
        expect(await player.getAttribute('controls')).not.toBeNull()
        expect(await player.getAttribute('src')).toContain('/credits/api/audio/content?')
        expect(await page.getByRole('link', { name: '下载原文件', exact: true }).getAttribute('download')).toBe('测试朗读.wav')
        await player.evaluate((element) => { if (element instanceof HTMLMediaElement) { element.preload = 'metadata'; element.load() } })
        await expect.poll(() => player.evaluate(element => element instanceof HTMLMediaElement
          ? element.readyState : -1)).toBeGreaterThan(0)
        const saveAgain = page.getByRole('button', { name: '重新保存到产物目录', exact: true })
        await saveAgain.waitFor()
        await page.getByText('ycapi-speech-qa · 音频已生成，待保存到产物目录', { exact: true }).waitFor()
        await page.screenshot({ path: join(evidence, 'audio-save-pending.png'), animations: 'disabled' })
        await saveAgain.click()
        await expect.poll(() => audioRecoveries.length).toBe(1)
        await expect.poll(() => saveAgain.count()).toBe(0)
        await page.getByText('ycapi-speech-qa · 音频已保存', { exact: true }).waitFor()
        expect(audioRequests).toHaveLength(1)
        expect(audioQuotes).toHaveLength(2)
        expect(audioRecoveries[0]).toMatchObject({ account_id: ACCOUNT,
          session_id: audioRequests[0]?.session_id, submission_id: audioRequests[0]?.submission_id })
        await page.screenshot({ path: join(evidence, 'audio-playback.png'), animations: 'disabled' })
        expect(unexpected).toEqual([])
        expect(tripwire.pageErrors).toEqual([])
        await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true,
          runtime: 'real built shipped Web composition', providerCalls: 0, paidCalls: 0,
          imageRequests, videoRequests, audioQuotes, audioRequests, audioRecoveries, geometry, unexpected,
          pageErrors: tripwire.pageErrors }, null, 2) + '\n')
        console.log(`AI creation specifications evidence: ${evidence}`)
      } catch (error) {
        await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined)
        await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), unexpected,
          imageRequests, videoRequests, audioQuotes, audioRequests, audioRecoveries, pageErrors: tripwire.pageErrors }, null, 2) + '\n')
        throw error
      }
    } finally { await browser.close() }
  } finally { await scaffold.close() }
}, 180_000)


it('checks all authorized media catalog specifications through the built creation controls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-creation-catalog-matrix-'))
  const cleanup: { scaffold?: () => Promise<void>; browser?: () => Promise<void>; upstream?: () => Promise<void> } = {}
  onTestFinished(async () => {
    try { await cleanup.browser?.() } finally {
      try { await cleanup.scaffold?.() } finally {
        try { await cleanup.upstream?.() } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  })
  const upstreamRequests: { method: string; path: string; authenticated: boolean }[] = []
  const forbidden: string[] = []
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    upstreamRequests.push({ method: request.method ?? 'GET', path, authenticated: request.headers.authorization !== undefined })
    response.setHeader('content-type', 'application/json')
    const answer = (data: unknown): void => { response.end(JSON.stringify({ success: true, data })) }
    if (path === '/harness/api/client-activity/heartbeat' && request.method === 'POST') {
      answer({ server_time: Math.floor(Date.now() / 1000), heartbeat_interval_seconds: 60 }); return
    }
    if (request.method !== 'GET') forbidden.push(`${request.method ?? ''} ${path}`)
    if (path === '/harness/api/pricing') { response.end(JSON.stringify(publicPricing)); return }
    if (path === '/harness/v1/models') {
      if (request.headers.authorization !== 'Bearer sk-synthetic-creation-catalog') {
        forbidden.push('Catalog discovery lacked the current relay token'); response.statusCode = 403; response.end('{}'); return
      }
      response.end(JSON.stringify(publicModels)); return
    }
    if (path === '/harness/api/status') { answer({ quota_per_unit: 500_000, usd_exchange_rate: 6.7138 }); return }
    if (path === '/harness/api/user/self') { answer({ id: 7, username: 'creation-catalog', group: 'default', quota: 50_000_000 }); return }
    if (path === '/harness/api/log/self') { answer({ total: 0, items: [] }); return }
    if (/chat\/completions|images\/generations|audio\/(speech|quote)|video|recharge|payment/u.test(path)) forbidden.push(path)
    response.statusCode = 404; response.end(JSON.stringify({ success: false }))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.upstream = () => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) }); server.closeAllConnections()
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Catalog matrix requires loopback upstream')
  const state = join(root, 'credits'); await mkdir(state)
  await writeFile(join(state, 'session.json'), JSON.stringify({ token: 'synthetic-creation-catalog-session',
    expiresAt: '9999-01-01T00:00:00.000Z', account: { id: '7', phone: '13800000000' },
    upstream: { token: 'synthetic-access', refresh: 'synthetic-refresh', expiresAt: '9999-01-01T00:00:00.000Z' },
    relay: { key: 'sk-synthetic-creation-catalog', id: 7 },
  }), { mode: 0o600 })
  const overlay = join(root, 'catalog.patch.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'credits-index', config: { newApiBaseUrl: `http://127.0.0.1:${String(address.port)}/harness`,
      baseUrl: '', bridgeBaseUrl: '', stateDir: state } },
    ...['dsh-market', 'dsh-skin-market'].map(id => ({ id, disabled: true })),
  ]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay }); cleanup.scaffold = () => scaffold.close()
  const catalogResponse = await scaffold.hostFetch('/credits/api/media/catalog')
  const directory = await catalogResponse.json() as {
    readonly ok: boolean
    readonly payload: {
      image: readonly (ModelCapability & { kind: 'image'; params: ImageParams })[]
      video: readonly (ModelCapability & { kind: 'video'; params: VideoParams })[]
      audio: readonly (ModelCapability & { kind: 'audio'; params: AudioParams })[]
    }
  }
  expect(catalogResponse.ok).toBe(true); expect(directory.ok).toBe(true)
  const catalog = directory.payload
  expect(catalog.image).toHaveLength(8); expect(catalog.video).toHaveLength(10); expect(catalog.audio).toHaveLength(3)
  expect(catalog.image.every(model => model.id.startsWith('ycapi-'))).toBe(true)
  expect(catalog.video.every(model => model.id.startsWith('ycapi-'))).toBe(true)
  const imageCount = catalog.image.reduce((sum, model) => sum + (model.params.specifications?.length ?? 0), 0)
  const videoCount = catalog.video.reduce((sum, model) => sum + (model.params.specifications?.length ?? 0), 0)
  expect(imageCount).toBe(19); expect(videoCount).toBe(44)
  const browser = await chromium.launch(); cleanup.browser = () => browser.close()
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, colorScheme: 'light',
    viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' })
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  const evidenceBase = fileURLToPath(new URL('../../../.artifacts/', import.meta.url)); await mkdir(evidenceBase, { recursive: true })
  const evidence = await mkdtemp(join(evidenceBase, 'ai-creation-catalog-matrix-'))
  const captures: { kind: 'image' | 'video' | 'audio'; model: string; specification: object; request: Record<string, unknown> }[] = []
  const quotes: Record<string, unknown>[] = []
  let expectedImage: Record<string, unknown> | undefined, expectedVideo: Record<string, unknown> | undefined
  let expectedAudio: Record<string, unknown> | undefined
  const routeFailures: string[] = []
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  const clip = await readFile(fileURLToPath(new URL('./fixtures/sidebar-media/preview.mp4', import.meta.url)))
  const assertPayload = (received: Record<string, unknown>, expected: Record<string, unknown>): void => {
    expect(typeof received.session_id).toBe('string')
    const { session_id: _session, ...parameters } = received
    expect(parameters).toEqual({ account_id: '7', ...expected })
  }
  await page.route('**/artifacts/api/list', route => route.fulfill({ status: 200, json: { items: [] } }))
  await page.route('**/artifacts/api/raw?**', route => route.fulfill({ status: 200,
    contentType: route.request().url().includes('catalog-image') ? 'image/png' : 'video/mp4',
    body: route.request().url().includes('catalog-image') ? png : clip }))
  await page.route('**/credits/api/**', async (route) => {
    const request = route.request(), url = new URL(request.url())
    const json = async (payload: object): Promise<void> => route.fulfill({ status: 200, json: { ok: true, payload } })
    try {
      if (url.pathname === '/credits/api/announcement-banner' && request.method() === 'GET') await json(disabledBannerPayload)
      else if (url.pathname === '/credits/api/creation/content') await json({ schemaVersion: 1, revision: 'catalog-matrix', image: emptyMode, video: emptyMode })
      else if (url.pathname === '/credits/api/creative/projects') await json({ accountId: '7', projects: [] })
      else if (url.pathname === '/credits/api/image/submissions' || url.pathname === '/credits/api/video/submissions') await json({ submissions: [] })
      else if (url.pathname === '/credits/api/audio/submissions') await route.fulfill({ status: 200, json: { ok: true, submissions: [] } })
      else if (url.pathname === '/credits/api/image/generate' && request.method() === 'POST') {
        const value = body(request.postDataJSON())
        if (expectedImage === undefined) throw new Error('Unexpected image POST')
        assertPayload(value, expectedImage)
        captures.push({ kind: 'image', model: String(value.model), specification: expectedImage, request: value })
        await json({ path: '/mock/catalog-image.png' })
      } else if (url.pathname === '/credits/api/video/tasks' && request.method() === 'POST') {
        const value = body(request.postDataJSON())
        if (expectedVideo === undefined) throw new Error('Unexpected video POST')
        assertPayload(value, expectedVideo)
        captures.push({ kind: 'video', model: String(value.model), specification: expectedVideo, request: value })
        await json({ path: '/mock/catalog-video.mp4' })
      } else if (url.pathname === '/credits/api/audio/quote' && request.method() === 'POST') {
        const value = body(request.postDataJSON())
        if (expectedAudio === undefined) throw new Error('Unexpected audio quote')
        assertPayload(value, expectedAudio); quotes.push(value)
        const now = Math.floor(Date.now() / 1000)
        await route.fulfill({ status: 200, json: { ok: true, quote: { object: 'audio.quote', schema_version: 1,
          quote_id: `matrix-quote-${String(quotes.length)}`, account_binding: 'synthetic-catalog', model: value.model,
          request_fingerprint: createHash('sha256').update(JSON.stringify(expectedAudio)).digest('hex'),
          estimated_total: '0.012', total_quota: 12, currency: 'CNY', pricing_revision: 'synthetic-matrix',
          created_at: now, expires_at: now + 60, estimate_only: true, charged: false, submitted: false, reserved: false } } })
      } else if (url.pathname === '/credits/api/audio/generate' && request.method() === 'POST') {
        const value = body(request.postDataJSON())
        if (expectedAudio === undefined) throw new Error('Unexpected audio POST')
        expect(value.quote_id).toBe(`matrix-quote-${String(quotes.length)}`)
        expect(typeof value.submission_id).toBe('string')
        const { quote_id: _quote, submission_id: _submission, ...parameters } = value
        assertPayload(parameters, expectedAudio)
        captures.push({ kind: 'audio', model: String(value.model), specification: expectedAudio, request: value })
        await route.fulfill({ status: 200, json: { ok: true, submissionId: value.submission_id, model: value.model,
          status: 'completed', filename: 'catalog-audio.wav', mediaUrl: `/credits/api/audio/content?${new URLSearchParams({
            session_id: String(value.session_id), submission_id: String(value.submission_id) })}` } })
      } else if (url.pathname === '/credits/api/audio/content') await route.fulfill({ status: 200, contentType: 'audio/wav', body: wave() })
      else await route.continue()
    } catch (error) {
      routeFailures.push(`${request.method()} ${url.pathname}: ${String(error)}`)
      await route.fulfill({ status: 400, json: { ok: false, code: 'CATALOG_UI_CONTRACT_MISMATCH' } })
    }
  })
  try {
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    await page.getByRole('button', { name: 'AI 创作', exact: true }).click()
    const images = page.locator('#imagegen')
    const imageModelChoice = images.getByRole('combobox', { name: '模型', exact: true })
    for (const model of catalog.image) {
      const params = model.params
      expect(params.maxEdits).toBe(0); expect(params.formats).toEqual([])
      expect(params.maxCount).toBe(1)
      await imageModelChoice.selectOption(model.id)
      const specifications = params.specifications
      if (specifications === undefined) throw new Error(`${model.id} lacks complete image specifications`)
      const choice = images.getByRole('combobox', { name: '完整规格', exact: true })
      await expect.poll(() => choice.locator('option').count()).toBe(specifications.length)
      expect(await images.getByRole('combobox').count()).toBe(2)
      expect(await images.getByRole('combobox', { name: '输出格式', exact: true }).count()).toBe(0)
      for (const [index, specification] of specifications.entries()) {
        await choice.selectOption(String(index))
        expect(await choice.inputValue()).toBe(String(index))
        const prompt = `Catalog image ${model.id} specification ${String(index)}`
        await images.getByRole('textbox', { name: '画面描述', exact: true }).fill(prompt)
        expectedImage = { model: model.id, prompt, count: 1, references: [],
          ...(specification.size ?? specification.ratio) === undefined ? {} : { size: specification.size ?? specification.ratio },
          ...specification.resolution === undefined ? {} : { resolution: specification.resolution },
          ...specification.quality === undefined ? {} : { quality: specification.quality } }
        const before = captures.length
        const submit = images.getByRole('button', { name: '生成图片', exact: true })
        await expect.poll(() => submit.isEnabled()).toBe(true)
        await submit.click(); await expect.poll(() => captures.length).toBe(before + 1)
        if (index === 0) await page.screenshot({ path: join(evidence, `image-${model.id}.png`), animations: 'disabled' })
      }
    }
    await images.getByRole('tab', { name: '视频', exact: true }).click()
    const videos = page.locator('#videogen')
    for (const model of catalog.video) {
      const params = model.params
      expect(params.frameSlots).toBe(0); expect(params.maxReferenceImages).toBe(0)
      expect(params.maxReferenceVideos).toBe(0); expect(params.maxReferenceAudios).toBe(0)
      await videos.getByRole('button', { name: '模型', exact: true }).click()
      await page.getByRole('menuitem', { name: model.displayName, exact: true }).click()
      const specifications = params.specifications
      if (specifications === undefined) throw new Error(`${model.id} lacks complete video specifications`)
      const choices = videos.getByRole('group', { name: '完整规格', exact: true }).getByRole('button')
      await expect.poll(() => choices.count()).toBe(specifications.length)
      expect(await videos.getByRole('group', { name: '分辨率', exact: true }).count()).toBe(0)
      expect(await videos.getByRole('group', { name: '时长', exact: true }).count()).toBe(0)
      for (const [index, specification] of specifications.entries()) {
        await choices.nth(index).click()
        expect(await choices.nth(index).getAttribute('aria-pressed')).toBe('true')
        const prompt = `Catalog video ${model.id} specification ${String(index)}`
        await videos.getByRole('textbox', { name: '画面描述', exact: true }).fill(prompt)
        expectedVideo = { model: model.id, prompt, durationSeconds: specification.seconds,
          frameImages: [], referenceImages: [], referenceVideos: [], referenceAudios: [],
          ...specification.resolution === undefined ? {} : { resolution: specification.resolution },
          ...specification.ratio === undefined ? {} : { ratio: specification.ratio },
          ...specification.quality === undefined ? {} : { quality: specification.quality },
          ...specification.mode === undefined ? {} : { mode: specification.mode },
          ...specification.size === undefined ? {} : { size: specification.size } }
        const before = captures.length
        const submit = videos.getByRole('button', { name: '生成视频', exact: true })
        await expect.poll(() => submit.isEnabled()).toBe(true)
        await submit.click(); await expect.poll(() => captures.length).toBe(before + 1)
        if (index === 0) await page.screenshot({ path: join(evidence, `video-${model.id}.png`), animations: 'disabled' })
      }
    }
    await videos.getByRole('tab', { name: '音频', exact: true }).click()
    for (const model of catalog.audio) {
      const params = model.params
      await page.getByRole('button', { name: '语音模型', exact: true }).click()
      await page.getByRole('menuitem', { name: model.displayName, exact: true }).click()
      const voice = params.voices[0], format = params.formats[0]
      if (voice === undefined || format === undefined) throw new Error(`${model.id} lacks public audio choices`)
      await page.getByRole('button', { name: '音色', exact: true }).click()
      expect(await page.getByRole('menuitem').allTextContents()).toEqual(params.voices)
      await page.getByRole('menuitem', { name: voice, exact: true }).click()
      await page.getByRole('button', { name: '格式', exact: true }).click()
      expect(await page.getByRole('menuitem').allTextContents()).toEqual(params.formats)
      await page.getByRole('menuitem', { name: format, exact: true }).click()
      expect(await page.getByRole('spinbutton', { name: '语速（可选）', exact: true }).count()).toBe(params.speedRange === undefined ? 0 : 1)
      expect(await page.getByRole('textbox', { name: '语气要求（可选）', exact: true }).count()).toBe(params.instructions ? 1 : 0)
      const input = `Catalog audio ${model.id}`
      await page.getByRole('textbox', { name: `朗读文本（最多 ${String(params.maxCharacters)} 字）`, exact: true }).fill(input)
      expectedAudio = { model: model.id, input, voice, response_format: format }
      const before = captures.length
      await page.getByRole('button', { name: '免费估价', exact: true }).click()
      const confirm = page.getByRole('button', { name: '确认生成 · 0.012 CNY', exact: true })
      await confirm.waitFor(); expect(captures.length).toBe(before)
      await page.screenshot({ path: join(evidence, `audio-${model.id}.png`), animations: 'disabled' })
      await confirm.click(); await expect.poll(() => captures.length).toBe(before + 1)
    }
    expect(captures.filter(value => value.kind === 'image')).toHaveLength(imageCount)
    expect(captures.filter(value => value.kind === 'video')).toHaveLength(videoCount)
    expect(captures.filter(value => value.kind === 'audio')).toHaveLength(3)
    expect(quotes).toHaveLength(3); expect(routeFailures).toEqual([]); expect(forbidden).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    await writeFile(join(evidence, 'matrix.json'), JSON.stringify({ status: 'BUILT_UI_CATALOG_MATRIX_PASS',
      scope: 'Real built Host authorization/catalog normalization and actual built UI controls. Generation/quote POSTs intercepted at the frontend Host boundary, not provider execution. Compare captured bodies with the separate actual API plugin decoder proof.',
      fixture: 'Actual public pricing/models fixture files, loopback synthetic account only',
      paidCalls: 0, providerCalls: 0, modelCounts: { image: 8, video: 10, audio: 3 }, imageSpecifications: imageCount,
      videoSpecifications: videoCount, captures, quotes, upstreamRequests, routeFailures, forbidden,
      pageErrors: tripwire.pageErrors, catalog }, null, 2) + '\n')
    console.log(`AI creation catalog matrix evidence: ${evidence}`)
  } catch (error) {
    await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined)
    await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), captures, quotes,
      upstreamRequests, routeFailures, forbidden, pageErrors: tripwire.pageErrors }, null, 2) + '\n')
    throw error
  }
}, 300_000)
