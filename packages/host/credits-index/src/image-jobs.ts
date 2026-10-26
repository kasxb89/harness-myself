/** Responsive image execution through the existing owner-scoped background registry. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-jobs/view' {
  interface JobKindMap { 'image-generation': 'image-generation' }
}

/** Durable coordinates remain usable after the process-local job has gone. */
export interface ImageJobCoordinates { readonly plan_id: string; readonly operation_id: string }
/** Model-visible result retained by job_output and the original creation operation. */
export interface ImageJobResult {
  readonly status: string
  readonly message?: string
  readonly paths?: readonly string[]
  readonly code?: string
}
/** Content-free monotonic measurements for one local execution only. */
export interface ImagePhaseTiming { readonly stage: string; readonly duration_ms: number }

/** A local execution exception cannot establish provider failure or erase its recovery coordinates. */
type UnconfirmedImageResult = ImageJobCoordinates & { readonly status: 'unknown'; readonly message: string; readonly code: string }
type TimedImageResult<T extends ImageJobResult> = (T | UnconfirmedImageResult) & {
  phase_timings: ImagePhaseTiming[]
  elapsed_ms: number
}

const PHASES: Readonly<Record<string, string>> = {
  preparing: '准备参数', catalog: '核对模型参数', 'validating-references': '校验参考图',
  'uploading-references': '上传参考图', 'local-queue': '等待本地生成名额',
  submitting: '提交中', accepted: '已受理', queued: '上游排队中', generating: '生成中',
  saving: '下载与保存', downloading: '下载与保存', unknown: '结果暂未确认',
}

/** Own all in-process image work and await it during plugin teardown. */
export class ImageJobs {
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()

  /** @param ctx - Producer scope with an optional owner-serving job provider. @param foregroundWaitMs - Local fast-completion wait. */
  constructor(private readonly ctx: Context, private readonly foregroundWaitMs: number) {}

  /** Stop local waiting and await all started producers; accepted provider work may continue. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.operations])
  }

  /**
   * Execute once and return either its fast result or the original background coordinates.
   * @param exec - Trusted calling agent and wait cancellation.
   * @param coordinates - Already committed creation operation, not a provider acceptance claim.
   * @param run - One submission owner; it must persist receipts and settle the creation operation.
   * @returns Exact result or a job id; no timer or local cancellation resubmits generation.
   */
  async run<T extends ImageJobResult>(exec: ToolRunContext, coordinates: ImageJobCoordinates,
    run: (signal: AbortSignal, phase: (stage: string) => void) => Promise<T>): Promise<TimedImageResult<T>
      | (ImageJobCoordinates & { status: 'background'; job_id: JobId; message: string })> {
    exec.signal.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    const started = performance.now()
    let phaseStarted = started
    let stage = 'preparing'
    const timings: ImagePhaseTiming[] = []
    const transition = (next: string): void => {
      if (next === stage) return
      const now = performance.now()
      timings.push({ stage, duration_ms: Math.max(0, Math.round(now - phaseStarted)) })
      phaseStarted = now
      stage = next
    }
    const unconfirmed = (): UnconfirmedImageResult => ({ ...coordinates, status: 'unknown',
      code: 'IMAGE_OPERATION_UNCONFIRMED',
      message: '图片任务结果暂未确认，请查询原任务；不会自动重新提交。' })
    const measured = (value: T | UnconfirmedImageResult): TimedImageResult<T> => {
      const now = performance.now()
      return { ...value, phase_timings: [...timings, { stage, duration_ms: Math.max(0, Math.round(now - phaseStarted)) }],
        elapsed_ms: Math.max(0, Math.round(now - started)) }
    }
    const execute = async (signal: AbortSignal, progress?: (text: string) => void): Promise<TimedImageResult<T>> => {
      try {
        return measured(await run(signal, (next) => { transition(next); progress?.(PHASES[next] ?? '准备参数') }))
      } catch (_unconfirmedOperation: unknown) {
        // Keep the original operation, including when local cancellation races an accepted POST.
        return measured(unconfirmed())
      }
    }
    const jobs = this.ctx.get('jobs')
    const agent = exec.agent
    if (jobs === undefined || agent === undefined) {
      const operation = execute(AbortSignal.any([exec.signal, this.lifetime.signal]))
      this.operations.add(operation)
      try { return await operation } finally { this.operations.delete(operation) }
    }
    let result: TimedImageResult<T> | undefined
    let producer: Promise<JobOutcome> | undefined
    const id = jobs.start({ kind: 'image-generation', owner: agent.id, label: '图片生成', readMode: 'background',
      backgroundReadConcludesTurn: false,
      run: (job) => {
        const controller = new AbortController()
        const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
        job.updateProgress('准备参数')
        const done = execute(signal, (text) => { job.updateProgress(text) }).then((value): JobOutcome => {
          result = value
          return { status: value.status === 'succeeded' ? 'completed' : signal.aborted ? 'killed'
            : value.status === 'failed' ? 'failed' : 'completed',
          result: JSON.stringify(value), ...value.code === undefined ? {} : { detail: value.code } }
        })
        producer = done
        this.operations.add(done)
        void done.finally(() => { this.operations.delete(done) })
        return { cancel: () => { controller.abort() }, done }
      },
    })
    try {
      const view = await jobs.wait(id, this.foregroundWaitMs, agent.id, exec.signal)
      if (view.status === 'completed' || view.status === 'failed' || view.status === 'killed') {
        jobs.read(id, agent.id)
        jobs.remove(id, agent.id)
        if (result !== undefined) return result
        return measured(unconfirmed())
      }
    } catch (_unconfirmedWait: unknown) {
      if (exec.signal.aborted) {
        try { jobs.kill(id, agent.id) } catch (_alreadyRemoved: unknown) { /* Its owner may already be disposing the same producer. */ }
        await producer
      }
      // The producer still owns settlement; callers must not finish it a second time.
      return result ?? measured(unconfirmed())
    }
    return { status: 'background', job_id: id, ...coordinates,
      message: '图片任务已在本地后台开始，可继续聊天。用 job_output 查看真实进度，完成后展示返回的图片路径。停止本地等待不代表上游已取消，已提交任务可能继续计费；不要重复提交。' }
  }
}
