/** Typed video identity normalization for recorded-session fixtures. @module */

/**
 * Collect only declared, request-bound video identities returned by tools.
 * @param results - Parsed tool results whose request and work bindings must remain visible.
 * @returns Reusable tokens for validated request and work ids, preserving repeated references.
 */
export function collectVideoWorkIdentities(results: readonly Readonly<Record<string, unknown>>[]): ReadonlyMap<string, string> {
  const requests = new Map<string, string>(), works = new Map<string, string>()
  for (const result of results) {
    if (result.work_request_id === undefined && result.work_id === undefined
      && result.pending_work_ids === undefined && result.works === undefined) continue
    const request = result.work_request_id
    if (typeof request !== 'string' || !/^vr_[a-f0-9]{64}$/u.test(request)) throw new Error('Invalid work_request_id')
    const captured: unknown[] = result.work_id === undefined ? [] : [result.work_id]
    if (result.pending_work_ids !== undefined) {
      if (!Array.isArray(result.pending_work_ids)) throw new Error('Invalid pending_work_ids')
      const pending: readonly unknown[] = result.pending_work_ids
      captured.push(...pending)
    }
    if (result.works !== undefined) {
      if (!Array.isArray(result.works)) throw new Error('Invalid works')
      const prepared: readonly unknown[] = result.works
      for (const work of prepared) {
        if (work === null || typeof work !== 'object' || Array.isArray(work)) throw new Error('Invalid work entry')
        captured.push((work as Record<string, unknown>).work_id)
      }
    }
    if (!requests.has(request)) requests.set(request, `{{videoRequest:${String(requests.size + 1)}}}`)
    for (const work of captured) {
      if (typeof work !== 'string' || !/^vw_[a-f0-9]{64}_[1-9][0-9]*$/u.test(work)
        || !work.startsWith(`vw_${request.slice(3)}_`)) throw new Error('Invalid work_id binding')
      if (!works.has(work)) works.set(work, `{{videoWork:${String(works.size + 1)}}}`)
    }
  }
  return new Map([...requests, ...works])
}
