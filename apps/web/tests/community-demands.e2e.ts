/** Opt-in real synthetic Go → independent publisher/acceptor Hosts → browser community flow. */
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator, type Page, type Route } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const imageFile = fileURLToPath(new URL('../../../packages/llm/llm-deepseek/tests/fixtures/red.png', import.meta.url))
const videoFile = fileURLToPath(new URL('./fixtures/sidebar-media/preview.mp4', import.meta.url))
const visualFile = resolve(process.env.DSH_COMMUNITY_VISUAL_COVER
  ?? fileURLToPath(new URL('../../../../selected-xiaohongshu/SELECTED-COMPOSITE.png', import.meta.url)))
const upstream = '/api/product/community-demands'
const local = '/credits/api/community-demands'
const forumUpstream = '/api/product/forum'
const forumLocal = '/credits/api/forum'
type Json = Record<string, unknown>
type Actor = 'publisher' | 'acceptor' | 'observer' | 'admin'
interface Identity { readonly id: number; readonly role: number; readonly token: string; readonly name: string; readonly session: Json }
interface Fixture {
  readonly base: string
  readonly id: string
  readonly source: string
  readonly actors: Readonly<Record<Actor, Identity>>
  readonly legacyEngineer: string | null
  readonly mutations: Json[]
  mutationJournal: string | null
}
function object(value: unknown): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid synthetic community response')
  return value as Json
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new Error('Missing synthetic community metadata')
  return value
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Invalid synthetic community number')
  return value
}
function items(value: unknown): Json[] {
  if (!Array.isArray(value)) throw new Error('Missing synthetic community collection')
  return value.map(object)
}
async function readFixture(path: string, readyPath: string): Promise<Fixture> {
  if (path === '' || readyPath === '') throw new Error('Community interop requires its private manifest and final READY receipt')
  const ready = object(JSON.parse(await readFile(readyPath, 'utf8')) as unknown)
  // The API owner's dedicated READY binds the generic session manifest to this fresh community database.
  // Generic demand/forum manifests alone do not authorize any writes.
  const approval = ready.mode === 'community-approval-interop'
  if (ready.schema !== 1 || ready.ready !== true || ready.synthetic_only !== true || ready.active !== true
    || ready.isolated_database !== true) throw new Error('The fresh isolated community fixture is not qualified')
  if (approval ? ready.purpose !== 'selected-design-approval-ui-interop' || ready.no_production !== true
    || ready.publication_policy !== 'approval_required' || object(ready.capabilities).community_approval_v1 !== true
    : ready.mode !== 'community-interop' || typeof ready.database_id !== 'string'
      || !/^[a-f0-9]{64}$/u.test(ready.database_id) || ready.health_http !== 200 || ready.source_pushed !== true
      || ready.source_remote_readback !== ready.source_commit) throw new Error('The community READY revision is not qualified')
  const counts = object(approval ? ready.initial_counts : ready.counts_at_start)
  for (const key of approval ? ['demand_engineers', 'community_orders', 'community_messages', 'community_attachments',
    'forum_posts', 'forum_comments', 'forum_likes', 'tasks', 'wallet_funding_events']
    : ['demands', 'community_orders', 'community_messages', 'demand_service_profiles',
      'demand_customer_profiles', 'tasks', 'logs', 'wallet_funding_events']) {
    if (counts[key] !== 0) throw new Error('The community fixture was not created with isolated empty business data')
  }
  const manifestPath = await realpath(path)
  if (manifestPath !== await realpath(resolve(dirname(readyPath), text(ready.private_manifest)))) {
    throw new Error('Community manifest does not match its READY receipt')
  }
  const data = object(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown), base = new URL(text(data.base_url))
  if (data.schema_version !== 1 || data.fixture_revision !== (approval ? 1 : 3) || data.synthetic_only !== true
    || (approval ? data.purpose !== ready.purpose : data.fixture_mode !== 'community-interop' || data.database_id !== ready.database_id)
    || data.pid !== ready.pid
    || !/^[a-f0-9]{40}$/u.test(text(data.source_commit)) || text(data.fixture_id) !== text(ready.fixture_id)
    || text(data.source_commit) !== text(ready.source_commit)
    || data.base_url !== ready.base_url || base.protocol !== 'http:' || base.username !== '' || base.password !== ''
    || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.pathname !== '/' || base.search !== '' || base.hash !== '') {
    throw new Error('Community fixture identity, source or loopback authority is inconsistent')
  }
  if (approval) {
    const root = dirname(manifestPath)
    const database = await realpath(text(data.database_path)), storage = await realpath(text(data.storage_root))
    if (base.hostname !== '127.0.0.1' || Number(base.port) !== integer(ready.port) || integer(data.pid) < 1
      || database !== await realpath(text(ready.database_path)) || storage !== await realpath(text(ready.storage_root))
      || dirname(database) !== root || dirname(storage) !== root || ((await stat(manifestPath)).mode & 0o077) !== 0) {
      throw new Error('Approval fixture storage, port or private-manifest ownership is inconsistent')
    }
    const initial = object(data.initial_counts)
    if (counts.users !== 4 || counts.user_sessions !== 4 || initial.users !== 4) throw new Error('Approval fixture users are not fresh')
    for (const name of ['engineers', 'orders', 'messages', 'posts', 'comments', 'likes']) {
      if (initial[name] !== 0) throw new Error('Approval fixture contains prior business records')
    }
  }
  if (['5272fcc1-0d48-44b8-9997-73e7f0119445', '9ea277ad-d09b-4144-a146-b8de44d2a6e8'].includes(text(data.fixture_id))
    || ['43321', '43322', '43323', '43451', '43452', '43453', '43601', '43602', '43611', '55247'].includes(base.port)
    || base.origin === ready.admin_qa_base) {
    throw new Error('Protected directory/manual fixtures cannot be used for community interop')
  }
  const users = object(data.users), tokens = object(data.tokens), bundles = object(data.auth_bundles)
  const identities = {} as Record<Actor, Identity>
  let expiry = Math.min(integer(data.expires_at), integer(ready.expires_at))
  for (const [role, userName, tokenName] of [
    ['publisher', 'owner', 'customerA'], ['acceptor', 'other', 'customerB'],
    ['observer', approval ? 'outsider' : 'engineer', approval ? 'outsider' : 'engineerA'], ['admin', 'admin', 'admin'],
  ] as const) {
    const user = object(users[userName]), bundle = object(bundles[userName]), id = integer(user.id)
    const token = text(tokens[tokenName]), expires = integer(bundle.access_expires_at)
    const identityMatches = approval ? (() => {
      const session = object(bundle.session)
      const claims = object(JSON.parse(Buffer.from(text(token.split('.')[1]), 'base64url').toString('utf8')) as unknown)
      return claims.sub === String(id) && claims.sid === text(session.sid) && integer(claims.exp) === expires
        && session.current === true && typeof session.login_method === 'string'
    })() : integer(object(bundle.user).id) === id && object(bundle.user).role === user.role
    if (id < 1 || user.status !== 1 || !identityMatches
      || bundle.token_type !== 'Bearer' || bundle.access_token !== token
      || role !== 'admin' && user.role !== 1 || role === 'admin' && integer(user.role) < 10) {
      throw new Error('Community identity is not a matching ordinary-user/admin product session')
    }
    expiry = Math.min(expiry, expires)
    if (typeof user.phone_e164 !== 'string' || user.phone_e164 === '') {
      throw new Error('The normal synthetic account phone_e164 must be present before launching its Host')
    }
    identities[role] = { id, role: integer(user.role), token, name: text(user.display_name), session: {
      token: `synthetic-local-${randomBytes(24).toString('hex')}`, backendBaseUrl: base.origin,
      expiresAt: new Date(expires * 1000).toISOString(), account: { id: String(id), phone: user.phone_e164 },
      upstream: { token, expiresAt: new Date(expires * 1000).toISOString() },
    } }
  }
  if (new Set(Object.values(identities).map(actor => actor.id)).size !== 4
    || new Set(Object.values(identities).map(actor => actor.token)).size !== 4
    || expiry * 1000 < Date.now() + 300_000) throw new Error('Community identities overlap or their sessions are expiring')
  return { base: base.origin, id: text(data.fixture_id), source: text(data.source_commit), actors: identities,
    legacyEngineer: approval ? null : text(object(data.engineers).engineer), mutations: [], mutationJournal: null }
}
function recordMutation(fixture: Fixture, mutation: Json): void {
  if (fixture.mutationJournal === null) throw new Error('Synthetic business mutation journal is not ready')
  appendFileSync(fixture.mutationJournal, JSON.stringify(mutation) + '\n', { encoding: 'utf8', mode: 0o600 })
  fixture.mutations.push(mutation)
}
function requests(fixture: Fixture): {
  api: (actor: Actor, path: string, body?: Json) => Promise<{ status: number; data: Json }>
  success: (actor: Actor, path: string, body?: Json) => Promise<Json>
} {
  const api = async (actor: Actor, path: string, body?: Json): Promise<{ status: number; data: Json }> => {
    if (!path.startsWith('/api/')) throw new Error('Only fixed synthetic API paths are allowed')
    if (body !== undefined) recordMutation(fixture, { channel: 'direct-api', actor, method: 'POST', path, body })
    const response = await fetch(fixture.base + path, { redirect: 'error', method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${fixture.actors[actor].token}`, accept: 'application/json',
        ...body === undefined ? {} : { 'content-type': 'application/json' } },
      ...body === undefined ? {} : { body: JSON.stringify(body) } })
    return { status: response.status, data: object(await response.json() as unknown) }
  }
  const success = async (actor: Actor, path: string, body?: Json): Promise<Json> => {
    const result = await api(actor, path, body)
    if (result.status < 200 || result.status >= 300 || result.data.success !== true) {
      throw new Error(`Synthetic community ${actor} API failed with HTTP ${result.status}`)
    }
    return object(result.data.data)
  }
  return { api, success }
}
async function overlayDirectory(fixture: Fixture, actor: 'publisher' | 'acceptor'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `yunshu-community-${actor}-`))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const state = join(root, 'state'); await mkdir(state, { mode: 0o700 })
  await writeFile(join(state, 'session.json'), JSON.stringify(fixture.actors[actor].session), { mode: 0o600 })
  const overlay = join(root, 'cordis.patch.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'credits-index', config: { newApiBaseUrl: fixture.base, baseUrl: '', bridgeBaseUrl: '', stateDir: state } },
    { id: 'ui-demands', config: { enabled: true, foregroundPollMs: 1000, backgroundPollMs: 1000, listPollMs: 1000 } },
    ...['dsh-market', 'dsh-skin-market'].map(id => ({ id, disabled: true })),
  ]))
  return overlay
}
async function openWorkspace(page: Page, url: string): Promise<Locator> {
  await page.goto(url, { waitUntil: 'load' })
  await page.getByRole('button', { name: '需求发布', exact: true }).click({ timeout: 30_000 })
  const service = page.getByRole('region', { name: '工程师服务', exact: true })
  await service.getByRole('tab', { name: '需求广场', exact: true }).waitFor()
  await service.getByRole('heading', { name: '需求广场', exact: true }).waitFor()
  expect(await service.getByRole('group', { name: '需求范围', exact: true }).count()).toBe(0)
  await service.getByRole('button', { name: '发布需求', exact: true }).waitFor()
  return service
}
async function responsePayload(page: Page, path: string, action: () => Promise<void>, prefix = local,
  method: 'POST' | 'PUT' = 'POST'): Promise<{ body: Json; payload: Json }> {
  // Consume the body as soon as the response arrives. Waiting for the click's navigation/UI
  // work first can let Chromium evict the completed network resource (large cover uploads).
  const waiting = page.waitForResponse(response => response.request().method() === method
    && new URL(response.url()).pathname === prefix + path).then(async (response) => {
    const body = object(response.request().postDataJSON() as unknown)
    const failure = await response.finished()
    if (failure !== null) throw failure
    const envelope = object(await response.json() as unknown)
    expect(envelope.ok).toBe(true)
    return { body, payload: object(envelope.payload) }
  })
  const [receipt] = await Promise.all([waiting, action()])
  return receipt
}
async function send(chat: Locator, page: Page, id: string, content: string, media = false): Promise<Json> {
  await chat.getByRole('textbox', { name: '输入消息', exact: true }).fill(content)
  if (media) {
    await chat.locator('input[type="file"]').setInputFiles([imageFile, videoFile])
    await expect.poll(() => chat.getByText('待发送', { exact: true }).count()).toBe(2)
  }
  const sent = await responsePayload(page, `/orders/${id}/messages`, async () => {
    await chat.getByRole('button', { name: '发送', exact: true }).click()
  })
  return object(sent.payload.message)
}
async function author(chat: Locator, content: string, role: 'publisher' | 'acceptor' | 'admin', name: string): Promise<void> {
  const message = chat.locator(`article[data-author-kind="${role}"]`).filter({ has: chat.page().getByText(content, { exact: true }) })
  await message.waitFor()
  const labels = { publisher: '发布人', acceptor: '接单用户', admin: '平台管理员' }
  await expect.poll(() => message.getByText(`${name} · ${labels[role]}`, { exact: true }).count()).toBe(1)
}
async function media(page: Page, message: Locator, evidence: string, prefix: string): Promise<void> {
  const image = message.getByRole('img', { name: 'red.png', exact: true })
  await expect.poll(() => image.evaluate(node => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0)).toBe(true)
  const imageUrl = new URL(text(await image.getAttribute('src')), page.url())
  expect(imageUrl.origin).toBe(new URL(page.url()).origin)
  expect(imageUrl.pathname.startsWith(local + '/attachments/')).toBe(true)
  expect(imageUrl.searchParams.has('token')).toBe(false)
  expect(imageUrl.searchParams.has('account_owner')).toBe(true)
  await message.getByRole('button', { name: '预览red.png', exact: true }).click()
  const lightbox = page.getByRole('dialog', { name: '图片预览', exact: true })
  await lightbox.waitFor()
  await expect.poll(() => lightbox.getByRole('img').evaluate(node => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0)).toBe(true)
  await lightbox.getByRole('button', { name: '关闭', exact: true }).click()
  const video = message.locator('video')
  expect(await video.getAttribute('aria-label')).toBe('preview.mp4')
  await video.scrollIntoViewIfNeeded()
  await expect.poll(() => video.evaluate(node => node instanceof HTMLVideoElement
    && Number.isFinite(node.duration) && node.duration > 0)).toBe(true)
  await video.evaluate(async (node) => {
    if (!(node instanceof HTMLVideoElement) || !node.controls) throw new Error('Community video controls are missing')
    node.muted = true; await node.play()
  })
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
  const target = await video.evaluate((node) => {
    const element = node as HTMLVideoElement
    element.pause(); element.currentTime = element.duration * 0.6
    return element.currentTime
  })
  await expect.poll(() => video.evaluate((node, seconds) => {
    const element = node as HTMLVideoElement
    return !element.seeking && Math.abs(element.currentTime - seconds) < 0.2
  }, target)).toBe(true)
  const range = await video.evaluate(async (node) => {
    const url = (node as HTMLVideoElement).currentSrc
    const response = await fetch(url, { headers: { range: 'bytes=0-31' }, cache: 'no-store' })
    const head = await fetch(url, { method: 'HEAD', cache: 'no-store' })
    return { status: response.status, bytes: (await response.arrayBuffer()).byteLength,
      contentRange: response.headers.get('content-range'), headStatus: head.status, headBytes: (await head.arrayBuffer()).byteLength }
  })
  expect(range).toMatchObject({ status: 206, bytes: 32, headStatus: 200, headBytes: 0 })
  expect(range.contentRange).toMatch(/^bytes 0-31\/\d+$/u)
  for (const [name, original] of [['red.png', imageFile], ['preview.mp4', videoFile]] as const) {
    const downloadReady = page.waitForEvent('download')
    await message.getByRole('button', { name: `下载${name}`, exact: true }).click()
    const download = await downloadReady
    expect(download.suggestedFilename()).toBe(name)
    const destination = join(evidence, `${prefix}-${name}`)
    await download.saveAs(destination)
    expect(await readFile(destination)).toEqual(await readFile(original))
  }
}

const optedIn = process.env.DSH_COMMUNITY_DEMAND_FIXTURE !== undefined || process.env.DSH_COMMUNITY_DEMAND_READY !== undefined
it.skipIf(!optedIn)('round-trips explicit public demands and private peer media through two real account-owned Hosts', async () => {
  const fixture = await readFixture(process.env.DSH_COMMUNITY_DEMAND_FIXTURE ?? '', process.env.DSH_COMMUNITY_DEMAND_READY ?? '')
  expect((await readFile(visualFile)).subarray(0, 8)).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'))
  const { api, success } = requests(fixture)
  for (const actor of ['publisher', 'acceptor', 'observer', 'admin'] as const) {
    const self = await success(actor, '/api/user/self')
    expect(integer(self.id)).toBe(fixture.actors[actor].id)
    expect(integer(self.role)).toBe(fixture.actors[actor].role)
  }
  const config = await success('publisher', upstream + '/config')
  expect(config).toMatchObject({ schema_version: 1, enabled: true, capabilities: { community_orders_v1: true,
    explicit_publication: true, single_acceptor: true, resumable_upload: true, private_participant_messages: true,
    community_approval_v1: true }, publication_policy: 'approval_required' })
  const root = fileURLToPath(new URL('../../../.artifacts/', import.meta.url)); await mkdir(root, { recursive: true })
  const evidence = await mkdtemp(join(root, 'community-real-go-')), stamp = `synthetic-community-${randomUUID()}`
  const audit: Json = { schema: 1, status: 'started', fixtureId: fixture.id, source: fixture.source,
    base: fixture.base, nonce: stamp, syntheticOnly: true, paidRequests: 0 }
  fixture.mutationJournal = join(evidence, 'business-mutations.PRIVATE.jsonl')
  await writeFile(fixture.mutationJournal, '', { mode: 0o600 })
  audit.mutations = fixture.mutations; audit.businessMutationJournal = fixture.mutationJournal
  const checkpoint = async (): Promise<void> => { await writeFile(join(evidence, 'run-audit.json'), JSON.stringify(audit), { mode: 0o600 }) }
  await checkpoint()
  const publisher = await launchWebScaffold({ extraOverlayPath: await overlayDirectory(fixture, 'publisher') })
  onTestFinished(() => publisher.close())
  const acceptor = await launchWebScaffold({ extraOverlayPath: await overlayDirectory(fixture, 'acceptor') })
  onTestFinished(() => acceptor.close())
  expect(publisher.baseUrl).not.toBe(acceptor.baseUrl)
  expect(publisher.persistenceRoot).not.toBe(acceptor.persistenceRoot)
  for (const host of [publisher, acceptor]) {
    const account = object(await (await host.hostFetch('/credits/api/session')).json() as unknown)
    expect(account).toMatchObject({ ok: true, signedIn: true, liveness: 'verified' })
  }
  const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  const browser = await chromium.launch(executable ? { executablePath: executable } : undefined)
  onTestFinished(() => browser.close())
  const publisherContext = await browser.newContext({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1320, height: 1000 },
    acceptDownloads: true })
  const acceptorContext = await browser.newContext({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1320, height: 1000 },
    acceptDownloads: true })
  const publisherPage = await publisherContext.newPage(), acceptorPage = await acceptorContext.newPage()
  const diagnostics = [watchConsole(publisherPage), watchConsole(acceptorPage)]
  const exposedCredentials: string[] = [], privateReads: string[] = []
  for (const page of [publisherPage, acceptorPage]) page.on('request', (request) => {
    const url = new URL(request.url())
    if ((url.pathname.startsWith(local) || url.pathname.startsWith(forumLocal))
      && (request.headers().authorization !== undefined || url.searchParams.has('token'))) exposedCredentials.push(url.pathname)
    if ((url.pathname.startsWith(local) || url.pathname.startsWith(forumLocal))
      && ['POST', 'PUT'].includes(request.method()) && request.headers()['content-type']?.includes('application/json')) {
      recordMutation(fixture, { channel: 'browser-host', actor: page === publisherPage ? 'publisher' : 'acceptor',
        method: request.method(), path: url.pathname, body: object(request.postDataJSON() as unknown) })
    }
    if (/\/(?:customer-profiles|profile-import)(?:\/|$)/u.test(url.pathname)) privateReads.push(url.pathname)
  })
  try {
    const initialOrders = items((await success('admin', '/api/community-demand-management/orders?limit=100')).items)
    audit.initialCommunityOrderCount = initialOrders.length; await checkpoint()
    expect(initialOrders).toEqual([])
    const forumConfig = await success('publisher', forumUpstream + '/config')
    expect(forumConfig).toMatchObject({ enabled: true, capabilities: { immediate_publish: true, likes: true, comments: true } })
    const initialForum = await success('publisher', forumUpstream + '/posts?limit=100')
    audit.initialForumCount = items(initialForum.items).length; await checkpoint()
    expect(items(initialForum.items)).toEqual([])
    if (initialForum.total !== undefined) expect(initialForum.total).toBe(0)
    const initialLegacy = items((await success('publisher', '/api/product/demands?limit=100')).items)
    audit.initialPrivateDemandCount = initialLegacy.length; await checkpoint()
    expect(initialLegacy).toEqual([])
    const secret = `private-legacy-${stamp}`
    let legacyEngineer = fixture.legacyEngineer
    if (legacyEngineer === null) {
      const engineer = await success('admin', '/api/demand-management/engineers', {
        user_id: fixture.actors.observer.id, display_name: `Synthetic legacy engineer ${stamp}`, category_ids: [],
        enabled: true, published: true, accepting: true, capacity: 20, revision: 0,
      })
      legacyEngineer = text(engineer.id)
      audit.createdLegacyEngineerId = legacyEngineer; await checkpoint()
    }
    const legacy = object((await success('publisher', '/api/product/demands', { client_request_id: randomUUID(),
      engineer_id: legacyEngineer, title: secret, text: secret, attachment_ids: [] })).demand)
    audit.legacyId = legacy.id; audit.phase = 'legacy-created'; await checkpoint()
    const noConsent = await api('publisher', upstream + '/orders', { client_request_id: randomUUID(),
      publish_to_community: false, title: stamp, public_summary: stamp, public_attachment_ids: [], private_attachment_ids: [] })
    expect(noConsent.status).toBe(400); expect(noConsent.data.code).toBe('COMMUNITY_EXPLICIT_PUBLICATION_REQUIRED')
    const before = await success('acceptor', upstream + '/listings?q=' + encodeURIComponent(stamp))
    expect(items(before.items)).toEqual([])
    const publisherUI = await openWorkspace(publisherPage, publisher.authenticatedUrl)
    const acceptorUI = await openWorkspace(acceptorPage, acceptor.authenticatedUrl)
    await publisherUI.getByRole('button', { name: '发布需求', exact: true }).click()
    const publication = publisherPage.getByRole('dialog', { name: '发布公开需求', exact: true })
    await publication.getByRole('textbox', { name: '需求标题', exact: true }).fill(stamp)
    await publication.getByRole('textbox', { name: '公开说明', exact: true }).fill(`公开说明 ${stamp}`)
    const budget = '¥6,000–9,000', expectedDate = '2026-12-08'
    await publication.getByRole('textbox', { name: '预期预算', exact: true }).fill(budget)
    await publication.getByLabel('预期交付', { exact: true }).fill(expectedDate)
    await publication.getByRole('button', { name: '官方定制', exact: true }).waitFor()
    await publication.locator('input[type="file"]').setInputFiles([imageFile, videoFile])
    await expect.poll(() => publication.getByText('待发送', { exact: true }).count()).toBe(2)
    expect(await publication.getByRole('button', { name: '提交审核', exact: true }).isDisabled()).toBe(true)
    await publication.getByRole('checkbox', { name: '审核通过后公开此需求，允许其他用户接单', exact: true }).check()
    const preview = publication.getByRole('region', { name: '即将公开的内容', exact: true })
    await preview.getByText(stamp, { exact: true }).waitFor()
    await preview.getByText(expectedDate, { exact: true }).waitFor()
    const created = await responsePayload(publisherPage, '/orders', async () => {
      await publication.getByRole('button', { name: '提交审核', exact: true }).click()
    })
    expect(created.body.publish_to_community).toBe(true)
    expect(created.body.public_budget).toBe(budget)
    expect(created.body.expected_delivery_date).toBe(expectedDate)
    const order = object(created.payload.order), id = text(order.id)
    audit.orderId = id; audit.createKey = created.body.client_request_id; audit.phase = 'public-order-created'; await checkpoint()
    expect(order).toMatchObject({ my_role: 'publisher', acceptor: null, status: 'open',
      listing: { approval_status: 'pending', public_budget: budget, expected_delivery_date: expectedDate } })
    const publisherChat = publisherUI.getByRole('region', { name: `需求沟通：${stamp}`, exact: true })
    await publisherChat.waitFor()
    const pendingPage = await success('acceptor', upstream + '/listings?q=' + encodeURIComponent(stamp))
    expect(items(pendingPage.items)).toEqual([])
    expect((await api('observer', upstream + `/listings/${id}`)).status).toBe(404)
    const blockedClaim = await api('acceptor', upstream + `/orders/${id}/accept`, { client_action_id: randomUUID() })
    expect(blockedClaim.status).toBe(409); expect(blockedClaim.data.code).toBe('COMMUNITY_APPROVAL_REQUIRED')
    expect((await api('observer', upstream + `/attachments/${text(items(object(order.listing).public_attachments)[0]?.id)}/link`,
      { disposition: 'inline' })).status).toBe(404)
    await publisherChat.getByRole('button', { name: '返回需求', exact: true }).click()
    await publisherUI.getByRole('button', { name: '我的需求', exact: true }).click()
    const ownedCard = publisherUI.getByRole('list', { name: '我的需求', exact: true }).locator('li')
      .filter({ has: publisherPage.getByRole('heading', { name: stamp, exact: true }) })
    await ownedCard.getByText('审核中', { exact: true }).waitFor()
    await publisherPage.screenshot({ path: join(evidence, 'owner-pending-review.png'), animations: 'disabled' })
    const rejectionReason = `仅本次隔离测试的明确驳回说明 ${stamp}`
    const rejected = await reject(fixture, id, rejectionReason)
    audit.rejection = { actionId: rejected.key, reason: rejectionReason, orderId: id, revision: rejected.revision }
    audit.phase = 'main-order-rejected'; await checkpoint()
    await publisherUI.getByRole('button', { name: '我的需求', exact: true }).click()
    await ownedCard.getByText('未通过审核', { exact: true }).waitFor()
    await ownedCard.getByText(rejectionReason, { exact: true }).waitFor()
    await publisherPage.screenshot({ path: join(evidence, 'owner-rejected-review-reason.png'), animations: 'disabled' })
    const rejectedPage = await success('observer', upstream + '/listings?q=' + encodeURIComponent(stamp))
    expect(items(rejectedPage.items)).toEqual([])
    expect(JSON.stringify(rejectedPage)).not.toContain(rejectionReason)
    expect((await api('observer', upstream + `/listings/${id}`)).status).toBe(404)
    expect((await api('observer', upstream + `/attachments/${text(items(object(order.listing).public_attachments)[0]?.id)}/link`,
      { disposition: 'inline' })).status).toBe(404)
    const rejectedClaim = await api('observer', upstream + `/orders/${id}/accept`, { client_action_id: randomUUID() })
    expect(rejectedClaim.status).toBe(409); expect(rejectedClaim.data.code).toBe('COMMUNITY_APPROVAL_REQUIRED')
    await ownedCard.getByRole('button', { name: stamp, exact: true }).click()
    await publisherChat.waitFor()
    const approved = await approve(fixture, id)
    audit.approvalActionId = approved.key; audit.phase = 'main-order-approved'; await checkpoint()
    const createReplay = await success('publisher', upstream + '/orders', created.body)
    expect(createReplay.replayed).toBe(true); expect(object(createReplay.order).id).toBe(id)
    const publicPage = await success('acceptor', upstream + '/listings?q=' + encodeURIComponent(stamp))
    expect(items(publicPage.items).map(item => item.id)).toEqual([id])
    expect(JSON.stringify(publicPage)).not.toContain(secret)
    expect(items(publicPage.items).some(item => item.id === legacy.id)).toBe(false)
    const listing = object((await success('acceptor', upstream + `/listings/${id}`)).listing)
    expect(listing).not.toHaveProperty('private_text'); expect(listing).not.toHaveProperty('acceptor')
    const publicVideo = items(listing.public_attachments).find(item => item.kind === 'video')
    if (publicVideo === undefined) throw new Error('The public listing video is missing')
    const publicLink = await success('observer', upstream + `/attachments/${text(publicVideo.id)}/link`, { disposition: 'inline' })
    const publicUrl = new URL(text(publicLink.url))
    expect(publicUrl.origin).toBe(fixture.base)
    expect(publicUrl.pathname).toBe(upstream + `/attachments/${text(publicVideo.id)}/content`)
    const publicRange = await fetch(publicUrl, { redirect: 'error', headers: { range: 'bytes=0-31' } })
    expect(publicRange.status).toBe(206)
    expect(Buffer.from(await publicRange.arrayBuffer())).toEqual((await readFile(videoFile)).subarray(0, 32))
    expect((await api('acceptor', upstream + `/orders/${id}`)).status).toBe(404)
    expect((await api('publisher', upstream + `/orders/${id}/accept`, { client_action_id: randomUUID() })).status).toBe(403)
    await acceptorUI.getByRole('button', { name: '搜索需求', exact: true }).click()
    await acceptorUI.getByRole('searchbox', { name: '搜索需求', exact: true }).fill(stamp)
    const card = acceptorUI.getByRole('list', { name: '公开需求', exact: true }).locator('li').filter({ has: acceptorPage.getByRole('heading', { name: stamp, exact: true }) })
    await card.getByText(budget, { exact: true }).waitFor()
    await card.getByText(expectedDate, { exact: true }).waitFor()
    await card.getByText(`公开说明 ${stamp}`, { exact: true }).waitFor()
    await captureLayouts(acceptorPage, acceptorUI, evidence, 'approved-demand-square')
    await acceptorUI.getByRole('button', { name: `查看详情：${stamp}`, exact: true }).click()
    const detail = acceptorPage.getByRole('dialog', { name: '公开需求详情', exact: true })
    await detail.getByText(`公开说明 ${stamp}`, { exact: true }).waitFor()
    await detail.getByText(budget, { exact: true }).waitFor()
    await detail.getByText(expectedDate, { exact: true }).waitFor()
    await detail.getByRole('img', { name: 'red.png', exact: true }).waitFor()
    const claimed = await responsePayload(acceptorPage, `/orders/${id}/accept`, async () => {
      await detail.getByRole('button', { name: '接单并沟通', exact: true }).click()
    })
    audit.acceptKey = claimed.body.client_action_id; audit.phase = 'main-order-accepted'; await checkpoint()
    expect(object(claimed.payload.order)).toMatchObject({ id, my_role: 'acceptor', status: 'accepted',
      acceptor: { id: fixture.actors.acceptor.id } })
    const acceptorChat = acceptorUI.getByRole('region', { name: `需求沟通：${stamp}`, exact: true })
    await acceptorChat.waitFor()
    const claimReplay = await success('acceptor', upstream + `/orders/${id}/accept`, claimed.body)
    expect(claimReplay.replayed).toBe(true); expect(object(claimReplay.order).id).toBe(id)
    expect((await api('publisher', upstream + `/orders/${id}/accept`, { client_action_id: randomUUID() })).status).toBe(403)
    const publisherText = `发布人私聊 ${stamp}`, acceptorText = `接单人私聊 ${stamp}`
    const firstMessage = await send(publisherChat, publisherPage, id, publisherText, true)
    audit.publisherMessageId = firstMessage.id; audit.phase = 'publisher-media-sent'; await checkpoint()
    await author(acceptorChat, publisherText, 'publisher', fixture.actors.publisher.name)
    const received = acceptorChat.locator('article[data-author-kind="publisher"]').filter({ has: acceptorPage.getByText(publisherText, { exact: true }) })
    await media(acceptorPage, received, evidence, 'publisher')
    const secondMessage = await send(acceptorChat, acceptorPage, id, acceptorText, true)
    audit.acceptorMessageId = secondMessage.id; audit.phase = 'acceptor-media-sent'; await checkpoint()
    await author(publisherChat, acceptorText, 'acceptor', fixture.actors.acceptor.name)
    const reply = publisherChat.locator('article[data-author-kind="acceptor"]').filter({ has: publisherPage.getByText(acceptorText, { exact: true }) })
    await media(publisherPage, reply, evidence, 'acceptor')
    // This observer is a role=1 product User that also owns a legacy engineer profile.
    // The community namespace must not grant that profile any extra private-order access.
    expect((await api('observer', upstream + `/orders/${id}`)).status).toBe(404)
    expect((await api('observer', upstream + `/orders/${id}/messages?after_seq=0&limit=100`)).status).toBe(404)
    expect((await api('observer', upstream + `/orders/${id}/accept`, { client_action_id: randomUUID() })).status).toBe(409)
    for (const message of [firstMessage, secondMessage]) {
      for (const attachment of items(message.attachments)) {
        const denied = await api('observer', upstream + `/attachments/${text(attachment.id)}/link`, { disposition: 'inline' })
        expect(denied.status).toBe(404)
      }
    }
    // A separate explicit synthetic order tests atomic contention without replacing the main UI acceptor.
    const auxiliary = object((await success('publisher', upstream + '/orders', { client_request_id: randomUUID(),
      publish_to_community: true, title: `接单竞争 ${stamp}`, public_summary: '仅用于独立合成接单并发验证',
      public_attachment_ids: [], private_attachment_ids: [], private_text: '', public_budget: '' })).order)
    audit.auxiliaryOrderId = auxiliary.id; audit.phase = 'auxiliary-order-created'; await checkpoint()
    const auxiliaryId = text(auxiliary.id), competingActors = ['acceptor', 'observer'] as const
    await approve(fixture, auxiliaryId)
    const competition = await Promise.all(competingActors.map(async actor => ({ actor,
      ...await api(actor, upstream + `/orders/${auxiliaryId}/accept`, { client_action_id: randomUUID() }),
    })))
    audit.raceResults = competition.map(result => ({ actor: result.actor, status: result.status }))
    audit.phase = 'acceptance-race-complete'; await checkpoint()
    expect(competition.map(result => result.status).sort()).toEqual([200, 409])
    const winner = competition.find(result => result.status === 200), loser = competition.find(result => result.status === 409)
    if (winner === undefined || loser === undefined) throw new Error('Atomic community acceptance did not produce one winner')
    expect(loser.data.code).toBe('COMMUNITY_ALREADY_ACCEPTED')
    const winningOrder = object(object(winner.data.data).order)
    expect(winningOrder.id).toBe(auxiliaryId)
    expect(object(winningOrder.acceptor).id).toBe(fixture.actors[winner.actor].id)
    expect((await api(loser.actor, upstream + `/orders/${auxiliaryId}`)).status).toBe(404)
    const adminPath = `/api/community-demand-management/orders/${id}`
    expect(object((await success('admin', adminPath)).order)).toMatchObject({ id, my_role: 'admin',
      publisher: { id: fixture.actors.publisher.id }, acceptor: { id: fixture.actors.acceptor.id } })
    const all = await success('admin', '/api/community-demand-management/orders?limit=100')
    expect(items(all.items).some(item => item.id === id)).toBe(true)
    expect(items(all.items).filter(item => item.id === auxiliaryId)).toHaveLength(1)
    const transcript = await success('admin', adminPath + '/messages?after_seq=0&limit=100')
    expect(items(transcript.items).map(item => item.id)).toContain(firstMessage.id)
    expect(items(transcript.items).map(item => item.id)).toContain(secondMessage.id)
    for (const message of [firstMessage, secondMessage]) {
      for (const attachment of items(message.attachments)) {
        const attachmentId = text(attachment.id)
        expect(attachment.scope).toBe('conversation')
        const signed = await success('admin', `/api/community-demand-management/attachments/${attachmentId}/link`, { disposition: 'attachment' })
        const url = new URL(text(signed.url))
        expect(url.origin).toBe(fixture.base)
        expect(url.pathname).toBe(upstream + `/attachments/${attachmentId}/content`)
        const response = await fetch(url, { redirect: 'error', headers: { range: 'bytes=0-31' } })
        expect(response.status).toBe(206)
        const original = attachment.name === 'red.png' ? imageFile : attachment.name === 'preview.mp4' ? videoFile : null
        if (original === null) throw new Error('The synthetic transcript contains an unexpected attachment')
        expect(Buffer.from(await response.arrayBuffer())).toEqual((await readFile(original)).subarray(0, 32))
      }
    }
    const adminText = `平台回复 ${stamp}`
    await success('admin', adminPath + '/messages', { client_message_id: randomUUID(), text: adminText, attachment_ids: [] })
    await author(publisherChat, adminText, 'admin', fixture.actors.admin.name)
    await author(acceptorChat, adminText, 'admin', fixture.actors.admin.name)
    await unknownMessage(publisherPage, publisherChat, id, `回执丢失 ${stamp}`, fixture, evidence)
    await publisherPage.screenshot({ path: join(evidence, 'publisher-community-chat.png'), animations: 'disabled' })
    await acceptorPage.screenshot({ path: join(evidence, 'acceptor-community-chat.png'), animations: 'disabled' })
    for (const layout of [
      { width: 1320, dark: false, name: 'wide-light' }, { width: 1320, dark: true, name: 'wide-dark' },
      { width: 760, dark: false, name: 'narrow-light' }, { width: 760, dark: true, name: 'narrow-dark' },
    ]) {
      await publisherPage.setViewportSize({ width: layout.width, height: 1000 })
      await publisherPage.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), layout.dark)
      expect(await publisherPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
      expect(await publisherChat.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      await publisherPage.screenshot({ path: join(evidence, `community-chat-${layout.name}.png`), animations: 'disabled' })
    }
    audit.forum = await forumFlow(fixture, publisherPage, publisherUI, acceptorPage, acceptorUI, evidence, stamp)
    audit.phase = 'forum-roundtrip-complete'; await checkpoint()
    const visualOrders: Json[] = []
    audit.visualOrders = visualOrders; await checkpoint()
    audit.visualGrid = await visualGrid(fixture, publisherPage, publisherUI, acceptorPage, acceptorUI,
      evidence, stamp, visualOrders, checkpoint)
    const expectedFinalOrderIds = [id, auxiliaryId, ...visualOrders.map(item => text(item.orderId))]
    audit.expectedFinalOrderIds = expectedFinalOrderIds; audit.phase = 'visual-grid-complete'; await checkpoint()
    expect(exposedCredentials).toEqual([]); expect(privateReads).toEqual([])
    for (const diagnostic of diagnostics) { expect(diagnostic.pageErrors).toEqual([]); expect(diagnostic.warnings).toEqual([]) }
    const finalOrders = items((await success('admin', '/api/community-demand-management/orders?limit=100')).items)
    audit.finalCommunityOrderCount = finalOrders.length; audit.finalCommunityOrderIds = finalOrders.map(item => item.id)
    audit.finalMainMessageCount = items((await success('admin', adminPath + '/messages?after_seq=0&limit=100')).items).length
    expect(finalOrders.map(item => item.id).sort()).toEqual([...expectedFinalOrderIds].sort())
    audit.status = 'passed'; audit.phase = 'all-checks-complete'; await checkpoint()
    await writeFile(join(evidence, 'result.json'), JSON.stringify({ syntheticOnly: true, fixtureId: fixture.id, source: fixture.source,
      orderId: id, legacyId: legacy.id, verified: ['explicit-publication', 'legacy-private-not-public', 'two-independent-hosts',
        'approval-required-before-list-detail-claim', 'same-order-pending-reject-approve', 'owner-rejection-reason-private',
        'admin-revision-bound-real-approval', 'budget-delivery-date-roundtrip',
        'ordinary-user-acceptor', 'atomic-two-user-claim-one-winner', 'observer-private-acl-denied', 'public-scope-range-access', 'original-create-and-accept-key-replay', 'immutable-publisher-acceptor-admin-authors', 'bidirectional-image-mp4',
        'play-seek-range-head-original-download', 'admin-all-order-transcript', 'lost-message-response-original-uuid',
        'real-forum-post-reply-like', 'forum-original-uuid-receipts', 'forum-modal-close-escape-draft-retention', 'wide-narrow-light-dark',
        'four-real-approved-cover-orders', 'computed-four-column-cover-grid'],
      auxiliaryOrderId: auxiliaryId, acceptanceRace: { attempts: 2, successes: 1, conflicts: 1, winner: winner.actor },
      approvalActionId: approved.key, rejection: audit.rejection, budget, expectedDeliveryDate: expectedDate, forum: audit.forum,
      visualOrders, visualGrid: audit.visualGrid, expectedFinalOrderIds,
      observerAccountHadLegacyEngineerProfile: true, observerExtraCommunityPermissions: false, paidRequests: 0 }))
  } catch (error) {
    audit.status = 'failed'; await checkpoint()
    await saveFailureShot(publisherPage, 'community-publisher-real-go')
    await saveFailureShot(acceptorPage, 'community-acceptor-real-go')
    throw error
  }
}, 480_000)

async function approve(fixture: Fixture, id: string): Promise<{ key: string }> {
  const { success } = requests(fixture)
  const path = `/api/community-demand-management/orders/${id}`
  const current = object((await success('admin', path)).order)
  const key = randomUUID(), body = { client_action_id: key, revision: integer(current.revision),
    action: 'approve_listing', reason: 'Synthetic isolated UI approval review' }
  const approved = await success('admin', path + '/actions', body), order = object(approved.order)
  expect(approved.replayed).toBe(false)
  expect(order).toMatchObject({ id, listing: { approval_status: 'approved' } })
  expect(integer(order.revision)).toBe(integer(current.revision) + 1)
  const replay = await success('admin', path + '/actions', body)
  expect(replay.replayed).toBe(true)
  expect(object(replay.order)).toMatchObject({ id, revision: order.revision })
  return { key }
}

async function reject(fixture: Fixture, id: string, reason: string): Promise<{ key: string; revision: number }> {
  const { success } = requests(fixture)
  const path = `/api/community-demand-management/orders/${id}`
  const current = object((await success('admin', path)).order)
  const key = randomUUID(), body = { client_action_id: key, revision: integer(current.revision), action: 'reject_listing', reason }
  const rejected = await success('admin', path + '/actions', body), order = object(rejected.order)
  expect(rejected.replayed).toBe(false)
  expect(order).toMatchObject({ id, status: 'open', acceptor: null,
    listing: { approval_status: 'rejected', approval_reason: reason } })
  const revision = integer(order.revision)
  expect(revision).toBe(integer(current.revision) + 1)
  const replay = await success('admin', path + '/actions', body)
  expect(replay.replayed).toBe(true)
  expect(object(replay.order)).toMatchObject({ id, revision })
  return { key, revision }
}

async function captureLayouts(page: Page, region: Locator, evidence: string, prefix: string): Promise<void> {
  for (const layout of [
    { width: 1320, dark: false, name: 'wide-light' }, { width: 1320, dark: true, name: 'wide-dark' },
    { width: 760, dark: false, name: 'narrow-light' }, { width: 760, dark: true, name: 'narrow-dark' },
  ]) {
    await page.setViewportSize({ width: layout.width, height: 1000 })
    await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), layout.dark)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    expect(await region.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: join(evidence, `${prefix}-${layout.name}.png`), animations: 'disabled' })
  }
  await page.setViewportSize({ width: 1320, height: 1000 })
  await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
}

async function visualGrid(fixture: Fixture, publisherPage: Page, publisherUI: Locator,
  acceptorPage: Page, acceptorUI: Locator, evidence: string, stamp: string,
  records: Json[], checkpoint: () => Promise<void>): Promise<Json> {
  await publisherUI.getByRole('tab', { name: '需求广场', exact: true }).click()
  const variants = [
    { budget: '¥6,000–9,000', date: '2026-12-08', brief: '企业官网布局与封面展示，仅用于隔离视觉验收' },
    { budget: '¥1,500–3,000', date: '2026-11-28', brief: '商品图与素材整理需求，仅用于隔离视觉验收' },
    { budget: '¥5,000–8,000', date: '2026-12-12', brief: '活动报名流程需求，仅用于隔离视觉验收' },
    { budget: '¥2,000–4,000', date: '2026-12-02', brief: '短视频剪辑工作流需求，仅用于隔离视觉验收' },
  ]
  for (const [index, variant] of variants.entries()) {
    const title = `synthetic视觉验收 ${index + 1} ${stamp}`
    await publisherUI.getByRole('button', { name: '发布需求', exact: true }).click()
    const dialog = publisherPage.getByRole('dialog', { name: '发布公开需求', exact: true })
    await dialog.getByRole('textbox', { name: '需求标题', exact: true }).fill(title)
    await dialog.getByRole('textbox', { name: '公开说明', exact: true }).fill(variant.brief)
    await dialog.getByRole('textbox', { name: '预期预算', exact: true }).fill(variant.budget)
    await dialog.getByLabel('预期交付', { exact: true }).fill(variant.date)
    await dialog.locator('input[type="file"]').setInputFiles(visualFile)
    await expect.poll(() => dialog.getByText('待发送', { exact: true }).count()).toBe(1)
    await dialog.getByRole('checkbox', { name: '审核通过后公开此需求，允许其他用户接单', exact: true }).check()
    const created = await responsePayload(publisherPage, '/orders', async () => {
      await dialog.getByRole('button', { name: '提交审核', exact: true }).click()
    })
    const order = object(created.payload.order), id = text(order.id), listing = object(order.listing)
    expect(listing).toMatchObject({ approval_status: 'pending', public_budget: variant.budget, expected_delivery_date: variant.date })
    const attachments = items(listing.public_attachments)
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({ kind: 'image', scope: 'listing' })
    const record: Json = { orderId: id, title, createKey: text(created.body.client_request_id), budget: variant.budget,
      expectedDeliveryDate: variant.date, attachmentIds: attachments.map(item => text(item.id)), approvalActionId: null }
    records.push(record); await checkpoint()
    const approved = await approve(fixture, id)
    record.approvalActionId = approved.key; await checkpoint()
    const chat = publisherUI.getByRole('region', { name: `需求沟通：${title}`, exact: true })
    await chat.waitFor()
    await chat.getByRole('button', { name: '返回需求', exact: true }).click()
  }
  expect(new Set(records.map(item => text(item.orderId))).size).toBe(4)
  expect(new Set(records.map(item => text(item.createKey))).size).toBe(4)
  await acceptorUI.getByRole('tab', { name: '需求广场', exact: true }).click()
  const list = acceptorUI.getByRole('list', { name: '公开需求', exact: true })
  for (const record of records) {
    const card = list.locator('li').filter({ has: acceptorPage.getByRole('heading', { name: text(record.title), exact: true }) })
    await card.getByText(text(record.budget), { exact: true }).waitFor()
    await card.getByText(text(record.expectedDeliveryDate), { exact: true }).waitFor()
    await expect.poll(() => card.locator('img').evaluate(node => node instanceof HTMLImageElement
      && node.complete && node.naturalWidth > 0)).toBe(true)
  }
  await captureLayouts(acceptorPage, acceptorUI, evidence, 'four-approved-cover-cards')
  const columnCount = () => list.evaluate(node => getComputedStyle(node).gridTemplateColumns.split(/\s+/u).filter(Boolean).length)
  let fourColumnWidth = 1320
  if (await columnCount() !== 4) {
    fourColumnWidth = 1560
    await acceptorPage.setViewportSize({ width: fourColumnWidth, height: 1000 })
  }
  await expect.poll(columnCount).toBe(4)
  for (const dark of [false, true]) {
    await acceptorPage.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), dark)
    expect(await list.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    expect(await acceptorPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    await acceptorPage.screenshot({ path: join(evidence, `four-column-${fourColumnWidth}-${dark ? 'dark' : 'light'}.png`),
      animations: 'disabled' })
  }
  await acceptorPage.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
  return { created: records.length, computedColumns: await columnCount(), fourColumnWidth, actualCoverUploads: 4 }
}

async function forumFlow(fixture: Fixture, publisherPage: Page, publisherUI: Locator,
  acceptorPage: Page, acceptorUI: Locator, evidence: string, stamp: string): Promise<Json> {
  const { success } = requests(fixture)
  for (const [page, ui] of [[publisherPage, publisherUI], [acceptorPage, acceptorUI]] as const) {
    await page.setViewportSize({ width: 1320, height: 1000 })
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
    await ui.getByRole('tab', { name: '论坛中心', exact: true }).click()
    await ui.getByRole('heading', { name: '论坛中心', exact: true }).waitFor()
    await ui.getByRole('heading', { name: '还没有帖子', exact: true }).waitFor()
  }
  const postRequests: string[] = []
  publisherPage.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === forumLocal + '/posts') {
      postRequests.push(text(request.postData()))
    }
  })
  const title = `工作流经验 ${stamp}`, body = `这篇讨论只属于本次隔离验证 ${stamp}\n\n我们想把重复的表格汇总自动化，保留原始数据，并按周生成报表。大家通常会先整理哪些字段？`
  await publisherUI.getByRole('button', { name: '发帖', exact: true }).click()
  let composer = publisherPage.getByRole('dialog', { name: '发帖', exact: true })
  await composer.getByRole('textbox', { name: '帖子标题', exact: true }).fill(title)
  await composer.getByRole('textbox', { name: '帖子正文', exact: true }).fill(body)
  await publisherPage.keyboard.press('Escape')
  await composer.waitFor({ state: 'hidden' })
  expect(postRequests).toEqual([])
  await publisherUI.getByRole('button', { name: '继续编辑帖子', exact: true }).click()
  composer = publisherPage.getByRole('dialog', { name: '发帖', exact: true })
  expect(await composer.getByRole('textbox', { name: '帖子标题', exact: true }).inputValue()).toBe(title)
  expect(await composer.getByRole('textbox', { name: '帖子正文', exact: true }).inputValue()).toBe(body)
  const created = await responsePayload(publisherPage, '/posts', async () => {
    await composer.getByRole('button', { name: '发布帖子', exact: true }).click()
  }, forumLocal)
  const post = object(created.payload.post), id = text(post.id)
  expect(post).toMatchObject({ title, body, author: { id: fixture.actors.publisher.id }, like_count: 0, comment_count: 0 })
  expect(postRequests).toHaveLength(1)
  const replay = await success('publisher', forumUpstream + '/posts', created.body)
  expect(replay.replayed).toBe(true); expect(object(replay.post).id).toBe(id)
  const reading = publisherPage.getByRole('dialog', { name: title, exact: true })
  await reading.getByRole('heading', { name: title, exact: true }).waitFor()
  await reading.getByRole('button', { name: '关闭', exact: true }).click()
  await reading.waitFor({ state: 'hidden' })
  const publisherForum = publisherUI.getByRole('region', { name: '论坛中心', exact: true })
  await publisherForum.getByRole('button', { name: `查看帖子：${title}`, exact: true }).waitFor()
  await captureLayouts(publisherPage, publisherForum, evidence, 'forum-note-feed')
  const open = acceptorUI.getByRole('button', { name: `查看帖子：${title}`, exact: true })
  await open.waitFor()
  await open.click()
  const detail = acceptorPage.getByRole('dialog', { name: title, exact: true })
  await detail.getByText(body, { exact: true }).waitFor()
  const replyBody = `这是接单用户的独立公开回复 ${stamp}`
  await detail.getByRole('textbox', { name: '回复内容', exact: true }).fill(replyBody)
  await acceptorPage.keyboard.press('Escape')
  await detail.waitFor({ state: 'hidden' })
  expect(await open.evaluate(node => node === document.activeElement)).toBe(true)
  await open.click()
  await detail.waitFor()
  expect(await detail.getByRole('textbox', { name: '回复内容', exact: true }).inputValue()).toBe(replyBody)
  const replied = await responsePayload(acceptorPage, `/posts/${id}/comments`, async () => {
    await detail.getByRole('button', { name: '发表回复', exact: true }).click()
  }, forumLocal)
  const comment = object(replied.payload.comment)
  expect(comment).toMatchObject({ post_id: id, body: replyBody, author: { id: fixture.actors.acceptor.id } })
  await detail.getByText(replyBody, { exact: true }).waitFor()
  const commentReplay = await success('acceptor', forumUpstream + `/posts/${id}/comments`, replied.body)
  expect(commentReplay.replayed).toBe(true); expect(object(commentReplay.comment).id).toBe(comment.id)
  const liked = await responsePayload(acceptorPage, `/posts/${id}/like`, async () => {
    await detail.getByRole('button', { name: '点赞 0', exact: true }).click()
  }, forumLocal, 'PUT')
  expect(liked.body).toEqual({ liked: true })
  expect(object(liked.payload.post)).toMatchObject({ id, liked: true, like_count: 1 })
  expect(await detail.getByRole('button', { name: '已点赞 1', exact: true }).getAttribute('aria-pressed')).toBe('true')
  const comments = items((await success('admin', forumUpstream + `/posts/${id}/comments?limit=100`)).items)
  expect(comments.map(item => item.id)).toEqual([comment.id])
  const posts = items((await success('publisher', forumUpstream + '/posts?limit=100')).items)
  expect(posts.map(item => item.id)).toEqual([id])
  expect(object((await success('acceptor', forumUpstream + `/posts/${id}`)).post)).toMatchObject({
    id, liked: true, like_count: 1, comment_count: 1,
  })
  await captureLayouts(acceptorPage, detail, evidence, 'forum-reading-modal')
  await detail.getByRole('button', { name: '关闭', exact: true }).click()
  await detail.waitFor({ state: 'hidden' })
  return { postId: id, commentId: comment.id, originalPostKey: created.body.client_request_id,
    originalCommentKey: replied.body.client_request_id, initialPosts: 0, finalPosts: posts.length,
    finalComments: comments.length, liked: true, postReplay: true, commentReplay: true,
    closedPostDraftPreserved: true, closedReplyDraftPreserved: true, modalCloseAndEscape: true }
}

async function unknownMessage(page: Page, chat: Locator, id: string, content: string, fixture: Fixture, evidence: string): Promise<void> {
  const originals: string[] = [], committed: Json[] = []
  let release: (() => void) | undefined, holdReads = true
  const gate = new Promise<void>((resolve) => { release = resolve })
  const pattern = '**/credits/api/community-demands/orders/' + id + '/messages*'
  const handler = async (route: Route): Promise<void> => {
    if (route.request().method() === 'GET' && holdReads) { await gate; await route.continue(); return }
    if (route.request().method() !== 'POST' || object(route.request().postDataJSON() as unknown).text !== content) {
      await route.continue(); return
    }
    originals.push(text(route.request().postData()))
    const response = await route.fetch({ maxRetries: 0 })
    const body = object(await response.json() as unknown)
    expect(body.ok).toBe(true); committed.push(object(body.payload))
    await writeFile(join(evidence, 'unknown-message-attempts.json'), JSON.stringify({ originals,
      receipts: committed.map(receipt => ({ replayed: receipt.replayed, message: receipt.message })) }))
    if (originals.length === 1) { await response.dispose(); await route.abort('failed') }
    else { holdReads = false; release?.(); await route.fulfill({ response }); await response.dispose() }
  }
  await page.route(pattern, handler)
  try {
    await chat.getByRole('textbox', { name: '输入消息', exact: true }).fill(content)
    await chat.getByRole('button', { name: '发送', exact: true }).click()
    const pending = chat.locator('article[data-author-kind="publisher"]').filter({ has: page.getByText(content, { exact: true }) })
    await pending.getByText('发送结果待确认', { exact: true }).waitFor()
    expect(originals).toHaveLength(1)
    await pending.getByRole('button', { name: '核对原发送结果', exact: true }).click()
    await expect.poll(() => committed.length).toBe(2)
    await pending.getByText('已发送', { exact: true }).waitFor()
    expect(originals[1]).toBe(originals[0])
    expect(committed[1]?.replayed).toBe(true)
    const first = object(committed[0]?.message), replay = object(committed[1]?.message)
    expect(replay.id).toBe(first.id); expect(replay.seq).toBe(first.seq)
    const key = object(JSON.parse(text(originals[0])) as unknown).client_message_id
    expect(first.client_message_id).toBe(key)
    const { success } = requests(fixture)
    const messages = items((await success('publisher', upstream + `/orders/${id}/messages?after_seq=0&limit=100`)).items)
    expect(messages.filter(message => message.client_message_id === key)).toHaveLength(1)
    await writeFile(join(evidence, 'unknown-message.json'), JSON.stringify({ originalKey: key, attempts: originals.length,
      sameBody: originals[0] === originals[1], sameMessageId: first.id === replay.id,
      sameSeq: first.seq === replay.seq, matchingMessages: 1 }))
  } finally { holdReads = false; release?.(); await page.unroute(pattern, handler) }
}
