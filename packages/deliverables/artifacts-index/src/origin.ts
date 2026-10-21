/** Private file-identity records for exact generating conversation locations. @module */
import { createHash } from 'node:crypto'
import { readFile, type lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ArtifactOrigin } from './types.ts'

type FileInfo = Awaited<ReturnType<typeof lstat>>

/** Stable across exclusive rename, trash and restore; replacement or edits invalidate the record. */
function identity(info: FileInfo): string {
  return JSON.stringify([info.dev, info.ino, info.birthtimeMs, info.size, info.mtimeMs])
}

/**
 * Resolve one private record name without exposing output names or conversation ids.
 * @param directory - Private artifact-state directory.
 * @param info - Completed file's filesystem identity and selected version.
 * @returns Private JSON record path keyed by the exact identity.
 */
export function originPath(directory: string, info: FileInfo): string {
  return join(directory, 'origins', createHash('sha256').update(identity(info)).digest('hex') + '.json')
}

/**
 * Build one durable association after the file bytes are complete and before publication.
 * @param info - Completed file's filesystem identity and selected version.
 * @param origin - Trusted generating conversation coordinates.
 * @returns Versioned private association record.
 */
export function originRecord(info: FileInfo, origin: ArtifactOrigin): object {
  return { version: 1, identity: identity(info), origin }
}

/**
 * Read only an exact file identity; absence never infers a conversation from a filename.
 * @param directory - Private artifact-state directory.
 * @param info - Current file's filesystem identity and selected version.
 * @returns Persisted generating location or null when the file has no record; damaged records reject.
 */
export async function readOrigin(directory: string, info: FileInfo): Promise<ArtifactOrigin | null> {
  let value: unknown
  try { value = JSON.parse(await readFile(originPath(directory, info), 'utf8')) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  if (value === null || typeof value !== 'object' || !('version' in value) || value.version !== 1
    || !('identity' in value) || value.identity !== identity(info) || !('origin' in value)
    || value.origin === null || typeof value.origin !== 'object') throw new Error('Invalid artifact origin record')
  const origin = value.origin
  if (!('sessionId' in origin) || typeof origin.sessionId !== 'string' || origin.sessionId.length === 0
    || !('turn' in origin) || typeof origin.turn !== 'number' || !Number.isSafeInteger(origin.turn) || origin.turn < 0
    || 'eventSeq' in origin && (typeof origin.eventSeq !== 'number' || !Number.isSafeInteger(origin.eventSeq) || origin.eventSeq < 0)
    || 'toolCallId' in origin && (typeof origin.toolCallId !== 'string' || origin.toolCallId === '')) {
    throw new Error('Invalid artifact origin location')
  }
  return { sessionId: origin.sessionId as SessionId, turn: origin.turn,
    ...'eventSeq' in origin ? { eventSeq: origin.eventSeq as SessionSeq } : {},
    ...'toolCallId' in origin ? { toolCallId: origin.toolCallId as ToolCallId } : {} }
}
