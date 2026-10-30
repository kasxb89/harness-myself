import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as PiAi from '../src/index.ts'
import type { HarnessAccount } from '../src/harness-account.ts'
import { textEvents } from './mock-server.ts'

const baseURL = 'https://product-scope.invalid/v1'
const provider = 'yunshu-local'
const modelId = 'scope-model'
const profile: PiAi.PiAiProviderProfile = { api: 'openai-completions', baseURL, managedLimitsScope: 'account-a',
  compat: { maxTokensField: 'max_tokens' }, models: [{ id: modelId,
    managedLimits: { scope: 'account-a', contextWindow: 1_048_576, maxTokens: 393_216 } }] }

async function product(
  configured: PiAi.PiAiProviderProfile, resolveRelayKey: HarnessAccount['resolveRelayKey'],
): Promise<Context> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  ctx.provide('harnessAccount', { provider, resolveRelayKey, refreshModels: async () => [modelId] })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(PiAi, { providers: { [provider]: configured } })
  return ctx
}
afterEach(() => { vi.unstubAllGlobals() })

describe('prepared product model account ownership', () => {
  it('passes the prepared scope to the live account and sends no request after switching accounts', async () => {
    let currentScope = 'account-a'
    const relay = vi.fn<HarnessAccount['resolveRelayKey']>(async (_base, expected) =>
      expected === undefined || expected === currentScope ? 'sk-synthetic-current' : undefined)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('No provider request is authorized') })
    vi.stubGlobal('fetch', fetch)
    const ctx = await product(profile, relay)
    const prepared = await ctx.llm.prepareCall({ provider, model: modelId })
    expect(prepared.config.maxTokens).toBe(393_216)
    currentScope = 'account-b'
    const chunks = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } })
    expect(relay).toHaveBeenCalledWith(baseURL, 'account-a')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('keeps a prepared request valid when only the same account’s relay credential renews', async () => {
    let key = 'sk-synthetic-original'
    const relay = vi.fn<HarnessAccount['resolveRelayKey']>(async (_base, expected) => expected === 'account-a' ? key : undefined)
    const calls: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init)
      expect(request.headers.get('authorization')).toBe('Bearer sk-synthetic-renewed')
      const body: unknown = await request.json()
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected SDK JSON')
      calls.push(body as Record<string, unknown>)
      return new Response(textEvents.map(event => `data: ${event}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }))
    const ctx = await product(profile, relay)
    const prepared = await ctx.llm.prepareCall({ provider, model: modelId })
    key = 'sk-synthetic-renewed'
    const chunks = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(calls).toMatchObject([{ model: modelId, max_tokens: 393_216 }])
    expect(relay).toHaveBeenCalledWith(baseURL, 'account-a')
  })
  it('uses current-account authorization for fresh discovery without requiring a previous scope', async () => {
    const relay = vi.fn<HarnessAccount['resolveRelayKey']>(async (_base, expected) => expected === undefined ? 'sk-synthetic-new-account' : undefined)
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init)
      expect(request.url).toBe(`${baseURL}/models`)
      expect(request.headers.get('authorization')).toBe('Bearer sk-synthetic-new-account')
      return Response.json({ data: [{ id: modelId }] })
    }))
    const ctx = await product(profile, relay)
    expect(await ctx.llm.discoverModels('llm-pi-ai', { provider, baseURL, api: 'openai-completions' })).toMatchObject([{ id: modelId }])
    expect(relay).toHaveBeenCalledWith(baseURL)
    expect(relay).not.toHaveBeenCalledWith(baseURL, 'account-a')
  })
})
