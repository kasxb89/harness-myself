/** Durable identities for finished video works, independent of conversation interpretation. @module */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { CreativeError, type CreativeOperationId, type CreativeOwner, type CreativeProjectId } from './creative-store.ts'
import type { VideoProjectId } from './video-project.ts'
import type { VideoProjectIdentity } from './video-project-types.ts'

/** Complete private-record byte budget, including ownership and every prepared work. */
const MAX_BYTES = 2 * 1024 * 1024

/** Host-issued identity of one finished work, unrelated to prompts or model call ids. */
export type VideoWorkId = Branded<'VideoWorkId'>
/** Host-issued identity of one real source message's work list. */
export type VideoWorkRequestId = Branded<'VideoWorkRequestId'>

/** Captured logged source; model arguments cannot supply or replace these fields. */
export interface VideoWorkSource {
  readonly messageId: string
  readonly sourceSeq: number
  readonly turn: number
  readonly callId?: string
  readonly rootCallSeq?: number
}

/** Exact real reply captured by the Host; model parameters cannot supply this identity. */
export interface VideoWorkRevision {
  readonly messageId: string
  readonly seq: number
}

/** Existing durable creation association, retained before any paid submission. */
export interface VideoWorkLink {
  readonly projectId: CreativeProjectId
  readonly operationId: CreativeOperationId
  readonly videoProjectId?: VideoProjectId
}

/** Credential-free state shown to the calling workflow; claim nonces remain private. */
export interface VideoWorkView {
  readonly workId: VideoWorkId
  readonly index: number
  readonly state: 'prepared' | 'preparing' | 'linked' | 'cancelled'
  readonly link?: VideoWorkLink
}

/** Concrete works for one original source; only a new Host-captured reply can append more works. */
export interface VideoWorkBatch {
  readonly requestId: VideoWorkRequestId
  readonly works: readonly VideoWorkView[]
}

/** Process-private capability required to settle the exact successful claim. */
export interface VideoWorkClaim {
  readonly workId: VideoWorkId
  readonly requestId: VideoWorkRequestId
  readonly owner: CreativeOwner
  readonly nonce: string
}

/** Exactly one contender receives a claim; all others observe its durable existing state. */
export type VideoWorkClaimResult = {
  readonly kind: 'claimed'
  readonly claim: VideoWorkClaim
  readonly work: VideoWorkView
  readonly batch: VideoWorkBatch
} | {
  readonly kind: 'existing'
  readonly work: VideoWorkView
  readonly batch: VideoWorkBatch
}

/** Private storage and the currently authenticated product login. */
export interface VideoWorkStoreOptions {
  readonly directory: string
  /** @returns Current account and login generation, or absence after sign-out. */
  current(): Promise<VideoProjectIdentity | undefined>
}

interface PreparedWork { workId: VideoWorkId; index: number; link?: VideoWorkLink }
interface WorkRevision {
  revision: VideoWorkRevision
  count: number
  startIndex: number
  endIndex: number
}
interface BatchFields {
  requestId: VideoWorkRequestId
  owner: CreativeOwner
  source: Pick<VideoWorkSource, 'messageId' | 'sourceSeq' | 'turn'>
  works: PreparedWork[]
}
type BatchRecord = BatchFields & ({ version: 1 } | {
  version: 2
  preparedRevision: VideoWorkRevision
  preparedCount: number
  revisions: WorkRevision[]
})
type CurrentBatchRecord = Extract<BatchRecord, { version: 2 }>
interface ClaimRecord {
  version: 1
  requestId: VideoWorkRequestId
  workId: VideoWorkId
  owner: CreativeOwner
  nonce: string
  state: 'preparing' | 'linked' | 'cancelled'
  link?: VideoWorkLink
}

function invalid(): never {
  throw new CreativeError('VIDEO_WORK_INVALID', 409, '视频作品登记无法核对，已停止重复提交；请查看原任务或联系支持。')
}
function unavailable(error: unknown): never {
  if (error instanceof CreativeError) throw error
  throw new CreativeError('VIDEO_WORK_UNAVAILABLE', 503, '暂时无法读取或保存视频作品登记，尚未重新提交；请保留原任务后重试查询。')
}
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !fields.includes(key))) return invalid()
  return result
}
function text(value: unknown, maximum = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f]/u.test(value)) return invalid()
  return value
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return invalid()
  return value
}
function owner(value: unknown): CreativeOwner {
  const item = object(value, ['accountId', 'sessionFingerprint', 'sessionId', 'workspaceRoot'])
  const workspaceRoot = text(item.workspaceRoot, 16_384)
  if (!isAbsolute(workspaceRoot) || resolve(workspaceRoot) !== workspaceRoot) return invalid()
  return { accountId: text(item.accountId, 128), sessionFingerprint: text(item.sessionFingerprint),
    sessionId: text(item.sessionId, 128), workspaceRoot }
}
function requestId(value: unknown): VideoWorkRequestId {
  const result = text(value)
  if (!/^vr_[a-f0-9]{64}$/u.test(result)) return invalid()
  return result as VideoWorkRequestId
}
function workId(value: unknown): VideoWorkId {
  const result = text(value)
  if (!/^vw_[a-f0-9]{64}_[1-9][0-9]*$/u.test(result)) return invalid()
  return result as VideoWorkId
}
function linkValue(value: unknown): VideoWorkLink {
  const item = object(value, ['projectId', 'operationId', 'videoProjectId'])
  const projectId = text(item.projectId, 128)
  const operationId = text(item.operationId, 128)
  if (!/^cp_[a-f0-9-]{36}$/u.test(projectId) || !/^op_[A-Za-z0-9_-]+$/u.test(operationId)) return invalid()
  const videoProjectId = item.videoProjectId === undefined ? undefined : text(item.videoProjectId, 128)
  if (videoProjectId !== undefined && !/^vp_[A-Za-z0-9_-]+$/u.test(videoProjectId)) return invalid()
  return { projectId: projectId as CreativeProjectId, operationId: operationId as CreativeOperationId,
    ...videoProjectId === undefined ? {} : { videoProjectId: videoProjectId as VideoProjectId } }
}
function sameOwner(left: CreativeOwner, right: CreativeOwner): boolean {
  return left.accountId === right.accountId && left.sessionId === right.sessionId && left.workspaceRoot === right.workspaceRoot
}
function revisionValue(value: unknown): VideoWorkRevision {
  const item = object(value, ['messageId', 'seq'])
  return { messageId: text(item.messageId), seq: integer(item.seq) }
}
function sourceRevision(source: Pick<VideoWorkSource, 'messageId' | 'sourceSeq'>): VideoWorkRevision {
  return { messageId: source.messageId, seq: source.sourceSeq }
}
function sameRevision(left: VideoWorkRevision, right: VideoWorkRevision): boolean {
  return left.messageId === right.messageId && left.seq === right.seq
}
function checkRevision(revision: VideoWorkRevision, source: Pick<VideoWorkSource, 'messageId' | 'sourceSeq'>): void {
  if (revision.seq < source.sourceSeq || !sameRevision(revision, sourceRevision(source))
    && (revision.seq === source.sourceSeq || revision.messageId === source.messageId)) invalid()
}
function batchRecord(value: unknown): BatchRecord {
  const item = object(value, ['version', 'requestId', 'owner', 'source', 'works', 'preparedRevision', 'preparedCount', 'revisions'])
  if (item.version !== 1 && item.version !== 2 || !Array.isArray(item.works) || item.works.length === 0) return invalid()
  const source = object(item.source, ['messageId', 'sourceSeq', 'turn'])
  const id = requestId(item.requestId)
  const works = item.works.map((value, index): PreparedWork => {
    const work = object(value, ['workId', 'index', 'link'])
    const parsed = workId(work.workId)
    if (integer(work.index, 1) !== index + 1 || parsed !== `vw_${id.slice(3)}_${String(index + 1)}`) return invalid()
    return { workId: parsed, index: index + 1, ...work.link === undefined ? {} : { link: linkValue(work.link) } }
  })
  const parsedSource = { messageId: text(source.messageId), sourceSeq: integer(source.sourceSeq), turn: integer(source.turn) }
  const fields: BatchFields = { requestId: id, owner: owner(item.owner), source: parsedSource, works }
  if (item.version === 1) {
    if ('preparedRevision' in item || 'preparedCount' in item || 'revisions' in item) return invalid()
    return { ...fields, version: 1 }
  }
  const preparedRevision = revisionValue(item.preparedRevision)
  const preparedCount = integer(item.preparedCount, 1)
  if (preparedCount > works.length) return invalid()
  checkRevision(preparedRevision, parsedSource)
  if (!Array.isArray(item.revisions)) return invalid()
  let previous = preparedRevision
  let endIndex = preparedCount
  const seen = new Set([parsedSource.messageId, previous.messageId])
  const revisions = item.revisions.map((value): WorkRevision => {
    const entry = object(value, ['revision', 'count', 'startIndex', 'endIndex'])
    const revision = revisionValue(entry.revision)
    const count = integer(entry.count, 1)
    const startIndex = integer(entry.startIndex, 2)
    const lastIndex = integer(entry.endIndex, 2)
    if (revision.seq <= previous.seq || seen.has(revision.messageId) || lastIndex !== startIndex + count - 1
      || lastIndex > works.length || startIndex !== endIndex + 1) return invalid()
    previous = revision
    endIndex = lastIndex
    seen.add(revision.messageId)
    return { revision, count, startIndex, endIndex: lastIndex }
  })
  if (endIndex !== works.length) return invalid()
  return { ...fields, version: 2, preparedRevision, preparedCount, revisions }
}
function claimRecord(value: unknown): ClaimRecord {
  const item = object(value, ['version', 'requestId', 'workId', 'owner', 'nonce', 'state', 'link'])
  if (item.version !== 1 || item.state !== 'preparing' && item.state !== 'linked' && item.state !== 'cancelled') return invalid()
  const id = requestId(item.requestId)
  const work = workId(item.workId)
  if (!work.startsWith(`vw_${id.slice(3)}_`)) return invalid()
  const nonce = text(item.nonce, 36)
  if (!/^[a-f0-9-]{36}$/u.test(nonce) || item.state === 'linked' && item.link === undefined
    || item.state === 'preparing' && item.link !== undefined) return invalid()
  return { version: 1, requestId: id, workId: work, owner: owner(item.owner), nonce, state: item.state,
    ...item.link === undefined ? {} : { link: linkValue(item.link) } }
}
function encode(value: BatchRecord | ClaimRecord): string {
  const encoded = JSON.stringify(value)
  if (Buffer.byteLength(encoded) > MAX_BYTES) {
    throw new CreativeError('VIDEO_WORK_LIMIT', 400, '本次作品清单过大，尚未提交生成；请分批安排作品。')
  }
  return encoded
}

/** Bound allocation using complete retained metadata and the smallest possible additional work. */
function checkAdditionalBytes(record: BatchRecord, count: number): void {
  const bytes = Buffer.byteLength(encode(record))
  const smallest = Buffer.byteLength(JSON.stringify({ workId: `vw_${record.requestId.slice(3)}_1`, index: 1 })) + 1
  if (count > Math.floor((MAX_BYTES - bytes) / smallest)) {
    throw new CreativeError('VIDEO_WORK_LIMIT', 400, '本次作品清单过大，尚未提交生成；请分批安排作品。')
  }
}

/** Durable work lists and cross-process exclusive submission claims; no prompt parsing or quantity quotas. */
export class VideoWorkStore {
  private rootDirectory: Promise<string> | undefined

  /** @param options - Private directory and current-login observer. */
  constructor(private readonly options: VideoWorkStoreOptions) {}

  private async root(): Promise<string> {
    this.rootDirectory ??= (async () => {
      const directory = resolve(this.options.directory)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if ((await lstat(directory)).isSymbolicLink()) return invalid()
      return realpath(directory)
    })()
    try {
      const directory = await this.rootDirectory
      if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) return invalid()
      return directory
    } catch (error) { return unavailable(error) }
  }

  private async current(captured: CreativeOwner): Promise<void> {
    const live = await this.options.current()
    if (live?.accountId !== captured.accountId || live.sessionFingerprint !== captured.sessionFingerprint) {
      throw new CreativeError('CREATIVE_ACCOUNT_CHANGED', 409, '登录状态已变化，已停止本次视频提交；请在原账号查看任务。')
    }
  }

  private async path(id: VideoWorkRequestId | VideoWorkId): Promise<string> { return join(await this.root(), `${id}.json`) }

  private async read(path: string): Promise<unknown> {
    try {
      let info: Awaited<ReturnType<typeof lstat>>
      try { info = await lstat(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_BYTES || await realpath(path) !== path) return invalid()
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = await file.stat()
        if (before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size
          || before.mtimeMs !== info.mtimeMs) return invalid()
        const bytes = await file.readFile()
        const after = await file.stat()
        if (bytes.length > MAX_BYTES || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return invalid()
        return JSON.parse(bytes.toString('utf8'))
      } finally { await file.close() }
    } catch (error) { return unavailable(error) }
  }

  private async publish(path: string, record: BatchRecord | ClaimRecord, captured: CreativeOwner): Promise<boolean> {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, encode(record), { flag: 'wx', mode: 0o600 })
      await this.current(captured)
      try { await link(temporary, path); return true } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
      }
    } catch (error) { return unavailable(error) }
    finally {
      try { await unlink(temporary) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailable(error)
      }
    }
  }

  private async record(captured: CreativeOwner, id: VideoWorkRequestId): Promise<BatchRecord> {
    const value = await this.read(await this.path(id))
    if (value === undefined) return invalid()
    const record = batchRecord(value)
    if (record.requestId !== id || !sameOwner(record.owner, captured)) {
      throw new CreativeError('CREATIVE_ACCESS_DENIED', 404, '当前聊天中没有该视频作品。')
    }
    const expected = this.request(captured, record.source)
    if (expected !== id) return invalid()
    return record
  }

  private request(captured: CreativeOwner, source: VideoWorkSource): VideoWorkRequestId {
    return `vr_${createHash('sha256').update(JSON.stringify([captured.accountId, captured.sessionId,
      captured.workspaceRoot, source.messageId, source.sourceSeq])).digest('hex')}` as VideoWorkRequestId
  }

  private async work(record: BatchRecord, prepared: PreparedWork): Promise<VideoWorkView> {
    const value = await this.read(await this.path(prepared.workId))
    if (value === undefined) return { ...prepared, state: prepared.link === undefined ? 'prepared' : 'linked' }
    const claim = claimRecord(value)
    if (claim.workId !== prepared.workId || claim.requestId !== record.requestId || !sameOwner(claim.owner, record.owner)
      || prepared.link !== undefined) return invalid()
    return { workId: prepared.workId, index: prepared.index, state: claim.state,
      ...claim.link === undefined ? {} : { link: claim.link } }
  }

  private async view(record: BatchRecord): Promise<VideoWorkBatch> {
    const works: VideoWorkView[] = []
    for (let offset = 0; offset < record.works.length; offset += 64) {
      works.push(...await Promise.all(record.works.slice(offset, offset + 64).map(work => this.work(record, work))))
    }
    return { requestId: record.requestId, works }
  }

  /**
   * Persist a concrete initial work list, defaulting to one finished video.
   * @param captured - Actual account, chat and workspace.
   * @param source - Host-captured original source; call-id changes do not change the list.
   * @param count - Concrete requested works; repeated calls never resize an existing list.
   * @param legacyLinks - Original-source operations adopted instead of adding new empty works.
   * @param revision - Host-captured real reply used for initial preparation; legacy adoption retains the source anchor.
   * @returns Existing or newly prepared work states, with no submission or charge.
   */
  async prepare(
    captured: CreativeOwner, source: VideoWorkSource, count = 1, legacyLinks: readonly VideoWorkLink[] = [],
    revision?: VideoWorkRevision,
  ): Promise<VideoWorkBatch> {
    await this.current(captured)
    const id = this.request(captured, source)
    const path = await this.path(id)
    if (await this.read(path) === undefined) {
      const total = legacyLinks.length > 0 ? legacyLinks.length : count
      integer(total, 1)
      // Every entry contains at least its id; reject impossible allocations before constructing the array.
      if (total > MAX_BYTES / (`vw_${id.slice(3)}_1`.length + 24)) {
        throw new CreativeError('VIDEO_WORK_LIMIT', 400, '本次作品清单过大，尚未提交生成；请分批安排作品。')
      }
      const parsedRevision = revision === undefined ? sourceRevision(source) : revisionValue(revision)
      checkRevision(parsedRevision, source)
      const record: CurrentBatchRecord = { version: 2, requestId: id, owner: captured, works: [], revisions: [],
        source: { messageId: source.messageId, sourceSeq: source.sourceSeq, turn: source.turn },
        preparedCount: total,
        preparedRevision: legacyLinks.length > 0 ? sourceRevision(source) : parsedRevision }
      checkAdditionalBytes(record, total)
      record.works = Array.from({ length: total }, (_, index) => ({
        workId: `vw_${id.slice(3)}_${String(index + 1)}` as VideoWorkId, index: index + 1,
        ...legacyLinks[index] === undefined ? {} : { link: legacyLinks[index] },
      }))
      await this.publish(path, batchRecord(record), captured)
    }
    const result = await this.view(await this.record(captured, id))
    const unmatched = legacyLinks.map(linkValue).filter(link => !result.works.some(work => work.link !== undefined
      && work.link.projectId === link.projectId && work.link.operationId === link.operationId
      && work.link.videoProjectId === link.videoProjectId))
    const reserved = result.works.filter(work => work.state !== 'prepared' && work.link === undefined)
    if (unmatched.length > reserved.length) return invalid()
    await this.current(captured)
    return result
  }

  /**
   * Append concrete additional works once for a new real reply without resetting existing submissions.
   * @param captured - Current account, exact chat and original workspace.
   * @param source - Host-captured original source whose existing work list receives the additions.
   * @param count - Additional finished works, never the requested total including existing works.
   * @param revision - Exact later real reply; repeated revisions return the retained list without additions.
   * @returns The same request id and every retained or newly prepared work in original order.
   */
  async append(
    captured: CreativeOwner, source: VideoWorkSource, count: number, revision: VideoWorkRevision,
  ): Promise<VideoWorkBatch> {
    await this.current(captured)
    const parsedRevision = revisionValue(revision)
    if (parsedRevision.seq <= source.sourceSeq || parsedRevision.messageId === source.messageId) return invalid()
    const id = this.request(captured, source)
    const path = await this.path(id)
    try {
      return await withFileLock(path, async () => {
        const record = await this.record(captured, id)
        if (record.source.messageId !== source.messageId || record.source.sourceSeq !== source.sourceSeq
          || record.source.turn !== source.turn) return invalid()
        const prepared = record.version === 2 ? record.preparedRevision : sourceRevision(record.source)
        const consumed = record.version === 2 ? record.revisions : []
        if (sameRevision(prepared, parsedRevision) || consumed.some(entry => sameRevision(entry.revision, parsedRevision))) {
          const batch = await this.view(record)
          await this.current(captured)
          return batch
        }
        const latest = consumed.at(-1)?.revision ?? prepared
        if (parsedRevision.seq <= latest.seq || prepared.messageId === parsedRevision.messageId
          || consumed.some(entry => entry.revision.messageId === parsedRevision.messageId)) return invalid()
        integer(count, 1)
        const total = record.works.length + count
        if (!Number.isSafeInteger(total)) return invalid()
        const next: CurrentBatchRecord = { ...record, version: 2, preparedRevision: prepared,
          preparedCount: record.version === 2 ? record.preparedCount : record.works.length,
          revisions: [...consumed, { revision: parsedRevision, count, startIndex: record.works.length + 1, endIndex: total }] }
        checkAdditionalBytes(next, count)
        next.works = [...record.works, ...Array.from({ length: count }, (_, offset) => {
          const index = record.works.length + offset + 1
          return { workId: `vw_${id.slice(3)}_${String(index)}` as VideoWorkId, index }
        })]
        const encoded = encode(batchRecord(next))
        await this.current(captured)
        await writeFileAtomic(path, encoded, { mode: 0o600, dirMode: 0o700 })
        const batch = await this.view(next)
        await this.current(captured)
        return batch
      })
    } catch (error) { return unavailable(error) }
  }

  /**
   * Atomically reserve a prepared work before any expensive or paid preparation.
   * @param captured - Captured account, chat and workspace.
   * @param source - Actual source used only when no work id is supplied.
   * @param suppliedWorkId - Explicit existing work; absence uses this source's first work.
   * @returns A unique process-private claim or the existing durable state.
   */
  async claim(captured: CreativeOwner, source: VideoWorkSource, suppliedWorkId?: string): Promise<VideoWorkClaimResult> {
    await this.current(captured)
    const id = suppliedWorkId === undefined
      ? ((await this.prepare(captured, source)).works[0]?.workId ?? invalid()) : workId(suppliedWorkId)
    const batchId = requestId(`vr_${id.slice(3).split('_')[0]}`)
    const record = await this.record(captured, batchId)
    const prepared = record.works.find(work => work.workId === id)
    if (prepared === undefined) return invalid()
    if (prepared.link === undefined) {
      const nonce = randomUUID()
      const claim: ClaimRecord = { version: 1, workId: id, requestId: batchId, owner: captured, nonce, state: 'preparing' }
      if (await this.publish(await this.path(id), claim, captured)) {
        const batch = await this.view(record)
        return { kind: 'claimed', claim: { workId: id, requestId: batchId, owner: captured, nonce },
          work: batch.works[prepared.index - 1] ?? invalid(), batch }
      }
    }
    const batch = await this.view(record)
    await this.current(captured)
    return { kind: 'existing', work: batch.works[prepared.index - 1] ?? invalid(), batch }
  }

  private async settle<T>(claim: VideoWorkClaim, operation: (record: ClaimRecord, path: string) => Promise<T>): Promise<T> {
    await this.current(claim.owner)
    const batch = await this.record(claim.owner, requestId(claim.requestId))
    if (!batch.works.some(work => work.workId === claim.workId && work.link === undefined)) return invalid()
    const path = await this.path(workId(claim.workId))
    try {
      return await withFileLock(path, async () => {
        const value = await this.read(path)
        if (value === undefined) return invalid()
        const record = claimRecord(value)
        if (record.workId !== claim.workId || record.requestId !== claim.requestId || record.nonce !== claim.nonce
          || !sameOwner(record.owner, claim.owner)) return invalid()
        await this.current(claim.owner)
        return operation(record, path)
      })
    } catch (error) { return unavailable(error) }
  }

  /**
   * Attach the original operation before any POST; attached and unknown work can never be released.
   * @param claim - Exact private capability from the successful reservation.
   * @param link - Durable creation association; replacement is forbidden.
   * @returns Linked state suitable for original-task recovery.
   */
  attach(claim: VideoWorkClaim, link: VideoWorkLink): Promise<VideoWorkView> {
    return this.settle(claim, async (record, path) => {
      const parsed = linkValue(link)
      if (record.state === 'cancelled' || record.link !== undefined && JSON.stringify(record.link) !== JSON.stringify(parsed)) return invalid()
      await writeFileAtomic(path, encode({ ...record, state: 'linked', link: parsed }), { mode: 0o600, dirMode: 0o700 })
      return { workId: record.workId, index: Number(record.workId.split('_').at(-1)), state: 'linked', link: parsed }
    })
  }

  /**
   * Release only a preparation whose caller established that no creation operation or POST exists.
   * @param claim - Exact private reservation; stale nonces cannot release a replacement claim.
   * @returns Whether the unlinked reservation was released; linked or cancelled work remains retained.
   */
  release(claim: VideoWorkClaim): Promise<boolean> {
    return this.settle(claim, async (record, path) => {
      if (record.state !== 'preparing' || record.link !== undefined) return false
      await unlink(path)
      return true
    })
  }

  /**
   * Retain cancellation without reviving the work or discarding its existing operation link.
   * @param claim - Exact process-private reservation.
   * @returns Retained cancelled state; paid work remains recoverable through its link.
   */
  cancel(claim: VideoWorkClaim): Promise<VideoWorkView> {
    return this.settle(claim, async (record, path) => {
      await writeFileAtomic(path, encode({ ...record, state: 'cancelled' }), { mode: 0o600, dirMode: 0o700 })
      return { workId: record.workId, index: Number(record.workId.split('_').at(-1)), state: 'cancelled',
        ...record.link === undefined ? {} : { link: record.link } }
    })
  }

  /**
   * Find only concrete unclaimed works in the same source's list; this is not a human permission quota.
   * @param captured - Actual owner of the existing work list.
   * @param suppliedWorkId - Any existing work in that list.
   * @returns Prepared work ids in their original order.
   */
  async pending(captured: CreativeOwner, suppliedWorkId: string): Promise<readonly VideoWorkId[]> {
    await this.current(captured)
    const id = workId(suppliedWorkId)
    const record = await this.record(captured, requestId(`vr_${id.slice(3).split('_')[0]}`))
    if (!record.works.some(work => work.workId === id)) return invalid()
    const batch = await this.view(record)
    await this.current(captured)
    return batch.works.filter(work => work.state === 'prepared').map(work => work.workId)
  }
}
