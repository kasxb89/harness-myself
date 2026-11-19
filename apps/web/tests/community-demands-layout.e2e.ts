/** Opt-in compact-layout checks on an existing synthetic community order; never publish or send. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator, type Page, type Response } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const local = '/credits/api/community-demands'
const imageFile = fileURLToPath(new URL('../../../packages/llm/llm-deepseek/tests/fixtures/red.png', import.meta.url))
type Json = Record<string, unknown>
interface Fixture {
  readonly base: string
  readonly id: string
  readonly source: string
  readonly orderId: string
  readonly session: Json
  readonly ownerToken: string
  readonly adminToken: string
  readonly expectedOrders: readonly string[]
  readonly expectedMessageCount: number
}
function object(value: unknown): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid synthetic layout response')
  return value as Json
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new Error('Missing synthetic layout metadata')
  return value
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Invalid synthetic layout number')
  return value
}
function items(value: unknown): Json[] {
  if (!Array.isArray(value)) throw new Error('Missing synthetic layout collection')
  return value.map(object)
}
async function readFixture(): Promise<Fixture> {
  const path = process.env.DSH_COMMUNITY_LAYOUT_FIXTURE ?? '', readyPath = process.env.DSH_COMMUNITY_LAYOUT_READY ?? ''
  const receiptPath = process.env.DSH_COMMUNITY_LAYOUT_CORE_RECEIPT ?? ''
  if (path === '' || readyPath === '' || receiptPath === '') throw new Error('Layout QA requires the private manifest, READY and original passed receipt')
  const ready = object(JSON.parse(await readFile(readyPath, 'utf8')) as unknown)
  const original = object(JSON.parse(await readFile(receiptPath, 'utf8')) as unknown)
  if (ready.schema !== 1 || ready.ready !== true || ready.active !== true || ready.synthetic_only !== true
    || ready.mode !== 'community-interop' || ready.isolated_database !== true || ready.health_http !== 200
    || !/^[a-f0-9]{64}$/u.test(text(ready.database_id)) || ready.source_pushed !== true
    || ready.source_remote_readback !== ready.source_commit) throw new Error('The isolated community fixture is not qualified')
  if (await realpath(path) !== await realpath(resolve(dirname(readyPath), text(ready.private_manifest)))) {
    throw new Error('Layout fixture manifest is not bound to READY')
  }
  const data = object(JSON.parse(await readFile(path, 'utf8')) as unknown), base = new URL(text(data.base_url))
  if (data.schema_version !== 1 || data.fixture_revision !== 3 || data.synthetic_only !== true
    || data.fixture_mode !== 'community-interop' || data.database_id !== ready.database_id || data.pid !== ready.pid
    || data.fixture_id !== ready.fixture_id || data.source_commit !== ready.source_commit || data.base_url !== ready.base_url
    || base.protocol !== 'http:' || base.username !== '' || base.password !== '' || base.pathname !== '/' || base.search !== '' || base.hash !== ''
    || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || ['43321', '43322', '43323', '43451', '43452', '43453', '43611'].includes(base.port) || base.origin === ready.admin_qa_base) {
    throw new Error('Layout fixture identity or loopback authority is inconsistent')
  }
  if (original.schema !== 1 || original.executions !== 1 || original.tests_passed !== 1 || original.exit_code !== 0
    || original.status !== 'SINGLE_REAL_SYNTHETIC_RUN_PASSED_BEFORE_ROOT_R04_CLEANUP'
    || original.fixture_id !== data.fixture_id || original.api_source !== data.source_commit || original.base !== base.origin) {
    throw new Error('Layout QA must use the original passed community order and fixture')
  }
  const orders = object(original.orders), orderId = text(orders.community_primary), auxiliaryId = text(orders.community_auxiliary)
  if (![orderId, auxiliaryId].every(id => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(id))) {
    throw new Error('The original synthetic order identities are invalid')
  }
  const users = object(data.users), tokens = object(data.tokens), bundles = object(data.auth_bundles)
  let expiry = Math.min(integer(data.expires_at), integer(ready.expires_at))
  for (const [name, tokenName, role] of [['owner', 'customerA', 1], ['admin', 'admin', 100]] as const) {
    const user = object(users[name]), bundle = object(bundles[name]), bundleUser = object(bundle.user)
    if (integer(user.id) < 1 || user.role !== role || user.status !== 1 || bundleUser.id !== user.id
      || bundleUser.role !== role || bundle.token_type !== 'Bearer' || bundle.access_token !== text(tokens[tokenName])) {
      throw new Error('Layout QA actor is not a matching normal product session')
    }
    expiry = Math.min(expiry, integer(bundle.access_expires_at))
  }
  if (expiry * 1000 < Date.now() + 300_000) throw new Error('Synthetic layout credentials need owner renewal before the five-minute gate')
  const owner = object(users.owner), ownerBundle = object(bundles.owner)
  const expiresAt = new Date(integer(ownerBundle.access_expires_at) * 1000).toISOString()
  const ownerToken = text(tokens.customerA)
  return { base: base.origin, id: text(data.fixture_id), source: text(data.source_commit), orderId, ownerToken,
    adminToken: text(tokens.admin), expectedOrders: [orderId, auxiliaryId].sort(),
    expectedMessageCount: integer(orders.primary_messages_after),
    session: { token: `synthetic-local-${randomBytes(24).toString('hex')}`, backendBaseUrl: base.origin, expiresAt,
      account: { id: String(integer(owner.id)), phone: text(owner.phone_e164) }, upstream: { token: ownerToken, expiresAt } } }
}
async function get(fixture: Fixture, path: string, admin = false): Promise<Json> {
  if (!path.startsWith('/api/')) throw new Error('Only fixed synthetic API paths are allowed')
  const response = await fetch(fixture.base + path, { redirect: 'error',
    headers: { authorization: `Bearer ${admin ? fixture.adminToken : fixture.ownerToken}`, accept: 'application/json' } })
  const result = object(await response.json() as unknown)
  if (response.status !== 200 || result.success !== true) throw new Error(`Synthetic layout GET failed with HTTP ${response.status}`)
  return object(result.data)
}
async function counts(fixture: Fixture): Promise<Json> {
  const orders = items((await get(fixture, '/api/community-demand-management/orders?limit=100', true)).items)
  const messages = items((await get(fixture, `/api/product/community-demands/orders/${fixture.orderId}/messages?after_seq=0&limit=100`)).items)
  return { orderCount: orders.length, orderIds: orders.map(item => text(item.id)).sort(), messageCount: messages.length,
    messageIds: messages.map(item => text(item.id)).sort() }
}
async function overlay(fixture: Fixture): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'yunshu-community-layout-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const state = join(root, 'state'); await mkdir(state, { mode: 0o700 })
  await writeFile(join(state, 'session.json'), JSON.stringify(fixture.session), { mode: 0o600 })
  const path = join(root, 'cordis.patch.yml')
  await writeFile(path, JSON.stringify([
    { id: 'credits-index', config: { newApiBaseUrl: fixture.base, baseUrl: '', bridgeBaseUrl: '', stateDir: state } },
    { id: 'ui-demands', config: { enabled: true, foregroundPollMs: 1000, backgroundPollMs: 1000, listPollMs: 1000 } },
    ...['dsh-market', 'dsh-skin-market'].map(id => ({ id, disabled: true })),
  ]))
  return path
}
async function reachable(target: Locator): Promise<Json> {
  return await target.evaluate((node) => {
    const box = node.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return { x: box.x, y: box.y, width: box.width, height: box.height,
      inside: box.x >= 0 && box.y >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1,
      hit: hit !== null && (hit === node || node.contains(hit)) }
  })
}
async function compactChat(page: Page, chat: Locator, names: readonly string[], evidence: string, theme: string): Promise<Json> {
  const composer = chat.locator('form'), send = composer.getByRole('button', { name: '发送', exact: true })
  const textarea = chat.getByRole('textbox', { name: '输入消息', exact: true })
  const geometry = await chat.evaluate((node) => {
    const pane = node.querySelector('[role="log"]'), form = node.querySelector('form')
    if (pane === null || form === null) throw new Error('The existing community conversation has no log/composer')
    const box = pane.getBoundingClientRect(), formBox = form.getBoundingClientRect(), extraOwners: string[] = []
    for (let parent = pane.parentElement; parent !== null; parent = parent.parentElement) {
      if (['auto', 'scroll'].includes(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight + 1) {
        extraOwners.push(parent.tagName)
      }
    }
    const composerOwners = Array.from(form.querySelectorAll('*')).filter(element => element.tagName !== 'TEXTAREA'
      && element.querySelector('textarea') !== null && ['auto', 'scroll'].includes(getComputedStyle(element).overflowY)
      && element.scrollHeight > element.clientHeight + 1).map(element => element.tagName)
    return { log: { y: box.y, bottom: box.bottom, height: box.height },
      composer: { y: formBox.y, bottom: formBox.bottom, height: formBox.height },
      extraOwners, composerOwners, formScrolls: ['auto', 'scroll'].includes(getComputedStyle(form).overflowY)
        && form.scrollHeight > form.clientHeight + 1,
      pageScrolls: document.documentElement.scrollHeight > innerHeight + 1,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1, viewport: { width: innerWidth, height: innerHeight } }
  })
  const sendBox = await reachable(send), inputBox = await textarea.boundingBox()
  const uploadLimits = await composer.locator(':scope > p').last().evaluate((node) => {
    const range = document.createRange(); range.selectNodeContents(node)
    const box = range.getBoundingClientRect()
    return { text: node.textContent, x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom,
      inside: box.x >= 0 && box.y >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 }
  })
  await writeFile(join(evidence, `chat-${theme}-geometry.json`), JSON.stringify({
    ...geometry, send: sendBox, textarea: inputBox, uploadLimits,
  }))
  expect(geometry.horizontalOverflow).toBe(false); expect(geometry.pageScrolls).toBe(false)
  expect(geometry.extraOwners).toEqual([]); expect(geometry.composerOwners).toEqual([]); expect(geometry.formScrolls).toBe(false)
  expect(geometry.log.height).toBeGreaterThanOrEqual(100)
  expect(geometry.log.y).toBeGreaterThanOrEqual(0); expect(geometry.log.bottom).toBeLessThanOrEqual(640)
  expect(geometry.composer.y).toBeGreaterThanOrEqual(0); expect(uploadLimits.inside).toBe(true)
  expect(sendBox).toMatchObject({ inside: true, hit: true }); expect(await send.isEnabled()).toBe(true)
  if (inputBox === null) throw new Error('The long draft input is not visible')
  expect(inputBox.height).toBeLessThanOrEqual(160)
  const attachmentButtons: Json[] = []
  for (const name of names) {
    const remove = composer.getByRole('button', { name: `移除${name}`, exact: true })
    await remove.scrollIntoViewIfNeeded()
    const box = await reachable(remove); attachmentButtons.push({ name, ...box })
    expect(box).toMatchObject({ inside: true, hit: true })
    expect(await reachable(send)).toMatchObject({ inside: true, hit: true })
    expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 1)).toBe(false)
  }
  return { ...geometry, send: sendBox, textareaHeight: inputBox.height, attachmentButtons, uploadLimits }
}
async function modalGeometry(dialog: Locator, end: boolean): Promise<Json> {
  return await dialog.evaluate((node, end) => {
    const form = node.querySelector('form'), heading = node.querySelector('h2')
    const submit = node.querySelector('button[type="submit"]')
    const cancel = Array.from(node.querySelectorAll('button')).find(button => button.textContent?.trim() === '取消')
    if (form === null || heading === null || submit === null || cancel === undefined) throw new Error('The public draft dialog is missing its structure')
    const owners: HTMLElement[] = []
    for (let parent = form.parentElement; parent !== null && parent !== node; parent = parent.parentElement) {
      if (['auto', 'scroll'].includes(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight + 1) owners.push(parent)
    }
    const owner = owners[0]
    if (owner !== undefined) owner.scrollTop = end ? owner.scrollHeight : 0
    const headerBox = heading.getBoundingClientRect(), submitBox = submit.getBoundingClientRect(), dialogBox = node.getBoundingClientRect()
    const inside = (box: DOMRect) => box.top >= 0 && box.bottom <= innerHeight + 1 && box.left >= 0 && box.right <= innerWidth + 1
    const hit = document.elementFromPoint(submitBox.x + submitBox.width / 2, submitBox.y + submitBox.height / 2)
    const cancelBox = cancel.getBoundingClientRect(), cancelHit = document.elementFromPoint(
      cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2)
    return { end, bodyScrollOwners: owners.length, bodyScrollTop: owner?.scrollTop ?? 0,
      bodyHasOverflow: owner !== undefined && owner.scrollHeight > owner.clientHeight + 1,
      headerInside: inside(headerBox), footerInside: inside(submitBox), footerHit: hit !== null && (hit === submit || submit.contains(hit)),
      cancelInside: inside(cancelBox), cancelHit: cancelHit !== null && (cancelHit === cancel || cancel.contains(cancelHit)),
      dialogInside: inside(dialogBox), pageScrolls: document.documentElement.scrollHeight > innerHeight + 1,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 }
  }, end)
}

const optedIn = ['DSH_COMMUNITY_LAYOUT_FIXTURE', 'DSH_COMMUNITY_LAYOUT_READY', 'DSH_COMMUNITY_LAYOUT_CORE_RECEIPT']
  .some(key => process.env[key] !== undefined)
it.skipIf(!optedIn)('keeps unsent eight-image drafts and long public-preview dialogs reachable at compact viewport sizes', async () => {
  const fixture = await readFixture(), nonce = `layout-${randomUUID()}`
  const artifactRoot = fileURLToPath(new URL('../../../.artifacts/', import.meta.url)); await mkdir(artifactRoot, { recursive: true })
  const evidence = await mkdtemp(join(artifactRoot, 'community-layout-real-go-'))
  const audit: Json = { schema: 1, status: 'started', nonce, fixtureId: fixture.id, source: fixture.source,
    base: fixture.base, orderId: fixture.orderId, newOrders: 0, newMessages: 0, newAccounts: 0, paidRequests: 0 }
  const checkpoint = async (): Promise<void> => { await writeFile(join(evidence, 'run-audit.json'), JSON.stringify(audit)) }
  const before = await counts(fixture); audit.before = before; await checkpoint()
  expect(before.orderIds).toEqual(fixture.expectedOrders); expect(before.messageCount).toBe(fixture.expectedMessageCount)
  const details = object((await get(fixture, `/api/product/community-demands/orders/${fixture.orderId}`)).order), title = text(details.title)
  const scaffold = await launchWebScaffold({ extraOverlayPath: await overlay(fixture) }); onTestFinished(() => scaffold.close())
  const session = object(await (await scaffold.hostFetch('/credits/api/session')).json() as unknown)
  expect(session).toMatchObject({ ok: true, signedIn: true, liveness: 'verified' })
  const browser = await chromium.launch(); onTestFinished(() => browser.close())
  const context = await browser.newContext({ locale: ZH_BROWSER_LOCALE, viewport: { width: 760, height: 640 } })
  const page = await context.newPage(), diagnostic = watchConsole(page), mutations: Json[] = [], uploads: Json[] = []
  const forbidden: string[] = [], externalOrigins = new Set<string>(), responseTasks: Promise<void>[] = [], responseErrors: string[] = []
  let phase = 'existing-chat'
  await page.route('**/credits/api/community-demands/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method()
    if (!['GET', 'HEAD'].includes(method)) {
      const upload = phase === 'existing-chat' && (method === 'POST' && (path === local + '/uploads'
        || /^\/credits\/api\/community-demands\/uploads\/[^/]+\/complete$/u.test(path))
        || method === 'PUT' && /^\/credits\/api\/community-demands\/uploads\/[^/]+\/content$/u.test(path))
      const read = method === 'POST' && path === local + `/orders/${fixture.orderId}/read`
      mutations.push({ method, path })
      if (!upload && !read) { forbidden.push(method + ' ' + path); await route.abort('blockedbyclient'); return }
    }
    await route.continue()
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) externalOrigins.add(url.origin)
  })
  const captureUpload = async (response: Response): Promise<void> => {
    const request = response.request(), path = new URL(response.url()).pathname
    if (request.method() !== 'POST' || path !== local + '/uploads') return
    const body = object(request.postDataJSON() as unknown), envelope = object(await response.json() as unknown)
    if (envelope.ok !== true) throw new Error('An explicitly selected tiny PNG upload did not initialize')
    const payload = object(envelope.payload)
    uploads.push({ clientUploadId: text(body.client_upload_id), uploadId: text(payload.id), attachmentId: text(payload.attachment_id),
      scope: body.scope, orderId: body.order_id, name: body.name, sizeBytes: body.size_bytes })
    audit.uploads = uploads; await checkpoint()
  }
  page.on('response', response => responseTasks.push(captureUpload(response).catch(() => { responseErrors.push('upload-receipt-invalid') })))
  try {
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '需求发布', exact: true }).click({ timeout: 30_000 })
    const service = page.getByRole('region', { name: '工程师服务', exact: true })
    await service.getByRole('button', { name: `沟通：${title}`, exact: true }).click()
    const chat = service.getByRole('region', { name: `需求沟通：${title}`, exact: true })
    await chat.getByRole('textbox', { name: '输入消息', exact: true }).waitFor()
    const png = await readFile(imageFile), names = Array.from({ length: 8 }, (_, index) => `${nonce}-${index + 1}.png`)
    await chat.locator('input[type="file"]').setInputFiles(names.map(name => ({ name, mimeType: 'image/png', buffer: png })))
    await expect.poll(() => chat.getByText('待发送', { exact: true }).count()).toBe(8)
    await Promise.all(responseTasks)
    expect(responseErrors).toEqual([]); expect(uploads).toHaveLength(8)
    expect(new Set(uploads.map(upload => upload.clientUploadId)).size).toBe(8)
    expect(uploads.every(upload => upload.scope === 'conversation' && upload.orderId === fixture.orderId)).toBe(true)
    const draftText = Array.from({ length: 20 }, () => '合法的长输入草稿，仅检查界面，不发送。'.repeat(15)).join('\n')
    expect(Array.from(draftText).length).toBeLessThanOrEqual(12_000)
    await chat.getByRole('textbox', { name: '输入消息', exact: true }).fill(draftText)
    audit.phase = 'eight-uploads-unsent'; audit.draftCharacters = Array.from(draftText).length; await checkpoint()
    for (const dark of [false, true]) {
      const name = dark ? 'dark' : 'light'
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark)
      await page.screenshot({ path: join(evidence, `chat-760x640-${name}-before-assert.png`), animations: 'disabled' })
      const geometry = await compactChat(page, chat, names, evidence, name)
      await writeFile(join(evidence, `chat-${name}-geometry.json`), JSON.stringify(geometry))
      await page.screenshot({ path: join(evidence, `chat-760x640-${name}.png`), animations: 'disabled' })
    }
    await chat.getByRole('button', { name: '返回需求', exact: true }).click()
    phase = 'public-local-draft'; audit.phase = phase; await checkpoint()
    const create = service.getByRole('button', { name: '新需求', exact: true })
    await create.click()
    const dialog = page.getByRole('dialog', { name: '发布公开需求', exact: true })
    await dialog.getByRole('textbox', { name: '需求标题', exact: true }).fill(`${nonce} 仅本地草稿`)
    await dialog.getByRole('textbox', { name: '公开说明', exact: true }).fill('界'.repeat(4000))
    await dialog.getByRole('checkbox', { name: '公开此需求，允许其他用户接单', exact: true }).check()
    await dialog.getByRole('region', { name: '即将公开的内容', exact: true }).waitFor()
    for (const dark of [false, true]) {
      const name = dark ? 'dark' : 'light'
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark)
      const geometry: Json[] = []
      for (const end of [false, true]) {
        const sample = await modalGeometry(dialog, end); geometry.push(sample)
        await writeFile(join(evidence, `modal-${name}-geometry.json`), JSON.stringify(geometry))
        await page.screenshot({ path: join(evidence, `modal-760x640-${name}-${end ? 'end' : 'top'}.png`), animations: 'disabled' })
        expect(sample).toMatchObject({ footerInside: true, footerHit: true, cancelInside: true, cancelHit: true, dialogInside: true,
          bodyScrollOwners: 1, bodyHasOverflow: true, pageScrolls: false, horizontalOverflow: false })
        if (end) expect(sample.bodyScrollTop).toBeGreaterThan(0)
        else expect(sample.headerInside).toBe(true)
      }
      const category = dialog.getByRole('button', { name: '服务分类 不指定分类', exact: true })
      await category.scrollIntoViewIfNeeded(); await category.focus(); await category.press('Enter')
      await page.getByRole('menuitem', { name: '不指定分类', exact: true }).waitFor()
      await page.keyboard.press('Escape')
      await expect.poll(() => category.evaluate(node => node === document.activeElement)).toBe(true)
      await expect.poll(() => page.getByRole('menuitem', { name: '不指定分类', exact: true }).count()).toBe(0)
      expect(await dialog.isVisible()).toBe(true)
      expect(await dialog.getByRole('textbox', { name: '公开说明', exact: true }).inputValue()).toHaveLength(4000)
    }
    await page.keyboard.press('Escape')
    await expect.poll(() => dialog.count()).toBe(0)
    await expect.poll(() => create.evaluate(node => node === document.activeElement)).toBe(true)
    expect(forbidden).toEqual([]); expect(Array.from(externalOrigins)).toEqual([])
    expect(diagnostic.pageErrors).toEqual([]); expect(diagnostic.warnings).toEqual([])
    audit.status = 'passed'; audit.phase = 'all-layout-checks-complete'
  } catch (error) {
    audit.status = 'failed'
    await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true, animations: 'disabled' })
    throw error
  } finally {
    await Promise.all(responseTasks)
    audit.uploads = uploads; audit.mutations = mutations; audit.forbiddenMutations = forbidden
    audit.externalOrigins = Array.from(externalOrigins)
    const after = await counts(fixture); audit.after = after; await checkpoint()
    expect(after).toEqual(before)
  }
}, 180_000)
