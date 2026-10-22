/** Current IM query decoding preserves Node's data; native Chromium launch never reports a browser. */
import { parse as nativeParse } from 'node:querystring'
import { afterEach, expect, it, vi } from 'vitest'
import { parse } from '../../src/node/builtin_modules/implemented/querystring.ts'
import renderer from '../../src/node/external_packages/puppeteer-core.ts'
import { createNodeBuiltins } from '../../src/node/builtins.ts'

afterEach(() => { vi.restoreAllMocks() })

it.each([
  '', '?', '?a=1', '??a=1', 'a=1&b=2', 'a=1&a=2&a=', 'a+b=c+d&x=%2B',
  'a=%E4%B8%AD%E6%96%87&%E7%A9%BA=%F0%9F%98%80', 'a=&b&=empty&a=next',
  'a=%&b=%ZZ&c=%E4%B8&d=%ED%A0%80', '__proto__=value&constructor=ctor&toString=text',
  'a[]=1&a[]=2&a[b]=literal', '&&a=1&&b=2&', 'x=a=b=c&encoded%26key=v%3Dvalue',
  '&'.repeat(999) + 'a=1', '&'.repeat(1000) + 'a=1',
  Array.from({ length: 1001 }, (_, index) => `key${index}=value`).join('&'),
])('decodes default flat query syntax like Node: %s', (source) => {
  const actual = parse(source)
  expect(actual).toStrictEqual(nativeParse(source))
  expect(Object.getPrototypeOf(actual)).toBeNull()
})

it('accepts explicitly named default delimiters', () => {
  expect(parse('a=1&a=2', '&', '=')).toStrictEqual(nativeParse('a=1&a=2'))
})

it.each([
  ['a:1;b:2', ';', ':', undefined],
  ['a=1', '&', '=', { maxKeys: 1 }],
  ['a=1', undefined, undefined, { decodeURIComponent: (value: string) => value }],
] as const)('refuses unsupported delimiters and decoder options %j', (source, separator, equals, options) => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(() => parse(source, separator, equals, options)).toThrow('parse custom separators or options is not available')
})

it('rejects malformed UTF-16 rather than silently replacing its code units', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(() => parse('a=\ud800')).toThrow('parse malformed UTF-16 is not available')
})

it('refuses the actual Univer launch API before returning a browser or issuing a request', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unexpected offline fetch'))
  expect(() => { renderer.launch() }).toThrow('puppeteer-core.launch is not available')
  expect(createNodeBuiltins()['puppeteer-core']?.()).toMatchObject({ default: renderer })
  expect(send).not.toHaveBeenCalled()
})
