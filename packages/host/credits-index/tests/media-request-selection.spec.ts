import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { MediaPreferencesStore, mediaPreferencesScope } from '../src/media-preferences.ts'
import { CreativeError } from '../src/creative-store.ts'
import { registerMediaRequestSelection, resolveMediaRequestSelection, needsMediaRequestSelectionCatalog, mediaRequestModelChoiceOf,
  canonicalMediaModelId, canonicalMediaRequestParameters, type MediaRequestSelectionContext } from '../src/media-request-selection.ts'
import { registerVideoGenerationIntent } from '../src/video-generation-intent.ts'
import type { MediaPreferenceSelection } from '../src/media-preferences-types.ts'
import { preferenceModels } from './media-preferences.fixture.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-request-media-choice-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new MediaPreferencesStore(directory)
  const scope = mediaPreferencesScope('https://example.test/harness', '7')
  let owner: string | undefined = 'a'.repeat(64)
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(SessionProjections)
  await ctx.plugin((owner: Context) => { registerVideoGenerationIntent(owner) })
  await ctx.plugin((feature: Context) => { registerMediaRequestSelection(feature, store, async () =>
    owner === undefined ? undefined : { scope, owner }) })
  const session = Session.create(SessionId('media-chat'), [], { version: SESSION_FORMAT_VERSION, id: SessionId('media-chat'),
    createdAt: 0, isSeeded: false, cwd: directory })
  const unsupported = (): never => { throw new Error('fixture inbox is immutable') }
  const agent: Agent = {
    id: session.header.id, session, ctx, options: {}, status: 'running',
    inbox: { nextTurn: [], nextStep: [], clear: unsupported, append: unsupported, prepend: unsupported,
      replace: unsupported, remove: unsupported, splice: unsupported },
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
    whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
  }
  let previous = await store.read(scope)
  const save = async (image: MediaPreferenceSelection | null, video: MediaPreferenceSelection | null) => {
    previous = await store.save(scope, owner ?? '', { schema_version: 1, expected_account_owner: owner,
      expected_revision: previous.revision, image, video }, preferenceModels, async () => {})
    return previous
  }
  const admit = async (id: string, text = '生成风景素材', hint?: { scope: string; revision: string; accountOwner: string }) => {
    const requestId = brandString<SessionRequestId>(id)
    const message = createUserMessage({ source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text }] })
    await ctx.waterfall('session/prompt-admission', { agent, requestId, message,
      ...hint === undefined ? {} : { inputContext: { credits_media_preferences: hint } } }, async () => {})
    return message
  }
  const selections: Record<string, unknown>[] = []
  const choices: ReturnType<typeof mediaRequestModelChoiceOf>[] = []
  const failures: CreativeError[] = []
  let liveModels = preferenceModels
  let pending: Promise<void> | undefined
  let callerFields: Record<string, unknown> = {}
  let auxiliaryImage: boolean | undefined
  let videoProject: MediaRequestSelectionContext | undefined
  let executionScope = scope
  let inspectLegacySelection = false
  let catalogReads = 0
  const inspect = async (exec: ToolRunContext) => {
    const kind = exec.name === 'image' ? 'image' : 'video'
    const args = { ...callerFields }
    const needed = await needsMediaRequestSelectionCatalog(exec, kind, async () => executionScope)
    if (needed) catalogReads += 1
    if (needed) choices.push(mediaRequestModelChoiceOf(exec, kind, liveModels, executionScope))
    try {
      selections.push(needed || inspectLegacySelection ? resolveMediaRequestSelection(exec, kind, args, liveModels, executionScope,
        { ...videoProject, ...auxiliaryImage === undefined ? {} : { auxiliaryImage } }) : args)
    } catch (error) {
      if (error instanceof CreativeError) failures.push(error)
      throw error
    }
    await pending
    return []
  }
  for (const name of ['image', 'video']) ctx.tools.register(defineContentToolFixture({ name, description: 'Inspect request choices.',
    parameters: {}, async execute(_args, exec) { return inspect(exec) } }))
  ctx.tools.register(defineContentToolFixture({ name: 'ptc', description: 'Inspect nested PTC choices.', parameters: {},
    async execute(_args, exec) {
      await ctx.tools.execute({ agent, signal: exec.signal, rootCallId: exec.rootCallId, parent: exec.token,
        callId: ToolCallId('nested-image'), name: 'image', arguments: {} })
      return []
    } }))
  let sequence = 0
  const execute = async (name: 'image' | 'video' | 'ptc') => {
    const callId = ToolCallId(`call-${String(++sequence)}`)
    session.append('tool/call', { turn: 1, step: sequence, callId, name, arguments: '{}' })
    return ctx.tools.execute({ agent, signal: new AbortController().signal, callId, name, arguments: {} })
  }
  session.append('turn/start', { turn: 1 })
  return { ctx, directory, store, scope, session, agent, selections, choices, failures, save, admit, execute,
    setModels: (models: typeof liveModels) => { liveModels = models }, setOwner: (value?: string) => { owner = value },
    setPending: (value: Promise<void> | undefined) => { pending = value },
    setCallerFields: (value: Record<string, unknown>) => { callerFields = value },
    setAuxiliary: (value: boolean) => { auxiliaryImage = value },
    setExecutionScope: (value: string) => { executionScope = value },
    inspectLegacy: () => { inspectLegacySelection = true },
    catalogReads: () => catalogReads,
    setProject: (value: MediaRequestSelectionContext) => { videoProject = value } }
}

describe('per-RPC personal media snapshots through native and nested execution', () => {
  it('uses A for RPC1 and its PTC child even after B is saved, while RPC2 uses B', async () => {
    const f = await fixture()
    await f.save({ model: 'image-b', parameters: {} }, { model: 'video-b', parameters: { seconds: 10, resolution: '1080P', ratio: '16:9' } })
    const first = await f.admit('rpc-1')
    await f.save({ model: 'image-a', parameters: { size: '16:9', resolution: '2k' } }, { model: 'MiniMax-H3', parameters: {} })
    const second = await f.admit('rpc-2')
    f.session.append('user/message', first, { surfaceOp: 'append' })
    await f.execute('video')
    await f.execute('ptc')
    expect(f.selections).toEqual([{ model: 'video-b', seconds: 10, resolution: '1080P', ratio: '16:9' }, { model: 'image-b' }])
    f.session.append('user/message', second, { surfaceOp: 'append' })
    await f.execute('image')
    expect(f.selections.at(-1)).toEqual({ model: 'image-a', size: '16:9', resolution: '2k' })
  })

  it('reuses an unqueued RPC snapshot on retry instead of reading newly saved preferences', async () => {
    const f = await fixture()
    await f.save({ model: 'image-b', parameters: {} }, null)
    await f.admit('retry')
    await f.save({ model: 'image-a', parameters: {} }, null)
    const retry = await f.admit('retry')
    f.session.append('user/message', retry, { surfaceOp: 'append' })
    await f.execute('image')
    expect(f.selections).toEqual([{ model: 'image-b' }])
    expect(Object.keys(f.ctx.sessionProjections.stateOf(f.session, 'mediaRequestSelections')?.selections ?? {})).toEqual(['retry'])
  })

  it('lets explicit real human model and specification override saved defaults', async () => {
    const f = await fixture()
    await f.save({ model: 'image-b', parameters: {} }, { model: 'video-b', parameters: { resolution: '1080P', seconds: 10, ratio: '16:9' } })
    const message = await f.admit('explicit', '使用image-a生成图片，16:9，2k；用H3生成15秒视频，768P')
    f.session.append('user/message', message, { surfaceOp: 'append' })
    await f.execute('image')
    await f.execute('video')
    expect(f.selections[0]).toEqual({ model: 'image-a', size: '16:9', resolution: '2k' })
    expect(f.choices[0]).toEqual({ model: 'image-a', parameters: { size: '16:9', resolution: '2k' }, source: 'human' })
    expect(f.selections[1]).toMatchObject({ model: 'MiniMax-H3', resolution: '768P' })
  })

  it('keeps the saved square image specification when only the agent supplies another ratio and resolution', async () => {
    const f = await fixture()
    await f.save({ model: 'image-a', parameters: { size: '1:1', resolution: '1k' } }, null)
    f.setCallerFields({ size: '3:4', resolution: '2k' })
    f.session.append('user/message', await f.admit('saved-square-image', '生成春天风景图片'), { surfaceOp: 'append' })
    const result = await f.execute('image')
    expect(result.isError).not.toBe(true)
    expect(f.failures).toEqual([])
    expect(f.selections).toEqual([{ model: 'image-a', size: '1:1', resolution: '1k' }])
    expect(f.choices).toEqual([{ model: 'image-a', parameters: { size: '1:1', resolution: '1k' }, source: 'personal' }])
  })

  it('rejects a real human unsupported image ratio instead of silently using the saved square specification', async () => {
    const f = await fixture()
    await f.save({ model: 'image-a', parameters: { size: '1:1', resolution: '1k' } }, null)
    f.setCallerFields({ size: '1:1', resolution: '1k' })
    f.session.append('user/message', await f.admit('unsupported-human-image-ratio', '生成3:4比例的春天风景图片'),
      { surfaceOp: 'append' })
    const result = await f.execute('image')
    expect(result.isError).toBe(true)
    expect(f.selections).toEqual([])
    expect(f.failures[0]?.code).toBe('SPECIFICATION_NOT_SUPPORTED')
    expect(JSON.stringify(result.content)).toContain('用户本次明确要求的规格')
  })

  it('does not let one unresponsive generation block the next request capture', async () => {
    const f = await fixture()
    await f.save({ model: 'image-b', parameters: {} }, null)
    const first = await f.admit('running')
    f.session.append('user/message', first, { surfaceOp: 'append' })
    const hold = Promise.withResolvers<undefined>()
    f.setPending(hold.promise)
    const running = f.execute('image')
    await expect.poll(() => f.selections.length).toBe(1)
    await f.save({ model: 'image-a', parameters: { size: '16:9', resolution: '2k' } }, null)
    const second = await f.admit('new')
    f.session.append('user/message', second, { surfaceOp: 'append' })
    f.setPending(undefined)
    await f.execute('image')
    expect(f.selections).toEqual([{ model: 'image-b' }, { model: 'image-a', size: '16:9', resolution: '2k' }])
    hold.resolve(undefined)
    await running
  })

  it('contains unavailable preference metadata to media execution and rejects removed saved models', async () => {
    const f = await fixture()
    await f.save({ model: 'image-b', parameters: {} }, null)
    f.setModels(preferenceModels.filter(model => model.id !== 'image-b'))
    f.session.append('user/message', await f.admit('removed'), { surfaceOp: 'append' })
    const removed = await f.execute('image')
    expect(removed.isError).toBe(true)
    expect(f.selections).toEqual([])
    f.session.append('user/message', await f.admit('new-explicit', '用image-a生成图片'), { surfaceOp: 'append' })
    await f.execute('image')
    expect(f.selections).toEqual([{ model: 'image-a' }])
    await writeFile(join(f.directory, `${f.scope}.json`), '{bad')
    const plain = await f.admit('plain', '今天你好')
    expect(plain.content).toBeDefined()
    f.session.append('user/message', plain, { surfaceOp: 'append' })
    expect((await f.execute('image')).isError).toBe(true)
  })

  it('records owner/revision hint failures but never trusts renderer-provided selections', async () => {
    const f = await fixture()
    const saved = await f.save({ model: 'image-b', parameters: {} }, null)
    await f.admit('stale', '普通文字', { scope: f.scope, revision: 'b'.repeat(64), accountOwner: 'a'.repeat(64) })
    await f.admit('other', '普通文字', { scope: f.scope, revision: saved.revision, accountOwner: 'b'.repeat(64) })
    const state = f.ctx.sessionProjections.stateOf(f.session, 'mediaRequestSelections')
    expect(state?.selections.stale).toMatchObject({ state: 'unavailable', code: 'MEDIA_PREFERENCES_CONFLICT' })
    expect(state?.selections.other).toMatchObject({ state: 'unavailable', code: 'ACCOUNT_CHANGED' })
  })

  it('requires an explicit complete selection for a model-only personal preference with several priced specifications', async () => {
    const f = await fixture()
    await f.save(null, { model: 'video-b', parameters: {} })
    f.session.append('user/message', await f.admit('multiple-specs', '生成一个视频'), { surfaceOp: 'append' })
    const result = await f.execute('video')
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('完整规格')
    expect(f.selections).toEqual([])
    expect(f.choices).toEqual([{ model: 'video-b', parameters: {}, source: 'personal' }])
    expect(f.failures[0]?.code).toBe('SPECIFICATION_REQUIRED')
  })

  it('reports the effective saved model before interpreting another model\'s tool parameters', async () => {
    const f = await fixture()
    await f.save(null, { model: 'video-b', parameters: {} })
    f.setCallerFields({ model: 'MiniMax-H3', resolution: '768P', ratio: '9:16' })
    f.setProject({ videoProject: true, plannedDurations: [30, 30] })
    f.session.append('user/message', await f.admit('different-tool-model', '生成一分钟视频'), { surfaceOp: 'append' })
    const result = await f.execute('video')
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('当前请求选择的模型为 video-b')
    expect(JSON.stringify(result.content)).toContain('本次尚未提交生成')
    expect(f.selections).toEqual([])
    expect(f.choices).toEqual([{ model: 'video-b', parameters: {}, source: 'personal' }])
    expect(f.failures[0]?.code).toBe('MEDIA_MODEL_MISMATCH')
  })

  it('uses an explicit real human H3 selection and canonical resolution instead of saved non-H3 parameters', async () => {
    const f = await fixture()
    await f.save(null, { model: 'video-b', parameters: { resolution: '1080P', seconds: 10, ratio: '16:9' } })
    f.setCallerFields({ model: 'MiniMax-H3', resolution: '768p', ratio: '9:16' })
    f.setProject({ videoProject: true, plannedDurations: [15, 15] })
    f.session.append('user/message', await f.admit('human-h3', '用H3生成竖屏视频，9:16，768p'), { surfaceOp: 'append' })
    await f.execute('video')
    expect(f.selections).toEqual([{ model: 'MiniMax-H3', resolution: '768P', ratio: '9:16' }])
    expect(f.choices[0]).toMatchObject({ model: 'MiniMax-H3', source: 'human' })
  })

  it('canonicalizes tool enum spelling for the same selected model without changing planned timing', async () => {
    const f = await fixture()
    await f.save(null, { model: 'video-b', parameters: {} })
    f.setCallerFields({ model: 'video-b', resolution: '1080p', ratio: '16:9', shot_durations_seconds: [10, 10] })
    f.setProject({ videoProject: true, plannedDurations: [10, 10] })
    f.session.append('user/message', await f.admit('same-model-spelling', '生成20秒视频'), { surfaceOp: 'append' })
    await f.execute('video')
    expect(f.selections).toEqual([{ model: 'video-b', resolution: '1080P', ratio: '16:9', shot_durations_seconds: [10, 10] }])
  })

  it('accepts only the exact direct-H3 display alias while retaining its canonical submission id', async () => {
    const f = await fixture()
    await f.save(null, { model: 'video-b', parameters: {} })
    f.setCallerFields({ model: 'mt-MiniMax-H3', resolution: '768p' })
    f.session.append('user/message', await f.admit('direct-h3-alias', '用mt-MiniMax-H3生成15秒视频'), { surfaceOp: 'append' })
    await f.execute('video')
    expect(f.selections.at(-1)).toMatchObject({ model: 'MiniMax-H3', resolution: '768P', seconds: 15 })
    f.setCallerFields({ model: 'mt-unrelated' })
    f.session.append('user/message', await f.admit('unrelated-prefix', '生成视频'), { surfaceOp: 'append' })
    const result = await f.execute('video')
    expect(result.isError).toBe(true)
    expect(f.selections).toHaveLength(1)
  })

  it('lets current human count, sound, watermark and seed override saved defaults', async () => {
    const f = await fixture()
    await f.save({ model: 'image-a', parameters: { size: '16:9', resolution: '2k', count: 2, seed: 1 } },
      { model: 'video-b', parameters: { seconds: 10, resolution: '1080P', ratio: '16:9', audio: true, watermark: true, seed: 1 } })
    f.session.append('user/message', await f.admit('image-count', '生成3张图片，随机种子42'), { surfaceOp: 'append' })
    await f.execute('image')
    expect(f.selections.at(-1)).toMatchObject({ model: 'image-a', count: 3, seed: 42 })
    f.session.append('user/message', await f.admit('video-flags', '生成视频，不需要声音，不要水印，seed=43'), { surfaceOp: 'append' })
    await f.execute('video')
    expect(f.selections.at(-1)).toMatchObject({ model: 'video-b', audio: false, watermark: false, seed: 43 })
  })

  it('preserves legal per-call batches for a larger human total and keeps auxiliary images single', async () => {
    const f = await fixture()
    await f.save({ model: 'image-a', parameters: { size: '16:9', resolution: '2k', count: 1 } }, null)
    f.setCallerFields({ count: 3 })
    f.session.append('user/message', await f.admit('six-images', '生成6张图片'), { surfaceOp: 'append' })
    await f.execute('image')
    await f.execute('image')
    expect(f.selections.map(value => value.count)).toEqual([3, 3])
    await f.save({ model: 'image-a', parameters: { size: '16:9', resolution: '2k', count: 3 } }, null)
    f.setCallerFields({ plan_id: 'ordinary-image-plan', shot_id: 'shot_1' })
    f.setAuxiliary(false)
    f.session.append('user/message', await f.admit('image-plan', '生成成图'), { surfaceOp: 'append' })
    await f.execute('image')
    expect(f.selections.at(-1)).toMatchObject({ model: 'image-a', count: 3 })
    f.setCallerFields({ count: 1, asset_id: 'fox-reference' })
    f.setAuxiliary(true)
    f.session.append('user/message', await f.admit('one-video', '生成1条视频，先画角色参考图'), { surfaceOp: 'append' })
    await f.execute('image')
    expect(f.selections.at(-1)).toMatchObject({ model: 'image-a', count: 1 })
    await f.save({ model: 'image-b', parameters: { count: 1 } }, null)
    f.setCallerFields({ count: 1 })
    f.setAuxiliary(false)
    f.session.append('user/message', await f.admit('single-batches', '生成3张图片'), { surfaceOp: 'append' })
    await f.execute('image')
    expect(f.selections.at(-1)).toMatchObject({ model: 'image-b', count: 1 })
  })

  it('drops incompatible saved specification dimensions when a human higher tier uniquely determines the legal combination', async () => {
    const f = await fixture()
    await f.save({ model: 'image-a', parameters: { size: '1:1', resolution: '1k' } },
      { model: 'video-b', parameters: { seconds: 5, resolution: '720P', ratio: '16:9' } })
    f.setCallerFields({ size: '1:1', resolution: '1k' })
    f.session.append('user/message', await f.admit('higher-image', '生成2k图片'), { surfaceOp: 'append' })
    await f.execute('image')
    expect(f.selections.at(-1)).toMatchObject({ model: 'image-a', size: '16:9', resolution: '2k' })
    f.setCallerFields({ resolution: '720P' })
    f.session.append('user/message', await f.admit('higher-video', '生成1080P视频'), { surfaceOp: 'append' })
    await f.execute('video')
    expect(f.selections.at(-1)).toMatchObject({ model: 'video-b', seconds: 10, resolution: '1080P', ratio: '16:9' })
  })

  it('recognizes an unambiguous current directory display name without allowing agent model arguments to replace preferences', async () => {
    const f = await fixture()
    f.setModels(preferenceModels.map(model => model.id === 'image-a' ? { ...model, displayName: '清晰绘图' } : model))
    await f.save({ model: 'image-b', parameters: {} }, null)
    f.session.append('user/message', await f.admit('named', '改用清晰绘图生成图片，16:9，2k'), { surfaceOp: 'append' })
    await f.execute('image')
    expect(f.selections.at(-1)).toMatchObject({ model: 'image-a', size: '16:9', resolution: '2k' })
  })

  it('applies an explicit reference workflow and transparent background instead of incompatible saved static defaults', async () => {
    const f = await fixture()
    const live = preferenceModels.map((model) => {
      if (model.id === 'video-b' && 'modes' in model.params) {
        const { specifications: _complete, ...parameters } = model.params
        return { ...model, params: { ...parameters, modes: ['text-to-video', 'image-to-video'] } }
      }
      return model.id === 'image-b' && 'backgrounds' in model.params ? { ...model,
        params: { ...model.params, backgrounds: ['opaque', 'transparent'] } } : model
    })
    f.setModels(live)
    // The production directory validates these declarations before the private-file fixture is captured.
    const initial = await f.store.read(f.scope)
    await f.store.save(f.scope, 'a'.repeat(64), { schema_version: 1, expected_account_owner: 'a'.repeat(64),
      expected_revision: initial.revision, image: { model: 'image-b', parameters: { background: 'opaque' } },
      video: { model: 'video-b', parameters: { mode: 'text-to-video', seconds: 10 } } }, live, async () => {})
    f.setCallerFields({ mode: 'image-to-video', reference_images: ['fixture-reference'] })
    f.session.append('user/message', await f.admit('reference-workflow', '用这张参考图做图生视频'), { surfaceOp: 'append' })
    await f.execute('video')
    expect(f.selections.at(-1)).toMatchObject({ model: 'video-b', mode: 'image-to-video' })
    f.setCallerFields({})
    f.session.append('user/message', await f.admit('background', '生成图片，透明背景'), { surfaceOp: 'append' })
    await f.execute('image')
    expect(f.selections.at(-1)).toMatchObject({ model: 'image-b', background: 'transparent' })
    f.session.append('user/message', await f.admit('opaque-background', '生成图片，不要透明背景，用白色背景'), { surfaceOp: 'append' })
    await f.execute('image')
    expect(f.selections.at(-1)).toMatchObject({ model: 'image-b', background: 'opaque' })
    f.setCallerFields({ mode: 'text-to-video' })
    f.session.append('user/message', await f.admit('text-workflow', '不要参考图，纯文字生成视频'), { surfaceOp: 'append' })
    await f.execute('video')
    expect(f.selections.at(-1)).toMatchObject({ model: 'video-b', mode: 'text-to-video' })
  })

  it('keeps final project duration separate from each planned clip and never overwrites legal mixed clip timing', async () => {
    const f = await fixture()
    await f.save(null, { model: 'video-b', parameters: { resolution: '1080P', seconds: 10, ratio: '16:9' } })
    f.setProject({ videoProject: true, plannedDurations: [5, 5] })
    f.setCallerFields({ total_duration_seconds: 10, shot_durations_seconds: [5, 5] })
    f.session.append('user/message', await f.admit('ten-second-project', '用video-b生成720P的10秒视频'), { surfaceOp: 'append' })
    await f.execute('video')
    expect(f.selections.at(-1)).toMatchObject({ model: 'video-b', resolution: '720P', total_duration_seconds: 10,
      shot_durations_seconds: [5, 5] })
    expect(f.selections.at(-1)).not.toHaveProperty('seconds')
    const live = preferenceModels.map(model => model.id === 'video-b' && 'specifications' in model.params ? { ...model,
      params: { ...model.params, specifications: [{ resolution: '1080P', seconds: 5, ratio: '16:9' },
        { resolution: '1080P', seconds: 10, ratio: '16:9' }] } } : model)
    f.setModels(live)
    f.setProject({ videoProject: true, plannedDurations: [5, 10] })
    f.setCallerFields({ total_duration_seconds: 15, shot_durations_seconds: [5, 10] })
    f.session.append('user/message', await f.admit('mixed-clip-project', '生成1080P的15秒视频'), { surfaceOp: 'append' })
    await f.execute('video')
    expect(f.selections.at(-1)).toMatchObject({ resolution: '1080P', total_duration_seconds: 15, shot_durations_seconds: [5, 10] })
    expect(f.selections.at(-1)).not.toHaveProperty('seconds')
  })

  it('keeps account isolation for the platform-following modality without extra directory reads and tolerates token renewal', async () => {
    const f = await fixture()
    f.setCallerFields({ model: 'image-a' })
    await f.save(null, { model: 'video-b', parameters: { resolution: '1080P', seconds: 10, ratio: '16:9' } })
    const message = await f.admit('other-kind')
    f.session.append('user/message', message, { surfaceOp: 'append' })
    f.setExecutionScope(mediaPreferencesScope('https://example.test/harness', '8'))
    expect((await f.execute('image')).isError).toBe(true)
    expect(f.catalogReads()).toBe(0)
    expect(f.selections).toEqual([])
    f.setExecutionScope(f.scope)
    f.setOwner('c'.repeat(64))
    await f.execute('image')
    expect(f.catalogReads()).toBe(0)
    expect(f.selections).toEqual([{ model: 'image-a' }])
  })

  it('leaves legacy no-preference requests unchanged and writes no required event for ordinary text', async () => {
    const f = await fixture()
    f.setCallerFields({ model: 'MiniMax-H3' })
    f.session.append('user/message', await f.admit('legacy'), { surfaceOp: 'append' })
    await f.execute('video')
    expect(f.selections).toEqual([{ model: 'MiniMax-H3' }])
    expect(f.ctx.sessionProjections.stateOf(f.session, 'mediaRequestSelections')?.selections).toEqual({})
    expect(f.catalogReads()).toBe(0)
  })

  it('normalizes only the exact direct-H3 tool alias without a captured preference', async () => {
    const f = await fixture()
    f.inspectLegacy()
    f.setCallerFields({ model: 'mt-MiniMax-H3' })
    f.session.append('user/message', await f.admit('legacy-alias'), { surfaceOp: 'append' })
    await f.execute('video')
    f.setCallerFields({ model: 'ycapi-minimax-h3' })
    f.session.append('user/message', await f.admit('legacy-yc'), { surfaceOp: 'append' })
    await f.execute('video')
    expect(f.selections).toEqual([{ model: 'MiniMax-H3' }, { model: 'ycapi-minimax-h3' }])
  })

  it('normalizes legacy tool controls only from the supplied selected model declaration', async () => {
    const f = await fixture()
    f.inspectLegacy()
    f.setCallerFields({ model: 'video-b', resolution: '1080p', seconds: 10 })
    f.session.append('user/message', await f.admit('legacy-spec-spelling'), { surfaceOp: 'append' })
    await f.execute('video')
    expect(f.selections).toEqual([{ model: 'video-b', resolution: '1080P', seconds: 10 }])
    expect(canonicalMediaModelId('video', 'mt-MiniMax-H3')).toBe('MiniMax-H3')
    expect(canonicalMediaModelId('video', 'ycapi-minimax-h3')).toBe('ycapi-minimax-h3')
    expect(canonicalMediaModelId('image', 'mt-MiniMax-H3')).toBe('mt-MiniMax-H3')
    expect(canonicalMediaRequestParameters(undefined, { resolution: '1080p' })).toEqual({ resolution: '1080p' })
  })

  it.each(['MiniMax-H3', 'video-b'])('resolves human H3 768k shorthand over the %s preference', async (preferredModel) => {
    const f = await fixture()
    await f.save(null, { model: preferredModel, parameters: {} })
    f.setCallerFields({ model: 'MiniMax-H3', resolution: '768k' })
    f.session.append('user/message', await f.admit('human-h3-shorthand', '用H3生成一条768k视频'), { surfaceOp: 'append' })
    await f.execute('video')
    expect(f.selections.at(-1)).toMatchObject({ model: 'MiniMax-H3', resolution: '768P' })
    const h3 = preferenceModels.find(model => model.id === 'MiniMax-H3')
    if (h3 === undefined) throw new Error('Expected direct H3 fixture')
    expect(canonicalMediaRequestParameters({ ...h3, id: 'ycapi-minimax-h3' }, { resolution: '768K' }))
      .toEqual({ resolution: '768K' })
  })
})
