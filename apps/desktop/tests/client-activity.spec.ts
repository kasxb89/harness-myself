import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopClientActivity, type DesktopActivitySample } from '../src/client-activity.ts'

const owned: DesktopClientActivity[] = []
afterEach(async () => {
  try { await Promise.all(owned.splice(0).map(activity => activity.dispose())) }
  finally { vi.useRealTimers() }
})

function fixture() {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  let focused = true
  const events: DesktopActivitySample[] = []
  const sender = vi.fn(async (event: DesktopActivitySample, _signal: AbortSignal) => { events.push(event) })
  const activity = new DesktopClientActivity('win32', '1.2.3', () => focused)
  owned.push(activity)
  return { activity, events, sender, focus(value: boolean) { focused = value; activity.changed() } }
}

describe('Desktop activity ownership', () => {
  it.each([-86_400_000, 86_400_000])('keeps the 30-second heartbeat interval when wall time changes by %i ms', async (shift) => {
    const f = fixture()
    f.activity.connect(f.sender)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(f.events).toHaveLength(1)
    const elapsedBeforeAdjustment = performance.now()
    const wallBeforeAdjustment = Date.now()
    vi.setSystemTime(wallBeforeAdjustment + shift)
    expect(Date.now()).toBe(wallBeforeAdjustment + shift)
    expect(performance.now()).toBe(elapsedBeforeAdjustment)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(f.events).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.events).toHaveLength(2)
    expect(f.events.at(-1)).toMatchObject({ event: 'heartbeat', foreground: true })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.events).toHaveLength(3)
    expect(f.events.at(-1)).toMatchObject({ event: 'heartbeat', foreground: true })
  })

  it('reports one process identity, keeps background presence and excludes locked or idle foreground use', async () => {
    const f = fixture()
    f.activity.connect(f.sender)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.events).toMatchObject([{ event: 'start', foreground: true, platform: 'win32', app_version: '1.2.3' }])
    await vi.advanceTimersByTimeAsync(29_999)
    expect(f.events).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.events.at(-1)).toMatchObject({ event: 'heartbeat', foreground: true })
    f.focus(false)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.events.at(-1)).toMatchObject({ event: 'heartbeat', foreground: false })
    f.focus(true)
    f.activity.setLocked(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.events.at(-1)?.foreground).toBe(false)
    f.activity.setLocked(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.events.at(-1)?.foreground).toBe(true)
    f.activity.setSuspended(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.events.at(-1)?.foreground).toBe(false)
    f.activity.setSuspended(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.events.at(-1)?.foreground).toBe(true)
    expect(new Set(f.events.map(event => event.session_id)).size).toBe(1)
    expect(Object.keys(f.events[0]!)).toEqual(['session_id', 'event', 'foreground', 'platform', 'app_version'])
    await f.activity.dispose()
    expect(f.events.at(-1)).toMatchObject({ event: 'stop', foreground: false })
    const count = f.events.length
    f.activity.changed()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(f.events).toHaveLength(count)
  })

  it('contains transport failures and reconnects without replaying missed samples', async () => {
    const f = fixture()
    f.sender.mockRejectedValueOnce(new Error('offline'))
    f.activity.connect(f.sender)
    await vi.advanceTimersByTimeAsync(0)
    f.activity.connect(undefined)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(f.sender).toHaveBeenCalledTimes(1)
    f.activity.connect(f.sender)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.sender).toHaveBeenCalledTimes(2)
    expect(f.events).toHaveLength(1)
  })

  it('settles a pending report before the final bounded stop', async () => {
    const f = fixture()
    const waiting = Promise.withResolvers<undefined>()
    let signal: AbortSignal | undefined
    f.sender.mockImplementationOnce(async (_sample, lifetime) => { signal = lifetime; await waiting.promise })
    f.activity.connect(f.sender)
    await vi.advanceTimersByTimeAsync(0)
    const closing = f.activity.dispose()
    expect(signal?.aborted).toBe(true)
    expect(f.sender).toHaveBeenCalledTimes(1)
    waiting.resolve(undefined)
    await closing
    expect(f.events).toMatchObject([{ event: 'stop', foreground: false }])
  })
})
