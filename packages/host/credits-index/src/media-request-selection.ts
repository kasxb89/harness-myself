/** Per-human-request choices and authoritative native/PTC media selection. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionPromptAdmission } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { CreativeError } from './creative-store.ts'
import type { ImageParams, MediaSpecification, ModelCapability, VideoParams } from './media.ts'
import { canonicalMediaSpecification, resolveMediaSpecification } from './media-request-specification.ts'
import { validateMediaPreference, type MediaPreferencesStore } from './media-preferences.ts'
import type { MediaRequestSelection } from './media-preferences-types.ts'
import { humanVideoDurationSeconds, videoGenerationIntentOf } from './video-generation-intent.ts'

const selection = z.object({ model: z.string().min(1),
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) }).strict()
const snapshotSchema: z.ZodType<MediaRequestSelection> = z.intersection(
  z.object({ schema_version: z.literal(1), requestId: z.string().min(1) }),
  z.discriminatedUnion('state', [z.object({ state: z.literal('selected'), scope: z.string(), revision: z.string(),
    image: selection.nullable(), video: selection.nullable() }),
  z.object({ state: z.literal('unavailable'), code: z.enum(['MEDIA_PREFERENCES_UNAVAILABLE', 'ACCOUNT_CHANGED', 'MEDIA_PREFERENCES_CONFLICT']) })]))
interface HumanInput { readonly seq: number; readonly text: string; readonly requestId?: string | undefined }
interface RequestSelectionState {
  readonly selections: Readonly<Record<string, MediaRequestSelection>>
  readonly humans: readonly HumanInput[]
}
const stateSchema: z.ZodType<RequestSelectionState> = z.object({ selections: z.record(z.string(), snapshotSchema),
  humans: z.array(z.object({ seq: z.number().int().nonnegative(), text: z.string(),
    requestId: z.string().optional() }).strict()) }).strict()

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Frozen personal choices joined to each real human RPC and exact source event. */
    mediaRequestSelections: RequestSelectionState
  }
}

/** Required execution metadata is read only through the registered incremental projection. */
export const mediaRequestSelectionProjection: ProjectionDefinition<'mediaRequestSelections', RequestSelectionState> = {
  key: 'mediaRequestSelections', stateVersion: 1, stateSchema, init: () => ({ selections: {}, humans: [] }),
  apply(state, event) {
    if (event.type === 'media/request-selection') return { ...state, selections: { ...state.selections,
      [event.data.requestId]: event.data } }
    if (event.type !== 'user/message' || event.data.source.kind !== 'user' && event.data.source.kind !== 'user-question-reply') return state
    const source = event.data.source
    return { ...state, humans: [...state.humans, { seq: event.seq,
      text: event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
      ...source.kind === 'user' && 'rpcId' in source && typeof source.rpcId === 'string' ? { requestId: source.rpcId } : {} }] }
  },
}

/** Captured login metadata, never persisted in a media choice event. */
export interface MediaPreferenceOwner { readonly scope: string; readonly owner: string }

/**
 * Capture preferences locally before enqueue; a failed lookup affects media tools, not normal text.
 * @param ctx - Credits owner context.
 * @param store - Private stable-account preferences.
 * @param current - Local sign-in read; it must not renew remotely.
 */
export function registerMediaRequestSelection(
  ctx: Context, store: MediaPreferencesStore, current: () => Promise<MediaPreferenceOwner | undefined>,
): void {
  ctx.inject(['sessionProjections'], (owner) => {
    owner.effect(() => owner.sessionProjections.register(mediaRequestSelectionProjection))
    owner.on('session/prompt-admission', async (admission: SessionPromptAdmission, next) => {
      const session = admission.agent.session
      const projected = owner.sessionProjections.stateOf(session, 'mediaRequestSelections')
      if (projected?.selections[admission.requestId] !== undefined) {
        await next()
        return
      }
      let captured: MediaRequestSelection | undefined
      try {
        const identity = await current()
        const raw = admission.inputContext?.credits_media_preferences
        const hint = raw === undefined ? undefined : z.object({ scope: z.string().regex(/^[a-f0-9]{64}$/u),
          revision: z.string().regex(/^[a-f0-9]{64}$/u), accountOwner: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().safeParse(raw)
        if (raw !== undefined && (hint?.success !== true || identity === undefined || hint.data.scope !== identity.scope
          || hint.data.accountOwner !== identity.owner)) captured = { schema_version: 1, requestId: admission.requestId,
          state: 'unavailable', code: 'ACCOUNT_CHANGED' }
        else if (identity !== undefined) {
          const preferences = await store.read(identity.scope)
          const latest = await current()
          if (latest?.scope !== identity.scope || latest.owner !== identity.owner) captured = { schema_version: 1,
            requestId: admission.requestId, state: 'unavailable', code: 'ACCOUNT_CHANGED' }
          else if (hint?.success === true && hint.data.revision !== preferences.revision) captured = { schema_version: 1,
            requestId: admission.requestId, state: 'unavailable', code: 'MEDIA_PREFERENCES_CONFLICT' }
          else if (preferences.image !== null || preferences.video !== null || hint?.success === true) captured = {
            schema_version: 1, requestId: admission.requestId, state: 'selected', scope: preferences.scope,
            revision: preferences.revision, image: preferences.image, video: preferences.video }
        }
      } catch (_unavailablePrivatePreferences: unknown) {
        captured = { schema_version: 1, requestId: admission.requestId, state: 'unavailable', code: 'MEDIA_PREFERENCES_UNAVAILABLE' }
      }
      if (captured !== undefined) session.append('media/request-selection', captured)
      await next()
    })
  })
}

function unquoted(text: string): string {
  return text.normalize('NFKC').replaceAll(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』|《[^》\n]*》|`[^`\n]*`/gu, '')
    .split(/[，,。；;\n]/u).filter(clause => !/不要|不需|无需|不用|而非|不是|参考(?:图|视频|素材)/u.test(clause)).join('，')
}

function humanFields(
  text: string, kind: 'image' | 'video', models: readonly ModelCapability[],
): { model?: string; parameters: Record<string, string | number | boolean> } {
  let modality: 'image' | 'video' | undefined
  const clauses = unquoted(text).split(/[，,。；;\n]/u).filter((clause) => {
    if (/(?:生成|制作|创作|输出|做).*?(?:视频|成片|短片)/u.test(clause)) modality = 'video'
    else if (/(?:生成|制作|创作|输出|绘制|画).*?(?:图片|照片|图像)/u.test(clause)) modality = 'image'
    return modality === undefined || modality === kind
  })
  const value = clauses.join('，')
  const selected = models.filter(model => model.kind === kind && [model.id, model.displayName,
    ...model.id === 'MiniMax-H3' ? ['H3', 'mt-MiniMax-H3'] : []].some((name) => {
    let start = value.toLowerCase().indexOf(name.toLowerCase())
    while (start !== -1) {
      const before = value.slice(0, start)
      const after = value.slice(start + name.length)
      if (/(?:使用|采用|选择|换成|改用|用|model\s*:?|using|use)\s*$/iu.test(before)
        && !/^[a-z0-9._/-]/iu.test(after)) return true
      start = value.toLowerCase().indexOf(name.toLowerCase(), start + name.length)
    }
    return false
  }))
  const parameters: Record<string, string | number | boolean> = {}
  const ratios = [...value.matchAll(/(?<!\d)(\d+\s*[:：]\s*\d+)(?!\d)/gu)].map(match => match[1]?.replaceAll(/\s|：/gu, character => character === '：' ? ':' : '')).filter(item => item !== undefined)
  if (new Set(ratios).size === 1) parameters[kind === 'image' ? 'size' : 'ratio'] = ratios[0] ?? ''
  const resolutions = [...value.matchAll(/(?<![a-z0-9._/-])(?:\d+[pk]|\d+\s*[x×]\s*\d+)(?![a-z0-9._/-])/giu)].map(match => match[0].replaceAll(/\s/gu, '').replace('×', 'x'))
  if (new Set(resolutions).size === 1 && resolutions[0] !== undefined) {
    const resolution = resolutions[0]
    parameters[kind === 'image' && resolution.includes('x') ? 'size' : 'resolution'] = resolution
  }
  for (const [field, label] of [['quality', '(?:质量|品质|quality)'], ['mode', '(?:模式|mode)'], ['background', '(?:背景模式|background)'],
    ['format', '(?:输出格式|format)'], ['moderation', '(?:审核等级|moderation)']] as const) {
    const matches = [...value.matchAll(new RegExp(`${label}\\s*(?:为|是|[:：=])?\\s*([a-z0-9_-]+)`, 'giu'))].map(match => match[1])
    if (new Set(matches).size === 1 && matches[0] !== undefined) parameters[field] = matches[0]
  }
  const seed = /(?:seed|随机种子)\s*(?:为|是|[:：=])?\s*(-?\d+)/iu.exec(value)?.[1]
  if (seed !== undefined && Number.isSafeInteger(Number(seed))) parameters.seed = Number(seed)
  if (kind === 'image') {
    const counts = [...value.matchAll(/(?:生成|制作|输出|绘制|画|做|来|需要|我要|给我)\s*([0-9一二两三四五六七八九十]+)\s*(?:张|幅)(?:图片|图|照片|画)?/gu)]
      .map(match => /^[0-9]+$/u.test(match[1] ?? '') ? Number(match[1])
        : ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 } as Record<string, number>)[match[1] ?? ''])
    if (counts[0] !== undefined && Number.isSafeInteger(counts[0]) && counts.every(count => count === counts[0])) {
      parameters.count = counts[0]
    }
  }
  const controls = text.normalize('NFKC').replaceAll(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/gu, '')
  for (const [field, positive, negative] of [
    ['audio', /有声视频|(?:开启|需要|保留)(?:声音|音频|配乐)|audio\s*[:=]\s*true/iu,
      /(?:无声|静音)(?:视频|成片)|(?:不要|不需要|关闭|去掉)(?:声音|音频|配乐|背景音乐)|audio\s*[:=]\s*false/iu],
    ['watermark', /(?:开启|需要|保留|添加)水印|watermark\s*[:=]\s*true/iu,
      /(?:不要|不需要|关闭|去掉|无)水印|watermark\s*[:=]\s*false/iu],
  ] as const) {
    if (kind !== 'video') continue
    const yes = positive.test(value)
    const no = negative.test(controls)
    if (yes !== no) parameters[field] = yes
  }
  const model = selected.length === 1 ? selected[0] : undefined
  return { ...model === undefined ? {} : { model: model.id }, parameters }
}

/**
 * Read locally captured choices for this exact opaque execution without touching a directory or account service.
 * @param exec - Native or nested PTC execution under a real logged human request.
 * @returns Its admitted snapshot, absent for legacy requests and unrelated notifications.
 */
export function mediaRequestSelectionOf(exec: ToolExecution): MediaRequestSelection | undefined {
  const intent = videoGenerationIntentOf(exec)
  const state = exec.agent?.ctx.get('sessionProjections')?.stateOf(exec.agent.session, 'mediaRequestSelections')
  if (intent === undefined || state === undefined) return undefined
  const human = state.humans.find(value => value.seq === intent.grant.sourceSeq)
  return human?.requestId === undefined ? undefined : state.selections[human.requestId]
}

/**
 * Decide locally whether this modality needs personal selection, retaining account isolation for platform-following choices.
 * @param exec - Exact native or PTC human execution.
 * @param kind - Requested modality.
 * @param currentScope - Local private-account read; it must not renew credentials or read a remote directory.
 * @returns Whether the personal selection resolver requires an authorized model catalog.
 */
export async function needsMediaRequestSelectionCatalog(
  exec: ToolExecution, kind: 'image' | 'video', currentScope: () => Promise<string | undefined>,
): Promise<boolean> {
  const snapshot = mediaRequestSelectionOf(exec)
  if (snapshot === undefined) return false
  if (snapshot.state === 'unavailable') {
    if (snapshot.code === 'ACCOUNT_CHANGED') throw new CreativeError('ACCOUNT_CHANGED', 409,
      '本次提交所属登录状态已变化，请核对原账号；尚未提交生成。')
    return true
  }
  if (await currentScope() !== snapshot.scope) throw new CreativeError('ACCOUNT_CHANGED', 409,
    '本次生成所属账号已变化，请核对原账号；尚未提交生成。')
  return snapshot[kind] !== null
}

/** Host-resolved workflow facts; model arguments cannot declare an auxiliary role or rewrite clip timing. */
export interface MediaRequestSelectionContext {
  readonly auxiliaryImage?: boolean
  readonly videoProject?: boolean
  readonly plannedDurations?: readonly number[]
}

interface RequestChoiceInputs {
  readonly snapshot: MediaRequestSelection
  readonly human: HumanInput
  readonly revision?: HumanInput | undefined
  readonly explicitModel?: string | undefined
  readonly parameters: Record<string, string | number | boolean>
}

/**
 * Preserve submitted model identities while accepting the direct-H3 public display alias.
 * @param kind - Requested media modality.
 * @param id - Exact caller-supplied public model identifier or display alias.
 * @returns The original id, or the canonical direct-H3 id for its one video alias.
 */
export function canonicalMediaModelId(kind: 'image' | 'video', id: string): string {
  return kind === 'video' && id === 'mt-MiniMax-H3' ? 'MiniMax-H3' : id
}

function requestChoiceInputsOf(
  exec: ToolExecution, kind: 'image' | 'video', models: readonly ModelCapability[],
): RequestChoiceInputs | undefined {
  const intent = videoGenerationIntentOf(exec)
  const state = exec.agent?.ctx.get('sessionProjections')?.stateOf(exec.agent.session, 'mediaRequestSelections')
  if (intent === undefined || state === undefined) return undefined
  const human = state.humans.find(value => value.seq === intent.grant.sourceSeq)
  const snapshot = human?.requestId === undefined ? undefined : state.selections[human.requestId]
  if (snapshot === undefined || human === undefined) return undefined
  const revision = intent.humanRevision === undefined ? undefined : state.humans.find(value => value.seq === intent.humanRevision?.seq)
  const original = humanFields(human.text, kind, models)
  const latest = revision === undefined ? original : humanFields(revision.text, kind, models)
  const requestedModel = kind === 'video' ? intent.requestedModel ?? latest.model ?? original.model : latest.model ?? original.model
  const explicitModel = requestedModel === undefined ? undefined : canonicalMediaModelId(kind, requestedModel)
  const parameters = { ...original.parameters, ...latest.parameters }
  if (kind === 'video' && intent.requestedResolution !== undefined) parameters.resolution = intent.requestedResolution
  return { snapshot, human, revision, explicitModel, parameters }
}

/** The effective request model remains observable even before its complete specification is chosen. */
export interface MediaRequestModelChoice {
  readonly model: string
  readonly parameters: Readonly<Record<string, string | number | boolean>>
  readonly source: 'human' | 'personal'
}

function modelChoiceOf(inputs: RequestChoiceInputs, kind: 'image' | 'video', scope: string): MediaRequestModelChoice | undefined {
  const { snapshot, explicitModel, parameters } = inputs
  if (snapshot.state === 'unavailable') {
    if (explicitModel !== undefined && snapshot.code !== 'ACCOUNT_CHANGED') return { model: explicitModel, parameters, source: 'human' }
    throw new CreativeError(snapshot.code, 409, '本次提交的图片或视频偏好暂时无法确认，请刷新偏好后重新提出生成要求；本次未提交生成。')
  }
  if (snapshot.scope !== scope) throw new CreativeError('ACCOUNT_CHANGED', 409, '本次生成所属账号已变化，请核对原账号；尚未提交生成。')
  const preference = snapshot[kind]
  const model = explicitModel ?? preference?.model
  if (model === undefined) return undefined
  return { model, parameters: { ...preference?.model === model ? preference.parameters : {}, ...parameters },
    source: explicitModel === undefined ? 'personal' : 'human' }
}

/**
 * Read the effective human or saved model without requiring a complete paid specification.
 * @param exec - Exact logged native or PTC execution.
 * @param kind - Requested media modality.
 * @param models - Current-account authorized models used to identify real human model names.
 * @param scope - Current stable backend/account scope.
 * @returns The captured choice, or undefined when this request follows the platform default.
 */
export function mediaRequestModelChoiceOf(
  exec: ToolExecution, kind: 'image' | 'video', models: readonly ModelCapability[], scope: string,
): MediaRequestModelChoice | undefined {
  const inputs = requestChoiceInputsOf(exec, kind, models)
  return inputs === undefined ? undefined : modelChoiceOf(inputs, kind, scope)
}

/**
 * Normalize unique catalog enum spellings and direct H3's declared 768k shorthand.
 * @param capability - The actual selected model; an absent declaration cannot normalize parameters.
 * @param values - Caller fields; unrelated controls and unsupported values remain unchanged.
 * @returns Caller fields with declared equivalents normalized; other models never inherit H3 shorthand.
 */
export function canonicalMediaRequestParameters(
  capability: ModelCapability | undefined, values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (capability === undefined || capability.kind === 'audio') return { ...values }
  const params = capability.params as ImageParams | VideoParams
  const directH3Resolution = capability.kind === 'video' && capability.id === 'MiniMax-H3'
    && typeof values.resolution === 'string' && /^768k$/iu.test(values.resolution)
    ? params.resolutions?.find(value => value.toLowerCase() === '768p') : undefined
  const controls = directH3Resolution === undefined ? values : { ...values, resolution: directH3Resolution }
  const menu = params.specifications ?? [
    ...(params.resolutions ?? []).map(resolution => ({ resolution })),
    ...('sizes' in params ? params.sizes.map(size => ({ size })) : []),
    ...('ratios' in params ? params.ratios.map(ratio => ({ ratio })) : []),
    ...('modes' in params ? params.modes.map(mode => ({ mode })) : []),
    ...(params.qualities ?? []).map(quality => ({ quality })),
  ]
  return { ...controls, ...canonicalMediaSpecification(menu, controls) }
}

/**
 * Apply captured preferences only to the exact native/PTC human request, before new paid work.
 * A contradictory tool model is rejected before interpreting that model's specification.
 * @param exec - Opaque attributed execution, never a model-supplied source.
 * @param kind - Requested media modality.
 * @param args - Static controls using catalog field names, with unrelated caller fields preserved.
 * @param models - Same-modality pricing/relay-authorized models.
 * @param scope - Current stable backend/account scope.
 * @param context - Host-resolved auxiliary image role from the owning creation plan.
 * @returns Human-overridden preferences, or caller controls with declared equivalent enum spellings.
 */
export function resolveMediaRequestSelection<T extends Readonly<Record<string, unknown>>>(
  exec: ToolExecution, kind: 'image' | 'video', args: T, models: readonly ModelCapability[], scope: string,
  context?: MediaRequestSelectionContext,
): T & { readonly model?: string } {
  const namedArgs = typeof args.model === 'string' ? { ...args, model: canonicalMediaModelId(kind, args.model) } : args
  const inputs = requestChoiceInputsOf(exec, kind, models)
  if (inputs === undefined) return canonicalMediaRequestParameters(
    models.find(model => model.kind === kind && model.id === namedArgs.model), namedArgs) as T & { readonly model?: string }
  const { snapshot, human, revision, explicitModel } = inputs
  const choice = modelChoiceOf(inputs, kind, scope)
  const selectedCapability = models.find(model => model.kind === kind && model.id === (choice?.model ?? namedArgs.model))
  if (choice !== undefined && selectedCapability !== undefined && typeof namedArgs.model === 'string' && namedArgs.model !== choice.model) {
    throw new CreativeError('MEDIA_MODEL_MISMATCH', 409,
      `当前请求选择的模型为 ${selectedCapability.id}，与工具指定的模型不一致。请读取当前模型选择，并使用该模型的规格重新提交；本次尚未提交生成。`)
  }
  const explicit = canonicalMediaRequestParameters(selectedCapability, inputs.parameters) as Record<string, string | number | boolean>
  const requestArgs = canonicalMediaRequestParameters(selectedCapability, namedArgs)
  const instruction = [human.text, revision?.text ?? ''].join('，')
    .replaceAll(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/gu, '')
  const affirmative = instruction.split(/[，,。；;\n]/u)
    .filter(clause => !/不要|不需要|无需|不用|而非|不是/u.test(clause)).join('，')
  if (selectedCapability !== undefined && kind === 'video' && 'modes' in selectedCapability.params) {
    const params = selectedCapability.params
    const referenceInput = /图生视频|图生视|参考(?:图|图片)|(?:用|根据|基于).*(?:这张|这幅|图片|照片|参考图)/u.test(affirmative)
    const textInput = /文生视频|文字生成视频|纯文字视频/u.test(affirmative)
    const aliases = referenceInput && !textInput ? ['image-to-video', 'image_to_video', 'i2v', 'reference-to-video', 'reference_to_video']
      : textInput && !referenceInput ? ['text-to-video', 'text_to_video', 't2v'] : []
    const supported = params.modes.filter(mode => aliases.includes(mode.toLowerCase()))
    if (typeof requestArgs.mode === 'string' && supported.includes(requestArgs.mode)) explicit.mode = requestArgs.mode
    else if (supported.length === 1 && supported[0] !== undefined) explicit.mode = supported[0]
  }
  if (selectedCapability !== undefined && kind === 'image' && 'backgrounds' in selectedCapability.params) {
    const opaque = /不透明背景|背景不透明|实色背景|纯色背景|白色背景|黑色背景/u.test(affirmative)
      || /(?:不要|不需要|关闭)(?:透明背景|背景透明)/u.test(instruction)
    const transparent = !opaque && /透明背景|背景透明|去掉背景|抠图/u.test(affirmative)
    const background = opaque ? 'opaque' : transparent ? 'transparent' : undefined
    if (background !== undefined && selectedCapability.params.backgrounds.includes(background)) explicit.background = background
  }
  if (kind === 'video' && context?.videoProject !== true) {
    const duration = humanVideoDurationSeconds(revision?.text ?? human.text)
    if (duration !== undefined && selectedCapability !== undefined && 'durations' in selectedCapability.params
      && selectedCapability.params.durations.includes(duration)) explicit.seconds = duration
  }
  if (typeof explicit.resolution === 'string' && selectedCapability !== undefined && 'resolutions' in selectedCapability.params) {
    const requested = explicit.resolution
    explicit.resolution = selectedCapability.params.resolutions.find(value => value.toLowerCase() === requested.toLowerCase()) ?? requested
  }

  const imageTotal = kind === 'image' && typeof explicit.count === 'number' ? explicit.count : undefined
  const auxiliaryImage = kind === 'image' && (args.asset_id !== undefined
    || (context?.auxiliaryImage ?? (/视频|成片|短片/u.test(instruction) && imageTotal === undefined)))
  if (kind === 'image' && selectedCapability !== undefined && 'maxCount' in selectedCapability.params) {
    if (auxiliaryImage) delete explicit.count
    else if (imageTotal !== undefined) {
      const batch = args.count
      if (typeof batch === 'number' && Number.isSafeInteger(batch) && batch > 0
        && batch <= selectedCapability.params.maxCount && batch <= imageTotal) explicit.count = batch
      else if (imageTotal > selectedCapability.params.maxCount) delete explicit.count
    }
  }

  const preference = snapshot.state === 'selected' ? snapshot[kind] : null
  if (preference === null || explicitModel !== undefined && explicitModel !== preference.model) {
    if (explicitModel !== undefined) validateMediaPreference(kind, { model: explicitModel, parameters: explicit }, models)
    return {
      ...requestArgs, ...explicitModel === undefined ? {} : { model: explicitModel }, ...explicit,
    } as T & { readonly model?: string }
  }
  let normalized = canonicalMediaRequestParameters(
    selectedCapability, { ...preference.parameters, ...explicit },
  ) as Record<string, string | number | boolean>
  const plannedVideo = context?.videoProject === true && (context.plannedDurations !== undefined || args.plan_id !== undefined)
  if (plannedVideo) delete normalized.seconds
  if (auxiliaryImage || imageTotal !== undefined && explicit.count === undefined) delete normalized.count
  const model = explicitModel ?? preference.model
  const capability = models.find(value => value.kind === kind && value.id === model)
  const specifications = (capability?.params as ImageParams | VideoParams | undefined)?.specifications
  let effectiveArgs: Record<string, unknown> = requestArgs
  if (specifications !== undefined) {
    const fields = ['size', 'resolution', 'seconds', 'ratio', 'quality', 'mode'] as const
    const matches = (specification: MediaSpecification, values: Readonly<Record<string, unknown>>): boolean => fields.every(field =>
      values[field] === undefined || specification[field] === values[field])
    const requested = specifications.filter(specification => matches(specification, explicit))
    if (requested.length === 0) throw new CreativeError('SPECIFICATION_NOT_SUPPORTED', 409,
      '当前型号不支持用户本次明确要求的规格，请核对当前规格；尚未提交生成。')
    const discarded = new Set<string>()
    for (const field of fields) {
      if (explicit[field] === undefined && normalized[field] !== undefined
        && !requested.some(specification => specification[field] === normalized[field])) {
        discarded.add(field)
      }
    }
    normalized = Object.fromEntries(Object.entries(normalized).filter(([field]) => !discarded.has(field)))
    if (!requested.some(specification => matches(specification, normalized))) {
      for (const field of fields) if (explicit[field] === undefined) {
        discarded.add(field)
      }
    }
    normalized = Object.fromEntries(Object.entries(normalized).filter(([field]) => !discarded.has(field)))
    effectiveArgs = Object.fromEntries(Object.entries(effectiveArgs).filter(([field]) => !discarded.has(field)))
    const controls = { ...effectiveArgs, ...normalized }
    const dimensions = Object.fromEntries(fields.flatMap(field => controls[field] === undefined ? [] : [[field, controls[field]]]))
    if (plannedVideo) {
      const { seconds: _ignoredDefaultSeconds, ...projectDimensions } = dimensions
      const timing = context.plannedDurations
      const complete: MediaSpecification[] = []
      if (timing !== undefined) {
        for (const seconds of new Set(timing)) {
          const clip = resolveMediaSpecification(requested, { ...projectDimensions, seconds })
          if (!clip.ok) throw new CreativeError(clip.code, 409, clip.message)
          complete.push(clip.specification)
        }
      } else complete.push(...requested.filter(specification => matches(specification, projectDimensions)))
      if (complete.length === 0) throw new CreativeError('SPECIFICATION_NOT_SUPPORTED', 409,
        '当前规格与原分镜不兼容，请核对每段规格；尚未提交生成。')
      for (const field of ['size', 'resolution', 'ratio', 'quality', 'mode'] as const) {
        const values = new Set(complete.map(specification => specification[field]))
        const [value] = values
        if (values.size !== 1) throw new CreativeError('SPECIFICATION_REQUIRED', 409,
          '原分镜仍对应多个分辨率或质量规格，请明确完整规格；尚未提交生成。')
        if (value !== undefined) normalized[field] = value
      }
    } else {
      const complete = resolveMediaSpecification(requested, dimensions)
      if (!complete.ok) throw new CreativeError(complete.code, 409, complete.message)
      Object.assign(normalized, complete.specification)
    }
  }
  validateMediaPreference(kind, { model, parameters: normalized }, models)
  return { ...effectiveArgs, model, ...normalized } as T & { readonly model?: string }
}
