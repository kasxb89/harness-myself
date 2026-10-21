/** Authored, keyless image receipts survive persistence and render query-only recovery. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  parseSeedFixture, readPersistedEvents, realizeSeedFixture, seedSession,
  selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandTurnProcesses, newEnglishPage } from './support.ts'

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
    await expect.poll(() => generation.getAttribute('data-state')).toBe('stopped')
    expect(await generation.textContent()).toContain('The original image task was accepted')
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
})
