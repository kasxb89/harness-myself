/** Display-only classification for fixed media workflow failures. */
import { productFailureKind, type ProductFailureKind } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'

const MEDIA_TOOLS = new Set([
  'generate_image', 'generate_video', 'generate_video_project', 'edit_video', 'assemble_video',
  'video_project_status', 'resume_video_project', 'get_creation_plan', 'update_creation_plan',
  'query_image_task',
])

// These receipts cannot establish a safe new paid submission. A failed project
// save can also precede dispatch, so the copy must not claim that charging occurred.
const UNKNOWN_OUTCOME_CODES = new Set([
  'SUBMISSION_UNKNOWN', 'CREATIVE_SUBMISSION_UNKNOWN', 'CREATIVE_OUTCOME_UNKNOWN',
  'PROJECT_STORAGE_FAILED', 'TIMEOUT', 'TRANSPORT', 'NO_TASK_ID',
])

type MediaFailure = ProductFailureKind | 'unknown-outcome' | 'accepted-pending'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
  for (const content of block.content) {
    if (content.type !== 'text') continue
    let value: unknown
    try { value = JSON.parse(content.text) } catch (_error) { continue }
    if (!record(value)) continue
    if (value.status === 'unauthorized') return 'sign-in'
    if (value.status === 'pending' || value.submission_state === 'pending') {
      return (toolName === 'generate_image' || toolName === 'query_image_task')
        && typeof value.task_id === 'string' && value.task_id !== '' ? 'accepted-pending' : 'unknown-outcome'
    }
    if (value.submission_state === 'unknown') return 'unknown-outcome'
    if (value.status === 'unknown' || value.status === 'interrupted') return 'unknown-outcome'
    if (value.status === 'cancelled' || value.status === 'killed') return 'cancelled'
    if ((value.status === 'failed' || value.status === 'running' || value.ok === false)
      && typeof value.code === 'string' && UNKNOWN_OUTCOME_CODES.has(value.code)) return 'unknown-outcome'
    if (value.status === 'failed' || value.ok === false) {
      return value.code === 'AUTH_REQUIRED' ? 'sign-in' : productFailureKind(value.code)
    }
  }
  if (block.isError && typeof block.error?.code === 'string' && UNKNOWN_OUTCOME_CODES.has(block.error.code)) return 'unknown-outcome'
  return block.isError ? productFailureKind(block.error?.code) : null
}
