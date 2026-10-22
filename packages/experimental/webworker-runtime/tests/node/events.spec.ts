/**
 * The `node:events` shim's dispatch semantics. Harness code registers on this
 * class through the module proxy table and branches on what it returns, so the
 * cases below pin the parts a hand-written emitter gets wrong: the boolean
 * `emit` reports, the point at which `once` unregisters, and the listener set an
 * in-flight emit dispatches to.
 */
import { EventEmitter as NativeEventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { inherits } from '../../src/node/builtin_modules/implemented/util.ts'
import { EventEmitter } from '../../src/node/builtin_modules/implemented/events.ts'

describe('emit', () => {
  it('reports whether the event reached a listener', () => {
    const emitter = new EventEmitter()
    expect(emitter.emit('ready')).toBe(false)
    emitter.on('ready', () => {})
    expect(emitter.emit('ready')).toBe(true)
    emitter.removeAllListeners('ready')
    expect(emitter.emit('ready')).toBe(false)
  })

  it('calls the listeners in registration order with every argument', () => {
    const emitter = new EventEmitter()
    const seen: string[] = []
    emitter.on('data', (...args) => { seen.push(`first:${args.join(',')}`) })
    emitter.on('data', (...args) => { seen.push(`second:${args.join(',')}`) })
    emitter.emit('data', 'a', 1, true)
    expect(seen).toEqual(['first:a,1,true', 'second:a,1,true'])
  })

  it('puts a prepended listener ahead of the ones already registered', () => {
    const emitter = new EventEmitter()
    const seen: string[] = []
    emitter.on('data', () => { seen.push('registered') })
    emitter.prependListener('data', () => { seen.push('prepended') })
    emitter.emit('data')
    expect(seen).toEqual(['prepended', 'registered'])
  })

  it('dispatches to the listeners present when the emit began', () => {
    // Node dispatches over a copy, so a removal from inside a listener takes
    // effect on the NEXT emit; a shim that iterated the live list would skip the
    // second listener here.
    const emitter = new EventEmitter()
    const seen: string[] = []
    const second = (): void => { seen.push('second') }
    emitter.on('data', () => {
      seen.push('first')
      emitter.off('data', second)
    })
    emitter.on('data', second)
    emitter.emit('data')
    emitter.emit('data')
    expect(seen).toEqual(['first', 'second', 'first'])
  })
})

describe('once', () => {
  it('unregisters before it calls, so a re-entrant emit does not repeat it', () => {
    const emitter = new EventEmitter()
    let calls = 0
    emitter.once('settled', () => {
      calls += 1
      // A listener that reacts by emitting the same event is the shape that
      // re-enters a once listener whose removal happens after the call.
      emitter.emit('settled')
    })
    emitter.emit('settled')
    expect(calls).toBe(1)
    expect(emitter.listenerCount('settled')).toBe(0)
  })

  it('passes the emit arguments through the wrapper', () => {
    const emitter = new EventEmitter()
    const seen: unknown[][] = []
    emitter.once('exit', (...args) => { seen.push(args) })
    emitter.emit('exit', 3, 'SIGTERM')
    expect(seen).toEqual([[3, 'SIGTERM']])
  })

  it('unregisters through the original listener, not only the wrapper', () => {
    // Node reaches the once wrapper by the listener handed to `once`, so a caller
    // that never saw the wrapper can still cancel its own registration.
    const emitter = new EventEmitter()
    let calls = 0
    const listener = (): void => { calls += 1 }
    emitter.once('ready', listener)
    emitter.off('ready', listener)
    expect(emitter.listenerCount('ready')).toBe(0)
    expect(emitter.emit('ready')).toBe(false)
    expect(calls).toBe(0)
  })
})

describe('registration bookkeeping', () => {
  it('hands out a copy of the listener list', () => {
    const emitter = new EventEmitter()
    emitter.on('data', () => {})
    emitter.listeners('data').length = 0
    expect(emitter.listenerCount('data')).toBe(1)
  })

  it('clears one event by name and every event without one', () => {
    const emitter = new EventEmitter()
    emitter.on('data', () => {})
    emitter.on('error', () => {})
    emitter.removeAllListeners('data')
    expect([emitter.listenerCount('data'), emitter.listenerCount('error')]).toEqual([0, 1])
    emitter.removeAllListeners()
    expect(emitter.listenerCount('error')).toBe(0)
  })

  it('removes only the listener named, and tolerates one that never registered', () => {
    const emitter = new EventEmitter()
    const kept = (): void => {}
    const dropped = (): void => {}
    emitter.on('data', kept).on('data', dropped)
    emitter.removeListener('data', dropped)
    emitter.off('data', (): void => {})
    emitter.off('absent', kept)
    expect(emitter.listeners('data')).toEqual([kept])
  })

  it('removes the last registration of a listener added twice', () => {
    // Removal searches from the tail and stops at one match, as Node does, so
    // the earlier registration is the one that stays — visible here in the order
    // the surviving listeners run.
    const emitter = new EventEmitter()
    const seen: string[] = []
    const repeated = (): void => { seen.push('repeated') }
    emitter.on('data', repeated)
    emitter.on('data', () => { seen.push('other') })
    emitter.on('data', repeated)
    emitter.off('data', repeated)
    emitter.emit('data')
    expect(seen).toEqual(['repeated', 'other'])
  })
})


describe('legacy emitter consumers', () => {
  it('matches Node when util.inherits consumers omit the parent constructor', () => {
    const trace = (parent: typeof EventEmitter): unknown[] => {
      function Legacy(): void {}
      inherits(Legacy, parent)
      const emitter = Reflect.construct(Legacy, []) as EventEmitter
      const seen: unknown[] = [emitter.emit('missing')]
      function listener(this: unknown, value: unknown): void { seen.push([this === emitter, value]) }
      emitter.on('data', listener).once('data', listener)
      emitter.emit('data', 1)
      emitter.removeListener('data', listener)
      seen.push(emitter.emit('data', 2))
      return seen
    }
    expect(trace(EventEmitter)).toEqual(trace(NativeEventEmitter))
    expect(trace(EventEmitter)).toEqual([false, [true, 1], [true, 1], false])
  })

  it('borrows emit on a plain object and keeps Worker registry state per object', () => {
    for (const Emitter of [EventEmitter, NativeEventEmitter]) expect(Emitter.prototype.emit.call({}, 'unused')).toBe(false)
    {
      const prototype = new EventEmitter()
      let inheritedCalls = 0
      prototype.on('data', () => { inheritedCalls++ })
      const first = Object.create(prototype) as EventEmitter
      const second = Object.create(prototype) as EventEmitter
      const seen: string[] = []
      first.on('own', () => { seen.push('first') })
      expect(second.emit('own')).toBe(false)
      expect(first.emit('own')).toBe(true)
      // The Worker stores each receiver's state privately, including legacy
      // objects inheriting an already populated emitter instance.
      first.on('data', () => { seen.push('own-data') })
      first.emit('data')
      expect(seen).toEqual(['first', 'own-data'])
      expect(inheritedCalls).toBe(0)
    }
  })

  it('throws the original unhandled error and delivers handled errors with the emitter receiver', () => {
    for (const Emitter of [EventEmitter, NativeEventEmitter]) {
      const emitter = new Emitter()
      const error = new Error('consumer failure')
      let caught: unknown
      try { emitter.emit('error', error) } catch (failure) { caught = failure }
      expect(caught).toBe(error)
      const received: unknown[] = []
      emitter.once('error', function (this: unknown, value: unknown): void { received.push(this, value) })
      expect(emitter.emit('error', error)).toBe(true)
      expect(received).toEqual([emitter, error])
    }
  })
})
