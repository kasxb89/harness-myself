/** Built skill-store and employee pages preserve their native actions across responsive layouts. */
import { mkdtemp, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename, join } from 'node:path'
import { chromium, type Locator } from 'playwright'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const overlay = fileURLToPath(new URL('./fixtures/skillhub-store/cordis.patch.yml', import.meta.url))

/** Assert adaptive grid rows, contained controls and unclipped horizontal content. */
async function assertCardsFit(cards: Locator): Promise<void> {
  const geometry = await cards.evaluateAll(nodes => nodes.map((node) => {
    const box = node.getBoundingClientRect()
    return {
      top: box.top, height: box.height, scroll: node.scrollWidth, client: node.clientWidth,
      controls: [...node.querySelectorAll('button')].map((button) => {
        const control = button.getBoundingClientRect()
        return control.left >= box.left - 1 && control.right <= box.right + 1
          && control.top >= box.top - 1 && control.bottom <= box.bottom + 1
      }),
    }
  }))
  expect(geometry.length).toBeGreaterThan(0)
  expect(geometry.every(card => card.height > 0 && card.scroll <= card.client + 1
    && card.controls.length > 0 && card.controls.every(Boolean))).toBe(true)
  const rows = new Map<number, number[]>()
  for (const card of geometry) {
    const top = Math.round(card.top)
    rows.set(top, [...(rows.get(top) ?? []), card.height])
  }
  for (const heights of rows.values()) {
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1)
  }
}

/** Wait for the bundled illustration to decode, rather than accepting an unpainted image element. */
async function assertEmbeddedArtwork(image: Locator): Promise<void> {
  await expect.poll(() => image.evaluate(node => node instanceof HTMLImageElement
    && node.currentSrc.startsWith('data:image/png;base64,') && node.complete
    && node.naturalWidth > 0 && node.naturalHeight > 0)).toBe(true)
}

it('keeps adaptive skill cards, independent installation and complete details in light, dark and narrow layouts', async () => {
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
  const installResponse = Promise.withResolvers<undefined>()
  await page.route('**/api/skillhub/install', async (route) => {
    installations += 1
    await installResponse.promise
    await route.fulfill({ json: { ok: false, code: 'install-failed' } })
  })
  try {
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '技能商店', exact: true }).click()
    const store = page.getByRole('region', { name: '技能商店', exact: true })
    const discover = store.getByRole('tabpanel', { name: '发现技能', exact: true })
    await discover.getByRole('heading', { name: longName, exact: true }).waitFor()
    await assertEmbeddedArtwork(store.locator('header img'))
    expect(await store.getByText('20万社区技能', { exact: false }).count()).toBe(1)
    expect(await discover.getByText('当前列表 60 个技能', { exact: true }).count()).toBe(1)
    expect(await discover.getByRole('listitem').count()).toBe(24)
    for (const layout of [
      { width: 1440, dark: false, name: 'wide-light' },
      { width: 1440, dark: true, name: 'wide-dark' },
      { width: 920, dark: true, name: 'narrow-dark' },
      { width: 620, dark: false, name: 'compact-light' },
      { width: 620, dark: true, name: 'compact-dark' },
    ]) {
      await page.setViewportSize({ width: layout.width, height: 1000 })
      await page.evaluate((dark) => { document.body.toggleAttribute('data-ds-dark-theme', dark) }, layout.dark)
      await assertCardsFit(discover.getByRole('listitem'))
      expect(await store.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
      await page.screenshot({ path: join(evidence, `${layout.name}.png`), animations: 'disabled' })
    }

    const details = discover.getByRole('button', { name: '查看详情', exact: true }).first()
    await details.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: '技能详情', exact: true })
    await dialog.waitFor()
    expect(await dialog.getByRole('heading', { name: longName, exact: true }).count()).toBe(1)
    expect(await dialog.getByText(description, { exact: true }).count()).toBe(1)
    const box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y + box!.height).toBeLessThanOrEqual(1000)
    expect(box!.width).toBeLessThanOrEqual(600)
    const close = await dialog.getByRole('button', { name: '关闭技能详情', exact: true }).boundingBox()
    expect(close).not.toBeNull()
    expect(close!.x).toBeGreaterThanOrEqual(0)
    expect(close!.x + close!.width).toBeLessThanOrEqual(620)
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

    const firstCard = discover.getByRole('listitem').first()
    const beforeError = (await firstCard.boundingBox())!.height
    const install = firstCard.getByRole('button', { name: '安装', exact: true })
    await install.click()
    await expect.poll(() => installations).toBe(1)
    expect(await page.getByRole('dialog', { name: '技能详情', exact: true }).count()).toBe(0)
    const pending = firstCard.getByRole('button', { name: '安装中…', exact: true })
    expect(await pending.isDisabled()).toBe(true)
    await pending.dispatchEvent('click')
    expect(installations).toBe(1)
    installResponse.resolve(undefined)
    const installError = firstCard.getByRole('alert')
    await installError.waitFor()
    expect(await installError.textContent()).toBe('安装失败，请重试')
    expect(await firstCard.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(beforeError)
    expect(await installError.evaluate((node) => {
      const style = getComputedStyle(node)
      return !['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY)
        && node.scrollHeight <= node.clientHeight + 1
    })).toBe(true)
    await assertCardsFit(discover.getByRole('listitem'))
    await page.screenshot({ path: join(evidence, 'install-error-compact.png'), animations: 'disabled' })

    await firstCard.click({ position: { x: 20, y: 20 } })
    await dialog.waitFor()
    expect(await dialog.getByRole('heading', { name: longName, exact: true }).count()).toBe(1)
    expect(installations).toBe(1)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    await discover.getByRole('button', { name: '下一页', exact: true }).click()
    expect(await discover.getByRole('listitem').count()).toBe(24)
    expect(await discover.getByRole('heading', { name: longName, exact: true }).count()).toBe(0)
    expect(installations).toBe(1)
    expect(consoleState.pageErrors).toEqual([])
    expect(consoleState.warnings).toEqual([])
    console.info(`SkillHub visual evidence: ${evidence}`)
  } catch (error) {
    // Preserve failure evidence while this test still owns the live page.
    await saveFailureShot(page, `${basename(evidence)}/failure`)
    throw error
  } finally {
    installResponse.resolve(undefined)
  }
})

it('browses the real eighteen digital employees and opens one unsent video-director draft', async () => {
  const artifactRoot = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
  await mkdir(artifactRoot, { recursive: true })
  const evidence = await mkdtemp(join(artifactRoot, 'digital-employees-'))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const events: SessionEvent[] = []
  scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 } })
  const consoleState = watchConsole(page)
  try {
    const roster = (await scaffold.ctx.agentPresets.remoteExportList()).presets
      .filter(preset => preset.id.startsWith('employee-'))
    expect(roster).toHaveLength(18)
    expect(roster.map(preset => preset.id)).toContain('employee-video-director')
    const originalDefault = scaffold.ctx.agentPresets.defaultId

    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'employee-ui', false)
    await expect.poll(() => scaffold.ctx.sessions.list().length).toBe(1)
    const originalSessionId = scaffold.ctx.sessions.list()[0]!.id
    await page.getByRole('button', { name: '数字员工', exact: true }).click()
    const employees = page.getByRole('region', { name: '数字员工', exact: true })
    await employees.getByRole('heading', { name: '短视频编导', exact: true }).waitFor()
    await assertEmbeddedArtwork(employees.locator('header img'))
    expect(await employees.getByRole('heading', { level: 3 }).allTextContents())
      .toEqual(roster.map(preset => preset.name?.trim() || preset.id))
    expect(await employees.getByRole('listitem').count()).toBe(18)
    expect(await employees.getByText('18 个岗位', { exact: true }).count()).toBe(1)

    for (const layout of [
      { width: 1440, dark: false, name: 'wide-light' },
      { width: 1440, dark: true, name: 'wide-dark' },
      { width: 620, dark: false, name: 'compact-light' },
      { width: 620, dark: true, name: 'compact-dark' },
    ]) {
      await page.setViewportSize({ width: layout.width, height: 1000 })
      await page.evaluate((dark) => { document.body.toggleAttribute('data-ds-dark-theme', dark) }, layout.dark)
      await assertCardsFit(employees.getByRole('listitem'))
      expect(await employees.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
      await page.screenshot({ path: join(evidence, `${layout.name}.png`), animations: 'disabled' })
    }

    const search = employees.getByRole('searchbox', { name: '搜索员工名称或职责', exact: true })
    await search.fill('短视频编导')
    expect(await employees.getByRole('listitem').count()).toBe(1)
    expect(await employees.getByText('找到 1 个岗位', { exact: true }).count()).toBe(1)
    await search.fill('未配置的测试岗位')
    expect(await employees.getByRole('listitem').count()).toBe(0)
    expect(await employees.getByRole('heading', { name: '没有找到相关员工', exact: true }).count()).toBe(1)
    await employees.getByRole('button', { name: '清空搜索', exact: true }).click()
    expect(await search.inputValue()).toBe('')
    expect(await search.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await employees.getByRole('listitem').count()).toBe(18)

    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
    await employees.getByRole('button', { name: '与短视频编导开始对话', exact: true }).click()
    await expect.poll(() => employees.count()).toBe(0)
    await expect.poll(() => scaffold.ctx.agents.list()
      .filter(agent => scaffold.ctx.agentPresets.composedPreset(agent.ctx) === 'employee-video-director').length).toBe(1)
    const sessions = scaffold.ctx.sessions.list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.id).toBe(originalSessionId)
    const composer = page.locator('[data-composer-input]').last()
    await composer.waitFor()
    expect(await composer.innerText()).toBe('')
    expect(scaffold.ctx.agentPresets.defaultId).toBe(originalDefault)
    expect(sessions[0]!.snapshotEvents().filter(event => event.type === 'agent-preset/selected'
      && event.data.agentPreset === 'employee-video-director')).toHaveLength(1)
    expect(events.some(event => event.type === 'user/message' || event.type === 'turn/start'
      || event.type === 'request/header' || event.type === 'tool/call' || event.type === 'assistant/attempt')).toBe(false)
    await page.screenshot({ path: join(evidence, 'video-director-unsent-draft.png'), animations: 'disabled' })
    expect(consoleState.pageErrors).toEqual([])
    expect(consoleState.warnings).toEqual([])
    console.info(`Digital employee visual evidence: ${evidence}`)
  } catch (error) {
    await saveFailureShot(page, `${basename(evidence)}/failure`)
    throw error
  }
})
