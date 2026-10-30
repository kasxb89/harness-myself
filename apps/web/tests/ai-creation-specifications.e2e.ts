/** Built AI creation uses complete public specifications and confirms independent speech estimates. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator } from 'playwright'
import { expect, it } from 'vitest'
import type { ModelCapability } from '../../../packages/host/credits-index/src/media.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

const ACCOUNT = 'creation-specifications-qa'
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
        if (url.pathname === '/credits/api/session') await json({ signedIn: true, creditsPerYuan: 1000, account: { id: ACCOUNT, phone: '+86 130 0000 0000' } })
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
