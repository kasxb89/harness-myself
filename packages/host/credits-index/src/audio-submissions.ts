/** Durable, account- and chat-scoped speech attempts; an existing attempt never authorizes another POST. @module */
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { audioRequestFingerprint, type AudioQuote, type AudioRequest } from './audio-generation.ts'
import { writePrivateState } from './private-state-file.ts'

/** Backend and product account identity captured before quoting or generating. */
export interface AudioOwner { readonly accountId: string; readonly sessionId: string; readonly backend: string }

const requestSchema = z.object({ model: z.string().min(1).max(256), input: z.string().min(1).max(200_000),
  voice: z.string().min(1).max(256), response_format: z.enum(['wav', 'mp3']), speed: z.number().optional(),
  instructions: z.string().max(200_000).optional(),
}).strict().transform((request): AudioRequest => ({ model: request.model, input: request.input, voice: request.voice,
  response_format: request.response_format, ...request.speed === undefined ? {} : { speed: request.speed },
  ...request.instructions === undefined ? {} : { instructions: request.instructions } }))
const submissionSchema = z.object({ version: z.literal(1), id: z.uuid(),
  owner: z.object({ accountId: z.string(), sessionId: z.string(), backend: z.string() }).strict(),
  request: requestSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), quoteId: z.string().min(1).max(256),
  createdAt: z.number().int().positive(), status: z.enum(['pending', 'unknown', 'completed', 'failed']),
  taskId: z.string().max(256).optional(), requestId: z.string().max(256).optional(), code: z.string().max(128).optional(),
  filename: z.string().max(256).optional(), resultHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict()

/** Private persisted attempt; the text and identifiers never leave the authenticated Host. */
export type AudioSubmission = z.infer<typeof submissionSchema>

function sameOwner(left: AudioOwner, right: AudioOwner): boolean {
  return left.accountId === right.accountId && left.sessionId === right.sessionId && left.backend === right.backend
}

/** Private speech attempt storage, separate from immutable Session event formats. */
export class AudioSubmissions {
  constructor(private readonly directory: string) {}
  private scope(owner: AudioOwner): string {
    return join(this.directory, createHash('sha256').update(JSON.stringify([owner.backend, owner.accountId])).digest('hex'))
  }
  private file(owner: AudioOwner, id: string): string {
    if (!z.uuid().safeParse(id).success) throw new Error('Invalid audio submission identity')
    return join(this.scope(owner), `${id}.json`)
  }
  /**
   * Read one exact original attempt; a different chat or account cannot recover it.
   * @param owner - Captured backend, account and chat scope.
   * @param id - Original submission UUID.
   * @returns The validated original record, or absence outside the exact scope.
   */
  async read(owner: AudioOwner, id: string): Promise<AudioSubmission | undefined> {
    const path = this.file(owner, id)
    let bytes: Buffer
    try { bytes = await readFile(path) } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
    if (bytes.length > 1_048_576) throw new Error('Invalid audio submission record')
    const record = submissionSchema.parse(JSON.parse(bytes.toString('utf8')))
    if (!sameOwner(record.owner, owner) || record.id !== id
      || record.fingerprint !== audioRequestFingerprint(record.request)) return undefined
    return record
  }
  /**
   * Atomically claim a new attempt before any dispatch; replay returns its original record.
   * @param owner - Captured backend, account and chat scope.
   * @param id - Stable submission UUID; never replaced to retry an uncertain request.
   * @param request - Validated exact speech parameters.
   * @param quote - Confirmed free estimate for those parameters.
   * @returns The original record and whether this call created its only dispatch claim.
   */
  async claim(
    owner: AudioOwner, id: string, request: AudioRequest, quote: AudioQuote,
  ): Promise<{ created: boolean; record: AudioSubmission }> {
    const path = this.file(owner, id)
    const record: AudioSubmission = { version: 1, id, owner, request, fingerprint: audioRequestFingerprint(request),
      quoteId: quote.quote_id, createdAt: Date.now(), status: 'unknown' }
    submissionSchema.parse(record)
    await mkdir(this.scope(owner), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx', flush: true })
      await link(temporary, path)
    } catch (error) {
      if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
      const original = await this.read(owner, id)
      if (original === undefined || original.fingerprint !== record.fingerprint) throw new Error('Audio submission already belongs to another request')
      return { created: false, record: original }
    }
    finally { await rm(temporary, { force: true }) }
    return { created: true, record }
  }
  /**
   * Publish only validated state for the original attempt.
   * @param record - Complete original record including any known task coordinates.
   */
  async update(record: AudioSubmission): Promise<void> {
    submissionSchema.parse(record)
    await writePrivateState(this.file(record.owner, record.id), JSON.stringify(record))
  }
  /**
   * Save an original result before publishing its playable state; never overwrite a different result.
   * @param record - Existing original attempt.
   * @param bytes - Validated complete WAV or MP3 content.
   * @param filename - Readable, path-free output name with a UUID.
   * @returns The persisted completed record, retaining original task coordinates.
   */
  async save(record: AudioSubmission, bytes: Uint8Array, filename: string): Promise<AudioSubmission> {
    const path = join(this.scope(record.owner), `${record.id}.${record.request.response_format}`)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx', flush: true })
      await link(temporary, path)
    } catch (error) {
      if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
      if (createHash('sha256').update(await readFile(path)).digest('hex') !== hash) throw new Error('Original audio result changed')
    } finally { await rm(temporary, { force: true }) }
    const completed = { ...record, status: 'completed' as const, filename, resultHash: hash }
    await this.update(completed)
    return completed
  }
  /**
   * Read authenticated original bytes by fixed local identity, never an arbitrary saved path.
   * @param record - Exact owner-validated completed attempt.
   * @returns Complete hash-verified original bytes, or absence when not playable.
   */
  async content(record: AudioSubmission): Promise<Buffer | undefined> {
    if (record.status !== 'completed' || record.resultHash === undefined) return undefined
    const bytes = await readFile(join(this.scope(record.owner), `${record.id}.${record.request.response_format}`))
    if (bytes.length > 32 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== record.resultHash) return undefined
    return bytes
  }
  /**
   * Read the most recent attempts for this exact chat; older attempts remain queryable by identity.
   * @param owner - Captured backend, account and chat scope.
   * @returns At most one hundred validated records in descending creation order.
   */
  async list(owner: AudioOwner): Promise<AudioSubmission[]> {
    let files: string[]
    try { files = await readdir(this.scope(owner)) } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
    const records: AudioSubmission[] = []
    for (const file of files) {
      if (!file.endsWith('.json') || !z.uuid().safeParse(file.slice(0, -5)).success) continue
      const record = await this.read(owner, file.slice(0, -5))
      if (record !== undefined) records.push(record)
    }
    return records.toSorted((left, right) => right.createdAt - left.createdAt).slice(0, 100)
  }
}
