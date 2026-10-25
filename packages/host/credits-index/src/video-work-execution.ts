/** Chat entry adapters for durable work identities and retained original submissions. @module */

import { CreativeError, type CreativeOwner, type CreativeStore } from './creative-store.ts'
import type { VideoGenerationIntent } from './video-generation-intent.ts'
import type { VideoWorkBatch, VideoWorkClaim, VideoWorkClaimResult, VideoWorkStore, VideoWorkView } from './video-work-store.ts'

/** Public tool coordinates contain neither the private claim nonce nor account credentials. */
export interface VideoWorkToolFields {
  work_id: string
  work_request_id: string
  pending_work_ids: string[]
  remaining_works: number
  plan_id?: string
  operation_id?: string
  project_id?: string
}

/**
 * Prepare concrete works without deriving permission or a quota from user wording.
 * @param store - Work identity owner shared by both generation entry points.
 * @param creative - Existing operations used only to adopt the exact source's historical submissions.
 * @param owner - Captured account, chat and workspace.
 * @param intent - Exact logged execution source, independent of creation language.
 * @param count - Number of concrete works to prepare; omitted prepares one.
 * @returns Immutable existing or newly prepared work list; no generation is submitted.
 */
export async function prepareChatVideoWorks(
  store: VideoWorkStore, creative: CreativeStore, owner: CreativeOwner,
  intent: VideoGenerationIntent | undefined, count = 1,
): Promise<VideoWorkBatch> {
  if (intent === undefined) throw new CreativeError('CREATIVE_VIDEO_SOURCE_UNAVAILABLE', 409,
    '当前调用没有可核对的用户来源，尚未提交生成；请在当前聊天中发起创作。')
  const legacy = await creative.videoWorkLinks(owner, intent)
  return store.prepare(owner, intent.grant, count, legacy, intent.humanRevision)
}

/**
 * Append concrete additional works once for a later real human quantity revision.
 * @param store - Durable work-list owner.
 * @param owner - Captured account, chat and workspace.
 * @param intent - Exact execution source and captured real human answer.
 * @param count - Additional finished works requested by that answer.
 * @returns Original and appended works; repeating the answer cannot append again.
 */
export async function appendChatVideoWorks(
  store: VideoWorkStore, owner: CreativeOwner, intent: VideoGenerationIntent | undefined, count: number,
): Promise<VideoWorkBatch> {
  if (intent?.humanRevision === undefined) throw new CreativeError('CREATIVE_VIDEO_SOURCE_UNAVAILABLE', 409,
    '当前调用没有可核对的新用户回答，尚未追加作品；请先核对已有作品清单。')
  return store.append(owner, intent.grant, count, intent.humanRevision)
}

/**
 * Claim one prepared work before any expensive preparation, reusing its original state on reentry.
 * @param store - Shared durable work identity owner.
 * @param creative - Original operation reader for upgrade continuity.
 * @param owner - Captured account, chat and workspace.
 * @param intent - Logged source of this exact native or inherited PTC execution.
 * @param workId - Existing work id; omission selects the source's default first work.
 * @returns Unique claim or an existing work; a different tool-call id never resets the same work.
 */
export async function claimChatVideoWork(
  store: VideoWorkStore, creative: CreativeStore, owner: CreativeOwner,
  intent: VideoGenerationIntent | undefined, workId?: string,
): Promise<VideoWorkClaimResult> {
  if (intent === undefined) throw new CreativeError('CREATIVE_VIDEO_SOURCE_UNAVAILABLE', 409,
    '当前调用没有可核对的用户来源，尚未提交生成；请在当前聊天中发起创作。')
  if (workId === undefined) await prepareChatVideoWorks(store, creative, owner, intent)
  return store.claim(owner, intent.grant, workId)
}

/**
 * Project a retained work and the concrete work list into model-visible coordinates.
 * @param batch - Existing source-bound list, never a natural-language allowance.
 * @param work - Exact existing work and any original operation association.
 * @returns Safe tool fields for reuse, querying and remaining prepared work scheduling.
 */
export function videoWorkToolFields(batch: VideoWorkBatch, work: VideoWorkView): VideoWorkToolFields {
  const pending = batch.works.filter(item => item.state === 'prepared').map(item => item.workId)
  return { work_id: work.workId, work_request_id: batch.requestId,
    pending_work_ids: pending, remaining_works: pending.length,
    ...work.link === undefined ? {} : { plan_id: work.link.projectId, operation_id: work.link.operationId,
      ...work.link.videoProjectId === undefined ? {} : { project_id: work.link.videoProjectId } } }
}

/**
 * Return the original work instead of creating another project or upstream attempt.
 * @param result - Existing durable work and the current prepared-list snapshot.
 * @returns Readable existing/cancelled state with exact recovery coordinates; no generation is performed.
 */
export function existingVideoWorkResult(result: Extract<VideoWorkClaimResult, { kind: 'existing' }>): VideoWorkToolFields & {
  status: string
  message: string
} {
  return { ...videoWorkToolFields(result.batch, result.work),
    status: result.work.state === 'cancelled' ? 'cancelled' : 'existing',
    message: result.work.state === 'cancelled' ? '这个作品已取消，未重新提交。另做作品时请按新的用户请求准备作品编号。'
      : result.work.link === undefined ? '这个作品已有准备登记，本次未创建第二份任务或重复提交。请先核对原调用；若客户端已重启或原调用已中断，这条准备记录不会自动重跑，请由用户另行发起新的创作请求。'
        : result.work.link.videoProjectId === undefined
          ? '这个作品已有原始生成记录，未重复提交。请用原 plan_id 和 operation_id 调用 query_video_task 核对。'
          : '这个作品已有原始视频项目，未重复提交。请用原 project_id 调用 video_project_status 或 resume_video_project。' }
}

/**
 * Settle a preparation owned by this call without replacing its outcome during a login transition.
 * @param store - Durable work owner.
 * @param claim - Exact process-private claim from this execution.
 * @param cancelled - Preserve a real cancellation; otherwise release only an unlinked preparation.
 */
export async function settleVideoWorkPreparation(store: VideoWorkStore, claim: VideoWorkClaim, cancelled = false): Promise<void> {
  try {
    if (cancelled) await store.cancel(claim)
    else await store.release(claim)
  } catch (error) {
    // A changed login cannot clear the original claim; retaining it still prevents a second submission.
    if (error instanceof CreativeError && error.code === 'CREATIVE_ACCOUNT_CHANGED') return
    throw error
  }
}
