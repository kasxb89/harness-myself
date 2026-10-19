/** Built image creation decodes mixed reference formats and retains per-file batch failures. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { normalizeReferenceImage, ReferenceImageError } from '../../../packages/host/credits-index/src/reference-image.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, connectFreshWorkspaceZh } from './support.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
// Two locally encoded solid-color frames, matching the host decoder regression fixture.
const gif = Buffer.from('R0lGODlhBAADAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAABAADAAAICAABCBxIUGBAACH5BAEKAAEALAAAAAAEAAMAgQD/AAAAAAAAAAAAAAgIAAEIHEhQYEAAOw==', 'base64')

/** Read actual browser-decoded image dimensions, layout and pixel colors. */
async function decodedReferences(panel: Locator): Promise<{
  name: string
  width: number
  height: number
  left: number
  top: number
  right: number
  bottom: number
  color: number[]
}[]> {
  const images = panel.getByRole('list').filter({ has: panel.page().locator('img') }).locator('img')
  await expect.poll(() => images.evaluateAll(elements => elements.length === 3 && elements.every(element =>
    element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)), { timeout: 15_000 }).toBe(true)
  return images.evaluateAll(elements => elements.map((element) => {
    if (!(element instanceof HTMLImageElement)) throw new Error('Expected a reference image')
    const canvas = document.createElement('canvas')
    canvas.width = 1; canvas.height = 1
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('Canvas pixels unavailable')
    context.drawImage(element, 0, 0, 1, 1)
    const rectangle = element.getBoundingClientRect()
    return { name: element.alt, width: element.naturalWidth, height: element.naturalHeight,
      left: rectangle.left, top: rectangle.top, right: rectangle.right, bottom: rectangle.bottom,
      color: [...context.getImageData(0, 0, 1, 1).data] }
  }))
}

/** Reject overlapping thumbnail rectangles rather than counting three hidden images. */
function expectSeparate(images: Awaited<ReturnType<typeof decodedReferences>>): void {
  for (let left = 0; left < images.length; left += 1) {
    for (let right = left + 1; right < images.length; right += 1) {
      const first = images[left]!, second = images[right]!
      expect(first.right <= second.left || second.right <= first.left
        || first.bottom <= second.top || second.bottom <= first.top).toBe(true)
    }
  }
  expect(new Set(images.map(image => JSON.stringify(image.color)))).toHaveProperty('size', 3)
}

/** Reveal the real registered image creation panel from its sidebar entry. */
async function openImages(page: Page, label: string): Promise<Locator> {
  await page.getByRole('button', { name: label, exact: true }).click()
  const panel = page.locator('#imagegen')
  await panel.waitFor({ state: 'visible' })
  return panel
}

describe('web e2e: mixed reference image uploads', () => {
  it.each(['zh-CN', 'en-US'])('decodes three references and explains the failed fourth file in %s', async (locale) => {
    const scaffold = await launchWebScaffold({})
    try {
      const browser = await chromium.launch()
      try {
        const zh = locale === 'zh-CN'
        const page = await browser.newPage({ locale, viewport: { width: zh ? 1440 : 900, height: 1000 },
          colorScheme: zh ? 'dark' : 'light', reducedMotion: 'reduce' })
        page.setDefaultTimeout(15_000)
        const tripwire = watchConsole(page)
        const evidenceRoot = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
        await mkdir(evidenceRoot, { recursive: true })
        const evidence = await mkdtemp(join(evidenceRoot, `image-reference-upload-${locale}-`))
        const heic = await readFile(new URL('../../../packages/host/credits-index/tests/fixtures/reference-normalization.heic', import.meta.url))
        const normalized = new Map<string, Awaited<ReturnType<typeof normalizeReferenceImage>>>()
        const uploads: { name: string; type: string; code?: string; assetId?: string; hash?: string }[] = []
        const previews: string[] = []
        const unexpectedReads: string[] = []
        const paidRequests: string[] = []
        const generationAttempts: string[] = []
        const labels = zh ? { create: 'AI 创作', remove: '清空参考图', upload: '添加素材', summary: '本次已添加 3 张，失败 1 张',
          failures: '未添加的图片及原因', decode: '图片损坏或无法解码，请重新导出后上传', converted: '其中 2 张已自动转换为模型支持的格式',
          firstFrame: '其中 1 张动态图片使用首帧作为参考图', oneAdded: '本次已添加 1 张，失败 0 张' }
          : { create: 'Create', remove: 'Clear references', upload: 'Add materials', summary: 'Added 3 images; 1 failed',
            failures: 'Images not added and reasons', decode: 'This image is damaged or cannot be decoded. Export it again and retry.',
            converted: '2 images were converted to a model-supported format', firstFrame: '1 animated images use their first frame as the reference',
            oneAdded: 'Added 1 images; 0 failed' }
        await page.route('**/credits/api/**', async (route) => {
          const request = route.request()
          const url = new URL(request.url())
          const json = async (payload: object): Promise<void> => route.fulfill({ status: 200, json: { ok: true, payload } })
          if (url.pathname === '/credits/api/session' && request.method() === 'GET') {
            await json({ signedIn: true, creditsPerYuan: 1000, account: { id: 'image-upload-qa' } })
          } else if (url.pathname === '/credits/api/summary') {
            await json({ balance_points: 10000, as_of: new Date().toISOString() })
          } else if (url.pathname === '/credits/api/media/catalog') {
            await json({ image: [{ id: 'gpt-image-2', displayName: 'Reference upload QA', params: {
              sizes: ['1024x1024'], maxCount: 1, maxEdits: 6, qualities: [], backgrounds: [], formats: ['png'], moderations: [], seed: false,
            } }], video: [] })
          } else if (url.pathname === '/credits/api/creation/content') {
            const mode = { title: { zh: '', en: '' }, description: { zh: '', en: '' }, promptPlaceholder: { zh: '', en: '' },
              categories: [], templates: [], presets: [] }
            await json({ schemaVersion: 1, revision: 'reference-upload-qa', image: mode, video: mode })
          } else if (url.pathname === '/credits/api/creative/projects') {
            await json({ accountId: 'image-upload-qa', projects: [] })
          } else if (url.pathname === '/credits/api/assets' && request.method() === 'POST') {
            const name = decodeURIComponent(request.headers()['x-file-name'] ?? '')
            const upload: typeof uploads[number] = { name, type: request.headers()['content-type'] ?? '' }
            uploads.push(upload)
            try {
              const result = await normalizeReferenceImage(request.postDataBuffer() ?? Buffer.alloc(0), name)
              const assetId = `ma_qa${String(uploads.length)}`
              normalized.set(assetId, result)
              upload.assetId = assetId
              upload.hash = createHash('sha256').update(result.bytes).digest('hex')
              await route.fulfill({ status: 200, json: { ok: true, asset: { assetId, originalName: result.originalName,
                contentType: result.mediaType, sizeBytes: result.bytes.length, converted: result.converted,
                sourceFormat: result.sourceFormat, firstFrameOnly: result.firstFrameOnly,
                previewUrl: `/credits/api/assets/preview?asset_id=${assetId}` } } })
            } catch (error) {
              if (!(error instanceof ReferenceImageError)) throw error
              upload.code = error.code
              await route.fulfill({ status: 400, json: { ok: false, code: error.code, filename: name } })
            }
          } else if (url.pathname === '/credits/api/assets/preview' && request.method() === 'GET') {
            const assetId = url.searchParams.get('asset_id') ?? ''
            const image = normalized.get(assetId)
            previews.push(assetId)
            if (image === undefined) { await route.fulfill({ status: 404 }); return }
            await route.fulfill({ status: 200, contentType: image.mediaType, body: image.bytes })
          } else if (url.pathname === '/credits/api/usage') {
            await json({ rows: [], start: Number(url.searchParams.get('start')), end: Number(url.searchParams.get('end')),
              asOf: new Date().toISOString(), delayMinutes: 0 })
          } else if (url.pathname === '/credits/api/image/generate' && request.method() === 'POST') {
            generationAttempts.push(request.postData() ?? '')
            const code = ['INVALID_REQUEST', 'TIMEOUT', 'NO_TASK_ID'][generationAttempts.length - 1] ?? 'UNEXPECTED_GENERATION'
            await route.fulfill({ status: 200, json: { ok: false, code,
              message: '400 reasoning_content private-request-id C:/private/upstream.ts:10' } })
          } else if (request.method() !== 'GET' && request.method() !== 'HEAD') {
            paidRequests.push(`${request.method()} ${url.pathname}`)
            await route.abort('blockedbyclient')
          } else {
            unexpectedReads.push(`${request.method()} ${url.pathname}`)
            await route.fulfill({ status: 404, json: { ok: false, code: 'UNEXPECTED_FIXTURE_READ' } })
          }
        })
        try {
          await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          await page.waitForSelector('[class*="frame"]')
          if (zh) await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
          else await connectFreshWorkspace(page, scaffold.workspaceCwd)
          const panel = await openImages(page, labels.create)
          const input = panel.locator('input[type="file"]')
          await expect.poll(() => input.isEnabled()).toBe(true)
          await input.setInputFiles([
            { name: '妈妈参考.jfif', mimeType: 'application/octet-stream', buffer: png },
            { name: '损坏图片.png', mimeType: 'image/png', buffer: png.subarray(0, 36) },
            { name: '孩子参考.HEIC', mimeType: 'application/octet-stream', buffer: heic },
            { name: '步骤参考.gif', mimeType: 'image/gif', buffer: gif },
          ])
          await panel.getByText(labels.summary, { exact: true }).waitFor()
          await panel.getByText('3/6', { exact: true }).waitFor()
          const images = await decodedReferences(panel)
          expect(images.map(image => image.name)).toEqual(['妈妈参考.jfif', '孩子参考.HEIC', '步骤参考.gif'])
          expect(images.map(image => [image.width, image.height])).toEqual([[1, 1], [64, 32], [4, 3]])
          expectSeparate(images)
          const failures = panel.getByRole('list', { name: labels.failures, exact: true })
          expect(await failures.innerText()).toContain('损坏图片.png')
          expect(await failures.innerText()).toContain(labels.decode)
          await panel.getByText(labels.converted, { exact: true }).waitFor()
          await panel.getByText(labels.firstFrame, { exact: true }).waitFor()
          expect(uploads).toHaveLength(4)
          expect(uploads[1]).toMatchObject({ name: '损坏图片.png', code: 'IMAGE_DECODE_FAILED' })
          expect(uploads[2]?.type).toBe('application/octet-stream')
          expect(previews).toEqual(['ma_qa1', 'ma_qa3', 'ma_qa4'])
          await page.screenshot({ path: join(evidence, 'mixed-batch-three-decoded-references.png'), animations: 'disabled' })

          await panel.getByRole('button', { name: labels.remove, exact: true }).click()
          await expect.poll(() => failures.count()).toBe(0)
          const start = uploads.length
          for (const [index, bytes] of [png, heic, gif].entries()) {
            await input.setInputFiles({ name: '同名图片.jpg', mimeType: 'application/octet-stream', buffer: bytes })
            await panel.getByText(labels.oneAdded, { exact: true }).waitFor()
            await expect.poll(() => uploads.length).toBe(start + index + 1)
            await panel.getByText(`${String(index + 1)}/6`, { exact: true }).waitFor()
          }
          const sameNames = await decodedReferences(panel)
          expect(sameNames.every(image => image.name === '同名图片.jpg')).toBe(true)
          expectSeparate(sameNames)
          expect(new Set(uploads.slice(start).map(upload => upload.assetId))).toHaveProperty('size', 3)
          expect(new Set(uploads.slice(start).map(upload => upload.hash))).toHaveProperty('size', 3)
          expect(paidRequests).toEqual([])
          expect(unexpectedReads).toEqual([])
          expect(tripwire.pageErrors).toEqual([])
          expect(tripwire.warnings).toEqual([])
          await page.screenshot({ path: join(evidence, 'sequential-same-filename-three-decoded-references.png'), animations: 'disabled' })

          const prompt = '为妈妈和孩子制作绘本展示图'
          await panel.getByRole('textbox', { name: zh ? '画面描述' : 'Prompt', exact: true }).fill(prompt)
          await panel.getByRole('button', { name: zh ? '生成图片' : 'Generate image', exact: true }).click()
          const busy = zh ? '服务器繁忙，请稍后重试' : 'The server is busy. Please try again later.'
          await panel.getByRole('alert').filter({ hasText: busy }).waitFor()
          const visible = await panel.innerText()
          for (const diagnostic of ['reasoning_content', 'INVALID_REQUEST', 'private-request-id', 'C:/private', '400']) {
            expect(visible).not.toContain(diagnostic)
          }
          expect(generationAttempts).toHaveLength(1)
          expect(await panel.getByRole('textbox', { name: zh ? '画面描述' : 'Prompt', exact: true }).inputValue()).toBe(prompt)
          expect((await decodedReferences(panel)).map(image => image.name)).toEqual(['同名图片.jpg', '同名图片.jpg', '同名图片.jpg'])
          expect(paidRequests).toEqual([])
          expect(unexpectedReads).toEqual([])
          expect(tripwire.pageErrors).toEqual([])
          await page.screenshot({ path: join(evidence, 'safe-generation-failure.png'), animations: 'disabled' })
          const unknown = zh ? '生成连接中断，结果可能仍在处理中。请先刷新作品，确认后再提交'
            : 'The connection was interrupted. Generation may still be processing. Refresh your works before submitting again.'
          for (const attempt of [2, 3]) {
            await panel.getByRole('button', { name: zh ? '生成图片' : 'Generate image', exact: true }).click()
            await expect.poll(() => generationAttempts.length).toBe(attempt)
            await panel.getByRole('alert').filter({ hasText: unknown }).waitFor()
            expect(await panel.getByRole('alert').innerText()).toBe(unknown)
            expect(await panel.innerText()).not.toContain('private-request-id')
          }
          expect(paidRequests).toEqual([])
          expect(tripwire.pageErrors).toEqual([])
          expect(await decodedReferences(panel)).toHaveLength(3)
          expect(await panel.getByRole('textbox', { name: zh ? '画面描述' : 'Prompt', exact: true }).inputValue()).toBe(prompt)
          await page.screenshot({ path: join(evidence, 'unknown-generation-outcome.png'), animations: 'disabled' })
          await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, locale, uploads, previews,
            decodedMixedBatch: images, decodedSameFilename: sameNames, paidRequests, unexpectedReads,
            safeGenerationFailure: { attempts: generationAttempts.length, rawDiagnosticVisible: false, retainedReferences: 3,
              unknownOutcomeCodes: ['TIMEOUT', 'NO_TASK_ID'] },
            pageErrors: tripwire.pageErrors, warnings: tripwire.warnings,
            host: 'real built shipped Web composition', upload: 'route calls actual current host image decoder; previews serve its real output bytes',
            upstreamGeneration: false, persistedAssetAuth: 'covered by host Loader integration tests' }, null, 2) + '\n')
          console.log(`Image reference upload evidence: ${evidence}`)
        } catch (error) {
          await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined)
          await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), uploads, previews, paidRequests,
            unexpectedReads, pageErrors: tripwire.pageErrors, warnings: tripwire.warnings }, null, 2) + '\n')
          throw error
        }
      } finally { await browser.close() }
    } finally { await scaffold.close() }
  })
})
