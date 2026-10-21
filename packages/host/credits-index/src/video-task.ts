/** Single-video task recovery reuses the media executor's one-submission lifecycle. @module */
import { executeImageTask, type ImageTaskOptions, type ImageTaskOutcome } from './image-task.ts'
import type { CreativeVideoReceipt } from './creative-types.ts'

/** Single-video transport and persistence operations; recovery never invokes submit. */
export type VideoTaskOptions = ImageTaskOptions

/** Accepted video identity survives query, download and local-save failures. */
export interface VideoTaskOutcome extends Omit<ImageTaskOutcome, 'imageReceipt'> {
  readonly videoReceipt?: CreativeVideoReceipt
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function videoReply(response: Response, taskId: string): Promise<Response> {
  const text = await response.text()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch (_invalidReply) {
    return new Response(text, { status: response.status, headers: response.headers })
  }
  const body = object(parsed)
  const nested = object(body?.data)
  const state = body?.task_status ?? body?.status ?? nested?.task_status ?? nested?.status
  const status = typeof state === 'string' ? state.toLowerCase() : undefined
  const result = object(nested?.task_result) ?? object(body?.task_result) ?? object(body?.result) ?? object(nested?.result)
  const videos = result?.videos ?? result?.data ?? (Array.isArray(body?.data) ? body.data : undefined)
  const first = Array.isArray(videos) ? object(videos[0]) : undefined
  const remote = first?.url ?? result?.url ?? body?.video_url ?? body?.url
  const ready = typeof remote === 'string' || ['completed', 'success', 'succeeded', 'succeed'].includes(status ?? '')
  return new Response(JSON.stringify({ ...body, status,
    result: { data: ready ? [{ taskId, ...typeof remote === 'string' ? { url: remote } : {} }] : [] },
  }), { status: response.status, headers: response.headers })
}

/**
 * Submit one video at most once and query the retained task after an interruption.
 * @param options - Owned request, durable receipt and output-save operations.
 * @returns Actual saved outputs, an explicit terminal rejection, or a pending/unknown outcome.
 */
export async function executeVideoTask(options: VideoTaskOptions): Promise<VideoTaskOutcome> {
  const outcome = await executeImageTask({ ...options,
    read: async (taskId, signal) => videoReply(await options.read(taskId, signal), taskId),
  })
  const { imageReceipt, ...rest } = outcome
  return { ...rest, ...rest.code === undefined ? {} : { code: rest.code.replace(/^IMAGE_/u, 'VIDEO_') },
    ...rest.message === undefined ? {} : { message: rest.message.replaceAll('图片', '视频') },
    ...imageReceipt === undefined ? {} : { videoReceipt: imageReceipt } }
}
