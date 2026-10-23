/** Real job roster delivery preserves multiline producer progress without model calls. */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { JobHandle, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
const LABEL = 'Scene production'
const SUMMARY = 'Project: 1/4 saved\nShot 1: saved\nShot 2: generating · 12s\nShot 3: queued · 8s\nShot 4: not submitted'
const UPDATED = 'Project: 2/4 saved\nShot 1: saved\nShot 2: saved\nShot 3: generating · 14s\nShot 4: queued · 2s'

it('shows every producer stage through real job updates with bounded keyboard scrolling in narrow light and dark layouts', async () => {
  const done = Promise.withResolvers<JobOutcome>()
  const scaffold = await launchWebScaffold({})
  onTestFinished(() => scaffold.close())
  const sessionId = SessionId('job-progress-summary-web')
  await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), sessionId)
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const tripwire = watchConsole(page)
  const evidenceRoot = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
  await mkdir(evidenceRoot, { recursive: true })
  const evidence = await mkdtemp(join(evidenceRoot, 'job-progress-summary-'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]')
  await page.locator('[role="treeitem"]').first().click()
  await page.locator('[role="treeitem"]').nth(1).click()
  const ctx = scaffold.ctx
  await expect.poll(() => ctx.agents.get(sessionId)).toBeDefined()
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('Expected the opened session agent')
  let handle: JobHandle | undefined
  const jobId = ctx.jobs.start({
    kind: 'bash', label: LABEL, owner: agent.id,
    run(job) {
      handle = job
      return { done: done.promise, cancel() { done.resolve({ status: 'killed' }) } }
    },
  })
  if (handle === undefined) throw new Error('Expected a real registered job handle')
  onTestFinished(async () => {
    // Collect the fixture's own settlement before owner teardown; it is not an unsolicited model notice.
    const settlement = ctx.jobs.wait(jobId, 1000, agent.id)
    done.resolve({ status: 'completed' })
    await settlement
    ctx.jobs.read(jobId, agent.id)
    ctx.jobs.remove(jobId, agent.id)
  })
  onTestFinished(async ({ task }) => {
    if (task.result?.state === 'fail') await page.screenshot({ path: join(evidence, 'failure.png'), animations: 'disabled' })
  })
  handle.updateProgress(SUMMARY)
  const trigger = page.getByRole('button', { name: '1 background job running', exact: true })
  await trigger.click()
  const list = page.getByRole('list', { name: 'Background jobs' })
  const progress = list.getByRole('region', { name: `Progress of ${LABEL}` })
  await expect.poll(() => progress.textContent()).toBe(SUMMARY)
  expect(await list.getByRole('button', { name: `Show live output of ${LABEL}` }).getAttribute('aria-expanded')).toBe('false')
  expect(await list.getByRole('button', { name: `Stop task ${LABEL}` }).count()).toBe(1)
  handle.updateProgress(UPDATED)
  await expect.poll(() => progress.textContent()).toBe(UPDATED)
  await page.screenshot({ path: join(evidence, 'mixed-stages.png'), animations: 'disabled' })

  const long = ['Project: 8/32 saved', ...Array.from({ length: 32 }, (_, index) =>
    `Shot ${String(index + 1)}: ${index < 8 ? 'saved' : index < 16 ? 'generating' : index < 24 ? 'queued' : 'not submitted'} ${index === 31 ? 'unbroken'.repeat(28) : ''}`)].join('\n')
  handle.updateProgress(long)
  await expect.poll(() => progress.textContent()).toBe(long)
  const geometry = []
  for (const [theme, width] of [['dark', 1440], ['light', 900]] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width, height: 800 })
    await page.evaluate(async () => { await document.fonts.ready })
    await expect.poll(() => progress.evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(width - 12)
    const metrics = await progress.evaluate((element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return { x: rect.x, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight, whiteSpace: style.whiteSpace, foreground: style.color,
        background: style.backgroundColor, documentWidth: document.documentElement.scrollWidth }
    })
    expect(metrics.documentWidth).toBeLessThanOrEqual(width)
    expect(metrics.right).toBeLessThanOrEqual(width - 12)
    expect(metrics.x).toBeGreaterThanOrEqual(12)
    expect(metrics.bottom).toBeLessThanOrEqual(788)
    expect(metrics.height).toBeLessThanOrEqual(224)
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth)
    expect(metrics.whiteSpace).toBe('pre-wrap')
    await progress.focus()
    await progress.press('End')
    await expect.poll(() => progress.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop))
      .toBeLessThanOrEqual(1)
    await page.screenshot({ path: join(evidence, `scroll-end-${theme}-${String(width)}.png`), animations: 'disabled' })
    await progress.press('Home')
    await expect.poll(() => progress.evaluate(element => element.scrollTop)).toBe(0)
    await page.screenshot({ path: join(evidence, `scroll-start-${theme}-${String(width)}.png`), animations: 'disabled' })
    geometry.push({ theme, viewportWidth: width, ...metrics })
  }
  expect(geometry[0]?.foreground).not.toBe(geometry[1]?.foreground)
  await page.keyboard.press('Escape')
  await list.waitFor({ state: 'detached' })
  expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true)
  await trigger.click()
  await progress.waitFor()
  await page.mouse.click(4, 796)
  await list.waitFor({ state: 'detached' })
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
  expect(ctx.jobs.get(jobId, agent.id).progress).toBe(long)
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, initialSummary: SUMMARY,
    updatedSummary: UPDATED, longSummaryLines: long.split('\n').length, geometry, pageErrors: tripwire.pageErrors,
    warnings: tripwire.warnings, method: 'Real Loader, job registry, roster transport and built UI; no model or supplier request' }, null, 2) + '\n')
})
