/** Display-only classification for fixed media workflow failures. */
import { productFailureKind, type ProductFailureKind } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'

const MEDIA_TOOLS = new Set([
  'generate_image', 'generate_video', 'generate_video_project', 'edit_video', 'assemble_video',
  'video_project_status', 'resume_video_project', 'get_creation_plan', 'update_creation_plan', 'query_image_task', 'query_video_task',
])

// These receipts cannot establish a safe new paid submission. A failed project
// save can also precede dispatch, so the copy must not claim that charging occurred.
const UNKNOWN_OUTCOME_CODES = new Set([
  'SUBMISSION_UNKNOWN', 'CREATIVE_SUBMISSION_UNKNOWN', 'CREATIVE_OUTCOME_UNKNOWN',
  'PROJECT_STORAGE_FAILED', 'TIMEOUT', 'TRANSPORT', 'NO_TASK_ID',
])

type MediaFailure = ProductFailureKind | 'unknown-outcome' | 'accepted-pending' | 'accepted-queued'
  | 'model-parameters' | 'plan-parameters' | 'video-count-limit' | 'video-intent-unavailable'
  | 'video-quote-unavailable' | 'video-quote-changed' | 'video-choice-unavailable'

const PARAMETER_FAILURES = new Set([
  'DURATION_NOT_SUPPORTED', 'SHOT_DURATION_UNSUPPORTED', 'SHOT_DURATION_MISMATCH', 'SHOT_COUNT_MISMATCH',
  'AUDIO_NOT_SUPPORTED', 'RESOLUTION_NOT_SUPPORTED', 'RATIO_NOT_SUPPORTED', 'PARAMETER_NOT_SUPPORTED',
  'REFERENCES_NOT_SUPPORTED', 'MIX_NOT_SUPPORTED', 'MODE_NOT_SUPPORTED', 'SEED_NOT_SUPPORTED',
])

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function planParameterFailure(toolName: string, code: unknown): boolean {
  return toolName === 'update_creation_plan' && (code === 'INVALID_ARGS' || code === 'CREATIVE_INVALID')
}

function videoIntentFailure(toolName: string, code: unknown): 'video-count-limit' | 'video-intent-unavailable'
  | 'video-quote-unavailable' | 'video-quote-changed' | 'video-choice-unavailable' | null {
  const generation = toolName === 'generate_video' || toolName === 'generate_video_project'
  if (!generation && toolName !== 'resume_video_project') return null
  if (generation && code === 'CREATIVE_VIDEO_COUNT_LIMIT') return 'video-count-limit'
  if (generation && code === 'CREATIVE_VIDEO_INTENT_UNAVAILABLE') return 'video-intent-unavailable'
  if (code === 'CREATIVE_VIDEO_QUOTE_UNAVAILABLE') return 'video-quote-unavailable'
  if (code === 'CREATIVE_VIDEO_QUOTE_CHANGED') return 'video-quote-changed'
  return code === 'CREATIVE_VIDEO_MODEL_CHOICE_UNAVAILABLE' ? 'video-choice-unavailable' : null
}

/**
 * Recognize explicit media failures without rewriting model-visible results.
 * @param toolName - Exact native workflow tool name.
 * @param block - Original current call or settled result.
 * @returns A safe failure category, or null for confirmed success, ordinary in-flight and unrelated calls.
 */
export function mediaFailure(toolName: string, block: ToolCallBlock): MediaFailure | null {
  if (!MEDIA_TOOLS.has(toolName) || !('kind' in block)) return null
  if (block.isError && block.error?.name === 'AutoReviewDeniedError' && block.error.code === 'AUTO_REVIEW_DENIED') return null
  if (block.isError && typeof block.error?.code === 'string' && UNKNOWN_OUTCOME_CODES.has(block.error.code)) return 'unknown-outcome'
  for (const content of block.content) {
    if (content.type !== 'text') continue
    let value: unknown
    try { value = JSON.parse(content.text) } catch (_error) { continue }
    if (!record(value)) continue
    if (value.status === 'unauthorized') return 'sign-in'
    if (value.submission_state === 'unknown') return 'unknown-outcome'
    if (value.code === 'VIDEO_QUEUE_WAITING' && value.submission_state === 'pending'
      && typeof value.task_id === 'string' && value.task_id.trim() !== '') return 'accepted-queued'
    if (value.code === 'VIDEO_TASK_TIMEOUT' && Array.isArray(value.task_ids)
      && value.task_ids.some(id => typeof id === 'string' && id.trim() !== '')) return 'accepted-pending'
    if (value.submission_state !== 'failed' && value.status !== 'failed'
      && (value.status === 'pending' || value.status === 'running' || value.submission_state === 'pending')) {
      return typeof value.task_id === 'string' && value.task_id.trim() !== '' ? 'accepted-pending' : 'unknown-outcome'
    }
    if (value.status === 'unknown' || value.status === 'interrupted') return 'unknown-outcome'
    if (value.status === 'cancelled' || value.status === 'killed') return 'cancelled'
    if ((value.status === 'failed' || value.status === 'running' || value.ok === false)
      && typeof value.code === 'string' && UNKNOWN_OUTCOME_CODES.has(value.code)) return 'unknown-outcome'
    if (value.status === 'failed' || value.ok === false) {
      const intentFailure = videoIntentFailure(toolName, value.code)
      if (intentFailure !== null) return intentFailure
      if (planParameterFailure(toolName, value.code)) return 'plan-parameters'
      if (typeof value.code === 'string' && PARAMETER_FAILURES.has(value.code)) return 'model-parameters'
      return value.code === 'AUTH_REQUIRED' ? 'sign-in' : productFailureKind(value.code)
    }
  }
  if (block.isError) {
    const intentFailure = videoIntentFailure(toolName, block.error?.code)
    if (intentFailure !== null) return intentFailure
  }
  if (block.isError && planParameterFailure(toolName, block.error?.code)) return 'plan-parameters'
  return block.isError ? productFailureKind(block.error?.code) : null
}
