import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type LlmModelLimits, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { buildModelCatalog } from '../src/catalog.ts'

describe('model catalog capacity projection', () => {
  it('publishes detached effective/platform/raw capacities and only the active managed settings owner without changing selection', async () => {
    const limits: LlmModelLimits = {
      contextWindow: 32768, maxOutputTokens: 4096,
      platform: { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
      override: { contextWindow: 32768, maxOutputTokens: 4096 }, managedScope: 'fixture-account',
    }
    class CapacityAdapter extends LlmAdapter {
      override async listModels(provider: string) {
        return [{ provider, id: 'managed', name: 'Managed' }, { provider, id: 'unmanaged', name: 'Unmanaged' }]
      }
      override async resolveModel(provider: string, id: string) {
        return { provider, id, name: id, context: { contextWindow: 32768 }, maxOutputTokens: 4096,
          limits: id === 'managed' ? limits : { contextWindow: 32768, maxOutputTokens: 4096, platform: {} } }
      }
      override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { throw new Error('Catalog must not generate') }
    }
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['fixture'], new CapacityAdapter())
      const path = ['providers', 'fixture']
      ctx.llm.registerConfigurableProviders([{ provider: 'fixture', displayName: 'Fixture', settingsNs: 'pi', settingsPath: path }])
      const selection = { provider: 'fixture', model: 'managed' }
      const result = await buildModelCatalog(ctx, selection)
      const [managed, unmanaged] = result.groups[0]!.models
      expect(managed?.limits).toEqual(limits)
      expect(managed?.limitSettings).toEqual({ settingsNs: 'pi', settingsPath: path })
      expect(unmanaged?.limits?.platform).toEqual({})
      expect(unmanaged).not.toHaveProperty('limitSettings')
      expect(result.default).toEqual(selection)
      expect(result.default).not.toBe(selection)
      Object.assign(managed!.limits!.platform, { maxOutputTokens: 1 })
      Object.assign(managed!.limits!.override!, { maxOutputTokens: 1 })
      ;(managed!.limitSettings!.settingsPath as string[]).push('wrong')
      const again = await buildModelCatalog(ctx, selection)
      expect(again.groups[0]?.models[0]?.limits).toEqual(limits)
      expect(again.groups[0]?.models[0]?.limitSettings?.settingsPath).toEqual(path)
      expect(selection).toEqual({ provider: 'fixture', model: 'managed' })
    } finally { await ctx.fiber.dispose() }
  })
})
