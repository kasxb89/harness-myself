/** Prepare gateway-owned video bodies without leaking private reference snapshots. @module */

/** Exact immutable local reference bytes retained in a private prepared request. */
export interface VideoReferenceSnapshot {
  kind: 'image' | 'video' | 'audio'
  mediaType: string
  filename: string
  base64: string
}

/** Prepared transport body; fetch supplies the boundary for multipart uploads. */
export interface VideoSubmission {
  body: BodyInit
  headers: Record<string, string>
}

/**
 * Serialize one prepared request. BlackRxAI snapshots become repeated file parts;
 * their private carrier never reaches the gateway. This function makes no requests.
 * @param request - Validated credential-free durable video request.
 * @returns A JSON body or multipart upload with all references in their original order.
 */
export function videoSubmission(request: Readonly<Record<string, unknown>>): VideoSubmission {
  const snapshots = request._blackrxReferences
  if (snapshots === undefined) return { body: JSON.stringify(request), headers: { 'content-type': 'application/json' } }
  if (!Array.isArray(snapshots)) throw new Error('Invalid private video reference snapshot')
  const allowed = new Set(['model', 'prompt', 'seconds', 'size', 'gen_type', 'n', '_blackrxReferences'])
  if (Object.keys(request).some(key => !allowed.has(key))) throw new Error('Invalid prepared BlackRxAI video field')
  const fields = Object.fromEntries(Object.entries(request).filter(([key]) => key !== '_blackrxReferences'))
  if (typeof fields.model !== 'string' || typeof fields.prompt !== 'string' || fields.prompt.trim() === ''
    || typeof fields.seconds !== 'number' || !Number.isSafeInteger(fields.seconds) || fields.seconds < 1 || fields.seconds > 30
    || !['1280x720', '720x1280', '1792x1024', '1024x1792'].includes(String(fields.size)) || fields.n !== 1
    || fields.gen_type !== (snapshots.length === 0 ? 'text_to_video' : 'reference_to_video')) throw new Error('Invalid prepared BlackRxAI video value')
  if (snapshots.length === 0) return { body: JSON.stringify(fields), headers: { 'content-type': 'application/json' } }
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Invalid prepared BlackRxAI video value')
    form.append(key, String(value))
  }
  const references: unknown[] = snapshots
  for (const value of references) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid private video reference snapshot')
    const snapshot = value as Record<string, unknown>
    if (!['image', 'video', 'audio'].includes(String(snapshot.kind)) || typeof snapshot.mediaType !== 'string'
      || !snapshot.mediaType.startsWith(String(snapshot.kind) + '/') || typeof snapshot.filename !== 'string'
      || typeof snapshot.base64 !== 'string') {
      throw new Error('Invalid private video reference snapshot')
    }
    const bytes = Buffer.from(snapshot.base64, 'base64')
    if (bytes.length === 0 || bytes.toString('base64') !== snapshot.base64) throw new Error('Invalid private video reference snapshot')
    form.append(String(snapshot.kind) + 's', new Blob([bytes], { type: snapshot.mediaType }), snapshot.filename)
  }
  return { body: form, headers: {} }
}
