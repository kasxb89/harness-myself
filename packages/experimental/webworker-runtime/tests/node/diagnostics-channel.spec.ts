/** Optional cache diagnostics retain real subscriptions and refuse unsupported asynchronous context tracing. */
import { channel as nativeChannel } from 'node:diagnostics_channel'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { channel, tracingChannel } from '../../src/node/builtin_modules/implemented/diagnostics_channel.ts'

afterEach(() => { vi.restoreAllMocks() })

it('reuses named channels and follows Node duplicate subscription, removal, and publication order', () => {
  const exercise = (make: typeof channel | typeof nativeChannel): unknown[] => {
    const name = `dsh-cache-probe:${randomUUID()}`
    const entry = make(name)
    const trace: unknown[] = [entry === make(name), entry.hasSubscribers]
    const first = (value: unknown, label: string | symbol): void => { trace.push(['first', value, label === name]) }
    const second = (value: unknown): void => { trace.push(['second', value]) }
    entry.subscribe(first); entry.subscribe(second); entry.subscribe(first)
    trace.push(entry.hasSubscribers)
    entry.publish('before')
    trace.push(entry.unsubscribe(first))
    entry.publish('after')
    trace.push(entry.unsubscribe(first), entry.unsubscribe(second), entry.unsubscribe(first), entry.hasSubscribers)
    return trace
  }
  expect(exercise(channel)).toEqual(exercise(nativeChannel))
})

it('reflects tracing-channel subscribers without enabling a native asynchronous store context', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const name = `dsh-lru-probe:${randomUUID()}`
  const tracing = tracingChannel(name)
  expect(tracing.start).toBe(channel(`tracing:${name}:start`))
  expect(tracing.hasSubscribers).toBe(false)
  const observer = vi.fn()
  tracing.start.subscribe(observer)
  expect(tracing.hasSubscribers).toBe(true)
  tracing.start.publish({ operation: 'cache' })
  expect(observer).toHaveBeenCalledExactlyOnceWith({ operation: 'cache' }, `tracing:${name}:start`)
  expect(tracing.start.unsubscribe(observer)).toBe(true)
  expect(tracing.hasSubscribers).toBe(false)
  expect(() => tracing.tracePromise()).toThrow('TracingChannel.tracePromise is not available')
})
