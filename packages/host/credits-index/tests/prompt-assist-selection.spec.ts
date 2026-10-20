import { describe, expect, it, vi } from 'vitest'
import type { ModelCatalog, ModelSelection, SessionProjectionsValue } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { isPromptAssistSelectionCurrent, resolvePromptAssistSelection, type PromptAssistSelectionOptions } from '../src/prompt-assist-selection.ts'

const selected: ModelSelection = { provider: 'product', model: 'deepseek-flash' }
const sessionId = 'session-one' as SessionId

function projection(next: ModelSelection | null): SessionProjectionsValue {
  const value = next === null ? null : {
    provider: next.provider, model: next.model,
    ...next.reasoningEffort === undefined ? {} : { reasoningEffort: next.reasoningEffort },
  }
  return { kind: 'sequenced', asOfSeq: 0, values: { modelSelection: { lastUsed: value, next: value } } }
}

function options(patch: Partial<PromptAssistSelectionOptions> = {}): PromptAssistSelectionOptions {
  const catalog: ModelCatalog = {
    default: selected, routableProviders: ['product'], failures: [],
    groups: [{ id: 'product', name: 'Product', models: [{ id: selected.model, name: 'Flash' }, { id: 'other', name: 'Other' }] }],
  }
  return {
    sessionId: null, expectedSelection: null, hasReferences: false, provider: 'product', signal: new AbortController().signal,
    readCatalog: vi.fn().mockResolvedValue(catalog), readProjections: vi.fn().mockResolvedValue(projection(null)),
    readModelInfo: vi.fn().mockResolvedValue({ inputModalities: ['text', 'image'] }), ...patch,
  }
}

describe('prompt writing follows the chat selection', () => {
  it('uses the live composer default for a workspace without a session', async () => {
    const input = options()
    expect(await resolvePromptAssistSelection(input)).toEqual({ ok: true, selection: selected })
    expect(input.readProjections).not.toHaveBeenCalled()
    expect(input.readModelInfo).toHaveBeenCalledExactlyOnceWith('product', 'deepseek-flash', input.signal)
  })

  it('keeps the existing conversation selection instead of replacing it with the current default', async () => {
    const current = { ...selected, model: 'other', reasoningEffort: 'medium' }
    const input = options({ sessionId, expectedSelection: current, readProjections: vi.fn().mockResolvedValue(projection(current)) })
    expect(await resolvePromptAssistSelection(input)).toEqual({ ok: true, selection: current })
    expect(input.readProjections).toHaveBeenCalledExactlyOnceWith(sessionId, input.signal)
  })

  it.each([null, { kind: 'migration-required', values: {} }, { kind: 'sequenced', asOfSeq: 0, values: {} }] as const)('refuses absent or unready conversation projections: %j', async (value) => {
    expect(await resolvePromptAssistSelection(options({ sessionId, readProjections: vi.fn().mockResolvedValue(value) })))
      .toMatchObject({ ok: false, code: 'PROMPT_ASSIST_MODEL_UNAVAILABLE' })
  })

  it.each([{ ...selected, model: 'missing' }, { ...selected, provider: 'another-provider' }])('refuses unavailable provider/model identities: %j', async (current) => {
    const input = options({ sessionId, expectedSelection: current, readProjections: vi.fn().mockResolvedValue(projection(current)) })
    expect(await resolvePromptAssistSelection(input)).toMatchObject({ ok: false, code: 'PROMPT_ASSIST_MODEL_UNAVAILABLE' })
    expect(input.readModelInfo).not.toHaveBeenCalled()
  })

  it('rejects a different provider even when its catalog advertises the same model name', async () => {
    const current = { ...selected, provider: 'another-provider' }
    expect(await resolvePromptAssistSelection(options({
      sessionId, expectedSelection: current, readProjections: vi.fn().mockResolvedValue(projection(current)),
      readCatalog: vi.fn().mockResolvedValue({ default: current, groups: [{ id: current.provider, models: [{ id: current.model }] }] }),
    }))).toMatchObject({ ok: false, code: 'PROMPT_ASSIST_MODEL_UNAVAILABLE' })
  })

  it.each([undefined, ['text']])('requires explicit image capability with reference images: %j', async (inputModalities) => {
    expect(await resolvePromptAssistSelection(options({
      hasReferences: true, readModelInfo: vi.fn().mockResolvedValue({ inputModalities }),
    })))
      .toMatchObject({ ok: false, code: 'PROMPT_ASSIST_VISION_REQUIRED' })
  })

  it('keeps the same selected multimodal model when references are attached', async () => {
    expect(await resolvePromptAssistSelection(options({ hasReferences: true }))).toEqual({ ok: true, selection: selected })
  })

  it('rejects known video generators even when the gateway advertises them as OpenAI chat', async () => {
    const current = { provider: 'product', model: 'MiniMax-H3' }
    const input = options({ sessionId, expectedSelection: current,
      readProjections: vi.fn().mockResolvedValue(projection(current)),
      readCatalog: vi.fn().mockResolvedValue({ default: current, groups: [{ id: current.provider, models: [{ id: current.model }] }] }),
    })
    expect(await resolvePromptAssistSelection(input)).toMatchObject({ ok: false, code: 'PROMPT_ASSIST_CHAT_REQUIRED' })
    expect(input.readModelInfo).not.toHaveBeenCalled()
  })

  it('rejects an obsolete browser selection rather than routing from it', async () => {
    expect(await resolvePromptAssistSelection(options({ sessionId, expectedSelection: { ...selected, model: 'other' },
      readProjections: vi.fn().mockResolvedValue(projection(selected)) })))
      .toMatchObject({ ok: false, code: 'PROMPT_ASSIST_SELECTION_CHANGED' })
  })

  it('rechecks local session and default identities without reloading a provider catalog', async () => {
    let current = selected
    const readDefaultSelection = vi.fn(() => current)
    const readProjections = vi.fn().mockResolvedValue(projection(null))
    const input = { sessionId, selection: selected, signal: new AbortController().signal, readProjections, readDefaultSelection }
    expect(await isPromptAssistSelectionCurrent(input)).toBe(true)
    current = { ...selected, model: 'other' }
    expect(await isPromptAssistSelectionCurrent(input)).toBe(false)
    readProjections.mockResolvedValue(projection(selected))
    expect(await isPromptAssistSelectionCurrent(input)).toBe(true)
    readProjections.mockResolvedValue(null)
    expect(await isPromptAssistSelectionCurrent(input)).toBe(false)
  })
})
