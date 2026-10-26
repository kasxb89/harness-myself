/** Capability-gated, current-owner consumption-log batch lookup without settlement inference. */
import { AccountReadError } from './account-read.ts'

/** Exact v1 receipt capability from the configured backend's public status. */
export interface ChatUsageBatchCapability {
  readonly maxRequestIds: number
  readonly maxBodyBytes: number
  readonly maxConsumeLogs: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function invalid(): never { throw new AccountReadError('protocol', 200) }

/**
 * Recognize only the supported fixed-route v1 declaration; missing support retains legacy GET reads.
 * @param value - Untrusted status.data.usage_receipts.
 * @returns Valid bounded capability or undefined for an absent/unsupported declaration.
 */
export function parseChatUsageBatchCapability(value: unknown): ChatUsageBatchCapability | undefined {
  const data = record(value)
  if (data?.schema_version !== 1 || data.batch_path !== '/api/log/self/batch' || data.method !== 'POST'
    || !integer(data.max_request_ids) || data.max_request_ids < 1 || data.max_request_ids > 100
    || !integer(data.max_body_bytes) || data.max_body_bytes < 1 || data.max_body_bytes > 16_384
    || !integer(data.max_consume_logs) || data.max_consume_logs < 1 || data.max_consume_logs > 1000
    || data.refund_state !== false || data.final_settlement_state !== false) return undefined
  return { maxRequestIds: data.max_request_ids, maxBodyBytes: data.max_body_bytes, maxConsumeLogs: data.max_consume_logs }
}

/**
 * Pack exact request ids within both advertised entry and encoded JSON byte limits.
 * @param requestIds - Current-owner receipt ids, already deduplicated by the Host.
 * @param capability - Validated fixed-route capability.
 * @returns Ordered bounded batches; an unrepresentable id is an explicit protocol failure.
 */
export function chatUsageBatches(requestIds: readonly string[], capability: ChatUsageBatchCapability): string[][] {
  const batches: string[][] = []
  let batch: string[] = []
  for (const id of requestIds) {
    if (id === '' || id.trim() !== id || Buffer.byteLength(id) > 64 || /[\u0000-\u001f\u007f]/u.test(id)) return invalid()
    const fits = (ids: readonly string[]): boolean => ids.length <= capability.maxRequestIds
      && Buffer.byteLength(JSON.stringify({ request_ids: ids })) <= capability.maxBodyBytes
    if (!fits([id])) return invalid()
    if (!fits([...batch, id])) { batches.push(batch); batch = [] }
    batch.push(id)
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

/**
 * Validate a complete exact-owner receipt response and sum every observed consumption row.
 * @param value - Decoded v1 response; error responses never enter this parser.
 * @param requestIds - Exact ids sent in this read-only batch, without account selectors.
 * @param capability - Advertised maximum aggregate row count.
 * @returns Per-id observed quota; absence means unknown, without inferring refund or final settlement.
 */
export function parseChatUsageBatch(value: unknown, requestIds: readonly string[],
  capability: ChatUsageBatchCapability): Map<string, number | undefined> {
  const body = record(value), data = record(body?.data)
  if (body?.success !== true || data?.schema_version !== 1 || !integer(data.lookup_window_start_unix)
    || !Array.isArray(data.items) || data.items.length !== requestIds.length) return invalid()
  const wanted = new Set(requestIds)
  const results = new Map<string, number | undefined>()
  let count = 0
  for (const raw of data.items) {
    const item = record(raw)
    if (typeof item?.request_id !== 'string' || !wanted.has(item.request_id) || results.has(item.request_id)
      || !Array.isArray(item.consume_logs) || item.refund_status !== 'unknown' || item.settlement_status !== 'unknown'
      || item.status !== 'found' && item.status !== 'not_found'
      || (item.status === 'found') !== (item.consume_logs.length > 0)) return invalid()
    let quota = 0
    for (const raw of item.consume_logs) {
      const row = record(raw)
      if (++count > capability.maxConsumeLogs || row?.request_id !== item.request_id
        || typeof row.model_name !== 'string' || !integer(row.quota) || !integer(row.prompt_tokens)
        || !integer(row.completion_tokens) || !integer(row.created_at) || !integer(row.use_time)) return invalid()
      quota += row.quota
      if (!Number.isSafeInteger(quota)) return invalid()
    }
    results.set(item.request_id, item.status === 'found' ? quota : undefined)
  }
  return results
}
