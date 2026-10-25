/** Account- and chat-owned creation plans joined to committed generation files. @module */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ArtifactImageRole } from '@deepseek-ai/dsh-artifacts-index'
import type { CreativeAsset, CreativeCharacter, CreativeImageReceipt, CreativeVideoReceipt, CreativeKind, CreativeOutput, CreativeOutputId, CreativePlanChange, CreativeProjectId, CreativeProjectView, CreativeShotPlan, CreativeShotView, CreativeSource, CreativeStatus, CreativeTaskView } from './creative-types.ts'
import type { VideoProjectManifest, VideoProjectRead } from './video-project.ts'
import type { VideoProjectIdentity } from './video-project-types.ts'
import { parseArtifactOrigin } from './artifact-origin.ts'
import { parseVideoRequestGrant, type VideoGenerationIntent, type VideoRequestGrant } from './video-generation-intent.ts'
import { notifyCreationActivity } from './creation-activity.ts'
import type { CreationOperationActivity } from './creation-activity.ts'
import type { MediaFilenameOptions } from './media-filename.ts'

/** Fixed complete-record and collection bounds for untrusted JSON and directory reads. */
const MAX_BYTES = 2 * 1024 * 1024
const MAX_PROJECTS = 1000
const MAX_OPERATIONS = 256
const MAX_LIST_BYTES = 8 * 1024 * 1024

export type { CreativeProjectId, CreativeShotPlan } from './creative-types.ts'
/** Owner-issued generation invocation identity. */
export type CreativeOperationId = Branded<'CreativeOperationId'>

/** A structured failure whose message excludes private paths and credentials. */
export class CreativeError extends Error {
  /** @param code - Stable code. @param status - Local HTTP status. @param message - Safe recovery instruction. */
  constructor(readonly code: string, readonly status: number, message: string) { super(message); this.name = 'CreativeError' }
}

/** One captured calling chat and product account; tokens are never stored. */
export interface CreativeOwner extends VideoProjectIdentity {
  readonly sessionId: string
  readonly workspaceRoot: string
}

/** Complete planning input supplied through the logged model tool. */
export interface CreativePlan {
  readonly kind: CreativeKind
  readonly title: string
  readonly brief: string
  readonly style: string
  readonly characters: readonly CreativeCharacter[]
  readonly assets: readonly CreativeAsset[]
  readonly shots: readonly CreativeShotPlan[]
}

/** Exact local files admitted after generation, never accepted as tool-provided outputs. */
interface SavedOutput {
  id: CreativeOutputId
  kind: 'image' | 'video' | 'audio'
  path: string
  frames?: { path: string; timeSeconds: number }[]
  previewUnavailable?: boolean
}

/** One explicitly linked invocation and its independently committed outcome. */
interface Operation {
  id: CreativeOperationId
  source?: CreativeSource
  prompt: string
  shotIds: string[]
  assetId?: string
  status: CreativeStatus
  submissionStarted?: boolean
  imageReceipt?: CreativeImageReceipt
  videoReceipt?: CreativeVideoReceipt
  outputs: SavedOutput[]
  videoProjectId?: string
  model?: string
  errorCode?: string
  requestGrant?: VideoRequestGrant
}

/** Private JSON v1. Existing video manifests and Session data remain unchanged. */
interface CreativeRecord extends CreativePlan {
  version: 1
  id: CreativeProjectId
  owner: CreativeOwner
  updatedAt: string
  operations: Operation[]
}

interface BeginInput {
  kind: CreativeKind
  /** Supplied by the trusted calling entry, never by model or HTTP parameters. */
  source?: CreativeSource
  prompt: string
  planId?: string
  shotIds?: readonly string[]
  assetId?: string
  shots: readonly { prompt: string; durationSeconds?: number }[]
  videoProjectId?: string
  model?: string
  expectedRevision?: string
  videoIntent?: VideoGenerationIntent
}

interface ShotFacts { status: CreativeStatus; outputs: SavedOutput[]; durationSeconds?: number }
interface CreationFacts {
  shots: Map<string, ShotFacts[]>
  assets: Map<string, ShotFacts[]>
  outputs: SavedOutput[]
  errors: string[]
  publicationErrorCode?: 'ARTIFACT_PUBLISH_FAILED'
  states: { shotIds: readonly string[]; assetId?: string; status: CreativeStatus }[]
  updatedAt: string
  tasks: (Omit<CreativeTaskView, 'outputs'> & { outputs: SavedOutput[] })[]
}

/** Exact operation identity returned before any paid submission. */
export interface CreativeOperation {
  readonly projectId: CreativeProjectId
  readonly operationId: CreativeOperationId
  readonly owner: CreativeOwner
  /** Image purpose derived from the validated original plan kind and immutable material association. */
  readonly imageRole?: ArtifactImageRole
  /** Remaining works in this human request after the atomic admission; absent on resumed operations. */
  readonly remainingVideoWorks?: number
  /** Runtime-only labels from this invocation's existing plan; never task identity or persisted fields. */
  readonly outputNaming?: Omit<MediaFilenameOptions, 'extension'>
}

/** Derive names only from the original invocation's explicit material or shot association. */
function operationOutputNaming(record: CreativeRecord, operation: Operation, kind: CreativeKind): Omit<MediaFilenameOptions, 'extension'> {
  const asset = operation.assetId === undefined ? undefined : record.assets.find(item => item.id === operation.assetId)
  const shot = operation.shotIds.length !== 1 ? undefined : record.shots.find(item => item.id === operation.shotIds[0])
  const shotTitle = shot?.title === String(shot?.order) ? undefined : shot?.title
  const planTitle = record.title === record.brief.slice(0, 80) ? undefined : record.title
  const title = asset?.name || shotTitle || planTitle
  const role = kind === 'video' ? shotTitle === undefined ? 'video' : 'shot'
    : asset === undefined ? 'image' : /参考|reference|identity|character|人物|角色/iu.test(asset.role) ? 'reference-image' : 'shot-image'
  return { ...title === undefined ? {} : { title }, prompt: operation.prompt, role,
    ...shotTitle === undefined || shot === undefined ? {} : { index: shot.order } }
}

/** Only the original plan kind and its validated image-material binding establish an image's purpose. */
function operationImageRole(record: CreativeRecord, assetId: string | undefined): ArtifactImageRole | undefined {
  if (record.kind === 'image') return 'final'
  return assetId !== undefined && record.assets.some(asset => asset.id === assetId && asset.kind === 'image') ? 'storyboard' : undefined
}

/** Runtime-only adapters; records never contain service objects or credentials. */
export interface CreativeStoreOptions {
  readonly directory: string
  /** Observe committed process-live invocations without counting retained records as active. */
  readonly activity?: (event: CreationOperationActivity) => void
  /** @returns Current login identity, or undefined after sign-out. */
  current(): Promise<VideoProjectIdentity | undefined>
  /** @returns Authorized retained video state after optional local output publication; no submission is made. */
  video(id: string, owner: CreativeOwner): Promise<VideoProjectRead>
}

/** Reject a malformed record or model input with a safe message. */
function invalid(): never { throw new CreativeError('CREATIVE_INVALID', 400, '创作记录或计划无效，请检查人物、素材和镜头信息。') }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function text(value: unknown, maximum = 12_000): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) return invalid()
  return value
}
function identifier(value: unknown): string {
  const result = text(value, 128)
  if (!/^[A-Za-z0-9_-]+$/u.test(result)) return invalid()
  return result
}
function projectId(value: string): CreativeProjectId {
  if (!/^cp_[a-f0-9-]{36}$/u.test(value)) return invalid()
  return value as CreativeProjectId
}
function operationId(value: unknown): CreativeOperationId { const id = identifier(value); if (!id.startsWith('op_')) invalid(); return id as CreativeOperationId }
function outputId(value: unknown): CreativeOutputId { const id = identifier(value); if (!id.startsWith('out_') && !id.startsWith('op_')) invalid(); return id as CreativeOutputId }
function list<T>(value: unknown, parse: (item: unknown) => T, maximum: number): T[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid()
  return value.map(parse)
}
function ids(value: unknown): string[] { return list(value, identifier, 128) }
function unique(values: readonly string[]): void { if (new Set(values).size !== values.length) invalid() }
function status(value: unknown): CreativeStatus {
  if (value !== 'planned' && value !== 'running' && value !== 'saving' && value !== 'editing' && value !== 'completed' && value !== 'failed' && value !== 'cancelled' && value !== 'interrupted' && value !== 'unknown') return invalid()
  return value
}

/** Validate receipt fields before retaining or reading a private creation record. */
function imageReceipt(value: unknown, sessionId?: string): CreativeImageReceipt {
  const item = object(value)
  const route = text(item.route, 512)
  const model = text(item.model, 256)
  const phase = item.phase
  const fingerprint = text(item.backendFingerprint, 64)
  const receiptId = (value: unknown): string => {
    const result = text(value, 256)
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result) || /^(?:sk-|nap_)/iu.test(result)) return invalid()
    return result
  }
  if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/u.test(route)
    || route.split('/').some(part => part === '.' || part === '..')
    || model.trim() !== model || model === '' || /[\u0000-\u001f\u007f]/u.test(model)
    || !/^[a-f0-9]{64}$/u.test(fingerprint)
    || phase !== 'submitting' && phase !== 'accepted' && phase !== 'completed') return invalid()
  const taskId = item.taskId === undefined ? undefined : receiptId(item.taskId)
  const requestId = item.requestId === undefined ? undefined : receiptId(item.requestId)
  if (phase === 'accepted' && taskId === undefined) return invalid()
  const origin = parseArtifactOrigin(item.origin, sessionId)
  if (origin === null) return invalid()
  return { route, model, phase, backendFingerprint: fingerprint,
    ...origin === undefined ? {} : { origin },
    ...taskId === undefined ? {} : { taskId }, ...requestId === undefined ? {} : { requestId } }
}
function mergeImageReceipt(prior: CreativeImageReceipt | undefined, value: CreativeImageReceipt, category: CreativeKind = 'image'): CreativeImageReceipt {
  const incoming = imageReceipt(value)
  const order = { submitting: 0, accepted: 1, completed: 2 }
  if (prior !== undefined && (prior.route !== incoming.route || prior.model !== incoming.model
    || prior.backendFingerprint !== incoming.backendFingerprint || order[incoming.phase] < order[prior.phase]
    || prior.taskId !== undefined && incoming.taskId !== undefined && prior.taskId !== incoming.taskId
    || prior.requestId !== undefined && incoming.requestId !== undefined && prior.requestId !== incoming.requestId
    || JSON.stringify(prior.origin) !== JSON.stringify(incoming.origin))) {
    throw new CreativeError(category === 'image' ? 'CREATIVE_IMAGE_RECEIPT_CONFLICT' : 'CREATIVE_VIDEO_RECEIPT_CONFLICT', 409,
      category === 'image' ? '原图片任务的回执不能替换，请保留原任务编号后核对。' : '原视频任务的回执不能替换，请保留原任务编号后核对。')
  }
  return { ...incoming, ...prior?.taskId !== undefined ? { taskId: prior.taskId } : {},
    ...prior?.requestId !== undefined ? { requestId: prior.requestId } : {} }
}
function kind(value: unknown): CreativeKind { return value === 'image' || value === 'video' ? value : invalid() }
function absolute(value: unknown): string {
  const result = text(value, 32_768)
  if (!isAbsolute(result)) return invalid()
  return result
}

function duration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 86_400) return invalid()
  return value
}
function character(value: unknown): CreativeCharacter {
  const item = object(value)
  return {
    id: identifier(item.id), name: text(item.name, 256), appearance: text(item.appearance), clothing: text(item.clothing),
    personality: text(item.personality), voice: text(item.voice), referenceAssetIds: ids(item.referenceAssetIds),
  }
}
function asset(value: unknown): CreativeAsset {
  const item = object(value)
  const category = item.kind
  if (category !== 'image' && category !== 'video' && category !== 'audio' && category !== 'document' && category !== 'other') return invalid()
  return {
    id: identifier(item.id), name: text(item.name, 256), kind: category, role: text(item.role), description: text(item.description),
    sourcePathOrAssetId: text(item.sourcePathOrAssetId, 32_768),
  }
}
function shot(value: unknown): CreativeShotPlan {
  const item = object(value)
  const order = item.order
  if (!Number.isSafeInteger(order) || typeof order !== 'number' || order < 1 || order > 128) return invalid()
  return {
    id: identifier(item.id), order, title: text(item.title, 256), prompt: text(item.prompt),
    camera: text(item.camera), scene: text(item.scene), action: text(item.action),
    dialogue: text(item.dialogue), subtitles: text(item.subtitles), characterIds: ids(item.characterIds), assetIds: ids(item.assetIds),
    ...item.durationSeconds === undefined ? {} : { durationSeconds: duration(item.durationSeconds) },
  }
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid()
}

/**
 * Parse one explicit browser edit without accepting execution state or arbitrary object properties.
 * @param value - Untrusted JSON change from an authenticated request.
 * @returns A bounded change whose complete resulting plan is validated by revise.
 */
export function parseCreativePlanChange(value: unknown): CreativePlanChange {
  const source = object(value)
  switch (source.kind) {
    case 'shot': {
      fields(source, ['kind', 'id', 'patch'])
      const patch = object(source.patch)
      fields(patch, ['title', 'durationSeconds', 'camera', 'scene', 'action', 'prompt', 'dialogue', 'subtitles', 'characterIds', 'assetIds'])
      return { kind: 'shot', id: identifier(source.id), patch: {
        ...Object.hasOwn(patch, 'title') ? { title: text(patch.title, 256) } : {},
        ...Object.hasOwn(patch, 'durationSeconds') ? { durationSeconds: duration(patch.durationSeconds) } : {},
        ...Object.hasOwn(patch, 'camera') ? { camera: text(patch.camera) } : {},
        ...Object.hasOwn(patch, 'scene') ? { scene: text(patch.scene) } : {},
        ...Object.hasOwn(patch, 'action') ? { action: text(patch.action) } : {},
        ...Object.hasOwn(patch, 'prompt') ? { prompt: text(patch.prompt) } : {},
        ...Object.hasOwn(patch, 'dialogue') ? { dialogue: text(patch.dialogue) } : {},
        ...Object.hasOwn(patch, 'subtitles') ? { subtitles: text(patch.subtitles) } : {},
        ...Object.hasOwn(patch, 'characterIds') ? { characterIds: ids(patch.characterIds) } : {},
        ...Object.hasOwn(patch, 'assetIds') ? { assetIds: ids(patch.assetIds) } : {},
      } }
    }
    case 'reorder':
      fields(source, ['kind', 'shotIds'])
      return { kind: 'reorder', shotIds: ids(source.shotIds) }
    case 'character': {
      fields(source, ['kind', 'value', 'assets'])
      fields(object(source.value), ['id', 'name', 'appearance', 'clothing', 'personality', 'voice', 'referenceAssetIds'])
      const assets = source.assets === undefined ? undefined : list(source.assets, (value) => {
        fields(object(value), ['id', 'name', 'kind', 'role', 'description', 'sourcePathOrAssetId'])
        const parsed = asset(value)
        if (parsed.kind !== 'image' || !/^ma_[A-Za-z0-9_-]+$/u.test(parsed.sourcePathOrAssetId)) return invalid()
        return parsed
      }, 128)
      if (assets !== undefined) unique(assets.map(item => item.id))
      return { kind: 'character', value: character(source.value), ...assets === undefined ? {} : { assets } }
    }
    case 'asset': {
      fields(source, ['kind', 'value'])
      fields(object(source.value), ['id', 'name', 'kind', 'role', 'description', 'sourcePathOrAssetId'])
      return { kind: 'asset', value: asset(source.value) }
    }
    case 'remove-character': case 'remove-asset': case 'remove-shot':
      fields(source, ['kind', 'id'])
      return { kind: source.kind, id: identifier(source.id) }
    case 'add-shot':
      fields(source, ['kind', 'value'])
      fields(object(source.value), ['id', 'order', 'title', 'durationSeconds', 'camera', 'scene', 'action', 'prompt', 'dialogue', 'subtitles', 'characterIds', 'assetIds'])
      return { kind: 'add-shot', value: shot(source.value) }
    default:
      return invalid()
  }
}

/**
 * Parse a complete structured plan at model/tool and private-file ingress.
 * @param value - Untrusted camel-case planning data.
 * @returns Bounded plan with unique ids and resolved character/material references.
 */
export function parseCreativePlan(value: unknown): CreativePlan {
  const source = object(value)
  const characters = list(source.characters, character, 64)
  const assets = list(source.assets, asset, 128)
  const shots = list(source.shots, shot, 128)
  if (shots.length === 0) invalid()
  unique(characters.map(item => item.id))
  unique(assets.map(item => item.id))
  unique(shots.map(item => item.id))
  unique(shots.map(item => String(item.order)))
  const characterIds = new Set(characters.map(item => item.id))
  const assetIds = new Set(assets.map(item => item.id))
  if (characters.some(item => item.referenceAssetIds.some(id => !assetIds.has(id)))
    || shots.some(item => item.characterIds.some(id => !characterIds.has(id)) || item.assetIds.some(id => !assetIds.has(id)))) invalid()
  const result = {
    kind: kind(source.kind), title: text(source.title, 256), brief: text(source.brief), style: text(source.style),
    characters, assets, shots: shots.sort((a, b) => a.order - b.order),
  }
  if (result.title.trim() === '' || result.brief.trim() === '' || result.shots.some(item => item.prompt.trim() === '')) invalid()
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES / 2) invalid()
  return result
}

/** Parse records completely before any path or media use. */
function parseRecord(value: unknown): CreativeRecord {
  const source = object(value)
  if (source.version !== 1) return invalid()
  const owner = object(source.owner)
  const operations = list<Operation>(source.operations, (value) => {
    const item = object(value)
    const requestGrant = parseVideoRequestGrant(item.requestGrant)
    if (requestGrant === null) return invalid()
    if (item.source !== undefined && item.source !== 'chat' && item.source !== 'ai-creation') return invalid()
    if (item.submissionStarted !== undefined && typeof item.submissionStarted !== 'boolean') return invalid()
    const outputs = list<SavedOutput>(item.outputs, (value) => {
      const output = object(value)
      const category = output.kind
      if (category !== 'image' && category !== 'video' && category !== 'audio') return invalid()
      const frames = output.frames === undefined ? undefined : list(output.frames, (value) => {
        const frame = object(value)
        if (typeof frame.timeSeconds !== 'number' || !Number.isFinite(frame.timeSeconds) || frame.timeSeconds < 0) return invalid()
        return { path: absolute(frame.path), timeSeconds: frame.timeSeconds }
      }, 6)
      if (output.previewUnavailable !== undefined && typeof output.previewUnavailable !== 'boolean') return invalid()
      return {
        id: outputId(output.id), kind: category, path: absolute(output.path), ...frames === undefined ? {} : { frames },
        ...output.previewUnavailable === undefined ? {} : { previewUnavailable: output.previewUnavailable },
      }
    }, 512)
    const recordedStatus = status(item.status)
    if (item.imageReceipt !== undefined && item.videoReceipt !== undefined) return invalid()
    return {
      id: operationId(item.id), prompt: text(item.prompt), shotIds: ids(item.shotIds),
      ...item.source === undefined ? {} : { source: item.source },
      status: recordedStatus === 'cancelled' && item.submissionStarted === true ? 'unknown' : recordedStatus, outputs,
      ...item.assetId === undefined ? {} : { assetId: identifier(item.assetId) },
      ...item.submissionStarted === undefined ? {} : { submissionStarted: item.submissionStarted },
      ...item.imageReceipt === undefined ? {} : { imageReceipt: imageReceipt(item.imageReceipt, identifier(owner.sessionId)) },
      ...item.videoReceipt === undefined ? {} : { videoReceipt: imageReceipt(item.videoReceipt, identifier(owner.sessionId)) },
      ...requestGrant === undefined ? {} : { requestGrant },
      ...item.videoProjectId === undefined ? {} : { videoProjectId: text(item.videoProjectId, 128) },
      ...item.model === undefined ? {} : { model: text(item.model, 256) },
      ...item.errorCode === undefined ? {} : { errorCode: identifier(item.errorCode) },
    }
  }, MAX_OPERATIONS)
  const plan = parseCreativePlan(source)
  if (operations.some(item => item.source === 'ai-creation' && (item.requestGrant !== undefined
    || item.videoProjectId !== undefined || item.videoReceipt?.origin?.toolCallId !== undefined
    || item.imageReceipt?.origin?.toolCallId !== undefined))) return invalid()
  if (operations.some(item => item.videoReceipt !== undefined && (plan.kind !== 'video' || item.videoProjectId !== undefined || item.assetId !== undefined))) return invalid()
  if (operations.some(item => item.assetId === undefined
    ? item.shotIds.length === 0 || item.shotIds.some(id => !plan.shots.some(shot => shot.id === id))
    : item.shotIds.length > 0 || !plan.assets.some(asset => asset.id === item.assetId && asset.kind === 'image'))) return invalid()
  return {
    ...plan, version: 1, id: projectId(text(source.id)),
    owner: {
      accountId: text(owner.accountId, 128), sessionFingerprint: text(owner.sessionFingerprint, 256),
      sessionId: identifier(owner.sessionId), workspaceRoot: absolute(owner.workspaceRoot),
    },
    updatedAt: text(source.updatedAt, 64), operations,
  }
}

/** Open the exact canonical file and protect against symlink replacement. */
async function safeFile(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  if (resolve(path) !== path || await realpath(path) !== path) throw new CreativeError('CREATIVE_MEDIA_UNAVAILABLE', 404, '文件已移动、删除或暂时无法读取，请检查原保存位置。')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new CreativeError('CREATIVE_MEDIA_UNAVAILABLE', 404, '文件暂时无法读取。')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  const opened = await file.stat()
  if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size || opened.mtimeMs !== info.mtimeMs) { await file.close(); throw new CreativeError('CREATIVE_MEDIA_CHANGED', 409, '文件已变化，请刷新后重试。') }
  return file
}

/** Aggregate only committed generation facts, keeping incomplete plans visibly incomplete. */
function aggregate(states: readonly CreativeStatus[]): CreativeStatus {
  for (const state of ['unknown', 'running', 'saving', 'editing', 'interrupted', 'failed', 'cancelled'] as const) if (states.includes(state)) return state
  return states.length > 0 && states.every(value => value === 'completed') ? 'completed' : 'planned'
}

/**
 * Hash the complete normalized planning fields independently of execution progress.
 * @param plan - The exact plan read before asynchronous generation preparation.
 * @returns Revision to check atomically when beginning the prepared invocation.
 */
export function creativePlanRevision(plan: CreativePlan): string {
  return createHash('sha256').update(JSON.stringify(parseCreativePlan(plan))).digest('hex')
}

/** Keep one real path per collection, retaining the latest preview metadata. */
function uniqueOutputs(outputs: readonly SavedOutput[]): SavedOutput[] {
  return [...new Map(outputs.map(output => [output.path, output])).values()]
}

/** Owns serialized local records and read-only browser projections. */
export class CreativeStore {
  private serial: Promise<unknown> = Promise.resolve()
  private readonly active = new Map<string, Omit<CreationOperationActivity, 'active'>>()
  private rootDirectory: Promise<string> | undefined

  /** @param options - Private directory and current-account/video adapters. */
  constructor(private readonly options: CreativeStoreOptions) {}

  private activate(operation: CreativeOperation, kind: 'image' | 'video', videoProjectId?: string): void {
    if (this.active.has(operation.operationId)) return
    const activity = { operation, kind, ...videoProjectId === undefined ? {} : { videoProjectId } }
    this.active.set(operation.operationId, activity)
    notifyCreationActivity(this.options.activity, { ...activity, active: true })
  }

  private deactivate(operation: CreativeOperation): void {
    const activity = this.active.get(operation.operationId)
    if (!this.active.delete(operation.operationId) || activity === undefined) return
    notifyCreationActivity(this.options.activity, { ...activity, active: false })
  }

  private root(): Promise<string> {
    this.rootDirectory ??= (async () => {
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
      if ((await lstat(this.options.directory)).isSymbolicLink()) invalid()
      return realpath(this.options.directory)
    })()
    return this.rootDirectory
  }

  private async current(owner: VideoProjectIdentity): Promise<void> {
    const live = await this.options.current()
    if (live?.accountId !== owner.accountId || live.sessionFingerprint !== owner.sessionFingerprint) throw new CreativeError('CREATIVE_ACCOUNT_CHANGED', 409, '登录状态已变化，已停止更新本次创作；请在原账号查看。')
  }

  private queue<T>(run: () => Promise<T>): Promise<T> {
    const work = this.serial.then(run)
    this.serial = work.catch((error: unknown) => { void error })
    return work
  }

  private async read(id: string, owner: Pick<CreativeOwner, 'accountId' | 'sessionId'>, workspaceRoot?: string): Promise<CreativeRecord> {
    const path = join(await this.root(), projectId(id), 'project.json')
    const file = await safeFile(path)
    let value: unknown
    try {
      if ((await file.stat()).size > MAX_BYTES) invalid()
      value = JSON.parse(await file.readFile('utf8'))
    } finally { await file.close() }
    const storedOwner = object(object(value).owner)
    // Unrelated history is not an input to this owner's count or recovery checks.
    if (typeof storedOwner.accountId === 'string' && storedOwner.accountId !== owner.accountId
      || typeof storedOwner.sessionId === 'string' && storedOwner.sessionId !== owner.sessionId
      || workspaceRoot !== undefined && typeof storedOwner.workspaceRoot === 'string' && storedOwner.workspaceRoot !== workspaceRoot) {
      throw new CreativeError('CREATIVE_ACCESS_DENIED', 404, '当前聊天中没有该创作项目。')
    }
    const result = parseRecord(value)
    if (result.id !== id || result.owner.accountId !== owner.accountId || result.owner.sessionId !== owner.sessionId) throw new CreativeError('CREATIVE_ACCESS_DENIED', 404, '当前聊天中没有该创作项目。')
    return result
  }

  /**
   * Recover a project's original workspace using only its current account and exact chat identity.
   * @param identity - Captured current product account and login generation.
   * @param id - Explicit existing project id.
   * @param sessionId - Exact owning conversation; another chat cannot reuse this project.
   * @returns Current login with the record's original workspace, without activating an Agent.
   */
  async owner(identity: VideoProjectIdentity, id: string, sessionId: string): Promise<CreativeOwner> {
    await this.serial
    await this.current(identity)
    const record = await this.read(id, { accountId: identity.accountId, sessionId })
    await this.current(identity)
    return { ...identity, sessionId, workspaceRoot: record.owner.workspaceRoot }
  }

  private async persist(record: CreativeRecord): Promise<void> {
    await this.current(record.owner)
    record.updatedAt = new Date().toISOString()
    const encoded = JSON.stringify(record)
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw new CreativeError('CREATIVE_LIMIT', 400, '创作记录过大，已停止后续生成，请减少素材或镜头。')
    const directory = join(await this.root(), record.id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (await realpath(directory) !== directory) invalid()
    const temporary = join(directory, `.project-${randomUUID()}.json`)
    await writeFile(temporary, encoded, { flag: 'wx', mode: 0o600 })
    try { await this.current(record.owner); await rename(temporary, join(directory, 'project.json')) }
    catch (error) { await unlink(temporary); throw error }
  }

  private async replacePlan(owner: CreativeOwner, old: CreativeRecord, plan: CreativePlan): Promise<CreativeProjectId> {
    const parsed = parseCreativePlan(plan)
    if (old.owner.workspaceRoot !== owner.workspaceRoot || old.kind !== parsed.kind || old.operations.some(operation =>
      operation.shotIds.some(shotId => !parsed.shots.some(shot => shot.id === shotId))
      || operation.assetId !== undefined && !parsed.assets.some(asset => asset.id === operation.assetId && asset.kind === 'image'))) {
      throw new CreativeError('CREATIVE_PLAN_CONFLICT', 409, '已有生成记录的镜头或图片素材不能移除，项目类型和工作区不能改变。')
    }
    for (const operation of old.operations) {
      if (!this.active.has(operation.id)) continue
      const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
      const referencedCharacters = new Set<string>()
      const referencedAssets = new Set<string>(operation.assetId === undefined ? [] : [operation.assetId])
      for (const id of operation.shotIds) {
        const before = old.shots.find(shot => shot.id === id)
        if (!same(before, parsed.shots.find(shot => shot.id === id))) {
          throw new CreativeError('CREATIVE_PLAN_RUNNING', 409, '相关镜头正在生成，请等待任务结束后再修改或排序。')
        }
        before?.characterIds.forEach(id => referencedCharacters.add(id))
        before?.assetIds.forEach(id => referencedAssets.add(id))
      }
      for (const character of old.characters) {
        if (referencedCharacters.has(character.id)
          || operation.assetId !== undefined && character.referenceAssetIds.includes(operation.assetId)) {
          if (!same(character, parsed.characters.find(item => item.id === character.id))) {
            throw new CreativeError('CREATIVE_PLAN_RUNNING', 409, '相关人物或素材正在生成，请等待任务结束后再修改。')
          }
          character.referenceAssetIds.forEach(id => referencedAssets.add(id))
        }
      }
      if ([...referencedAssets].some(id => !same(old.assets.find(item => item.id === id), parsed.assets.find(item => item.id === id)))) {
        throw new CreativeError('CREATIVE_PLAN_RUNNING', 409, '相关素材正在生成，请等待任务结束后再修改。')
      }
    }
    await this.persist({ ...old, ...parsed, owner })
    return old.id
  }

  /**
   * Save a complete explicit plan, preserving every existing execution association.
   * @param owner - Calling chat and captured product login.
   * @param plan - Bounded structured plan.
   * @param id - Existing explicit project id; omission creates a fresh project.
   * @returns Exact project id for later generation calls.
   */
  updatePlan(owner: CreativeOwner, plan: CreativePlan, id?: string): Promise<CreativeProjectId> {
    return this.queue(async () => {
      await this.current(owner)
      const parsed = parseCreativePlan(plan)
      if (id === undefined) {
        const record: CreativeRecord = { ...parsed, version: 1, id: `cp_${randomUUID()}` as CreativeProjectId, owner, updatedAt: '', operations: [] }
        await this.persist(record)
        return record.id
      }
      const old = await this.read(id, owner)
      return this.replacePlan(owner, old, parsed)
    })
  }

  /**
   * Apply one explicit edit only while its original planning revision is current.
   * @param owner - Current account, exact chat and workspace.
   * @param id - Existing creation project id.
   * @param expectedRevision - Hash last returned with the displayed plan; progress does not invalidate it.
   * @param change - One targeted change, checked with the complete resulting plan before persistence.
   * @returns The unchanged project identity after an atomic edit; stale, referenced or active changes reject without writing.
   */
  revise(owner: CreativeOwner, id: string, expectedRevision: string, change: CreativePlanChange): Promise<CreativeProjectId> {
    return this.queue(async () => {
      await this.current(owner)
      const old = await this.read(id, owner)
      if (old.owner.workspaceRoot !== owner.workspaceRoot) throw new CreativeError('CREATIVE_ACCESS_DENIED', 404, '该创作计划不属于当前工作区。')
      if (creativePlanRevision(old) !== expectedRevision) throw new CreativeError('CREATIVE_PLAN_STALE', 409, '创作计划已变化，请刷新后再修改。')
      let plan = parseCreativePlan(old)
      const missing = (): never => { throw new CreativeError('CREATIVE_PLAN_CONFLICT', 409, '人物、素材或镜头已变化，请刷新后重新选择。') }
      switch (change.kind) {
        case 'shot': {
          if (!plan.shots.some(item => item.id === change.id)) missing()
          plan = { ...plan, shots: plan.shots.map(item => item.id === change.id
            ? { ...item, ...change.patch, id: item.id, order: item.order } : item) }
          break
        }
        case 'reorder': {
          if (change.shotIds.length !== plan.shots.length || new Set(change.shotIds).size !== change.shotIds.length) missing()
          plan = { ...plan, shots: change.shotIds.map((id, index) => {
            const shot = plan.shots.find(item => item.id === id)
            return shot === undefined ? missing() : { ...shot, order: index + 1 }
          }) }
          break
        }
        case 'character':
          if (change.assets?.some(asset => plan.assets.some(item => item.id === asset.id))) missing()
          plan = { ...plan, characters: plan.characters.some(item => item.id === change.value.id)
            ? plan.characters.map(item => item.id === change.value.id ? change.value : item) : [...plan.characters, change.value],
          assets: [...plan.assets, ...change.assets ?? []] }
          break
        case 'asset':
          plan = { ...plan, assets: plan.assets.some(item => item.id === change.value.id)
            ? plan.assets.map(item => item.id === change.value.id ? change.value : item) : [...plan.assets, change.value] }
          break
        case 'remove-character':
          if (!plan.characters.some(item => item.id === change.id)) missing()
          plan = { ...plan, characters: plan.characters.filter(item => item.id !== change.id) }
          break
        case 'remove-asset':
          if (!plan.assets.some(item => item.id === change.id)) missing()
          plan = { ...plan, assets: plan.assets.filter(item => item.id !== change.id) }
          break
        case 'remove-shot':
          if (!plan.shots.some(item => item.id === change.id)) missing()
          plan = { ...plan, shots: plan.shots.filter(item => item.id !== change.id) }
          break
        case 'add-shot':
          plan = { ...plan, shots: [...plan.shots, change.value] }
          break
        default: {
          const unsupported: never = change
          void unsupported
          return invalid()
        }
      }
      return this.replacePlan(owner, old, plan)
    })
  }

  /**
   * Read the complete current plan before a targeted revision without changing execution state.
   * @param owner - Current account, exact chat and workspace.
   * @param id - Explicit existing creation plan id.
   * @returns Bounded original planning fields without private operation, provider or login data.
   */
  async plan(owner: CreativeOwner, id: string): Promise<CreativePlan> {
    await this.serial
    await this.current(owner)
    const record = await this.read(id, owner)
    if (record.owner.workspaceRoot !== owner.workspaceRoot) throw new CreativeError('CREATIVE_ACCESS_DENIED', 404, '该创作计划不属于当前工作区。')
    await this.current(owner)
    return parseCreativePlan(record)
  }

  private async assertVideoWorkCount(owner: CreativeOwner, intent: VideoGenerationIntent): Promise<number> {
    const unavailable = (): never => { throw new CreativeError('CREATIVE_VIDEO_INTENT_UNAVAILABLE', 409,
      '暂时无法核对已有视频与本次请求的对应关系，已停止新增生成；请先核对已有任务，需要追加时请明确发送新的生成要求。') }
    const grant = parseVideoRequestGrant(intent.grant)
    if (grant === undefined || grant === null) unavailable()
    const duplicate = (): never => { throw new CreativeError('CREATIVE_VIDEO_SUBMISSION_DUPLICATE', 409,
      '本次视频提交已登记，可能已被上游受理；请查看原任务，不会重复提交。需要另做一条时请明确提出新的生成要求。') }
    const sameSubmission = (prior: Pick<VideoGenerationIntent['evidence'][number], 'messageId' | 'callId' | 'rootCallSeq'>): boolean =>
      prior.messageId === intent.grant.messageId && prior.callId === intent.grant.callId
      && (prior.rootCallSeq === undefined || intent.grant.rootCallSeq === undefined || prior.rootCallSeq === intent.grant.rootCallSeq)
    let entries: string[]
    try { entries = await readdir(await this.root()) } catch (_error) { return unavailable() }
    if (entries.length > MAX_PROJECTS) unavailable()
    const matchedEvidence = new Set<VideoGenerationIntent['evidence'][number]>()
    let used = 0
    for (const id of entries) {
      if (!/^cp_[a-f0-9-]{36}$/u.test(id)) continue
      let record: CreativeRecord
      try { record = await this.read(id, owner, owner.workspaceRoot) } catch (error) {
        if (error instanceof CreativeError && error.code === 'CREATIVE_ACCESS_DENIED') continue
        return unavailable()
      }
      if (record.owner.workspaceRoot !== owner.workspaceRoot) continue
      for (const operation of record.operations) {
        if (operation.source === 'ai-creation') continue
        if (!(record.kind === 'video' && operation.assetId === undefined)
          && operation.videoReceipt === undefined && operation.videoProjectId === undefined) continue
        const evidence = intent.evidence.filter(item => item.operationId === operation.id
          || operation.videoProjectId !== undefined && item.videoProjectId === operation.videoProjectId)
        for (const item of evidence) matchedEvidence.add(item)
        let prior: Pick<VideoGenerationIntent['evidence'][number], 'messageId' | 'callId' | 'rootCallSeq'> | undefined
          = operation.requestGrant ?? evidence[0]
        let legacyRoot = false
        if (prior === undefined) {
          const origin = operation.videoReceipt?.origin
          if (origin?.sessionId === owner.sessionId && origin.toolCallId !== undefined) {
            const candidates = intent.calls.filter(call => call.native === true && call.callId === origin.toolCallId
              && call.turn === origin.turn && (origin.eventSeq === undefined
                || call.rootCallSeq !== undefined && call.rootCallSeq > origin.eventSeq))
            const original = candidates[0]
            if (original !== undefined && new Set(candidates.map(call => call.messageId)).size === 1) {
              prior = { messageId: original.messageId, callId: original.callId,
                ...candidates.length !== 1 || original.rootCallSeq === undefined ? {} : { rootCallSeq: original.rootCallSeq } }
              legacyRoot = true
            }
          }
        }
        // Older invocations keep their original project and uncertainty without claiming a later human's allowance.
        if (prior === undefined) continue
        const rootCallSeq = prior.rootCallSeq ?? evidence.find(item => item.messageId === prior.messageId
          && item.callId === prior.callId && item.rootCallSeq !== undefined)?.rootCallSeq
        const priorSubmission = { messageId: prior.messageId, callId: prior.callId,
          ...rootCallSeq === undefined ? {} : { rootCallSeq } }
        if (legacyRoot ? prior.callId === intent.grant.rootCallId
          && sameSubmission({ ...priorSubmission, callId: intent.grant.callId }) : sameSubmission(priorSubmission)) duplicate()
        if (prior.messageId === intent.grant.messageId) used += 1
      }
    }
    const unrecordedEvidence = intent.evidence.filter(item => item.messageId === intent.grant.messageId && !matchedEvidence.has(item))
    if (unrecordedEvidence.some(sameSubmission)) duplicate()
    const unrecorded = new Set(unrecordedEvidence.map(item => item.operationId !== undefined ? `operation:${item.operationId}`
      : item.videoProjectId !== undefined ? `project:${item.videoProjectId}`
        : `call:${String(item.rootCallSeq)}:${item.callId}`))
    used += unrecorded.size
    if (used >= intent.grant.maxWorks) {
      throw new CreativeError('CREATIVE_VIDEO_COUNT_LIMIT', 409,
        `这次已经安排 ${String(used)} 个视频作品，请先查看或恢复原任务。若想追加，可直接说明另做几条，或修改成片总数量；已安排的作品会计入总量。`)
    }
    return used
  }

  private async assertGenerationAvailable(record: CreativeRecord, input: Pick<BeginInput, 'shotIds' | 'assetId'>): Promise<void> {
    const wanted = new Set(input.shotIds ?? [])
    const overlaps = (item: { shotIds: readonly string[]; assetId?: string }): boolean => input.assetId === undefined
      ? item.assetId === undefined && item.shotIds.some(id => wanted.has(id)) : item.assetId === input.assetId
    if (record.operations.some(item => this.active.has(item.id) && overlaps(item))) {
      throw new CreativeError('CREATIVE_SHOT_RUNNING', 409, '该镜头或素材已有正在运行的生成，请查看原任务，不要重复提交。')
    }
    const facts = await this.facts(record)
    if (facts.states.some(item => ['unknown', 'running', 'saving', 'editing'].includes(item.status) && overlaps(item))) {
      throw new CreativeError('CREATIVE_SUBMISSION_UNKNOWN', 409, '该镜头或素材已有结果未知的提交，可能已经计费；请先核对原任务，不会自动重新提交。')
    }
  }

  /**
   * Check exact submission identity and human-request capacity before expensive preparation.
   * Plans associate content; only calls lacking trusted human intent retain the original-shot lock.
   * Begin repeats admission and claims capacity atomically.
   * @param owner - Captured account, chat, and workspace.
   * @param intent - Attribution from the original human request, when available.
   * @param association - Exact optional plan and shots supplied for this invocation.
   * @returns Verified original-request attribution; no operation is created.
   */
  preflightVideoWorkCount(
    owner: CreativeOwner, intent: VideoGenerationIntent | undefined,
    association: Pick<BeginInput, 'planId' | 'shotIds'> = {},
  ): Promise<VideoGenerationIntent> {
    return this.queue(async () => {
      await this.current(owner)
      if (association.planId !== undefined) {
        const record = await this.read(association.planId, owner)
        if (record.owner.workspaceRoot !== owner.workspaceRoot) throw new CreativeError('CREATIVE_ACCESS_DENIED', 404, '该创作项目不属于当前工作区。')
        if (record.kind !== 'video' || association.shotIds === undefined || association.shotIds.length === 0
          || association.shotIds.some(id => !record.shots.some(shot => shot.id === id))) {
          throw new CreativeError('CREATIVE_SHOT_MISMATCH', 400, '请明确指定本次生成对应的计划镜头，镜头数量须与实际分段一致。')
        }
        if (intent === undefined) await this.assertGenerationAvailable(record, association)
        if (intent?.requestedDurationSeconds !== undefined
          && record.shots.every(shot => shot.durationSeconds !== undefined)
          && record.shots.reduce((sum, shot) => sum + (shot.durationSeconds ?? 0), 0) !== intent.requestedDurationSeconds) {
          throw new CreativeError('CREATIVE_VIDEO_INTENT_UNAVAILABLE', 409,
            '创作计划的成片时长与用户明确要求不一致，尚未提交生成；请先按用户要求调整计划。')
        }
      }
      if (intent === undefined) throw new CreativeError('CREATIVE_VIDEO_INTENT_UNAVAILABLE', 409,
        '这次尚未提交生成。请结合前文简短确认是继续原视频还是另做作品；未指定数量时默认一条，无需重述完整需求。')
      await this.assertVideoWorkCount(owner, intent)
      return intent
    })
  }

  /**
   * Record a named invocation before billing; no nearest-project association is allowed.
   * @param owner - Exact captured chat and login.
   * @param input - Trusted entry, actual brief, explicit association, ordered fallback shots and optional prepared-plan revision.
   * @returns Durable invocation identity, also marked process-live until settlement.
   */
  begin(owner: CreativeOwner, input: BeginInput): Promise<CreativeOperation> {
    return this.queue(async () => {
      await this.current(owner)
      let record: CreativeRecord
      if (input.planId !== undefined) {
        record = await this.read(input.planId, owner)
        if (record.owner.workspaceRoot !== owner.workspaceRoot) throw new CreativeError('CREATIVE_ACCESS_DENIED', 404, '该创作项目不属于当前工作区。')
        if (input.expectedRevision !== undefined && creativePlanRevision(record) !== input.expectedRevision) {
          throw new CreativeError('CREATIVE_PLAN_STALE', 409, '创作计划已变化，请刷新后重新生成；尚未提交生成。')
        }
        if (input.assetId !== undefined) {
          if (input.kind !== 'image' || input.shotIds !== undefined
            || !record.assets.some(asset => asset.id === input.assetId && asset.kind === 'image')) {
            throw new CreativeError('CREATIVE_ASSET_MISMATCH', 400, '请指定计划中已有的图片素材，asset_id 与 shot_id 不能同时使用。')
          }
        } else if (record.kind !== input.kind || input.shotIds === undefined || input.shotIds.length !== input.shots.length
          || input.shotIds.some(id => !record.shots.some(shot => shot.id === id))) {
          throw new CreativeError('CREATIVE_SHOT_MISMATCH', 400, '请明确指定本次生成对应的计划镜头，镜头数量须与实际分段一致。')
        }
        if (input.kind !== 'video' || input.videoIntent === undefined) await this.assertGenerationAvailable(record, input)
      } else {
        if (input.shotIds !== undefined || input.assetId !== undefined) throw new CreativeError('CREATIVE_PLAN_REQUIRED', 400, '指定镜头或素材时必须同时指定创作计划。')
        const plan = parseCreativePlan({
          kind: input.kind, title: input.prompt.slice(0, 80), brief: input.prompt, style: '', characters: [], assets: [],
          shots: input.shots.map((shot, index) => ({
            id: `shot_${String(index + 1)}`, order: index + 1, title: String(index + 1), prompt: shot.prompt,
            camera: '', scene: '', action: '', dialogue: '', subtitles: '', characterIds: [], assetIds: [],
            ...shot.durationSeconds === undefined ? {} : { durationSeconds: shot.durationSeconds },
          })),
        })
        record = { ...plan, version: 1, id: `cp_${randomUUID()}` as CreativeProjectId, owner, updatedAt: '', operations: [] }
      }
      if (record.operations.length >= MAX_OPERATIONS) throw new CreativeError('CREATIVE_LIMIT', 400, '该项目的生成记录已达上限，请新建项目。')
      const remainingVideoWorks = input.kind === 'video' && input.videoIntent !== undefined
        ? input.videoIntent.grant.maxWorks - await this.assertVideoWorkCount(owner, input.videoIntent) - 1 : undefined
      const shotIds = input.assetId === undefined ? [...input.shotIds ?? record.shots.map(shot => shot.id)] : []
      unique(shotIds)
      const id = operationId(`op_${randomUUID()}`)
      record.owner = owner
      const invocation: Operation = { id, ...input.source === undefined ? {} : { source: input.source }, prompt: text(input.prompt), shotIds, ...input.assetId === undefined ? {} : { assetId: input.assetId }, status: 'running', outputs: [], ...input.videoProjectId === undefined ? {} : { videoProjectId: input.videoProjectId }, ...input.model === undefined ? {} : { model: text(input.model, 256) },
        ...input.kind !== 'video' || input.videoIntent === undefined ? {} : { requestGrant: { ...input.videoIntent.grant } } }
      record.operations.push(invocation)
      if (Buffer.byteLength(JSON.stringify(record)) > MAX_BYTES / 2) throw new CreativeError('CREATIVE_LIMIT', 400, '项目记录已接近上限，请新建项目；尚未提交生成。')
      await this.persist(record)
      const imageRole = input.kind === 'image' ? operationImageRole(record, input.assetId) : undefined
      const operation = { projectId: record.id, operationId: id, owner, ...imageRole === undefined ? {} : { imageRole },
        ...remainingVideoWorks === undefined ? {} : { remainingVideoWorks },
        outputNaming: operationOutputNaming(record, invocation, input.kind) }
      this.activate(operation, input.kind, input.videoProjectId)
      return operation
    })
  }

  /**
   * Retain possible billing before a single-image or single-video submission.
   * @param operation - Original running invocation; no network request is performed.
   */
  dispatched(operation: CreativeOperation): Promise<void> {
    return this.queue(async () => {
      await this.current(operation.owner)
      const record = await this.read(operation.projectId, operation.owner)
      const found = record.operations.find(item => item.id === operation.operationId)
      if (found === undefined) invalid()
      found.submissionStarted = true
      await this.persist(record)
    })
  }

  /**
   * Retain the original image receipt before polling, without storing credentials or submitting work.
   * @param operation - Exact live invocation and captured account identity.
   * @param received - Validated relative route, backend identity and available task/request ids.
   */
  receipt(operation: CreativeOperation, received: CreativeImageReceipt): Promise<void> {
    return this.queue(async () => {
      await this.current(operation.owner)
      const incoming = imageReceipt(received, operation.owner.sessionId)
      const record = await this.read(operation.projectId, operation.owner)
      if (record.owner.workspaceRoot !== operation.owner.workspaceRoot) throw new CreativeError('CREATIVE_ACCESS_DENIED', 404, '该创作项目不属于当前工作区。')
      const found = record.operations.find(item => item.id === operation.operationId)
      if (found === undefined || found.videoProjectId !== undefined || found.videoReceipt !== undefined) return invalid()
      if (!this.active.has(found.id)) throw new CreativeError('CREATIVE_IMAGE_NOT_RUNNING', 409, '本次图片操作已停止，请查询原任务；不会重新提交生成。')
      found.imageReceipt = mergeImageReceipt(found.imageReceipt, incoming)
      found.submissionStarted = true
      found.model = incoming.model
      await this.persist(record)
    })
  }

  /**
   * Claim one retained image task for query-only recovery under the same account, chat and workspace.
   * @param owner - Current login with the project's original workspace.
   * @param id - Explicit creation project id; no latest-project inference occurs.
   * @param invocationId - Exact retained invocation to query without calling begin or posting again.
   * @returns The exclusively live original invocation, purpose derived from its unchanged plan/material, and nonsecret receipt.
   */
  resumeImage(
    owner: CreativeOwner, id: string, invocationId: string,
  ): Promise<{ operation: CreativeOperation; receipt: CreativeImageReceipt }> {
    return this.queue(async () => {
      await this.current(owner)
      const record = await this.read(id, owner)
      if (record.owner.workspaceRoot !== owner.workspaceRoot) throw new CreativeError('CREATIVE_ACCESS_DENIED', 404, '该创作项目不属于当前工作区。')
      const found = record.operations.find(item => item.id === operationId(invocationId))
      if (found === undefined || found.videoProjectId !== undefined) return invalid()
      if (this.active.has(found.id)) throw new CreativeError('CREATIVE_SHOT_RUNNING', 409, '原图片任务正在处理，请等待当前查询完成。')
      if (found.imageReceipt?.taskId === undefined) throw new CreativeError('CREATIVE_IMAGE_TASK_UNCONFIRMED', 409, '原图片提交尚无可查询任务编号，请保留请求编号并核对；不会重新提交生成。')
      if (found.status === 'completed' || found.status === 'failed' || found.status === 'cancelled') {
        throw new CreativeError('CREATIVE_IMAGE_TASK_SETTLED', 409, '原图片任务已明确结束，请查看保留的结果。')
      }
      record.owner = owner
      found.status = 'running'
      delete found.errorCode
      await this.persist(record)
      const imageRole = operationImageRole(record, found.assetId)
      const operation = { projectId: record.id, operationId: found.id, owner, ...imageRole === undefined ? {} : { imageRole },
        outputNaming: operationOutputNaming(record, found, 'image') }
      this.activate(operation, 'image')
      return { operation, receipt: { ...found.imageReceipt } }
    })
  }

  /**
   * Persist one ordinary video submission before any polling or local cancellation.
   * @param operation - Exact live invocation under the initiating login.
   * @param received - Nonsecret relative route and original task identity.
   */
  videoReceipt(operation: CreativeOperation, received: CreativeVideoReceipt): Promise<void> {
    return this.queue(async () => {
      await this.current(operation.owner)
      const incoming = imageReceipt(received, operation.owner.sessionId)
      const record = await this.read(operation.projectId, operation.owner)
      if (record.owner.workspaceRoot !== operation.owner.workspaceRoot) throw new CreativeError('CREATIVE_ACCESS_DENIED', 404, '该创作项目不属于当前工作区。')
      const found = record.operations.find(item => item.id === operation.operationId)
      if (record.kind !== 'video' || found === undefined || found.videoProjectId !== undefined || found.assetId !== undefined || found.imageReceipt !== undefined) return invalid()
      if (!this.active.has(found.id)) throw new CreativeError('CREATIVE_VIDEO_NOT_RUNNING', 409, '本次视频操作已停止，请查询原任务；不会重新提交生成。')
      found.videoReceipt = mergeImageReceipt(found.videoReceipt, incoming, 'video')
      found.submissionStarted = true
      found.model = incoming.model
      await this.persist(record)
    })
  }

  /**
   * Claim an ordinary retained video for GET-only recovery; manifest projects keep their existing resume path.
   * @param owner - Current login for the original account, chat and workspace.
   * @param id - Explicit original creation project.
   * @param invocationId - Explicit original operation; no new operation is allocated.
   * @returns Exclusively live original operation and its retained task identity.
   */
  resumeVideoTask(
    owner: CreativeOwner, id: string, invocationId: string,
  ): Promise<{ operation: CreativeOperation; receipt: CreativeVideoReceipt }> {
    return this.queue(async () => {
      await this.current(owner)
      const record = await this.read(id, owner)
      if (record.owner.workspaceRoot !== owner.workspaceRoot) throw new CreativeError('CREATIVE_ACCESS_DENIED', 404, '该创作项目不属于当前工作区。')
      const found = record.operations.find(item => item.id === operationId(invocationId))
      if (record.kind !== 'video' || found === undefined || found.videoProjectId !== undefined || found.assetId !== undefined || found.imageReceipt !== undefined) return invalid()
      if (this.active.has(found.id)) throw new CreativeError('CREATIVE_SHOT_RUNNING', 409, '原视频任务正在处理，请等待当前查询完成。')
      if (found.videoReceipt?.taskId === undefined) throw new CreativeError('CREATIVE_VIDEO_TASK_UNCONFIRMED', 409, '原视频提交尚无可查询任务编号，请保留请求编号并核对；不会重新提交生成。')
      if (found.status === 'completed' || found.status === 'failed' || found.status === 'cancelled') throw new CreativeError('CREATIVE_VIDEO_TASK_SETTLED', 409, '原视频任务已明确结束，请查看保留的结果。')
      record.owner = owner
      found.status = 'running'
      delete found.errorCode
      await this.persist(record)
      const operation = { projectId: record.id, operationId: found.id, owner, outputNaming: operationOutputNaming(record, found, 'video') }
      this.activate(operation, 'video')
      return { operation, receipt: { ...found.videoReceipt } }
    })
  }

  /**
   * Reuse exact bytes already retained by this invocation during query-only recovery.
   * @param operation - Exclusively live original invocation with its current login identity.
   * @param bytes - Actual recovered image bytes; record JSON limits do not limit image size.
   * @returns The original saved image path when complete contents match and file identity stays unchanged.
   */
  matchImageOutput(operation: CreativeOperation, bytes: Uint8Array): Promise<string | undefined> {
    return this.matchOutput(operation, bytes, 'image')
  }

  /**
   * Reuse a complete, unchanged video already saved by the original invocation.
   * @param operation - Exclusively live ordinary video recovery operation.
   * @param bytes - Full content returned for the retained original task.
   * @returns Original owned path only after complete byte and identity comparison.
   */
  matchVideoOutput(operation: CreativeOperation, bytes: Uint8Array): Promise<string | undefined> {
    return this.matchOutput(operation, bytes, 'video')
  }

  private matchOutput(operation: CreativeOperation, bytes: Uint8Array, category: CreativeKind): Promise<string | undefined> {
    return this.queue(async () => {
      await this.current(operation.owner)
      const record = await this.read(operation.projectId, operation.owner)
      if (record.owner.workspaceRoot !== operation.owner.workspaceRoot) throw new CreativeError('CREATIVE_ACCESS_DENIED', 404, '该创作项目不属于当前工作区。')
      const found = record.operations.find(item => item.id === operation.operationId)
      if (found === undefined || found.videoProjectId !== undefined
        || category === 'video' && (record.kind !== 'video' || found.assetId !== undefined || found.imageReceipt !== undefined)) return invalid()
      if (!this.active.has(found.id)) throw new CreativeError(category === 'image' ? 'CREATIVE_IMAGE_NOT_RUNNING' : 'CREATIVE_VIDEO_NOT_RUNNING', 409,
        category === 'image' ? '原图片操作未在查询，请先恢复原任务。' : '原视频操作未在查询，请先恢复原任务。')
      if (bytes.byteLength === 0) return undefined
      const buffer = Buffer.alloc(Math.min(64 * 1024, bytes.byteLength))
      for (const output of found.outputs) {
        if (output.kind !== category) continue
        const file = await safeFile(output.path).catch((error: unknown) => {
          if (isMissing(error)) return undefined
          throw error
        })
        if (file === undefined) continue
        try {
          const before = await file.stat({ bigint: true })
          if (before.size !== BigInt(bytes.byteLength)) continue
          let offset = 0
          while (offset < bytes.byteLength) {
            const length = Math.min(buffer.byteLength, bytes.byteLength - offset)
            const { bytesRead } = await file.read(buffer, 0, length, offset)
            if (bytesRead === 0 || !buffer.subarray(0, bytesRead).equals(bytes.subarray(offset, offset + bytesRead))) break
            offset += bytesRead
          }
          if (offset === bytes.byteLength) {
            const after = await file.stat({ bigint: true })
            const named = await lstat(output.path, { bigint: true }).catch((error: unknown) => {
              if (isMissing(error)) return undefined
              throw error
            })
            if (named === undefined || !named.isFile() || [after, named].some(info => info.dev !== before.dev
              || info.ino !== before.ino || info.size !== before.size || info.mtimeNs !== before.mtimeNs
              || info.ctimeNs !== before.ctimeNs) || await realpath(output.path) !== output.path) continue
            await this.current(operation.owner)
            return output.path
          }
        } finally { await file.close() }
      }
      await this.current(operation.owner)
      return undefined
    })
  }

  /**
   * Commit one actual image as soon as it is saved, retaining partial results if later output fails.
   * @param operation - Exact running invocation.
   * @param path - File exclusively published by the generation owner.
   * @param kind - Actual generated media category.
   */
  saved(operation: CreativeOperation, path: string, kind: 'image' | 'video'): Promise<void> {
    return this.queue(async () => {
      await this.current(operation.owner)
      if ((await lstat(path)).isSymbolicLink()) invalid()
      const canonical = await realpath(path)
      const file = await safeFile(canonical)
      try { if ((await file.stat()).size <= 0) invalid() } finally { await file.close() }
      const record = await this.read(operation.projectId, operation.owner)
      const found = record.operations.find(item => item.id === operation.operationId)
      if (found === undefined) invalid()
      if (!found.outputs.some(item => item.path === canonical)) found.outputs.push({ id: outputId(`out_${randomUUID()}`), kind, path: canonical })
      found.status = 'saving'
      await this.persist(record)
    })
  }

  /**
   * Publish only independently saved files from one generation; late account results cannot write.
   * @param operation - Original invocation identity.
   * @param outcome - Actual saved paths or a stable failure state.
   */
  finish(operation: CreativeOperation, outcome: {
    status: CreativeStatus
    paths?: readonly string[]
    kind?: 'image' | 'video'
    errorCode?: string
    previewUnavailable?: boolean
    /** Executor proof that no submission fetch was invoked; it cannot override a retained receipt id. */
    notSubmitted?: true
    /** Final settlement atomically retains any receipt whose earlier standalone write was interrupted. */
    imageReceipt?: CreativeImageReceipt
    videoReceipt?: CreativeVideoReceipt
  }): Promise<void> {
    return this.queue(async () => {
      try {
        await this.current(operation.owner)
        const record = await this.read(operation.projectId, operation.owner)
        const found = record.operations.find(item => item.id === operation.operationId)
        if (found === undefined) invalid()
        if (outcome.imageReceipt !== undefined) {
          if (!this.active.has(found.id) || found.videoProjectId !== undefined
            || found.videoReceipt !== undefined || outcome.videoReceipt !== undefined) invalid()
          found.imageReceipt = mergeImageReceipt(found.imageReceipt, imageReceipt(outcome.imageReceipt, operation.owner.sessionId))
          found.submissionStarted = true
          found.model = found.imageReceipt.model
        }
        if (outcome.videoReceipt !== undefined) {
          if (!this.active.has(found.id) || record.kind !== 'video' || found.videoProjectId !== undefined
            || found.assetId !== undefined || found.imageReceipt !== undefined) invalid()
          found.videoReceipt = mergeImageReceipt(found.videoReceipt, imageReceipt(outcome.videoReceipt, operation.owner.sessionId), 'video')
          found.submissionStarted = true
          found.model = found.videoReceipt.model
        }
        if (outcome.notSubmitted === true) {
          const receipt = found.imageReceipt ?? found.videoReceipt
          if (!this.active.has(found.id) || found.videoProjectId !== undefined || found.outputs.length !== 0
            || receipt !== undefined && (receipt.phase !== 'submitting' || receipt.taskId !== undefined || receipt.requestId !== undefined)) {
            throw new CreativeError(found.videoReceipt === undefined ? 'CREATIVE_IMAGE_RECEIPT_CONFLICT' : 'CREATIVE_VIDEO_RECEIPT_CONFLICT', 409,
              found.videoReceipt === undefined ? '原图片任务已有提交证据，不能将其改为未提交；请核对原任务。' : '原视频任务已有提交证据，不能将其改为未提交；请核对原任务。')
          }
          found.submissionStarted = false
          delete found.imageReceipt
          delete found.videoReceipt
        }
        const outputs: SavedOutput[] = []
        if (outcome.status === 'completed' && (outcome.paths === undefined || outcome.paths.length === 0)) throw new CreativeError('CREATIVE_OUTPUT_REQUIRED', 400, '没有实际保存的产物，不能将生成标记为完成。')
        for (const path of outcome.paths ?? []) {
          if ((await lstat(path)).isSymbolicLink()) invalid()
          const canonical = await realpath(path)
          const file = await safeFile(canonical)
          try { if ((await file.stat()).size <= 0) throw new CreativeError('CREATIVE_MEDIA_UNAVAILABLE', 404, '生成文件为空，尚未作为产物交付。') } finally { await file.close() }
          if (!found.outputs.some(item => item.path === canonical)) outputs.push({ id: outputId(`out_${randomUUID()}`), kind: outcome.kind ?? record.kind, path: canonical, ...outcome.previewUnavailable === undefined ? {} : { previewUnavailable: outcome.previewUnavailable } })
        }
        found.status = outcome.status === 'cancelled' && (found.submissionStarted === true || found.imageReceipt !== undefined || found.videoReceipt !== undefined)
          ? 'unknown' : outcome.status
        found.outputs.push(...outputs)
        if (outcome.errorCode !== undefined) found.errorCode = outcome.errorCode
        else if (found.status === 'completed') delete found.errorCode
        await this.persist(record)
      } finally { this.deactivate(operation) }
    })
  }

  /**
   * Mark the end of a manifest-backed run; file/status facts remain owned by its manifest.
   * @param operation - Original generation invocation whose process-local activity ends.
   */
  release(operation: CreativeOperation): void { this.deactivate(operation) }

  /**
   * Reattach an explicitly resumed retained video to its original creation record.
   * @param owner - Same account/chat/workspace with its current login generation.
   * @param manifest - Already ownership-checked original video record.
   * @returns Reused operation, or a minimal record for a legacy video project.
   */
  async resumeVideo(owner: CreativeOwner, manifest: VideoProjectManifest): Promise<CreativeOperation> {
    await this.serial
    const entries = await readdir(await this.root())
    if (entries.length > MAX_PROJECTS) throw new CreativeError('CREATIVE_LIMIT', 503, '创作记录数量过多，请联系管理员整理本机记录。')
    for (const id of entries) {
      if (!/^cp_[a-f0-9-]{36}$/u.test(id)) continue
      let record: CreativeRecord
      try { record = await this.read(id, owner) } catch (error) { if (error instanceof CreativeError && error.code === 'CREATIVE_ACCESS_DENIED') continue; throw error }
      const operation = record.operations.find(item => item.videoProjectId === manifest.id)
      if (operation === undefined) continue
      return this.queue(async () => {
        const latest = await this.read(id, owner)
        const linked = latest.operations.find(item => item.videoProjectId === manifest.id)
        if (linked === undefined || latest.owner.workspaceRoot !== owner.workspaceRoot) {
          throw new CreativeError('CREATIVE_ACCESS_DENIED', 404, '该创作项目不属于当前工作区。')
        }
        latest.owner = owner
        await this.persist(latest)
        const resumed = { projectId: latest.id, operationId: linked.id, owner }
        this.activate(resumed, 'video', manifest.id)
        return resumed
      })
    }
    if (manifest.status === 'prepared' && manifest.segments.every(segment => segment.taskId === undefined && segment.path === undefined)) {
      throw new CreativeError('CREATIVE_VIDEO_INTENT_UNAVAILABLE', 409,
        '该未提交项目没有已确认的生成许可，已停止新增生成；需要新视频时请明确提出请求，不会通过恢复项目绕过作品数量限制。')
    }
    return this.begin(owner, { kind: 'video', source: 'chat', prompt: manifest.input.prompt, shots: manifest.segments.map(segment => ({ prompt: segment.prompt, durationSeconds: segment.durationSeconds })), videoProjectId: manifest.id })
  }

  /**
   * Retain extracted frames independently from the main generation outcome.
   * @param operation - Exact original invocation.
   * @param path - Actual saved video.
   * @param build - Session-sandboxed frame extraction; a failure becomes previewUnavailable.
   * @param suppliedOutputId - Manifest-backed output id; otherwise identifies the saved invocation output by path.
   */
  async preview(
    operation: CreativeOperation, path: string,
    build: () => Promise<readonly { path: string; timeSeconds: number }[]>, suppliedOutputId?: string,
  ): Promise<void> {
    await this.current(operation.owner)
    if ((await lstat(path)).isSymbolicLink()) invalid()
    const canonical = await realpath(path)
    let frames: { path: string; timeSeconds: number }[] | undefined
    try {
      frames = [...await build()]
      if (frames.length === 0 || frames.length > 6) invalid()
      for (const frame of frames) {
        if ((await lstat(frame.path)).isSymbolicLink()) invalid()
        frame.path = await realpath(frame.path)
        const file = await safeFile(frame.path); await file.close()
      }
    } catch (error) {
      // Frame extraction has no generation authority; only this optional preview is unavailable.
      void error
      frames = undefined
    }
    await this.queue(async () => {
      await this.current(operation.owner)
      const record = await this.read(operation.projectId, operation.owner)
      const found = record.operations.find(item => item.id === operation.operationId)
      if (found === undefined) invalid()
      let output = found.outputs.find(item => suppliedOutputId === undefined ? item.path === canonical : item.id === suppliedOutputId)
      if (output === undefined) {
        if (suppliedOutputId === undefined) invalid()
        output = { id: outputId(suppliedOutputId), kind: 'video', path: canonical }
        found.outputs.push(output)
      }
      if (frames !== undefined) { output.frames = frames; delete output.previewUnavailable }
      else output.previewUnavailable = true
      await this.persist(record)
    })
  }

  private mediaUrl(record: CreativeRecord, id: string, frame?: number): string {
    const query = new URLSearchParams({ session_id: record.owner.sessionId, project_id: record.id, output_id: id })
    if (frame !== undefined) query.set('frame', String(frame))
    return '/credits/api/creative/media?' + query.toString()
  }

  private outputView(record: CreativeRecord, output: SavedOutput): CreativeOutput {
    const frames = output.frames?.map((frame, index) => ({ url: this.mediaUrl(record, output.id, index), timeSeconds: frame.timeSeconds }))
    const first = frames?.[0]
    return {
      id: output.id, kind: output.kind, name: basename(output.path), url: this.mediaUrl(record, output.id),
      ...first === undefined || frames === undefined ? {} : { frames, posterUrl: first.url },
      ...output.previewUnavailable === undefined ? {} : { previewUnavailable: output.previewUnavailable },
    }
  }

  private async facts(record: CreativeRecord): Promise<CreationFacts> {
    const shots = new Map<string, ShotFacts[]>()
    const assets = new Map<string, ShotFacts[]>()
    const outputs: SavedOutput[] = []
    const errors: string[] = []
    const states: CreationFacts['states'] = []
    const tasks: CreationFacts['tasks'] = []
    let publicationErrorCode: CreationFacts['publicationErrorCode']
    let updatedAt = record.updatedAt
    const task = (operation: Operation, state: CreativeStatus, saved: readonly SavedOutput[], completedShots: number,
      totalShots: number, model?: string, errorCode?: string): void => {
      tasks.push({
        id: operation.id, status: state, shotIds: [...operation.shotIds],
        ...operation.source === undefined ? {} : { source: operation.source },
        outputs: [...new Map(saved.map(output => [output.id, output])).values()],
        completedShots, totalShots,
        ...operation.assetId === undefined ? {} : { assetId: operation.assetId },
        ...model === undefined ? {} : { model },
        ...operation.videoProjectId === undefined ? {} : { videoProjectId: operation.videoProjectId },
        ...errorCode === undefined ? {} : { errorCode },
        ...operation.imageReceipt === undefined ? {} : {
          imageReceipt: { ...operation.imageReceipt },
          canQuery: operation.imageReceipt.taskId !== undefined && !this.active.has(operation.id)
            && state !== 'completed' && state !== 'failed' && state !== 'cancelled',
        },
        ...operation.videoReceipt === undefined ? {} : {
          videoReceipt: { ...operation.videoReceipt },
          canQuery: operation.videoReceipt.taskId !== undefined && !this.active.has(operation.id)
            && state !== 'completed' && state !== 'failed' && state !== 'cancelled',
        },
      })
    }
    const add = (id: string, state: CreativeStatus, result: SavedOutput[], durationSeconds?: number): void => {
      const items = shots.get(id) ?? []
      items.push({ status: state, outputs: result, ...durationSeconds === undefined ? {} : { durationSeconds } })
      shots.set(id, items)
    }
    for (const operation of record.operations) {
      if (operation.errorCode !== undefined) errors.push(operation.errorCode)
      if (operation.videoProjectId === undefined) {
        const state = (operation.status === 'running' || operation.status === 'saving') && !this.active.has(operation.id)
          ? operation.submissionStarted ? 'unknown' : 'interrupted' : operation.status
        states.push({ shotIds: operation.shotIds, status: state, ...operation.assetId === undefined ? {} : { assetId: operation.assetId } })
        task(operation, state, operation.outputs, state === 'completed' ? operation.shotIds.length : 0, operation.shotIds.length,
          operation.model, state === 'unknown' ? 'SUBMISSION_UNKNOWN' : operation.errorCode)
        outputs.push(...operation.outputs)
        if (operation.assetId !== undefined) {
          const items = assets.get(operation.assetId) ?? []
          items.push({ status: state, outputs: operation.outputs }); assets.set(operation.assetId, items)
          continue
        }
        operation.shotIds.forEach((id) => { add(id, state, operation.outputs) })
        continue
      }
      const video = await this.options.video(operation.videoProjectId, record.owner)
      if (video.segments.length !== operation.shotIds.length) invalid()
      if (video.failureCode !== undefined) errors.push(video.failureCode)
      if (video.publicationErrorCode !== undefined) publicationErrorCode = video.publicationErrorCode
      const live = this.active.has(operation.id)
      const state = video.failureCode === 'SUBMISSION_UNKNOWN' ? 'unknown' : video.status === 'prepared' ? 'planned' : (video.status === 'running' || video.status === 'editing') && !live ? 'interrupted' : video.status
      states.push({ shotIds: operation.shotIds, status: state })
      if (video.updatedAt > updatedAt) updatedAt = video.updatedAt
      const generated: SavedOutput[] = []
      for (const [index, segment] of video.segments.entries()) {
        const shotId = operation.shotIds[index]
        if (shotId === undefined) invalid()
        const state: CreativeStatus = segment.status === 'saved' ? 'completed' : segment.status === 'unknown' || segment.status === 'submitting' && segment.taskId === undefined && !this.active.has(operation.id) ? 'unknown' : segment.status === 'failed' ? 'failed' : segment.status === 'pending' ? 'planned' : !this.active.has(operation.id) ? 'interrupted' : 'running'
        const id = outputId(`${operation.id}_clip_${String(index + 1)}`)
        const saved: SavedOutput[] = segment.path === undefined ? [] : [{ ...operation.outputs.find(output => output.id === id),
          id, kind: 'video', path: segment.publishedPath ?? segment.path }]
        generated.push(...saved)
        add(shotId, state, saved, segment.durationSeconds)
      }
      if (video.finalPath !== undefined && video.status === 'completed') {
        const id = outputId(`${operation.id}_final`)
        generated.push({ id, kind: 'video', path: video.finalPath, ...operation.outputs.find(output => output.id === id) })
      }
      outputs.push(...generated)
      task(operation, state, generated, video.segments.filter(segment => segment.status === 'saved').length,
        video.segments.length, video.model, video.publicationErrorCode ?? video.failureCode ?? operation.errorCode)
    }
    return { shots, assets, outputs: uniqueOutputs(outputs), errors, states, tasks, updatedAt,
      ...publicationErrorCode === undefined ? {} : { publicationErrorCode } }
  }

  /**
   * List only the captured account's projects in the requested chat, including restart-safe facts.
   * @param owner - Current account and requested exact session id.
   * @returns Credential-free creation projections; private provider requests are excluded.
   */
  async projects(owner: Pick<CreativeOwner, 'accountId' | 'sessionId'>): Promise<CreativeProjectView[]> {
    await this.serial
    let entries: string[]
    try { entries = await readdir(await this.root()) } catch (error) { if (isMissing(error)) return []; throw error }
    if (entries.length > MAX_PROJECTS) throw new CreativeError('CREATIVE_LIMIT', 503, '创作记录数量过多，请联系管理员整理本机记录。')
    const result: CreativeProjectView[] = []
    let bytes = 2
    for (const id of entries) {
      if (!/^cp_[a-f0-9-]{36}$/u.test(id)) continue
      let record: CreativeRecord
      try { record = await this.read(id, owner) } catch (error) { if (error instanceof CreativeError && error.code === 'CREATIVE_ACCESS_DENIED') continue; throw error }
      const facts = await this.facts(record)
      const shots = record.shots.map((shot): CreativeShotView => {
        const operations = facts.shots.get(shot.id) ?? []
        const actualDurationSeconds = operations.at(-1)?.durationSeconds
        return {
          ...shot, ...actualDurationSeconds === undefined ? {} : { actualDurationSeconds }, status: operations.at(-1)?.status ?? 'planned',
          outputs: uniqueOutputs(operations.flatMap(item => item.outputs)).map(output => this.outputView(record, output)),
        }
      })
      const latest = new Map<string, number>()
      facts.states.forEach((state, index) => {
        if (state.assetId !== undefined) latest.set('asset:' + state.assetId, index)
        else state.shotIds.forEach((id) => { latest.set('shot:' + id, index) })
      })
      const currentStates = facts.states.filter((state, index) => state.status === 'unknown'
        || (state.assetId === undefined ? state.shotIds.some(id => latest.get('shot:' + id) === index) : latest.get('asset:' + state.assetId) === index))
      const projectStatus = aggregate([...shots.map(shot => shot.status), ...currentStates.map(item => item.status)])
      const errorCode = projectStatus === 'unknown' ? 'SUBMISSION_UNKNOWN' : facts.publicationErrorCode
        ?? (projectStatus === 'failed' || projectStatus === 'cancelled' ? facts.errors.at(-1) : undefined)
      result.push({
        id: record.id, sessionId: record.owner.sessionId, planRevision: creativePlanRevision(record), kind: record.kind,
        title: record.title, brief: record.brief, style: record.style, updatedAt: facts.updatedAt,
        completedShots: shots.filter(shot => shot.status === 'completed').length, totalShots: shots.length,
        characters: record.characters, assets: record.assets.map((asset) => {
          const history = facts.assets.get(asset.id)
          const referenceUrl = asset.kind === 'image' && asset.sourcePathOrAssetId.startsWith('ma_')
            ? '/credits/api/creative/reference?' + new URLSearchParams({ session_id: record.owner.sessionId, project_id: record.id, asset_id: asset.id }).toString()
            : undefined
          return {
            ...asset, ...referenceUrl === undefined ? {} : { referenceUrl },
            ...history === undefined ? {} : {
              status: history.at(-1)?.status ?? 'planned',
              outputs: uniqueOutputs(history.flatMap(item => item.outputs)).map(output => this.outputView(record, output)),
            },
          }
        }), shots, outputs: facts.outputs.map(output => this.outputView(record, output)),
        tasks: facts.tasks.map(task => ({ ...task, outputs: task.outputs.map(output => this.outputView(record, output)) })),
        status: projectStatus, ...errorCode === undefined ? {} : { errorCode },
      })
      bytes += Buffer.byteLength(JSON.stringify(result[result.length - 1])) + 1
      if (bytes > MAX_LIST_BYTES) throw new CreativeError('CREATIVE_LIMIT', 503, '当前聊天的创作记录过大，请联系管理员整理本机记录。')
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * Read only a real generated image already retained by this explicit account/chat project.
   * @param owner - Current captured caller login and workspace.
   * @param id - Explicit creation plan id.
   * @param requested - Logged generated output path or opaque output id; never a new source-file permission.
   * @returns Bounded image bytes and recorded path, or undefined when this project owns no such output.
   */
  async imageReference(
    owner: CreativeOwner, id: string, requested: string,
  ): Promise<{ path: string; bytes: Buffer } | undefined> {
    await this.serial
    await this.current(owner)
    const record = await this.read(id, owner)
    if (record.owner.workspaceRoot !== owner.workspaceRoot) throw new CreativeError('CREATIVE_ACCESS_DENIED', 404, '该素材不属于当前工作区。')
    const facts = await this.facts(record)
    const outputs = [
      ...facts.outputs, ...[...facts.shots.values(), ...facts.assets.values()].flatMap(items => items.flatMap(item => item.outputs)),
    ]
    const output = outputs.find(item => item.kind === 'image' && (item.id === requested || item.path === requested))
    if (output === undefined) return undefined
    const file = await safeFile(output.path)
    try {
      const size = (await file.stat()).size
      if (size <= 0 || size > 6 * 1024 * 1024) throw new CreativeError('CREATIVE_REFERENCE_TOO_LARGE', 400, '图片参考须为 6 MiB 以内的已保存文件。')
      const bytes = await file.readFile()
      await this.current(owner)
      return { path: output.path, bytes }
    } finally { await file.close() }
  }

  /**
   * Serve a recorded generated file or extracted frame after account/chat lookup.
   * @param request - Authenticated Host request; supports one standard byte range.
   * @param response - Response receiving only recorded local bytes.
   * @param owner - Captured product account, login generation and exact requested chat; rechecked before response headers.
   * @param id - Explicit project id.
   * @param outputId - Published output id, never a filesystem path.
   * @param frame - Optional nonnegative extracted-frame index.
   */
  async serve(
    request: IncomingMessage, response: ServerResponse, owner: Pick<CreativeOwner, 'accountId' | 'sessionId' | 'sessionFingerprint'>,
    id: string, outputId: string, frame?: number,
  ): Promise<void> {
    await this.serial
    await this.current(owner)
    const record = await this.read(id, owner)
    const facts = await this.facts(record)
    const saved = [
      ...facts.outputs, ...[...facts.shots.values(), ...facts.assets.values()].flatMap(items => items.flatMap(item => item.outputs)),
    ]
    const output = saved.find(output => output.id === outputId)
    if (output === undefined || frame !== undefined && (!Number.isSafeInteger(frame) || frame < 0)) throw new CreativeError('CREATIVE_MEDIA_UNAVAILABLE', 404, '该创作产物暂时无法读取。')
    const path = frame === undefined ? output.path : output.frames?.[frame]?.path
    if (path === undefined) throw new CreativeError('CREATIVE_MEDIA_UNAVAILABLE', 404, '预览帧暂时不可用。')
    const file = await safeFile(path)
    try {
      const info = await file.stat()
      await this.current(owner)
      const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' }
      response.setHeader('content-type', types[extname(path).toLowerCase()] ?? 'application/octet-stream')
      response.setHeader('x-content-type-options', 'nosniff')
      response.setHeader('cache-control', 'no-store')
      response.setHeader('accept-ranges', 'bytes')
      let start = 0; let end = info.size - 1
      const range = request.headers.range
      if (range !== undefined) {
        const parsed = /^bytes=(\d*)-(\d*)$/u.exec(range)
        if (parsed === null || parsed[1] === '' && parsed[2] === '') { response.writeHead(416, { 'content-range': `bytes */${String(info.size)}` }); response.end(); return }
        if (parsed[1] === '') { const suffix = Number(parsed[2]); start = Math.max(0, info.size - suffix) }
        else { start = Number(parsed[1]); end = parsed[2] === '' ? end : Math.min(end, Number(parsed[2])) }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= info.size) { response.writeHead(416, { 'content-range': `bytes */${String(info.size)}` }); response.end(); return }
        response.statusCode = 206
        response.setHeader('content-range', `bytes ${String(start)}-${String(end)}/${String(info.size)}`)
      }
      response.setHeader('content-length', String(Math.max(0, end - start + 1)))
      if (request.method === 'HEAD') { response.end(); return }
      const stream = file.createReadStream({ start, end, autoClose: false })
      await new Promise<void>((complete, reject) => {
        const close = (): void => { stream.destroy(); complete() }
        response.once('close', close)
        stream.once('error', reject)
        stream.once('end', () => { response.off('close', close); complete() })
        stream.pipe(response)
      })
    } finally { await file.close() }
  }
}

/** Node filesystem missing-file errors are expected before the first project. */
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
