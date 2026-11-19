/** Opt-in synthetic Go→Host→browser forum publication and moderation. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid forum fixture response')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Missing forum fixture field')
  return value
}
it.skipIf(process.env.DSH_FORUM_FIXTURE === undefined)(
  'publishes forum posts and comments immediately through the real Go Host proxy and honors unilateral moderation',
  async () => {
    const manifest = object(
      JSON.parse(await readFile(process.env.DSH_FORUM_FIXTURE ?? '', 'utf8')) as unknown,
    )
    const base = text(manifest.base_url),
      url = new URL(base)
    if (
      manifest.synthetic_only !== true ||
      url.hostname !== '127.0.0.1' ||
      !['43581', '43591'].includes(url.port)
    )
      throw new Error('Forum interop requires its owned synthetic loopback fixture')
    const login = async (name: string): Promise<{ token: string; id: string }> => {
      const r = await fetch(base + '/api/user/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: `synthetic-${name}`, password: 'SYNTHETIC-LOCAL-ONLY' }),
      })
      const data = object(object((await r.json()) as unknown).data)
      return { token: text(data.access_token), id: String(object(data.user).id) }
    }
    const customer = await login('owner'),
      other = await login('other'),
      admin = await login('admin')
    const api = async (actor: typeof customer, path: string, method = 'GET', body?: unknown) => {
      const r = await fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${actor.token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const envelope = object((await r.json()) as unknown)
      return {
        status: r.status,
        value: envelope,
        data: envelope.success === true ? object(envelope.data) : {},
      }
    }
    const root = await mkdtemp(join(tmpdir(), 'yunshu-forum-e2e-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const evidence = join(import.meta.dirname, '../../../.artifacts', 'forum-' + randomUUID())
    await mkdir(evidence, { recursive: true })
    const state = join(root, 'state')
    await mkdir(state, { mode: 0o700 })
    const expiry = new Date(Date.now() + 10 * 60_000).toISOString()
    await writeFile(
      join(state, 'session.json'),
      JSON.stringify({
        token: randomBytes(24).toString('hex'),
        backendBaseUrl: base,
        expiresAt: expiry,
        account: { id: customer.id, phone: '+15550001000' },
        upstream: { token: customer.token, expiresAt: expiry },
      }),
      { mode: 0o600 },
    )
    const overlay = join(root, 'overlay.yml')
    await writeFile(
      overlay,
      JSON.stringify([
        {
          id: 'credits-index',
          config: { newApiBaseUrl: base, baseUrl: '', bridgeBaseUrl: '', stateDir: state },
        },
        { id: 'ui-forum', config: { requestTimeoutMs: 20_000, refreshMs: 300_000 } },
        ...['dsh-market', 'dsh-skin-market'].map(id => ({ id, disabled: true })),
      ]),
      { mode: 0o600 },
    )
    const scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    onTestFinished(() => scaffold.close())
    const browser = await chromium.launch({ headless: true })
    onTestFinished(() => browser.close())
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage(),
      errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: '需求发布', exact: true }).click()
    await page.getByRole('tab', { name: '论坛', exact: true }).click()
    const forum = page.getByRole('region', { name: '论坛', exact: true })
    await forum.getByRole('button', { name: '发帖', exact: true }).click()
    const title = '真实联调 · ' + randomUUID()
    await forum.getByRole('textbox', { name: '标题', exact: true }).fill(title)
    await forum
      .getByRole('textbox', { name: '分享点什么…', exact: true })
      .fill('本地合成讨论，不调用模型、不消耗积分。')
    await forum.getByRole('button', { name: '发布', exact: true }).click()
    await forum.getByRole('heading', { name: title, exact: true }).waitFor()
    const list = await api(other, '/api/product/forum/posts'),
      posts = list.data.items
    if (!Array.isArray(posts)) throw new Error('Missing forum posts')
    const created = posts.map(object).find(row => row.title === title)
    if (!created) throw new Error('The post was not published immediately')
    const id = text(created.id)
    expect(created.reviewed_at).toBeUndefined()
    await forum.getByRole('button', { name: '赞 · 0', exact: true }).click()
    await expect.poll(() => forum.getByRole('button', { name: '赞 · 1', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await forum.getByRole('button', { name: '赞 · 1', exact: true }).click()
    await forum.getByRole('button', { name: '赞 · 0', exact: true }).waitFor()
    const comment = '无需审批的评论 · ' + randomUUID()
    await forum.getByRole('textbox', { name: '写下你的评论', exact: true }).fill(comment)
    await forum.getByRole('button', { name: '评论', exact: true }).click()
    await forum.getByRole('article').filter({ hasText: comment }).waitFor()
    const comments = (await api(other, `/api/product/forum/posts/${id}/comments`)).data.items
    if (!Array.isArray(comments) || comments.length !== 1)
      throw new Error('Comment was not immediately published exactly once')
    const commentId = text(object(comments[0]).id)
    expect((await api(other, `/api/forum-management/comments/${commentId}`, 'DELETE', {})).status).toBe(403)
    expect(
      (await api(admin, `/api/forum-management/posts/${id}/review`, 'PUT', { reviewed: true })).status,
    ).toBe(200)
    expect((await api(other, `/api/product/forum/posts/${id}`)).status).toBe(200)
    await page.screenshot({ path: join(evidence, 'desktop.png') })
    await page.evaluate(() =>{  document.body.setAttribute('data-ds-dark-theme', '') })
    await page.screenshot({ path: join(evidence, 'dark.png') })
    await page.setViewportSize({ width: 620, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    await page.screenshot({ path: join(evidence, 'compact.png') })
    expect(
      (
        await api(admin, `/api/forum-management/comments/${commentId}`, 'DELETE', {
          reason: 'Synthetic moderation check',
        })
      ).status,
    ).toBe(200)
    await forum.getByRole('button', { name: '刷新', exact: true }).click()
    await expect.poll(() => forum.getByText(comment, { exact: true }).count()).toBe(0)
    expect(
      (
        await api(admin, `/api/forum-management/posts/${id}`, 'DELETE', {
          reason: 'Synthetic moderation check',
        })
      ).status,
    ).toBe(200)
    await forum.getByRole('button', { name: '刷新', exact: true }).click()
    await expect.poll(() => forum.getByRole('heading', { name: title, exact: true }).count()).toBe(0)
    expect((await api(other, `/api/product/forum/posts/${id}`)).status).toBe(404)
    expect(errors).toEqual([])
    await writeFile(
      join(evidence, 'result.json'),
      JSON.stringify({
        status: 'PASS',
        base,
        immediatePost: true,
        immediateComment: true,
        oneComment: true,
        likeUndo: true,
        adminReviewAfterPublication: true,
        adminRemovalRevokesClient: true,
        screenshots: ['desktop.png', 'dark.png', 'compact.png'],
        consoleErrors: errors,
        paid: 0,
        production: 0,
      }),
    )
  },
)
