/**
 * The summary domain declaration: one `summaries` table keyed by
 * `<sessionId>:<seq>`, each record the summary one `workspace/changes` event
 * announced. The stored record is the same information the service serves
 * ({@link WorkspaceChangesSummary}) minus the comparison sources, which stay in
 * the recorder's temporary directory and never outlive the Session.
 *
 * Persisting them is what keeps the changed-files card on a Session's closing
 * turn after the Host stops observing that Session — the record outlives both
 * the in-memory recorder and the process.
 * @module @deepseek-ai/dsh-workspace-changes/src/spec
 */

import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** One changed file as stored: counts plus the two refusal markers. */
const changedFileRecord = z.object({
  path: z.string(),
  display: z.string(),
  added: z.number().int(),
  deleted: z.number().int(),
  binary: z.literal(true).optional(),
  oversized: z.literal(true).optional(),
})

/** One top-level turn's summary as stored. */
export const summaryRecord = z.object({
  turn: z.number().int(),
  cwd: z.string(),
  files: z.array(changedFileRecord),
  total: z.number().int(),
  added: z.number().int(),
  deleted: z.number().int(),
  snapshot: z.object({ before: z.string(), after: z.string() }).optional(),
})

/** The stored summary, as the schema validates it. */
export type SummaryRecord = z.infer<typeof summaryRecord>

/**
 * The key one summary is stored under: the Session that appended the event and
 * the event's sequence, which is what both the service and the browser address
 * a summary by.
 * @param sessionId - the Session that appended the `workspace/changes` event.
 * @param seq - the event's sequence number.
 * @returns the record key.
 */
export function summaryKey(sessionId: SessionId, seq: number): string {
  return `${sessionId}:${String(seq)}`
}

/** The domain the plugin opens for durable summaries. */
export const workspaceChangesDomainSpec = defineDomain({
  name: 'workspace_changes',
  version: 1,
  tables: { summaries: domainTable<string, SummaryRecord>(summaryRecord) },
})
