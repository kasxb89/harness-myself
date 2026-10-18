/** Validated, account-authorized reads of retained chat creation projects. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type {
  CreativeAssetView, CreativeCharacter, CreativeOutput, CreativeProjectView, CreativeProjectsPayload,
  CreativeShotView, CreativeStatus, CreativeTaskView, CreativePlanChange,
} from '@deepseek-ai/dsh-credits-index/src/creative-types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Read failures own no paid or mutating operation. */
export type CreativeReadResult =
  | { readonly ok: true; readonly payload: CreativeProjectsPayload }
  | { readonly ok: false; readonly code: 'signed-out' | 'unavailable' | 'invalid' }

/** One cancellable, explicitly Session-scoped project read. */
export type ReadCreativeProjects = (sessionId: SessionId, signal: AbortSignal) => Promise<CreativeReadResult>

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function text(value: unknown): value is string { return typeof value === 'string' }
function texts(value: unknown): value is string[] { return Array.isArray(value) && value.every(text) }
function status(value: unknown): value is CreativeStatus {
  return typeof value === 'string' && ['planned', 'running', 'saving', 'editing', 'completed', 'failed',
    'cancelled', 'interrupted', 'unknown'].includes(value)
}
function media(value: unknown, sessionId: SessionId, projectId: string, outputId: string): value is string {
  if (typeof value !== 'string' || !value.startsWith('/credits/api/creative/media?')) return false
  try {
    const parsed = new URL(value, 'https://creative.invalid')
    const query = parsed.searchParams
    const frame = query.get('frame')
    return parsed.origin === 'https://creative.invalid' && parsed.pathname === '/credits/api/creative/media'
      && parsed.hash === '' && parsed.username === '' && parsed.password === ''
      && query.getAll('session_id').length === 1 && query.get('session_id') === sessionId
      && query.getAll('project_id').length === 1 && query.get('project_id') === projectId
      && query.getAll('output_id').length === 1 && query.get('output_id') === outputId
      && query.getAll('frame').length <= 1 && (frame === null || /^(?:0|[1-9]\d*)$/u.test(frame))
  } catch (_invalidUrl) { return false }
}
function output(value: unknown, sessionId: SessionId, projectId: string): value is CreativeOutput {
  if (!record(value) || !text(value.id)) return false
  const id = value.id
  return text(value.name) && text(value.kind) && ['image', 'video', 'audio'].includes(value.kind)
    && media(value.url, sessionId, projectId, id)
    && (value.posterUrl === undefined || media(value.posterUrl, sessionId, projectId, id))
    && (value.previewUnavailable === undefined || typeof value.previewUnavailable === 'boolean')
    && (value.frames === undefined || Array.isArray(value.frames) && value.frames.every(frame => record(frame)
      && media(frame.url, sessionId, projectId, id)
      && typeof frame.timeSeconds === 'number' && Number.isFinite(frame.timeSeconds) && frame.timeSeconds >= 0))
}
function character(value: unknown): value is CreativeCharacter {
  return record(value) && ['id', 'name', 'appearance', 'clothing', 'personality', 'voice'].every(key => text(value[key]))
    && texts(value.referenceAssetIds)
}
function reference(value: unknown, sessionId: SessionId, projectId: string, assetId: unknown): boolean {
  if (typeof value !== 'string' || !value.startsWith('/credits/api/creative/reference?')) return false
  try {
    const parsed = new URL(value, 'https://creative.invalid')
    return parsed.origin === 'https://creative.invalid' && parsed.pathname === '/credits/api/creative/reference'
      && parsed.hash === '' && parsed.searchParams.getAll('session_id').length === 1
      && parsed.searchParams.get('session_id') === sessionId && parsed.searchParams.getAll('project_id').length === 1
      && parsed.searchParams.get('project_id') === projectId && parsed.searchParams.getAll('asset_id').length === 1
      && parsed.searchParams.get('asset_id') === assetId
  } catch (_invalidReference) { return false }
}
function asset(value: unknown, sessionId: SessionId, projectId: string): value is CreativeAssetView {
  return record(value) && ['id', 'name', 'role', 'description', 'sourcePathOrAssetId'].every(key => text(value[key]))
    && text(value.kind) && ['image', 'video', 'audio', 'document', 'other'].includes(value.kind)
    && (value.status === undefined || status(value.status))
    && (value.referenceUrl === undefined || reference(value.referenceUrl, sessionId, projectId, value.id))
    && (value.outputs === undefined || Array.isArray(value.outputs) && value.outputs.every(item => output(item, sessionId, projectId)))
}
function shot(value: unknown, sessionId: SessionId, projectId: string): value is CreativeShotView {
  return record(value) && ['id', 'title', 'camera', 'scene', 'action', 'prompt', 'dialogue', 'subtitles'].every(key => text(value[key]))
    && typeof value.order === 'number' && Number.isSafeInteger(value.order) && value.order >= 0
    && (value.durationSeconds === undefined || typeof value.durationSeconds === 'number'
      && Number.isFinite(value.durationSeconds) && value.durationSeconds > 0)
    && (value.actualDurationSeconds === undefined || typeof value.actualDurationSeconds === 'number'
      && Number.isFinite(value.actualDurationSeconds) && value.actualDurationSeconds > 0)
    && texts(value.characterIds) && texts(value.assetIds) && status(value.status)
    && Array.isArray(value.outputs) && value.outputs.every(item => output(item, sessionId, projectId))
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function task(value: unknown, sessionId: SessionId, projectId: string): value is CreativeTaskView {
  return record(value) && text(value.id) && status(value.status) && texts(value.shotIds)
    && count(value.completedShots) && count(value.totalShots) && value.completedShots <= value.totalShots
    && ['assetId', 'model', 'videoProjectId', 'errorCode'].every(key => value[key] === undefined || text(value[key]))
    && Array.isArray(value.outputs) && value.outputs.every(item => output(item, sessionId, projectId))
}
function project(value: unknown, sessionId: SessionId): value is CreativeProjectView {
  if (!record(value) || !text(value.id)) return false
  const id = value.id
  return ['title', 'brief', 'style', 'updatedAt', 'planRevision'].every(key => text(value[key]))
    && value.sessionId === sessionId && count(value.completedShots) && count(value.totalShots)
    && value.completedShots <= value.totalShots
    && Array.isArray(value.tasks) && value.tasks.every(item => task(item, sessionId, id))
    && (value.kind === 'image' || value.kind === 'video') && status(value.status)
    && Array.isArray(value.characters) && value.characters.every(character)
    && Array.isArray(value.assets) && value.assets.every(item => asset(item, sessionId, id))
    && Array.isArray(value.shots) && value.shots.every(item => shot(item, sessionId, id))
    && Array.isArray(value.outputs) && value.outputs.every(item => output(item, sessionId, id))
    && (value.errorCode === undefined || text(value.errorCode))
}

/**
 * Read retained plans and real files; reject malformed data and arbitrary media destinations.
 * @param sessionId - Conversation whose explicitly registered projects are requested.
 * @param signal - Owner cancellation for hiding, switching, logout or disposal.
 * @returns A validated account-owned listing or a localizable read failure.
 */
export const readCreativeProjects: ReadCreativeProjects = async (sessionId, signal) => {
  try {
    const response = await fetch(`/credits/api/creative/projects?${new URLSearchParams({ session_id: sessionId })}`, {
      signal, credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
    })
    if (response.status === 401) return { ok: false, code: 'signed-out' }
    const value: unknown = await response.json()
    if (!response.ok) return { ok: false, code: 'unavailable' }
    if (!record(value) || value.ok !== true || !record(value.payload) || !text(value.payload.accountId)
      || !Array.isArray(value.payload.projects) || !value.payload.projects.every(item => project(item, sessionId))) {
      return { ok: false, code: 'invalid' }
    }
    return { ok: true, payload: { accountId: value.payload.accountId, projects: value.payload.projects } }
  } catch (_readFailed) { return { ok: false, code: 'unavailable' } }
}

/** Free plan-edit outcome; ambiguous mutations must not be automatically retried. */
export type CreativeSaveResult = CreativeReadResult | {
  readonly ok: false
  readonly code: 'stale' | 'rejected'
}

/** Browser-safe CAS request owned by the authoritative project controller. */
export interface CreativePlanRequest {
  readonly sessionId: SessionId
  readonly projectId: string
  readonly expectedRevision: string
  readonly change: CreativePlanChange
}

/**
 * Save structured directions only; this endpoint never starts media generation.
 * @param request - captured revision and explicitly addressed plan change.
 * @param signal - editor and account lifetime cancellation.
 * @returns a validated current listing or a failure without automatic retry.
 */
export async function saveCreativePlan(request: CreativePlanRequest, signal: AbortSignal): Promise<CreativeSaveResult> {
  try {
    const response = await fetch('/credits/api/creative/plan', {
      method: 'POST', signal, credentials: 'same-origin', cache: 'no-store',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: request.sessionId, project_id: request.projectId,
        expected_revision: request.expectedRevision, change: request.change }),
    })
    if (response.status === 401) return { ok: false, code: 'signed-out' }
    const value: unknown = await response.json()
    if (response.status === 409 && record(value) && value.code === 'CREATIVE_PLAN_STALE') return { ok: false, code: 'stale' }
    if (!response.ok) return { ok: false, code: 'rejected' }
    if (!record(value) || value.ok !== true || !record(value.payload) || !text(value.payload.accountId)
      || !Array.isArray(value.payload.projects) || !value.payload.projects.every(item => project(item, request.sessionId))) {
      return { ok: false, code: 'invalid' }
    }
    return { ok: true, payload: { accountId: value.payload.accountId, projects: value.payload.projects } }
  } catch (_saveFailed) { return { ok: false, code: 'unavailable' } }
}

/** Upload result contains an opaque material id, never a provider URL. */
export type CreativeUploadResult =
  | { readonly ok: true; readonly assetId: string; readonly kind: 'image' | 'video' | 'audio' }
  | { readonly ok: false }

/**
 * Upload a real source file through the existing authenticated material endpoint.
 * @param file - nonempty supported material of at most 32 MB.
 * @param signal - editor and account lifetime cancellation.
 * @returns an opaque material id or an upload failure.
 */
export async function uploadCreativeAsset(file: File, signal: AbortSignal): Promise<CreativeUploadResult> {
  const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video'
    : file.type.startsWith('audio/') ? 'audio' : null
  if (kind === null || file.size === 0 || file.size > 32 * 1024 * 1024) return { ok: false }
  try {
    const response = await fetch('/credits/api/assets', {
      method: 'POST', signal, credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': file.type, 'x-file-name': encodeURIComponent(file.name),
        'x-idempotency-key': `yunshu-asset-${randomUUID()}`, accept: 'application/json' }, body: file,
    })
    const value: unknown = await response.json()
    if (!response.ok || !record(value) || value.ok !== true || !record(value.asset)
      || typeof value.asset.assetId !== 'string' || !/^ma_[A-Za-z0-9_-]+$/u.test(value.asset.assetId)) return { ok: false }
    return { ok: true, assetId: value.asset.assetId, kind }
  } catch (_uploadFailed) { return { ok: false } }
}
