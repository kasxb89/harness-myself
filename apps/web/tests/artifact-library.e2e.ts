/** The built artifact library discovers real generated output and currently mounted workspace files. */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-artifacts-index'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const overlay = fileURLToPath(new URL('./fixtures/artifact-library/cordis.patch.yml', import.meta.url))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

it('opens saved and mounted output in one library and refreshes files without a duplicate workspace browser', async () => {
  const evidenceRoot = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
  await mkdir(evidenceRoot, { recursive: true })
  const evidence = await mkdtemp(join(evidenceRoot, 'artifact-library-'))
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'yunshu-artifact-library-')))
  const cleanup: { scaffold?: () => Promise<void>; browser?: () => Promise<void> } = {}
  onTestFinished(async () => {
    try { await cleanup.browser?.() }
    finally {
      try { await cleanup.scaffold?.() }
      finally { await rm(outside, { recursive: true, force: true }) }
    }
  })
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
  cleanup.scaffold = () => scaffold.close()
  const browser = await chromium.launch()
  cleanup.browser = () => browser.close()
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 } })
  const consoleState = watchConsole(page)
  const signal = new AbortController().signal
  try {
    const firstPath = join(scaffold.workspaceCwd, '聊天工作区')
    const secondPath = join(outside, '挂载项目')
    const customPath = join(outside, '自选保存目录')
    await Promise.all([mkdir(firstPath), mkdir(secondPath), mkdir(customPath)])
    await scaffold.ctx.workspaceRegistry.create(firstPath, '聊天工作区')
    const mounted = await scaffold.ctx.workspaceRegistry.create(secondPath, '挂载项目')
    const nested = join(mounted.path, '输出', '分镜')
    await mkdir(nested, { recursive: true })
    const mountedFile = join(nested, '挂载目录剧本.md')
    await writeFile(mountedFile, '# 挂载目录的剧情\n\n这份剧情由聊天工具保存到另一个工作区的嵌套目录\n')
    await writeFile(join(firstPath, '聊天工作区说明.txt'), '聊天工作区内创建的文件\n')
    const original = await scaffold.ctx.artifactStorage.capture(signal)
    const deepParts = ['一层', '二层', '三层', '四层', '五层', '六层']
    const deepDirectory = join(original.directory, ...deepParts)
    await mkdir(deepDirectory, { recursive: true })
    const deepFile = join(deepDirectory, '深层产物.txt')
    await writeFile(deepFile, '超过首次扫描深度的真实产物\n')
    const originalImage = await scaffold.ctx.artifactStorage.write({ destination: original,
      filename: '保存前图片.png', bytes: png, signal })
    await scaffold.ctx.artifactStorage.write({ destination: original,
      filename: '聊天生成笔记.md', bytes: Buffer.from('# 聊天生成的笔记\n\n从实际产物保存服务写入\n'), signal })

    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '产物', exact: true }).click()
    const heading = page.getByRole('heading', { name: '产物库', exact: true })
    await heading.waitFor()
    const library = heading.locator('..').locator('..')
    const preview = library.getByRole('region', { name: '预览', exact: true })
    const search = library.getByRole('searchbox', { name: '搜索名称或路径' })
    expect(await library.getByRole('tablist').count()).toBe(0)
    expect(await library.getByRole('combobox').count()).toBe(0)
    for (const name of ['保存前图片.png', '聊天生成笔记.md', '聊天工作区说明.txt', '挂载目录剧本.md']) {
      await library.getByRole('button', { name: new RegExp(`^${name.replaceAll('.', '\\.')}`, 'u') }).waitFor()
    }
    expect(await library.getByRole('button', { name: /^深层产物\.txt/u }).count()).toBe(0)
    await library.getByRole('button', { name: '查找未列出的文件', exact: true }).click()
    const finder = page.getByRole('dialog', { name: '查找未列出的文件', exact: true })
    for (const part of deepParts) await finder.getByRole('button', { name: `打开文件夹 ${part}`, exact: true }).click()
    await finder.getByRole('button', { name: '深层产物.txt', exact: true }).click()
    await expect.poll(() => finder.count()).toBe(0)
    await expect.poll(() => preview.textContent()).toContain('超过首次扫描深度的真实产物')
    expect(await preview.getByText(deepFile, { exact: true }).isVisible()).toBe(false)
    const focusedListing = page.waitForResponse(response => new URL(response.url()).pathname === '/artifacts/api/list')
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
    expect((await focusedListing).status()).toBe(200)
    await expect.poll(() => preview.textContent()).toContain('超过首次扫描深度的真实产物')
    expect(await library.getByRole('button', { name: /^深层产物\.txt/u }).count()).toBe(1)
    await page.screenshot({ path: join(evidence, 'deep-output.png'), animations: 'disabled' })

    await library.getByRole('button', { name: /^保存前图片\.png/u }).click()
    const image = preview.getByRole('img', { name: '保存前图片.png', exact: true })
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true)
    const filePath = preview.getByText(originalImage.path, { exact: true })
    expect(await filePath.isVisible()).toBe(false)
    await preview.getByText('文件位置', { exact: true }).click()
    expect(await filePath.isVisible()).toBe(true)
    await preview.getByText('文件位置', { exact: true }).click()
    expect(await filePath.isVisible()).toBe(false)

    await search.fill('挂载目录剧本')
    expect(await library.getByRole('button', { name: /^保存前图片\.png/u }).count()).toBe(0)
    const textResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === '/artifacts/api/raw' && url.searchParams.get('path') === mountedFile
        && url.searchParams.get('workspaceId') === mounted.id
    })
    await library.getByRole('button', { name: /^挂载目录剧本\.md/u }).click()
    expect((await textResponse).status()).toBe(200)
    await preview.getByRole('heading', { name: '挂载目录的剧情', exact: true }).waitFor()
    await page.screenshot({ path: join(evidence, 'mounted-output.png'), animations: 'disabled' })
    await search.fill('')

    await library.getByRole('button', { name: '保存目录', exact: true }).click()
    const storage = page.getByRole('dialog', { name: '保存目录', exact: true })
    await storage.getByRole('textbox', { name: '完整目录路径', exact: true }).fill(customPath)
    await storage.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => storage.count()).toBe(0)
    const custom = await scaffold.ctx.artifactStorage.capture(signal)
    expect(custom.directory).toBe(await realpath(customPath))
    await scaffold.ctx.artifactStorage.write({ destination: custom, filename: '保存后图片.png', bytes: png, signal })
    await library.getByRole('button', { name: '刷新', exact: true }).click()
    await library.getByRole('button', { name: /^保存后图片\.png/u }).waitFor()
    expect(await library.getByRole('button', { name: /^保存前图片\.png/u }).count()).toBe(1)
    await library.getByRole('button', { name: /^保存后图片\.png/u }).click()
    await expect.poll(() => preview.getByRole('img', { name: '保存后图片.png', exact: true })
      .evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true)

    const background = await browser.newPage()
    await background.goto('about:blank')
    await background.bringToFront()
    await scaffold.ctx.artifactStorage.write({ destination: custom,
      filename: '返回后新产物.txt', bytes: Buffer.from('返回产物库时自动发现这个文件\n'), signal })
    await page.bringToFront()
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
    await library.getByRole('button', { name: /^返回后新产物\.txt/u }).waitFor()
    await background.close()
    await scaffold.ctx.workspaceRegistry.delete(mounted.id)
    await library.getByRole('button', { name: '刷新', exact: true }).click()
    await expect.poll(() => library.getByRole('button', { name: /^挂载目录剧本\.md/u }).count()).toBe(0)
    expect(await library.getByRole('button', { name: /^聊天工作区说明\.txt/u }).count()).toBe(1)
    expect(await library.getByRole('button', { name: /^保存前图片\.png/u }).count()).toBe(1)
    expect(await library.getByRole('button', { name: /^保存后图片\.png/u }).count()).toBe(1)
    expect(await library.getByRole('tablist').count()).toBe(0)
    expect(consoleState.pageErrors).toEqual([])
    await page.screenshot({ path: join(evidence, 'unified-library.png'), animations: 'disabled' })
    console.info(`Artifact library browser evidence: ${evidence}`)
  } catch (error) {
    await saveFailureShot(page, `${basename(evidence)}/failure`)
    throw error
  }
})
