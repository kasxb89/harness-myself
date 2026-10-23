/** Private producer-declared media purpose, independent of conversation origin records. @module */
import { createHash } from 'node:crypto'
import { open, type lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { artifactIdentity } from './origin.ts'
import type { ArtifactWriteRequest } from './types.ts'

type FileInfo = Awaited<ReturnType<typeof lstat>>
type MediaRoles = Pick<ArtifactWriteRequest, 'videoRole' | 'imageRole'>

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
 * @param roles - Explicit video or image purposes from the trusted producer.
 * @returns An independent versioned sidecar, with no Session or account fields.
 */
export function mediaRoleRecord(info: FileInfo, roles: MediaRoles): object {
  return { version: 1, identity: artifactIdentity(info), ...roles }
}

/**
 * Read at most 4097 bytes and accept only an exact, valid file association.
 * @param directory - Private artifact state.
 * @param info - Current authorized file identity and version.
 * @returns Trusted purposes, or no fields for old, replaced, malformed or unavailable records.
 */
export async function readMediaRoles(directory: string, info: FileInfo): Promise<MediaRoles> {
  let value: unknown
  try {
    const handle = await open(videoRolePath(directory, info), 'r')
    try {
      const bytes = Buffer.alloc(4097)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 4096) return {}
      value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
    } finally { await handle.close() }
  } catch (_unavailable: unknown) { return {} }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !('version' in value) || value.version !== 1 || !('identity' in value) || value.identity !== artifactIdentity(info)
    || Object.keys(value).some(key => !['version', 'identity', 'videoRole', 'imageRole'].includes(key))) return {}
  const videoRole = 'videoRole' in value ? value.videoRole : undefined
  const imageRole = 'imageRole' in value ? value.imageRole : undefined
  if (videoRole !== undefined && videoRole !== 'final' && videoRole !== 'shot'
    || imageRole !== undefined && imageRole !== 'final' && imageRole !== 'storyboard') return {}
  return {
    ...videoRole === undefined ? {} : { videoRole },
    ...imageRole === undefined ? {} : { imageRole },
  }
}
