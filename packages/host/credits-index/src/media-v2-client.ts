/** Receipt-first typed media transport with private, restart-safe operation records. @module */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { writePrivateState } from './private-state-file.ts'
import { mediaFilename } from './media-filename.ts'
import { readMediaBytes } from './media-transfer.ts'
import type { CapturedMediaOutput } from './media-output.ts'
import { mediaV2Id, mediaV2Object, mediaV2UUID, mediaV2TaskComplete, parseMediaV2Asset, parseMediaV2Batch, parseMediaV2TaskBatch,
  parseMediaV2Catalog, parseMediaV2Operation,
  parseMediaV2Quote, parseMediaV2Request, parseMediaV2Task,
  type MediaV2Asset, type MediaV2Catalog, type MediaV2Operation, type MediaV2Quote, type MediaV2Request, type MediaV2Task } from './media-v2-protocol.ts'

/** Captured account identity and a credential-owning fetch; credentials never enter this module's records. */
export interface MediaV2Account { owner: string
  fetch(path: string, init: RequestInit): Promise<Response> }
/** Authorized original bytes; a source factory must cancel pending reads when its upload signal aborts. */
export type MediaV2UploadSource = { bytes: Uint8Array } | {
  stream: AsyncIterable<Uint8Array> | ((signal: AbortSignal) => AsyncIterable<Uint8Array>)
  size?: number
}
/** Original upload identity and the exact declared material role, when selected. */
export type MediaV2UploadInput = {
  model: string
  clientAssetId: string
  filename: string
  mime: string
  field?: string
} & MediaV2UploadSource
/** Append-only explicit configuration quotation action; the original request is never overwritten. */
export interface MediaV2ConfigurationRequote {
  requested_at: number
  request: MediaV2Request
  previous_quote: MediaV2Quote
  result_quote?: MediaV2Quote
}
/** Local, trusted creation-plan scope; never sent in a vendor request, hash or header. */
export interface MediaV2PlanOrigin {
  planId: string
  sessionId: string
  workspaceRoot: string
  shotIds?: readonly string[]
  assetId?: string
}
/** Optional plan-wide, ordered-shot or single-asset target, validated by the owning plan store. */
export type MediaV2PlanTarget = Pick<MediaV2PlanOrigin, 'shotIds' | 'assetId'>
/** Original operation state; an uncertain submission can only recover its existing receipt. */
export interface MediaV2Record {
  version: 1
  owner: string
  origin?: MediaV2PlanOrigin
  request: MediaV2Request
  state: 'quoting' | 'quoted' | 'quote-rejected' | 'submitting' | 'accepted' | 'unknown'
  quote_failure?: { code: string; message: string }
  configuration_requotes?: MediaV2ConfigurationRequote[]
  quote?: MediaV2Quote
  task?: MediaV2Task
  updated_at: number
  saved?: { key: string; path: string; sha256: string; bytes: number }[]
}
/** Safe runtime failure with a stable code and observed HTTP status. */
export class MediaV2Error extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = 'MediaV2Error' }
}
const REMOTE_CODES = new Set(['invalid_request', 'model_not_available', 'model_version_changed', 'invalid_parameters',
  'reference_required', 'reference_limit_exceeded', 'asset_not_ready', 'asset_not_found', 'asset_binding_mismatch',
  'quote_expired', 'quote_changed', 'operation_conflict', 'operation_unknown', 'insufficient_quota', 'media_capacity_full', 'media_batch_client_unsupported', 'upstream_unavailable'])
function planOrigin(value: unknown): MediaV2PlanOrigin {
  const row = mediaV2Object(value)
  const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0
    && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
  if (!identifier(row.planId) || !identifier(row.sessionId) || typeof row.workspaceRoot !== 'string'
    || !isAbsolute(row.workspaceRoot) || row.workspaceRoot.length > 32768 || /[\u0000-\u001f\u007f]/u.test(row.workspaceRoot)
    || Object.keys(row).some(key => !['planId', 'sessionId', 'workspaceRoot', 'shotIds', 'assetId'].includes(key))
    || row.shotIds !== undefined && (!Array.isArray(row.shotIds) || row.shotIds.length < 1 || row.shotIds.length > 256
      || row.shotIds.some(value => !identifier(value)) || new Set(row.shotIds).size !== row.shotIds.length)
    || row.assetId !== undefined && !identifier(row.assetId) || row.shotIds !== undefined && row.assetId !== undefined) {
    throw new MediaV2Error('invalid_request', '本地创作计划关联无效；请核对原计划和素材目标。', 400)
  }
  return { planId: row.planId, sessionId: row.sessionId, workspaceRoot: row.workspaceRoot,
    ...row.shotIds === undefined ? {} : { shotIds: row.shotIds.filter(identifier) },
    ...row.assetId === undefined ? {} : { assetId: row.assetId } }
}
function sameOperation(left: MediaV2Request, right: MediaV2Request): boolean {
  return isDeepStrictEqual({ ...left, model_version: '' }, { ...right, model_version: '' })
}
function artifactSignature(bytes: Buffer, mime: string): boolean {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
  if (mime === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (['video/mp4', 'video/quicktime', 'audio/mp4'].includes(mime)) return bytes.toString('ascii', 4, 8) === 'ftyp'
  if (mime === 'video/webm') return bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))
  if (mime === 'audio/wav') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
  if (mime === 'image/svg+xml') return /<svg(?:\s|>)/u.test(bytes.subarray(0, 4096).toString('utf8'))
  return true
}
/** One Host-owned runtime. No accepted/unknown operation is submitted a second time. */
export class MediaV2Client {
  private readonly pending = new Map<string, Promise<unknown>>()
  constructor(private readonly options: { baseUrl: string
    directory: string
    timeoutMs: number
    creditsPerYuan: number
    pollIntervalMs?: number
    maxArtifactBytes?: number
    maxUploadBytes?: number
    uploadTimeoutMs?: number
    output?: (signal: AbortSignal) => Promise<CapturedMediaOutput> }) {}

  private path(owner: string, id: string): string {
    return join(this.options.directory, createHash('sha256').update(`${this.options.baseUrl}\n${owner}`).digest('hex'), `${mediaV2UUID(id)}.json`)
  }
  private async read(account: Pick<MediaV2Account, 'owner'>, id: string): Promise<MediaV2Record | undefined> {
    let raw: unknown
    try { raw = JSON.parse(await readFile(this.path(account.owner, id), 'utf8')) }
    catch (error) { if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined; throw error }
    const row = mediaV2Object(raw), request = parseMediaV2Request(row.request)
    if (row.version !== 1 || row.owner !== account.owner || request.client_operation_id !== id
      || !['quoting', 'quoted', 'quote-rejected', 'submitting', 'accepted', 'unknown'].includes(String(row.state))) throw new MediaV2Error('operation_unknown', '原操作记录无法完整核对，请勿重新提交。')
    const result: MediaV2Record = { version: 1, owner: account.owner, request,
      state: row.state as MediaV2Record['state'], updated_at: Number(row.updated_at),
      ...row.origin === undefined ? {} : { origin: planOrigin(row.origin) },
      ...row.quote === undefined ? {} : { quote: parseMediaV2Quote(row.quote) },
      ...row.task === undefined ? {} : { task: parseMediaV2Task(row.task) } }
    if (row.configuration_requotes !== undefined) {
      if (!Array.isArray(row.configuration_requotes) || row.configuration_requotes.length > 256) throw new MediaV2Error('operation_unknown', '原配置报价记录无效。')
      result.configuration_requotes = row.configuration_requotes.map((value) => {
        const action = mediaV2Object(value), next = parseMediaV2Request(action.request), previous = parseMediaV2Quote(action.previous_quote)
        if (typeof action.requested_at !== 'number' || !Number.isFinite(action.requested_at) || !sameOperation(request, next)) {
          throw new MediaV2Error('operation_unknown', '原配置报价请求无法核对。')
        }
        this.matchQuote({ ...request, model_version: previous.model_version }, previous, true)
        return { requested_at: action.requested_at, request: next, previous_quote: previous,
          ...action.result_quote === undefined ? {} : { result_quote: parseMediaV2Quote(action.result_quote) } }
      })
    }
    if (row.quote_failure !== undefined) {
      const failure = mediaV2Object(row.quote_failure)
      if (typeof failure.code !== 'string' || typeof failure.message !== 'string' || failure.message.length > 2000) throw new MediaV2Error('operation_unknown', '原报价拒绝记录无效。')
      result.quote_failure = { code: failure.code, message: failure.message }
    }
    if (row.saved !== undefined) {
      if (!Array.isArray(row.saved) || row.saved.length > 256) throw new MediaV2Error('operation_unknown', '原产物保存记录无效。')
      result.saved = row.saved.map((raw) => {
        const entry = mediaV2Object(raw)
        if (typeof entry.path !== 'string' || !isAbsolute(entry.path) || typeof entry.sha256 !== 'string'
          || !/^[a-f0-9]{64}$/u.test(entry.sha256) || typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1) {
          throw new MediaV2Error('operation_unknown', '原产物保存记录无效。')
        }
        return { key: mediaV2Id(entry.key), path: entry.path, sha256: entry.sha256, bytes: entry.bytes }
      })
    }
    return result
  }
  private async save(record: MediaV2Record): Promise<void> {
    await mkdir(dirname(this.path(record.owner, record.request.client_operation_id)), { recursive: true, mode: 0o700 })
    await writePrivateState(this.path(record.owner, record.request.client_operation_id), JSON.stringify(record) + '\n')
  }
  private async single<T>(account: MediaV2Account, id: string, work: () => Promise<T>): Promise<T> {
    const key = this.path(account.owner, id), previous = this.pending.get(key)
    // Chain the claim synchronously; concurrent callers cannot both see an unclaimed task.
    const operation = (async () => { if (previous !== undefined) await previous.catch(() => undefined); return await work() })()
    this.pending.set(key, operation)
    try { return await operation } finally { if (this.pending.get(key) === operation) this.pending.delete(key) }
  }
  private async json(account: MediaV2Account, path: string, method: 'GET' | 'POST', body: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await account.fetch(`/v1/media-v2${path}`, { method, headers: { accept: 'application/json',
      'X-Yunshu-Media-Batch-Version': '1',
      ...method === 'GET' ? {} : { 'content-type': 'application/json' } },
    ...method === 'GET' ? {} : { body: JSON.stringify(body) }, signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]) })
    const text = (await readMediaBytes(response, 8 * 1024 * 1024, signal)).toString('utf8')
    let row: Record<string, unknown>
    try { row = mediaV2Object(JSON.parse(text)) } catch { throw new MediaV2Error('operation_unknown', '暂时无法核对媒体回执，请查询原操作。', response.status) }
    if (!response.ok || row.success !== true) {
      const error = row.error !== null && typeof row.error === 'object' ? mediaV2Object(row.error) : {}
      const code = typeof error.code === 'string' && REMOTE_CODES.has(error.code) ? error.code : 'operation_unknown'
      const message = REMOTE_CODES.has(code) && typeof error.message === 'string' && error.message.length <= 2000
        ? error.message : '暂时无法核对媒体操作，请保留原任务，不要重复生成。'
      throw new MediaV2Error(code, message, response.status)
    }
    return row.data
  }
  private uploadCeiling(): number {
    const maximum = this.options.maxUploadBytes ?? 50 * 1024 * 1024
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1024 * 1024 * 1024) {
      throw new MediaV2Error('invalid_request', '素材上传部署上限无效。', 500)
    }
    return maximum
  }
  /**
   * Read executable models and published native controls without requesting generation.
   * @param account - Captured account scope and its credential-owning fetch closure.
   * @param signal - Cancellation for this invocation; cancellation never submits another operation.
   * @returns Executable model controls and the current Host product-credit scale.
   */
  async catalog(account: MediaV2Account, signal: AbortSignal): Promise<MediaV2Catalog> {
    const raw = mediaV2Object(await this.json(account, '/models', 'GET', undefined, signal))
    const models = Array.isArray(raw.models) ? raw.models.map((value) => {
      const model = mediaV2Object(value), pricing = mediaV2Object(model.pricing)
      return { ...model, pricing: { ...pricing, credits_per_yuan: this.options.creditsPerYuan } }
    }) : raw.models
    const catalog = parseMediaV2Catalog({ ...raw, models, credits_per_yuan: this.options.creditsPerYuan,
      ...this.options.pollIntervalMs === undefined ? {} : { poll_after_ms: this.options.pollIntervalMs } })
    // This is the Host's effective upload cap, not a claim that an older server declared a larger limit.
    return { ...catalog, capabilities: { ...catalog.capabilities,
      max_upload_bytes: Math.min(this.uploadCeiling(), catalog.capabilities.max_upload_bytes ?? 50 * 1024 * 1024) } }
  }
  /**
   * Intersect published server/material limits with the deployment ceiling before reading a file.
   * @param account - Current credential-owning account.
   * @param model - Exact model selected for this upload.
   * @param signal - Free catalog-read cancellation.
   * @param field - Selected material field; omission permits the largest compatible declared role.
   * @param mime - Known actual MIME, if already inspected by the authorized reader.
   * @returns Effective byte ceiling; an absent server declaration keeps the 50 MiB compatibility limit.
   */
  async uploadLimit(account: MediaV2Account, model: string, signal: AbortSignal, field?: string, mime?: string): Promise<number> {
    const catalog = await this.catalog(account, signal)
    const selected = catalog.models.find(item => item.id === model && item.enabled)
    if (selected === undefined) throw new MediaV2Error('model_not_available', '当前型号暂不可上传素材，请保留原选择并核对目录。', 404)
    const server = catalog.capabilities.max_upload_bytes ?? 50 * 1024 * 1024
    const fields = selected.asset_fields.filter(item => (field === undefined || item.name === field)
      && (mime === undefined || mime === 'application/octet-stream' || item.mime_types.length === 0 || item.mime_types.includes(mime)))
    if (fields.length === 0) throw new MediaV2Error('invalid_parameters', '当前型号或素材字段不支持这种素材，请核对素材用途和格式。', 400)
    const limits = fields.map((item) => {
      const value = item.constraints.max_bytes
      if (value === undefined) return server
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new MediaV2Error('invalid_parameters', '当前素材大小限制无效，请核对型号目录。', 400)
      return value
    })
    return Math.min(server, Math.max(...limits))
  }
  /**
   * Upload exact bytes once. An unknown response must be recovered with assetByClientId.
   * @param account - Captured account scope and its credential-owning fetch closure.
   * @param input - Exact user-selected fields or original file bytes.
   * @param signal - Cancellation for this invocation; cancellation never submits another operation.
   * @returns The immutable original upload receipt; an uncertain upload is queried, never reposted.
   */
  async upload(account: MediaV2Account,
    input: MediaV2UploadInput,
    signal: AbortSignal): Promise<MediaV2Asset> {
    if (input.filename === '' || input.filename.length > 256 || /[\u0000-\u001f\u007f/\\]/u.test(input.filename)
      || !/^[\w.+-]+\/[\w.+-]+$/u.test(input.mime)) throw new MediaV2Error('invalid_request', '素材文件名或格式无效。', 400)
    return await this.single(account, input.clientAssetId, async () => {
      const receiptPath = this.path(account.owner, input.clientAssetId).replace(/\.json$/u, '.upload.json')
      let previous: Record<string, unknown> | undefined
      try { previous = mediaV2Object(JSON.parse(await readFile(receiptPath, 'utf8'))) }
      catch (error) { if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
      const maximum = previous === undefined ? await this.uploadLimit(account, input.model, signal, input.field, input.mime)
        : typeof previous.bytes === 'number' && Number.isSafeInteger(previous.bytes)
          && previous.bytes > 0 && previous.bytes <= 1024 * 1024 * 1024
          ? previous.bytes : 0
      if (maximum < 1) throw new MediaV2Error('asset_binding_mismatch', '原上传大小记录无法核对，请查询原上传编号。')
      const expectedSize = 'bytes' in input ? input.bytes.byteLength : input.size
      if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maximum)) {
        throw new MediaV2Error(previous === undefined ? 'invalid_request' : 'asset_binding_mismatch', '素材为空、超过有效大小限制，或与原上传不一致。', 413)
      }
      await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 })
      const temporary = join(dirname(receiptPath), `.upload-${randomUUID()}.tmp`)
      const transferSignal = AbortSignal.any([signal, AbortSignal.timeout(this.options.uploadTimeoutMs ?? this.options.timeoutMs)])
      try {
        const file = await open(temporary, 'wx', 0o600), hash = createHash('sha256')
        let size = 0
        try {
          const source = 'bytes' in input ? [input.bytes]
            : typeof input.stream === 'function' ? input.stream(transferSignal) : input.stream
          for await (const chunk of source) {
            transferSignal.throwIfAborted()
            if (!(chunk instanceof Uint8Array)) throw new MediaV2Error('invalid_request', '无法读取原素材字节。', 400)
            size += chunk.byteLength
            if (size > maximum) throw new MediaV2Error('invalid_request', '素材超过有效大小限制，未上传或提交生成。', 413)
            hash.update(chunk)
            await file.writeFile(chunk)
          }
          if (size === 0 || expectedSize !== undefined && size !== expectedSize) throw new MediaV2Error('invalid_request', '素材实际大小发生变化，未上传或提交生成。', 400)
          await file.sync()
        } finally { await file.close() }
        transferSignal.throwIfAborted()
        const digest = hash.digest('hex'), claim = { model: mediaV2Id(input.model),
          client_asset_id: mediaV2UUID(input.clientAssetId), sha256: digest, bytes: size }
        if (previous !== undefined) {
          if (previous.model !== claim.model || previous.sha256 !== digest || previous.bytes !== size) throw new MediaV2Error('asset_binding_mismatch', '原上传编号不能改绑到其他素材。')
          const asset = previous.asset === undefined
            ? await this.assetByClientId(account, input.clientAssetId, input.model, transferSignal) : parseMediaV2Asset(previous.asset)
          if (asset.client_asset_id !== input.clientAssetId || asset.model !== input.model
            || asset.sha256 !== digest || asset.bytes !== size) {
            throw new MediaV2Error('asset_binding_mismatch', '原上传回执与素材不匹配。')
          }
          return asset
        }
        await writePrivateState(receiptPath, JSON.stringify(claim) + '\n')
        const boundary = `yunshu-${randomUUID()}`
        const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${claim.model}\r\n--${boundary}\r\nContent-Disposition: form-data; name="client_asset_id"\r\n\r\n${claim.client_asset_id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${input.filename.replaceAll('"', '%22')}"\r\nContent-Type: ${input.mime}\r\n\r\n`)
        const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
        const staged = await open(temporary, 'r')
        const multipart = (async function* () {
          try {
            yield prefix
            for (;;) {
              transferSignal.throwIfAborted()
              const chunk = Buffer.allocUnsafe(1024 * 1024)
              const { bytesRead } = await staged.read(chunk, 0, chunk.byteLength, null)
              if (bytesRead === 0) break
              yield chunk.subarray(0, bytesRead)
            }
            yield suffix
          } finally { await staged.close() }
        })()
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try { const chunk = await multipart.next(); if (chunk.done) controller.close(); else controller.enqueue(chunk.value) }
            catch (error) { controller.error(error) }
          },
          async cancel() { await multipart.return(undefined); await staged.close() },
        })
        const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half', signal: transferSignal,
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}`,
            'content-length': String(prefix.byteLength + size + suffix.byteLength) } }
        let response: Response
        try { response = await account.fetch('/v1/media-v2/assets', init) }
        finally { await body.cancel().catch(() => undefined); await multipart.return(undefined); await staged.close() }
        const row = mediaV2Object(JSON.parse((await readMediaBytes(response, 1024 * 1024, transferSignal)).toString('utf8')))
        if (!response.ok || row.success !== true) {
          throw new MediaV2Error('asset_not_ready', '素材上传结果尚未确认，请查询原上传编号，不要重复上传。', response.status)
        }
        const asset = parseMediaV2Asset(row.data)
        if (asset.client_asset_id !== input.clientAssetId || asset.model !== input.model
          || asset.sha256 !== digest || asset.bytes !== size) {
          throw new MediaV2Error('asset_binding_mismatch', '素材原字节与回执不匹配，尚未提交生成。')
        }
        await writePrivateState(receiptPath, JSON.stringify({ ...claim, asset }) + '\n')
        return asset
      } finally { await unlink(temporary).catch(() => undefined) }
    })
  }
  /**
   * Recover one original upload; this path never repeats its POST.
   * @param account - Captured account scope and its credential-owning fetch closure.
   * @param id - Original persisted operation or upload UUID.
   * @param model - Exact public model ID bound to the upload.
   * @param signal - Cancellation for this invocation; cancellation never submits another operation.
   * @returns The same original model-bound upload receipt, or a failure retaining its identity.
   */
  async assetByClientId(account: MediaV2Account, id: string, model: string, signal: AbortSignal): Promise<MediaV2Asset> {
    const result = parseMediaV2Asset(await this.json(account, `/assets/by-client-id/${mediaV2UUID(id)}?model=${encodeURIComponent(mediaV2Id(model))}`, 'GET', undefined, signal))
    if (result.client_asset_id !== id || result.model !== model) throw new MediaV2Error('asset_binding_mismatch', '原上传素材归属不匹配。')
    return result
  }
  private projectQuote(value: unknown, recovery = false): MediaV2Quote {
    const raw = mediaV2Object(value)
    const quote = parseMediaV2Quote({ ...raw, credits_per_yuan: this.options.creditsPerYuan,
      credits: Math.round(Number(raw.retail_cny) * this.options.creditsPerYuan) })
    this.matchQuoteBatch(quote, quote, recovery)
    return quote
  }
  private matchQuoteBatch(request: MediaV2Request, quote: MediaV2Quote, recovery: boolean): void {
    if (quote.batch === undefined) return
    let batch
    try { batch = parseMediaV2Batch(quote.batch) }
    catch {
      if (recovery) return // Future metadata stays readable but cannot authorize submission or completed output.
      throw new MediaV2Error('quote_changed', '当前批量报价规则无法核对，尚未提交生成。')
    }
    if ((request.parameters.count ?? 1) !== batch.requested_output_count) {
      throw new MediaV2Error('quote_changed', '批量报价数量与原请求不一致，尚未提交生成。')
    }
    if (batch.output_duration_seconds > 0) {
      const duration = quote.parameters.duration ?? quote.parameters.seconds
      if ((typeof duration !== 'number' && typeof duration !== 'string') || Number(duration) !== batch.output_duration_seconds) {
        throw new MediaV2Error('quote_changed', '批量报价时长与原请求不一致，尚未提交生成。')
      }
    }
  }
  private matchQuote(request: MediaV2Request, quote: MediaV2Quote, recovery = false): void {
    if (quote.client_operation_id !== request.client_operation_id || quote.model !== request.model
      || quote.model_version !== request.model_version
      || quote.intent !== request.intent || !isDeepStrictEqual(quote.assets, request.assets)) throw new MediaV2Error('quote_changed', '报价的模型、模式或素材已变化，尚未提交生成。')
    for (const [key, value] of Object.entries(request.parameters)) if (!isDeepStrictEqual(value, quote.parameters[key])) throw new MediaV2Error('quote_changed', '报价调整了已选择参数，尚未提交生成。')
    this.matchQuoteBatch(request, quote, recovery)
  }
  private matchRetainedQuote(record: MediaV2Record, quote: MediaV2Quote, requested?: MediaV2Request, recovery = false): void {
    const requests = [record.request, ...record.configuration_requotes?.map(action => action.request) ?? []]
    const snapshot = requests.find(request => request.model_version === quote.model_version)
    if (snapshot === undefined) throw new MediaV2Error('quote_changed', '报价版本不属于原操作的明确请求，不能提交。')
    this.matchQuote(snapshot, quote, recovery)
    if (record.quote?.quote_id === quote.quote_id && (record.quote.retail_cny !== quote.retail_cny
      || !isDeepStrictEqual(record.quote.batch, quote.batch))) {
      throw new MediaV2Error('operation_conflict', '原报价金额或批量规则已变化，请保留原操作。')
    }
    const hashes = [record.quote?.request_sha256,
      ...record.configuration_requotes?.map(action => action.previous_quote.request_sha256) ?? []]
    if (hashes.some(hash => hash !== undefined && hash !== quote.request_sha256)) {
      throw new MediaV2Error('operation_conflict', '原操作语义哈希不一致，不能重新生成。')
    }
    if (quote.operation_state === 'accepted' && requested !== undefined && quote.model_version !== requested.model_version) {
      const retained = [record.quote,
        ...record.configuration_requotes?.flatMap(action => [action.previous_quote, action.result_quote]) ?? []]
      if (!retained.some(item => item?.quote_id === quote.quote_id && item.model_version === quote.model_version)) {
        throw new MediaV2Error('operation_conflict', '已受理报价不匹配原保留快照，请继续核对原任务。')
      }
    }
  }
  /**
   * Persist the original complete request before asking the server for its free quotation.
   * @param account - Captured account scope and its credential-owning fetch closure.
   * @param input - Exact user-selected fields or original file bytes.
   * @param signal - Cancellation for this invocation; cancellation never submits another operation.
   * @param origin - Optional trusted local plan binding, frozen before the first quote and excluded from the wire.
   * @returns The original operation with its free quote or previously accepted task.
   */
  async quote(account: MediaV2Account, input: unknown, signal: AbortSignal, origin?: MediaV2PlanOrigin): Promise<MediaV2Record> {
    const binding = origin === undefined ? undefined : planOrigin(origin)
    let request: MediaV2Request
    try { request = parseMediaV2Request(input) }
    catch { throw new MediaV2Error('invalid_parameters', '参数或参考素材不完整，请保留草稿并补全；尚未提交生成。', 422) }
    return await this.single(account, request.client_operation_id, async () => {
      const previous = await this.read(account, request.client_operation_id)
      if (previous !== undefined && !isDeepStrictEqual(previous.origin, binding)) {
        throw new MediaV2Error('operation_conflict', '原操作的创作计划关联已冻结，不能省略、补绑或改绑；请查询原编号。')
      }
      if (previous !== undefined && !sameOperation(previous.request, request)) {
        throw new MediaV2Error('operation_conflict', '原操作内容、模式或素材已冻结；修改后请明确开始独立新操作。')
      }
      let record: MediaV2Record = previous ?? { version: 1, owner: account.owner, request, state: 'quoting', updated_at: Date.now(),
        ...binding === undefined ? {} : { origin: binding } }
      if (previous !== undefined && (previous.state !== 'quote-rejected' || previous.quote !== undefined)) {
        try { record = await this.queryOriginal(account, request.client_operation_id, signal) }
        catch (error) {
          previous.state = 'unknown'; previous.updated_at = Date.now(); await this.save(previous); throw error
        }
        if (record.task !== undefined || record.state === 'accepted') return record
        if (!['quoted', 'quote-rejected'].includes(record.state) || record.quote === undefined) {
          throw new MediaV2Error('operation_unknown', '原操作尚未确认未受理，请只查询原编号。')
        }
        // A lost first quotation is recovered with GET only, never another quote POST.
        if (previous.quote === undefined && previous.state === 'quoting') return record
        const catalog = await this.catalog(account, signal)
        const configurable = catalog.capabilities.same_operation_configuration_requote === true
        if (request.model_version !== record.request.model_version && !configurable) {
          throw new MediaV2Error('operation_conflict', '当前服务尚未声明同操作更新配置，请保留原报价。')
        }
        if (configurable) {
          if ((record.configuration_requotes?.length ?? 0) >= 256) throw new MediaV2Error('operation_conflict', '原配置报价历史已满，请保留原记录。')
          record.configuration_requotes = [...record.configuration_requotes ?? [],
            { requested_at: Date.now(), request, previous_quote: record.quote }]
        }
      } else if (previous !== undefined && request.model_version !== previous.request.model_version) {
        throw new MediaV2Error('operation_conflict', '原报价尚无服务器未受理回执，请保留原记录。')
      }
      record.state = 'quoting'; record.updated_at = Date.now(); await this.save(record)
      let reply: unknown
      try { reply = await this.json(account, '/quotes', 'POST', request, signal) }
      catch (error) {
        // A confirmed free-quote validation rejection precedes every task POST. Preserve it separately from an uncertain submission.
        if (error instanceof MediaV2Error && [400, 422].includes(error.status) && ['invalid_request', 'invalid_parameters', 'reference_required',
          'reference_limit_exceeded', 'asset_not_ready', 'asset_not_found', 'asset_binding_mismatch', 'model_not_available',
          'model_version_changed', 'media_batch_client_unsupported'].includes(error.code)) {
          record.state = 'quote-rejected'; record.quote_failure = { code: error.code, message: error.message }; record.updated_at = Date.now(); await this.save(record)
        }
        throw error
      }
      const quote = this.projectQuote(reply)
      if (quote.operation_state === 'quoted') this.matchQuote(request, quote)
      this.matchRetainedQuote(record, quote, request)
      const action = record.configuration_requotes?.at(-1)
      if (action !== undefined && isDeepStrictEqual(action.request, request)) action.result_quote = quote
      // Defaults may be added, but no explicitly selected parameter may be silently rewritten.
      delete record.quote_failure
      record.quote = quote; record.state = quote.operation_state === 'accepted' ? 'accepted' : 'quoted'
      if (quote.task !== undefined) record.task = this.matchTask(record, quote.task)
      record.updated_at = Date.now(); await this.save(record); return record
    })
  }
  /**
   * Submit exactly once, or return/query the original task after any lost response.
   * @param account - Captured account scope and its credential-owning fetch closure.
   * @param id - Original persisted operation or upload UUID.
   * @param signal - Cancellation for this invocation; cancellation never submits another operation.
   * @returns The original task record; only a never-submitted quoted record sends one task POST.
   */
  async submit(account: MediaV2Account, id: string, signal: AbortSignal): Promise<MediaV2Record> {
    mediaV2UUID(id)
    return await this.single(account, id, async () => {
      const record = await this.read(account, id)
      if (record === undefined) throw new MediaV2Error('operation_unknown', '没有找到本机原报价记录，不能创建重复操作。')
      if (record.state !== 'quoted') return await this.queryOriginal(account, id, signal)
      const quote = record.quote
      if (quote === undefined || quote.expires_at * 1000 <= Date.now()) throw new MediaV2Error('quote_expired', '报价已过期，尚未提交生成；请重新核对同一草稿报价。')
      this.matchRetainedQuote(record, quote)
      record.state = 'submitting'; record.updated_at = Date.now(); await this.save(record)
      try {
        const data = mediaV2Object(await this.json(account, '/tasks', 'POST', { quote_id: quote.quote_id,
          client_operation_id: id, request_sha256: quote.request_sha256 }, signal))
        record.task = this.matchTask(record, parseMediaV2Task(data.task)); record.state = 'accepted'
        record.updated_at = Date.now(); await this.save(record); return record
      } catch (error) { record.state = 'unknown'; record.updated_at = Date.now(); await this.save(record); throw error }
    })
  }
  private matchTask(record: MediaV2Record, task: MediaV2Task, recovery = false): MediaV2Task {
    if (task.model !== record.request.model || record.task !== undefined && task.id !== record.task.id) throw new MediaV2Error('operation_conflict', '原任务身份不匹配，保留原操作并停止恢复。')
    if (record.quote?.batch !== undefined || task.batch !== undefined) {
      let frozen, current
      try {
        frozen = parseMediaV2Batch(record.quote?.batch)
        const { received_main_output_count: _received, completeness: _completeness,
          failure_reason: _failure, ...policy } = parseMediaV2TaskBatch(task.batch)
        current = policy
      } catch {
        if (recovery) return task
        throw new MediaV2Error('operation_conflict', '原批量任务规则无法核对，请继续查询原编号。')
      }
      if (!isDeepStrictEqual(frozen, current) || task.status === 'succeeded' && !mediaV2TaskComplete(task, record.quote?.batch)) {
        throw new MediaV2Error('operation_conflict', '原批量任务数量或产物不完整，请保留原操作。')
      }
    }
    return task
  }
  private async queryOriginal(account: MediaV2Account, id: string, signal: AbortSignal): Promise<MediaV2Record> {
    const record = await this.read(account, id)
    if (record === undefined) throw new MediaV2Error('operation_unknown', '没有找到本机原操作，不能补建或重发。', 404)
    if (record.state === 'quote-rejected' && record.quote === undefined) return record
    const raw = mediaV2Object(await this.json(account, `/operations/${mediaV2UUID(id)}`, 'GET', undefined, signal))
    let retainedQuote = raw.quote
    if (retainedQuote !== undefined) {
      const nested = mediaV2Object(retainedQuote)
      // Revision 3 recovery may carry the accepted task beside its retained quote.
      // Bind only that exact operation's task; standalone POST quote validation stays strict.
      if (raw.state === 'accepted' && nested.operation_state === 'accepted' && nested.task === undefined && raw.task !== undefined) {
        const task = parseMediaV2Task(raw.task)
        if (nested.client_operation_id !== id || nested.quote_id !== raw.quote_id || nested.model !== task.model) {
          throw new MediaV2Error('operation_conflict', '原报价和任务身份不匹配，不能重新生成。')
        }
        retainedQuote = { ...nested, task }
      }
    }
    const operation: MediaV2Operation = parseMediaV2Operation({ ...raw,
      ...retainedQuote === undefined ? {} : { quote: this.projectQuote(retainedQuote, true) } })
    if (operation.client_operation_id !== id) throw new MediaV2Error('operation_conflict', '原操作回执不匹配，不能重新生成。')
    if (operation.quote !== undefined) {
      this.matchRetainedQuote(record, operation.quote, undefined, true)
      if (record.quote !== undefined && operation.quote_id !== record.quote.quote_id) {
        const action = record.configuration_requotes?.at(-1)
        if (action === undefined || action.previous_quote.quote_id !== record.quote.quote_id
          || action.result_quote !== undefined || action.request.model_version !== operation.quote.model_version) {
          throw new MediaV2Error('operation_conflict', '新报价没有原操作的明确更新记录，不能重新生成。')
        }
        action.result_quote = operation.quote
      }
      const pending = record.configuration_requotes?.at(-1)
      if (operation.state === 'accepted' && pending !== undefined && pending.result_quote === undefined) pending.result_quote = operation.quote
      record.quote = operation.quote
    }
    if (record.quote !== undefined && operation.quote_id !== record.quote.quote_id) throw new MediaV2Error('operation_conflict', '原报价回执不匹配，不能重新生成。')
    if (operation.state === 'quoted' && operation.task === undefined && record.task === undefined) {
      if (record.state !== 'quote-rejected') { record.state = 'quoted'; delete record.quote_failure }
    }
    if (operation.task !== undefined) {
      const task = mediaV2Object(await this.json(account, `/tasks/${encodeURIComponent(operation.task.id)}`, 'GET', undefined, signal))
      record.task = this.matchTask(record, parseMediaV2Task(task.task), true); record.state = 'accepted'
    }
    record.updated_at = Date.now(); await this.save(record); return record
  }
  /**
   * Query only the retained operation/task; 404 and unknown never delete the local receipt.
   * @param account - Captured account scope and its credential-owning fetch closure.
   * @param id - Original persisted operation or upload UUID.
   * @param signal - Cancellation for this invocation; cancellation never submits another operation.
   * @returns The retained original record updated by GET; failed reads never remove its submission fence.
   */
  async query(account: MediaV2Account, id: string, signal: AbortSignal): Promise<MediaV2Record> {
    return await this.single(account, id, async () => await this.queryOriginal(account, id, signal))
  }
  /**
   * Read the private original record without fetching, requoting or changing its journal.
   * @param account - Only the captured account scope; no credential closure is required.
   * @param id - Exact original operation UUID.
   * @returns The local original record, including its immutable plan origin when present.
   */
  async record(account: Pick<MediaV2Account, 'owner'>, id: string): Promise<MediaV2Record> {
    const record = await this.read(account, id)
    if (record === undefined) throw new MediaV2Error('operation_unknown', '没有找到本机原操作，请保留原编号，不要补建或重发。', 404)
    return record
  }
  /**
   * List this account's original receipts for page/restart recovery without model calls.
   * @param account - Captured account scope and its credential-owning fetch closure.
   * @returns Only this account scope's retained operations, ordered newest first.
   */
  async records(account: Pick<MediaV2Account, 'owner'>): Promise<MediaV2Record[]> {
    const directory = join(this.path(account.owner, '00000000-0000-0000-0000-000000000000'), '..')
    let names: string[]
    try { names = await readdir(directory) } catch (error) { if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []; throw error }
    const results: MediaV2Record[] = []
    for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/iu.test(name))) {
      const record = await this.read(account, name.slice(0, -5)); if (record !== undefined) results.push(record)
    }
    return results.sort((a, b) => b.updated_at - a.updated_at)
  }
  /**
   * Save every original output, retaining partial progress so recovery never generates again.
   * @param account - Captured account scope and its credential-owning fetch closure.
   * @param id - Original persisted operation or upload UUID.
   * @param signal - Cancellation for this invocation; cancellation never submits another operation.
   * @returns The original record with every verified local path; partial saves remain recoverable.
   */
  async saveArtifacts(account: MediaV2Account, id: string, signal: AbortSignal): Promise<MediaV2Record> {
    return await this.single(account, id, async () => {
      const record = await this.queryOriginal(account, id, signal), task = record.task
      if (task === undefined || !mediaV2TaskComplete(task, record.quote?.batch) || task.artifacts.length === 0) throw new MediaV2Error('operation_unknown', '原任务产物尚未齐备，请继续查询原任务。')
      if (this.options.output === undefined) throw new MediaV2Error('artifact_destination_unavailable', '当前产物保存位置不可用，请保留原任务。')
      const output = await this.options.output(signal)
      for (const artifact of [...task.artifacts].sort((a, b) => a.order - b.order)) {
        signal.throwIfAborted()
        const saved = record.saved?.find(item => item.key === artifact.key)
        if (saved !== undefined) {
          try {
            const bytes = await readFile(saved.path)
            if (bytes.length === saved.bytes && createHash('sha256').update(bytes).digest('hex') === saved.sha256) continue
          } catch { /* A removed local output is restored from this same original server task. */ }
        }
        const response = await this.content(account, task.id, artifact.key, { method: 'GET', signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]) })
        if (!response.ok) { await response.body?.cancel(); throw new MediaV2Error('asset_not_found', '原产物下载尚未完成，已保存结果保留；请继续原任务。', response.status) }
        const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
        if (mime !== artifact.mime_type.toLowerCase()) { await response.body?.cancel(); throw new MediaV2Error('artifact_type_mismatch', '原产物文件类型不匹配，请保留原任务。') }
        const bytes = await readMediaBytes(response, this.options.maxArtifactBytes ?? 536_870_912, signal)
        const digest = createHash('sha256').update(bytes).digest('hex')
        if (bytes.length === 0 || !artifactSignature(bytes, artifact.mime_type.toLowerCase())
          || artifact.bytes !== undefined && bytes.length !== artifact.bytes
          || artifact.sha256 !== undefined && digest !== artifact.sha256) {
          throw new MediaV2Error('artifact_integrity_mismatch', '原产物字节尚未完整核对，已保存结果保留，请继续原任务。')
        }
        const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
          'image/svg+xml': 'svg', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a' }
        // A fresh portable filename preserves changed/orphaned local files if a prior save receipt was lost.
        const filename = mediaFilename({ title: artifact.filename ?? artifact.key,
          role: artifact.type === 'audio' ? 'audio' : artifact.type === 'video' ? 'video' : 'image',
          index: artifact.order + 1, extension: extensions[artifact.mime_type] ?? 'bin' })
        const file = await output.write(filename, bytes)
        record.saved = [...record.saved?.filter(item => item.key !== artifact.key) ?? [],
          { key: artifact.key, path: file.path, sha256: digest, bytes: bytes.length }]
        record.updated_at = Date.now(); await this.save(record)
      }
      return record
    })
  }
  /**
   * Authorized fixed-origin artifact response, preserving GET/HEAD/Range and every original key.
   * @param account - Captured account scope and its credential-owning fetch closure.
   * @param id - Original persisted operation or upload UUID.
   * @param key - Original artifact key.
   * @param init - Read-only method, Range headers and cancellation for the fixed content route.
   * @returns The authorized fixed-origin response, preserving the requested GET, HEAD or Range.
   */
  async content(account: MediaV2Account, id: string, key: string, init: RequestInit): Promise<Response> {
    const canonical = `/v1/tasks/${encodeURIComponent(mediaV2Id(id))}/artifacts/${encodeURIComponent(mediaV2Id(key))}/content`
    // This path is generated from opaque IDs, never from a browser/provider URL.
    return await account.fetch(canonical, init)
  }
}
