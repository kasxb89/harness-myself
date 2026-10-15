/**
 * The durable half of the summary service: the domain one plugin instance opens
 * when the composition mounts storage, the record each announced summary is
 * written to, and the read that answers once the in-memory recorder is gone.
 *
 * Storage is optional. A composition without `storageDomain` keeps today's
 * behavior — summaries live exactly as long as their Session does — and every
 * failure here is soft: the in-memory copy stays authoritative, and a lost write
 * only costs the card after the Session stops being observed.
 * @module @deepseek-ai/dsh-workspace-changes/src/store
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { summaryKey, summaryRecord, workspaceChangesDomainSpec, type SummaryRecord } from './spec.ts'
import type { WorkspaceChangedFile, WorkspaceChangesSummary } from './types.ts'

/** The summary table this plugin owns. */
type SummaryTable = KvTable<string, SummaryRecord>

/** The durable summaries one plugin instance holds. */
export interface SummaryStore {
  /**
   * The stored summary one event announced.
   * @param sessionId - the Session that appended the event.
   * @param seq - the event's sequence number.
   * @returns the stored summary, or undefined while none is held for that event.
   */
  get(sessionId: SessionId, seq: number): WorkspaceChangesSummary | undefined
  /**
   * Store one summary. An absent store, or a write that fails, leaves the
   * in-memory copy authoritative.
   * @param sessionId - the Session that appended the event.
   * @param seq - the event's sequence number.
   * @param summary - the summary to store.
   */
  put(sessionId: SessionId, seq: number, summary: WorkspaceChangesSummary): void
}

/**
 * Rebuild the service's summary from its stored record. Written field by field
 * because the stored form omits the two refusal markers instead of carrying them
 * as `undefined`, which the summary's optional properties do not accept.
 * @param record - the stored, schema-validated record.
 * @returns the summary in the shape the service serves.
 */
function adopt(record: SummaryRecord): WorkspaceChangesSummary {
  return {
    turn: record.turn,
    cwd: record.cwd,
    files: record.files.map((file): WorkspaceChangedFile => ({
      path: file.path,
      display: file.display,
      added: file.added,
      deleted: file.deleted,
      ...file.binary === true ? { binary: true } : {},
      ...file.oversized === true ? { oversized: true } : {},
    })),
    total: record.total,
    added: record.added,
    deleted: record.deleted,
    ...record.snapshot === undefined ? {} : { snapshot: record.snapshot },
  }
}

/**
 * Open the summary domain for one plugin instance.
 *
 * The domain opens asynchronously; a read or write that arrives before it
 * resolves finds no table and behaves as an in-memory-only composition. The
 * domain closes with the plugin, including when the plugin is disposed while the
 * open is still in flight.
 * @param ctx - host context that may carry `storageDomain`.
 * @returns the store the summary service reads and writes through.
 */
export function openSummaryStore(ctx: Context): SummaryStore {
  let table: SummaryTable | undefined
  const storage = ctx.get('storageDomain')
  if (storage !== undefined) {
    ctx.effect(() => {
      let close: (() => Promise<void>) | undefined
      let disposed = false
      void storage.open(workspaceChangesDomainSpec).then(
        (domain) => {
          if (disposed) { void domain.close(); return }
          table = domain.table('summaries')
          close = () => { table = undefined; return domain.close() }
        },
        (error: unknown) => {
          ctx.logger.warn(`workspace-changes: summaries stay in memory for this run: ${String(error)}`)
        },
      )
      return () => { disposed = true; return close?.() }
    }, 'workspace-changes: summary store')
  }
  return {
    get: (sessionId, seq) => {
      const record = table?.get(summaryKey(sessionId, seq))
      return record === undefined ? undefined : adopt(record)
    },
    put: (sessionId, seq, summary) => {
      if (table === undefined) return
      void table.put(summaryKey(sessionId, seq), summaryRecord.parse(summary)).catch((error: unknown) => {
        ctx.logger.warn(`workspace-changes: turn ${String(summary.turn)} was not stored: ${String(error)}`)
      })
    },
  }
}
