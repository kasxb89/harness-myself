/** Opt-in real synthetic Go → independent publisher/acceptor Hosts → browser community flow. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator, type Page, type Route } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const imageFile = fileURLToPath(new URL('../../../packages/llm/llm-deepseek/tests/fixtures/red.png', import.meta.url))
const videoFile = fileURLToPath(new URL('./fixtures/sidebar-media/preview.mp4', import.meta.url))
const upstream = '/api/product/community-demands'
const local = '/credits/api/community-demands'
type Json = Record<string, unknown>
type Actor = 'publisher' | 'acceptor' | 'observer' | 'admin'
interface Identity { readonly id: number; readonly token: string; readonly name: string; readonly session: Json }
interface Fixture {
  readonly base: string
  readonly id: string
  readonly source: string
  readonly actors: Readonly<Record<Actor, Identity>>
  readonly legacyEngineer: string
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
  if (ready.schema !== 1 || ready.ready !== true || ready.synthetic_only !== true || ready.active !== true
    || ready.mode !== 'community-interop' || ready.isolated_database !== true || typeof ready.database_id !== 'string'
    || !/^[a-f0-9]{64}$/u.test(ready.database_id) || ready.health_http !== 200 || ready.source_pushed !== true
    || ready.source_remote_readback !== ready.source_commit) throw new Error('The fresh isolated community fixture is not qualified')
  const counts = object(ready.counts_at_start)
  for (const key of ['demands', 'community_orders', 'community_messages', 'demand_service_profiles',
    'demand_customer_profiles', 'tasks', 'logs', 'wallet_funding_events']) {
    if (counts[key] !== 0) throw new Error('The community fixture was not created with isolated empty business data')
  }
  const manifestPath = await realpath(path)
  if (manifestPath !== await realpath(resolve(dirname(readyPath), text(ready.private_manifest)))) {
    throw new Error('Community manifest does not match its READY receipt')
  }
  const data = object(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown), base = new URL(text(data.base_url))
  if (data.schema_version !== 1 || data.fixture_revision !== 3 || data.synthetic_only !== true
    || data.fixture_mode !== 'community-interop' || data.database_id !== ready.database_id || data.pid !== ready.pid
    || !/^[a-f0-9]{40}$/u.test(text(data.source_commit)) || text(data.fixture_id) !== text(ready.fixture_id)
    || text(data.source_commit) !== text(ready.source_commit)
    || data.base_url !== ready.base_url || base.protocol !== 'http:' || base.username !== '' || base.password !== ''
    || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.pathname !== '/' || base.search !== '' || base.hash !== '') {
    throw new Error('Community fixture identity, source or loopback authority is inconsistent')
  }
  if (['43321', '43322', '43323', '43451', '43452', '43453', '43611'].includes(base.port)
    || base.origin === ready.admin_qa_base) {
    throw new Error('Protected directory/manual fixtures cannot be used for community interop')
  }
  const users = object(data.users), tokens = object(data.tokens), bundles = object(data.auth_bundles)
  const identities = {} as Record<Actor, Identity>
  let expiry = Math.min(integer(data.expires_at), integer(ready.expires_at))
  for (const [role, userName, tokenName] of [
    ['publisher', 'owner', 'customerA'], ['acceptor', 'other', 'customerB'],
    ['observer', 'engineer', 'engineerA'], ['admin', 'admin', 'admin'],
  ] as const) {
    const user = object(users[userName]), bundle = object(bundles[userName]), id = integer(user.id), bundleUser = object(bundle.user)
    const token = text(tokens[tokenName]), expires = integer(bundle.access_expires_at)
    if (id < 1 || user.status !== 1 || integer(bundleUser.id) !== id || bundleUser.role !== user.role
      || bundle.token_type !== 'Bearer' || bundle.access_token !== token
      || role !== 'admin' && user.role !== 1 || role === 'admin' && integer(user.role) < 10) {
      throw new Error('Community identity is not a matching ordinary-user/admin product session')
    }
    expiry = Math.min(expiry, expires)
    identities[role] = { id, token, name: text(user.display_name), session: {
      token: `synthetic-local-${randomBytes(24).toString('hex')}`, backendBaseUrl: base.origin,
      expiresAt: new Date(expires * 1000).toISOString(), account: { id: String(id), phone: text(user.phone_e164) },
      upstream: { token, expiresAt: new Date(expires * 1000).toISOString() },
    } }
  }
  if (new Set(Object.values(identities).map(actor => actor.id)).size !== 4
    || new Set(Object.values(identities).map(actor => actor.token)).size !== 4
    || expiry * 1000 < Date.now() + 300_000) throw new Error('Community identities overlap or their sessions are expiring')
  return { base: base.origin, id: text(data.fixture_id), source: text(data.source_commit), actors: identities,
    legacyEngineer: text(object(data.engineers).engineer) }
}
function requests(fixture: Fixture): {
  api: (actor: Actor, path: string, body?: Json) => Promise<{ status: number; data: Json }>
  success: (actor: Actor, path: string, body?: Json) => Promise<Json>
} {
  const api = async (actor: Actor, path: string, body?: Json): Promise<{ status: number; data: Json }> => {
    if (!path.startsWith('/api/')) throw new Error('Only fixed synthetic API paths are allowed')
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
  await service.getByRole('tab', { name: '个人需求', exact: true }).waitFor()
  await service.getByRole('group', { name: '需求范围', exact: true }).waitFor()
  return service
}
async function responsePayload(page: Page, path: string, action: () => Promise<void>): Promise<{ body: Json; payload: Json }> {
  const waiting = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === local + path)
  await action()
  const response = await waiting, envelope = object(await response.json() as unknown)
  expect(envelope.ok).toBe(true)
  return { body: object(response.request().postDataJSON() as unknown), payload: object(envelope.payload) }
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
  const { api, success } = requests(fixture)
  for (const actor of ['publisher', 'acceptor', 'observer', 'admin'] as const) {
    const self = await success(actor, '/api/user/self')
    expect(integer(self.id)).toBe(fixture.actors[actor].id)
  }
  const config = await success('publisher', upstream + '/config')
  expect(config).toMatchObject({ schema_version: 1, enabled: true, capabilities: { community_orders_v1: true,
    explicit_publication: true, single_acceptor: true, resumable_upload: true, private_participant_messages: true } })
  const root = fileURLToPath(new URL('../../../.artifacts/', import.meta.url)); await mkdir(root, { recursive: true })
  const evidence = await mkdtemp(join(root, 'community-real-go-')), stamp = `synthetic-community-${randomUUID()}`
  const audit: Json = { schema: 1, status: 'started', fixtureId: fixture.id, source: fixture.source,
    base: fixture.base, nonce: stamp, syntheticOnly: true, paidRequests: 0 }
  const checkpoint = async (): Promise<void> => { await writeFile(join(evidence, 'run-audit.json'), JSON.stringify(audit)) }
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
  const browser = await chromium.launch(); onTestFinished(() => browser.close())
  const publisherContext = await browser.newContext({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1320, height: 1000 },
    acceptDownloads: true })
  const acceptorContext = await browser.newContext({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1320, height: 1000 },
    acceptDownloads: true })
  const publisherPage = await publisherContext.newPage(), acceptorPage = await acceptorContext.newPage()
  const diagnostics = [watchConsole(publisherPage), watchConsole(acceptorPage)]
  const exposedCredentials: string[] = [], privateReads: string[] = []
  for (const page of [publisherPage, acceptorPage]) page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith(local) && (request.headers().authorization !== undefined || url.searchParams.has('token'))) exposedCredentials.push(url.pathname)
    if (/\/(?:customer-profiles|profile-import)(?:\/|$)/u.test(url.pathname)) privateReads.push(url.pathname)
  })
  try {
    const initialOrders = items((await success('admin', '/api/community-demand-management/orders?limit=100')).items)
    audit.initialCommunityOrderCount = initialOrders.length; await checkpoint()
    expect(initialOrders).toEqual([])
    const secret = `private-legacy-${stamp}`
    const legacy = object((await success('publisher', '/api/product/demands', { client_request_id: randomUUID(),
      engineer_id: fixture.legacyEngineer, title: secret, text: secret, attachment_ids: [] })).demand)
    audit.legacyId = legacy.id; audit.phase = 'legacy-created'; await checkpoint()
    const noConsent = await api('publisher', upstream + '/orders', { client_request_id: randomUUID(),
      publish_to_community: false, title: stamp, public_summary: stamp, public_attachment_ids: [], private_attachment_ids: [] })
    expect(noConsent.status).toBe(400); expect(noConsent.data.code).toBe('COMMUNITY_EXPLICIT_PUBLICATION_REQUIRED')
    const before = await success('acceptor', upstream + '/listings?q=' + encodeURIComponent(stamp))
    expect(items(before.items)).toEqual([])
    const publisherUI = await openWorkspace(publisherPage, publisher.authenticatedUrl)
    const acceptorUI = await openWorkspace(acceptorPage, acceptor.authenticatedUrl)
    await publisherUI.getByRole('button', { name: '新需求', exact: true }).click()
    const publication = publisherPage.getByRole('dialog', { name: '发布公开需求', exact: true })
    await publication.getByRole('textbox', { name: '需求标题', exact: true }).fill(stamp)
    await publication.getByRole('textbox', { name: '公开说明', exact: true }).fill(`公开说明 ${stamp}`)
    await publication.getByRole('button', { name: '官方定制', exact: true }).waitFor()
    await publication.locator('input[type="file"]').setInputFiles([imageFile, videoFile])
    await expect.poll(() => publication.getByText('待发送', { exact: true }).count()).toBe(2)
    expect(await publication.getByRole('button', { name: '公开发布需求', exact: true }).isDisabled()).toBe(true)
    await publication.getByRole('checkbox', { name: '公开此需求，允许其他用户接单', exact: true }).check()
    const preview = publication.getByRole('region', { name: '即将公开的内容', exact: true })
    await preview.getByText(stamp, { exact: true }).waitFor()
    const created = await responsePayload(publisherPage, '/orders', async () => {
      await publication.getByRole('button', { name: '公开发布需求', exact: true }).click()
    })
    expect(created.body.publish_to_community).toBe(true)
    const order = object(created.payload.order), id = text(order.id)
    audit.orderId = id; audit.createKey = created.body.client_request_id; audit.phase = 'public-order-created'; await checkpoint()
    expect(order).toMatchObject({ my_role: 'publisher', acceptor: null, status: 'open' })
    const publisherChat = publisherUI.getByRole('region', { name: `需求沟通：${stamp}`, exact: true })
    await publisherChat.waitFor()
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
    await acceptorUI.getByRole('button', { name: '公开需求', exact: true }).click()
    await acceptorUI.getByRole('searchbox', { name: '搜索需求', exact: true }).fill(stamp)
    await acceptorUI.getByRole('button', { name: `查看需求：${stamp}`, exact: true }).click()
    const detail = acceptorPage.getByRole('dialog', { name: '公开需求详情', exact: true })
    await detail.getByText(`公开说明 ${stamp}`, { exact: true }).waitFor()
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
    expect(exposedCredentials).toEqual([]); expect(privateReads).toEqual([])
    for (const diagnostic of diagnostics) { expect(diagnostic.pageErrors).toEqual([]); expect(diagnostic.warnings).toEqual([]) }
    const finalOrders = items((await success('admin', '/api/community-demand-management/orders?limit=100')).items)
    audit.finalCommunityOrderCount = finalOrders.length; audit.finalCommunityOrderIds = finalOrders.map(item => item.id)
    audit.finalMainMessageCount = items((await success('admin', adminPath + '/messages?after_seq=0&limit=100')).items).length
    expect(finalOrders.map(item => item.id).sort()).toEqual([id, auxiliaryId].sort())
    audit.status = 'passed'; audit.phase = 'all-checks-complete'; await checkpoint()
    await writeFile(join(evidence, 'result.json'), JSON.stringify({ syntheticOnly: true, fixtureId: fixture.id, source: fixture.source,
      orderId: id, legacyId: legacy.id, verified: ['explicit-publication', 'legacy-private-not-public', 'two-independent-hosts',
        'ordinary-user-acceptor', 'atomic-two-user-claim-one-winner', 'observer-private-acl-denied', 'public-scope-range-access', 'original-accept-key-replay', 'immutable-publisher-acceptor-admin-authors', 'bidirectional-image-mp4',
        'play-seek-range-head-original-download', 'admin-all-order-transcript', 'lost-message-response-original-uuid'],
      auxiliaryOrderId: auxiliaryId, acceptanceRace: { attempts: 2, successes: 1, conflicts: 1, winner: winner.actor },
      observerAccountHadLegacyEngineerProfile: true, observerExtraCommunityPermissions: false, paidRequests: 0 }))
  } catch (error) {
    audit.status = 'failed'; await checkpoint()
    await saveFailureShot(publisherPage, 'community-publisher-real-go')
    await saveFailureShot(acceptorPage, 'community-acceptor-real-go')
    throw error
  }
}, 240_000)

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
