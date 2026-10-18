/** Stream URLs retain the artifact service's existing managed-root and Workspace authorization. */

/**
 * Build a same-origin media URL without embedding bytes in browser memory.
 * @param path - Host-resolved absolute path from the addressed Session's file resource.
 * @param version - Source version, separating browser requests after a reload.
 * @param workspaceId - Registered Workspace containing the addressed Session, when required.
 * @returns An authenticated Range-capable artifact URL.
 */
export function mediaUrl(path: string, version: string, workspaceId?: string): string {
  const query = new URLSearchParams({ path, version })
  if (workspaceId !== undefined) query.set('workspaceId', workspaceId)
  return `/artifacts/api/raw?${query.toString()}`
}

/**
 * Authorize managed output first, then the addressed Session's registered Workspace.
 * @param path - Host-resolved absolute file path.
 * @param version - The metadata version being displayed.
 * @param workspaceId - Workspace resolved from the real Session membership; never inferred from a path.
 * @param signal - Renderer revision and tab lifetime cancellation.
 * @returns The accepted stream URL, or undefined when neither existing scope permits playback.
 */
export async function resolveMediaSource(path: string, version: string, workspaceId: string | undefined,
  signal: AbortSignal): Promise<string | undefined> {
  try {
    signal.throwIfAborted()
    const managed = mediaUrl(path, version)
    const response = await fetch(managed, { method: 'HEAD', signal, credentials: 'same-origin', cache: 'no-store' })
    signal.throwIfAborted()
    if (response.ok) return managed
    if (workspaceId === undefined || response.status !== 403 && response.status !== 404) return undefined
    const scoped = mediaUrl(path, version, workspaceId)
    const workspace = await fetch(scoped, { method: 'HEAD', signal, credentials: 'same-origin', cache: 'no-store' })
    signal.throwIfAborted()
    return workspace.ok ? scoped : undefined
  } catch (_error) {
    // Cancellation is checked by the revision owner; transport failures stay local to this preview.
    return undefined
  }
}
