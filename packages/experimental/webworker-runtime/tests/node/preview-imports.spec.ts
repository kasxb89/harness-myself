/** Data-only package setup must not start the native or provider actions the Worker cannot support. */
import { StringDecoder as NodeStringDecoder } from 'node:string_decoder'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agent as HttpAgent } from '../../src/node/builtin_modules/implemented/http.ts'
import { Agent as HttpsAgent } from '../../src/node/builtin_modules/mock/https.ts'
import { StringDecoder } from '../../src/node/builtin_modules/implemented/string_decoder.ts'
import { installProcessGlobal } from '../../src/node/globals/process.ts'
import * as piAi from '../../src/node/external_packages/pi-ai.ts'
import { toBuffer, toDataURL } from '../../src/node/external_packages/qrcode.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('loads transport subclasses while refusing a native agent construction', () => {
  class ProxyAgent extends HttpAgent {}
  class SecureProxyAgent extends HttpsAgent {}
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(() => new ProxyAgent()).toThrow('node:http.Agent is not available')
  expect(() => new SecureProxyAgent()).toThrow('node:https.Agent is not available')
})

it('publishes the Node global alias before package evaluation', () => {
  vi.stubGlobal('global', undefined)
  vi.stubGlobal('process', globalThis.process)
  installProcessGlobal({ cwd: '/dsh', env: {} })
  expect(globalThis.global).toBe(globalThis)
})

it.each(['utf8', 'utf16le', 'base64'] as const)('decodes split %s input like Node', (encoding) => {
  const input = new TextEncoder().encode('中文😀abc')
  for (let split = 0; split <= input.length; split++) {
    const actual = new StringDecoder(encoding)
    const expected = new NodeStringDecoder(encoding)
    expect([actual.write(input.subarray(0, split)), actual.end(input.subarray(split))])
      .toEqual([expected.write(input.subarray(0, split)), expected.end(input.subarray(split))])
  }
})

describe('pi-ai metadata setup', () => {
  it('retains configured route identity and complete model metadata without transport', () => {
    const model = { id: 'exact-model', provider: 'yunshu-local', name: 'Configured name',
      reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 4096 }
    const provider = { id: 'yunshu-local', getModels: () => [model] }
    const models = piAi.builtinModels()
    models.clearProviders()
    models.setProvider(provider)
    expect(models.getProviders()).toEqual([provider])
    expect(models.getProvider('yunshu-local')).toBe(provider)
    expect(models.getModels('yunshu-local')).toEqual([model])
    expect(models.getModel('yunshu-local', 'exact-model')).toBe(model)
    expect(models.getModel('another-route', 'exact-model')).toBeUndefined()
    expect(models.getModel('yunshu-local', 'unconfigured-model')).toBeUndefined()
    models.deleteProvider('yunshu-local')
    expect(models.getModels()).toEqual([])
    models.setProvider(provider)
    models.clearProviders()
    expect(models.getModels()).toEqual([])
  })

  it('constructs protocol metadata but refuses every stream and collection request', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const transports = [piAi.openAICompletionsApi(), piAi.openAIResponsesApi(), piAi.anthropicMessagesApi()]
    const models = piAi.builtinModels()
    expect(errors).not.toHaveBeenCalled()
    for (const transport of transports) {
      expect(() => transport.stream()).toThrow('Provider.stream is not available')
      expect(() => transport.streamSimple()).toThrow('Provider.streamSimple is not available')
    }
    expect(() => models.stream()).toThrow('Models.stream is not available')
    expect(() => models.streamSimple()).toThrow('Models.streamSimple is not available')
    expect(() => models.generateImages()).toThrow('Models.generateImages is not available')
  })
})

it('renders a real QR matrix as an SVG URI with the requested image size and margin', async () => {
  const input = 'weixin://wxpay/bizpayurl?pr=preview-fixture'
  const uri = await toDataURL(input, { margin: 1, width: 320 })
  expect(uri).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/u)
  const svg = decodeURIComponent(uri.slice(uri.indexOf(',') + 1))
  expect(svg).toContain('width="320" height="320"')
  expect(svg).toMatch(/<path stroke="#000000" d="M[\d. ]+h/u)
  expect(svg).not.toContain(input)
  expect(await toDataURL(input + '-changed', { margin: 1, width: 320 })).not.toBe(uri)
  expect(await toDataURL(input, { margin: 4, width: 320 })).not.toBe(uri)
})

it('encodes hostile QR text as matrix data and rejects empty content', async () => {
  const uri = await toDataURL('<svg onload="alert(1)"><script>boom</script>', { width: 320 })
  const svg = decodeURIComponent(uri.slice(uri.indexOf(',') + 1))
  expect(svg).not.toContain('onload')
  expect(svg).not.toContain('<script>')
  expect(svg.match(/<svg/gu)).toHaveLength(1)
  await expect(toDataURL('')).rejects.toThrow('No input text')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(() => toBuffer()).toThrow('qrcode.toBuffer is not available')
})
