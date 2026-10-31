import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore, ImageVariantId, type ImageAttachmentRef, type RequestImageAttachment, type ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createUserMessage, ReasoningEffortId, ToolCallId, type LlmTextCapabilities } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { Config, resolveProfiles, type PiAiProviderProfile } from '../src/config.ts'
import { MAX_CAPACITY_TOKENS, type PiAiModelProfile } from '../src/catalog.ts'
import { memoryAuth } from './auth-double.ts'
import { textEvents } from './mock-server.ts'

const provider = 'managed-gateway'
const scope = 'backend-account-a'
const base: PiAiProviderProfile = { api: 'openai-completions', baseURL: 'https://managed-limits.invalid/v1',
  compat: { maxTokensField: 'max_tokens' }, managedLimitsScope: scope }
const model = (id: string, contextWindow: number, maxTokens: number): PiAiModelProfile =>
  ({ id, managedLimits: { scope, contextWindow, maxTokens } })

function memoryRequests(api: 'chat/completions' | 'responses' = 'chat/completions'): Record<string, unknown>[] {
  const calls: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init)
    expect(request.url).toBe(`https://managed-limits.invalid/v1/${api}`)
    const body: unknown = await request.json()
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected SDK JSON request')
    calls.push(body as Record<string, unknown>)
    if (api === 'responses') return Response.json({ error: { message: 'Synthetic completed wire observation' } }, { status: 400 })
    return new Response(textEvents.map(event => `data: ${event}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }))
  return calls
}
function adapterFor(profile: PiAiProviderProfile): { adapter: PiAiAdapter; update: (profile: PiAiProviderProfile) => void } {
  let profiles = resolveProfiles({ [provider]: profile })
  return {
    adapter: new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'synthetic-key', auth: memoryAuth() }),
    update: (profile) => { profiles = resolveProfiles({ [provider]: profile }) },
  }
}
async function drain(adapter: PiAiAdapter, id: string, maxTokens?: number): Promise<void> {
  const chunks = []
  for await (const chunk of adapter.stream({ provider, model: id, messages: [], ...maxTokens === undefined ? {} : { maxTokens } })) {
    chunks.push(chunk)
  }
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
}
afterEach(() => { vi.unstubAllGlobals() })

describe('account-scoped managed capacities', () => {
  it('keeps absent managed declarations absent through the settings schema', () => {
    const options = Config({ providers: { [provider]: { ...base, models: [{ id: 'legacy' }] } } }).providers.get()
    expect(options[provider]?.models?.[0]?.managedLimits).toBeUndefined()
    expect(() => Config({ providers: { [provider]: { ...base, models: [{ id: 'broken', managedLimits: { scope, maxTokens: Infinity } }] } } }))
      .toThrow()
  })
  it('uses each model’s real context and output limits rather than the smaller unknown-model defaults', async () => {
    const calls = memoryRequests()
    const { adapter } = adapterFor({ ...base, models: [model('large', 1_048_576, 393_216), model('small', 32_768, 8192)] })
    expect(await adapter.resolveModel(provider, 'large')).toMatchObject({ context: { contextWindow: 1_048_576 }, maxOutputTokens: 393_216 })
    expect(await adapter.resolveModel(provider, 'large')).toHaveProperty('defaultMaxTokens', 393_216)
    expect(await adapter.resolveModel(provider, 'small')).toMatchObject({ context: { contextWindow: 32_768 }, defaultMaxTokens: 8192, maxOutputTokens: 8192 })
    await drain(adapter, 'large'); await drain(adapter, 'small')
    expect(calls.map(call => [call.model, call.max_tokens])).toEqual([['large', 393_216], ['small', 8192]])
    expect(JSON.stringify(calls)).not.toMatch(/managedLimits|backend-account-a/)
  })
  it('applies both increases and decreases to later requests while prepared calls retain their original snapshot', async () => {
    const calls = memoryRequests()
    const { adapter, update } = adapterFor({ ...base, models: [model('dynamic', 65_536, 8192)] })
    const prepared = await adapter.prepareCall(provider, 'dynamic')
    update({ ...base, models: [model('dynamic', 1_048_576, 393_216)] })
    await drain(adapter, 'dynamic')
    expect(await adapter.resolveModel(provider, 'dynamic')).toMatchObject({ context: { contextWindow: 1_048_576 }, maxOutputTokens: 393_216 })
    for await (const _chunk of prepared.stream({ provider, model: 'dynamic', messages: [] })) { /* Consume the frozen call. */ }
    update({ ...base, models: [model('dynamic', 32_768, 4096)] })
    await drain(adapter, 'dynamic', 500_000)
    expect(calls.map(call => call.max_tokens)).toEqual([393_216, 8192, 4096])
  })
  it('keeps smaller manual limits and clamps an explicitly larger request before the real SDK serializes it', async () => {
    const calls = memoryRequests()
    const { adapter } = adapterFor({ ...base, models: [{ ...model('manual', 1_048_576, 393_216), contextWindow: 65_536, maxTokens: 2048 }] })
    expect(await adapter.resolveModel(provider, 'manual')).toMatchObject({ context: { contextWindow: 65_536 }, defaultMaxTokens: 2048, maxOutputTokens: 2048 })
    await drain(adapter, 'manual', 90_000)
    await drain(adapter, 'manual', 512)
    expect(calls.map(call => call.max_tokens)).toEqual([2048, 512])
  })
  it('tightens a larger manual default and bounds a partially refreshed output by the effective context', async () => {
    const calls = memoryRequests()
    const { adapter } = adapterFor({ ...base, models: [{ ...model('refreshing', 8192, 393_216), maxTokens: 400_000 }] })
    expect(await adapter.resolveModel(provider, 'refreshing')).toMatchObject({ context: { contextWindow: 8192 }, defaultMaxTokens: 4096, maxOutputTokens: 4096 })
    await drain(adapter, 'refreshing', 1_000_000)
    expect(calls[0]?.max_tokens).toBe(4096)
  })
  it('does not transfer another account’s limits or turn the legacy fallback into a hard output ceiling', async () => {
    const calls = memoryRequests()
    const { adapter, update } = adapterFor({ ...base, managedLimitsScope: 'backend-account-b', models: [model('shared-id', 1_048_576, 393_216)] })
    const resolved = await adapter.resolveModel(provider, 'shared-id')
    expect(resolved).toMatchObject({ context: { contextWindow: 262_144 } })
    expect(resolved).not.toHaveProperty('maxOutputTokens')
    expect(resolved).not.toHaveProperty('defaultMaxTokens')
    await drain(adapter, 'shared-id', 65_536)
    update({ ...base, models: [model('shared-id', 1_048_576, 393_216)] })
    await drain(adapter, 'shared-id')
    expect(calls.map(call => call.max_tokens)).toEqual([65_536, 393_216])
  })
  it('keeps the output ceiling while the SDK further reduces wire tokens for nonempty history', async () => {
    const calls = memoryRequests()
    const { adapter } = adapterFor({ ...base, models: [model('near-context', 8192, 8192)] })
    const info = await adapter.resolveModel(provider, 'near-context')
    expect(info.maxOutputTokens).toBe(4096)
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: 'x'.repeat(8000) }], source: { kind: 'user' } }),
      createAssistantMessage({ content: [{ type: 'text', text: 'y'.repeat(2000) }], source: { provider, model: 'near-context' } }),
      createUserMessage({ content: [{ type: 'text', text: 'z'.repeat(2000) }], source: { kind: 'user' } }),
    ]
    for await (const _chunk of adapter.stream({ provider, model: 'near-context', messages, maxTokens: 1_000_000 })) {
      // Consume the real SDK stream; no provider-network call leaves the in-memory fetch.
    }
    expect(calls[0]?.max_tokens).toBe(1096)
    expect(calls[0]?.max_tokens).toBeLessThan(info.maxOutputTokens ?? 0)
  })
  it('rejects malformed request budgets before any SDK request is sent', async () => {
    const calls = memoryRequests()
    const { adapter } = adapterFor({ ...base, models: [model('bounded', 1_048_576, 393_216)] })
    for (const invalid of [0, -1, 0.5, NaN, Infinity, MAX_CAPACITY_TOKENS + 1]) {
      await expect(drain(adapter, 'bounded', invalid)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    expect(calls).toEqual([])
  })
  it('refuses out-of-range declared limits instead of converting them into usable caps', () => {
    for (const invalid of [0, -1, 0.5, NaN, Infinity, MAX_CAPACITY_TOKENS + 1]) {
      expect(() => resolveProfiles({ [provider]: { ...base, models: [{ id: 'invalid', managedLimits: { scope, maxTokens: invalid } }] } }))
        .toThrow(/managedLimits.maxTokens/)
    }
  })
  it('rejects managed Responses limits the real SDK would raise or omit, preserving unmanaged compatibility', async () => {
    const calls = memoryRequests('responses')
    const responses: PiAiProviderProfile = { api: 'openai-responses', baseURL: base.baseURL ?? '', managedLimitsScope: scope }
    const legacySmall = adapterFor({ ...responses, models: [{ id: 'small-response', contextWindow: 32_768, maxTokens: 8 }] }).adapter
    for await (const _chunk of legacySmall.stream({ provider, model: 'small-response', messages: [], maxTokens: 8 })) { /* Observe actual SDK JSON. */ }
    expect(calls[0]?.max_output_tokens).toBe(16)
    expect(() => adapterFor({ ...responses, models: [model('small-response', 32_768, 8)] })).toThrow(/Responses minimum/)
    const noOutput = { ...responses, compat: { supportsMaxOutputTokens: false } }
    const legacyOmitted = adapterFor({ ...noOutput, models: [{ id: 'omitted-response', contextWindow: 32_768, maxTokens: 2048 }] }).adapter
    for await (const _chunk of legacyOmitted.stream({ provider, model: 'omitted-response', messages: [] })) { /* Observe actual SDK JSON. */ }
    expect(calls[1]).not.toHaveProperty('max_output_tokens')
    expect(() => adapterFor({ ...noOutput, models: [model('omitted-response', 32_768, 2048)] })).toThrow(/max_output_tokens support/)
    expect(calls).toHaveLength(2)
  })
  it('keeps valid Responses budgets on the wire and rejects smaller explicit budgets before dispatch', async () => {
    const calls = memoryRequests('responses')
    const { adapter } = adapterFor({ api: 'openai-responses', baseURL: base.baseURL ?? '', managedLimitsScope: scope,
      models: [model('bounded-response', 32_768, 2048)] })
    await expect(drain(adapter, 'bounded-response', 8)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(calls).toEqual([])
    for await (const _chunk of adapter.stream({ provider, model: 'bounded-response', messages: [], maxTokens: 16 })) { /* Observe actual SDK JSON. */ }
    expect(calls[0]?.max_output_tokens).toBe(16)
  })
  it('rejects Responses history whose remaining room would make the SDK raise a budget above its available context', async () => {
    const calls = memoryRequests('responses')
    const { adapter } = adapterFor({ api: 'openai-responses', baseURL: base.baseURL ?? '', managedLimitsScope: scope,
      models: [model('full-response', 8192, 2048)] })
    const messages = [createUserMessage({ content: [{ type: 'text', text: 'x'.repeat(16_384) }], source: { kind: 'user' } })]
    await expect(async () => {
      for await (const _chunk of adapter.stream({ provider, model: 'full-response', messages })) { /* No SDK request is allowed. */ }
    }).rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
    expect(calls).toEqual([])
  })
  it('leaves native protocol profiles unchanged without managed limits and rejects unsupported managed combinations', () => {
    const anthropic: PiAiProviderProfile = { api: 'anthropic-messages', baseURL: 'https://managed-limits.invalid',
      models: [{ id: 'native-model', maxTokens: 2048 }] }
    expect(() => adapterFor(anthropic)).not.toThrow()
    expect(() => adapterFor({ ...anthropic, managedLimitsScope: scope, models: [model('native-model', 32_768, 2048)] }))
      .toThrow(/managed output limits are not supported/)
  })
  it('does not dispatch managed official Responses with credentials that cause the SDK to omit output limits', async () => {
    const calls = memoryRequests('responses')
    const profiles = resolveProfiles({ openai: { api: 'openai-responses', baseURL: 'https://api.openai.com/v1', managedLimitsScope: scope,
      models: [model('managed-openai', 32_768, 2048)] } })
    const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'synthetic-oauth-token', auth: memoryAuth() })
    await expect(async () => {
      for await (const _chunk of adapter.stream({ provider: 'openai', model: 'managed-openai', messages: [] })) { /* No request is allowed. */ }
    }).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect(calls).toEqual([])
  })
})


describe('account-bound gateway text execution', () => {
  const capabilities = { tools: false, vision: false, reasoning: false, stream: true, maxInputTokens: 32000 }
  const plain = { ...model('plain', 1000000, 8192), input: ['text', 'image'] as ('text' | 'image')[],
    reasoningEfforts: { off: null, high: 'high' }, managedLimits: { scope, contextWindow: 1000000, maxTokens: 8192, textCapabilities: capabilities } }
  it('publishes narrower gateway input while retaining scope-controlled removal and manual output', async () => {
    const { adapter, update } = adapterFor({ ...base, models: [plain] })
    expect(await adapter.resolveModel(provider, 'plain')).toMatchObject({ textCapabilities: capabilities,
      context: { contextWindow: 40192 }, inputModalities: ['text'], defaultMaxTokens: 8192 })
    expect(await adapter.resolveModel(provider, 'plain')).not.toHaveProperty('reasoning')
    expect((await adapter.listModels(provider))[0]?.textCapabilities).toEqual(capabilities)
    update({ ...base, models: [{ ...plain, maxTokens: 2048 }] })
    expect(await adapter.resolveModel(provider, 'plain')).toMatchObject({ context: { contextWindow: 34048 }, defaultMaxTokens: 2048 })
    update({ ...base, managedLimitsScope: 'other', models: [plain] })
    expect(await adapter.resolveModel(provider, 'plain')).not.toHaveProperty('textCapabilities')
    expect((await adapter.resolveModel(provider, 'plain')).inputModalities).toEqual(['text', 'image'])
    update({ ...base, models: [{ ...plain, managedLimits: { scope, contextWindow: 1000000, maxTokens: 8192 } }] })
    expect(await adapter.resolveModel(provider, 'plain')).toMatchObject({ context: { contextWindow: 1000000 }, inputModalities: ['text', 'image'] })
    expect(await adapter.resolveModel(provider, 'plain')).not.toHaveProperty('textCapabilities')
  })
  it('does not silently drop explicit tool declarations or historical tool results before the SDK', async () => {
    const calls = memoryRequests()
    const { adapter } = adapterFor({ ...base, models: [plain] })
    const tool = { name: 'lookup', description: 'fixture lookup', parameters: { type: 'object' as const, properties: {} } }
    await expect(async () => {
      for await (const _chunk of adapter.stream({ provider, model: 'plain', messages: [], tools: [tool] })) { /* No dispatch is permitted. */ }
    }).rejects.toMatchObject({ code: 'MODEL_CAPABILITY_TOOLS_UNSUPPORTED' })
    const history = [createAssistantMessage({ source: { provider, model: 'plain' },
      content: [{ type: 'tool-call', id: ToolCallId('call-plain'), name: 'lookup', arguments: '{}' }] })]
    await expect(async () => {
      for await (const _chunk of adapter.stream({ provider, model: 'plain', messages: history })) { /* Retain original history and fail before dispatch. */ }
    }).rejects.toMatchObject({ code: 'MODEL_CAPABILITY_HISTORY_UNSUPPORTED' })
    expect(calls).toEqual([])
  })
  it('suppresses a configured reasoning default, refuses explicit reasoning and does not discard reasoning history', async () => {
    const calls = memoryRequests()
    const { adapter } = adapterFor({ ...base, reasoning: 'high', models: [plain] })
    await drain(adapter, 'plain')
    expect(calls[0]).not.toHaveProperty('reasoning_effort')
    await expect(async () => {
      for await (const _chunk of adapter.stream({ provider, model: 'plain', messages: [], reasoningEffort: ReasoningEffortId('high') })) { /* No incompatible wire. */ }
    }).rejects.toMatchObject({ code: 'MODEL_CAPABILITY_REASONING_UNSUPPORTED' })
    const history = [createAssistantMessage({ source: { provider, model: 'plain' }, content: [{ type: 'reasoning', text: 'retained reasoning' }, { type: 'text', text: 'answer' }] })]
    for await (const _chunk of adapter.stream({ provider, model: 'plain', messages: history })) { /* Existing codec owns reasoning replay. */ }
    expect(calls).toHaveLength(2)
    expect(calls[1]).not.toHaveProperty('reasoning_effort')
    expect(JSON.stringify(calls[1])).toContain('retained reasoning')
  })
  it('rejects a non-streaming declaration and malformed persisted declarations', async () => {
    const calls = memoryRequests()
    const { adapter } = adapterFor({ ...base, models: [{ ...plain,
      managedLimits: { ...plain.managedLimits, textCapabilities: { ...capabilities, stream: false } } }] })
    await expect(drain(adapter, 'plain')).rejects.toMatchObject({ code: 'MODEL_CAPABILITY_STREAM_UNSUPPORTED' })
    expect(calls).toEqual([])
    expect(() => Schema.resolve({ providers: { [provider]: { ...base, models: [{ id: 'broken', managedLimits: { scope,
      textCapabilities: { tools: false } } }] } } }, Config, {})).toThrow()
  })
})


describe('text-only gateway attachment refusal', () => {
  it.each([{ tools: true, vision: false }, { tools: false, vision: true }])('never dispatches unprojected native files for %j', async (declared) => {
    const calls = memoryRequests()
    const { adapter } = adapterFor({ ...base, models: [{ ...model('native-file', 1000000, 8192),
      managedLimits: { scope, contextWindow: 1000000, maxTokens: 8192,
        textCapabilities: { ...declared, reasoning: false, stream: true, maxInputTokens: 32000 } } }] })
    await expect(async () => {
      for await (const _chunk of adapter.stream({ provider, model: 'native-file', messages: [createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'file', attachment: {
          attachmentId: AttachmentId('c'.repeat(64)), name: 'notes.txt', bytes: 1,
        } }],
      })] })) { /* Files must pass through the owning runtime's handle projection. */ }
    }).rejects.toMatchObject({ code: 'MODEL_CAPABILITY_INPUT_UNSUPPORTED' })
    expect(calls).toEqual([])
  })

  it('rejects image and file references before reading attachments or dispatching', async () => {
    const calls = memoryRequests()
    const { adapter } = adapterFor({ ...base, models: [{ ...model('plain-input', 1000000, 8192),
      managedLimits: { scope, contextWindow: 1000000, maxTokens: 8192,
        textCapabilities: { tools: false, vision: false, reasoning: false, stream: true, maxInputTokens: 32000 } } }] })
    const id = AttachmentId(`sha256:${'a'.repeat(64)}`)
    for (const block of [
      { type: 'image' as const, attachment: { attachmentId: id, mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 } },
      { type: 'file' as const, attachment: { attachmentId: id, name: 'fixture.txt', bytes: 1 } },
    ]) {
      await expect(async () => {
        for await (const _chunk of adapter.stream({ provider, model: 'plain-input', messages: [createUserMessage({
          source: { kind: 'user' }, content: [block],
        })] })) { /* No attachment reader or upstream call. */ }
      }).rejects.toMatchObject({ code: 'MODEL_CAPABILITY_INPUT_UNSUPPORTED' })
    }
    expect(calls).toEqual([])
  })
})


describe('version2 gateway capabilities through the actual SDK', () => {
  const capabilities: LlmTextCapabilities = { tools: true, vision: true, reasoning: true, stream: true, maxInputTokens: 32000,
    schemaVersion: 2, revision: 'v2-test', checkedAt: '2026-10-31T00:00:00Z',
    verification: { tools: 'supported', vision: 'supported', reasoning: 'supported' }, inputModalities: ['text', 'image'],
    toolsConfig: { protocol: 'openai-chat', roundtripVerified: true, verifiedToolChoices: ['auto'], parallelCalls: 'unverified' },
    visionConfig: { verifiedTransports: ['data_url'], verifiedMimeTypes: ['image/png'], billing: 'input_tokens' },
    reasoningMode: 'configurable', reasoningControls: { type: 'object', properties: { enable_thinking: { type: 'boolean', default: false } }, additionalProperties: false },
    reasoningOmitBehavior: 'provider_default', operationalStatus: 'available' }
  const profile = (value: LlmTextCapabilities): PiAiProviderProfile => ({ ...base, models: [{ ...model('v2-opaque', 1000000, 8192), maxTokens: 2048,
    managedLimits: { scope, contextWindow: 1000000, maxTokens: 8192, textCapabilities: value } }] })
  it('positively publishes image support and preserves complete nested metadata through Settings schema', async () => {
    const config = Config({ providers: { [provider]: profile(capabilities) } }).providers.get()
    expect(config[provider]?.models?.[0]?.managedLimits?.textCapabilities).toMatchObject(capabilities)
    const emptyMapping = { ...capabilities, reasoningControlMapping: {} }
    const emptyMappingConfig = Config({ providers: { [provider]: profile(emptyMapping) } }).providers.get()
    expect(emptyMappingConfig[provider]?.models?.[0]?.managedLimits?.textCapabilities).toEqual(emptyMapping)
    const { adapter } = adapterFor(profile(capabilities))
    const info = await adapter.resolveModel(provider, 'v2-opaque')
    expect(info).toMatchObject({ inputModalities: ['text', 'image'], defaultMaxTokens: 2048,
      textCapabilities: { verification: capabilities.verification, reasoningControls: capabilities.reasoningControls } })
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['on', 'off'])
    info.textCapabilities!.reasoningControls!.properties.enable_thinking!.default = true
    expect((await adapter.resolveModel(provider, 'v2-opaque')).textCapabilities?.reasoningControls?.properties.enable_thinking?.default).toBe(false)
  })
  it.each(['on', 'off', undefined])('sends boolean %s exactly, including false instead of omission', async (selected) => {
    const calls = memoryRequests(), { adapter } = adapterFor(profile(capabilities))
    for await (const _chunk of adapter.stream({ provider, model: 'v2-opaque', messages: [], maxTokens: 1024,
      ...selected === undefined ? {} : { reasoningEffort: ReasoningEffortId(selected) } })) { /* Capture actual serialized request. */ }
    expect(calls).toHaveLength(1)
    expect(calls[0]?.max_tokens).toBe(1024)
    expect(calls[0]).not.toHaveProperty('reasoning_effort')
    if (selected === undefined) expect(calls[0]).not.toHaveProperty('enable_thinking')
    else expect(calls[0]?.enable_thinking).toBe(selected === 'on')
  })
  it.each(['none', 'high', undefined])('sends exact declared string effort %s without relying on built-in model names', async (selected) => {
    const value: LlmTextCapabilities = { ...capabilities, reasoningControlMapping: { enableThinkingWithEffort: true, omitEffortOnNone: true }, reasoningControls: { type: 'object', properties: {
      reasoning_effort: { type: 'string', enum: ['none', 'high'] } }, additionalProperties: false } }
    const calls = memoryRequests(), { adapter } = adapterFor(profile(value))
    for await (const _chunk of adapter.stream({ provider, model: 'v2-opaque', messages: [],
      ...selected === undefined ? {} : { reasoningEffort: ReasoningEffortId(selected) } })) { /* Inspect wire. */ }
    expect(calls[0]?.reasoning_effort).toBe(selected)
    if (selected === undefined) expect(calls[0]).not.toHaveProperty('reasoning_effort')
    expect(calls[0]).not.toHaveProperty('enable_thinking')
    expect(calls[0]).not.toHaveProperty('reasoning_control_mapping')
  })
  it.each([
    { values: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { values: ['low', 'medium', 'high'] },
    { values: ['low', 'medium', 'high', 'xhigh'] },
  ])('offers and serializes the exact always-on effort schema $values without a default or off', async ({ values }) => {
    const value: LlmTextCapabilities = { ...capabilities, reasoningMode: 'always_on',
      verification: { ...capabilities.verification!, reasoning: values.length === 3 ? 'unverified' : 'supported' },
      reasoningControls: { type: 'object', properties: { reasoning_effort: { type: 'string', enum: values, default: 'high' } },
        additionalProperties: false } }
    const calls = memoryRequests(), { adapter } = adapterFor(profile(value))
    const info = await adapter.resolveModel(provider, 'v2-opaque')
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(values)
    expect(info.reasoning).not.toHaveProperty('defaultEffort')
    for (const selected of [...values, undefined]) {
      for await (const _chunk of adapter.stream({ provider, model: 'v2-opaque', messages: [], maxTokens: 1024,
        ...selected === undefined ? {} : { reasoningEffort: ReasoningEffortId(selected) } })) { /* Inspect actual SDK wire. */ }
      const body = calls.at(-1)
      expect(body?.max_tokens).toBe(1024)
      expect(body).not.toHaveProperty('enable_thinking')
      if (selected === undefined) expect(body).not.toHaveProperty('reasoning_effort')
      else expect(body?.reasoning_effort).toBe(selected)
    }
    expect(calls).toHaveLength(values.length + 1)
  })
  it('keeps always-on off/none unavailable and retains captured controls independently of later schemas', async () => {
    const value: LlmTextCapabilities = { ...capabilities, reasoningMode: 'always_on',
      reasoningControls: { type: 'object', properties: { reasoning_effort: { type: 'string', enum: ['none', 'off', 'low', 'high'] } },
        additionalProperties: false } }
    const calls = memoryRequests(), { adapter, update } = adapterFor(profile(value))
    expect((await adapter.resolveModel(provider, 'v2-opaque')).reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'high'])
    for (const selected of ['none', 'off']) await expect((async () => {
      for await (const _chunk of adapter.stream({ provider, model: 'v2-opaque', messages: [],
        reasoningEffort: ReasoningEffortId(selected) })) { /* Must reject without I/O. */ }
    })()).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    expect(calls).toHaveLength(0)
    const prepared = await adapter.prepareCall(provider, 'v2-opaque')
    prepared.model.textCapabilities!.reasoningControls!.properties.reasoning_effort!.enum.push('invented')
    await expect((async () => {
      for await (const _chunk of prepared.stream({ provider, model: 'v2-opaque', messages: [],
        reasoningEffort: ReasoningEffortId('invented') })) { /* Public metadata must not change the captured declaration. */ }
    })()).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    expect(calls).toHaveLength(0)
    update(profile({ ...value, reasoningControls: { type: 'object', properties: {}, additionalProperties: false } }))
    for await (const _chunk of prepared.stream({ provider, model: 'v2-opaque', messages: [], reasoningEffort: ReasoningEffortId('high') })) { /* Frozen route. */ }
    expect(calls[0]?.reasoning_effort).toBe('high')
    expect((await adapter.resolveModel(provider, 'v2-opaque')).reasoning).toBeUndefined()
    await drain(adapter, 'v2-opaque')
    expect(calls[1]).not.toHaveProperty('reasoning_effort')
    expect(calls[1]).not.toHaveProperty('enable_thinking')
  })
  it('keeps a localized image outage visible and rejects image bytes before SDK projection without disabling text or tools', async () => {
    const value: LlmTextCapabilities = { ...capabilities, vision: false, inputModalities: ['text'],
      verification: { ...capabilities.verification!, vision: 'unverified' }, visionConfig: { ...capabilities.visionConfig!,
        operationalStatus: 'temporarily_unavailable', operationalReason: 'Temporary image outage.' } }
    const config = Config({ providers: { [provider]: profile(value) } }).providers.get()
    expect(config[provider]?.models?.[0]?.managedLimits?.textCapabilities).toEqual(value)
    const calls = memoryRequests(), { adapter } = adapterFor(profile(value))
    const metadata = await adapter.resolveModel(provider, 'v2-opaque')
    expect(metadata.inputModalities).toEqual(['text'])
    expect(metadata.textCapabilities?.verification?.vision).toBe('unverified')
    const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: {
      attachmentId: AttachmentId('f'.repeat(64)), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }] })
    await expect((async () => {
      for await (const _chunk of adapter.stream({ provider, model: 'v2-opaque', messages: [original] })) { /* Must reject first. */ }
    })()).rejects.toMatchObject({ code: 'MODEL_CAPABILITY_INPUT_UNAVAILABLE' })
    expect(original.content[0]?.type).toBe('image')
    expect(calls).toHaveLength(0)
    await drain(adapter, 'v2-opaque')
    expect(calls).toHaveLength(1)
    expect(metadata.textCapabilities?.tools).toBe(true)
  })
  it('passes actual PNG bytes through the attachment reader and SDK for a custom image-capable public id', async () => {
    const calls = memoryRequests()
    const data = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQZkAAAAASUVORK5CYII=', 'base64'))
    const ref: ImageAttachmentRef = { attachmentId: AttachmentId('d'.repeat(64)), mediaType: 'image/png', bytes: data.byteLength, width: 1, height: 1 }
    let reads = 0
    class FixtureImages extends AttachmentStore {
      readonly imageLimits = { maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024,
        maxImagePixels: 1, maxImageDimension: 1, mediaTypes: ['image/png' as const] }
      async validateImage() { throw new Error('read-only fixture') }
      async saveImage(): Promise<ImageAttachmentRef> { throw new Error('read-only fixture') }
      async readImage() { return { ref, data } }
      override async readImageRequest(_ref: ImageAttachmentRef, _target: ImageRequestTarget): Promise<RequestImageAttachment> {
        reads += 1
        return { variantId: ImageVariantId('e'.repeat(64)), attachment: ref, data, mediaType: 'image/png', bytes: data.byteLength,
          width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: true }
      }
    }
    const ctx = new Context()
    try {
      await ctx.plugin(FixtureImages)
      const profiles = resolveProfiles({ [provider]: profile(capabilities) })
      const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'synthetic-key',
        auth: memoryAuth(), resolveAttachments: () => ctx.attachments })
      for await (const _chunk of adapter.stream({ provider, model: 'v2-opaque', messages: [createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the attached pixel.' }, { type: 'image', attachment: ref }],
      })] })) { /* Real attachment -> Pi context -> SDK HTTP serialization. */ }
      expect(reads).toBe(1)
      expect(calls).toHaveLength(1)
      expect(JSON.stringify(calls[0]?.messages)).toContain('data:image/png;base64,' + Buffer.from(data).toString('base64'))
      expect(JSON.stringify(calls[0]?.messages)).not.toContain('[image omitted')
    } finally { await ctx.fiber.dispose() }
  })

  it('does not offer false off/high controls for automatic reasoning and refuses explicit unavailable routes', async () => {
    const calls = memoryRequests(), { adapter, update } = adapterFor(profile({ ...capabilities, reasoningMode: 'always_on' }))
    expect((await adapter.resolveModel(provider, 'v2-opaque')).reasoning).toBeUndefined()
    await drain(adapter, 'v2-opaque')
    expect(calls[0]).not.toHaveProperty('reasoning_effort')
    expect(calls[0]).not.toHaveProperty('enable_thinking')
    update(profile({ ...capabilities, operationalStatus: 'fixed_lane_unavailable', operationalReason: 'Temporary test route outage' }))
    await expect(drain(adapter, 'v2-opaque')).rejects.toMatchObject({ code: 'MODEL_ROUTE_UNAVAILABLE' })
    expect(calls).toHaveLength(1)
  })
})
