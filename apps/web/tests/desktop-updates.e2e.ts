/** Built workspace chrome with a controlled Desktop carrier; no Electron or installer is exercised. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { presentDesktopUpdate } from '../../desktop/src/update-presentation.ts'
import { en } from '../../desktop/src/locale.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'

// Mirrors the preload's presentation-only API; importing Client projects would mix compiler faces.
type Presentation = ReturnType<typeof presentDesktopUpdate>
interface CarrierFixture {
  publish(state: Presentation): void
  opens: number
  checks: number
  listeners: Set<(state: Presentation) => void>
}
type FixtureWindow = Window & typeof globalThis & { updateFixture: CarrierFixture }

describe('web e2e: Desktop update workspace chrome', () => {
  it.each(['zh-CN', 'en-US'])('renders update states and routes explicit actions in %s', async (locale) => {
    const scaffold = await launchWebScaffold({})
    try {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale })
        await page.addInitScript(() => {
          let current: Presentation = { phase: 'idle' }
          const listeners = new Set<(state: Presentation) => void>()
          const fixture: CarrierFixture = {
            opens: 0, checks: 0, listeners,
            publish(state) { current = state; for (const listener of listeners) listener(state) },
          }
          Object.assign(window, {
            updateFixture: fixture,
            dshDesktop: { protocolVersion: 1, updates: {
              status: async () => current,
              check: async () => { fixture.checks += 1 },
              open: async () => { fixture.opens += 1 },
              subscribe(listener: (state: Presentation) => void) { listeners.add(listener); return () => listeners.delete(listener) },
            } },
          })
        })
        const tripwire = watchConsole(page)
        const evidenceRoot = fileURLToPath(new URL('../../desktop/.desktop-build/qualification/', import.meta.url))
        await mkdir(evidenceRoot, { recursive: true })
        const evidence = await mkdtemp(join(evidenceRoot, `workspace-updates-${locale}-`))
        try {
          await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          await page.waitForSelector('[class*="frame"]')
          await expect.poll(() => page.evaluate(() => (window as FixtureWindow).updateFixture.listeners.size)).toBe(1)
          const availableLabel = locale === 'zh-CN' ? '新版本' : 'Update'
          const retryLabel = locale === 'zh-CN' ? '重试更新' : 'Retry update'
          const errorDetail = locale === 'zh-CN' ? '下载更新失败，请重试。' : 'Could not download the update. Please try again.'
          const readyLabel = locale === 'zh-CN' ? '安装并重启' : 'Install and Restart'
          const version = '0.1.5-nightly.20260911'
          // The carrier classification deliberately uses English shell copy; Web copy follows its own locale.
          const available = presentDesktopUpdate({ phase: 'available', version }, en)
          const publish = async (state: Presentation) => page.evaluate((value) => {
            (window as FixtureWindow).updateFixture.publish(value)
          }, state)
          const opens = async () => page.evaluate(() => (window as FixtureWindow).updateFixture.opens)
          const checks = async () => page.evaluate(() => (window as FixtureWindow).updateFixture.checks)
          const checkLabel = locale === 'zh-CN' ? '检查更新' : 'Check for updates'
          const updateLabel = locale === 'zh-CN' ? '更新版本' : 'Update version'
          let actionLabel = checkLabel
          const permanentCheck = () => page.getByRole('button', { name: actionLabel, exact: true })
          await permanentCheck().waitFor()
          const checkGeometry = await permanentCheck().boundingBox()
          const mobileGeometry = await page.getByRole('button', { name: locale === 'zh-CN' ? '手机' : 'Mobile', exact: true }).boundingBox()
          expect(checkGeometry).not.toBeNull()
          expect(mobileGeometry).not.toBeNull()
          expect(checkGeometry!.y + checkGeometry!.height).toBeLessThanOrEqual(mobileGeometry!.y)
          await permanentCheck().click()
          await expect.poll(checks).toBe(1)
          expect(await opens()).toBe(0)
          await page.screenshot({ path: join(evidence, 'permanent-check.png') })

          await page.getByRole('button', { name: locale === 'zh-CN' ? '设置' : 'Settings', exact: true }).click()
          const settings = page.getByRole('dialog', { name: locale === 'zh-CN' ? '设置' : 'Settings', exact: true })
          await settings.getByRole('button', { name: locale === 'zh-CN' ? '通用设置' : 'General', exact: true }).click()
          const versionRow = settings.getByText(locale === 'zh-CN' ? /^当前版本：/ : /^Current version:/).locator('..')
          await versionRow.waitFor()
          const settingsCheck = versionRow.getByRole('button', { name: checkLabel, exact: true })
          await settingsCheck.click()
          await expect.poll(checks).toBe(2)
          expect(await opens()).toBe(0)
          await page.screenshot({ path: join(evidence, 'settings-version-check.png') })
          await settings.getByRole('button', { name: locale === 'zh-CN' ? '关闭' : 'Close', exact: true }).click()

          const showCheckTooltip = async (label: string) => {
            await page.mouse.move(0, 0)
            await permanentCheck().hover()
            const tooltip = page.getByRole('tooltip', { name: label.replaceAll('\n', ' '), exact: true })
            await expect.poll(() => tooltip.evaluateAll(elements => elements.map(element => getComputedStyle(element).opacity))).toEqual(['1'])
          }
          await publish(available)
          actionLabel = updateLabel
          await permanentCheck().waitFor()
          expect(await page.getByRole('button', { name: checkLabel, exact: true }).count()).toBe(0)
          await page.getByRole('button', { name: locale === 'zh-CN' ? '设置' : 'Settings', exact: true }).click()
          await versionRow.getByRole('button', { name: updateLabel, exact: true }).waitFor()
          await page.screenshot({ path: join(evidence, 'settings-update-version.png') })
          await settings.getByRole('button', { name: locale === 'zh-CN' ? '关闭' : 'Close', exact: true }).click()
          await showCheckTooltip(`${availableLabel}${locale === 'zh-CN' ? '：' : ': '}${version}`)
          expect(await opens()).toBe(0)
          await page.screenshot({ path: join(evidence, 'available.png') })
          await permanentCheck().click()
          await expect.poll(opens).toBe(1)
          expect(await checks()).toBe(2)

          await publish(presentDesktopUpdate({ phase: 'checking' }, en))
          actionLabel = locale === 'zh-CN' ? '正在检查更新…' : 'Checking for updates…'
          await expect.poll(() => permanentCheck().getAttribute('aria-disabled')).toBe('true')
          await permanentCheck().click({ force: true })
          expect(await checks()).toBe(2)
          expect(await opens()).toBe(1)

          const progress = presentDesktopUpdate({ phase: 'downloading', version, percent: 58 }, en)
          await publish(progress)
          actionLabel = locale === 'zh-CN' ? '下载中 58%' : 'Downloading 58%'
          await showCheckTooltip(locale === 'zh-CN' ? `正在下载更新：58%\n目标版本：${version}`
            : `Downloading update: 58%\nTarget version: ${version}`)
          expect(await permanentCheck().getAttribute('aria-disabled')).toBe('false')
          await permanentCheck().click()
          await expect.poll(opens).toBe(2)
          expect(await checks()).toBe(2)
          await page.screenshot({ path: join(evidence, 'downloading.png') })

          const collapse = locale === 'zh-CN' ? '收起侧边栏' : 'Collapse sidebar'
          const expand = locale === 'zh-CN' ? '打开侧边栏' : 'Open sidebar'
          await page.getByRole('button', { name: collapse, exact: true }).click()
          const toggle = page.getByRole('button', { name: expand, exact: true })
          const badge = toggle.getByRole('img', { name: '58%', exact: true })
          await badge.waitFor()
          expect(await permanentCheck().count()).toBe(1)
          expect(await page.getByRole('img', { name: '58%', exact: true }).count()).toBe(1)
          const updateBackground = await badge.evaluate(element => getComputedStyle(element).backgroundColor)
          await page.screenshot({ path: join(evidence, 'collapsed.png') })

          const error = presentDesktopUpdate({ phase: 'error', version, failedOperation: 'download', message: 'HTTP 503' }, en)
          await publish(error)
          actionLabel = updateLabel
          const errorBadge = toggle.getByRole('img', { name: retryLabel, exact: true })
          await errorBadge.waitFor()
          // A failure keeps the update palette; only the label distinguishes it.
          const failedBackground = await errorBadge.evaluate(element => getComputedStyle(element).backgroundColor)
          expect(failedBackground).toBe(updateBackground)
          await errorBadge.hover()
          const tooltip = page.getByRole('tooltip', { name: errorDetail, exact: true })
          await expect.poll(() => tooltip.evaluateAll(elements => elements.map(element => getComputedStyle(element).opacity))).toEqual(['1'])
          await page.screenshot({ path: join(evidence, 'collapsed-error.png') })
          await toggle.click()
          await expect.poll(() => errorBadge.count()).toBe(0)
          await showCheckTooltip(errorDetail)
          await page.screenshot({ path: join(evidence, 'retry.png') })
          await permanentCheck().click()
          await expect.poll(opens).toBe(3)
          expect(await checks()).toBe(2)

          await publish(presentDesktopUpdate({ phase: 'ready', version }, en))
          await showCheckTooltip(`${readyLabel}${locale === 'zh-CN' ? '：' : ': '}${version}`)
          expect(await permanentCheck().getAttribute('aria-disabled')).toBe('false')
          await page.screenshot({ path: join(evidence, 'ready.png') })
          await permanentCheck().click()
          await expect.poll(opens).toBe(4)
          expect(await checks()).toBe(2)
          expect(tripwire.pageErrors).toEqual([])
          expect(tripwire.warnings).toEqual([])
          expect(await page.evaluate(() => (window as FixtureWindow).updateFixture.listeners.size)).toBe(1)
          await writeFile(join(evidence, 'result.json'), JSON.stringify({ locale, checkGeometry, mobileGeometry, updateBackground, failedBackground,
            passed: true, explicitActions: await opens(), manualChecks: await checks(), carrier: 'substituted', host: 'real Web composition',
            electron: false, installerExecuted: false }, null, 2) + '\n')
          console.log(`Desktop workspace chrome evidence: ${evidence}`)
        } catch (error) {
          await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined)
          throw error
        }
      } finally { await browser.close() }
    } finally { await scaffold.close() }
  })
})
