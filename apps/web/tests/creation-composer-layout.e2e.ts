/** Built creation composers share one material area above prompts and one upload input. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator } from 'playwright'
import { expect, it } from 'vitest'
import { catalogFromPricing } from '../../../packages/host/credits-index/src/media.ts'
import { normalizeReferenceImage } from '../../../packages/host/credits-index/src/reference-image.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

const videoLabels = {
  'lec-mj-seedance-2-5-cd-720p': 'Seedance 2.5 · 720p · 30秒（线路1）',
  'sd-25-900-2': 'Seedance 2.5 · 720p · 30秒（线路2）',
  'k2-sd2.5-720p': 'Seedance 2.5 满参版 · 720p · 30秒',
  'lec-sz-sd2-full-480p': 'Seedance 2.5 · 480p · 30秒',
  'video-sd25-480p': 'Seedance 2.5 · 480p · 15–30秒',
  'model_5': 'Seedance 2.5 完整版 · 480p · 15–30秒',
  'sd2.5-720p-x2': 'Seedance 2.5 完整版 · 720p · 15–30秒',
  'sd2-th-2.0-720p': 'Seedance 2.0 Fast · 720p · 15秒（线路1）',
  'bt-seedance-2.0': 'Seedance 2.0 · 720p · 10/15秒',
  'lec-rs-seedance-2-0-fast': 'Seedance 2.0 Fast · 720p · 15秒（线路2）',
  'sd20-933-720p': 'Seedance 2.0 Fast · 720p · 15秒（线路3）',
  'sd2-hn2-480-pro': 'Seedance 2.0 完整版 · 480p · 15秒',
  'v3-sd2.0-933-720p': 'Seedance 2.0 完整版 · 720p · 15秒（线路1）',
  'sd-20-9/3/3-1': 'Seedance 2.0 完整版 · 720p · 15秒（线路2）',
  'sd-20-903': 'Seedance 2.0 Fast · 480p · 15秒',
} as const

/** Compare rendered coordinates after the browser has decoded every uploaded image. */
async function materialsAbovePrompt(panel: Locator): Promise<{ promptTop: number; materialBottom: number }> {
  const images = panel.locator('img')
  await expect.poll(() => images.evaluateAll(items => items.length === 3 && items.every(item =>
    item instanceof HTMLImageElement && item.complete && item.naturalWidth > 0))).toBe(true)
  const prompt = await panel.getByRole('textbox', { name: '画面描述', exact: true }).boundingBox()
  const materialBottom = await images.evaluateAll(items => Math.max(...items.map(item => item.getBoundingClientRect().bottom)))
  if (prompt === null) throw new Error('Creation prompt must be visible')
  expect(materialBottom).toBeLessThanOrEqual(prompt.y)
  return { promptTop: prompt.y, materialBottom }
}

it('keeps all images above long prompts and maps video frame roles without duplicate uploaders', async () => {
  const scaffold = await launchWebScaffold({})
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
      page.setDefaultTimeout(15_000)
      const tripwire = watchConsole(page)
      const directory = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
      await mkdir(directory, { recursive: true })
      const evidence = await mkdtemp(join(directory, 'creation-composer-layout-'))
      const image = await normalizeReferenceImage(png, '参考.png')
      const uploads: string[] = [], paidRequests: string[] = [], unexpectedReads: string[] = []
      let friendlyLabels = false, catalogReads = 0
      const geometry: Record<string, Awaited<ReturnType<typeof materialsAbovePrompt>>> = {}
      await page.route('**/artifacts/api/list', route => route.fulfill({ status: 200, json: { items: [] } }))
      await page.route('**/credits/api/**', async (route) => {
        const request = route.request(), url = new URL(request.url())
        const json = async (payload: object): Promise<void> => route.fulfill({ status: 200, json: { ok: true, payload } })
        if (url.pathname === '/credits/api/session') {
          await json({ signedIn: true, creditsPerYuan: 1000, account: { id: 'creation-layout-qa' } })
        } else if (url.pathname === '/credits/api/summary') await json({ balance_points: 10000 })
        else if (url.pathname === '/credits/api/creative/projects') await json({ accountId: 'creation-layout-qa', projects: [] })
        else if (url.pathname === '/credits/api/media/catalog') {
          catalogReads += 1
          const catalog = catalogFromPricing([
            { model_name: 'yunshu-internal-gpt-image-2', supported_endpoint_types: ['image-generation'], display_name: '图片模型' },
            { model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] },
            ...Object.entries(videoLabels).map(([id, label]) => ({ model_name: id, supported_endpoint_types: ['openai-video'],
              display_name: friendlyLabels ? label : id })),
          ], 'product')
          await json({ image: catalog.filter(model => model.kind === 'image'), video: catalog.filter(model => model.kind === 'video') })
        }
        else if (url.pathname === '/credits/api/creation/content') {
          const mode = { title: { zh: '' }, description: { zh: '' }, promptPlaceholder: { zh: '' }, categories: [], templates: [], presets: [] }
          await json({ schemaVersion: 1, revision: 'layout-qa', image: mode, video: mode })
        } else if (url.pathname === '/credits/api/assets' && request.method() === 'POST') {
          const name = decodeURIComponent(request.headers()['x-file-name'] ?? '')
          uploads.push(name)
          const assetId = `ma_layout${String(uploads.length)}`
          await route.fulfill({ status: 200, json: { ok: true, asset: { assetId, sizeBytes: image.bytes.length,
            contentType: image.mediaType, previewUrl: `/credits/api/assets/preview?asset_id=${assetId}` } } })
        } else if (url.pathname === '/credits/api/assets/preview') {
          await route.fulfill({ status: 200, contentType: image.mediaType, body: image.bytes })
        } else if (url.pathname === '/credits/api/usage') await json({ rows: [], asOf: new Date().toISOString(), delayMinutes: 0 })
        else if (request.method() !== 'GET' && request.method() !== 'HEAD') {
          paidRequests.push(`${request.method()} ${url.pathname}`); await route.abort('blockedbyclient')
        } else {
          unexpectedReads.push(url.pathname); await route.fulfill({ status: 404, json: { ok: false } })
        }
      })
      try {
        await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
        await page.getByRole('button', { name: 'AI 创作', exact: true }).click()
        const images = page.locator('#imagegen'), videos = page.locator('#videogen')
        await expect.poll(() => images.locator('input[type=file]').isEnabled()).toBe(true)
        await images.locator('input[type=file]').setInputFiles(['人物.png', '场景.png', '商品.png'].map(name => ({ name, mimeType: 'image/png', buffer: png })))
        await images.getByText('3/6', { exact: true }).waitFor()
        await images.getByRole('textbox', { name: '画面描述', exact: true }).fill('保持三张参考素材的视觉设定。\n'.repeat(45))
        for (const [theme, width] of [['dark', 1440], ['light', 900]] as const) {
          await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height: 1000 })
          geometry[`image-${theme}`] = await materialsAbovePrompt(images)
          await page.screenshot({ path: join(evidence, `image-${theme}.png`), animations: 'disabled' })
        }
        await images.getByRole('tab', { name: '视频', exact: true }).click()
        await expect.poll(() => videos.locator('input[type=file]').isEnabled()).toBe(true)
        await videos.getByRole('button', { name: '首尾帧', exact: true }).click()
        await videos.locator('input[type=file]').setInputFiles(['首.png', '尾.png', '候选.png'].map(name => ({ name, mimeType: 'image/png', buffer: png })))
        await videos.getByRole('combobox', { name: '首帧图', exact: true }).selectOption({ label: '首.png' })
        await videos.getByRole('combobox', { name: '尾帧图', exact: true }).selectOption({ label: '尾.png' })
        await videos.getByRole('textbox', { name: '画面描述', exact: true }).fill('从开场到收尾保持人物与构图连续。\n'.repeat(45))
        expect(await videos.locator('input[type=file]').count()).toBe(1)
        expect(await videos.getByRole('combobox', { name: '首帧图', exact: true }).count()).toBe(1)
        expect(await videos.getByRole('combobox', { name: '尾帧图', exact: true }).count()).toBe(1)
        for (const [theme, width] of [['dark', 1440], ['light', 900]] as const) {
          await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height: 1000 })
          geometry[`video-${theme}`] = await materialsAbovePrompt(videos)
          await page.screenshot({ path: join(evidence, `video-${theme}.png`), animations: 'disabled' })
        }
        await videos.getByRole('button', { name: '模型', exact: true }).click()
        await page.getByRole('menuitem', { name: 'lec-mj-seedance-2-5-cd-720p', exact: true }).click()
        expect(await videos.getByRole('button', { name: '首尾帧', exact: true }).count()).toBe(0)
        expect(await videos.getByRole('button', { name: '图生视频', exact: true }).count()).toBe(0)
        expect(await videos.getByRole('combobox', { name: '首帧图', exact: true }).count()).toBe(0)
        await videos.getByRole('button', { name: '参考素材', exact: true }).click()
        await videos.getByLabel('视频参数：画面尺寸 1280x720，时长 30 秒', { exact: true }).waitFor()
        const readsBeforeRename = catalogReads
        friendlyLabels = true
        await page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
        await expect.poll(() => catalogReads).toBeGreaterThan(readsBeforeRename)
        await expect.poll(() => videos.getByRole('button', { name: '模型', exact: true }).innerText()).toContain(videoLabels['lec-mj-seedance-2-5-cd-720p'])
        await videos.getByLabel('视频参数：画面尺寸 1280x720，时长 30 秒', { exact: true }).waitFor()
        await videos.getByRole('button', { name: '模型', exact: true }).click()
        for (const label of Object.values(videoLabels)) await page.getByRole('menuitem', { name: label, exact: true }).waitFor()
        const selected = page.getByRole('menuitem', { name: videoLabels['lec-mj-seedance-2-5-cd-720p'], exact: true })
        expect(await selected.locator('svg[class*="check"]').count()).toBe(1)
        await page.screenshot({ path: join(evidence, 'video-friendly-model-menu-first.png'), animations: 'disabled' })
        await page.getByRole('menuitem', { name: videoLabels['sd-20-903'], exact: true }).scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(evidence, 'video-friendly-model-menu-last.png'), animations: 'disabled' })
        await page.keyboard.press('Escape')
        await page.screenshot({ path: join(evidence, 'video-reference-only-pixel-size.png'), animations: 'disabled' })
        expect(uploads).toHaveLength(6)
        expect(paidRequests).toEqual([])
        expect(unexpectedReads).toEqual([])
        expect(tripwire.pageErrors).toEqual([])
        await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, geometry, uploads, paidRequests,
          unexpectedReads, pageErrors: tripwire.pageErrors, runtime: 'real built shipped Web composition',
          imageResolutionTiers: ['1k', '2k', '4k'], singleVideoUploadInput: true, blackrxDefaultDuration: 30, friendlyVideoLabels: videoLabels,
          labelOnlyRefreshPreservesSelectedId: 'lec-mj-seedance-2-5-cd-720p', catalogReads }, null, 2) + '\n')
        console.log(`Creation composer layout evidence: ${evidence}`)
      } catch (error) {
        await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined)
        await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), uploads, geometry,
          paidRequests, unexpectedReads, pageErrors: tripwire.pageErrors }, null, 2) + '\n')
        throw error
      }
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})
