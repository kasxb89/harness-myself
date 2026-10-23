/** Private producer-declared video purpose, independent of conversation origin records. @module */
import { createHash } from 'node:crypto'
import { open, type lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { artifactIdentity } from './origin.ts'
import type { ArtifactVideoRole } from './types.ts'

type FileInfo = Awaited<ReturnType<typeof lstat>>

/**
 * Resolve a private purpose record for the exact file version.
 * @param directory - Private artifact state.
 * @param info - Completed file identity and version.
 * @returns Hashed sidecar path without user filenames or chat identifiers.
 */
export function videoRolePath(directory: string, info: FileInfo): string {
  return join(directory, 'video-roles', createHash('sha256').update(artifactIdentity(info)).digest('hex') + '.json')
}

/**
 * Encode a trusted producer's purpose before publishing the completed file.
 * @param info - Completed file identity and version.
 * @param videoRole - Explicit finished-video or storyboard-clip classification.
 * @returns An independent versioned sidecar, with no Session or account fields.
 */
export function videoRoleRecord(info: FileInfo, videoRole: ArtifactVideoRole): object {
  return { version: 1, identity: artifactIdentity(info), videoRole }
}

/**
 * Read at most 4097 bytes and accept only an exact, valid file association.
 * @param directory - Private artifact state.
 * @param info - Current authorized file identity and version.
 * @returns Trusted purpose, or absence for old, replaced, malformed or unavailable records.
 */
export async function readVideoRole(directory: string, info: FileInfo): Promise<ArtifactVideoRole | undefined> {
  let value: unknown
  try {
    const handle = await open(videoRolePath(directory, info), 'r')
    try {
      const bytes = Buffer.alloc(4097)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 4096) return undefined
      value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
    } finally { await handle.close() }
  } catch (_unavailable: unknown) { return undefined }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !('version' in value) || value.version !== 1 || !('identity' in value) || value.identity !== artifactIdentity(info)
    || !('videoRole' in value) || value.videoRole !== 'final' && value.videoRole !== 'shot'
    || Object.keys(value).some(key => !['version', 'identity', 'videoRole'].includes(key))) return undefined
  return value.videoRole
}
