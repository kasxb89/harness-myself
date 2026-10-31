/** Correlate live job transitions and media starts without announcing unrelated historical failures. */
import type { IJobs } from '@deepseek-ai/dsh-api-job-controller/client'
import type { QuotaNotices } from '@deepseek-ai/dsh-client-ui-chat/client'

/**
 * Retain confirmed job failures and relate them to live generation receipts before announcing them.
 * @param source - The actual client job roster source.
 * @param notices - Login-guarded correlation and publication of live background jobs.
 * @returns Subscription release; uncorrelated initial history never publishes.
 */
export function watchBalanceFailures(
  source: IJobs['state'], notices: Pick<QuotaNotices, 'observeBalanceJob'>,
): () => void {
  const statuses = new Map<string, string>()
  const read = (notify: boolean): void => {
    for (const [sessionId, rows] of Object.entries(source.getSnapshot().rows)) {
      for (const job of rows) {
        const key = `${sessionId}:${job.id}`
        const previous = statuses.get(key)
        statuses.set(key, job.status)
        const action = job.actionRequired
        if (job.status === 'failed' && action?.code === 'INSUFFICIENT_BALANCE' && typeof action.scope === 'string') {
          notices.observeBalanceJob({ scope: action.scope, key: `job:${job.id}` },
            notify && (previous === 'running' || previous === 'stopping'))
        }
      }
    }
  }
  read(false)
  return source.subscribe(() => { read(true) })
}
