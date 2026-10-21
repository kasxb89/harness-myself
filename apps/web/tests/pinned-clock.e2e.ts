import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { pinBrowserClock, pinHostClock, WEB_FIXTURE_TIME } from './support.ts'

it('pins Date across reload under a Host clock spy while native timers and animation frames keep running', async () => {
  const hostClock = pinHostClock()
  let browser: Browser | undefined
  try {
    browser = await chromium.launch()
    const page = await browser.newPage({ timezoneId: 'UTC' })
    await pinBrowserClock(page)
    await page.goto('data:text/html,<title>Clock contract</title>')
    const contract = await page.evaluate(async () => {
      const before = Date.now()
      await new Promise<void>(resolve => setTimeout(resolve, 20))
      await new Promise<void>(resolve => requestAnimationFrame(() => { resolve() }))
      class DerivedDate extends Date {}
      const derived = new DerivedDate(2001, 1, 3, 4, 5, 6, 7)
      return {
        before, after: Date.now(),
        constructed: new Date(2001, 1, 3, 4, 5, 6, 7).getTime(),
        copied: new Date(new Date('2001-02-03T04:05:06.007Z')).toISOString(),
        called: Date(),
        parsed: Date.parse('2001-02-03T04:05:06.007Z'),
        utc: Date.UTC(2001, 1, 3, 4, 5, 6, 7),
        prototype: Object.getPrototypeOf(new Date()) === Date.prototype,
        instance: derived instanceof DerivedDate && derived instanceof Date,
        timerIsNative: setTimeout.toString().includes('[native code]'),
        performanceIsNative: performance.now.toString().includes('[native code]'),
      }
    })
    const explicit = Date.parse('2001-02-03T04:05:06.007Z')
    expect(contract).toMatchObject({
      constructed: explicit, copied: '2001-02-03T04:05:06.007Z', parsed: explicit, utc: explicit,
      prototype: true, instance: true, timerIsNative: true, performanceIsNative: true,
    })
    expect(contract.called).toContain('Jan 15 2026')
    expect(contract.before).toBeGreaterThanOrEqual(WEB_FIXTURE_TIME)
    expect(contract.after).toBeGreaterThan(contract.before)
    await page.reload()
    const afterReload = await page.evaluate(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      await new Promise<void>(resolve => requestAnimationFrame(() => { resolve() }))
      return Date.now()
    })
    expect(afterReload).toBeGreaterThanOrEqual(contract.after)
    expect(afterReload - WEB_FIXTURE_TIME).toBeLessThan(30_000)
  } finally {
    try { await browser?.close() } finally { hostClock.mockRestore() }
  }
})
