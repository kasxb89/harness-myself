/** Built sidebar actions share one explicit login reminder before dispatching their feature. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished, vi } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

it('keeps Publish request visible and guards every signed-out sidebar action before opening its feature', async () => {
  const cleanup: { scaffold?: () => Promise<void>; browser?: () => Promise<void>; spies?: () => void; page?: Page } = {}
  const evidenceRoot = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
  await mkdir(evidenceRoot, { recursive: true })
  const evidence = await mkdtemp(join(evidenceRoot, 'sidebar-login-reminder-'))
  const requests: { method: string; path: string; signedIn: boolean; ownerVerified: boolean }[] = []
  const writes: string[] = [], external: string[] = [], checked: string[] = []
  onTestFinished(async ({ task }) => {
    try {
      await writeFile(join(evidence, 'requests.json'), JSON.stringify({ checked, requests, writes, external }, null, 2) + '\n', { mode: 0o600 })
      if (task.result?.state === 'fail' && cleanup.page !== undefined && !cleanup.page.isClosed()) {
        await cleanup.page.screenshot({ path: join(evidence, 'failure.png'), animations: 'disabled' })
      }
    } finally {
      cleanup.spies?.()
      try { await cleanup.browser?.() } finally { await cleanup.scaffold?.() }
    }
  })
  const scaffold = await launchWebScaffold({})
  cleanup.scaffold = () => scaffold.close()
  const browser = await chromium.launch()
  cleanup.browser = () => browser.close()
  const browserPage = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1100 } })
  cleanup.page = browserPage
  browserPage.setDefaultTimeout(5000)
  const tripwire = watchConsole(browserPage)
  const origin = new URL(scaffold.baseUrl).origin
  const account = { id: '7', phone: '+8613800000000' }, accountOwner = 'a'.repeat(64)
  let signedIn = false
  const uploadRules = { max_image_bytes: 20_971_520, max_video_bytes: 536_870_912, max_attachments: 8,
    chunk_bytes: 4_194_304, allowed_mime_types: ['image/png', 'video/mp4'], upload_ttl_seconds: 86400 }
  const emptyPage = { items: [], next_cursor: '', has_more: false }
  await browserPage.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url())
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin) {
      external.push(url.origin)
      await route.abort('blockedbyclient')
      return
    }
    if (!url.pathname.startsWith('/credits/api/')) { await route.continue(); return }
    const headers = request.headers()
    requests.push({ method: request.method(), path: url.pathname, signedIn,
      ownerVerified: headers['x-yunshu-account-id'] === account.id && headers['x-yunshu-account-owner'] === accountOwner })
    if (request.method() !== 'GET') {
      writes.push(`${request.method()} ${url.pathname}`)
      await route.abort('blockedbyclient')
      return
    }
    let payload: unknown
    if (url.pathname === '/credits/api/session') {
      payload = { signedIn, creditsPerYuan: 1000, ...signedIn ? { account, accountOwner } : {} }
    } else if (url.pathname === '/credits/api/summary') {
      payload = { balance_points: 2000, as_of: '2026-11-20T00:00:00Z' }
    } else if (url.pathname === '/credits/api/usage') {
      payload = { start: Number(url.searchParams.get('start')), end: Number(url.searchParams.get('end')),
        asOf: '2026-11-20T00:00:00Z', delayMinutes: 0, rows: [] }
    } else if (url.pathname === '/credits/api/creation/content') {
      const mode = { title: { zh: '', en: '' }, description: { zh: '', en: '' },
        promptPlaceholder: { zh: '', en: '' }, categories: [], templates: [], presets: [] }
      payload = { schemaVersion: 1, revision: 'sidebar-login-local', image: mode, video: mode }
    } else if (url.pathname === '/credits/api/announcement-banner') {
      payload = { enabled: false, scope: 'b'.repeat(64), revision: 'c'.repeat(64), announcements: [] }
    } else if (url.pathname === '/credits/api/demands/config') {
      payload = { config: { enabled: true, categories: [], upload_rules: uploadRules }, server_time: 100,
        capabilities: { polling: true, resumable_upload: true } }
    } else if (url.pathname === '/credits/api/demands/engineers') {
      payload = { items: [], server_time: 100 }
    } else if (url.pathname === '/credits/api/demands') {
      payload = { items: [], next_before_id: null, has_more: false }
    } else if (url.pathname === '/credits/api/community-demands/config') {
      payload = { schema_version: 1, enabled: true, publication_policy: 'approval_required', upload_rules: uploadRules,
        capabilities: { community_orders_v1: true, explicit_publication: true, single_acceptor: true,
          resumable_upload: true, private_participant_messages: true, community_approval_v1: true } }
    } else if (url.pathname === '/credits/api/community-demands/listings' || url.pathname === '/credits/api/community-demands/orders'
      || url.pathname === '/credits/api/forum/posts') {
      payload = emptyPage
    } else if (url.pathname === '/credits/api/forum/config') {
      payload = { revision: 1, enabled: true, capabilities: { immediate_publish: true, likes: true, comments: true } }
    } else if (url.pathname === '/credits/api/media/preferences') {
      payload = { schema_version: 1, scope: 'd'.repeat(64), revision: 'e'.repeat(64), image: null, video: null }
    } else {
      await route.fulfill({ status: 404, json: { ok: false, code: 'LOCAL_FIXTURE_UNUSED_READ' } })
      return
    }
    await route.fulfill({ status: 200, json: { ok: true, payload, ...signedIn ? { account, accountOwner } : {} } })
  })
  await browserPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const demandEntry = browserPage.getByRole('button', { name: '需求发布', exact: true })
  await demandEntry.waitFor()
  expect(await browserPage.getByRole('dialog').count()).toBe(0)
  expect(await browserPage.getByRole('button', { name: '检查更新', exact: true }).count()).toBe(0)
  const agents = scaffold.ctx.agents.list().map(agent => agent.id)
  const createAgent = vi.spyOn(scaffold.ctx.agents, 'create')
  const createSession = vi.spyOn(scaffold.ctx.sessions, 'create')
  cleanup.spies = () => { createAgent.mockRestore(); createSession.mockRestore() }
  const reminder = browserPage.getByRole('dialog', { name: '请先登录', exact: true })
  const labels = ['聊天', '数字员工', '产物', 'AI 创作', '需求发布', '广场', '技能商店', '插件',
    '公告', '客服', '手机', '余额', '充值', '设置']
  for (const label of labels) {
    const trigger = browserPage.getByRole('button', { name: label, exact: true })
    await trigger.click()
    await reminder.waitFor()
    expect(await browserPage.getByRole('dialog').count()).toBe(1)
    expect(await reminder.getByText('登录后即可使用该功能', { exact: true }).count()).toBe(1)
    expect(await reminder.getByRole('button', { name: '暂不登录', exact: true }).count()).toBe(1)
    expect(await reminder.getByRole('button', { name: '去登录', exact: true }).count()).toBe(1)
    expect(await browserPage.getByRole('button', { name: '聊天', exact: true }).getAttribute('aria-current')).toBe('page')
    await reminder.getByRole('button', { name: '暂不登录', exact: true }).click()
    await reminder.waitFor({ state: 'detached' })
    await expect.poll(() => trigger.evaluate(element => element === document.activeElement)).toBe(true)
    checked.push(label)
  }
  const newChat = browserPage.getByRole('button', { name: '新建会话', exact: true }).first()
  await newChat.click()
  await reminder.waitFor()
  await expect.poll(() => reminder.evaluate(element => element.contains(document.activeElement))).toBe(true)
  for (let index = 0; index < 4; index++) {
    await browserPage.keyboard.press('Tab')
    expect(await reminder.evaluate(element => element.contains(document.activeElement))).toBe(true)
  }
  await browserPage.keyboard.press('Escape')
  await reminder.waitFor({ state: 'detached' })
  await expect.poll(() => newChat.evaluate(element => element === document.activeElement)).toBe(true)
  checked.push('新建会话（键盘）')
  await demandEntry.click()
  await reminder.getByRole('button', { name: '关闭登录提示', exact: true }).click()
  await reminder.waitFor({ state: 'detached' })
  await expect.poll(() => demandEntry.evaluate(element => element === document.activeElement)).toBe(true)
  await demandEntry.click()
  await reminder.getByRole('button', { name: '去登录', exact: true }).click()
  await reminder.waitFor({ state: 'detached' })
  const phoneForm = browserPage.getByRole('region', { name: '手机号登录', exact: true })
  await phoneForm.waitFor()
  expect(await phoneForm.getByRole('textbox', { name: '手机号', exact: true }).isEnabled()).toBe(true)
  expect(await browserPage.getByRole('dialog').count()).toBe(0)
  const privatePaths = ['demands', 'community-demands', 'forum', 'summary', 'usage', 'recharge', 'assets',
    'media/preferences', 'announcements', 'customer-support'].map(path => `/credits/api/${path}`)
  const guestPrivateReads = requests.filter(request => !request.signedIn
    && privatePaths.some(path => request.path === path || request.path.startsWith(`${path}/`)))
  expect(guestPrivateReads).toEqual([])
  expect(createAgent).not.toHaveBeenCalled()
  expect(createSession).not.toHaveBeenCalled()
  expect(scaffold.ctx.agents.list().map(agent => agent.id)).toEqual(agents)
  expect(writes).toEqual([])
  await browserPage.screenshot({ path: join(evidence, 'explicit-phone-sign-in.png'), animations: 'disabled' })

  signedIn = true
  await browserPage.reload({ waitUntil: 'load' })
  await expect.poll(() => requests.some(request => request.signedIn && request.path === '/credits/api/summary')).toBe(true)
  await browserPage.getByRole('button', { name: '余额', exact: true }).click()
  await browserPage.getByRole('region', { name: '积分余额', exact: true }).getByText('2,000', { exact: true }).waitFor()
  expect(await browserPage.getByRole('dialog').count()).toBe(0)
  await demandEntry.click()
  const tabs = ['需求广场', '论坛中心', '案例展示', '官方定制']
  const emptyViews = [
    ['需求广场', '暂无公开需求', '/credits/api/community-demands/listings'],
    ['论坛中心', '还没有帖子', '/credits/api/forum/posts'],
    ['官方定制', '暂无可用工程师', '/credits/api/demands/engineers'],
  ] as const
  for (const [tab, empty, path] of emptyViews) {
    const trigger = browserPage.getByRole('tab', { name: tab, exact: true })
    await trigger.click()
    expect(await trigger.getAttribute('aria-selected')).toBe('true')
    expect(await browserPage.getByRole('tab').allTextContents()).toEqual(tabs)
    expect(await browserPage.getByRole('dialog').count()).toBe(0)
    await browserPage.getByRole('heading', { name: empty, exact: true }).waitFor()
    expect(requests.some(request => request.signedIn && request.method === 'GET' && request.path === path && request.ownerVerified)).toBe(true)
  }
  await browserPage.getByRole('tab', { name: '案例展示', exact: true }).click()
  await browserPage.getByRole('heading', { name: '暂无案例', exact: true }).waitFor()
  expect(await browserPage.getByRole('dialog').count()).toBe(0)
  expect(createAgent).not.toHaveBeenCalled()
  expect(createSession).not.toHaveBeenCalled()
  expect(writes).toEqual([])
  expect(external).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
  await browserPage.screenshot({ path: join(evidence, 'signed-in-demand-tabs.png'), animations: 'disabled' })
  console.info(`Sidebar login reminder browser evidence: ${evidence}`)
})
