import { describe, expect, it } from 'vitest'
import { ClientModelConfigError, parseClientModelConfigStatus, parseClientModelPresentationStatus } from '../src/client-model-config.ts'

const config = () => ({ schema_version: 1, default_chat_model: '', model_order: [] as string[] })
const status = (value: unknown) => ({ success: true, data: { quota_per_unit: 500000, client_model_config: value } })

describe('public client model configuration', () => {
  it('accepts an older backend without model preferences', () => {
    expect(parseClientModelConfigStatus({ success: true, data: { unrelated: true } })).toBeUndefined()
  })

  it('decodes the empty v1 configuration and preserves exact model ids', () => {
    expect(parseClientModelConfigStatus(status(config()))).toEqual({ defaultChatModel: null, modelOrder: [] })
    expect(parseClientModelConfigStatus(status({ ...config(), default_chat_model: '云枢/chat-1', model_order: ['Other ID'] })))
      .toEqual({ defaultChatModel: '云枢/chat-1', modelOrder: ['Other ID'] })
  })

  it('does not retain a mutable remote array', () => {
    const source = { ...config(), model_order: ['a'] }
    const decoded = parseClientModelConfigStatus(status(source))
    source.model_order.push('b')
    expect(decoded?.modelOrder).toEqual(['a'])
  })

  it.each([null, [], {}, { success: false, data: {} }, { success: true, data: null }])('rejects an invalid status envelope %#', (body) => {
    expect(() => parseClientModelConfigStatus(body)).toThrow(ClientModelConfigError)
  })

  it.each([null, [], {}, { ...config(), schema_version: 2 }, { ...config(), extra: true },
    { ...config(), default_chat_model: null }, { ...config(), model_order: null },
    { ...config(), model_order: ['a', 'a'] }, { ...config(), model_order: [''] },
    { ...config(), model_order: [' padded'] }, { ...config(), model_order: ['a\nb'] },
  ])('rejects a malformed present configuration %#', (value) => {
    expect(() => parseClientModelConfigStatus(status(value))).toThrow(ClientModelConfigError)
  })

  it('enforces UTF-8 bytes rather than JavaScript character counts', () => {
    const exact = '模'.repeat(85)
    expect(parseClientModelConfigStatus(status({ ...config(), default_chat_model: exact }))?.defaultChatModel).toBe(exact)
    expect(() => parseClientModelConfigStatus(status({ ...config(), default_chat_model: exact + 'x' }))).toThrow(ClientModelConfigError)
    expect(() => parseClientModelConfigStatus(status({ ...config(), model_order: ['é'.repeat(128)] }))).toThrow(ClientModelConfigError)
  })

  it('accepts 256 distinct entries and refuses a larger complete ranking', () => {
    const ids = Array.from({ length: 256 }, (_, index) => `model-${String(index)}`)
    expect(parseClientModelConfigStatus(status({ ...config(), model_order: ids }))?.modelOrder).toHaveLength(256)
    expect(() => parseClientModelConfigStatus(status({ ...config(), model_order: [...ids, 'overflow'] }))).toThrow(ClientModelConfigError)
  })
})

describe('public client model display text', () => {
  const body = (models: unknown) => ({ success: true, data: {
    client_model_config: config(), client_model_presentation: { schema_version: 1, models },
  } })

  it('preserves the old exact-three-field preferences and independent display fallback or clearing', () => {
    expect(parseClientModelPresentationStatus(status(config()))).toBeUndefined()
    expect(parseClientModelPresentationStatus(body({}))).toEqual({})
    const response = body({ a: { description: '', badge: '<b>Fast</b>' }, b: { description: '  exact text  ' }, c: {} })
    expect(parseClientModelConfigStatus(response)).toEqual({ defaultChatModel: null, modelOrder: [] })
    expect(parseClientModelPresentationStatus(response)).toEqual({
      a: { description: '', badge: '<b>Fast</b>' }, b: { description: '  exact text  ' }, c: {},
    })
  })

  it('detaches entries and treats prototype-looking ids as exact own keys', () => {
    const models = JSON.parse('{"__proto__":{"badge":"own"},"constructor":{"description":"literal"}}') as Record<string, { badge?: string; description?: string }>
    const result = parseClientModelPresentationStatus(body(models))!
    models.__proto__!.badge = 'mutated'
    expect(Object.hasOwn(result, '__proto__')).toBe(true)
    expect(result.__proto__).toEqual({ badge: 'own' })
    expect(result.constructor).toEqual({ description: 'literal' })
    expect(Object.hasOwn(result, 'toString')).toBe(false)
  })

  it('rejects all five badge line breaks while preserving multiline description text', () => {
    for (const lineBreak of ['\n', '\r', '\u0085', '\u2028', '\u2029']) {
      const text = 'before' + lineBreak + 'after'
      expect(() => parseClientModelPresentationStatus(body({ chat: { badge: text } }))).toThrow(ClientModelConfigError)
      expect(parseClientModelPresentationStatus(body({ chat: { badge: 'Single line', description: text } }))?.chat)
        .toEqual({ badge: 'Single line', description: text })
    }
  })

  it('matches backend Unicode White_Space edges while preserving FEFF model ids as exact own keys', () => {
    const ids = ['\uFEFFchat', 'chat\uFEFF', 'chat\u2003inside']
    const decoded = parseClientModelPresentationStatus(body(Object.fromEntries(ids.map(id => [id, { badge: id }]))))!
    expect(Object.keys(decoded)).toEqual(ids)
    for (const id of ids) {
      expect(Object.hasOwn(decoded, id)).toBe(true)
      expect(decoded[id]).toEqual({ badge: id })
    }
    for (const id of ids.slice(0, 2)) {
      expect(() => parseClientModelConfigStatus(status({ ...config(), default_chat_model: id }))).toThrow(ClientModelConfigError)
    }
    const exact = '\uFEFF' + 'a'.repeat(252)
    expect(Object.hasOwn(parseClientModelPresentationStatus(body({ [exact]: {} }))!, exact)).toBe(true)
    expect(() => parseClientModelPresentationStatus(body({ [exact + 'a']: {} }))).toThrow(ClientModelConfigError)
  })

  it('rejects every backend White_Space edge and embedded control characters in display ids', () => {
    const whiteSpace = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680,
      0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
      0x2028, 0x2029, 0x202f, 0x205f, 0x3000]
    for (const point of whiteSpace) {
      const character = String.fromCodePoint(point)
      for (const id of [character + 'chat', 'chat' + character]) {
        expect(() => parseClientModelPresentationStatus(body({ [id]: {} }))).toThrow(ClientModelConfigError)
      }
    }
    for (const point of [0, 0x1f, 0x7f, 0x85, 0x9f]) {
      const id = 'chat' + String.fromCodePoint(point) + 'inside'
      expect(() => parseClientModelPresentationStatus(body({ [id]: {} }))).toThrow(ClientModelConfigError)
    }
  })

  it('uses UTF16 text limits, UTF8 exact id limits and the complete 256-model bound', () => {
    const id = '模'.repeat(85)
    expect(parseClientModelPresentationStatus(body({ [id]: { description: '🙂'.repeat(250), badge: '标'.repeat(32) } }))?.[id])
      .toEqual({ description: '🙂'.repeat(250), badge: '标'.repeat(32) })
    const entries = Array.from({ length: 256 }, (_, index) => [`m${String(index)}`, {}])
    expect(Object.keys(parseClientModelPresentationStatus(body(Object.fromEntries(entries)))!)).toHaveLength(256)
    expect(() => parseClientModelPresentationStatus(body(Object.fromEntries([...entries, ['overflow', {}]]))))
      .toThrow(ClientModelConfigError)
  })

  it.each([null, [], { a: null }, { a: { badge: null } }, { a: { description: 1 } },
    { a: { badge: '🙂'.repeat(17) } }, { a: { description: '🙂'.repeat(251) } },
    { a: { extra: '' } }, { ' padded': {} }, { 'a\nb': {} }, { ['模'.repeat(86)]: {} },
  ])('rejects a malformed complete display map %#', (models) => {
    expect(() => parseClientModelPresentationStatus(body(models))).toThrow(ClientModelConfigError)
  })

  it.each([null, {}, { schema_version: 2, models: {} }, { schema_version: 1, models: {}, extra: true }])
  ('rejects malformed display documents independently of preferences %#', (value) => {
    const response = { ...status(config()), data: { ...status(config()).data, client_model_presentation: value } }
    expect(() => parseClientModelPresentationStatus(response)).toThrow(ClientModelConfigError)
    expect(parseClientModelConfigStatus(response)).toEqual({ defaultChatModel: null, modelOrder: [] })
  })
})
