// Web e2e scenarios: live-turn interactions — running-draft submission,
// cancellation, error surfacing, transient-retry recovery, and retry
// exhaustion, all through the real composition and wire. The model adapter is
// dsh-llm-replay with override
// sidecars: `hang` (+ a readyFile marker) makes mid-stream cancel
// deterministic by construction, `throw` entries express provider failures by
// stable code, and `{ patches }` augmentation injects transient throws before
// (or instead of) the recorded success so llm-retry's recovery and exhaustion
// are proven end-to-end in the browser. Sidecar CONTENT is authored here
// (single-sourced against the fixture via deriveReplayScript — no committed
// copy of recorded chunks); the file is a per-run artifact in the temp
// workspace. One recorded base fixture serves every scenario.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { ReplayEntry, ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  assertFixtureInventory, captureExpandedTurnProcessAria, captureStableAria,
  compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/live-interactions', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
// One golden pins the empty mid-turn loading state, one pins the sendable draft
// state, and the other four capture what remains after cancel, after a
// non-retryable failure, after retry recovery, and after retry exhaustion.
const CANCEL_EXPECTED = join(SNAPSHOT_DIR, 'cancel.expected.md')
const CANCEL_EXPANDED_EXPECTED = join(SNAPSHOT_DIR, 'cancel-expanded.expected.md')
const LOADING_EXPECTED = join(SNAPSHOT_DIR, 'loading.expected.md')
const RUNNING_DRAFT_EXPECTED = join(SNAPSHOT_DIR, 'running-draft.expected.md')
const ERROR_EXPECTED = join(SNAPSHOT_DIR, 'error-auth.expected.md')
const RETRY_EXPECTED = join(SNAPSHOT_DIR, 'retry.expected.md')
const RETRY_EXPANDED_EXPECTED = join(SNAPSHOT_DIR, 'retry-expanded.expected.md')
const RETRY_REQUEST_EXPECTED = join(SNAPSHOT_DIR, 'retry-request.expected.md')
const RETRY_EXHAUSTED_EXPECTED = join(SNAPSHOT_DIR, 'retry-exhausted.expected.md')
const MODE = webSnapshotMode()
const AUTH_PROVIDER_MESSAGE = 'Authentication Fails, Your api key: sk-preview-secret is invalid'

// The recorded base: one text-only turn whose derived script the sidecars
// patch. Kept deliberately tool-free so the derived script is exactly one
// model call.
const PROMPT = 'Reply with a one-sentence description of event sourcing, then stop.'
const RUNNING_DRAFT = 'Queue this follow-up while the current turn is running.'
const RETRY_PARTIAL = 'This partial reply must disappear when the attempt fails.'

/** turn/end reasons observed, in order. */
function turnEndReasons(events: SessionEvent[]): string[] {
  return events
    .filter(e => e.type === 'turn/end')
    .map(e => (e as SessionEvent & { data: { reason: { kind: string } } }).data.reason.kind)
}

describe('web e2e: live-turn interactions (cancel / error / retry)', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let sessionEvents: SessionEvent[]
  let sidecarDir: string | undefined

  afterEach(async () => {
    // scaffold.close() failures MUST fail the scenario: assertConsumed() is
    // the fixture-drift tripwire and cleanup problems are real defects. Run
    // every teardown step regardless, then rethrow what failed.
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    browser = undefined
    const closing = scaffold
    scaffold = undefined
    await closing?.close().catch((error: unknown) => failures.push(error))
    if (sidecarDir !== undefined) await rm(sidecarDir, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    sidecarDir = undefined
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'live-interactions teardown failed')
  })

  /** Boot scaffold + page with an optional override doc materialized per run. */
  async function launch(
    buildOverride?: (sidecarHome: string) => ReplayOverrideDoc,
    retryPolicy?: RetryPolicyConfig,
    preparePage?: (page: Page) => Promise<void>,
  ): Promise<void> {
    sessionEvents = []
    let overridePath: string | undefined
    if (buildOverride !== undefined) {
      // The sidecar CONTENT is authored in this spec; the file is a per-run
      // artifact minted in a spec-owned temp dir. It must exist BEFORE the
      // scaffold boots — installLlmReplay resolves the script at install.
      sidecarDir = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-sidecar-'))
      overridePath = join(sidecarDir, 'replay.override.json')
      await writeFile(overridePath, JSON.stringify(buildOverride(sidecarDir)))
    }
    scaffold = await launchWebScaffold({
      developerTools: true, showTrajectory: true,
      replayFixture: FIXTURE,
      // Throughput snapshots need a nonzero interval between replayed chunks.
      paceMs: 1,
      ...(overridePath === undefined ? {} : { replayOverride: overridePath }),
      ...(overridePath === undefined ? {} : { compareReplaySession: false }),
      ...(retryPolicy === undefined ? {} : { replayRetryPolicy: retryPolicy }),
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await preparePage?.(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // Fresh world: connect a Workspace so the composer scenarios start live.
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }

  /**
   * Type the recorded prompt and send, with the settled barrier pre-armed.
   * Returned WRAPPED ({ settled }) — a bare returned promise would be
   * flattened by the caller's await, blocking on turn/end before the caller
   * can act mid-turn (the cancel scenario's whole point).
   */
  async function sendPrompt(timeoutMs?: number): Promise<{ settled: ReturnType<WebScaffold['whenTurnSettled']> }> {
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold!.whenTurnSettled(timeoutMs)
    await input.fill(PROMPT)
    await input.press('Enter')
    return { settled }
  }

  it.skipIf(MODE !== 'record')('records the base fixture live through the composer', async () => {
    await launch()
    onTestFailed(() => saveFailureShot(page, 'web-e2e-interactions-record'))
    const { settled } = await sendPrompt(180_000)
    const sessionId = await settled
    await recordFixture(scaffold!, sessionId, FIXTURE)
  }, 200_000)

  it.skipIf(MODE === 'record')('matches the canonical persisted session', async () => {
    await launch()
    const { settled } = await sendPrompt(30_000)
    await settled
  })

  it.skipIf(MODE === 'record')('cancels a hung stream deterministically via the readyFile marker', async () => {
    expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    let marker = ''
    await launch((sidecarHome) => {
      marker = join(sidecarHome, '.hang-ready')
      return { patches: [{ at: 0, entry: { kind: 'hang', readyFile: marker } }] }
    })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-cancel'))
    const { settled } = await sendPrompt()
    // The marker IS the synchronization: the stream is provably parked in the
    // hang (prefix chunks delivered to the loop) before the stop click.
    await expect.poll(() => existsSync(marker), { timeout: 15_000 }).toBe(true)
    await expect.poll(
      () => page.getByRole('status').filter({ hasText: 'Working' }).isVisible(),
      { timeout: 10_000 },
    ).toBe(true)
    await page.locator('[data-streaming="true"]:not([inert] *)')
      .getByText('partial', { exact: true })
      .waitFor({ timeout: 30_000 })
    const loadingSnapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold!.workspaceCwd)
    await compareOrRefreshGolden(LOADING_EXPECTED, loadingSnapshot, MODE)

    const input = page.locator('[data-composer-input]').first()
    await input.fill(RUNNING_DRAFT)
    // The running primary names its delivery: the default busy-state
    // preference is Queue, so the button reads Queue rather than plain Send.
    const send = page.getByRole('button', { name: 'Queue message', exact: true })
    await send.waitFor({ timeout: 10_000 })
    expect(await page.getByRole('button', { name: 'Stop generating', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Send message', exact: true }).count()).toBe(0)
    const runningDraftSnapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold!.workspaceCwd)
    await compareOrRefreshGolden(RUNNING_DRAFT_EXPECTED, runningDraftSnapshot, MODE)
    await send.click()
    await expect.poll(() => input.textContent(), { timeout: 10_000 }).toBe('')
    const queuedRow = page.locator('[data-queue-dock]').getByRole('listitem').filter({ hasText: RUNNING_DRAFT })
    await queuedRow.waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Stop generating', exact: true }).waitFor({ timeout: 10_000 })
    await queuedRow.getByRole('button', { name: 'Remove queued message' }).click()
    await expect.poll(() => queuedRow.count(), { timeout: 10_000 }).toBe(0)

    const stopButton = page.getByRole('button', { name: 'Stop generating' })
    await stopButton.hover()
    await page.getByRole('tooltip', { name: 'Stop generating Esc Esc', exact: true }).waitFor()
    await stopButton.click()
    await settled
    expect(turnEndReasons(sessionEvents).at(-1)).toBe('aborted')
    // Composer recovered; no streaming node lingers. The host settled first
    // (awaited above), but the abort frame reaches the browser over SSE — the
    // frozen-partial swap is eventually consistent, so poll rather than count.
    await expect.poll(() => page.locator('[data-composer-input]').first().isEnabled(), { timeout: 10_000 }).toBe(true)
    await expect.poll(() => page.locator('[data-streaming="true"]:not([inert] *)').count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => page.getByRole('tooltip').count()).toBe(0)
    // Golden of the aborted end-state: the prompt bubble plus the frozen
    // partial ('partial' is the hang entry's replayed prefix) and no more.
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold!.workspaceCwd)
    await compareOrRefreshGolden(CANCEL_EXPECTED, snapshot, MODE)
    const expanded = await captureExpandedTurnProcessAria(
      page,
      '[class*="centerCol"]',
      scaffold!.workspaceCwd,
    )
    await compareOrRefreshGolden(CANCEL_EXPANDED_EXPECTED, expanded, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it.skipIf(MODE === 'record')('surfaces a non-retryable AUTH failure without retrying', async () => {
    await launch(() => ({
      patches: [{ at: 0, entry: { kind: 'throw', chunks: [], message: AUTH_PROVIDER_MESSAGE, code: 'AUTH' } }],
    }))
    onTestFailed(() => saveFailureShot(page, 'web-e2e-error-auth'))
    const { settled } = await sendPrompt()
    await settled
    expect(turnEndReasons(sessionEvents).at(-1)).toBe('error')
    // AUTH is outside llm-retry's retryable set: no retry record.
    expect(sessionEvents.filter(e => e.type === 'llm/retry').length).toBe(0)
    await expect.poll(() => page.locator('[data-composer-input]').first().isEnabled(), { timeout: 10_000 }).toBe(true)
    expect(await page.locator('[data-streaming="true"]:not([inert] *)').count()).toBe(0)
    const errorStatus = page.getByRole('status').filter({ hasText: 'This turn failed' })
    await errorStatus.waitFor({ timeout: 10_000 })
    expect(await errorStatus.textContent()).toContain('The server is busy. Please try again later.')
    expect(await errorStatus.textContent()).not.toContain('AUTH')
    expect(sessionEvents.findLast(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'error', error: { code: 'AUTH' } } },
    })
    expect(await page.locator('body').textContent()).not.toContain('sk-preview-secret')
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold!.workspaceCwd)
    await compareOrRefreshGolden(ERROR_EXPECTED, snapshot, MODE)
    await page.getByRole('tab', { name: 'Trajectory' }).click()
    const requestMarker = page.locator('tr[data-request-only="true"]').last()
      .getByRole('button', { name: /Request #/ })
    await requestMarker.click()
    await page.getByText('API key is invalid', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await page.locator('body').textContent()).not.toContain('sk-preview-secret')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it.skipIf(MODE === 'record')('offers recharge for a live video tool rejection after a completed turn', async () => {
    const accountOwner = 'a'.repeat(64)
    await launch(() => ({ patches: [] }), undefined, async (prepared) => {
      const local = new URL(scaffold!.baseUrl).origin
      await prepared.route(url => url.origin === local && [
        '/credits/api/session', '/credits/api/summary', '/credits/api/chat-usage',
      ].includes(url.pathname), async (route) => {
        const url = new URL(route.request().url())
        const payload = url.pathname === '/credits/api/session'
          ? { signedIn: true, accountOwner, account: { id: 'balance-fixture', phone: 'fixture' }, creditsPerYuan: 1000 }
          : url.pathname === '/credits/api/summary' ? { balance_points: 0, as_of: '2026-01-15T04:00:00Z' }
            : { scope: 'chat-model', accountId: 'balance-fixture', status: 'unavailable', settledRequests: 0, totalRequests: 0 }
        await route.fulfill({ json: { ok: true, payload } })
      })
    })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-video-balance-action'))
    const { settled } = await sendPrompt()
    const sessionId = await settled
    const refreshed = page.waitForResponse(response => response.url() === `${scaffold!.baseUrl}/credits/api/session`)
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
    expect(await (await refreshed).json()).toMatchObject({ payload: { signedIn: true, accountOwner } })
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
    }))
    const agent = scaffold!.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Expected the live browser chat Agent')
    let turn = 1
    const publish = (workId: string, scope = accountOwner): void => {
      turn += 1
      const callId = ToolCallId(`video-balance-${String(turn)}`)
      const args = JSON.stringify({ prompt: 'One requested video', duration_seconds: 15 })
      agent.session.append('turn/start', { turn })
      agent.session.append('user/message', createUserMessage({ source: { kind: 'user' },
        content: [{ type: 'text', text: 'Generate one video.' }] }), { surfaceOp: 'append' })
      agent.session.append('step/start', { turn, step: 1 })
      agent.session.append('assistant/message', { turn, step: 1, stream: [],
        message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' },
          content: [{ type: 'tool-call', id: callId, name: 'generate_video', arguments: args }] }) }, { surfaceOp: 'append' })
      const call = agent.session.append('tool/call', { turn, step: 1, callId, name: 'generate_video', arguments: args })
      agent.session.append('tool/result', { turn, step: 1,
        message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: JSON.stringify({
          status: 'unknown', submission_state: 'unknown', code: 'INSUFFICIENT_BALANCE', work_id: workId,
          message: '余额不足，请充值；提交结果尚未确认，请先检查已有任务，不要重复提交。',
          actionRequired: { code: 'INSUFFICIENT_BALANCE', scope },
        }) }] }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
      agent.session.append('step/end', { turn, step: 1 })
      agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const dialog = page.getByRole('dialog', { name: 'Insufficient balance. Please top up.', exact: true })
    publish('original-video')
    await dialog.waitFor({ timeout: 10_000 })
    await expect.poll(() => dialog.getByRole('button', { name: 'Top up', exact: true }).isEnabled()).toBe(true)
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
    await dialog.waitFor({ state: 'hidden' })
    publish('original-video')
    publish('old-account-video', 'b'.repeat(64))
    await page.locator('[data-turn-process="4"]').waitFor()
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
    }))
    expect(await dialog.count()).toBe(0)
    publish('new-video')
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Top up', exact: true }).click()
    await page.getByRole('heading', { name: 'Credit top-up', exact: true }).waitFor()
    expect(await dialog.count()).toBe(0)
    expect(sessionEvents.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'error')).toHaveLength(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it.skipIf(MODE === 'record').each(['QUOTA', 'ACCOUNT_QUOTA', 'INSUFFICIENT_BALANCE'])(
    'retains a %s failure with its product notice policy after history reloads', async (code) => {
      await launch(() => ({
        patches: [{ at: 0, entry: { kind: 'throw', chunks: [], message: 'Provider quota exhausted', code } }],
      }))
      onTestFailed(() => saveFailureShot(page, `web-e2e-quota-${code}`))
      const { settled } = await sendPrompt()
      await settled
      const copy = code === 'QUOTA' ? 'The operation did not complete; the cause is unconfirmed. Check the status first.'
        : code === 'INSUFFICIENT_BALANCE' ? 'Insufficient balance. Please top up.' : 'Request quota exhausted.'
      const notice = page.getByRole('alert').filter({ hasText: code === 'QUOTA' ? 'Request quota exhausted.' : copy })
      if (code === 'INSUFFICIENT_BALANCE') {
        // Credits owns this code with a persistent, identity-bound recharge
        // dialog. An unsigned reader can dismiss it but cannot top up.
        const balanceDialog = page.getByRole('dialog', { name: copy, exact: true })
        await balanceDialog.waitFor({ timeout: 10_000 })
        expect(await notice.count()).toBe(0)
        expect(await balanceDialog.getByRole('button', { name: 'Top up', exact: true }).isDisabled()).toBe(true)
        const refreshed = page.waitForResponse(response => response.url() === `${scaffold!.baseUrl}/credits/api/session`)
        await page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
        expect(await (await refreshed).json()).toMatchObject({ payload: { signedIn: false } })
        await page.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
        }))
        expect(await balanceDialog.isVisible()).toBe(true)
        await balanceDialog.getByRole('button', { name: 'Close', exact: true }).filter({ hasText: 'Close' }).click()
        await balanceDialog.waitFor({ state: 'hidden' })
      } else if (code === 'ACCOUNT_QUOTA') await notice.waitFor({ timeout: 10_000 })
      else expect(await notice.count()).toBe(0)
      expect(await page.getByRole('dialog').count()).toBe(0)
      const failure = page.getByRole('status').filter({ hasText: 'This turn failed' })
      await failure.waitFor({ timeout: 10_000 })
      expect(await failure.textContent()).toContain(copy)
      expect(await failure.textContent()).not.toContain(code)
      expect(sessionEvents.findLast(event => event.type === 'turn/end')).toMatchObject({
        data: { reason: { kind: 'error', error: { code } } },
      })
      if (code === 'ACCOUNT_QUOTA') await notice.waitFor({ state: 'hidden', timeout: 10_000 })
      expect(await failure.isVisible()).toBe(true)
      const expected = fileURLToPath(new URL(`./expected/quota-notice/${code.toLowerCase()}.expected.md`, import.meta.url))
      await compareOrRefreshGolden(expected, await failure.ariaSnapshot(), MODE)

      await page.reload({ waitUntil: 'load' })
      await failure.waitFor({ timeout: 15_000 })
      expect(await notice.count()).toBe(0)
      expect(await page.getByRole('dialog').count()).toBe(0)
      expect(tripwire.pageErrors).toEqual([])
    }, 120_000,
  )

  it.skipIf(MODE === 'record').each(['switch', 'logout'] as const)(
    'dismisses the live balance dialog on account %s without navigating or replaying it', async (transition) => {
      let accountId: string | undefined = 'fixture-balance-a'
      await launch(() => ({
        patches: [{ at: 0, entry: { kind: 'throw', chunks: [], message: 'private upstream funding diagnostic', code: 'INSUFFICIENT_BALANCE' } }],
      }), undefined, async (prepared) => {
        // Only three loopback account reads are controlled. No sign-in,
        // recharge or model endpoint is called by these identity fixtures.
        const origin = new URL(scaffold!.baseUrl).origin
        await prepared.route(url => url.origin === origin && [
          '/credits/api/session', '/credits/api/summary', '/credits/api/chat-usage',
        ].includes(url.pathname), async (route) => {
          const url = new URL(route.request().url())
          const payload = url.pathname === '/credits/api/session'
            ? { signedIn: accountId !== undefined, creditsPerYuan: 1000,
              ...(accountId === undefined ? {} : { account: { id: accountId, phone: 'fixture' } }) }
            : url.pathname === '/credits/api/summary'
              ? { balance_points: 0, as_of: '2026-01-15T04:00:00Z' }
              : { scope: 'chat-model', accountId: url.searchParams.get('account_id'),
                status: 'unavailable', settledRequests: 0, totalRequests: 0 }
          await route.fulfill({ json: { ok: true, payload } })
        })
      })
      onTestFailed(() => saveFailureShot(page, `web-e2e-balance-account-${transition}`))
      const { settled } = await sendPrompt()
      await settled
      const dialog = page.getByRole('dialog', { name: 'Insufficient balance. Please top up.', exact: true })
      await dialog.waitFor({ timeout: 10_000 })
      await expect.poll(() => dialog.getByRole('button', { name: 'Top up', exact: true }).isEnabled()).toBe(true)
      const refreshIdentity = async (): Promise<void> => {
        const expectedIdentity = accountId
        const refreshed = page.waitForResponse(response => response.url() === `${scaffold!.baseUrl}/credits/api/session`)
        // Signed-in refresh publishes the Session before asking for its
        // balance. Observe that read, then a browser render before inspecting
        // the identity-bound dialog rather than racing the fetch callback.
        const balance = expectedIdentity === undefined ? undefined
          : page.waitForResponse(response => response.url() === `${scaffold!.baseUrl}/credits/api/summary`)
        await page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
        expect(await (await refreshed).json()).toMatchObject({ payload: {
          signedIn: expectedIdentity !== undefined,
          ...(expectedIdentity === undefined ? {} : { account: { id: expectedIdentity } }),
        } })
        if (balance !== undefined) expect(await (await balance).json()).toMatchObject({ ok: true })
        await page.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
        }))
      }
      // A same-account heartbeat retains the live decision. An identity
      // replacement or logout withdraws it instead of charging another account.
      await refreshIdentity()
      expect(await dialog.isVisible()).toBe(true)
      accountId = transition === 'switch' ? 'fixture-balance-b' : undefined
      await refreshIdentity()
      await dialog.waitFor({ state: 'hidden' })
      const failure = page.getByRole('status').filter({ hasText: 'This turn failed' })
      await failure.waitFor({ timeout: 10_000 })
      expect(await failure.textContent()).toBe('This turn failedInsufficient balance. Please top up.')
      expect(await page.locator('body').textContent()).not.toContain('private upstream funding diagnostic')
      expect(await page.locator('[data-composer-input]').first().isVisible()).toBe(true)
      expect(sessionEvents.filter(event => event.type === 'turn/end')).toHaveLength(1)
      expect(sessionEvents.findLast(event => event.type === 'turn/end')).toMatchObject({
        data: { reason: { kind: 'error', error: { code: 'INSUFFICIENT_BALANCE' } } },
      })
      expect(tripwire.warnings).toEqual([])
      await page.reload({ waitUntil: 'load' })
      await failure.waitFor({ timeout: 15_000 })
      expect(await dialog.count()).toBe(0)
      expect(await page.getByRole('alert').count()).toBe(0)
      expect(sessionEvents.filter(event => event.type === 'turn/end')).toHaveLength(1)
      expect(tripwire.pageErrors).toEqual([])
    }, 120_000,
  )

  it.skipIf(MODE === 'record')('keeps a terminal request marker inside the trajectory table', async () => {
    await launch(() => ({
      patches: [{ at: 0, entry: { kind: 'throw', chunks: [], message: AUTH_PROVIDER_MESSAGE, code: 'AUTH' } }],
    }))
    const { settled } = await sendPrompt()
    await settled
    await page.getByRole('tab', { name: 'Trajectory' }).click()
    // The boundary marker row itself is a 0-height hairline except at the
    // table tail; the marker button is absolutely positioned and stays
    // visible, so wait on it directly.
    const tailRequest = page.locator('tr[data-request-only="true"]').last()
    const requestMarker = tailRequest.getByRole('button', { name: /Request #/ })
    await requestMarker.waitFor({ timeout: 10_000 })

    const markerWithinTable = await requestMarker.evaluate((element) => {
      const marker = element.getBoundingClientRect()
      const table = element.closest('table')?.getBoundingClientRect()
      if (table === undefined) throw new Error('request marker has no table')
      return marker.bottom <= table.bottom
    })

    expect(markerWithinTable).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it.skipIf(MODE === 'record')('wraps an active retry label inside a narrow conversation column', async () => {
    await launch(() => ({ patches: [{ at: 0, entry: { kind: 'throw', chunks: [], message: 'upstream 503', code: 'SERVER' } }] }),
      { mode: 'normal', maxRetries: 1, retryableCodes: ['SERVER'],
        backoff: { initialDelayMs: 60_000, maxDelayMs: 60_000, jitterRatio: 0 } })
    await scaffold!.ctx.settings.update('ui-theme', { fontSize: 17 })
    const { settled } = await sendPrompt(90_000)
    const retry = page.locator('details[data-active="true"]')
    await retry.waitFor()
    const originalStyle = await retry.getAttribute('style')
    try {
      const geometry = await retry.evaluate((element) => {
        element.style.width = '200px'
        const summary = element.querySelector('summary')!
        const status = summary.querySelector('[role="status"]')!
        return { width: summary.getBoundingClientRect().width,
          scrollWidth: summary.scrollWidth, clientWidth: summary.clientWidth,
          height: status.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(getComputedStyle(status).lineHeight) }
      })
      expect(geometry.width).toBeLessThanOrEqual(200)
      expect(geometry.scrollWidth).toBe(geometry.clientWidth)
      expect(geometry.height).toBeGreaterThan(geometry.lineHeight)
      expect(await retry.getByRole('status').textContent()).toContain('Retrying')
    } finally {
      await retry.evaluate((element, style) => {
        if (style === null) element.removeAttribute('style')
        else element.setAttribute('style', style)
      }, originalStyle)
      await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
      await settled
    }
    expect(tripwire.pageErrors).toEqual([])
  })

  it.skipIf(MODE === 'record')('recovers a transient SERVER failure through llm-retry and completes', async () => {
    const derived = deriveReplayScript(parseSessionLog(await readFile(FIXTURE, 'utf8')))
    expect(derived).toHaveLength(1)
    await launch(() => ({
      patches: [
        { at: 0, entry: {
          kind: 'throw', message: 'upstream 503', code: 'SERVER',
          chunks: [
            { type: 'block-start', index: 0, blockType: 'text' },
            { type: 'text-delta', index: 0, text: RETRY_PARTIAL },
          ],
        } },
        // Append the fixture's own success as the retry attempt — single-
        // sourced from the recording, never copied into a committed sidecar.
        { at: 1, entry: derived[0]! },
      ],
    }), {
      mode: 'normal', maxRetries: 5, retryableCodes: ['SERVER'],
      backoff: { initialDelayMs: 25, maxDelayMs: 25, jitterRatio: 0 },
    })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-retry'))
    const releaseFailure = Promise.withResolvers<undefined>()
    const retryReady = Promise.withResolvers<undefined>()
    const releaseRetry = Promise.withResolvers<undefined>()
    const requestStates: string[] = []
    let attempts = 0
    // Retirement must follow a visible partial, not race the first browser paint.
    const stopHolding = scaffold!.ctx.on('llm/stream', async function* (_request, next) {
      if (++attempts === 2) {
        retryReady.resolve(undefined)
        await releaseRetry.promise
      }
      for await (const chunk of next()) {
        yield chunk
        if (chunk.type === 'text-delta' && chunk.text === RETRY_PARTIAL) await releaseFailure.promise
      }
    })
    try {
      const { settled } = await sendPrompt(60_000)
      await page.getByText(RETRY_PARTIAL, { exact: true }).waitFor({ timeout: 15_000 })
      releaseFailure.resolve(undefined)
      await retryReady.promise
      await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
      await page.getByRole('table').getByRole('button', { name: 'Request #1', exact: true }).click()
      const overview = page.getByRole('tabpanel').locator('dl').first()
      await overview.getByText('Pending', { exact: true }).waitFor()
      await overview.getByText('Last attempt error', { exact: true }).waitFor()
      expect(await overview.getByText('Error', { exact: true }).count()).toBe(0)
      requestStates.push('# Retrying request', await overview.ariaSnapshot())
      await page.getByRole('tab', { name: 'Chat', exact: true }).click()
      releaseRetry.resolve(undefined)
      await settled
    } finally {
      releaseFailure.resolve(undefined)
      releaseRetry.resolve(undefined)
      stopHolding()
    }
    expect(turnEndReasons(sessionEvents).at(-1)).toBe('completed')
    // The durable retry record proves the second attempt (request/header logs
    // only on change, so attempt count is invisible there).
    expect(sessionEvents.filter(e => e.type === 'llm/retry').length).toBeGreaterThanOrEqual(1)
    await expect.poll(() => page.getByText('event sourcing', { exact: false }).count(), { timeout: 10_000 }).toBeGreaterThan(0)
    await expect.poll(() => page.getByText(RETRY_PARTIAL, { exact: true }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    // Golden of the recovered end-state: the discarded partial stays absent,
    // while the settled retry row remains as durable recovery context.
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold!.workspaceCwd)
    await compareOrRefreshGolden(RETRY_EXPECTED, snapshot, MODE)
    const expanded = await captureExpandedTurnProcessAria(
      page,
      '[class*="centerCol"]',
      scaffold!.workspaceCwd,
    )
    await compareOrRefreshGolden(RETRY_EXPANDED_EXPECTED, expanded, MODE)
    await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
    await page.getByRole('table').getByRole('button', { name: 'Request #1', exact: true }).click()
    const overview = page.getByRole('tabpanel').locator('dl').first()
    await overview.getByText('Completed', { exact: true }).waitFor()
    await overview.getByText('Last attempt error', { exact: true }).waitFor()
    expect(await overview.getByText('Error', { exact: true }).count()).toBe(0)
    requestStates.push('# Recovered request', await overview.ariaSnapshot())
    await compareOrRefreshGolden(RETRY_REQUEST_EXPECTED, requestStates.join('\n\n'), MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it.skipIf(MODE === 'record')('surfaces the terminal turn error after transient retries exhaust', async () => {
    // A whole-script replacement: three throw entries cover the first request
    // plus both budgeted retries (patches cannot reach past the one-call
    // derived script). The scenario-owned policy keeps exhaustion fast and
    // jitter-free instead of walking the shared default's five backed-off
    // attempts.
    const failure: ReplayEntry = { kind: 'throw', chunks: [], message: 'upstream 503', code: 'SERVER' }
    await launch(
      () => [failure, failure, failure],
      { mode: 'normal', maxRetries: 2, retryableCodes: ['SERVER'], backoff: { initialDelayMs: 25, maxDelayMs: 50, jitterRatio: 0 } },
    )
    onTestFailed(() => saveFailureShot(page, 'web-e2e-retry-exhausted'))
    const { settled } = await sendPrompt(60_000)
    await settled
    expect(turnEndReasons(sessionEvents).at(-1)).toBe('error')
    expect(sessionEvents.filter(e => e.type === 'llm/retry').length).toBe(2)
    await expect.poll(() => page.locator('[data-composer-input]').first().isEnabled(), { timeout: 10_000 }).toBe(true)
    expect(await page.locator('[data-streaming="true"]:not([inert] *)').count()).toBe(0)
    // The terminal error row must render even though the turn owns a retry
    // chain: exhausted recovery shares the failing turn, so suppressing the
    // row by retry history would leave the failure invisible.
    const errorStatus = page.getByRole('status').filter({ hasText: 'This turn failed' })
    await errorStatus.waitFor({ timeout: 10_000 })
    expect(await errorStatus.textContent()).toContain('The server is busy. Please try again later.')
    expect(await errorStatus.textContent()).not.toContain('upstream 503')
    expect(await errorStatus.textContent()).not.toContain('SERVER')
    expect(sessionEvents.findLast(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'error', error: { code: 'SERVER', message: 'upstream 503' } } },
    })
    // The settled retry chain stays alongside the terminal row as recovery
    // context; the golden pins both.
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold!.workspaceCwd)
    await compareOrRefreshGolden(RETRY_EXHAUSTED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.v3.jsonl', 'cancel.expected.md', 'cancel-expanded.expected.md',
      'loading.expected.md', 'running-draft.expected.md', 'error-auth.expected.md',
      'retry.expected.md', 'retry-expanded.expected.md', 'retry-request.expected.md', 'retry-exhausted.expected.md',
    ])
  })
})
