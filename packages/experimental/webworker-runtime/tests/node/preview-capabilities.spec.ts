/** Reachable product imports retain pure behavior and refuse native actions before side effects. */
import { Buffer as NativeBuffer } from 'node:buffer'
import { inherits as nativeInherits } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import events, { EventEmitter } from '../../src/node/builtin_modules/implemented/events.ts'
import { Buffer as BrowserBuffer } from '../../src/node/builtin_modules/implemented/buffer.ts'
import { totalmem } from '../../src/node/builtin_modules/implemented/os.ts'
import { inherits } from '../../src/node/builtin_modules/implemented/util.ts'
import * as undici from '../../src/node/external_packages/undici.ts'
import { createNodeBuiltins } from '../../src/node/builtins.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { lowerModuleSource } from '../../src/compile/transform.ts'

afterEach(() => { vi.restoreAllMocks() })

it('loads tar-style default EventEmitter inheritance and preserves the named class identity', () => {
  expect(events).toBe(EventEmitter)
  expect(events.EventEmitter).toBe(EventEmitter)
  const source = lowerModuleSource({ filename: '/tar.mjs', source: 'import EE from "events"; export class Sink extends EE {}' })
  const vfs = new MemoryVfs()
  vfs.seed('/dsh/tar.js', source.code)
  const loader = new WorkerModuleLoader({ vfs, root: '/dsh', staticModules: createNodeBuiltins() })
  const require = loader.requireFrom('/dsh/')
  expect(require('events')).toBe(EventEmitter)
  expect(require('events')).toBe(require('node:events'))
  vfs.seed('/dsh/commonjs.js', 'const EE = require("events"); module.exports = class Sink extends EE {};')
  const CommonJsSink = require('./commonjs.js') as typeof EventEmitter
  expect(new CommonJsSink()).toBeInstanceOf(EventEmitter)
  const { Sink } = require('./tar.js') as { Sink: typeof EventEmitter }
  const sink = new Sink()
  const handler = vi.fn()
  sink.once('ready', handler)
  sink.emit('ready', 'value')
  sink.emit('ready', 'ignored')
  expect(handler).toHaveBeenCalledExactlyOnceWith('value')
  expect(sink).toBeInstanceOf(EventEmitter)
})

it('exposes callable bare and prefixed truthiness assertions without swallowing failures', () => {
  const vfs = new MemoryVfs()
  vfs.seedDirectory('/dsh')
  const require = new WorkerModuleLoader({ vfs, root: '/dsh', staticModules: createNodeBuiltins() }).requireFrom('/dsh/')
  const assert = require('assert') as (value: unknown) => void
  expect(assert).toBe(require('node:assert'))
  expect(() => { assert('present') }).not.toThrow()
  expect(() => { assert(false) }).toThrow(expect.objectContaining({ code: 'ERR_ASSERTION' }))
})

it('makes DNS and TLS imports available but refuses native operations explicitly', () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const table = createNodeBuiltins()
  const dns = table['node:dns']?.() as { lookup(): never }
  const tls = table['node:tls']?.() as { connect(): never }
  expect(table.dns?.()).toBe(dns)
  expect(table.tls?.()).toBe(tls)
  expect(() => dns.lookup()).toThrow('node:dns.lookup is not available')
  expect(() => tls.connect()).toThrow('node:tls.connect is not available')
  expect(errors).toHaveBeenCalledTimes(2)
})

describe('browser Buffer URL-safe output', () => {
  it('uses the exact maintained browser constructor rather than Node core', () => {
    expect(BrowserBuffer).not.toBe(NativeBuffer)
    expect(globalThis.Buffer).toBe(BrowserBuffer)
  })

  it.each([0, 1, 2, 3, 32, 255, 256])('encodes %i bytes and slices like Node without changing their bytes', (length) => {
    const input = Uint8Array.from({ length }, (_, index) => (index * 157 + 251) % 256)
    const browser = BrowserBuffer.from(input)
    const native = NativeBuffer.from(input)
    for (const [start, end] of [[undefined, undefined], [0, 1], [1, length - 1], [-1, length + 10], [length, length]] as const) {
      expect(browser.toString('base64url', start, end)).toBe(native.toString('base64url', start, end))
      expect(browser.toString('BASE64URL' as BufferEncoding, start, end)).toBe(native.toString('base64url', start, end))
    }
    expect([...browser]).toEqual([...input])
    expect(browser.toString('base64')).toBe(native.toString('base64'))
    if (length > 0) expect(() => browser.toString('unsupported' as BufferEncoding)).toThrow('Unknown encoding')
  })
})

it('links function prototypes like Node while preserving own methods and excluding static inheritance', () => {
  const trace = (inherit: typeof nativeInherits): object => {
    class Parent { static parentOnly = 1; inherited(): string { return 'parent' } }
    class Child { own(): string { return 'child' } }
    const original = Child.prototype
    inherit(Child, Parent)
    const staticLookup: unknown = Reflect.get(Child, 'parentOnly')
    return {
      kept: Child.prototype === original,
      parent: Object.getPrototypeOf(Child.prototype) === Parent.prototype,
      own: new Child().own(),
      inherited: (new Child() as Child & Parent).inherited(),
      staticInherited: Object.hasOwn(Child, 'parentOnly'),
      staticLookup,
      superDescriptor: { ...Object.getOwnPropertyDescriptor(Child, 'super_'), value: Reflect.get(Child, 'super_') === Parent },
      instanceOf: new Child() instanceof Parent,
    }
  }
  expect(trace(inherits)).toEqual(trace(nativeInherits))
})

it('reports unobservable memory with zero rather than a fabricated host capacity', () => {
  expect(totalmem()).toBe(0)
})

describe('exact undici browser adapter', () => {
  it('retains the real Fetch classes', () => {
    expect(undici.Headers).toBe(globalThis.Headers)
    expect(undici.Request).toBe(globalThis.Request)
    expect(undici.Response).toBe(globalThis.Response)
    expect(undici.FormData).toBe(globalThis.FormData)
  })

  it('passes browser request options and the response through unchanged', async () => {
    const response = new Response('offline body', { status: 202, headers: { 'x-probe': 'retained' } })
    const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    const signal = new AbortController().signal
    const options = { method: 'POST', body: 'offline input', signal, redirect: 'manual' as const, headers: new Headers({ accept: 'text/plain' }) }
    expect(await undici.fetch('https://offline.invalid/test', options)).toBe(response)
    expect(send).toHaveBeenCalledExactlyOnceWith('https://offline.invalid/test', options)
  })

  it('preserves cancellation and browser failures', async () => {
    const abort = new DOMException('Cancelled', 'AbortError')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abort)
    await expect(undici.fetch('https://offline.invalid/test')).rejects.toBe(abort)
  })

  it.each([{}, null, false, 0])('rejects an explicit dispatcher %j before calling Fetch', async (dispatcher) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unexpected offline fetch'))
    await expect(undici.fetch('https://offline.invalid/test', { dispatcher })).rejects.toThrow('undici.fetch dispatcher is not available')
    expect(send).not.toHaveBeenCalled()
  })

  it.each(['Agent', 'Pool', 'ProxyAgent', 'EnvHttpProxyAgent', 'getGlobalDispatcher', 'setGlobalDispatcher'] as const)(
    'refuses native %s without a socket or proxy fallback', (name) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unexpected offline fetch'))
      expect(() => { Reflect.construct(undici[name], []) }).toThrow(`undici.${name} is not available`)
      expect(send).not.toHaveBeenCalled()
    },
  )
})
