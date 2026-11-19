/** A real built composer retains generation materials across incompatible catalog changes. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { catalogFromPricing, type VideoParams } from '../../../packages/host/credits-index/src/media.ts'
import fixture from '../../../packages/host/credits-index/tests/fixtures/media-video-parameters-actual-go-20261120.json' with { type: 'json' }
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

const ACCOUNT = 'video-transition-qa'
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const assetId = 'ma_transition1'
const emptyContent = { title: { zh: '' }, description: { zh: '' }, promptPlaceholder: { zh: '' },
  categories: [], templates: [], presets: [] }

it('retains a bound frame on model switch and same-model capability refresh until the user explicitly chooses text', async () => {
  const scaffold = await launchWebScaffold({})
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, colorScheme: 'dark',
        viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
      page.setDefaultTimeout(15_000)
      const tripwire = watchConsole(page)
      const root = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
      await mkdir(root, { recursive: true })
      const evidence = await mkdtemp(join(root, 'video-workflow-transition-'))
      const selected = fixture.cases.filter(value => value.case_id === 'MiniMax-H3/live-unmodified'
        || value.case_id === 'ycapi-seedance-2-5/live-unmodified')
      const initial = catalogFromPricing(selected, null)
      const h3 = initial.find(value => value.id === 'MiniMax-H3')
      const textOnly = initial.find(value => value.id === 'ycapi-seedance-2-5')
      if (h3?.kind !== 'video' || textOnly?.kind !== 'video') throw new Error('Missing retained Go video catalog cases')
      const params = h3.params as VideoParams
      const generation: Record<string, unknown>[] = [], quotes: string[] = [], unexpected: string[] = []
      const uploadHashes: string[] = []
      let catalogReads = 0
      let referencesDisabled = false
      await page.route('**/artifacts/api/list', route => route.fulfill({ status: 200, json: { items: [] } }))
      await page.route('**/credits/api/**', async (route) => {
        const request = route.request(), url = new URL(request.url())
        const json = async (payload: object): Promise<void> => route.fulfill({ status: 200, json: { ok: true, payload } })
        if (url.pathname === '/credits/api/announcement-banner' && request.method() === 'GET') {
          await json({ enabled: false, scope: '0'.repeat(64), revision: '1'.repeat(64), announcements: [] })
        } else if (url.pathname === '/credits/api/session' && request.method() === 'GET') {
          await json({ signedIn: true, creditsPerYuan: 1000, account: { id: ACCOUNT } })
        } else if (url.pathname === '/credits/api/summary' && request.method() === 'GET') await json({ balance_points: 10000 })
        else if (url.pathname === '/credits/api/media/catalog' && request.method() === 'GET') {
          catalogReads += 1
          // A same-ID capability update is a separate UI boundary, not a claim that the retained Go fixture changed.
          const updated = referencesDisabled ? { ...h3, params: { ...params, strictReferences: true,
            frameSlots: 0, maxFrameImages: 0, maxReferenceImages: 0, maxReferenceVideos: 0, maxReferenceAudios: 0 } } : h3
          await json({ image: [], video: [updated, { ...textOnly, displayName: '仅文字视频模型' }] })
        } else if (url.pathname === '/credits/api/creation/content' && request.method() === 'GET') {
          await json({ schemaVersion: 1, revision: 'transition-qa', image: emptyContent, video: emptyContent })
        } else if (url.pathname === '/credits/api/creative/projects' && request.method() === 'GET') await json({ accountId: ACCOUNT, projects: [] })
        else if (url.pathname === '/credits/api/chat-usage' && request.method() === 'GET') {
          await json({ scope: 'chat-model', status: 'unavailable', settledRequests: 0, totalRequests: 0, accountId: ACCOUNT })
        } else if (url.pathname === '/credits/api/usage' && request.method() === 'GET') await json({ rows: [], asOf: new Date().toISOString(), delayMinutes: 0 })
        else if (url.pathname === '/credits/api/assets' && request.method() === 'POST') {
          const bytes = request.postDataBuffer()
          expect(bytes).toEqual(image)
          uploadHashes.push(createHash('sha256').update(bytes ?? Buffer.alloc(0)).digest('hex'))
          await route.fulfill({ status: 200, json: { ok: true, asset: { assetId, contentType: 'image/png',
            sizeBytes: image.length, previewUrl: `/credits/api/assets/preview?asset_id=${assetId}` } } })
        } else if (url.pathname === '/credits/api/assets/preview' && request.method() === 'GET') {
          await route.fulfill({ status: 200, contentType: 'image/png', body: image })
        } else if (url.pathname.includes('quote')) {
          quotes.push(`${request.method()} ${url.pathname}`)
          await route.fulfill({ status: 400, json: { ok: false, code: 'UNEXPECTED_QUOTE' } })
        } else if (url.pathname === '/credits/api/video/tasks' && request.method() === 'POST') {
          const body: unknown = request.postDataJSON()
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected video request')
          generation.push(body as Record<string, unknown>)
          await route.fulfill({ status: 200, json: { ok: false, code: 'INVALID_REQUEST', submission_state: 'not-submitted' } })
        } else {
          unexpected.push(`${request.method()} ${url.pathname}`)
          await route.fulfill({ status: 404, json: { ok: false, code: 'UNEXPECTED_FIXTURE_REQUEST' } })
        }
      })
      try {
        await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
        await page.getByRole('button', { name: 'AI 创作', exact: true }).click()
        await page.locator('#imagegen').getByRole('tab', { name: '视频', exact: true }).click()
        const panel = page.locator('#videogen')
        const model = panel.getByRole('button', { name: '模型', exact: true })
        const send = panel.getByRole('button', { name: '生成视频', exact: true })
        const frameWorkflow = panel.getByRole('button', { name: '图生视频', exact: true })
        const prompt = panel.getByRole('textbox', { name: '画面描述', exact: true })
        const retained = panel.getByRole('img', { name: '保留主体.png', exact: true })
        await expect.poll(() => model.innerText()).toContain('mt-MiniMax-H3')
        await prompt.fill('保持这张图片中的主体，缓慢推进。')
        await panel.getByLabel('添加素材', { exact: true }).setInputFiles({ name: '保留主体.png', mimeType: 'image/png', buffer: image })
        await retained.waitFor()
        await expect.poll(() => retained.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true)
        await frameWorkflow.click()
        await expect.poll(() => send.isEnabled()).toBe(true)
        expect(await frameWorkflow.getAttribute('aria-pressed')).toBe('true')
        await page.screenshot({ path: join(evidence, 'bound-frame.png'), animations: 'disabled' })

        await model.click()
        await page.getByRole('menuitem', { name: '仅文字视频模型', exact: true }).click()
        await panel.getByRole('alert').filter({ hasText: '当前模型不支持所选生成方式。素材已保留，请切换模型或主动选择其他生成方式' }).waitFor()
        expect(await frameWorkflow.getAttribute('aria-pressed')).toBe('true')
        expect(await retained.isVisible()).toBe(true)
        expect(await send.isDisabled()).toBe(true)
        expect(generation).toEqual([])
        expect(quotes).toEqual([])
        await page.screenshot({ path: join(evidence, 'incompatible-model-blocked.png'), animations: 'disabled' })

        await model.click()
        await page.getByRole('menuitem', { name: 'mt-MiniMax-H3', exact: true }).click()
        await expect.poll(() => send.isEnabled()).toBe(true)
        expect(await frameWorkflow.getAttribute('aria-pressed')).toBe('true')
        referencesDisabled = true
        const readsBefore = catalogReads
        await panel.getByRole('tab', { name: '图片', exact: true }).click()
        await page.locator('#imagegen').getByRole('tab', { name: '视频', exact: true }).click()
        await expect.poll(() => catalogReads).toBeGreaterThan(readsBefore)
        await panel.getByRole('alert').filter({ hasText: '当前模型不支持所选生成方式。素材已保留，请切换模型或主动选择其他生成方式' }).waitFor()
        expect(await frameWorkflow.getAttribute('aria-pressed')).toBe('true')
        expect(await retained.isVisible()).toBe(true)
        expect(await send.isDisabled()).toBe(true)
        expect(generation).toEqual([])
        expect(quotes).toEqual([])
        await page.screenshot({ path: join(evidence, 'same-model-capability-blocked.png'), animations: 'disabled' })

        await panel.getByRole('button', { name: '文生视频', exact: true }).click()
        await expect.poll(() => send.isEnabled()).toBe(true)
        expect(await prompt.inputValue()).toBe('保持这张图片中的主体，缓慢推进。')
        expect(await retained.isVisible()).toBe(true)
        await send.click()
        await expect.poll(() => generation.length).toBe(1)
        await expect.poll(() => panel.getByRole('region', { name: '视频创作输入', exact: true }).getAttribute('aria-busy')).toBe('false')
        expect(generation).toHaveLength(1)
        expect(generation[0]).toMatchObject({ model: 'MiniMax-H3', frameImages: [], referenceImages: [], referenceVideos: [], referenceAudios: [] })
        expect(uploadHashes).toEqual([createHash('sha256').update(image).digest('hex')])
        expect(quotes).toEqual([])
        expect(unexpected).toEqual([])
        expect(tripwire.pageErrors).toEqual([])
        await page.screenshot({ path: join(evidence, 'explicit-text.png'), animations: 'disabled' })
        await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, runtime: 'real built shipped Web composition',
          catalogSource: fixture.source, modelChange: { retainedFrame: true, quote: 0, generationPost: 0 },
          sameModelCapabilityRefresh: { retainedFrame: true, quote: 0, generationPost: 0 },
          explicitText: { generationPost: generation.length, generation }, uploads: uploadHashes,
          catalogReads, unexpected, pageErrors: tripwire.pageErrors }, null, 2) + '\n')
        console.log(`Video workflow transition browser evidence: ${evidence}`)
      } catch (error) {
        await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined)
        await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), generation, quotes,
          unexpected, catalogReads, uploadHashes, pageErrors: tripwire.pageErrors }, null, 2) + '\n')
        throw error
      }
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})
