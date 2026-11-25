/** Permanent Session deletion through the built browser, Remote and real JSONL persistence. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished, vi } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const seed = new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url)

it('confirms one permanent Session deletion without removing another conversation or its independent files', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const original = await readFile(seed, 'utf8')
  const deleted = await seedSession(scaffold, original, 'delete-session-browser-fixture')
  const retained = await seedSession(scaffold, original, 'retained-session-browser-fixture')
  const title = 'Delete this fixture conversation'
  const retainedTitle = 'Keep this fixture conversation'
  await scaffold.ctx.sessionController.rename({ sessionId: deleted, title })
  await scaffold.ctx.sessionController.rename({ sessionId: retained, title: retainedTitle })
  const artifact = join(scaffold.workspaceCwd, 'independent-output.txt')
  await writeFile(artifact, 'Keep this output after deleting the conversation.')
  const removed = vi.fn()
  scaffold.ctx.on('api-session/removed', removed)
  const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  let failurePage: Page | undefined
  try {
    const page = await newEnglishPage(browser)
    failurePage = page
    const console = watchConsole(page)
    // Only the UI sign-in prerequisite is synthetic; deletion uses the real
    // authenticated local Remote and the scaffold's private persistence.
    const account = { id: '7', phone: '+8613800000000' }, accountOwner = 'a'.repeat(64)
    await page.route('**/credits/api/session', route => route.fulfill({ json: { ok: true,
      payload: { signedIn: true, creditsPerYuan: 1000, account, accountOwner } } }))
    await page.route('**/credits/api/summary', route => route.fulfill({ json: { ok: true, account, accountOwner,
      payload: { balance_points: 1000 } } }))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const ungrouped = page.getByText('Ungrouped', { exact: true })
    const group = ungrouped.locator('xpath=ancestor::*[@aria-expanded][1]')
    await group.waitFor()
    if (await group.getAttribute('aria-expanded') !== 'true') await ungrouped.click()
    const row = page.getByRole('treeitem').filter({ has: page.getByText(title, { exact: true }) })
    const openDelete = async () => {
      await row.hover()
      await row.getByRole('button', { name: `Session actions for ${title}` }).click()
      await page.getByRole('menuitem', { name: 'Delete session', exact: true }).click()
      await page.getByRole('dialog', { name: 'Permanently delete this session?' }).waitFor()
    }
    await openDelete()
    expect(await scaffold.ctx.sessionPersistence.stat(deleted)).toBeDefined()
    expect(removed).not.toHaveBeenCalled()
    const dialog = page.getByRole('dialog', { name: 'Permanently delete this session?' })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    expect(await scaffold.ctx.sessionPersistence.stat(deleted)).toBeDefined()
    await openDelete()
    await dialog.getByRole('button', { name: 'Permanently delete', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => scaffold.ctx.sessionPersistence.stat(deleted)).toBeUndefined()
    await expect.poll(() => row.count()).toBe(0)
    expect(removed).toHaveBeenCalledExactlyOnceWith(deleted)
    expect(await scaffold.ctx.sessionPersistence.stat(retained)).toBeDefined()
    expect(await readFile(artifact, 'utf8')).toBe('Keep this output after deleting the conversation.')
    await page.reload({ waitUntil: 'load' })
    await page.getByText(retainedTitle, { exact: true }).waitFor()
    expect(await row.count()).toBe(0)
    expect(await scaffold.ctx.sessionPersistence.stat(deleted)).toBeUndefined()
    expect(console.pageErrors).toEqual([])
  } catch (error: unknown) {
    if (failurePage !== undefined) {
      await saveFailureShot(failurePage, 'web-e2e-session-delete')
      await writeFile(new URL('../../../.artifacts/web-e2e-session-delete.txt', import.meta.url),
        await failurePage.locator('body').innerText(), { mode: 0o600 })
    }
    throw error
  } finally {
    await browser.close()
  }
}, 120_000)
