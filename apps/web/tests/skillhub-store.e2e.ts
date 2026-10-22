/** The built store keeps long community entries bounded in the real Web composition. */
import { mkdtemp, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename, join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const overlay = fileURLToPath(new URL('./fixtures/skillhub-store/cordis.patch.yml', import.meta.url))

it('bounds long skill cards and scrolls complete details in light, dark and narrow layouts', async () => {
  const artifactRoot = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
  await mkdir(artifactRoot, { recursive: true })
  const evidence = await mkdtemp(join(artifactRoot, 'skillhub-store-'))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 } })
  const consoleState = watchConsole(page)
  const longName = 'StoryboardAndLongVideoMaterialDirector'.repeat(12)
  const description = `${'编排镜头、人物、素材与对白，生成完整剧情和分镜。\n'.repeat(80)}完整说明结束。`
  const skills = Array.from({ length: 60 }, (_, index) => ({
    slug: `@community/skill-${String(index)}-${'long-identifier-'.repeat(8)}`,
    name: index === 0 ? longName : `创作技能 ${String(index + 1)}`,
    description: index === 0 ? description : '用于日常创作的社区技能。',
    version: '1.0.0', source: 'SkillHub 社区',
  }))
  await page.route('**/api/skillhub/recommendations', route => route.fulfill({ json: { ok: true, skills } }))
  await page.route('**/api/skillhub/installed', route => route.fulfill({ json: { ok: true, skills: [] } }))
  let installations = 0
  await page.route('**/api/skillhub/install', async (route) => {
    installations += 1
    await route.abort()
  })
  try {
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '技能商店', exact: true }).click()
    const store = page.getByRole('region', { name: '技能商店', exact: true })
    const discover = store.getByRole('tabpanel', { name: '发现技能', exact: true })
    await discover.getByRole('heading', { name: longName, exact: true }).waitFor()
    expect(await store.getByText('20万社区技能', { exact: false }).count()).toBe(1)
    expect(await discover.getByText('当前列表 60 个技能', { exact: true }).count()).toBe(1)
    expect(await discover.getByRole('listitem').count()).toBe(24)
    for (const layout of [
      { width: 1440, dark: false, name: 'wide-light' },
      { width: 1440, dark: true, name: 'wide-dark' },
      { width: 920, dark: true, name: 'narrow-dark' },
    ]) {
      await page.setViewportSize({ width: layout.width, height: 1000 })
      await page.evaluate((dark) => { document.body.toggleAttribute('data-ds-dark-theme', dark) }, layout.dark)
      const geometry = await discover.getByRole('listitem').evaluateAll(nodes => nodes.map((node) => {
        const box = node.getBoundingClientRect()
        const buttons = [...node.querySelectorAll('button')]
        const footer = buttons.at(-1)?.getBoundingClientRect()
        return { width: box.width, height: box.height, footerBottom: footer?.bottom, bottom: box.bottom,
          hasIcon: node.querySelector('svg') !== null, scroll: node.scrollWidth, client: node.clientWidth }
      }))
      expect(geometry.every(card => card.height <= 280 && card.height >= 220 && card.hasIcon)).toBe(true)
      expect(Math.max(...geometry.map(card => card.height)) - Math.min(...geometry.map(card => card.height))).toBeLessThan(1)
      expect(geometry.every(card => card.scroll <= card.client
        && card.footerBottom !== undefined && card.footerBottom < card.bottom)).toBe(true)
      await page.screenshot({ path: join(evidence, `${layout.name}.png`), animations: 'disabled' })
    }

    const details = discover.getByRole('button', { name: '查看详情', exact: true }).first()
    await details.click()
    const dialog = page.getByRole('dialog', { name: '技能详情', exact: true })
    await dialog.waitFor()
    expect(await dialog.getByRole('heading', { name: longName, exact: true }).count()).toBe(1)
    expect(await dialog.getByText(description, { exact: true }).count()).toBe(1)
    const box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeLessThanOrEqual(952)
    expect(box!.width).toBeLessThanOrEqual(600)
    const close = await dialog.getByRole('button', { name: '关闭技能详情', exact: true }).boundingBox()
    expect(close).not.toBeNull()
    expect(close!.x + close!.width).toBeLessThanOrEqual(920)
    await page.screenshot({ path: join(evidence, 'details-narrow.png'), animations: 'disabled' })
    expect(await dialog.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
    const descriptionParagraph = dialog.getByText(description, { exact: true })
    await descriptionParagraph.evaluate((node) => {
      let scroller = node.parentElement
      while (scroller !== null && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement
      if (scroller === null) throw new Error('Skill details have no scroll owner')
      scroller.scrollTop = scroller.scrollHeight
    })
    expect(await descriptionParagraph.evaluate((node) => {
      const bounds = node.getBoundingClientRect()
      return bounds.bottom <= window.innerHeight && bounds.bottom > 0
    })).toBe(true)
    await page.screenshot({ path: join(evidence, 'details-scrolled.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0)
    expect(await details.evaluate(node => node === document.activeElement)).toBe(true)
    await discover.getByRole('button', { name: '下一页', exact: true }).click()
    expect(await discover.getByRole('listitem').count()).toBe(24)
    expect(await discover.getByRole('heading', { name: longName, exact: true }).count()).toBe(0)
    expect(installations).toBe(0)
    expect(consoleState.pageErrors).toEqual([])
    console.info(`SkillHub visual evidence: ${evidence}`)
  } catch (error) {
    // Preserve failure evidence while this test still owns the live page.
    await saveFailureShot(page, `${basename(evidence)}/failure`)
    throw error
  }
})
