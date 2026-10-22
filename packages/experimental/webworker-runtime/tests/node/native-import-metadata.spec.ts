/** Native-only dependencies expose genuine boot metadata and reject every reachable native action. */
import { constants as nativeHttp2 } from 'node:http2'
import { afterEach, expect, it, vi } from 'vitest'
import inspector from '../../src/node/builtin_modules/implemented/inspector.ts'
import http2 from '../../src/node/builtin_modules/mock/http2.ts'
import readline from '../../src/node/builtin_modules/mock/readline.ts'
import { createNodeBuiltins } from '../../src/node/builtins.ts'

afterEach(() => { vi.restoreAllMocks() })

it('reports no Node inspector endpoint without pretending native debug sessions are available', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(inspector.url()).toBeUndefined()
  expect(() => { inspector.open() }).toThrow('node:inspector.open is not available')
  expect(() => { new inspector.Session() }).toThrow('node:inspector.Session is not available')
  expect(createNodeBuiltins()['node:inspector']?.()).toMatchObject({ default: inspector })
})

it('preserves all four HTTP2 pseudo-header constants and refuses native connections', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(http2.constants).toEqual({
    HTTP2_HEADER_SCHEME: nativeHttp2.HTTP2_HEADER_SCHEME,
    HTTP2_HEADER_METHOD: nativeHttp2.HTTP2_HEADER_METHOD,
    HTTP2_HEADER_PATH: nativeHttp2.HTTP2_HEADER_PATH,
    HTTP2_HEADER_STATUS: nativeHttp2.HTTP2_HEADER_STATUS,
  })
  expect(() => { http2.connect('https://offline.invalid') }).toThrow('node:http2.connect is not available')
  const table = createNodeBuiltins()
  expect(table.http2?.()).toBe(table['node:http2']?.())
})

it('refuses a native process line reader instead of returning a fake launch result', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(() => { readline.createInterface({ input: process.stdin }) }).toThrow('node:readline.createInterface is not available')
  expect(createNodeBuiltins()['node:readline']?.()).toMatchObject({ default: readline })
})
