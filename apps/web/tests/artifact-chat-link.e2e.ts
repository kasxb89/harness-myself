/** A saved output returns to its recorded generating card through the assembled shell. */
import { mkdir, mkdtemp } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-artifacts-index'
import {
  ToolCallId, createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage,
} from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION, Session, SessionId, type SessionEvent, type SessionSeq,
} from '@deepseek-ai/dsh-session'
// Carries the persisted session/title event into the fixture's canonical append calls.
import type {} from '@deepseek-ai/dsh-session-title'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const overlay = fileURLToPath(new URL('./fixtures/artifact-library/cordis.patch.yml', import.meta.url))

interface SourceFixture {
  readonly log: string
  readonly firstPrompt: string
  readonly tail: string
  readonly callId: ToolCallId
  readonly sourceSeq: SessionSeq
}

function createSourceFixture(prefix: string, turns: number): SourceFixture {
  const session = Session.create(SessionId(`artifact-link-${prefix}-template`))
  const events: SessionEvent[] = []
  const record = <T extends SessionEvent>(event: T): T => { events.push(event); return event }
  const callId = ToolCallId(`artifact-link-${prefix}-generate-image`)
  const firstPrompt = `ARTIFACT_LINK_${prefix}_USER_1`
  const tail = `ARTIFACT_LINK_${prefix}_ANSWER_${String(turns)}`
  const args = JSON.stringify({ prompt: 'A synthetic fixture image; this recorded call never runs.' })
  let sourceSeq: SessionSeq | undefined
  for (let turn = 1; turn <= turns; turn++) {
    record(session.append('turn/start', { turn }))
    record(session.append('step/start', { turn, step: 1 }))
    if (turn === 1) {
      record(session.append('system/message', {
        turn, step: 1, message: createSystemMessage('Synthetic artifact source-chat history.'),
      }, { surfaceOp: 'append' }))
    }
    const user = record(session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `ARTIFACT_LINK_${prefix}_USER_${String(turn)} Review this saved output.` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }))
    if (turn === 1) {
      record(session.append('session/title', {
        title: `Artifact source ${prefix}`, messageSeqs: [user.seq], source: { kind: 'fallback' },
      }))
    }
    record(session.append('request/header', {
      header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
      reason: turn === 1 ? 'initial' : 'change',
    }))
    if (turn === 1) {
      record(session.append('assistant/message', {
        stream: [], turn, step: 1,
        message: createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'Preparing the recorded image output.' },
            { type: 'tool-call', id: callId, name: 'generate_image', arguments: args },
          ],
          source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        }),
      }, { surfaceOp: 'append' }))
      const call = record(session.append('tool/call', {
        turn, step: 1, callId, name: 'generate_image', arguments: args,
      }))
      sourceSeq = call.seq
      record(session.append('tool/result', {
        turn, step: 1,
        message: createToolResultMessage({
          callId, isError: false,
          content: [{ type: 'text', text: `ARTIFACT_LINK_${prefix}_GENERATED The fixture output was saved.` }],
        }),
      }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] }))
      record(session.append('step/end', { turn, step: 1 }))
      record(session.append('step/start', { turn, step: 2 }))
      record(session.append('request/header', {
        header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }, reason: 'change',
      }))
    }
    const step = turn === 1 ? 2 : 1
    record(session.append('assistant/message', {
      stream: [], turn, step,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `ARTIFACT_LINK_${prefix}_ANSWER_${String(turn)} The saved output is ready.` }],
        source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      }),
    }, { surfaceOp: 'append' }))
    record(session.append('step/end', { turn, step }))
    record(session.append('turn/end', { turn, reason: { kind: 'completed' } }))
  }
  if (sourceSeq === undefined) throw new Error('artifact source fixture needs at least one closed turn')
  const header = { type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}',
    createdAt: 0, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }
  return { log: [JSON.stringify(header), ...events.map(event => JSON.stringify(event)), ''].join('\n'),
    firstPrompt, tail, callId, sourceSeq }
}

async function openFixture(page: Page, fixture: SourceFixture): Promise<void> {
  const toggle = page.getByRole('button', { name: 'Search sessions', exact: true })
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  await page.getByRole('textbox', { name: 'Search session names', exact: true }).fill(fixture.firstPrompt)
  const result = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => result.count(), { timeout: 60_000 }).toBe(1)
  await result.click()
  // The product hides view tabs when Chat is the only visible view; its own transcript is the ready signal.
  await page.locator('[data-conversation-scroll]').getByText(fixture.tail, { exact: false })
    .waitFor({ timeout: 30_000 })
}

it('returns from a trusted artifact to the exact older generating card in another chat', async () => {
  const evidenceRoot = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
  await mkdir(evidenceRoot, { recursive: true })
  const evidence = await mkdtemp(join(evidenceRoot, 'artifact-chat-link-'))
  const cleanup: { scaffold?: () => Promise<void>; browser?: () => Promise<void> } = {}
  onTestFinished(async () => {
    try { await cleanup.browser?.() }
    finally { await cleanup.scaffold?.() }
  })
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
  cleanup.scaffold = () => scaffold.close()
  const source = createSourceFixture('SOURCE', 40)
  const other = createSourceFixture('OTHER', 2)
  const sourceId = await seedSession(scaffold, source.log, 'artifact-chat-source-e2e')
  await seedSession(scaffold, other.log, 'artifact-chat-other-e2e')
  const signal = new AbortController().signal
  const destination = await scaffold.ctx.artifactStorage.capture(signal)
  await scaffold.ctx.artifactStorage.write({ destination, filename: 'recorded-output.txt',
    bytes: Buffer.from('The generated artifact belongs to the first turn of the source chat.\n'), signal,
    origin: { sessionId: sourceId, turn: 1, eventSeq: source.sourceSeq, toolCallId: source.callId } })
  // A plausible output name has no authority to associate an older file with either chat.
  await scaffold.ctx.artifactStorage.write({ destination, filename: 'generate_image-legacy-output.txt',
    bytes: Buffer.from('An older output with no trusted source record.\n'), signal })
  const browser = await chromium.launch()
  cleanup.browser = () => browser.close()
  const page = await newEnglishPage(browser)
  const consoleState = watchConsole(page)
  try {
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByText('Ungrouped', { exact: true }).waitFor({ timeout: 30_000 })
    await openFixture(page, source)
    // The source is outside the initial history page; navigation must load it through the real session pager.
    expect(await page.locator(`[data-chat-call-id="${source.callId}"]`).count()).toBe(0)
    await openFixture(page, other)
    expect(await page.locator(`[data-chat-call-id="${source.callId}"]`).count()).toBe(0)
    await page.getByRole('button', { name: 'Artifacts', exact: true }).click()
    const heading = page.getByRole('heading', { name: 'Artifact library', exact: true })
    await heading.waitFor()
    const library = heading.locator('..').locator('..')
    const preview = library.getByRole('region', { name: 'Preview', exact: true })
    await library.getByRole('button', { name: /^generate_image-legacy-output\.txt/u }).click()
    await preview.getByText('Source chat unavailable', { exact: true }).waitFor()
    expect(await preview.getByRole('button', { name: 'Back to chat', exact: true }).count()).toBe(0)
    await library.getByRole('button', { name: /^recorded-output\.txt/u }).click()
    await preview.getByRole('button', { name: 'Back to chat', exact: true }).click()

    const chat = page.locator('[data-conversation-scroll]')
    const card = chat.locator(`[data-chat-call-id="${source.callId}"]`)
    await card.waitFor({ state: 'visible', timeout: 30_000 })
    await chat.getByText(`${source.firstPrompt} Review this saved output.`, { exact: true }).waitFor()
    expect(await chat.locator(`[data-chat-call-id="${other.callId}"]`).count()).toBe(0)
    expect(await chat.locator('[data-turn-process="1"]').getAttribute('aria-expanded')).toBe('true')
    const group = card.locator('xpath=ancestor::*[@data-chat-group-key][1]')
    expect(await group.locator('[data-process-activity]').getAttribute('aria-expanded')).toBe('true')
    expect(await card.locator('[data-tool="generate_image"]').count()).toBe(1)
    // Visibility alone ignores clipping: the selected card must intersect both the outer scrollport and its process body.
    await expect.poll(() => page.evaluate((callId) => {
      const element = document.querySelector(`[data-conversation-scroll] [data-chat-call-id="${callId}"]`)
      if (element === null) return false
      const scroll = element.closest('[data-conversation-scroll]')
      const body = element.closest('[data-step-process-body]')
      if (scroll === null || element.closest('[hidden]') !== null) return false
      const rect = element.getBoundingClientRect()
      const outer = scroll.getBoundingClientRect()
      const inner = body?.getBoundingClientRect()
      return rect.height > 0 && rect.bottom > Math.max(outer.top, inner?.top ?? outer.top)
        && rect.top < Math.min(outer.bottom, inner?.bottom ?? outer.bottom)
    }, source.callId), { timeout: 15_000 }).toBe(true)
    expect(consoleState.pageErrors).toEqual([])
    await page.screenshot({ path: join(evidence, 'source-generating-card.png'), animations: 'disabled' })
    console.info(`Artifact source-chat browser evidence: ${evidence}`)
  } catch (error) {
    console.error('Artifact source-chat failure diagnostics:', consoleState)
    await saveFailureShot(page, `${basename(evidence)}/failure`)
    throw error
  }
})
