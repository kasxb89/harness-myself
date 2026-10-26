/** Private, account-owned image results and verified local save checkpoints. @module */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { CreativeError, type CreativeOperationId, type CreativeOwner } from './creative-store.ts'
import type { CreativeImageReceipt } from './creative-types.ts'
import type { VideoProjectIdentity } from './video-project-types.ts'
import { parseArtifactOrigin } from './artifact-origin.ts'

const MANIFEST_BYTES = 1_048_576
const DEFAULT_RESPONSE_BYTES = 134_217_728
const DEFAULT_IMAGE_BYTES = 67_108_864

/** Private reference; signed URLs and inline bytes never belong in public task views. */
export type ImageResultRef = Branded<'ImageResultRef'>
/** Provider image representations admitted before any save or private result publication. */
export type ImageResultItem = { readonly url: string } | { readonly b64_json: string }
/** Current Host-owned operation; login freshness is checked separately from durable ownership. */
export interface ImageResultScope {
  readonly owner: CreativeOwner
  readonly operationId: CreativeOperationId
  readonly backendFingerprint: string
}
/** A private retained result ready to save without submitting or querying generation again. */
export interface ImageRetainedResult {
  readonly receipt: CreativeImageReceipt
  readonly items: readonly ImageResultItem[]
  readonly saved: readonly { readonly index: number; readonly path: string }[]
}

interface ScopeRecord {
  accountId: string
  sessionId: string
  workspaceRoot: string
  operationId: string
  backendFingerprint: string
}
type StoredItem = { url: string } | { file: string; bytes: number; sha256: string }
interface Checkpoint { index: number; path: string; bytes: number; sha256: string }
interface Manifest {
  version: 1
  scope: ScopeRecord
  receipt: CreativeImageReceipt
  items: StoredItem[]
  saved: Checkpoint[]
}

function invalid(code = 'IMAGE_RESULT_INVALID'): never {
  throw new CreativeError(code, 409, '原图片结果无法完整核对，请保留原任务并检查保存状态；不会重新生成。')
}
function unavailable(error: unknown, code: string): never {
  if (error instanceof CreativeError) throw error
  throw new CreativeError(code, 503, '原图片结果尚未完整保存或暂时无法读取，请保留原任务并恢复保存；不会重新生成。')
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value === '' || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) return invalid()
  return value
}
function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return invalid()
  return value
}

/**
 * Validate an entire returned batch before decoding inline bytes or persisting any entry.
 * @param values - Untrusted provider result array.
 * @param imageMaxBytes - Per-image decoded byte limit.
 * @param responseMaxBytes - Complete serialized result budget.
 * @returns Only supported image sources, with no prompt, credential or arbitrary provider fields.
 */
export function validateImageResultItems(values: readonly unknown[], imageMaxBytes = DEFAULT_IMAGE_BYTES,
  responseMaxBytes = DEFAULT_RESPONSE_BYTES): ImageResultItem[] {
  let encodedBytes = 0
  return values.map((value): ImageResultItem => {
    const entry = object(value)
    if (typeof entry.b64_json === 'string' && entry.b64_json !== '') {
      const data = entry.b64_json
      const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
      const bytes = Math.floor(data.length * 3 / 4) - padding
      if (bytes <= 0 || bytes > imageMaxBytes || data.length % 4 === 1
        || padding !== 0 && data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) return invalid()
      encodedBytes += data.length + 32
      if (encodedBytes > responseMaxBytes) return invalid('IMAGE_RESULT_TOO_LARGE')
      return { b64_json: data }
    }
    const url = text(entry.url, 16_384)
    let parsed: URL
    try { parsed = new URL(url) } catch (_invalidUrl: unknown) { return invalid() }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '') return invalid()
    encodedBytes += Buffer.byteLength(url) + 32
    if (encodedBytes > responseMaxBytes) return invalid('IMAGE_RESULT_TOO_LARGE')
    return { url }
  })
}

function receiptValue(value: unknown, scope: ScopeRecord): CreativeImageReceipt {
  const item = object(value)
  const route = text(item.route, 512), model = text(item.model, 256)
  const phase = item.phase
  if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/u.test(route)
    || route.split('/').some(part => part === '.' || part === '..')
    || item.backendFingerprint !== scope.backendFingerprint
    || phase !== 'submitting' && phase !== 'accepted' && phase !== 'completed') return invalid()
  const id = (value: unknown): string => {
    const result = text(value, 256)
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result) || /^(?:sk-|nap_)/iu.test(result)) return invalid()
    return result
  }
  const taskId = item.taskId === undefined ? undefined : id(item.taskId)
  const requestId = item.requestId === undefined ? undefined : id(item.requestId)
  if (phase === 'accepted' && taskId === undefined) return invalid()
  const origin = parseArtifactOrigin(item.origin, scope.sessionId)
  if (origin === null) return invalid()
  return { route, model, phase, backendFingerprint: scope.backendFingerprint,
    ...taskId === undefined ? {} : { taskId }, ...requestId === undefined ? {} : { requestId },
    ...origin === undefined ? {} : { origin } }
}

/** Private immutable sources plus mutable, hash-verified local save checkpoints. */
export class ImageResultStore {
  private rootDirectory: Promise<string> | undefined
  private readonly imageLimit: number
  private readonly responseLimit: number

  /** @param options - Private directory, current login observer and configured byte budgets. */
  constructor(private readonly options: {
    readonly directory: string
    readonly current: () => Promise<VideoProjectIdentity | undefined>
    readonly maxImageBytes?: number
    readonly maxResponseBytes?: number
  }) {
    if (!isAbsolute(options.directory)) throw new Error('Image result directory must be absolute')
    this.imageLimit = positive(options.maxImageBytes ?? DEFAULT_IMAGE_BYTES)
    this.responseLimit = positive(options.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES)
  }

  private async root(): Promise<string> {
    this.rootDirectory ??= (async () => {
      const path = resolve(this.options.directory)
      await mkdir(path, { recursive: true, mode: 0o700 })
      if ((await lstat(path)).isSymbolicLink()) return invalid()
      return realpath(path)
    })()
    const path = await this.rootDirectory
    if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) return invalid()
    return path
  }

  private async current(scope: ImageResultScope): Promise<ScopeRecord> {
    const live = await this.options.current()
    const owner = scope.owner
    if (live?.accountId !== owner.accountId || live.sessionFingerprint !== owner.sessionFingerprint) {
      throw new CreativeError('CREATIVE_ACCOUNT_CHANGED', 409, '登录账号已变化，请在原账号恢复保存图片。')
    }
    if (!/^[a-f0-9]{64}$/u.test(scope.backendFingerprint) || !isAbsolute(owner.workspaceRoot)
      || resolve(owner.workspaceRoot) !== owner.workspaceRoot) return invalid()
    return { accountId: text(owner.accountId, 128), sessionId: text(owner.sessionId, 128),
      workspaceRoot: text(owner.workspaceRoot, 16_384), operationId: text(scope.operationId, 256),
      backendFingerprint: scope.backendFingerprint }
  }

  private ref(scope: ScopeRecord, receipt: CreativeImageReceipt, items: readonly StoredItem[]): ImageResultRef {
    return `ir_${digest(JSON.stringify([scope, receipt, items]))}` as ImageResultRef
  }

  private async directory(ref: ImageResultRef, create = false): Promise<string> {
    if (!/^ir_[a-f0-9]{64}$/u.test(ref)) return invalid()
    const path = join(await this.root(), ref)
    if (create) await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) return invalid()
    return path
  }

  private async lock(ref: ImageResultRef): Promise<string> {
    if (!/^ir_[a-f0-9]{64}$/u.test(ref)) return invalid()
    return join(await this.root(), `${ref}.state`)
  }

  private async readBytes(path: string, maximum: number): Promise<Buffer> {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) return invalid()
    const canonical = await realpath(path)
    const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await file.stat()
      if (before.ino !== info.ino || before.dev !== info.dev || before.size !== info.size) return invalid()
      const parts: Buffer[] = []
      let size = 0
      while (true) {
        const part = Buffer.alloc(Math.min(65_536, maximum - size + 1))
        const { bytesRead } = await file.read(part)
        if (bytesRead === 0) break
        size += bytesRead
        if (size > maximum) return invalid('IMAGE_RESULT_TOO_LARGE')
        parts.push(part.subarray(0, bytesRead))
      }
      const after = await file.stat()
      if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return invalid()
      return Buffer.concat(parts, size)
    } finally { await file.close() }
  }

  private async manifest(scope: ScopeRecord, ref: ImageResultRef): Promise<Manifest> {
    const path = await this.directory(ref)
    const bytes = await this.readBytes(join(path, 'manifest.json'), MANIFEST_BYTES)
    let raw: unknown
    try { raw = JSON.parse(bytes.toString('utf8')) }
    catch (_invalidJson: unknown) { return invalid() }
    const value = object(raw)
    if (value.version !== 1 || JSON.stringify(value.scope) !== JSON.stringify(scope)
      || !Array.isArray(value.items) || value.items.length === 0 || !Array.isArray(value.saved)) return invalid()
    const receipt = receiptValue(value.receipt, scope)
    let total = 0
    const items = value.items.map((raw: unknown): StoredItem => {
      const item = object(raw)
      if (item.url !== undefined) {
        const [entry] = validateImageResultItems([item], this.imageLimit, this.responseLimit)
        if (entry === undefined || !('url' in entry)) return invalid()
        total += Buffer.byteLength(entry.url) + 32
        return { url: entry.url }
      }
      const file = text(item.file, 128), sha256 = text(item.sha256, 64), bytes = positive(item.bytes)
      if (!/^[a-f0-9]{64}\.b64$/u.test(file) || !/^[a-f0-9]{64}$/u.test(sha256)
        || file !== `${sha256}.b64` || bytes > this.responseLimit) return invalid()
      total += bytes + 32
      return { file, sha256, bytes }
    })
    if (total > this.responseLimit || this.ref(scope, receipt, items) !== ref) return invalid()
    const indexes = new Set<number>()
    const saved = value.saved.map((raw: unknown): Checkpoint => {
      const item = object(raw)
      if (typeof item.index !== 'number' || !Number.isSafeInteger(item.index) || item.index < 0
        || item.index >= items.length || indexes.has(item.index) || !isAbsolute(String(item.path))) return invalid()
      indexes.add(item.index)
      const sha256 = text(item.sha256, 64)
      if (!/^[a-f0-9]{64}$/u.test(sha256)) return invalid()
      return { index: item.index, path: text(item.path, 16_384), sha256, bytes: positive(item.bytes) }
    })
    return { version: 1, scope, receipt, items, saved }
  }

  private async publish(path: string, manifest: Manifest): Promise<void> {
    const text = JSON.stringify(manifest) + '\n'
    if (Buffer.byteLength(text) > MANIFEST_BYTES) return invalid('IMAGE_RESULT_TOO_LARGE')
    await writeFileAtomic(join(path, 'manifest.json'), text, { mode: 0o600, dirMode: 0o700 })
  }

  /**
   * Retain all validated sources before any dependent download or artifact write.
   * @param scope - Exact backend, account, chat, workspace and operation owner.
   * @param received - Original submission identity, including synchronous replies without a task id.
   * @param values - Complete provider image results; inline data is stored in separate private files.
   * @param linked - Persist the opaque operation reference before publishing the complete private manifest.
   * @returns Opaque private reference; an interrupted publication never permits another generation POST.
   */
  async retain(scope: ImageResultScope, received: CreativeImageReceipt, values: readonly ImageResultItem[],
    linked?: (ref: ImageResultRef) => Promise<void>): Promise<ImageResultRef> {
    const owner = await this.current(scope)
    const receipt = receiptValue(received, owner)
    const entries = validateImageResultItems(values, this.imageLimit, this.responseLimit)
    if (entries.length === 0) return invalid()
    const items: StoredItem[] = entries.map(item => 'url' in item ? { url: item.url }
      : { file: `${digest(item.b64_json)}.b64`, sha256: digest(item.b64_json), bytes: item.b64_json.length })
    const ref = this.ref(owner, receipt, items)
    const lock = await this.lock(ref).catch((error: unknown) => unavailable(error, 'IMAGE_RESULT_PERSISTENCE_UNAVAILABLE'))
    return withFileLock(lock, async () => {
      const path = await this.directory(ref, true)
      for (const item of entries) {
        if (!('b64_json' in item)) continue
        const filePath = join(path, `${digest(item.b64_json)}.b64`)
        try {
          if ((await this.readBytes(filePath, this.responseLimit)).toString('ascii') !== item.b64_json) return invalid()
          continue
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        const temporary = `${filePath}.${randomUUID()}.tmp`
        try {
          const file = await open(temporary, 'wx', 0o600)
          try {
            for (let offset = 0; offset < item.b64_json.length; offset += 65_536) {
              const part = Buffer.from(item.b64_json.slice(offset, offset + 65_536), 'ascii')
              let written = 0
              while (written < part.length) {
                const result = await file.write(part.subarray(written))
                if (result.bytesWritten === 0) return invalid('IMAGE_RESULT_PERSISTENCE_UNAVAILABLE')
                written += result.bytesWritten
              }
            }
            await file.sync()
          } finally { await file.close() }
          await link(temporary, filePath)
        } finally {
          try { await unlink(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
      }
      await this.current(scope)
      let existing: Manifest | undefined
      try { existing = await this.manifest(owner, ref) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await linked?.(ref)
      await this.current(scope)
      await this.publish(path, existing ?? { version: 1, scope: owner, receipt, items, saved: [] })
      return ref
    }).catch((error: unknown) => unavailable(error, 'IMAGE_RESULT_PERSISTENCE_UNAVAILABLE'))
  }

  /**
   * Load original sources and retain only checkpoints whose current file bytes still match.
   * @param scope - Current login and exact original operation ownership.
   * @param ref - Private reference issued by retain, never a model-supplied path.
   * @returns Verified sources and saved indexes; deleted or changed outputs are saved again without generation.
   */
  async load(scope: ImageResultScope, ref: ImageResultRef): Promise<ImageRetainedResult> {
    const owner = await this.current(scope)
    const lock = await this.lock(ref).catch((error: unknown) => unavailable(error, 'IMAGE_RESULT_UNAVAILABLE'))
    return withFileLock(lock, async () => {
      const value = await this.manifest(owner, ref)
      const path = await this.directory(ref)
      const entries: ImageResultItem[] = []
      for (const item of value.items) {
        if ('url' in item) entries.push({ url: item.url })
        else {
          const bytes = await this.readBytes(join(path, item.file), item.bytes)
          if (bytes.length !== item.bytes || digest(bytes) !== item.sha256) return invalid()
          entries.push({ b64_json: bytes.toString('ascii') })
        }
      }
      const items = validateImageResultItems(entries, this.imageLimit, this.responseLimit)
      const saved: { index: number; path: string }[] = []
      for (const checkpoint of value.saved) {
        try {
          const bytes = await this.readBytes(checkpoint.path, this.imageLimit)
          if (bytes.length === checkpoint.bytes && digest(bytes) === checkpoint.sha256) {
            saved.push({ index: checkpoint.index, path: checkpoint.path })
          }
        } catch (_changedOutput: unknown) { /* A missing, replaced or unreadable output is saved anew from retained sources. */ }
      }
      await this.current(scope)
      return { receipt: value.receipt, items, saved }
    }).catch((error: unknown) => unavailable(error, 'IMAGE_RESULT_UNAVAILABLE'))
  }

  /**
   * Commit one actual saved file after hashing its current regular, non-link bytes.
   * @param scope - Exact original operation ownership and current login.
   * @param ref - Retained original result reference.
   * @param index - Stable provider result index, independent of transfer completion order.
   * @param path - Actual artifact file; its bytes are revalidated when recovering.
   */
  async saved(scope: ImageResultScope, ref: ImageResultRef, index: number, path: string): Promise<void> {
    const owner = await this.current(scope)
    const lock = await this.lock(ref).catch((error: unknown) => unavailable(error, 'IMAGE_RESULT_CHECKPOINT_UNAVAILABLE'))
    await withFileLock(lock, async () => {
      const value = await this.manifest(owner, ref)
      if (!Number.isSafeInteger(index) || index < 0 || index >= value.items.length || !isAbsolute(path)) return invalid()
      const bytes = await this.readBytes(path, this.imageLimit)
      if (bytes.length === 0) return invalid()
      const next = { index, path, bytes: bytes.length, sha256: digest(bytes) }
      await this.current(scope)
      await this.publish(await this.directory(ref), { ...value, saved: [...value.saved.filter(item => item.index !== index), next] })
    }).catch((error: unknown) => unavailable(error, 'IMAGE_RESULT_CHECKPOINT_UNAVAILABLE'))
  }
}
