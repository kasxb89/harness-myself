/** Assembled human-demand UI and an opt-in, exclusively synthetic Go→Host→browser workflow. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'
import { assertReadableText } from './readable-text.ts'
import { installDemandFixture, type DemandFixture } from './fixtures/demands/host-fixture.ts'

const imageFile = fileURLToPath(new URL('../../../packages/llm/llm-deepseek/tests/fixtures/red.png', import.meta.url))
const videoFile = fileURLToPath(new URL('./fixtures/sidebar-media/preview.mp4', import.meta.url))
type Json = Record<string, unknown>
function object(value: unknown): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid synthetic demand test response')
  return value as Json
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new Error('Missing synthetic demand test identity')
  return value
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Invalid synthetic demand test number')
  return value
}
async function artifactDirectory(prefix: string): Promise<string> {
  const root = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
  await mkdir(root, { recursive: true })
  return await mkdtemp(join(root, `demands-${prefix}-`))
}
async function overlayDirectory(real?: { readonly base: string; readonly session: Json }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'yunshu-demands-web-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const state = join(root, 'state'); await mkdir(state, { mode: 0o700 })
  if (real !== undefined) await writeFile(join(state, 'session.json'), JSON.stringify(real.session), { mode: 0o600 })
  const overlay = join(root, 'cordis.patch.yml')
  await writeFile(overlay, JSON.stringify([
    real === undefined ? { id: 'credits-index', disabled: true } : { id: 'credits-index', config: {
      newApiBaseUrl: real.base, baseUrl: '', bridgeBaseUrl: '', stateDir: state,
    } },
    { id: 'ui-demands', config: { enabled: true, foregroundPollMs: 1000, backgroundPollMs: 1000, listPollMs: 1000 } },
    ...['dsh-market', 'dsh-skin-market'].map(id => ({ id, disabled: true })),
  ]))
  return overlay
}
async function navigateService(page: Page, url: string, directory: 'engineers' | 'services' = 'engineers'): Promise<Locator> {
  await page.goto(url, { waitUntil: 'load' })
  await page.bringToFront()
  await page.getByRole('button', { name: '需求发布', exact: true }).click({ timeout: 30_000 })
  const service = page.getByRole('region', { name: '工程师服务', exact: true })
  const personal = service.getByRole('tab', { name: '需求广场', exact: true })
  await personal.waitFor()
  expect(await personal.getAttribute('aria-selected')).toBe('true')
  expect(await service.getByRole('searchbox', { name: directory === 'services' ? '搜索服务或能力' : '搜索工程师或技能', exact: true }).count()).toBe(0)
  await service.getByRole('tab', { name: '官方定制', exact: true }).click()
  await service.getByRole('searchbox', { name: directory === 'services' ? '搜索服务或能力' : '搜索工程师或技能', exact: true }).waitFor()
  return service
}
async function layouts(page: Page, service: Locator, evidence: string, prefix: string): Promise<void> {
  for (const layout of [
    { width: 1320, dark: false, name: 'wide-light' }, { width: 1320, dark: true, name: 'wide-dark' },
    { width: 760, dark: false, name: 'compact-light' }, { width: 760, dark: true, name: 'compact-dark' },
  ]) {
    await page.setViewportSize({ width: layout.width, height: 1000 })
    await page.evaluate((dark) => { document.body.toggleAttribute('data-ds-dark-theme', dark) }, layout.dark)
    const navigation = page.getByRole('button', { name: '需求发布', exact: true })
    await navigation.waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '设置', exact: true }).waitFor({ state: 'visible' })
    await expect.poll(() => navigation.evaluate((node) => {
      for (let item: Element | null = node; item !== null; item = item.parentElement) {
        if (Number(getComputedStyle(item).opacity) < 0.99) return false
      }
      return node.getBoundingClientRect().left >= 0
    })).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    expect(await service.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    const input = service.locator('input:not([type="file"]):visible, textarea:visible').first()
    await assertReadableText(input, '::placeholder')
    if (prefix === 'directory') {
      const cards = service.getByRole('list', { name: '官方定制', exact: true }).getByRole('listitem')
      if (layout.width === 1320 && await cards.count() >= 4) {
        const boxes = await cards.evaluateAll(nodes => nodes.slice(0, 5).map((node) => {
          const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width }
        }))
        expect(new Set(boxes.slice(0, 4).map(box => Math.round(box.y))).size).toBe(1)
        expect(new Set(boxes.slice(0, 4).map(box => Math.round(box.x))).size).toBe(4)
        if (boxes[4] !== undefined) expect(boxes[4].y).toBeGreaterThan(boxes[0]?.y ?? 0)
      }
    }
    await page.screenshot({ path: join(evidence, `${prefix}-${layout.name}.png`), animations: 'disabled' })
  }
}
async function titleDraft(chat: Locator, value: string, retained?: { budget: string; expectedDate: string }): Promise<void> {
  const details = chat.getByRole('button', { name: '补充信息（选填）', exact: true })
  await details.click()
  await chat.getByRole('textbox', { name: '需求标题', exact: true }).fill(value)
  if (retained !== undefined) {
    await chat.getByRole('textbox', { name: '预算', exact: true }).fill(retained.budget)
    await chat.locator('input[type="date"]').fill(retained.expectedDate)
  }
  await details.click()
}
async function assertCompactComposer(chat: Locator): Promise<void> {
  const composer = chat.locator('form'), input = composer.getByRole('textbox', { name: '说明需求、预期结果和相关限制', exact: true })
  await input.waitFor()
  expect(await composer.getByRole('textbox', { name: '需求标题', exact: true }).isVisible()).toBe(false)
  expect(await composer.getByRole('textbox', { name: '预算', exact: true }).isVisible()).toBe(false)
  const box = await composer.boundingBox(), field = await input.boundingBox()
  if (box === null || field === null) throw new Error('The human chat composer is not visible')
  expect(box.height).toBeLessThanOrEqual(240)
  expect(field.height).toBeLessThanOrEqual(100)
  expect(await composer.getByRole('button', { name: '发送', exact: true }).isDisabled()).toBe(true)
  await composer.getByRole('button', { name: '添加附件', exact: true }).waitFor()
}
async function composeWithKeyboard(input: Locator, content: string): Promise<string> {
  await input.fill(content)
  await input.dispatchEvent('compositionstart', { data: '测' })
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
  await input.dispatchEvent('compositionend', { data: '测' })
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter' })
  await input.dispatchEvent('keyup', { key: 'Enter', code: 'Enter' })
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 })
  await input.dispatchEvent('keyup', { key: 'Enter', code: 'Enter' })
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true })
  await input.dispatchEvent('keyup', { key: 'Enter', code: 'Enter' })
  expect(await input.inputValue()).toBe(content)
  expect(await input.isEnabled()).toBe(true)
  await input.press('Shift+Enter')
  expect(await input.inputValue()).toBe(content + '\n')
  await input.pressSequentially('补充说明')
  const result = content + '\n补充说明'
  expect(await input.inputValue()).toBe(result)
  await input.press('Enter')
  return result
}
async function assertPersonalCardLayouts(page: Page, service: Locator, evidence: string): Promise<void> {
  const list = service.getByRole('list', { name: '个人需求', exact: true })
  const cards = list.getByRole('listitem'), geometry: Json[] = []
  for (const layout of [
    { width: 1320, dark: false, name: 'wide-light' }, { width: 1320, dark: true, name: 'wide-dark' },
    { width: 760, dark: false, name: 'compact-light' }, { width: 760, dark: true, name: 'compact-dark' },
  ]) {
    await page.setViewportSize({ width: layout.width, height: 1000 })
    await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), layout.dark)
    await list.waitFor({ state: 'visible' })
    await list.evaluate((node) => {
      for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
        if (['auto', 'scroll'].includes(getComputedStyle(parent).overflowY)) parent.scrollTop = 0
      }
    })
    expect(await service.getByRole('tab', { name: '需求广场', exact: true }).getAttribute('aria-selected')).toBe('true')
    expect(await cards.count()).toBe(5)
    expect(await list.getByRole('button').filter({ hasText: '继续编辑' }).count()).toBe(3)
    expect(await list.getByRole('button').filter({ hasText: '沟通' }).count()).toBe(2)
    for (const hidden of ['同一服务的第二个独立请求', '测试交付：已完成，请验收。', '待分配工程师', '已完成', '3600 MYR']) {
      expect(await list.getByText(hidden, { exact: true }).count()).toBe(0)
    }
    expect(await list.getByText('期望交付：2026-12-20', { exact: true }).count()).toBe(0)
    expect(await service.getByRole('searchbox', { name: '搜索服务或能力', exact: true }).count()).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    const boxes = []
    for (const card of await cards.all()) {
      expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      await assertReadableText(card.getByRole('heading', { level: 2 }))
      await assertReadableText(card.getByRole('button'))
      const box = await card.boundingBox(), button = await card.getByRole('button').boundingBox()
      if (box === null || button === null) throw new Error('A split personal demand card is missing its action')
      expect(button.x).toBeGreaterThan(box.x + box.width * 0.6)
      expect(await card.getByRole('button').evaluate(node => node.parentElement !== null
        && Number.parseFloat(getComputedStyle(node.parentElement).borderLeftWidth) > 0)).toBe(true)
      boxes.push(box)
    }
    if (layout.width === 1320) {
      expect(Math.round(boxes[0]?.y ?? 0)).toBe(Math.round(boxes[1]?.y ?? 0))
      expect(boxes[2]?.y).toBeGreaterThan(boxes[0]?.y ?? 0)
    } else expect(new Set(boxes.map(box => Math.round(box.x))).size).toBe(1)
    const scrollOwners = await list.evaluate((node) => {
      const owners = []
      for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
        if (['auto', 'scroll'].includes(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight + 2) {
          owners.push({ tag: parent.tagName, height: parent.clientHeight, scrollHeight: parent.scrollHeight })
        }
      }
      return owners
    })
    if (layout.width === 760) expect(scrollOwners).toHaveLength(1)
    else expect(scrollOwners.length).toBeLessThanOrEqual(1)
    await page.screenshot({ path: join(evidence, `personal-five-${layout.name}.png`), fullPage: true, animations: 'disabled' })
    if (layout.width === 760) {
      await cards.first().hover(); await page.mouse.wheel(0, 1600)
      await expect.poll(() => cards.last().getByRole('button').evaluate((node) => {
        const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight
      })).toBe(true)
      await page.screenshot({ path: join(evidence, `personal-five-bottom-${layout.name}.png`), fullPage: true, animations: 'disabled' })
    }
    geometry.push({ layout: layout.name, viewport: page.viewportSize(),
      devicePixelRatio: await page.evaluate(() => window.devicePixelRatio), cards: boxes, scrollOwners })
  }
  await writeFile(join(evidence, 'personal-card-layouts.json'), JSON.stringify(geometry))
}
async function assertInboxLayouts(page: Page, service: Locator, evidence: string, serviceName: string): Promise<void> {
  const inbox = service.getByRole('complementary', { name: '我的需求', exact: true })
  const rows = inbox.getByRole('button').filter({ has: page.locator('strong') })
  const coordinates: Json[] = []
  for (const layout of [
    { width: 1320, dark: false, name: 'wide-light' }, { width: 1320, dark: true, name: 'wide-dark' },
    { width: 760, dark: false, name: 'compact-light' }, { width: 760, dark: true, name: 'compact-dark' },
  ]) {
    await page.setViewportSize({ width: layout.width, height: 1000 })
    await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), layout.dark)
    const back = service.getByRole('button', { name: '返回需求列表', exact: true })
    if (layout.width === 760 && await back.isVisible()) await back.click()
    await inbox.waitFor({ state: 'visible' })
    expect(await rows.count()).toBe(5)
    expect(await inbox.locator('button[aria-current="true"]').count()).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    for (const row of await rows.all()) {
      expect(await row.locator('strong').textContent()).toBe(serviceName)
      expect(await row.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      const bounds = await row.boundingBox()
      if (bounds === null) throw new Error('A human conversation row is not visible')
      expect(bounds.height).toBeLessThanOrEqual(76)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(1000)
      await assertReadableText(row.locator('strong'))
      await assertReadableText(row.locator('time'))
    }
    await assertReadableText(inbox.getByRole('searchbox', { name: '搜索需求', exact: true }), '::placeholder')
    coordinates.push({ layout: layout.name, inbox: await inbox.boundingBox(),
      rowHeights: await rows.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height)) })
    await page.screenshot({ path: join(evidence, `inbox-five-${layout.name}.png`), animations: 'disabled' })
  }
  await writeFile(join(evidence, 'inbox-layouts.json'), JSON.stringify(coordinates))
}
async function exerciseIndependentServiceInbox(
  page: Page, service: Locator, fixture: DemandFixture, evidence: string, serviceName: string,
): Promise<void> {
  await page.setViewportSize({ width: 1320, height: 1000 })
  let chat = service.getByRole('region', { name: '与测试工程师林沟通', exact: true })
  const start = async (): Promise<Locator> => {
    await chat.getByRole('button', { name: '新需求', exact: true }).click()
    await service.getByRole('button', { name: `为${serviceName}发布需求`, exact: true }).click()
    chat = service.getByRole('region', { name: '与平台统一接待沟通', exact: true })
    await chat.waitFor()
    return chat
  }
  await start()
  await titleDraft(chat, '第二笔独立交付乙')
  await chat.getByRole('textbox', { name: '说明需求、预期结果和相关限制', exact: true }).fill('同一服务的第二个独立请求')
  await chat.getByRole('button', { name: '发送', exact: true }).click()
  await chat.getByRole('textbox', { name: '输入消息', exact: true }).waitFor()
  expect(fixture.records.size).toBe(2)
  expect(new Set([...fixture.records.values()].map(row => row.id)).size).toBe(2)
  expect(new Set([...fixture.records.values()].map(row => row.service_profile_id)).size).toBe(1)
  const first = object(JSON.parse(fixture.createBodies[0] ?? '{}') as unknown)
  const second = object(JSON.parse(fixture.createBodies[2] ?? '{}') as unknown)
  expect(second.client_request_id).not.toBe(first.client_request_id)
  const drafts = [
    { title: '草稿甲：这是一段足够长的自定义交付标题，用于验证一行省略后仍可搜索', body: '甲需要整理图片与视频素材',
      retained: { budget: '3600 MYR', expectedDate: '2026-12-20' } },
    { title: '草稿乙：独立客服资料', body: '乙需要客户支持资料' },
    { title: '草稿丙：独立流程', body: '丙需要固定工作流程' },
  ]
  for (const item of drafts) {
    await start()
    await titleDraft(chat, item.title, item.retained)
    await chat.getByRole('textbox', { name: '说明需求、预期结果和相关限制', exact: true }).fill(item.body)
  }
  await service.getByRole('button', { name: '返回个人需求', exact: true }).click()
  const personal = service.getByRole('list', { name: '个人需求', exact: true })
  await expect.poll(() => personal.getByRole('listitem').count()).toBe(5)
  const submittedCards = fixture.createBodies.length
  for (const item of drafts) {
    const card = personal.getByRole('listitem').filter({ has: page.getByRole('heading', { name: item.title, exact: true }) })
    expect(await card.getByRole('button').textContent()).toBe('继续编辑')
    await card.getByRole('button').click()
    expect(await chat.getByRole('textbox', { name: '说明需求、预期结果和相关限制', exact: true }).inputValue()).toBe(item.body)
    if (item.retained !== undefined) {
      const details = chat.getByRole('button', { name: '补充信息（选填）', exact: true })
      await details.click()
      expect(await chat.getByRole('textbox', { name: '预算', exact: true }).inputValue()).toBe(item.retained.budget)
      expect(await chat.locator('input[type="date"]').inputValue()).toBe(item.retained.expectedDate)
      await details.click()
    }
    await service.getByRole('button', { name: '返回个人需求', exact: true }).click()
  }
  const published = personal.getByRole('listitem').filter({ has: page.getByRole('heading', { name: '第二笔独立交付乙', exact: true }) })
  expect(await published.getByRole('button').textContent()).toBe('沟通')
  await published.getByRole('button').click()
  await chat.getByRole('log').getByText('同一服务的第二个独立请求', { exact: true }).waitFor()
  expect(fixture.createBodies).toHaveLength(submittedCards)
  await service.getByRole('button', { name: '返回个人需求', exact: true }).click()
  await assertPersonalCardLayouts(page, service, evidence)
  await page.setViewportSize({ width: 1320, height: 1000 })
  await service.getByRole('button', { name: '会话列表', exact: true }).click()
  const inbox = service.getByRole('complementary', { name: '我的需求', exact: true })
  const rows = inbox.getByRole('button').filter({ has: page.locator('strong') })
  const search = inbox.getByRole('searchbox', { name: '搜索需求', exact: true })
  await expect.poll(() => rows.count()).toBe(5)
  expect(await inbox.getByRole('group', { name: '草稿', exact: true }).getByRole('button').count()).toBe(3)
  expect(await inbox.locator('button[aria-current="true"]').count()).toBe(1)
  const submitted = fixture.createBodies.length
  for (const item of drafts) {
    await search.fill(item.title)
    await expect.poll(() => rows.count()).toBe(1)
    expect(await rows.first().locator('strong').textContent()).toBe(serviceName)
    await rows.first().click()
    expect(await chat.getByRole('textbox', { name: '说明需求、预期结果和相关限制', exact: true }).inputValue()).toBe(item.body)
    expect(await rows.first().getAttribute('aria-current')).toBe('true')
  }
  await search.fill('第二笔独立交付乙')
  await expect.poll(() => rows.count()).toBe(1)
  await rows.first().click()
  await chat.getByRole('textbox', { name: '输入消息', exact: true }).waitFor()
  expect(await rows.first().locator('strong').textContent()).toBe(serviceName)
  expect(fixture.createBodies).toHaveLength(submitted)
  await search.fill('')
  await expect.poll(() => rows.count()).toBe(5)
  const filter = inbox.getByRole('button', { name: '筛选', exact: true })
  expect(await filter.textContent()).toBe('')
  await filter.hover()
  await page.getByRole('tooltip', { name: '筛选', exact: true }).waitFor()
  await filter.click()
  const menu = page.getByRole('menu')
  await menu.waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  expect(await filter.evaluate(node => document.activeElement === node)).toBe(true)
  await filter.click()
  await page.getByRole('menuitem', { name: '已完成', exact: true }).click()
  await expect.poll(() => inbox.getByText('第二笔独立交付乙', { exact: true }).count()).toBe(0)
  await filter.click()
  await page.getByRole('menuitem', { name: '全部需求', exact: true }).click()
  await expect.poll(() => rows.count()).toBe(5)
  expect(fixture.createBodies).toHaveLength(submitted)
  await assertInboxLayouts(page, service, evidence, serviceName)
}
async function assertSingleMessageScroll(page: Page, log: Locator): Promise<void> {
  await expect.poll(() => log.evaluate(node => node.scrollHeight > node.clientHeight + 20)).toBe(true)
  const scrollOwners = await log.evaluate((node) => {
    const ancestors: string[] = []
    for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
      if (['auto', 'scroll'].includes(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight + 2) ancestors.push(parent.tagName)
    }
    return ancestors
  })
  expect(scrollOwners).toEqual([])
  await log.evaluate((node) => { node.scrollTop = node.scrollHeight })
  const before = await log.evaluate(node => node.scrollTop)
  await log.hover(); await page.mouse.wheel(0, -350)
  await expect.poll(() => log.evaluate(node => node.scrollTop)).toBeLessThan(before)
}
async function assertMessageAuthor(chat: Locator, content: string, author: string): Promise<void> {
  const message = chat.locator('article[data-author="engineer"]').filter({ hasText: content })
  await message.waitFor()
  await expect.poll(() => message.getByText(author, { exact: true }).count()).toBe(1)
}
async function assertMedia(page: Page, chat: Locator, imageName: string, videoName: string): Promise<void> {
  await chat.getByRole('button', { name: `预览${imageName}`, exact: true }).click()
  const lightbox = page.getByRole('dialog', { name: '图片预览', exact: true })
  await lightbox.waitFor()
  await expect.poll(() => lightbox.getByRole('img').evaluate(node => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0)).toBe(true)
  await lightbox.getByRole('button', { name: '关闭', exact: true }).click()
  const video = chat.locator('video').first()
  expect(await video.getAttribute('aria-label')).toBe(videoName)
  await video.scrollIntoViewIfNeeded()
  await expect.poll(() => video.evaluate(node => node instanceof HTMLVideoElement
    && Number.isFinite(node.duration) && node.duration > 0)).toBe(true)
  await video.evaluate(async (node) => {
    if (!(node instanceof HTMLVideoElement) || !node.controls) throw new Error('Native demand video controls are missing')
    node.muted = true; await node.play()
  })
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
  const target = await video.evaluate((node) => {
    const media = node as HTMLVideoElement
    media.pause(); media.currentTime = media.duration * 0.6
    return media.currentTime
  })
  await expect.poll(() => video.evaluate((node, target) => {
    const media = node as HTMLVideoElement
    return !media.seeking && Math.abs(media.currentTime - target) < 0.2
  }, target)).toBe(true)
  const range = await video.evaluate(async (node) => {
    const response = await fetch((node as HTMLVideoElement).currentSrc, { headers: { range: 'bytes=0-31' }, cache: 'no-store' })
    return { status: response.status, bytes: (await response.arrayBuffer()).byteLength }
  })
  expect(range.status).toBe(206); expect(range.bytes).toBe(32)
}

it('keeps independent drafts, original unknown-submit keys, uploads and responsive human chat usable without a paid model', async () => {
  const evidence = await artifactDirectory('keyless'), overlay = await overlayDirectory()
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay }); onTestFinished(() => scaffold.close())
  const browser = await chromium.launch(); onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1320, height: 1000 } })
  const diagnostics = watchConsole(page), fixture = await installDemandFixture(page)
  const removeMedia = scaffold.ctx.webServer.register({ kind: 'prefix', path: '/credits/api/demands/attachments', handler: (request, response) => { fixture.serveMedia(request, response) } })
  onTestFinished(removeMedia)
  try {
    const service = await navigateService(page, scaffold.authenticatedUrl)
    await service.getByRole('heading', { name: '测试工程师林', exact: true }).waitFor()
    expect(await service.getByRole('heading', { level: 2 }).count()).toBe(4)
    expect(await service.getByRole('button', { name: '向测试工程师陈发起需求', exact: true }).isDisabled()).toBe(true)
    expect(await service.getByRole('button', { name: '向测试工程师周发起需求', exact: true }).isDisabled()).toBe(true)
    await layouts(page, service, evidence, 'directory')
    await page.setViewportSize({ width: 1320, height: 1000 })
    await service.getByRole('button', { name: '向测试工程师林发起需求', exact: true }).click()
    let chat = service.getByRole('region', { name: '与测试工程师林沟通', exact: true })
    await assertCompactComposer(chat)
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
    await page.screenshot({ path: join(evidence, 'draft-wide-light.png'), animations: 'disabled' })
    await titleDraft(chat, '首个待确认需求')
    const firstText = await composeWithKeyboard(chat.getByRole('textbox', { name: '说明需求、预期结果和相关限制', exact: true }), '首个待确认需求的正文')
    await chat.getByRole('button', { name: '核对发布结果', exact: true }).waitFor()
    expect(fixture.createBodies).toHaveLength(1)
    const original = object(JSON.parse(fixture.createBodies[0] ?? '{}') as unknown)
    expect(original.text).toBe(firstText)
    expect(original.client_request_id).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu)
    await chat.getByRole('button', { name: '新需求', exact: true }).click()
    await service.getByRole('button', { name: '向测试工程师林发起需求', exact: true }).click()
    chat = service.getByRole('region', { name: '与测试工程师林沟通', exact: true })
    await chat.getByRole('textbox', { name: '说明需求、预期结果和相关限制', exact: true }).fill('独立第二个需求的正文')
    await titleDraft(chat, '独立第二个需求')
    await chat.getByRole('button', { name: '发送', exact: true }).click()
    await chat.getByRole('textbox', { name: '输入消息', exact: true }).waitFor()
    expect(fixture.records.size).toBe(2)
    const retainedText = '独立第二个需求的暂存后续消息'
    await chat.getByRole('textbox', { name: '输入消息', exact: true }).fill(retainedText)
    await service.getByRole('button', { name: '返回个人需求', exact: true }).click()
    const personal = service.getByRole('list', { name: '个人需求', exact: true })
    const pending = personal.getByRole('listitem').filter({ has: page.getByRole('heading', { name: '首个待确认需求', exact: true }) })
    expect(await pending.getByRole('button').textContent()).toBe('核对发布结果')
    await pending.getByRole('button').click()
    expect(fixture.createBodies).toHaveLength(2)
    const originalDraft = chat.getByRole('textbox', { name: '说明需求、预期结果和相关限制', exact: true })
    expect(await originalDraft.inputValue()).toBe(firstText)
    expect(await originalDraft.isDisabled()).toBe(true)
    await chat.getByRole('button', { name: '核对发布结果', exact: true }).click()
    await chat.getByRole('textbox', { name: '输入消息', exact: true }).waitFor()
    expect(fixture.createBodies).toHaveLength(3)
    expect(fixture.createBodies[2]).toBe(fixture.createBodies[0])
    expect(object(JSON.parse(fixture.createBodies[2] ?? '{}') as unknown).client_request_id).toBe(original.client_request_id)
    expect(fixture.createBodies[1]).not.toBe(fixture.createBodies[0])
    expect(fixture.records.size).toBe(2)
    await service.getByRole('button', { name: '返回个人需求', exact: true }).click()
    await personal.getByRole('listitem').filter({ has: page.getByRole('heading', { name: '独立第二个需求', exact: true }) })
      .getByRole('button').click()
    expect(await chat.getByRole('textbox', { name: '输入消息', exact: true }).inputValue()).toBe(retainedText)
    await chat.getByRole('textbox', { name: '输入消息', exact: true }).fill('')

    await chat.getByRole('button', { name: '新需求', exact: true }).click()
    await service.getByRole('button', { name: '向测试工程师林发起需求', exact: true }).click()
    const files = await Promise.all([readFile(imageFile), readFile(videoFile)])
    await chat.locator('input[type="file"]').setInputFiles([
      { name: '需求截图.png', mimeType: 'image/png', buffer: files[0] ?? Buffer.alloc(0) },
      { name: '需求演示.mp4', mimeType: 'video/mp4', buffer: files[1] ?? Buffer.alloc(0) },
    ])
    await expect.poll(() => chat.getByText('待发送', { exact: true }).count()).toBe(2)
    await chat.getByRole('button', { name: '发送', exact: true }).click()
    await chat.getByRole('textbox', { name: '输入消息', exact: true }).waitFor()
    const latest = [...fixture.records.values()].at(-1)
    if (latest === undefined) throw new Error('Pure attachment demand did not persist')
    expect(object(JSON.parse(fixture.createBodies.at(-1) ?? '{}') as unknown).text).toBe('')
    expect([...fixture.chunks.values()]).toEqual([1, 1])
    fixture.deliver(latest.id)
    await chat.getByText('测试交付：已完成，请验收。', { exact: true }).first().waitFor()
    await assertMessageAuthor(chat, '测试工程师进度 1：', '测试工程师林')
    await assertMessageAuthor(chat, '测试工程师进度 2：', '工程师')
    await assertMessageAuthor(chat, '测试交付：已完成，请验收。', '测试工程师林')
    await assertSingleMessageScroll(page, chat.getByRole('log'))
    await layouts(page, service, evidence, 'chat')
    await service.getByRole('button', { name: '返回个人需求', exact: true }).click()
    await personal.waitFor({ state: 'visible' })
    expect(await chat.isVisible()).toBe(false)
    expect(await personal.getByText('测试交付：已完成，请验收。', { exact: true }).count()).toBe(0)
    const restoredLabels = await personal.getByRole('button').evaluateAll((nodes, number) => nodes
      .map(node => node.getAttribute('aria-label')).filter(label => label?.endsWith(`需求 ${number}`)), latest.number)
    expect(restoredLabels).toHaveLength(1)
    const restoredLabel = restoredLabels[0]
    if (restoredLabel == null) throw new Error('The original private request card cannot be found')
    await personal.getByRole('button', { name: restoredLabel, exact: true }).click()
    await chat.waitFor({ state: 'visible' })
    await assertMedia(page, chat, '需求截图.png', '需求演示.mp4')
    const downloadReady = page.waitForEvent('download')
    await chat.getByRole('button', { name: '下载需求截图.png', exact: true }).click()
    const download = await downloadReady
    expect(download.suggestedFilename()).toBe('需求截图.png'); expect(await download.failure()).toBeNull()
    const downloadedPath = join(evidence, 'downloaded-需求截图.png')
    await download.saveAs(downloadedPath); expect(await readFile(downloadedPath)).toEqual(files[0])
    await chat.getByRole('button', { name: '确认完成', exact: true }).click()
    await chat.getByRole('button', { name: '确认验收', exact: true }).click()
    await chat.getByText('已验收', { exact: true }).waitFor()
    expect(latest.status).toBe('completed')
    expect(diagnostics.pageErrors).toEqual([]); expect(diagnostics.warnings).toEqual([])
    await writeFile(join(evidence, 'result.json'), JSON.stringify({ syntheticOnly: true, requestCount: fixture.records.size,
      sameUnknownSubmitBody: fixture.createBodies[0] === fixture.createBodies[2],
      uploadedParts: [...fixture.chunks.values()], authorNames: 'preserved-with-generic-legacy-fallback', paidRequests: 0 }))
  } catch (error) { await saveFailureShot(page, 'demands-keyless'); throw error }
}, 120_000)

it('pages 100 platform services, filters on the server and keeps the original intake target through unknown submission and assignment', async () => {
  const evidence = await artifactDirectory('service-directory'), overlay = await overlayDirectory()
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay }); onTestFinished(() => scaffold.close())
  const browser = await chromium.launch(); onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1320, height: 1000 } })
  const diagnostics = watchConsole(page), fixture = await installDemandFixture(page, { serviceProfiles: true })
  try {
    const service = await navigateService(page, scaffold.authenticatedUrl, 'services')
    const search = service.getByRole('searchbox', { name: '搜索服务或能力', exact: true })
    const cards = service.getByRole('heading', { level: 2 })
    await service.getByText('100 项服务', { exact: true }).waitFor()
    await expect.poll(() => cards.count()).toBe(30)
    for (const count of [60, 90, 100]) {
      await service.getByRole('button', { name: '加载更多服务', exact: true }).click()
      await expect.poll(() => cards.count()).toBe(count)
    }
    expect(await service.getByRole('button', { name: '加载更多服务', exact: true }).count()).toBe(0)
    for (const label of ['在线', '忙碌中', '离线']) expect(await service.getByText(label, { exact: true }).count()).toBe(0)
    await search.scrollIntoViewIfNeeded()
    await layouts(page, service, evidence, 'directory')
    await page.setViewportSize({ width: 1320, height: 1000 })
    await search.fill('057')
    await service.getByText('1 项服务', { exact: true }).waitFor()
    await expect.poll(() => cards.count()).toBe(1)
    expect(await cards.first().textContent()).toBe('测试服务 057')
    expect(fixture.directoryRequests.some(query => new URLSearchParams(query).get('q') === '057')).toBe(true)
    await service.getByRole('button', { name: '清空搜索', exact: true }).click()
    await service.getByText('100 项服务', { exact: true }).waitFor()
    await service.getByRole('button', { name: '文档处理', exact: true }).click()
    await service.getByText('50 项服务', { exact: true }).waitFor()
    await expect.poll(() => cards.count()).toBe(30)
    await service.getByRole('button', { name: '加载更多服务', exact: true }).click()
    await expect.poll(() => cards.count()).toBe(50)
    expect(fixture.directoryRequests.some(query => new URLSearchParams(query).get('category_id') === 'documents')).toBe(true)
    await service.getByRole('button', { name: '全部分类', exact: true }).click()
    await search.fill('001')
    await service.getByText('1 项服务', { exact: true }).waitFor()
    const target = fixture.services[0]
    if (target === undefined) throw new Error('Synthetic service target is missing')
    await service.getByRole('button', { name: `为${target.display_name}发布需求`, exact: true }).click()
    let chat = service.getByRole('region', { name: '与平台统一接待沟通', exact: true })
    await chat.getByRole('textbox', { name: '说明需求、预期结果和相关限制', exact: true }).fill('测试平台服务需求，附画面与演示视频')
    await chat.locator('input[type="file"]').setInputFiles([imageFile, videoFile])
    await expect.poll(() => chat.getByText('待发送', { exact: true }).count()).toBe(2)
    await chat.getByRole('button', { name: '发送', exact: true }).click()
    await chat.getByRole('button', { name: '核对发布结果', exact: true }).waitFor()
    expect(fixture.createBodies).toHaveLength(1)
    expect(object(JSON.parse(fixture.createBodies[0] ?? '{}') as unknown)).toMatchObject({ service_profile_id: target.id })
    expect(object(JSON.parse(fixture.createBodies[0] ?? '{}') as unknown)).not.toHaveProperty('engineer_id')
    await chat.getByRole('button', { name: '核对发布结果', exact: true }).click()
    await chat.getByRole('textbox', { name: '输入消息', exact: true }).waitFor()
    expect(fixture.createBodies).toHaveLength(2)
    expect(fixture.createBodies[1]).toBe(fixture.createBodies[0])
    expect(fixture.records.size).toBe(1)
    const queued = [...fixture.records.values()][0]
    if (queued === undefined) throw new Error('Platform request did not persist')
    expect(queued.assigned).toBe(false)
    await chat.getByText('待分配工程师', { exact: true }).waitFor()
    await chat.getByText(`服务：${target.display_name}`, { exact: true }).waitFor()
    for (const label of ['在线', '忙碌中', '离线']) expect(await chat.getByText(label, { exact: true }).count()).toBe(0)
    await page.screenshot({ path: join(evidence, 'unassigned-platform-intake.png'), animations: 'disabled' })
    fixture.assign(queued.id)
    chat = service.getByRole('region', { name: '与测试工程师林沟通', exact: true })
    await chat.waitFor()
    await chat.getByText(`服务：${target.display_name}`, { exact: true }).waitFor()
    expect(queued.service_profile_id).toBe(target.id)
    fixture.deliver(queued.id)
    await chat.getByRole('button', { name: '确认完成', exact: true }).waitFor()
    await layouts(page, service, evidence, 'assigned-chat')
    await assertMedia(page, chat, 'red.png', 'preview.mp4')
    await chat.getByRole('button', { name: '确认完成', exact: true }).click()
    await chat.getByRole('button', { name: '确认验收', exact: true }).click()
    await chat.getByText('已验收', { exact: true }).waitFor()
    expect(queued.status).toBe('completed')
    await exerciseIndependentServiceInbox(page, service, fixture, evidence, target.display_name)
    expect(diagnostics.pageErrors).toEqual([]); expect(diagnostics.warnings).toEqual([])
    await writeFile(join(evidence, 'result.json'), JSON.stringify({ syntheticOnly: true, catalogTotal: 100,
      sameUnknownServiceBody: fixture.createBodies[0] === fixture.createBodies[1], serviceTarget: target.id,
      sourceSnapshot: queued.service_profile_name, independentPublished: 2, localDrafts: 3,
      directoryReads: fixture.directoryRequests.length, paidRequests: 0 }))
  } catch (error) { await saveFailureShot(page, 'demands-service-directory'); throw error }
}, 120_000)

type Actor = 'customerA' | 'customerB' | 'engineerA' | 'engineerB' | 'admin'
interface SyntheticFixture {
  readonly base: string
  readonly tokens: Record<Actor, string>
  readonly expiresAt: number
  readonly ownerId: string
  readonly engineerId: string
  readonly replacementId: string
}
async function readSyntheticFixture(path: string): Promise<SyntheticFixture> {
  const data = object(JSON.parse(await readFile(path, 'utf8')) as unknown), base = new URL(text(data.base_url))
  if (data.synthetic_only !== true || data.schema_version !== 1 || base.protocol !== 'http:' || base.username !== '' || base.password !== ''
    || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.pathname !== '/' || base.search !== '' || base.hash !== '') {
    throw new Error('DSH_DEMAND_FIXTURE must identify a synthetic-only loopback fixture')
  }
  const tokens = object(data.tokens), users = object(data.users), engineers = object(data.engineers), expiresAt = number(data.expires_at)
  if (expiresAt * 1000 < Date.now() + 120_000) throw new Error('Synthetic JWTs are expiring; renew_fixture.py may refresh them, then rerun this opt-in case')
  return { base: base.origin, expiresAt, ownerId: String(number(object(users.owner).id)), engineerId: text(engineers.engineer),
    replacementId: text(engineers.replacement), tokens: { customerA: text(tokens.customerA), customerB: text(tokens.customerB),
      engineerA: text(tokens.engineerA), engineerB: text(tokens.engineerB), admin: text(tokens.admin) } }
}

interface DirectoryFixture extends SyntheticFixture {
  readonly storedSession: Json
}
async function readDirectoryFixture(path: string, readyPath: string): Promise<DirectoryFixture> {
  if (path === '' || readyPath === '') throw new Error('Directory interop requires both a private manifest and its final READY receipt')
  const ready = object(JSON.parse(await readFile(readyPath, 'utf8')) as unknown)
  if (ready.schema !== 1 || ready.ready !== true || ready.synthetic_only !== true || ready.active === false) {
    throw new Error('The directory fixture has not passed final qualification')
  }
  const manifestPath = await realpath(path)
  if (manifestPath !== await realpath(resolve(dirname(readyPath), text(ready.private_manifest)))) {
    throw new Error('Directory manifest does not match its READY receipt')
  }
  const data = object(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown), base = new URL(text(data.base_url))
  if (data.schema_version !== 1 || data.synthetic_only !== true || data.mode !== 'directory-interop'
    || text(data.fixture_id) !== text(ready.fixture_id) || text(data.source_commit) !== text(ready.source_commit)
    || data.base_url !== ready.base_url || base.protocol !== 'http:' || base.username !== '' || base.password !== ''
    || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.pathname !== '/' || base.search !== '' || base.hash !== '') {
    throw new Error('Directory fixture identity, source, mode or loopback authority is inconsistent')
  }
  if (['43321', '43322', '43323'].includes(base.port)) throw new Error('The protected manual fixture cannot be used for directory interop')
  const actors = object(data.actors), tokens = {} as Record<Actor, string>
  let expiry = number(data.expires_at)
  for (const name of ['customerA', 'customerB', 'engineerA', 'engineerB', 'admin'] as const) {
    const actor = object(actors[name])
    if (number(actor.id) < 1) throw new Error('Synthetic actor has an invalid account identity')
    tokens[name] = text(actor.access_token)
    expiry = Math.min(expiry, number(actor.access_expires_at))
  }
  const supplied = object(data.customerStoredSession), upstream = object(supplied.upstream), account = object(supplied.account)
  const ownerId = String(number(object(actors.customerA).id)), expiresAt = text(supplied.expiresAt)
  const upstreamExpiresAt = text(upstream.expiresAt), localExpiry = Date.parse(expiresAt), accessExpiry = Date.parse(upstreamExpiresAt)
  if (account.id !== ownerId || supplied.backendBaseUrl !== base.origin || upstream.token !== tokens.customerA
    || !Number.isFinite(localExpiry) || !Number.isFinite(accessExpiry)) throw new Error('Directory StoredSession is not bound to its customer actor')
  expiry = Math.min(expiry, Math.floor(localExpiry / 1000), Math.floor(accessExpiry / 1000))
  if (expiry * 1000 < Date.now() + 120_000) throw new Error('Qualified synthetic credentials are expiring; the fixture owner must renew them')
  const storedSession: Json = { token: text(supplied.token), backendBaseUrl: base.origin, expiresAt,
    account: { id: ownerId, phone: text(account.phone) }, upstream: { token: tokens.customerA, expiresAt: upstreamExpiresAt,
      ...upstream.refresh === undefined ? {} : { refresh: text(upstream.refresh) } } }
  const engineers = object(data.engineers)
  return { base: base.origin, tokens, expiresAt: expiry, ownerId, storedSession,
    engineerId: text(engineers.engineer), replacementId: text(engineers.replacement) }
}


function syntheticRequests(fixture: SyntheticFixture): {
  api: (actor: Actor, path: string, body?: Json) => Promise<{ status: number; data: Json }>
  success: (actor: Actor, path: string, body?: Json) => Promise<Json>
} {
  const api = async (actor: Actor, path: string, body?: Json): Promise<{ status: number; data: Json }> => {
    const response = await fetch(fixture.base + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${fixture.tokens[actor]}`, accept: 'application/json',
        ...body === undefined ? {} : { 'content-type': 'application/json' } },
      ...body === undefined ? {} : { body: JSON.stringify(body) } })
    return { status: response.status, data: object(await response.json() as unknown) }
  }
  const success = async (actor: Actor, path: string, body?: Json): Promise<Json> => {
    const result = await api(actor, path, body)
    if (result.status < 200 || result.status >= 300 || result.data.success !== true) {
      throw new Error(`Synthetic demand API rejected ${actor} operation: ${result.status}`)
    }
    return object(result.data.data)
  }
  return { api, success }
}

it.skipIf(process.env.DSH_DEMAND_FIXTURE === undefined)(
  'round-trips a synthetic Go request through the actual Host, assignment security, original media and user acceptance', async () => {
    const fixture = await readSyntheticFixture(process.env.DSH_DEMAND_FIXTURE ?? '')
    const evidence = await artifactDirectory('real-go'), stamp = `synthetic-${randomUUID()}`
    const { api, success } = syntheticRequests(fixture)
    const expires = new Date(fixture.expiresAt * 1000).toISOString()
    const overlay = await overlayDirectory({ base: fixture.base, session: { token: `synthetic-local-${randomBytes(24).toString('hex')}`,
      backendBaseUrl: fixture.base, expiresAt: expires, account: { id: fixture.ownerId, phone: '+8613800000000' },
      upstream: { token: fixture.tokens.customerA, expiresAt: expires } } })
    const scaffold = await launchWebScaffold({ extraOverlayPath: overlay }); onTestFinished(() => scaffold.close())
    const creditsEntry = [...scaffold.ctx.loader.entries()].find(row => row.options.id === 'credits-index')
    const creditsConfig = object(creditsEntry?.options.config)
    expect(creditsConfig.newApiBaseUrl).toBe(fixture.base)
    const sessionResponse = object(await (await scaffold.hostFetch('/credits/api/session')).json() as unknown)
    const sessionPayload = object(sessionResponse.payload)
    const sessionDiagnostic = { base: creditsConfig.newApiBaseUrl, stateDir: creditsConfig.stateDir, ok: sessionResponse.ok,
      code: sessionResponse.code, signedIn: sessionPayload.signedIn, liveness: sessionPayload.liveness, failure: sessionPayload.failure }
    await writeFile(join(evidence, 'session-preflight.json'), JSON.stringify(sessionDiagnostic))
    expect(sessionDiagnostic, 'Synthetic session must be verified before the private service can appear').toMatchObject({ ok: true, signedIn: true, liveness: 'verified' })
    const browser = await chromium.launch(); onTestFinished(() => browser.close())
    const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1320, height: 1000 } })
    const diagnostics = watchConsole(page)
    try {
      const directory = await success('customerA', '/api/product/demands/engineers')
      if (!Array.isArray(directory.items)) throw new Error('Synthetic engineer directory is missing')
      const engineer = directory.items.map(object).find(item => item.id === fixture.engineerId)
      const replacement = directory.items.map(object).find(item => item.id === fixture.replacementId)
      if (engineer === undefined || replacement === undefined) throw new Error('Configured synthetic engineer is unavailable')
      const name = text(engineer.display_name), replacementName = text(replacement.display_name)
      expect(replacementName).not.toBe(name)
      const service = await navigateService(page, scaffold.authenticatedUrl)
      await service.getByRole('button', { name: `向${name}发起需求`, exact: true }).click()
      const chat = service.getByRole('region', { name: `与${name}沟通`, exact: true })
      await chat.getByRole('textbox', { name: '说明需求、预期结果和相关限制', exact: true }).fill(stamp)
      await chat.locator('input[type="file"]').setInputFiles([imageFile, videoFile])
      await expect.poll(() => chat.getByText('待发送', { exact: true }).count()).toBe(2)
      const receiptReady = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname.endsWith('/credits/api/demands'))
      await chat.getByRole('button', { name: '发送', exact: true }).click()
      const receipt = object(await (await receiptReady).json() as unknown), created = object(object(receipt.payload).demand)
      const demandId = text(created.id), initialMessage = object(object(receipt.payload).message)
      if (!Array.isArray(initialMessage.attachments)) throw new Error('Synthetic attachment receipts are missing')
      const attachmentId = text(object(initialMessage.attachments[0]).id)
      await chat.getByRole('textbox', { name: '输入消息', exact: true }).waitFor()
      const foreign = await api('customerB', `/api/product/demands/${demandId}`)
      expect([403, 404]).toContain(foreign.status)
      const foreignAsset = await api('customerB', `/api/product/demands/attachments/${attachmentId}/link`, { disposition: 'inline' })
      expect([403, 404]).toContain(foreignAsset.status)
      const engineerAction = async (actor: 'engineerA' | 'engineerB', action: string, extra: Json = {}): Promise<void> => {
        const current = object((await success(actor, `/api/engineer/demands/${demandId}`)).demand)
        await success(actor, `/api/engineer/demands/${demandId}/actions`, {
          client_action_id: randomUUID(), revision: number(current.revision), action, ...extra,
        })
      }
      await engineerAction('engineerA', 'accept'); await engineerAction('engineerA', 'start')
      await success('engineerA', `/api/engineer/demands/${demandId}/messages`, { client_message_id: randomUUID(), text: `工程师已接单 ${stamp}`, attachment_ids: [] })
      await chat.getByText(`工程师已接单 ${stamp}`, { exact: true }).waitFor()
      await assertMessageAuthor(chat, `工程师已接单 ${stamp}`, name)
      await assertMedia(page, chat, 'red.png', 'preview.mp4')
      const downloadReady = page.waitForEvent('download')
      await chat.getByRole('button', { name: '下载red.png', exact: true }).click()
      const downloaded = await downloadReady
      expect(downloaded.suggestedFilename()).toBe('red.png'); expect(await downloaded.failure()).toBeNull()
      const originalPath = join(evidence, 'downloaded-red.png')
      await downloaded.saveAs(originalPath); expect(await readFile(originalPath)).toEqual(await readFile(imageFile))
      const oldLink = await success('engineerA', `/api/product/demands/attachments/${attachmentId}/link`, { disposition: 'inline' })
      const adminAction = async (action: string, extra: Json): Promise<void> => {
        const current = object((await success('admin', `/api/demand-management/${demandId}`)).demand)
        await success('admin', `/api/demand-management/${demandId}/actions`, { client_action_id: randomUUID(),
          revision: number(current.revision), action, ...extra })
      }
      await adminAction('internal_note', { text: `INTERNAL-ONLY-${stamp}` })
      const customerMessages = await success('customerA', `/api/product/demands/${demandId}/messages?after_seq=0&limit=100`)
      expect(JSON.stringify(customerMessages)).not.toContain(`INTERNAL-ONLY-${stamp}`)
      await adminAction('assign', { engineer_id: fixture.replacementId })
      expect([403, 404]).toContain((await api('engineerA', `/api/engineer/demands/${demandId}`)).status)
      const signed = new URL(text(oldLink.url), fixture.base)
      if (signed.origin !== fixture.base) throw new Error('Synthetic media capability points outside its fixture')
      const oldContent = await fetch(signed, { redirect: 'error' })
      expect([403, 404]).toContain(oldContent.status); await oldContent.body?.cancel()
      const reassignedChat = service.getByRole('region', { name: `与${replacementName}沟通`, exact: true })
      await reassignedChat.waitFor()
      await assertMessageAuthor(reassignedChat, `工程师已接单 ${stamp}`, name)
      await engineerAction('engineerB', 'accept'); await engineerAction('engineerB', 'start')
      await success('engineerB', `/api/engineer/demands/${demandId}/messages`, { client_message_id: randomUUID(), text: `转派工程师已接手 ${stamp}`, attachment_ids: [] })
      await assertMessageAuthor(reassignedChat, `转派工程师已接手 ${stamp}`, replacementName)
      await engineerAction('engineerB', 'deliver', { text: `真人交付 ${stamp}`, attachment_ids: [] })
      await assertMessageAuthor(reassignedChat, `真人交付 ${stamp}`, replacementName)
      await assertMessageAuthor(reassignedChat, `工程师已接单 ${stamp}`, name)
      await page.screenshot({ path: join(evidence, 'reassigned-historical-and-current-authors.png'), animations: 'disabled' })
      await service.getByRole('button', { name: '确认完成', exact: true }).waitFor()
      await service.getByRole('button', { name: '确认完成', exact: true }).click()
      await service.getByRole('button', { name: '确认验收', exact: true }).click()
      await service.getByText('已验收', { exact: true }).waitFor()
      expect(object((await success('customerA', `/api/product/demands/${demandId}`)).demand).status).toBe('completed')
      expect(await service.getByText(`INTERNAL-ONLY-${stamp}`, { exact: true }).count()).toBe(0)
      await page.screenshot({ path: join(evidence, 'accepted-go-host-browser.png'), animations: 'disabled' })
      expect(diagnostics.pageErrors).toEqual([]); expect(diagnostics.warnings).toEqual([])
      await writeFile(join(evidence, 'result.json'), JSON.stringify({ syntheticOnly: true, demandId,
        verified: ['Go-Host-browser', 'image-preview', 'native-video-play-seek-range', 'original-media-download', 'foreign-owner-rejected',
          'internal-note-hidden', 'reassigned-old-engineer-and-capability-rejected', 'historical-and-current-author-names', 'engineer-delivery-user-acceptance'], paidRequests: 0 }))
    } catch (error) { await saveFailureShot(page, 'demands-real-go'); throw error }
  }, 180_000,
)

it.skipIf(process.env.DSH_DEMAND_DIRECTORY_FIXTURE === undefined)(
  'round-trips a seeded platform service through central assignment and real engineer delivery without modifying profiles', async () => {
    const fixture = await readDirectoryFixture(process.env.DSH_DEMAND_DIRECTORY_FIXTURE ?? '', process.env.DSH_DEMAND_DIRECTORY_READY ?? '')
    const evidence = await artifactDirectory('service-real-go'), stamp = `synthetic-service-${randomUUID()}`
    const { api, success } = syntheticRequests(fixture)
    const overlay = await overlayDirectory({ base: fixture.base, session: fixture.storedSession })
    const scaffold = await launchWebScaffold({ extraOverlayPath: overlay }); onTestFinished(() => scaffold.close())
    const account = object(await (await scaffold.hostFetch('/credits/api/session')).json() as unknown)
    expect(account, 'The new directory fixture must pass the existing product login checks').toMatchObject({ ok: true, signedIn: true, liveness: 'verified' })
    const browser = await chromium.launch(); onTestFinished(() => browser.close())
    const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1320, height: 1000 } })
    const diagnostics = watchConsole(page), privateReads: string[] = []
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (/\/(?:customer-profiles|profile-import)(?:\/|$)/u.test(path)) privateReads.push(path)
    })
    try {
      const catalog = await success('customerA', '/api/product/demands/service-profiles?limit=30')
      expect(catalog.total).toBe(100)
      if (!Array.isArray(catalog.items) || catalog.items.length !== 30) throw new Error('The seeded service directory is not paginated')
      const target = object(catalog.items[0]), profileId = text(target.id), profileName = text(target.display_name)
      const directory = await success('customerA', '/api/product/demands/engineers?limit=30')
      if (!Array.isArray(directory.items)) throw new Error('Real engineer assignment targets are missing')
      const engineer = directory.items.map(object).find(item => item.id === fixture.engineerId)
      if (engineer === undefined) throw new Error('The synthetic assignee is missing')
      const engineerName = text(engineer.display_name)
      const service = await navigateService(page, scaffold.authenticatedUrl, 'services')
      await service.getByText('100 项服务', { exact: true }).waitFor()
      await expect.poll(() => service.getByRole('heading', { level: 2 }).count()).toBe(30)
      const card = service.getByRole('listitem').filter({ has: page.getByRole('heading', { name: profileName, exact: true }) })
      const avatar = card.locator('img').first()
      await expect.poll(() => avatar.evaluate(node => node instanceof HTMLImageElement
        && node.complete && node.naturalWidth > 0)).toBe(true)
      const avatarUrl = new URL(await avatar.getAttribute('src') ?? '', scaffold.baseUrl)
      expect(avatarUrl.origin).toBe(new URL(scaffold.baseUrl).origin)
      expect(avatarUrl.pathname.startsWith('/credits/api/demands/attachments/')).toBe(true)
      expect(avatarUrl.searchParams.has('token')).toBe(false)
      for (const label of ['在线', '忙碌中', '离线']) expect(await service.getByText(label, { exact: true }).count()).toBe(0)
      await page.screenshot({ path: join(evidence, 'seeded-service-directory.png'), animations: 'disabled' })
      await card.getByRole('button', { name: `为${profileName}发布需求`, exact: true }).click()
      let chat = service.getByRole('region', { name: '与平台统一接待沟通', exact: true })
      await chat.getByRole('textbox', { name: '说明需求、预期结果和相关限制', exact: true }).fill(stamp)
      await chat.locator('input[type="file"]').setInputFiles([imageFile, videoFile])
      await expect.poll(() => chat.getByText('待发送', { exact: true }).count()).toBe(2)
      const receiptReady = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname.endsWith('/credits/api/demands'))
      await chat.getByRole('button', { name: '发送', exact: true }).click()
      const submitted = await receiptReady, requestBody = object(submitted.request().postDataJSON() as unknown)
      expect(requestBody.service_profile_id).toBe(profileId); expect(requestBody).not.toHaveProperty('engineer_id')
      const receipt = object(await submitted.json() as unknown), payload = object(receipt.payload), created = object(payload.demand)
      expect(created).toMatchObject({ assigned: false, intake_mode: 'platform', engineer_id: 'platform-intake',
        service_profile_id: profileId, service_profile_name: profileName, status: 'pending' })
      const demandId = text(created.id), initial = object(payload.message)
      if (!Array.isArray(initial.attachments) || initial.attachments.length !== 2) throw new Error('Platform media receipts are missing')
      const attachmentId = text(object(initial.attachments[0]).id)
      await chat.getByRole('textbox', { name: '输入消息', exact: true }).waitFor()
      await chat.getByText('待分配工程师', { exact: true }).waitFor()
      await chat.getByText(`服务：${profileName}`, { exact: true }).waitFor()
      for (const label of ['在线', '忙碌中', '离线']) expect(await chat.getByText(label, { exact: true }).count()).toBe(0)
      expect([403, 404]).toContain((await api('engineerA', `/api/engineer/demands/${demandId}`)).status)
      expect([403, 404]).toContain((await api('engineerA', `/api/product/demands/attachments/${attachmentId}/link`, { disposition: 'inline' })).status)
      const queue = await success('admin', `/api/demand-management?assignment=unassigned&user_id=${fixture.ownerId}&limit=30`)
      if (!Array.isArray(queue.items)) throw new Error('Central assignment queue is missing')
      expect(queue.items.map(object).some(item => item.id === demandId && item.service_profile_id === profileId)).toBe(true)
      await page.screenshot({ path: join(evidence, 'unassigned-go-platform-intake.png'), animations: 'disabled' })
      const beforeAssign = object((await success('admin', `/api/demand-management/${demandId}`)).demand)
      await success('admin', `/api/demand-management/${demandId}/actions`, { client_action_id: randomUUID(),
        revision: number(beforeAssign.revision), action: 'assign', engineer_id: fixture.engineerId })
      chat = service.getByRole('region', { name: `与${engineerName}沟通`, exact: true })
      await chat.waitFor()
      await chat.getByText(`服务：${profileName}`, { exact: true }).waitFor()
      const engineerAction = async (action: string, extra: Json = {}): Promise<void> => {
        const current = object((await success('engineerA', `/api/engineer/demands/${demandId}`)).demand)
        await success('engineerA', `/api/engineer/demands/${demandId}/actions`, { client_action_id: randomUUID(),
          revision: number(current.revision), action, ...extra })
      }
      await engineerAction('accept'); await engineerAction('start')
      await success('engineerA', `/api/engineer/demands/${demandId}/messages`, { client_message_id: randomUUID(),
        text: `已接手平台服务 ${stamp}`, attachment_ids: [] })
      await assertMessageAuthor(chat, `已接手平台服务 ${stamp}`, engineerName)
      await assertMedia(page, chat, 'red.png', 'preview.mp4')
      await engineerAction('deliver', { text: `平台服务交付 ${stamp}`, attachment_ids: [] })
      await assertMessageAuthor(chat, `平台服务交付 ${stamp}`, engineerName)
      await chat.getByRole('button', { name: '确认完成', exact: true }).click()
      await chat.getByRole('button', { name: '确认验收', exact: true }).click()
      await chat.getByText('已验收', { exact: true }).waitFor()
      expect(object((await success('customerA', `/api/product/demands/${demandId}`)).demand)).toMatchObject({
        status: 'completed', assigned: true, service_profile_id: profileId, service_profile_name: profileName, engineer_id: fixture.engineerId,
      })
      await chat.getByText(`服务：${profileName}`, { exact: true }).waitFor()
      await page.screenshot({ path: join(evidence, 'accepted-go-service-source.png'), animations: 'disabled' })
      expect(privateReads).toEqual([])
      expect(diagnostics.pageErrors).toEqual([]); expect(diagnostics.warnings).toEqual([])
      await writeFile(join(evidence, 'result.json'), JSON.stringify({ syntheticOnly: true, demandId, profileId, profileName,
        catalogTotal: 100, profileMutations: 0, verified: ['central-unassigned-queue', 'unassigned-engineer-rejected',
          'admin-assignment', 'real-engineer-author', 'image-video-play-seek-range', 'delivery-acceptance-service-source'], paidRequests: 0 }))
    } catch (error) { await saveFailureShot(page, 'demands-service-real-go'); throw error }
  }, 180_000,
)
