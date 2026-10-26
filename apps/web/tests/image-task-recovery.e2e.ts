/** Authored, keyless image receipts survive persistence and render query-only recovery. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CreativeProjectView } from '@deepseek-ai/dsh-credits-index/creative-types'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  parseSeedFixture, readPersistedEvents, realizeSeedFixture, seedSession,
  selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandTurnProcesses, newEnglishPage, ZH_BROWSER_LOCALE } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/image-task-recovery', import.meta.url))
const FIXTURE = `${SNAPSHOT_DIR}/session.v4.jsonl`
const SEED_ID = 'image-task-recovery'
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: retained image task recovery', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let fixture: string
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    fixture = await readFile(await selectedSessionFixture(FIXTURE), 'utf8')
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, fixture, SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByText('The original task completed and its image is saved. No additional generation was submitted.', { exact: true }).waitFor()
  })

  afterAll(async () => {
    try { await browser?.close() }
    finally { await scaffold?.close() }
  })

  it('keeps original task identities and the single submission in the persisted transcript', async () => {
    const persisted = await readPersistedEvents(scaffold, SessionId(SEED_ID))
    const expected = parseSeedFixture(realizeSeedFixture(scaffold, fixture, SEED_ID)).events
    const tools = (events: typeof persisted) => events.filter(event => event.type === 'tool/call' || event.type === 'tool/result')
      .map(event => ({ type: event.type, data: event.data }))
    expect(tools(persisted)).toEqual(tools(expected))
    expect(persisted.filter(event => event.type === 'tool/call').map(event => event.data.name))
      .toEqual(['generate_image', 'query_image_task'])
  })

  it('shows an uncertain accepted generation and the original query result without another generation', async () => {
    await expandTurnProcesses(page)
    const generation = page.locator('[data-tool="generate_image"]')
    const query = page.locator('[data-tool="query_image_task"]')
    await expect.poll(() => generation.getAttribute('data-state')).toBe('running')
    expect(await generation.textContent()).toContain('Generating or waiting to save. Check the original task’s progress without generating again.')
    expect(await generation.textContent()).not.toContain('The server is busy')
    await expect.poll(() => query.getAttribute('data-state')).toBe('ok')
    await query.locator('[data-expandable]').click()
    expect(await query.textContent()).toContain('snapshot-original-task')
    expect(await query.textContent()).toContain('snapshot-original-request')
    expect(await query.textContent()).toContain('retained-image.png')
    expect(await page.locator('[data-tool="generate_image"]').count()).toBe(1)
    await compareOrRefreshGolden(`${SNAPSHOT_DIR}/ui.expected.md`,
      (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)).split(SEED_ID).join('{{seededId}}'), MODE)
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v4.jsonl', 'ui.expected.md'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('continues saving the original synchronous image from its task card without submitting generation', async () => {
    const savePage = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1680, height: 1000 } })
    try {
      const observed = watchConsole(savePage)
      const account = { id: 'image-result-browser-qa', phone: '+8613800000000' }
      const projectId = 'cp_original_sync' as CreativeProjectView['id']
      const operationId = 'op_original_sync'
      const media = `/credits/api/creative/media?${new URLSearchParams({
        session_id: SEED_ID, project_id: projectId, output_id: 'out_original_sync',
      })}`
      const image = { id: 'out_original_sync' as CreativeProjectView['outputs'][number]['id'],
        kind: 'image' as const, name: '同步原图.png', url: media }
      let completed = false
      let mediaReads = 0
      const recoveries: unknown[] = []
      const forbiddenWrites: string[] = []
      const unexpectedReads: string[] = []
      const listing = (): { accountId: string; projects: CreativeProjectView[] } => ({ accountId: account.id, projects: [{
        id: projectId, sessionId: SEED_ID, planRevision: 'original-sync', kind: 'image', title: '原图保存恢复验收',
        brief: '保存已收到的原图，不提交新的生成', style: '本地浏览器测试色块', updatedAt: new Date().toISOString(),
        status: completed ? 'completed' : 'unknown', completedShots: 0, totalShots: 0,
        characters: [], assets: [], shots: [], outputs: completed ? [image] : [], tasks: [{
          id: operationId, status: completed ? 'completed' : 'unknown', shotIds: [], completedShots: 0, totalShots: 0,
          outputs: completed ? [image] : [], canQuery: !completed, recovery: 'image-result',
          imageReceipt: { route: '/v1/images/generations', model: 'image-fixture',
            phase: completed ? 'completed' : 'submitting', requestId: 'original-sync-request', backendFingerprint: 'a'.repeat(64) },
        }],
      }] })
      await savePage.route('**/credits/api/**', async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        const json = async (payload: unknown): Promise<void> => route.fulfill({ status: 200, json: { ok: true, payload } })
        if (url.pathname === '/credits/api/creative/image/recover' && request.method() === 'POST') {
          const body: unknown = JSON.parse(request.postData() ?? '{}')
          recoveries.push(body)
          completed = true
          await route.fulfill({ status: 202, json: { ok: true, payload: listing() } })
        } else if (request.method() !== 'GET') {
          forbiddenWrites.push(`${request.method()} ${url.pathname}`)
          await route.abort('blockedbyclient')
        } else if (url.pathname === '/credits/api/session') {
          await json({ signedIn: true, creditsPerYuan: 1000, account })
        } else if (url.pathname === '/credits/api/summary') {
          await route.fulfill({ status: 200, json: { ok: true, account: { id: account.id }, payload: { balance_points: 20000 } } })
        } else if (url.pathname === '/credits/api/creative/projects' && url.searchParams.get('session_id') === SEED_ID) {
          await json(listing())
        } else if (url.pathname === '/credits/api/creative/media' && url.search === new URL(media, savePage.url()).search) {
          mediaReads++
          await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') })
        } else if (url.pathname === '/credits/api/chat-usage') {
          await json({ scope: 'chat-model', status: 'unavailable', settledRequests: 0, totalRequests: 0, accountId: account.id })
        } else if (url.pathname === '/credits/api/media/catalog') await json({ image: [], video: [] })
        else if (url.pathname === '/credits/api/creation/content') {
          const mode = { title: { zh: '', en: '' }, description: { zh: '', en: '' },
            promptPlaceholder: { zh: '', en: '' }, categories: [], templates: [], presets: [] }
          await json({ schemaVersion: 1, revision: 'original-sync-browser', image: mode, video: mode })
        } else {
          unexpectedReads.push(`${request.method()} ${url.pathname}`)
          await route.fulfill({ status: 404, json: { ok: false, code: 'UNEXPECTED_FIXTURE_READ' } })
        }
      })
      await savePage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      const workspace = savePage.locator('[role="treeitem"][aria-expanded]').first()
      await workspace.waitFor()
      if (await workspace.getAttribute('aria-expanded') === 'false') await workspace.click()
      await savePage.locator('[role="treeitem"]').nth(1).click()
      const body = savePage.locator(`[data-creative-session="${SEED_ID}"]`)
      if (!await body.isVisible()) {
        const expand = savePage.locator('[data-sidebar-right-expand]')
        if (await expand.isVisible()) await expand.click()
        if (!await body.isVisible()) {
          const tab = savePage.locator('[data-dockkit-tab]').filter({ hasText: '创作' })
          if (await tab.count() > 0) await tab.first().click()
          else {
            const entry = savePage.locator('[data-sidebar-right-guide-entry="creative"]')
            if (!await entry.isVisible()) await savePage.locator('[data-dockkit-add-tab]').first().click()
            await entry.click()
          }
        }
      }
      await body.getByText('原图保存恢复验收', { exact: true }).waitFor()
      await body.getByRole('tab', { name: '任务与作品', exact: true }).click()
      const card = body.locator(`[data-creative-task="${operationId}"]`)
      await card.getByText('原图结果已收到，本地保存尚未完成。可继续保存原图，无需再次生成', { exact: true }).waitFor()
      expect(await card.getByRole('button', { name: '查询原任务', exact: true }).count()).toBe(0)
      await card.getByRole('button', { name: '继续保存原图', exact: true }).click()
      await card.getByText('文件已完成', { exact: true }).waitFor()
      await body.getByText('同步原图.png', { exact: true }).first().waitFor()
      await expect.poll(() => body.locator('img:visible').evaluateAll(elements => elements.length > 0 && elements.every(element =>
        element instanceof HTMLImageElement && element.complete && element.naturalWidth === 1)), { timeout: 10_000 }).toBe(true)
      expect(recoveries).toEqual([{ session_id: SEED_ID, project_id: projectId, operation_id: operationId }])
      expect(forbiddenWrites).toEqual([])
      expect(unexpectedReads).toEqual([])
      expect(mediaReads).toBeGreaterThan(0)
      expect(observed.pageErrors).toEqual([])
    } finally { await savePage.close() }
  })
})
