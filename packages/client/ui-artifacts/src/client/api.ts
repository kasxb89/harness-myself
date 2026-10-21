/** Cancellable artifact reads and explicit, non-retrying file mutations. */
import type { ArtifactEntry } from './ArtifactsPage.tsx'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

/** Public Host errors whose details have product-owned translations. */
export const ERROR_CODES = [
  'ARTIFACT_PATH_INVALID', 'ARTIFACT_NOT_FOUND', 'ARTIFACT_PATH_FORBIDDEN', 'ARTIFACT_PERMISSION_DENIED', 'ARTIFACT_STALE',
  'ARTIFACT_CONFLICT', 'ARTIFACT_MOVE_UNSUPPORTED', 'ARTIFACT_OPERATION_UNKNOWN',
  'ARTIFACT_STORAGE_INVALID', 'ARTIFACT_STORAGE_UNWRITABLE', 'ARTIFACT_STORAGE_UNAVAILABLE',
  'ARTIFACT_OUTPUT_INVALID', 'ARTIFACT_NAME_INVALID', 'ARTIFACT_TRASH_INVALID',
  'ARTIFACT_REQUEST_INVALID', 'ARTIFACT_AUTH_REQUIRED', 'ARTIFACT_METHOD_INVALID', 'ARTIFACT_OPERATION_FAILED',
  'ARTIFACT_WORKSPACE_UNAVAILABLE', 'ARTIFACT_DIRECTORY_INVALID', 'ARTIFACT_WORKSPACE_REMOTE_UNSUPPORTED', 'ARTIFACT_OPEN_FAILED',
  'ARTIFACT_ORIGIN_UNAVAILABLE',
] as const

/** Localizable failure code; raw Host exception text never reaches the page. */
export type ArtifactErrorCode = typeof ERROR_CODES[number]

/** A response read at the artifact boundary. */
export type ArtifactResult<T> = { ok: true; value: T } | { ok: false; code: ArtifactErrorCode }

/** Host-recorded generating location for this exact file identity. */
export interface ArtifactOrigin {
  readonly sessionId: SessionId
  readonly turn: number
  readonly eventSeq?: SessionSeq
  readonly toolCallId?: ToolCallId
}

function origin(value: unknown): value is ArtifactOrigin | null {
  return value === null || record(value) && typeof value.sessionId === 'string' && value.sessionId !== ''
    && typeof value.turn === 'number' && Number.isSafeInteger(value.turn) && value.turn >= 0
    && (value.eventSeq === undefined || typeof value.eventSeq === 'number' && Number.isSafeInteger(value.eventSeq) && value.eventSeq >= 0)
    && (value.toolCallId === undefined || typeof value.toolCallId === 'string' && value.toolCallId !== '')
}

/**
 * Read an exact file's generating location without interpreting its name.
 * @param selected - Listed file version and authorization scope.
 * @param signal - Mounted preview lifetime.
 * @returns Verified generating location, absence for older or unrelated files, or a localizable read failure.
 */
export async function readArtifactOrigin(selected: ArtifactEntry, signal: AbortSignal): Promise<ArtifactResult<ArtifactOrigin | null>> {
  const query = new URLSearchParams({ path: selected.path, size: String(selected.size), mtimeMs: String(selected.mtimeMs) })
  if (selected.workspaceId !== undefined) query.set('workspaceId', selected.workspaceId)
  const result = await request(`origin?${query}`, (value): value is { origin: ArtifactOrigin | null } => record(value) && origin(value.origin), signal)
  return result.ok ? { ok: true, value: result.value.origin } : result
}

/** Authoritative future-output preference, distinct from retained browsing roots. */
export interface ArtifactStorage {
  directory: string
  defaultDirectory: string
  revision: number
  roots: readonly string[]
}

/** One recoverable deletion, retained by the Host across panel and app restarts. */
export interface TrashedArtifact {
  id: string
  name: string
  originalPath: string
  deletedAt: string
  workspaceRoot?: string
}

/** One currently registered local workspace, as the Host authorizes it. */
export interface ArtifactWorkspace { id: string; title: string; path: string }

/** One lazily read workspace directory; relative navigation always uses POSIX separators. */
export interface WorkspaceListing {
  workspace: ArtifactWorkspace
  directory: string
  absoluteDirectory: string
  parentDirectory: string | null
  directories: readonly { name: string; directory: string }[]
  items: readonly ArtifactEntry[]
  truncated: boolean
  offset?: number
  nextOffset?: number | null
}

/** One lazily read retained output directory, with no workspace authorization added. */
export interface RootDirectoryListing {
  root: string
  directory: string
  absoluteDirectory: string
  parentDirectory: string | null
  directories: readonly { name: string; directory: string }[]
  items: readonly ArtifactEntry[]
  truncated: boolean
  offset?: number
  nextOffset?: number | null
}

/** A workspace whose files could not be completely read without affecting other sources. */
export interface ArtifactListingIssue {
  workspaceId: string
  title: string
  code: 'ARTIFACT_WORKSPACE_UNAVAILABLE' | 'ARTIFACT_WORKSPACE_REMOTE_UNSUPPORTED'
    | 'ARTIFACT_PERMISSION_DENIED' | 'ARTIFACT_OPERATION_FAILED'
}

/** Current artifact inventory, with explicit scan limits and independently unavailable sources. */
export interface ArtifactListing {
  items: readonly ArtifactEntry[]
  roots: readonly string[]
  truncated: boolean
  issues?: readonly ArtifactListingIssue[]
}

/** File identity supplied with a mutation so a changed file cannot be silently replaced. */
export type ArtifactExpected = Pick<ArtifactEntry, 'size' | 'mtimeMs'>

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function entry(value: unknown): value is ArtifactEntry {
  return record(value) && typeof value.path === 'string' && typeof value.name === 'string'
    && typeof value.kind === 'string'
    && ['image', 'video', 'audio', 'document', 'sheet', 'slides', 'archive', 'code', 'text', 'other'].includes(value.kind)
    && typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0
    && typeof value.mtimeMs === 'number' && Number.isFinite(value.mtimeMs)
    && (value.workspaceId === undefined || typeof value.workspaceId === 'string' && value.workspaceId !== '')
}

function listingIssue(value: unknown): value is ArtifactListingIssue {
  return record(value) && typeof value.workspaceId === 'string' && value.workspaceId !== '' && typeof value.title === 'string'
    && typeof value.code === 'string' && ['ARTIFACT_WORKSPACE_UNAVAILABLE', 'ARTIFACT_WORKSPACE_REMOTE_UNSUPPORTED',
    'ARTIFACT_PERMISSION_DENIED', 'ARTIFACT_OPERATION_FAILED'].includes(value.code)
}

function pagination(value: Record<string, unknown>, offset: number): boolean {
  if (value.offset === undefined && value.nextOffset === undefined) return offset === 0
  return value.offset === offset && (value.nextOffset === null
    || typeof value.nextOffset === 'number' && Number.isSafeInteger(value.nextOffset) && value.nextOffset > offset)
}

function storage(value: unknown): value is ArtifactStorage {
  return record(value) && typeof value.directory === 'string' && typeof value.defaultDirectory === 'string'
    && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 0
    && strings(value.roots)
}

/** Execute once; a missing mutation receipt is uncertain even if the network says it failed. */
async function request<T>(path: string, valid: (value: unknown) => value is T, signal: AbortSignal,
  body?: unknown): Promise<ArtifactResult<T>> {
  const uncertain = body !== undefined ? 'ARTIFACT_OPERATION_UNKNOWN' : 'ARTIFACT_OPERATION_FAILED'
  try {
    const response = await fetch(`/artifacts/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST', signal, credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
    })
    const value: unknown = await response.json()
    if (!response.ok) {
      const code = record(value) ? value.code : undefined
      return { ok: false, code: typeof code === 'string' && ERROR_CODES.includes(code as ArtifactErrorCode)
        ? code as ArtifactErrorCode : uncertain }
    }
    return valid(value) ? { ok: true, value } : { ok: false, code: uncertain }
  } catch (_error) {
    return { ok: false, code: uncertain }
  }
}

/**
 * Read current files without losing the previous listing on failure.
 * @param signal - Page-owned cancellation for an unmounted or superseded read.
 * @returns Validated files, roots, scan limits, and source issues, or a localizable error code.
 */
export function readArtifacts(signal: AbortSignal): Promise<ArtifactResult<ArtifactListing>> {
  return request('list', (value): value is ArtifactListing => record(value) && Array.isArray(value.items)
    && value.items.every(entry) && strings(value.roots) && typeof value.truncated === 'boolean'
    && (value.issues === undefined || Array.isArray(value.issues) && value.issues.every(listingIssue)), signal)
}

/**
 * Read one registered workspace directory without recursively scanning its source tree.
 * @param workspaceId - Explicit registered workspace selected by the user or current conversation.
 * @param directory - Host-provided POSIX relative directory; the empty string names its root.
 * @param signal - Page-owned cancellation for a changed workspace or directory.
 * @param offset - Next page offset previously supplied by the Host; zero starts a directory.
 * @returns Validated directory metadata and workspace-bound files, or a localizable error code.
 */
export async function readWorkspace(workspaceId: string, directory: string,
  signal: AbortSignal, offset = 0): Promise<ArtifactResult<WorkspaceListing>> {
  const query = new URLSearchParams({ workspaceId, directory, ...offset === 0 ? {} : { offset: String(offset) } })
  const result = await request(`workspace?${query.toString()}`, (value): value is WorkspaceListing => record(value)
    && record(value.workspace) && value.workspace.id === workspaceId && typeof value.workspace.title === 'string'
    && typeof value.workspace.path === 'string' && value.directory === directory && typeof value.absoluteDirectory === 'string'
    && (value.parentDirectory === null || typeof value.parentDirectory === 'string')
    && Array.isArray(value.directories) && value.directories.every(item => record(item)
      && typeof item.name === 'string' && typeof item.directory === 'string')
    && Array.isArray(value.items) && value.items.every(entry) && typeof value.truncated === 'boolean'
    && pagination(value, offset), signal)
  return result.ok ? { ok: true, value: { ...result.value,
    items: result.value.items.map(item => ({ ...item, workspaceId: result.value.workspace.id })) } } : result
}

/**
 * Read one currently retained output root without recursively scanning it.
 * @param root - Exact canonical root from the current library response.
 * @param directory - Portable relative directory below that root.
 * @param signal - Finder-owned cancellation for navigation or dismissal.
 * @param offset - Next page offset previously supplied by the Host; zero starts a directory.
 * @returns Validated directory metadata and files, or a localizable error code.
 */
export function readRootDirectory(root: string, directory: string,
  signal: AbortSignal, offset = 0): Promise<ArtifactResult<RootDirectoryListing>> {
  const query = new URLSearchParams({ root, directory, ...offset === 0 ? {} : { offset: String(offset) } })
  return request(`directory?${query.toString()}`, (value): value is RootDirectoryListing => record(value)
    && value.root === root && value.directory === directory && typeof value.absoluteDirectory === 'string'
    && (value.parentDirectory === null || typeof value.parentDirectory === 'string')
    && Array.isArray(value.directories) && value.directories.every(item => record(item)
      && typeof item.name === 'string' && typeof item.directory === 'string')
    && Array.isArray(value.items) && value.items.every(item => entry(item) && item.workspaceId === undefined)
    && typeof value.truncated === 'boolean' && pagination(value, offset), signal)
}

/**
 * Read the current future-output directory and its optimistic revision.
 * @param signal - Page-owned cancellation for an unmounted or superseded read.
 * @returns The committed storage preference and revision, or a localizable error code.
 */
export function readStorage(signal: AbortSignal): Promise<ArtifactResult<ArtifactStorage>> {
  return request('storage', storage, signal)
}

/**
 * Save a future-output preference without moving existing files.
 * @param directory - User-confirmed complete path for future generated files.
 * @param expectedRevision - Last observed preference revision, checked by the Host before committing.
 * @param signal - Plugin lifetime; an interrupted receipt leaves the operation result unconfirmed.
 * @returns The committed storage preference, or a localizable failure without retrying the write.
 */
export function saveStorage(directory: string, expectedRevision: number, signal: AbortSignal): Promise<ArtifactResult<ArtifactStorage>> {
  return request('storage', storage, signal, { directory, expectedRevision })
}

/**
 * Rename exactly the file the person inspected; never retry a missing receipt.
 * @param path - Complete path of the selected listed file.
 * @param name - User-confirmed filename within the file's current directory.
 * @param expected - Selected file size and modification time used to reject stale mutations.
 * @param signal - Plugin lifetime; an interrupted receipt leaves the operation result unconfirmed.
 * @param workspaceId - Registered workspace scope for a source file; absent for managed generated output.
 * @returns The renamed file entry, or a localizable failure without retrying the mutation.
 */
export async function renameArtifact(path: string, name: string, expected: ArtifactExpected,
  signal: AbortSignal, workspaceId?: string): Promise<ArtifactResult<ArtifactEntry>> {
  const result = await request('rename', (value): value is { item: ArtifactEntry } => record(value) && entry(value.item), signal,
    { path, name, expected, ...workspaceId === undefined ? {} : { workspaceId } })
  return result.ok ? { ok: true, value: { ...result.value.item, ...workspaceId === undefined ? {} : { workspaceId } } } : result
}

/**
 * Move one file into recoverable storage after confirmation.
 * @param path - Complete path of the selected listed file.
 * @param expected - Selected file size and modification time used to reject stale mutations.
 * @param signal - Plugin lifetime; an interrupted receipt leaves the operation result unconfirmed.
 * @param workspaceId - Registered workspace scope for a source file; absent for managed generated output.
 * @returns The durable recovery identifier, or a localizable failure without retrying the deletion.
 */
export async function trashArtifact(path: string, expected: ArtifactExpected,
  signal: AbortSignal, workspaceId?: string): Promise<ArtifactResult<string>> {
  const result = await request('trash', (value): value is { trashId: string } => record(value)
    && typeof value.trashId === 'string' && value.trashId !== '', signal, { path, expected, ...workspaceId === undefined ? {} : { workspaceId } })
  return result.ok ? { ok: true, value: result.value.trashId } : result
}

/**
 * Read recoverable deletions without inferring them from files missing in the listing.
 * @param signal - Page-owned cancellation for an unmounted or superseded read.
 * @returns Validated durable recovery records, or a localizable error code.
 */
export async function readTrash(signal: AbortSignal): Promise<ArtifactResult<readonly TrashedArtifact[]>> {
  const result = await request('trash', (value): value is { items: TrashedArtifact[] } => record(value)
    && Array.isArray(value.items) && value.items.every(item => record(item) && typeof item.id === 'string'
      && typeof item.name === 'string' && typeof item.originalPath === 'string' && typeof item.deletedAt === 'string'
      && (item.workspaceRoot === undefined || typeof item.workspaceRoot === 'string')), signal)
  return result.ok ? { ok: true, value: result.value.items } : result
}

/**
 * Restore one retained deletion; conflicts remain visible and never overwrite another file.
 * @param id - Durable recovery identifier explicitly selected by the user.
 * @param signal - Plugin lifetime; an interrupted receipt leaves the operation result unconfirmed.
 * @returns The restored file entry, or a localizable failure without retrying the restoration.
 */
export async function restoreArtifact(id: string, signal: AbortSignal): Promise<ArtifactResult<ArtifactEntry>> {
  const result = await request('restore', (value): value is { item: ArtifactEntry } => record(value) && entry(value.item), signal, { id })
  return result.ok ? { ok: true, value: result.value.item } : result
}
