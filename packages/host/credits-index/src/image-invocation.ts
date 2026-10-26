/** Credential-free durable ownership of one actual image tool submission. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { CreativeError, type CreativeOwner, type CreativeProjectId, type CreativeOperationId } from './creative-store.ts'
import type { VideoProjectIdentity } from './video-project-types.ts'
import { normalizeApiBaseUrl } from './api-url.ts'

/** Host-captured source coordinates; prompts and model arguments never establish identity. */
export interface ImageInvocationSource {
  readonly sourceSeq: number
  readonly rootCallId: string
  readonly callId: string
  readonly rootCallSeq?: number
}

/** Original creation coordinates committed before any generation POST. */
export interface ImageInvocationLink {
  readonly projectId: CreativeProjectId
  readonly operationId: CreativeOperationId
}

/** Retained preparing state is unknown after a crash and never automatically re-claimed. */
export interface ImageInvocationView {
  readonly invocationId: string
  readonly state: 'preparing' | 'linked'
  readonly link?: ImageInvocationLink
}

/** Private reservation capability, kept only in Host memory and private files. */
export interface ImageInvocationClaim {
  readonly invocationId: string
  readonly nonce: string
  readonly owner: CreativeOwner
  readonly source: ImageInvocationSource
}

/** Exactly one contender owns submission; all other calls return existing coordinates. */
export type ImageInvocationResult = { kind: 'claimed'; claim: ImageInvocationClaim; view: ImageInvocationView }
  | { kind: 'existing'; view: ImageInvocationView }

interface InvocationRecord {
  version: 1
  invocationId: string
  nonce: string
  owner: CreativeOwner
  source: ImageInvocationSource
  apiBaseUrl: string
  state: 'preparing' | 'linked'
  link?: ImageInvocationLink
}

function invalid(): never {
  throw new CreativeError('IMAGE_INVOCATION_INVALID', 409, '图片提交记录无法确认，请保留原任务并核对产物，不要重复提交。')
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Own-account source identity and cross-process exclusive image submission claim. */
export class ImageInvocationStore {
  private rootDirectory: Promise<string> | undefined
  private readonly baseUrl: string

  /** @param options - Absolute private directory, deployment root and current-login observer. */
  constructor(private readonly options: {
    directory: string
    apiBaseUrl: string
    current: () => Promise<VideoProjectIdentity | undefined>
  }) {
    if (!isAbsolute(options.directory)) throw new Error('Image invocation directory must be absolute')
    this.baseUrl = normalizeApiBaseUrl(options.apiBaseUrl)
  }

  private async root(): Promise<string> {
    this.rootDirectory ??= (async () => {
      const directory = resolve(this.options.directory)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if ((await lstat(directory)).isSymbolicLink()) return invalid()
      return realpath(directory)
    })()
    const directory = await this.rootDirectory
    if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) return invalid()
    return directory
  }

  private async current(owner: CreativeOwner): Promise<void> {
    const live = await this.options.current()
    if (live?.accountId !== owner.accountId || live.sessionFingerprint !== owner.sessionFingerprint) {
      throw new CreativeError('CREATIVE_ACCOUNT_CHANGED', 409, '登录账号已变化，请在原账号查询图片任务。')
    }
  }

  private identity(owner: CreativeOwner, source: ImageInvocationSource): string {
    if (!Number.isSafeInteger(source.sourceSeq) || source.sourceSeq < 0
      || source.rootCallSeq !== undefined && (!Number.isSafeInteger(source.rootCallSeq) || source.rootCallSeq < 0)
      || source.rootCallId === '' || source.callId === '' || source.rootCallId.length > 512 || source.callId.length > 512) return invalid()
    return `ii_${createHash('sha256').update(JSON.stringify([this.baseUrl, owner.accountId, owner.sessionFingerprint,
      owner.sessionId, owner.workspaceRoot, source.sourceSeq, source.rootCallId, source.callId,
      ...source.rootCallSeq === undefined ? [] : [source.rootCallSeq]])).digest('hex')}`
  }

  private async read(path: string, owner: CreativeOwner, source: ImageInvocationSource): Promise<InvocationRecord | undefined> {
    let info: Awaited<ReturnType<typeof lstat>>
    try { info = await lstat(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536 || await realpath(path) !== path) return invalid()
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let raw: unknown
    try {
      const before = await file.stat()
      if (before.ino !== info.ino || before.dev !== info.dev
        || before.size !== info.size || before.mtimeMs !== info.mtimeMs) return invalid()
      const bytes = await file.readFile()
      const after = await file.stat()
      if (bytes.length > 65_536 || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return invalid()
      raw = JSON.parse(bytes.toString('utf8'))
    } finally { await file.close() }
    const value = object(raw), storedOwner = object(value?.owner), storedSource = object(value?.source), linked = object(value?.link)
    if (value?.version !== 1 || value.invocationId !== this.identity(owner, source) || value.apiBaseUrl !== this.baseUrl
      || typeof value.nonce !== 'string' || !/^[a-f\d-]{36}$/u.test(value.nonce)
      || !['preparing', 'linked'].includes(String(value.state))
      || storedOwner?.accountId !== owner.accountId || storedOwner.sessionFingerprint !== owner.sessionFingerprint
      || storedOwner.sessionId !== owner.sessionId || storedOwner.workspaceRoot !== owner.workspaceRoot
      || storedSource?.sourceSeq !== source.sourceSeq || storedSource.rootCallId !== source.rootCallId
      || storedSource.callId !== source.callId || storedSource.rootCallSeq !== source.rootCallSeq
      || value.state === 'preparing' && value.link !== undefined
      || value.state === 'linked' && (typeof linked?.projectId !== 'string' || linked.projectId === ''
        || typeof linked.operationId !== 'string' || linked.operationId === '')) return invalid()
    // The private-file parser above establishes the complete record before this type assertion.
    return raw as InvocationRecord
  }

  private view(record: InvocationRecord): ImageInvocationView {
    return { invocationId: record.invocationId, state: record.state, ...record.link === undefined ? {} : { link: { ...record.link } } }
  }

  /**
   * Reserve one source/call before reference upload, operation creation or generation.
   * @param owner - Current account, login fingerprint, chat and workspace captured by the Host.
   * @param source - Actual human sequence and logged root/sub-call identities.
   * @returns One private claim or its existing durable state; orphan preparing records stay reserved.
   */
  async claim(owner: CreativeOwner, source: ImageInvocationSource): Promise<ImageInvocationResult> {
    await this.current(owner)
    const invocationId = this.identity(owner, source)
    const path = join(await this.root(), `${invocationId}.json`)
    const nonce = randomUUID()
    const record: InvocationRecord = { version: 1, invocationId, nonce, owner: { ...owner }, source: { ...source },
      apiBaseUrl: this.baseUrl, state: 'preparing' }
    const temporary = `${path}.${nonce}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 })
      await this.current(owner)
      try {
        await link(temporary, path)
        return { kind: 'claimed', claim: { invocationId, nonce, owner: { ...owner }, source: { ...source } }, view: this.view(record) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const existing = await this.read(path, owner, source)
      if (existing === undefined) return invalid()
      await this.current(owner)
      return { kind: 'existing', view: this.view(existing) }
    } finally {
      try { await unlink(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }

  /**
   * Attach the original creation before any paid POST; links cannot be replaced or released.
   * @param claim - Private capability from the unique successful claim.
   * @param association - Existing private creation coordinates.
   * @returns The retained original link for future replay/recovery.
   */
  async attach(claim: ImageInvocationClaim, association: ImageInvocationLink): Promise<ImageInvocationView> {
    await this.current(claim.owner)
    if (association.projectId === '' || association.operationId === '') return invalid()
    if (this.identity(claim.owner, claim.source) !== claim.invocationId) return invalid()
    const path = join(await this.root(), `${claim.invocationId}.json`)
    return withFileLock(path, async () => {
      const record = await this.read(path, claim.owner, claim.source)
      if (record === undefined || record.nonce !== claim.nonce) return invalid()
      if (record.link !== undefined && (record.link.projectId !== association.projectId
        || record.link.operationId !== association.operationId)) return invalid()
      await this.current(claim.owner)
      const next: InvocationRecord = { ...record, state: 'linked', link: { ...association } }
      await writeFileAtomic(path, JSON.stringify(next) + '\n', { mode: 0o600, dirMode: 0o700 })
      return this.view(next)
    })
  }
}
