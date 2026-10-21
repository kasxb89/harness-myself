/** Default model references remain live without a settings service. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import DefaultModel from '../src/index.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

it('reads complete selections from volatile config and clears omitted reasoning effort', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const live = await liveConfig(ctx, DefaultModel, { provider: 'p', model: 'm' })
  const consumer = ctx.agentDefaultModel
  await live.update({ provider: 'q', model: 'n', reasoningEffort: 'high' })
  expect(consumer.currentSelection()).toEqual({ provider: 'q', model: 'n', reasoningEffort: 'high' })
  await live.replace({ provider: 'p', model: 'm' })
  expect(consumer.currentSelection()).toEqual({ provider: 'p', model: 'm' })
  await consumer.saveSelection({ provider: 'unsaved', model: 'unsaved' })
  expect(consumer.currentSelection()).toEqual({ provider: 'p', model: 'm' })
})

it('persists complete selections through its owning profile entry', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ReasoningEffortId } = await import('@deepseek-ai/dsh-llm')
  const { ctx } = await configurationFixture({ hmr: false })
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'next', reasoningEffort: ReasoningEffortId('high') })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'next', reasoningEffort: 'high' })
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'final' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'final' })
  const standalone = new Context()
  onTestFinished(() => standalone.fiber.dispose())
  await standalone.plugin(DefaultModel, { provider: 'test', model: 'original' })
  await standalone.agentDefaultModel.saveSelection({ provider: 'test', model: 'ignored' })
  expect(standalone.agentDefaultModel.currentSelection().model).toBe('original')
})

it('serializes overlapping saves and continues after a rejected write', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ctx } = await configurationFixture({ hmr: false })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const editor = ctx.configEditor
  const edit = editor.edit.bind(editor)
  const calls: string[] = []
  const intercepted = vi.spyOn(editor, 'edit').mockImplementationOnce(async () => {
    calls.push('rejected')
    entered.resolve(undefined)
    await release.promise
    throw new Error('read-only document')
  }).mockImplementation(async (entry, change) => {
    calls.push('saved')
    await edit(entry, change)
  })
  const first = ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'rejected' })
  const failed = expect(first).rejects.toThrow('read-only document')
  const lastSelection = { provider: 'test', model: 'final' }
  const last = ctx.agentDefaultModel.saveSelection(lastSelection)
  onTestFinished(async () => {
    release.resolve(undefined)
    await Promise.allSettled([failed, last])
    intercepted.mockRestore()
  })
  lastSelection.model = 'mutated'
  await entered.promise
  expect(calls).toEqual(['rejected'])
  release.resolve(undefined)
  await failed
  await last
  expect(calls).toEqual(['rejected', 'saved'])
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'final' })
})

it('follows the live deployment policy only while the composition opts in', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const live = await liveConfig(ctx, DefaultModel, { provider: 'product', model: 'original', followPolicy: true })
  let model = 'first'
  const read = () => ({ provider: 'product', model })
  const dispose = ctx.agentDefaultModel.registerPolicySelection(read)
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'product', model: 'first' })
  const captured = ctx.agentDefaultModel.currentSelection()
  model = 'second'
  expect(captured.model).toBe('first')
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('second')
  await live.replace({ provider: 'custom', model: 'explicit' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'custom', model: 'explicit' })
  await live.update({ followPolicy: true })
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('second')
  dispose()
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'custom', model: 'explicit' })
})

it('withdraws an owned policy without clearing a later contribution', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await liveConfig(ctx, DefaultModel, { provider: 'product', model: 'original', followPolicy: true })
  const read = () => ({ provider: 'product', model: 'policy' })
  const first = ctx.agentDefaultModel.registerPolicySelection(read)
  expect(() => ctx.agentDefaultModel.registerPolicySelection(read)).toThrow('already registered')
  first()
  const second = ctx.agentDefaultModel.registerPolicySelection(read)
  first()
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('policy')
  second()
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('original')
})

it('persists a manual selection as an opt-out and retains policy after a rejected save', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ctx, start } = await configurationFixture({ hmr: false })
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'default-model')
  if (entry === undefined) throw new Error('Missing default model fixture')
  await ctx.configEditor.edit(entry, () => ({ provider: 'test', model: 'original', followPolicy: true }))
  const dispose = ctx.agentDefaultModel.registerPolicySelection(() => ({ provider: 'product', model: 'recommended' }))
  const rejected = vi.spyOn(ctx.configEditor, 'edit').mockRejectedValueOnce(new Error('read-only profile'))
  await expect(ctx.agentDefaultModel.saveSelection({ provider: 'custom', model: 'manual' })).rejects.toThrow('read-only')
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('recommended')
  rejected.mockRestore()
  await ctx.agentDefaultModel.saveSelection({ provider: 'custom', model: 'manual' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'custom', model: 'manual' })
  dispose()
  const restored = await start()
  const release = restored.agentDefaultModel.registerPolicySelection(() => ({ provider: 'product', model: 'new-policy' }))
  expect(restored.agentDefaultModel.currentSelection()).toEqual({ provider: 'custom', model: 'manual' })
  release()
})
