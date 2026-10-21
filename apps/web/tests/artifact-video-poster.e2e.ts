/** Real decoded first frames for existing library videos and mounted workspace outputs. */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-artifacts-index'
import { chromium, type Locator } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const runtimeRoot = process.env.DSH_VIDEO_TEST_RUNTIME_ROOT
const ffmpeg = runtimeRoot === undefined ? undefined : join(runtimeRoot, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const overlay = fileURLToPath(new URL('./fixtures/artifact-library/cordis.patch.yml', import.meta.url))
// Covers the configured 15-second decode deadline plus the short local queue.
const posterBudget = { timeout: 20_000 }

/** Produce distinguishable first and later frames through the installed test encoder. */
async function encodeVideo(directory: string, firstColor: 'red' | 'lime', name: string): Promise<Buffer> {
  if (ffmpeg === undefined) throw new Error('DSH_VIDEO_TEST_RUNTIME_ROOT must identify the prepared video runtime')
  const path = join(directory, name)
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
    '-f', 'lavfi', '-i', `color=c=${firstColor}:s=320x180:r=12:d=0.5`,
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=12:d=0.5',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path], { timeout: 30_000 })
  return readFile(path)
}

/** Read an actual decoded center pixel, rather than accepting the presence of an img element. */
async function pixel(image: Locator): Promise<readonly number[]> {
  return image.evaluate((node: HTMLImageElement) => {
    const canvas = document.createElement('canvas')
    canvas.width = 1; canvas.height = 1
    const context = canvas.getContext('2d')
    if (context === null || !node.complete || node.naturalWidth === 0) return []
    context.drawImage(node, 0, 0, 1, 1)
    return Array.from(context.getImageData(0, 0, 1, 1).data)
  })
}

it.skipIf(ffmpeg === undefined || !existsSync(ffmpeg))(
  'shows real first-frame covers for old and mounted videos without autoplay, and refreshes replaced files', async () => {
    const evidenceRoot = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
    await mkdir(evidenceRoot, { recursive: true })
    const evidence = await mkdtemp(join(evidenceRoot, 'artifact-video-posters-'))
    const cleanup: { scaffold?: () => Promise<void>; browser?: () => Promise<void> } = {}
    onTestFinished(async () => { try { await cleanup.browser?.() } finally { await cleanup.scaffold?.() } })
    const scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    cleanup.scaffold = () => scaffold.close()
    const destination = await scaffold.ctx.artifactStorage.capture(new AbortController().signal)
    const red = await encodeVideo(evidence, 'red', 'first-red-then-blue.mp4')
    const green = await encodeVideo(evidence, 'lime', 'first-green-then-blue.mp4')
    const existingPath = join(destination.directory, '已有视频.mp4')
    // These older files have no generated-output metadata or separate poster image.
    await writeFile(existingPath, red)
    await writeFile(join(destination.directory, '损坏视频.mp4'), 'This is not an encoded video')
    const workspacePath = join(scaffold.workspaceCwd, '挂载视频')
    await mkdir(workspacePath)
    await scaffold.ctx.workspaceRegistry.create(workspacePath, '挂载视频')
    const mountedPath = join(workspacePath, '挂载成片.mp4')
    await writeFile(mountedPath, green)

    const browser = await chromium.launch()
    cleanup.browser = () => browser.close()
    const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 } })
    const tripwire = watchConsole(page)
    try {
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: '产物', exact: true }).click()
      const heading = page.getByRole('heading', { name: '产物库', exact: true })
      await heading.waitFor()
      const library = heading.locator('..').locator('..')
      const preview = library.getByRole('region', { name: '预览', exact: true })
      const oldRow = library.getByRole('button', { name: /^已有视频\.mp4/u })
      const oldPoster = oldRow.locator('[data-video-poster]')
      const mountedRow = library.getByRole('button', { name: /^挂载成片\.mp4/u })
      const mountedPoster = mountedRow.locator('[data-video-poster]')
      await expect.poll(() => oldPoster.getAttribute('data-video-poster'), posterBudget).toBe('ready')
      await expect.poll(() => mountedPoster.getAttribute('data-video-poster'), posterBudget).toBe('ready')
      const oldImage = oldPoster.locator('img')
      await expect.poll(async () => {
        const color = await pixel(oldImage)
        return (color[0] ?? 0) > 180 && (color[2] ?? 255) < 80
      }, posterBudget).toBe(true)
      await expect.poll(async () => {
        const color = await pixel(mountedPoster.locator('img'))
        return (color[1] ?? 0) > 180 && (color[2] ?? 255) < 80
      }, posterBudget).toBe(true)
      await oldRow.click()
      const video = preview.locator('video[data-artifact-video-preview]')
      await expect.poll(() => video.getAttribute('poster')).toBe(await oldImage.getAttribute('src'))
      expect(await video.evaluate((node: HTMLVideoElement) => node.paused && node.currentTime === 0)).toBe(true)
      await page.screenshot({ path: join(evidence, 'first-frame-covers.png'), animations: 'disabled' })

      const broken = library.getByRole('button', { name: /^损坏视频\.mp4/u })
      await expect.poll(() => broken.locator('[data-video-poster]').getAttribute('data-video-poster'), posterBudget).toBe('failed')
      expect(await broken.locator('img').count()).toBe(0)
      await broken.click()
      await preview.getByRole('link', { name: '下载原文件', exact: true }).waitFor()

      await writeFile(existingPath, green)
      await library.getByRole('button', { name: '刷新', exact: true }).click()
      await oldRow.click()
      await expect.poll(() => oldPoster.getAttribute('data-video-poster'), posterBudget).toBe('ready')
      await expect.poll(async () => {
        const color = await pixel(oldImage)
        return (color[1] ?? 0) > 180 && (color[0] ?? 255) < 80
      }, posterBudget).toBe(true)
      await expect.poll(() => preview.locator('video').getAttribute('poster')).toBe(await oldImage.getAttribute('src'))
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.screenshot({ path: join(evidence, 'replaced-video-cover-dark.png'), animations: 'disabled' })
      expect(tripwire.pageErrors).toEqual([])
      await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, realFirstFrameDecoded: true,
        olderFileWithoutPosterMetadata: true, mountedWorkspace: true, replacedFileInvalidatesCover: true,
        autoplay: false, paidGenerationRequests: 0, pageErrors: tripwire.pageErrors }, null, 2) + '\n')
      console.info(`Artifact video poster evidence: ${evidence}`)
    } catch (error) {
      await page.screenshot({ path: join(evidence, 'failure.png'), animations: 'disabled' }).catch((captureError: unknown) => {
        console.warn('Artifact poster failure screenshot unavailable', captureError)
      })
      throw error
    }
  },
)
