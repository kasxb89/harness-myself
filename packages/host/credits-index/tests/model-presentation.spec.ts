import { describe, expect, it } from 'vitest'
import { orderProductModels, preferredProductModel, productModelDisplaySignature } from '../src/model-presentation.ts'

describe('authorized model presentation', () => {
  it('ranks configured models and appends new authorized models in their original order', () => {
    const models = ['new-a', 'chat-a', 'new-b', 'chat-b']
    const policy = { defaultChatModel: null, modelOrder: ['chat-b', 'unknown', 'chat-a'] }
    expect(orderProductModels(models, policy)).toEqual(['chat-b', 'chat-a', 'new-a', 'new-b'])
    expect(models).toEqual(['new-a', 'chat-a', 'new-b', 'chat-b'])
  })

  it('retains the source order when the administrator supplies no ranking', () => {
    expect(orderProductModels(['b', 'a'], { defaultChatModel: null, modelOrder: [] })).toEqual(['b', 'a'])
  })

  it('does not add an unavailable model from the ranking or default', () => {
    const policy = { defaultChatModel: 'private', modelOrder: ['private', 'chat'] }
    expect(orderProductModels(['chat'], policy)).toEqual(['chat'])
    expect(preferredProductModel(['chat'], policy)).toBe('chat')
  })

  it('uses an authorized default independently of its list position', () => {
    expect(preferredProductModel(['a', 'b'], { defaultChatModel: 'b', modelOrder: ['a'] })).toBe('b')
  })

  it('keeps media rankings out of the chat default candidates', () => {
    expect(preferredProductModel(['chat-a', 'chat-b'], {
      defaultChatModel: 'image', modelOrder: ['image', 'video', 'chat-b'],
    })).toBe('chat-b')
  })

  it.each([null, 'unavailable'])('falls back to the first ranked chat for default %s', (defaultChatModel) => {
    expect(preferredProductModel(['a', 'b'], { defaultChatModel, modelOrder: ['b'] })).toBe('b')
  })

  it('does not invent a default when the account has no chat access', () => {
    expect(preferredProductModel([], { defaultChatModel: 'private', modelOrder: ['private'] })).toBeUndefined()
  })

  it('compares only authorized exact-model display values and distinguishes clearing from inheritance', () => {
    const original = productModelDisplaySignature(['a'], { a: { description: 'text', badge: '' }, private: { badge: 'x' } })
    expect(productModelDisplaySignature(['a'], { private: { badge: 'y' }, a: { badge: '', description: 'text' } })).toBe(original)
    expect(productModelDisplaySignature(['a'], { a: { description: 'text' } })).not.toBe(original)
    expect(productModelDisplaySignature(['a'], { a: {} })).toBe(productModelDisplaySignature(['a'], undefined))
    const own = Object.fromEntries([['__proto__', { badge: 'own' }]])
    expect(productModelDisplaySignature(['__proto__'], own)).toContain('own')
    expect(productModelDisplaySignature(['constructor'], {})).toBe('[["constructor",null,null]]')
  })
})
