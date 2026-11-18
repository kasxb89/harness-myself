/** Assembled human-demand UI and an opt-in, exclusively synthetic Go→Host→browser workflow. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'
import { assertReadableText } from './readable-text.ts'
import { installDemandFixture } from './fixtures/demands/host-fixture.ts'

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
async function navigateService(page: Page, url: string): Promise<Locator> {
  await page.goto(url, { waitUntil: 'load' })
  await page.bringToFront()
  await page.getByRole('button', { name: '需求发布', exact: true }).click({ timeout: 30_000 })
  const service = page.getByRole('region', { name: '工程师服务', exact: true })
  await service.getByRole('searchbox', { name: '搜索工程师或技能', exact: true }).waitFor()
  return service
}
async function layouts(page: Page, service: Locator, evidence: string, prefix: string): Promise<void> {
  for (const layout of [
    { width: 1440, dark: false, name: 'wide-light' }, { width: 1440, dark: true, name: 'wide-dark' },
    { width: 620, dark: false, name: 'compact-light' }, { width: 620, dark: true, name: 'compact-dark' },
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
    await page.screenshot({ path: join(evidence, `${prefix}-${layout.name}.png`), animations: 'disabled' })
  }
}
async function titleDraft(chat: Locator, value: string): Promise<void> {
  await chat.getByText('补充信息（选填）', { exact: true }).click()
  await chat.getByRole('textbox', { name: '需求标题', exact: true }).fill(value)
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
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 } })
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
    await page.setViewportSize({ width: 1440, height: 1000 })
    await service.getByRole('button', { name: '向测试工程师林发起需求', exact: true }).click()
    let chat = service.getByRole('region', { name: '与测试工程师林沟通', exact: true })
    await chat.getByRole('textbox', { name: '说明需求、预期结果和相关限制', exact: true }).fill('首个待确认需求的正文')
    await titleDraft(chat, '首个待确认需求')
    await chat.getByRole('button', { name: '发送并提交需求', exact: true }).click()
    await chat.getByRole('button', { name: '核对发布结果', exact: true }).waitFor()
    await chat.getByRole('button', { name: '新需求', exact: true }).click()
    await service.getByRole('button', { name: '向测试工程师林发起需求', exact: true }).click()
    chat = service.getByRole('region', { name: '与测试工程师林沟通', exact: true })
    await chat.getByRole('textbox', { name: '说明需求、预期结果和相关限制', exact: true }).fill('独立第二个需求的正文')
    await titleDraft(chat, '独立第二个需求')
    await chat.getByRole('button', { name: '发送并提交需求', exact: true }).click()
    await chat.getByRole('textbox', { name: '输入消息', exact: true }).waitFor()
    expect(fixture.records.size).toBe(2)
    await service.getByRole('group', { name: '草稿与待确认发布', exact: true }).getByRole('button').filter({ hasText: '首个待确认需求' }).click()
    await chat.getByRole('button', { name: '核对发布结果', exact: true }).click()
    await chat.getByRole('textbox', { name: '输入消息', exact: true }).waitFor()
    expect(fixture.createBodies).toHaveLength(3)
    expect(fixture.createBodies[2]).toBe(fixture.createBodies[0])
    expect(fixture.createBodies[1]).not.toBe(fixture.createBodies[0])
    expect(fixture.records.size).toBe(2)

    await chat.getByRole('button', { name: '新需求', exact: true }).click()
    await service.getByRole('button', { name: '向测试工程师林发起需求', exact: true }).click()
    const files = await Promise.all([readFile(imageFile), readFile(videoFile)])
    await chat.locator('input[type="file"]').setInputFiles([
      { name: '需求截图.png', mimeType: 'image/png', buffer: files[0] ?? Buffer.alloc(0) },
      { name: '需求演示.mp4', mimeType: 'video/mp4', buffer: files[1] ?? Buffer.alloc(0) },
    ])
    await expect.poll(() => chat.getByText('待发送', { exact: true }).count()).toBe(2)
    await chat.getByRole('button', { name: '发送并提交需求', exact: true }).click()
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

it.skipIf(process.env.DSH_DEMAND_FIXTURE === undefined)(
  'round-trips a synthetic Go request through the actual Host, assignment security, original media and user acceptance', async () => {
    const fixture = await readSyntheticFixture(process.env.DSH_DEMAND_FIXTURE ?? '')
    const evidence = await artifactDirectory('real-go'), stamp = `synthetic-${randomUUID()}`
    const api = async (actor: Actor, path: string, body?: Json): Promise<{ status: number; data: Json }> => {
      const response = await fetch(fixture.base + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${fixture.tokens[actor]}`, accept: 'application/json',
          ...body === undefined ? {} : { 'content-type': 'application/json' } },
        ...body === undefined ? {} : { body: JSON.stringify(body) } })
      return { status: response.status, data: object(await response.json() as unknown) }
    }
    const success = async (actor: Actor, path: string, body?: Json): Promise<Json> => {
      const result = await api(actor, path, body)
      if (result.status < 200 || result.status >= 300 || result.data.success !== true) throw new Error(`Synthetic demand API rejected ${actor} operation: ${result.status}`)
      return object(result.data.data)
    }
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
    const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 } })
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
      await chat.getByRole('button', { name: '发送并提交需求', exact: true }).click()
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
