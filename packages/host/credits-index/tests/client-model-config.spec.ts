import { describe, expect, it } from 'vitest'
import { ClientModelConfigError, parseClientModelConfigStatus } from '../src/client-model-config.ts'

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
