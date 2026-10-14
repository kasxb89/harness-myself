/**
 * Host half of the sidebar Credits panel: the client of the relay platform's
 * production API (phone login, balance, WeChat Native top-up).
 *
 * The browser never talks to the platform itself — its JSON entry points are an
 * origin-checked local relay surface, not a CORS API — so every call is proxied
 * here, over HTTPS with normal certificate verification.
 *
 * The session token is kept in the harness credential store when one is
 * mounted, and otherwise in a `0600` file beside the masked account and expiry,
 * so the panel restores a session through `auth/startup` rather than asking for
 * a new code. Idempotency keys arrive from the panel: they belong to the
 * operation the operator is watching, and a retry must reuse the original key
 * with the original parameters.
 *
 * @module @deepseek-ai/dsh-credits-index
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import QRCode from 'qrcode'
import {
  catalogFromPricing,
  mediaModelIds,
  pickModel,
  type ImageParams,
  type ModelCapability,
  type VideoParams,
} from './media.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'credits-index'

/** The route carrier this plugin registers into. */
export const inject = ['webServer', 'tools']

/** Plugin config: platform origin, display rate, and where the session file lives. */
export interface Config {
  /** Platform origin, without a trailing slash. */
  baseUrl?: string
  /** Credit units per yuan, for the panel's conversion line. */
  creditsPerYuan?: number
  /** Directory holding `session.json`; empty uses the harness home. */
  stateDir?: string
  /** Deadline for one platform call, in milliseconds. */
  timeoutMs?: number
  /** Loopback port of the model relay; 0 disables it. */
  relayPort?: number
  /** Credential reference the relay's bearer token lives under. */
  relayTokenEnv?: string
  /** Local new-api origin, without a trailing slash. */
  newApiBaseUrl?: string
  /** Credential reference holding the new-api key. */
  newApiKeyEnv?: string
  /** Local Bridge origin serving the SMS login contract. */
  bridgeBaseUrl?: string
  /** File holding the read-only new-api admin token used to find a user by phone. */
  newApiAdminTokenFile?: string
  /** LLM provider route whose model list follows this deployment's new-api. */
  chatProviderRoute?: string
  /** Settings namespace holding that provider profile. */
  chatSettingsNamespace?: string
}

export const Config: z<Config> = z.object({
  // Empty by default: the harness talks to the local stack only. A non-loopback
  // origin is refused at request time, so no configuration can quietly point
  // this plugin at a production deployment again.
  baseUrl: z.string().default(''),
  creditsPerYuan: z.number().min(1).default(1000),
  stateDir: z.string().default(''),
  timeoutMs: z.number().step(1).min(1).default(15_000),
  relayPort: z.number().step(1).min(1).default(8791),
  relayTokenEnv: z.string().default('YUNSHU_RELAY_TOKEN'),
  newApiBaseUrl: z.string().default('http://127.0.0.1:3000'),
  newApiKeyEnv: z.string().default('YUNSHU_NEWAPI_KEY'),
  bridgeBaseUrl: z.string().default('http://127.0.0.1:4310'),
  newApiAdminTokenFile: z.string().default(''),
  chatProviderRoute: z.string().default('yunshu-local'),
  chatSettingsNamespace: z.string().default('llm-pi-ai'),
})

/** Resolved configuration: schemastery already filled every defaulted field. */
type ResolvedConfig = Required<Config>

/** The single prefix this plugin owns. */
const ROUTE_PREFIX = '/credits'

/**
 * Credential address holding the session token. The store only accepts
 * environment-variable-shaped names (`^[A-Za-z_][A-Za-z0-9_]*$`); anything with
 * a slash belongs to the record key space and makes the whole document
 * unreadable at the next boot.
 */
const TOKEN_REF = 'YUNSHU_SESSION_TOKEN'

/** Masked account facts the panel shows while signed in. */
interface StoredAccount {
  readonly id: string
  readonly phone: string
}

/** One platform call's outcome, normalised for the panel. */
interface PlatformResult {
  readonly status: number
  readonly code: string | null
  readonly message: string | null
  readonly retryAfterSeconds: number | null
  readonly body: unknown
}

/** Persisted sign-in facts; the token lives in the credential store when mounted. */
interface StoredSession {
  /**
   * The product's own session token.
   *
   * This product signs its users in itself: the value below is minted here,
   * never sent to the backend, and expires on the product's own schedule. The
   * backend is the account system of record — it is asked who someone is and
   * what they can spend — but it is not what keeps a client signed in, so a
   * backend token's fifteen minutes have no say in how long this session lasts.
   */
  readonly token?: string | undefined
  /**
   * The backend credential for this account, when the backend handed one out.
   * It is a service credential: used to read that account's own record on the
   * backend, renewed quietly, and never treated as the product's login state —
   * if it lapses the operator stays signed in here and only the backend reads
   * fall back to the read-only lookup.
   */
  readonly upstream?: {
    readonly token?: string | undefined
    readonly refresh?: string | undefined
    readonly expiresAt?: string | undefined
  } | undefined
  /**
   * The signed-in account's own relay credential, minted by the backend at
   * sign-in and owned by that account. Everything the product sends — chat,
   * images, video — uses this, so the usage is billed to whoever is signed in
   * and the balance on screen is the balance being spent. Absent only when the
   * deployment has no per-account credential, in which case the product falls
   * back to its own relay key.
   */
  readonly relay?: { readonly key?: string | undefined; readonly id?: number | undefined } | undefined
  readonly expiresAt: string
  readonly account: StoredAccount
}

/** Write one JSON response. */
function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/**
 * True when an origin names this machine. An empty value counts as loopback
 * because the plugin then simply has no remote backend configured.
 */
function isLoopbackOrigin(origin: string): boolean {
  if (origin === '') return true
  try {
    const { hostname } = new URL(origin)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}

/** Refuse cross-site callers; the listener is loopback-only. */
function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined || origin === 'null') return true
  if (origin === 'dsh-app://app') return true
  try {
    const { hostname, protocol } = new URL(origin)
    if (protocol !== 'http:' && protocol !== 'https:') return false
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}

/** Read one request body as JSON, with a hard ceiling. */
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > 64 * 1024) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object')
  return parsed as Record<string, unknown>
}

/** Read one raw body, bounded; the media upload path never goes through JSON. */
async function readRaw(request: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limitBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** Read a non-empty string field, or null. */
function readString(source: Record<string, unknown> | null, key: string): string | null {
  if (source === null) return null
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/** Read the masked account out of a payload. */
function readAccount(value: unknown): StoredAccount | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = readString(record, 'id')
  const phone = readString(record, 'phone')
  return id === null || phone === null ? null : { id, phone }
}

/**
 * Perform one platform call over HTTPS with normal certificate verification.
 * The `Host` header carries the origin's authority, which the platform's edge
 * routes on.
 */
function platformCall(
  origin: string,
  path: string,
  options: {
    method: 'GET' | 'POST'
    token?: string | undefined
    idempotencyKey?: string | undefined
    body?: unknown
    extraHeaders?: Record<string, string>
    timeoutMs: number
  },
): Promise<PlatformResult> {
  return new Promise((resolve, reject) => {
    const target = new URL(path, origin)
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    const headers: Record<string, string> = { accept: 'application/json', host: target.host }
    if (payload !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(Buffer.byteLength(payload))
    }
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
    if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey
    Object.assign(headers, options.extraHeaders ?? {})
    // The local Bridge answers over plain HTTP; the platform over HTTPS. Pick by
    // protocol rather than assuming one, or the loopback login cannot connect.
    const send = target.protocol === 'http:' ? httpRequest : httpsRequest
    const request = send({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port === '' ? undefined : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: options.method,
      headers,
      timeout: options.timeoutMs,
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk as Buffer))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: unknown = null
        try {
          body = text === '' ? null : JSON.parse(text)
        } catch {
          body = text === '' ? null : text
        }
        const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : null
        const retryAfterHeader = response.headers['retry-after']
        const retryAfter = typeof retryAfterHeader === 'string' ? Number(retryAfterHeader) : Number.NaN
        resolve({
          status: response.statusCode ?? 0,
          code: readString(record, 'error'),
          message: readString(record, 'message'),
          retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
          body,
        })
      })
    })
    request.on('timeout', () => { request.destroy(new Error('platform call timed out')) })
    request.on('error', reject)
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

/** Session storage: credential store when mounted, `0600` file otherwise. */
class SessionStore {
  private cached: StoredSession | null | undefined

  constructor(private readonly ctx: Context, private readonly file: string) {}

  /** The file holding the non-secret half of the session. */
  get path(): string {
    return this.file
  }

  /** Read the stored session, or null when signed out. */
  async read(): Promise<StoredSession | null> {
    if (this.cached !== undefined) return this.cached
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<StoredSession>
      const token = typeof parsed.token === 'string' && parsed.token !== '' ? parsed.token : await this.readCredential()
      const account = readAccount(parsed.account)
      const expiresAt = typeof parsed.expiresAt === 'string' ? parsed.expiresAt : null
      if (token === null || account === null || expiresAt === null) {
        this.cached = null
        return null
      }
      const upstream = parsed.upstream === null || typeof parsed.upstream !== 'object' ? undefined : parsed.upstream
      const relay = parsed.relay === null || typeof parsed.relay !== 'object' ? undefined : parsed.relay
      this.cached = {
        token,
        expiresAt,
        account,
        ...upstream === undefined ? {} : { upstream },
        ...relay === undefined ? {} : { relay },
      }
      return this.cached
    } catch {
      this.cached = null
      return null
    }
  }

  /** Persist one sign-in; the token goes to the credential store when available. */
  async write(session: {
    token: string
    expiresAt: string
    account: StoredAccount
    upstream?: StoredSession['upstream']
    relay?: StoredSession['relay']
  }): Promise<void> {
    // The store is a convenience, never the source of truth: the `0600` file
    // always carries the token, so a store that refuses the write (or a ref the
    // store later rejects) cannot cost the operator their sign-in.
    await this.writeCredential(session.token)
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, `${JSON.stringify({
      token: session.token,
      ...session.upstream === undefined ? {} : { upstream: session.upstream },
      ...session.relay === undefined ? {} : { relay: session.relay },
      expiresAt: session.expiresAt,
      account: session.account,
    }, null, 2)}\n`, { mode: 0o600 })
    this.cached = { ...session }
  }

  /** Forget the session on both halves. */
  async clear(): Promise<void> {
    this.cached = null
    await this.deleteCredential()
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file, '{}\n', { mode: 0o600 })
    } catch {
      // A file that cannot be written is already the signed-out state.
    }
  }

  /**
   * Drop the in-memory copy so the next read comes from disk.
   *
   * The sign-in is one document shared by every host that opens this home, and
   * a renewal rotates the token in place. A process holding the previous copy
   * would validate a token that no longer exists and conclude the operator was
   * signed out — taking the *newer* sign-in down with it. Re-reading before
   * that judgement is what keeps one stale process from logging everyone out.
   */
  invalidate(): void {
    this.cached = undefined
  }

  /** The credential half, or null when no store is mounted or nothing is stored. */
  private async readCredential(): Promise<string | null> {
    const credentials = this.ctx.get('credentials') as { resolve?: (ref: string) => Promise<unknown> } | undefined
    if (credentials?.resolve === undefined) return null
    try {
      const record = await credentials.resolve(TOKEN_REF)
      if (typeof record === 'string') return record
      const key = (record as { key?: unknown } | null)?.key
      return typeof key === 'string' && key !== '' ? key : null
    } catch {
      return null
    }
  }

  /** Write the credential half; false means the token lives in the file instead. */
  private async writeCredential(token: string): Promise<boolean> {
    const credentials = this.ctx.get('credentials') as { set?: (ref: string, value: string) => Promise<void> } | undefined
    if (credentials?.set === undefined) return false
    try {
      await credentials.set(TOKEN_REF, token)
      return true
    } catch {
      return false
    }
  }

  /** Remove the credential half, tolerating an absent store. */
  private async deleteCredential(): Promise<void> {
    const credentials = this.ctx.get('credentials') as {
      deleteRecord?: (ref: string) => Promise<void>
      delete?: (ref: string) => Promise<void>
    } | undefined
    try {
      if (credentials?.deleteRecord !== undefined) await credentials.deleteRecord(TOKEN_REF)
      else if (credentials?.delete !== undefined) await credentials.delete(TOKEN_REF)
    } catch {
      // Nothing stored, or the store refuses removals; the file half is cleared regardless.
    }
  }
}

/**
 * Upload one file as raw bytes, with the exact-length body and filename header
 * the asset endpoint requires (`Content-Length` is always set from the buffer,
 * never left to a chunked transfer).
 */
function platformUpload(
  origin: string,
  path: string,
  options: {
    token: string
    idempotencyKey: string
    mediaType: string
    filename: string
    bytes: Buffer
    timeoutMs: number
  },
): Promise<PlatformResult> {
  return new Promise((resolve, reject) => {
    const target = new URL(path, origin)
    const request = httpsRequest({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port === '' ? undefined : Number(target.port),
      path: target.pathname,
      method: 'POST',
      headers: {
        accept: 'application/json',
        host: target.host,
        authorization: `Bearer ${options.token}`,
        'content-type': options.mediaType,
        'content-length': String(options.bytes.length),
        'x-yunshu-file-name': encodeURIComponent(options.filename),
        'idempotency-key': options.idempotencyKey,
      },
      timeout: options.timeoutMs,
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk as Buffer))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: unknown = null
        try {
          body = text === '' ? null : JSON.parse(text)
        } catch {
          body = text === '' ? null : text
        }
        const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : null
        resolve({
          status: response.statusCode ?? 0,
          code: readString(record, 'error'),
          message: readString(record, 'message'),
          retryAfterSeconds: null,
          body,
        })
      })
    })
    request.on('timeout', () => { request.destroy(new Error('asset upload timed out')) })
    request.on('error', reject)
    request.write(options.bytes)
    request.end()
  })
}

/** Image media types the asset endpoint accepts; this client uploads images only. */
const ALLOWED_ASSET_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

/**
 * Reference video types the local stack accepts. A video-to-video model takes a
 * clip as a reference the same way an image model takes a picture, and the
 * bytes never leave this machine.
 */
const ALLOWED_REFERENCE_VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime'])

/** One reference image on a video manifest. */
interface VideoAssetRef {
  readonly kind: 'reference_image'
  readonly asset_id: string
  readonly order: number
}

/** The video manifest's own shape, as the confirmation fingerprint covers it. */
interface VideoManifest {
  readonly schema: 'yunshu.media.video-confirmation/v1'
  readonly operation_id: string
  readonly prompt: string
  readonly options: {
    readonly duration_seconds: number
    readonly aspect_ratio: '16:9' | '9:16'
    readonly generate_audio: true
    readonly watermark: boolean
  }
  readonly assets: readonly VideoAssetRef[]
  readonly expected_counts: {
    readonly reference_image: number
    readonly reference_video: number
    readonly reference_audio: number
  }
  readonly billing: {
    readonly reserve_points: 0
    readonly points_per_second: number
    readonly settlement: 'actual_duration_seconds'
    readonly pricing_version: string
    readonly billing_mode: 'charge_on_success'
    readonly estimated_cost_points: number
  }
}

/**
 * Canonical JSON for the video fingerprint: object keys sorted at every level,
 * array order preserved, values encoded with `JSON.stringify`, no whitespace.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

/** Extension guessed from a media artifact's content type. */
function extensionFor(mediaType: string): string {
  const base = mediaType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (base === 'image/png') return '.png'
  if (base === 'image/jpeg') return '.jpg'
  if (base === 'image/webp') return '.webp'
  if (base === 'image/gif') return '.gif'
  if (base === 'video/mp4') return '.mp4'
  if (base === 'video/webm') return '.webm'
  if (base === 'video/quicktime') return '.mov'
  return '.bin'
}

/** One saved artifact, or the reason saving failed. */
type SaveOutcome =
  | { readonly ok: true; readonly path: string; readonly bytes: number; readonly mediaType: string }
  | { readonly ok: false; readonly code: string; readonly message: string }

/**
 * Stream one artifact onto disk. The path is the platform's own relative
 * `download_path` resolved against its origin, and the session token is
 * attached here rather than by the caller, so a stray absolute URL cannot carry
 * the operator's session anywhere else.
 */
async function downloadToFile(
  url: URL,
  origin: string,
  token: string,
  directory: string,
  timeoutMs: number,
): Promise<SaveOutcome> {
  if (url.origin !== new URL(origin).origin) {
    return { ok: false, code: 'ARTIFACT_ORIGIN', message: 'download path is outside the platform origin' }
  }
  return await new Promise<SaveOutcome>((resolve, reject) => {
    const request = httpsRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port === '' ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: '*/*', host: url.host },
      timeout: timeoutMs,
    }, response => {
      if (response.statusCode !== 200) {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk as Buffer))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let code = `HTTP_${String(response.statusCode ?? 0)}`
          try {
            const parsed = JSON.parse(text) as { error?: unknown }
            if (typeof parsed.error === 'string') code = parsed.error
          } catch {
            // A non-JSON body leaves the status code as the reason.
          }
          resolve({ ok: false, code, message: text.slice(0, 200) })
        })
        return
      }
      const mediaType = String(response.headers['content-type'] ?? 'application/octet-stream')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const filename = `gen-${stamp}-${randomBytes(3).toString('hex')}${extensionFor(mediaType)}`
      const target = join(directory, filename)
      void (async () => {
        await mkdir(directory, { recursive: true })
        const sink = createWriteStream(target)
        let bytes = 0
        response.on('data', chunk => { bytes += (chunk as Buffer).length })
        response.pipe(sink)
        sink.on('finish', () => { resolve({ ok: true, path: target, bytes, mediaType }) })
        sink.on('error', error => { resolve({ ok: false, code: 'WRITE_FAILED', message: error.message }) })
      })().catch(reject)
    })
    request.on('timeout', () => { request.destroy(new Error('artifact download timed out')) })
    request.on('error', error => { resolve({ ok: false, code: 'TRANSPORT', message: error.message }) })
    request.end()
  })
}

export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const stateDir = resolved.stateDir === ''
    ? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugin-data', 'credits')
    : resolved.stateDir
  const store = new SessionStore(ctx, join(stateDir, 'session.json'))

  /**
   * The signed-in account's own relay credential, or null when nobody is.
   *
   * This is the only key generation ever uses: the product's rule is that using
   * it requires a sign-in, and that whatever the account spends is what its
   * balance shows. There is deliberately no fallback — a fallback would mean a
   * request billed to the operator while the panel displays someone else.
   */
  const accountKey = async (): Promise<{ key: string } | { reason: 'signed-out' | 'no-credential' }> => {
    const session = await store.read()
    if (session?.token === undefined) return { reason: 'signed-out' }
    const key = session.relay?.key
    if (key === undefined || key === '') return { reason: 'no-credential' }
    return { key }
  }

  /** What to say when a generation cannot be sent at all. */
  const noCredential = (reason: 'signed-out' | 'no-credential'): { code: string; message: string } =>
    reason === 'no-credential'
      // A session from before per-account credentials existed: it is a sign-in
      // without a key, and only signing in again can mint one.
      ? { code: 'RELAY_MISSING', message: '这个登录还没有中转凭据，请到「额度」里登出后重新登录一次。' }
      : { code: 'SESSION_REQUIRED', message: '请先在「额度」里用手机号登录，登录后才能生成。' }

  /**
   * Drop the account's relay credential from the credential store.
   *
   * Nothing else has to be told: an unset entry means the chat path simply has
   * no key to send with, which is exactly the rule — using the product requires
   * a sign-in.
   */
  const releaseAccountCredential = async (): Promise<void> => {
    // The shared credential document is not this plugin's to edit; releasing
    // the account means only that this product stops holding its key.
  }

  /**
   * The deployment's own key, read from the file the operator installed.
   *
   * Catalogue reads only — model lists and pricing — never a generation. Its
   * group defines what the product sells, so the picker shows the same set
   * whether or not anyone is signed in.
   */
  const deploymentKey = async (): Promise<string | null> => {
    try {
      const file = (await readFile(join(stateDir, 'newapi-key'), 'utf8')).trim()
      return file === '' ? null : file
    } catch {
      return null
    }
  }

  /**
   * Ask the local new-api which models it serves, split by the endpoint types
   * each one declares. This is the live source the model pickers follow, so a
   * channel added on the new-api side shows up here without any config edit.
   */
  const readNewApiModels = async (): Promise<{ ok: boolean; code?: string; message?: string; chat: string[]; image: string[]; video: string[] }> => {
    const key = await deploymentKey()
    if (key === null) return { ok: false, code: 'NO_KEY', message: 'new-api key 未配置', chat: [], image: [], video: [] }
    try {
      const response = await fetch(`${resolved.newApiBaseUrl}/v1/models`, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(resolved.timeoutMs),
      })
      if (!response.ok) return { ok: false, code: `HTTP_${String(response.status)}`, message: 'new-api 模型列表不可用', chat: [], image: [], video: [] }
      const payload: unknown = await response.json()
      const data = (payload as { data?: unknown })?.data
      const chat: string[] = []
      const image: string[] = []
      const video: string[] = []
      for (const entry of Array.isArray(data) ? data : []) {
        if (entry === null || typeof entry !== 'object') continue
        const record = entry as Record<string, unknown>
        const id = typeof record.id === 'string' ? record.id : null
        if (id === null) continue
        const endpoints = Array.isArray(record.supported_endpoint_types)
          ? record.supported_endpoint_types.filter((value): value is string => typeof value === 'string')
          : []
        if (endpoints.includes('image') || endpoints.includes('image-generation')) image.push(id)
        else if (endpoints.includes('video') || endpoints.includes('video-generation')) video.push(id)
        else chat.push(id)
      }
      return { ok: true, chat, image, video }
    } catch (error) {
      return { ok: false, code: 'TRANSPORT', message: error instanceof Error ? error.message : String(error), chat: [], image: [], video: [] }
    }
  }

  /**
   * The signed-in user's new-api group, which decides the models the panel may
   * offer. The value was written next to the session at sign-in; a record that
   * is missing or stale simply leaves the catalog unfiltered.
   */
  const readUserGroup = async (): Promise<string | null> => {
    try {
      const stored = JSON.parse(await readFile(join(stateDir, 'newapi-user.json'), 'utf8')) as { group?: unknown }
      return typeof stored.group === 'string' && stored.group !== '' ? stored.group : null
    } catch {
      return null
    }
  }

  /**
   * The deployment's own media catalog: `/api/pricing` is public on new-api, so
   * this read needs no credential and follows the running gateway — add a
   * channel on the new-api side and its image and video models, with their real
   * parameter menus, appear in the panels.
   */
  const readMediaCatalog = async (): Promise<{ ok: boolean; code?: string; message?: string; group: string | null; models: ModelCapability[] }> => {
    const group = await readUserGroup()
    try {
      const response = await fetch(`${resolved.newApiBaseUrl}/api/pricing`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(resolved.timeoutMs),
      })
      if (!response.ok) {
        return { ok: false, code: `HTTP_${String(response.status)}`, message: 'new-api 定价表不可用', group, models: [] }
      }
      const body = await response.json() as { data?: unknown }
      const rows = Array.isArray(body.data) ? body.data : []
      return { ok: true, group, models: catalogFromPricing(rows, group) }
    } catch (error) {
      return {
        ok: false,
        code: 'TRANSPORT',
        message: error instanceof Error ? error.message : String(error),
        group,
        models: [],
      }
    }
  }

  /**
   * Reference media the panels attached, kept on this machine between the
   * upload and the generation call that inlines it. new-api takes the bytes
   * with the request, so this is the whole "asset store" the local stack needs.
   */
  const referenceDir = join(stateDir, 'refs')

  const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
  }

  /** Persist one uploaded reference and report where it landed. */
  const storeReference = async (
    assetId: string,
    bytes: Buffer,
    mediaType: string,
    originalName: string,
  ): Promise<{ path: string; filename: string }> => {
    await mkdir(referenceDir, { recursive: true, mode: 0o700 })
    const extension = Object.entries(MEDIA_TYPE_BY_EXTENSION).find(([, type]) => type === mediaType)?.[0] ?? 'bin'
    const filename = `${assetId}.${extension}`
    const target = join(referenceDir, filename)
    await writeFile(target, bytes, { mode: 0o600 })
    await writeFile(`${target}.json`, `${JSON.stringify({ mediaType, originalName }, null, 2)}\n`, { mode: 0o600 })
    return { path: target, filename }
  }

  /** Read one stored reference back, with the media type it was uploaded as. */
  const readReference = async (assetId: string): Promise<{ bytes: Buffer; mediaType: string; filename: string } | null> => {
    if (!/^ma_[A-Za-z0-9]{1,64}$/.test(assetId)) return null
    try {
      const entries = await readdir(referenceDir)
      const match = entries.find(entry => entry.startsWith(`${assetId}.`) && !entry.endsWith('.json'))
      if (match === undefined) return null
      const bytes = await readFile(join(referenceDir, match))
      const meta = JSON.parse(await readFile(join(referenceDir, `${match}.json`), 'utf8')) as { mediaType?: unknown; originalName?: unknown }
      const extension = match.split('.').pop() ?? 'bin'
      return {
        bytes,
        mediaType: typeof meta.mediaType === 'string' ? meta.mediaType : MEDIA_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream',
        filename: typeof meta.originalName === 'string' ? meta.originalName : match,
      }
    } catch {
      return null
    }
  }

  /** A stored reference as the inline string a generation request carries. */
  const referenceDataUrl = async (assetId: string): Promise<{ dataUrl: string; bytes: number } | null> => {
    const file = await readReference(assetId)
    return file === null ? null : { dataUrl: `data:${file.mediaType};base64,${file.bytes.toString('base64')}`, bytes: file.bytes.length }
  }

  /** One media model's capability, or a readable reason it is not callable. */
  const capabilityFor = async (
    kind: 'image' | 'video',
    id: string | null,
  ): Promise<{ ok: true; model: ModelCapability } | { ok: false; code: string; message: string; catalog: ModelCapability[] }> => {
    const catalog = await readMediaCatalog()
    if (!catalog.ok) return { ok: false, code: catalog.code ?? 'CATALOG_FAILED', message: catalog.message ?? '模型表不可用', catalog: [] }
    const model = pickModel(catalog.models, kind, id)
    if (model === null) {
      return {
        ok: false,
        code: id === null ? 'NO_MEDIA_MODEL' : 'MODEL_NOT_AVAILABLE',
        message: id === null
          ? `本机 new-api 当前没有可用的${kind === 'image' ? '生图' : '生视频'}模型`
          : `模型 ${id} 不在你的分组（${catalog.group ?? '未知'}）可用范围内`,
        catalog: catalog.models,
      }
    }
    return { ok: true, model }
  }

  /** What one media generation produced, in the shape both callers report. */
  interface MediaOutcome {
    readonly ok: boolean
    readonly code?: string | undefined
    readonly message?: string | undefined
    readonly model?: string | undefined
    readonly taskId?: string | undefined
    readonly path?: string | undefined
  }

  /**
   * Submit one video job to the local new-api and wait for its file.
   *
   * The body is the superset the gateway's own video plugins decode: `duration`
   * and `resolution` for every family, `metadata.ratio` for the ones that
   * require an explicit ratio, `images` for first/last frames, and
   * `metadata.content` / `metadata.reference_video` for multimodal references.
   * A plugin reads the fields it knows and ignores the rest, which is what lets
   * one call site serve models whose parameters differ.
   */
  const runVideoTask = async (
    key: string,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MediaOutcome> => {
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' }
    try {
      const created = await fetch(`${resolved.newApiBaseUrl}/v1/videos`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: signal ?? AbortSignal.timeout(Math.max(resolved.timeoutMs, 120_000)),
      })
      const createdText = await created.text()
      if (!created.ok) {
        return { ok: false, code: `HTTP_${String(created.status)}`, message: createdText.slice(0, 400) }
      }
      let createdBody: Record<string, unknown> | null = null
      try { createdBody = JSON.parse(createdText) as Record<string, unknown> } catch { createdBody = null }
      const nested = createdBody?.data !== null && typeof createdBody?.data === 'object'
        ? createdBody.data as Record<string, unknown>
        : null
      const taskId = readString(createdBody, 'task_id') ?? readString(createdBody, 'id')
        ?? readString(nested, 'task_id') ?? readString(nested, 'id')
      if (taskId === null) {
        return { ok: false, code: 'NO_TASK_ID', message: createdText.slice(0, 400) }
      }
      // Poll until the task settles. Every read is a plain GET, so a slow
      // provider costs time and nothing else.
      for (let attempt = 0; attempt < 150; attempt += 1) {
        if (signal?.aborted === true) return { ok: false, code: 'ABORTED', message: '任务已取消', taskId }
        await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 4000 : 6000))
        const read = await fetch(`${resolved.newApiBaseUrl}/v1/videos/${encodeURIComponent(taskId)}`, {
          headers, signal: AbortSignal.timeout(resolved.timeoutMs),
        })
        const readText = await read.text()
        let readBody: Record<string, unknown> | null = null
        try { readBody = JSON.parse(readText) as Record<string, unknown> } catch { readBody = null }
        const readNested = readBody?.data !== null && typeof readBody?.data === 'object'
          ? readBody.data as Record<string, unknown>
          : null
        const status = readString(readBody, 'task_status') ?? readString(readBody, 'status')
          ?? readString(readNested, 'task_status') ?? readString(readNested, 'status')
        const result = readNested?.task_result ?? readBody?.task_result
        const videos = result !== null && typeof result === 'object' ? (result as Record<string, unknown>).videos : null
        const first = Array.isArray(videos) ? videos[0] as Record<string, unknown> | undefined : undefined
        const remote = typeof first?.url === 'string' ? first.url : null
        // The gateway answers with `completed`, the vendors with `succeed` /
        // `succeeded` / `success`; all three mean the file is ready, and a
        // body that already carries a URL is ready whatever it calls itself.
        if (status === 'succeed' || status === 'succeeded' || status === 'success' || status === 'completed' || remote !== null) {
          const directory = join(stateDir, 'media')
          await mkdir(directory, { recursive: true })
          const file = join(directory, `vid-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.mp4`)
          const response_ = remote === null
            ? await fetch(`${resolved.newApiBaseUrl}/v1/videos/${encodeURIComponent(taskId)}/content`, {
              headers, signal: AbortSignal.timeout(300_000),
            })
            : await fetch(remote, { signal: AbortSignal.timeout(300_000) })
          if (!response_.ok) {
            return { ok: false, code: 'CONTENT_FAILED', message: `取回视频失败（HTTP ${String(response_.status)}）`, taskId }
          }
          await writeFile(file, Buffer.from(await response_.arrayBuffer()), { mode: 0o600 })
          return { ok: true, taskId, path: file }
        }
        if (status === 'failed' || status === 'fail' || status === 'error' || status === 'cancelled' || status === 'canceled') {
          return { ok: false, code: 'TASK_FAILED', message: readText.slice(0, 400), taskId }
        }
      }
      return { ok: false, code: 'TIMEOUT', message: '任务仍在运行，稍后可在「产物」面板查看。', taskId }
    } catch (error) {
      return { ok: false, code: 'TRANSPORT', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Only stored references reach a request; anything else is dropped. */
  const referenceIds = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.startsWith('ma_')) : []

  /**
   * Turn a panel or tool request into the body the gateway's video plugins
   * decode, refusing anything the chosen model's declared capability would
   * reject — a wrong duration, an unsupported resolution, or a frame/reference
   * combination the model forbids.
   */
  const buildVideoRequest = async (
    model: ModelCapability,
    body: Record<string, unknown>,
  ): Promise<{ ok: true; request: Record<string, unknown> } | { ok: false; code: string; message: string }> => {
    const params = model.params as VideoParams
    const prompt = readString(body, 'prompt') ?? ''
    const duration = typeof body.durationSeconds === 'number'
      ? Math.round(body.durationSeconds)
      : params.durations[0] ?? params.minDuration
    if (params.durations.length > 0 && !params.durations.includes(duration)) {
      return { ok: false, code: 'DURATION_NOT_SUPPORTED', message: `${model.id} 的时长可选：${params.durations.join('、')} 秒` }
    }
    const resolution = readString(body, 'resolution')
    if (resolution !== null && params.resolutions.length > 0 && !params.resolutions.includes(resolution)) {
      return { ok: false, code: 'RESOLUTION_NOT_SUPPORTED', message: `${model.id} 的分辨率可选：${params.resolutions.join('、')}` }
    }
    const ratio = readString(body, 'ratio')
    if (ratio !== null && params.ratios.length > 0 && !params.ratios.includes(ratio)) {
      return { ok: false, code: 'RATIO_NOT_SUPPORTED', message: `${model.id} 的画面比例可选：${params.ratios.join('、')}` }
    }
    // Quality tiers, seed and the audio switch exist only where the vendor's
    // own route reads them; everything else is refused by name rather than
    // silently dropped on the floor.
    const mode = readString(body, 'mode')
    if (mode !== null && params.modes.length > 0 && !params.modes.includes(mode)) {
      return { ok: false, code: 'MODE_NOT_SUPPORTED', message: `${model.id} 的档位可选：${params.modes.join('、')}` }
    }
    const seed = typeof body.seed === 'number' && Number.isInteger(body.seed) ? body.seed : null
    if (seed !== null && !params.seed) {
      return { ok: false, code: 'SEED_NOT_SUPPORTED', message: `${model.id} 不支持随机种子` }
    }
    const audio = typeof body.audio === 'boolean' ? body.audio : null
    if (audio !== null && !params.audioToggle) {
      return { ok: false, code: 'AUDIO_NOT_SUPPORTED', message: `${model.id} 没有音轨开关` }
    }
    const frames = referenceIds(body.frameImages)
    const referenceImages = referenceIds(body.referenceImages)
    const referenceVideos = referenceIds(body.referenceVideos)
    const referenceAudios = referenceIds(body.referenceAudios)
    const caps: readonly [string, number, number][] = [
      ['首尾帧图', frames.length, params.maxFrameImages],
      ['参考图', referenceImages.length, params.maxReferenceImages],
      ['参考视频', referenceVideos.length, params.maxReferenceVideos],
      ['参考音频', referenceAudios.length, params.maxReferenceAudios],
    ]
    for (const [label, used, allowed] of caps) {
      if (used > allowed) {
        return {
          ok: false,
          code: 'REFERENCES_NOT_SUPPORTED',
          message: allowed === 0 ? `${model.id} 不支持${label}` : `${model.id} 最多接受 ${String(allowed)} 个${label}`,
        }
      }
    }
    if (!params.mixFramesAndReferences && frames.length > 0
      && referenceImages.length + referenceVideos.length + referenceAudios.length > 0) {
      return { ok: false, code: 'MIX_NOT_SUPPORTED', message: `${model.id} 不能同时使用首尾帧和参考素材，请只留一种` }
    }

    /** Inline one stored reference; a missing file is a stale panel state. */
    const inline = async (ids: readonly string[]): Promise<string[] | null> => {
      const values: string[] = []
      for (const id of ids) {
        const value = await referenceDataUrl(id)
        if (value === null) return null
        values.push(value.dataUrl)
      }
      return values
    }
    const frameUrls = await inline(frames)
    const imageUrls = await inline(referenceImages)
    const videoUrls = await inline(referenceVideos)
    const audioUrls = await inline(referenceAudios)
    if (frameUrls === null || imageUrls === null || videoUrls === null || audioUrls === null) {
      return { ok: false, code: 'REFERENCE_MISSING', message: '有参考素材已失效，请重新上传' }
    }

    const metadata: Record<string, unknown> = {}
    if (ratio !== null) metadata.ratio = ratio
    // The frame images are named explicitly: the gateway's video plugins read
    // `metadata.first_frame_image` / `last_frame_image` in preference to the
    // positional `images` array, so a model with two slots gets the shot it was
    // told to make rather than whichever one happened to be first.
    if (frameUrls[0] !== undefined) metadata.first_frame_image = frameUrls[0]
    if (frameUrls[1] !== undefined) metadata.last_frame_image = frameUrls[1]
    if (imageUrls.length > 0) {
      // H3 and its siblings take multimodal references as a content array; the
      // text item is prepended so the same call works whether or not the caller
      // spelled the prompt inside `content`.
      metadata.content = [
        { type: 'text', text: prompt },
        ...imageUrls.map(url => ({ type: 'image_url', role: 'reference_image', image_url: { url } })),
      ]
    }
    if (videoUrls.length > 0) metadata.reference_video = videoUrls
    if (audioUrls.length > 0) metadata.reference_audio = audioUrls

    const request: Record<string, unknown> = {
      model: model.id,
      prompt,
      duration,
      // Both spellings travel: plugins read `duration` or `seconds`, and
      // `resolution` or `size`, and each ignores the one it does not know.
      seconds: duration,
      ...resolution === null ? {} : { resolution, size: resolution },
      ...ratio === null ? {} : { ratio, aspect_ratio: ratio },
      ...mode === null || params.modes.length === 0 ? {} : { mode },
      ...seed === null ? {} : { seed },
      ...audio === null || !params.audioToggle ? {} : { generate_audio: audio },
      ...Object.keys(metadata).length === 0 ? {} : { metadata },
      ...frameUrls.length === 0 ? {} : { images: frameUrls },
    }
    return { ok: true, request }
  }

  /**
   * Generate images on the local new-api, one entry point for the panel and the
   * tool. Text-to-image posts the documented JSON body; a request carrying
   * reference images posts multipart to `/images/edits`, which is the shape
   * new-api's own image adapter reads.
   */
  const runImageGeneration = async (
    key: string,
    body: Record<string, unknown>,
  ): Promise<MediaOutcome & { paths?: readonly string[]; mode?: string }> => {
    const prompt = readString(body, 'prompt')
    if (prompt === null) return { ok: false, code: 'INVALID_REQUEST', message: 'prompt 必填' }
    const capability = await capabilityFor('image', readString(body, 'model'))
    if (!capability.ok) {
      return {
        ok: false,
        code: capability.code,
        message: `${capability.message}${capability.catalog.length === 0 ? '' : `（可用：${capability.catalog.map(entry => entry.id).join('、')}）`}`,
      }
    }
    const params = capability.model.params as ImageParams
    const model = capability.model.id
    const size = readString(body, 'size')
    if (size !== null && params.sizes.length > 0 && !params.sizes.includes(size)) {
      return { ok: false, code: 'SIZE_NOT_SUPPORTED', message: `${model} 不支持 ${size}，可选：${params.sizes.join('、')}` }
    }
    const quality = readString(body, 'quality')
    if (quality !== null && params.qualities.length > 0 && !params.qualities.includes(quality)) {
      return { ok: false, code: 'QUALITY_NOT_SUPPORTED', message: `${model} 不支持 ${quality}，可选：${params.qualities.join('、')}` }
    }
    // Every optional field below is "not sent" unless the caller chose one, so
    // a model that has never heard of `background` is never asked about it.
    const background = readString(body, 'background')
    if (background !== null && params.backgrounds.length > 0 && !params.backgrounds.includes(background)) {
      return { ok: false, code: 'BACKGROUND_NOT_SUPPORTED', message: `${model} 不支持背景 ${background}，可选：${params.backgrounds.join('、')}` }
    }
    const format = readString(body, 'format')
    if (format !== null && params.formats.length > 0 && !params.formats.includes(format)) {
      return { ok: false, code: 'FORMAT_NOT_SUPPORTED', message: `${model} 不支持输出格式 ${format}，可选：${params.formats.join('、')}` }
    }
    const moderation = readString(body, 'moderation')
    if (moderation !== null && params.moderations.length > 0 && !params.moderations.includes(moderation)) {
      return { ok: false, code: 'MODERATION_NOT_SUPPORTED', message: `${model} 不支持审核级别 ${moderation}，可选：${params.moderations.join('、')}` }
    }
    const rawCompression = typeof body.compression === 'number' ? Math.round(body.compression) : null
    if (rawCompression !== null && (rawCompression < 0 || rawCompression > 100)) {
      return { ok: false, code: 'COMPRESSION_NOT_SUPPORTED', message: '压缩质量需要在 0–100 之间' }
    }
    const compression = rawCompression !== null && format !== null && format !== 'png' ? rawCompression : null
    const seed = typeof body.seed === 'number' && Number.isInteger(body.seed) ? body.seed : null
    if (seed !== null && !params.seed) {
      return { ok: false, code: 'SEED_NOT_SUPPORTED', message: `${model} 不支持随机种子` }
    }
    const count = typeof body.count === 'number' && Number.isInteger(body.count) ? body.count : 1
    if (count < 1 || count > params.maxCount) {
      return { ok: false, code: 'COUNT_NOT_SUPPORTED', message: `${model} 一次可出 1–${String(params.maxCount)} 张` }
    }
    const references = referenceIds(body.references)
    if (references.length > params.maxEdits) {
      return {
        ok: false,
        code: 'REFERENCES_NOT_SUPPORTED',
        message: params.maxEdits === 0
          ? `${model} 只支持文生图，不能带参考图`
          : `${model} 最多接受 ${String(params.maxEdits)} 张参考图`,
      }
    }
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' }
    /** The optional knobs, spelled the way both the relay and the vendors read them. */
    const extras: Record<string, unknown> = {
      ...size === null ? {} : { size },
      ...quality === null ? {} : { quality },
      ...background === null ? {} : { background },
      ...format === null ? {} : { output_format: format },
      ...compression === null ? {} : { output_compression: compression },
      ...moderation === null ? {} : { moderation },
      ...seed === null ? {} : { seed },
    }
    try {
      // A plugin-served model answers on its own path and hands back a task;
      // the OpenAI host protocol answers inline on `/v1/images/generations`.
      if (capability.model.route !== '/v1/images/generations') {
        const submitted = await fetch(`${resolved.newApiBaseUrl}${capability.model.route}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            prompt,
            n: count,
            ...extras,
          }),
          signal: AbortSignal.timeout(Math.max(resolved.timeoutMs, 60_000)),
        })
        const submittedText = await submitted.text()
        if (!submitted.ok) {
          return { ok: false, model, code: `HTTP_${String(submitted.status)}`, message: submittedText.slice(0, 400) }
        }
        let submittedBody: Record<string, unknown> | null = null
        try { submittedBody = JSON.parse(submittedText) as Record<string, unknown> } catch { submittedBody = null }
        const taskId = readString(submittedBody, 'id') ?? readString(submittedBody, 'task_id')
        if (taskId === null) {
          return { ok: false, model, code: 'NO_TASK_ID', message: submittedText.slice(0, 400) }
        }
        for (let attempt = 0; attempt < 120; attempt += 1) {
          if (attempt > 0) await new Promise(resolve => setTimeout(resolve, attempt < 5 ? 2000 : 4000))
          const read = await fetch(
            `${resolved.newApiBaseUrl}${capability.model.route}/${encodeURIComponent(taskId)}`,
            { headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, signal: AbortSignal.timeout(resolved.timeoutMs) },
          )
          const readText = await read.text()
          let task: Record<string, unknown> | null = null
          try { task = JSON.parse(readText) as Record<string, unknown> } catch { task = null }
          if (task === null) continue
          const status = readString(task, 'status')
          if (status === 'failed' || status === 'error') {
            const error = task.error !== null && typeof task.error === 'object' ? task.error as Record<string, unknown> : null
            return { ok: false, model, code: 'TASK_FAILED', message: readString(error, 'message') ?? readText.slice(0, 300) }
          }
          const result = task.result !== null && typeof task.result === 'object' ? task.result as Record<string, unknown> : null
          const items = Array.isArray(result?.data) ? result.data : []
          const saved: string[] = []
          const directory = join(stateDir, 'media')
          for (const [index, item] of items.entries()) {
            if (item === null || typeof item !== 'object') continue
            const entry = item as Record<string, unknown>
            const remote = readString(entry, 'url')
            const b64 = readString(entry, 'b64_json')
            let bytes: Buffer | null = null
            if (b64 !== null) bytes = Buffer.from(b64, 'base64')
            else if (remote !== null) {
              const image = await fetch(remote, { signal: AbortSignal.timeout(120_000) })
              if (image.ok) bytes = Buffer.from(await image.arrayBuffer())
            }
            if (bytes === null) continue
            await mkdir(directory, { recursive: true })
            const suffix = format === 'jpeg' ? 'jpg' : format === 'webp' ? 'webp' : 'png'
            const file = join(directory, `gen-${new Date().toISOString().replace(/[:.]/g, '-')}-${String(index)}-${randomBytes(3).toString('hex')}.${suffix}`)
            await writeFile(file, bytes, { mode: 0o600 })
            saved.push(file)
          }
          if (saved.length > 0) {
            return { ok: true, model, path: saved[0], paths: saved, mode: 'generate' }
          }
        }
        return { ok: false, model, code: 'TIMEOUT', message: '任务仍在运行，稍后可重试。' }
      }
      const upstream = references.length === 0
        ? await fetch(`${resolved.newApiBaseUrl}/v1/images/generations`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            prompt,
            n: count,
            response_format: 'b64_json',
            ...extras,
          }),
          signal: AbortSignal.timeout(Math.max(resolved.timeoutMs, 180_000)),
        })
        : await (async (): Promise<Response> => {
          const form = new FormData()
          form.set('model', model)
          form.set('prompt', prompt)
          form.set('n', String(count))
          for (const [field, value] of Object.entries(extras)) form.set(field, String(value))
          for (const assetId of references) {
            const file = await readReference(assetId)
            if (file === null) throw new Error(`参考图 ${assetId} 已失效，请重新上传`)
            form.append('image[]', new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }), file.filename)
          }
          return await fetch(`${resolved.newApiBaseUrl}/v1/images/edits`, {
            method: 'POST',
            headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
            body: form,
            signal: AbortSignal.timeout(Math.max(resolved.timeoutMs, 300_000)),
          })
        })()
      const text = await upstream.text()
      if (!upstream.ok) {
        return { ok: false, model, code: `HTTP_${String(upstream.status)}`, message: text.slice(0, 400) }
      }
      let payload: unknown = null
      try { payload = JSON.parse(text) } catch { payload = null }
      const directory = join(stateDir, 'media')
      await mkdir(directory, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const extension = format === 'jpeg' ? 'jpg' : format === 'webp' ? 'webp' : 'png'
      const saved: string[] = []
      /** Write every inline image in one answer; returns how many landed. */
      const saveImages = async (list: readonly unknown[]): Promise<number> => {
        let written = 0
        for (const entry of list) {
          const item = entry !== null && typeof entry === 'object' ? entry as Record<string, unknown> : {}
          const b64 = readString(item, 'b64_json')
          const remote = readString(item, 'url')
          let bytes: Buffer | null = null
          if (b64 !== null) bytes = Buffer.from(b64, 'base64')
          else if (remote !== null) {
            const image = await fetch(remote, { signal: AbortSignal.timeout(120_000) })
            if (!image.ok) continue
            bytes = Buffer.from(await image.arrayBuffer())
          }
          if (bytes === null) continue
          const file = join(directory, `gen-${stamp}-${String(saved.length)}-${randomBytes(3).toString('hex')}.${extension}`)
          await writeFile(file, bytes, { mode: 0o600 })
          saved.push(file)
          written += 1
        }
        return written
      }
      const entries = Array.isArray((payload as { data?: unknown } | null)?.data)
        ? (payload as { data: unknown[] }).data
        : []
      await saveImages(entries)
      /**
       * No image came back inline, but the answer is a task envelope: some
       * upstreams hand one out and the gateway relays it untouched. Read it
       * back on the same path if the deployment registers that read; when it
       * does not, say exactly that instead of "no image data".
       */
      if (saved.length === 0) {
        const record = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : null
        const taskId = readString(record, 'id') ?? readString(record, 'task_id')
        const status = readString(record, 'status')
        if (record !== null && taskId !== null && (record.object === 'generation.task' || status !== null)) {
          for (let attempt = 0; attempt < 45; attempt += 1) {
            if (attempt > 0) await new Promise(resolve => setTimeout(resolve, attempt < 5 ? 2000 : 4000))
            const read = await fetch(`${capability.model.route}/${encodeURIComponent(taskId)}`, {
              headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
              signal: AbortSignal.timeout(resolved.timeoutMs),
            })
            if (!read.ok) {
              const body = await read.text()
              return {
                ok: false,
                model,
                code: 'ASYNC_TASK_NOT_READABLE',
                message: `上游把生图做成了异步任务（task ${taskId}），而本机 new-api 没有回读路由（${capability.model.route}/${'{id}'} 返回 HTTP ${String(read.status)}）。`
                  + `请让 new-api 支持该渠道的任务回读，或改用能直接出图的模型。原始响应：${body.slice(0, 200)}`,
              }
            }
            const readText = await read.text()
            let task: Record<string, unknown> | null = null
            try { task = JSON.parse(readText) as Record<string, unknown> } catch { task = null }
            const taskStatus = readString(task, 'status')
            if (taskStatus === 'failed' || taskStatus === 'error') {
              const error = task?.error !== null && typeof task?.error === 'object' ? task.error as Record<string, unknown> : null
              return { ok: false, model, code: 'TASK_FAILED', message: readString(error, 'message') ?? readText.slice(0, 300) }
            }
            const result = task?.result !== null && typeof task?.result === 'object' ? task.result as Record<string, unknown> : null
            const list = Array.isArray(result?.data) ? result.data : []
            await saveImages(list)
            if (saved.length > 0) break
          }
          if (saved.length > 0) {
            return { ok: true, model, path: saved[0], paths: saved, mode: 'generate' }
          }
          return {
            ok: false,
            model,
            code: 'TIMEOUT',
            message: `上游任务（${taskId}）仍在运行，稍后可在「产物」里看看，或重试。`,
          }
        }
      }
      if (saved.length === 0) {
        return { ok: false, model, code: 'EMPTY_RESULT', message: text.slice(0, 400) || '上游未返回图片数据' }
      }
      return {
        ok: true,
        model,
        path: saved[0],
        paths: saved,
        mode: references.length === 0 ? 'generate' : 'edit',
      }
    } catch (error) {
      return { ok: false, code: 'TRANSPORT', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * The user-level balance on the local new-api, converted to points.
   *
   * The token must have `allow_user_quota_query` on for `user_quota` to appear;
   * the outer `total_available` is the token's own allowance and reads 0 on an
   * unlimited token, so it is never used here. The unit conversion mirrors the
   * new-api console itself: quota → USD by `quota_per_unit`, USD → CNY by
   * `usd_exchange_rate`, CNY → points at the deployment's 1000 points per yuan.
   */
  /** Convert one new-api quota figure into points, using the platform's own parameters. */
  const convertQuota = async (quota: number): Promise<{ points: number; yuan: number }> => {
    let quotaPerUnit = 500_000
    let rate = 7.3
    try {
      const status = await fetch(`${resolved.newApiBaseUrl}/api/status`, { signal: AbortSignal.timeout(resolved.timeoutMs) })
      if (status.ok) {
        const body = await status.json() as { data?: { quota_per_unit?: unknown; usd_exchange_rate?: unknown } }
        if (typeof body.data?.quota_per_unit === 'number' && body.data.quota_per_unit > 0) quotaPerUnit = body.data.quota_per_unit
        if (typeof body.data?.usd_exchange_rate === 'number' && body.data.usd_exchange_rate > 0) rate = body.data.usd_exchange_rate
      }
    } catch {
      // Unreachable status keeps the documented defaults rather than failing the read.
    }
    const yuan = quota / quotaPerUnit * rate
    return { yuan, points: Math.round(yuan * resolved.creditsPerYuan) }
  }

  const readNewApiBalance = async (): Promise<{ ok: boolean; points?: number; yuan?: number; message?: string }> => {
    // Reserved for the no-session fallback; the signed-in path reads the user below.
    const key = await deploymentKey()
    if (key === null) return { ok: false, message: 'new-api key 未配置' }
    try {
      const [usage, status] = await Promise.all([
        fetch(`${resolved.newApiBaseUrl}/api/usage/token/`, {
          headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
          signal: AbortSignal.timeout(resolved.timeoutMs),
        }),
        fetch(`${resolved.newApiBaseUrl}/api/status`, {
          headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
          signal: AbortSignal.timeout(resolved.timeoutMs),
        }),
      ])
      if (!usage.ok) return { ok: false, message: `usage HTTP ${String(usage.status)}` }
      const usageBody = await usage.json() as { data?: { user_quota?: { total_available?: unknown } } }
      const available = usageBody?.data?.user_quota?.total_available
      if (typeof available !== 'number' || !Number.isFinite(available)) {
        return { ok: false, message: '令牌未开启「允许查询用户额度」，user_quota 缺失' }
      }
      let quotaPerUnit = 500_000
      let usdExchangeRate = 7.3
      if (status.ok) {
        const statusBody = await status.json() as { data?: { quota_per_unit?: unknown; usd_exchange_rate?: unknown } }
        if (typeof statusBody?.data?.quota_per_unit === 'number' && statusBody.data.quota_per_unit > 0) {
          quotaPerUnit = statusBody.data.quota_per_unit
        }
        if (typeof statusBody?.data?.usd_exchange_rate === 'number' && statusBody.data.usd_exchange_rate > 0) {
          usdExchangeRate = statusBody.data.usd_exchange_rate
        }
      }
      const yuan = available / quotaPerUnit * usdExchangeRate
      return { ok: true, yuan, points: Math.round(yuan * resolved.creditsPerYuan) }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * The model grant (G) is minted from the session (S) and cached until shortly
   * before it expires; only metadata ever leaves this process, never the key.
   */
  let grant: { baseUrl: string; apiKey: string; expiresAt: string; models: string[]; defaultModelId: string } | null = null

  const ensureGrant = async (force: boolean): Promise<{ ok: boolean; code?: string; message?: string; sessionInvalid?: boolean }> => {
    if (!force && grant !== null && Date.parse(grant.expiresAt) - Date.now() > 60_000) return { ok: true }
    const session = await liveSession()
    if (session?.token === undefined) return { ok: false, code: 'SESSION_INVALID', message: 'not signed in', sessionInvalid: true }
    const result = await platformCall(resolved.baseUrl, '/api/v2/auth/model-grant', {
      method: 'POST', token: (session.upstream?.token ?? ''), body: {}, timeoutMs: resolved.timeoutMs,
    })
    if (result.status === 401 && result.code === 'SESSION_INVALID') {
      await store.clear()
      grant = null
      return { ok: false, code: 'SESSION_INVALID', message: 'session expired', sessionInvalid: true }
    }
    const payload = result.body !== null && typeof result.body === 'object' ? result.body as Record<string, unknown> : null
    const gateway = payload?.model_gateway !== null && typeof payload?.model_gateway === 'object'
      ? payload.model_gateway as Record<string, unknown>
      : null
    const baseUrl = readString(gateway, 'base_url')
    const apiKey = readString(gateway, 'api_key')
    const expiresAt = readString(gateway, 'expires_at')
    if (result.status !== 200 || baseUrl === null || apiKey === null || expiresAt === null) {
      return { ok: false, code: result.code ?? 'GRANT_FAILED', message: result.message ?? 'model grant unavailable' }
    }
    const models = Array.isArray(gateway?.models)
      ? gateway.models.filter((item): item is string => typeof item === 'string')
      : []
    grant = { baseUrl, apiKey, expiresAt, models, defaultModelId: readString(gateway, 'default_model_id') ?? models[0] ?? '' }
    return { ok: true }
  }

  /**
   * Run one authenticated call; a dead session clears the stored sign-in and
   * reports `sessionInvalid` so the panel returns to the login form.
   */
  const withToken = async (
    run: (token: string) => Promise<PlatformResult>,
  ): Promise<{ result: PlatformResult; sessionInvalid: boolean }> => {
    const session = await liveSession()
    if (session?.token === undefined) {
      return {
        result: { status: 401, code: 'SESSION_INVALID', message: 'not signed in', retryAfterSeconds: null, body: null },
        sessionInvalid: true,
      }
    }
    const result = await run((session.upstream?.token ?? ''))
    if (result.status === 401 && result.code === 'SESSION_INVALID') {
      await store.clear()
      return { result, sessionInvalid: true }
    }
    return { result, sessionInvalid: false }
  }

  /** Phone remembered from the last challenge, so verification can find its user. */
  let challengePhone: string | null = null

  /** The `new_api_refresh` value inside one response's `Set-Cookie` headers. */
  const refreshFromSetCookie = (response: Response): string | null => {
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? '']
    for (const cookie of cookies) {
      const match = /(?:^|[,;]\s*)new_api_refresh=([^;,\s]+)/.exec(cookie)
      if (match?.[1] !== undefined && match[1] !== '') return match[1]
    }
    return null
  }

  /**
   * Trade the stored refresh cookie for a fresh access token.
   *
   * new-api issues a short-lived access token and a long-lived refresh cookie
   * at sign-in. Without this exchange the operator is sent back to the code
   * form every few minutes; with it, a sign-in lasts as long as the session
   * does. The cookie rotates, so whatever comes back replaces what was stored.
   */
  /**
   * One renewal at a time, and that is not an optimisation: the deployment
   * rotates the refresh token on every exchange, so two renewals racing each
   * other leave one of them holding a token that has just been invalidated —
   * which reads as "your session was revoked" and signs the operator out. The
   * panels poll two endpoints, so the race is the normal case, not the rare
   * one.
   */
  let renewal: Promise<StoredSession | null> | null = null
  let lastRenewalAttempt = 0
  let renewalReported = false

  const refreshSession = async (refresh: string): Promise<StoredSession | null> => {
    if (renewal !== null) return await renewal
    const attempt = exchangeRefreshToken(refresh)
    renewal = attempt
    try {
      return await attempt
    } finally {
      renewal = null
    }
  }

  const exchangeRefreshToken = async (refresh: string): Promise<StoredSession | null> => {
    try {
      const answered = await fetch(`${resolved.newApiBaseUrl}/api/user/auth/refresh`, {
        method: 'POST',
        headers: {
          cookie: `new_api_refresh=${refresh}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(resolved.timeoutMs),
      })
      const text = await answered.text()
      let payload: {
        success?: boolean
        data?: { access_token?: unknown; access_expires_at?: unknown; user?: { id?: unknown; phone_e164?: unknown } }
      } = {}
      try {
        if (text !== '') payload = JSON.parse(text) as typeof payload
      } catch {
        payload = {}
      }
      const token = typeof payload.data?.access_token === 'string' ? payload.data.access_token : null
      if (payload.success !== true || token === null) return null
      const previous = await store.read()
      const account = previous?.account ?? {
        id: String(payload.data?.user?.id ?? ''),
        phone: String(payload.data?.user?.phone_e164 ?? ''),
      }
      const expiresAtSeconds = typeof payload.data?.access_expires_at === 'number' ? payload.data.access_expires_at : null
      const expiresAt = expiresAtSeconds === null ? '' : new Date(expiresAtSeconds * 1000).toISOString()
      const rotated = refreshFromSetCookie(answered) ?? refresh
      if (previous?.token === undefined) return null
      // Only the backend credential is renewed here; the product's own session
      // token and its expiry are untouched by anything the backend says.
      const upstream = { token, refresh: rotated, expiresAt }
      await store.write({
        token: previous.token,
        expiresAt: previous.expiresAt,
        account,
        upstream,
      })
      return { token: previous.token, expiresAt: previous.expiresAt, account, upstream }
    } catch {
      return null
    }
  }

  /**
   * The stored session, renewed first when its access token is at or near its
   * end. A renewal that fails leaves the stale session in place: the caller's
   * own read is what decides whether the sign-in is really over.
   */
  const liveSession = async (): Promise<StoredSession | null> => {
    const session = await store.read()
    if (session?.token === undefined) return session
    const expiresAt = Date.parse(session.expiresAt)
    // The product's session ends when the product says so, not when a backend
    // token lapses.
    if (!Number.isNaN(expiresAt) && expiresAt - Date.now() <= 0) {
      await store.clear()
      await releaseAccountCredential()
      return null
    }
    /**
     * The backend credential is renewed quietly in the background. It is not
     * part of the sign-in: if it lapses, this session stands and the backend is
     * still readable through the read-only account lookup.
     */
    const upstreamExpiry = session.upstream?.expiresAt === undefined
      ? Number.NaN
      : Date.parse(session.upstream.expiresAt)
    if (!Number.isNaN(upstreamExpiry) && upstreamExpiry - Date.now() < 5 * 60_000
      && session.upstream?.refresh !== undefined
      && Date.now() - lastRenewalAttempt > 5 * 60_000) {
      /**
       * Backed off on purpose. The panels poll, so a renewal that keeps being
       * refused would otherwise be retried (and logged) on every poll — a dead
       * credential is a fact to report once, not a fault to shout about every
       * few seconds.
       */
      lastRenewalAttempt = Date.now()
      void refreshSession(session.upstream.refresh).then(renewed => {
        if (renewed !== null) {
          renewalReported = false
          return
        }
        if (!renewalReported) {
          renewalReported = true
          console.log(
            '[credits-index] the backend credential lapsed; the balance is read through the'
            + ' read-only account lookup instead, and the sign-in stands.',
          )
        }
      })
    }
    return session
  }

  /** The signed-in user's own record on new-api, or null when it is not readable. */
  const readSelf = async (token: string): Promise<{ id: number; username: string; group: string; quota: number; phone: string } | null> => {
    const answered = await fetch(`${resolved.newApiBaseUrl}/api/user/self`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(resolved.timeoutMs),
    }).catch(() => null)
    if (answered === null || !answered.ok) return null
    const body = await answered.json().catch(() => null) as {
      success?: boolean
      data?: { id?: unknown; username?: unknown; group?: unknown; quota?: unknown; phone_e164?: unknown }
    } | null
    if (body?.success !== true) return null
    const quota = typeof body.data?.quota === 'number' ? body.data.quota : null
    if (quota === null) return null
    return {
      id: typeof body.data?.id === 'number' ? body.data.id : 0,
      username: typeof body.data?.username === 'string' ? body.data.username : '',
      group: typeof body.data?.group === 'string' ? body.data.group : '',
      quota,
      phone: typeof body.data?.phone_e164 === 'string' ? body.data.phone_e164 : '',
    }
  }

  /** The phone's new-api user, found with the read-only admin token. */
  const lookupNewApiUser = async (phone: string): Promise<{ id: number; username: string; group: string; quota: number } | null> => {
    const file = resolved.newApiAdminTokenFile !== ''
      ? resolved.newApiAdminTokenFile
      : join(stateDir, '..', 'credentials', 'newapi-admin-read-token')
    let token: string
    try {
      token = (await readFile(file, 'utf8')).trim()
    } catch {
      return null
    }
    if (token === '') return null
    const keyword = phone.replace(/[^0-9]/g, '')
    const response = await fetch(`${resolved.newApiBaseUrl}/api/user/search?keyword=${keyword}&p=1&page_size=20`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(resolved.timeoutMs),
    })
    if (!response.ok) return null
    const body = await response.json() as { data?: { items?: unknown[] } }
    const items = Array.isArray(body?.data?.items) ? body.data.items : []
    const first = items[0] as Record<string, unknown> | undefined
    if (first === undefined) return null
    const id = typeof first.id === 'number' ? first.id : null
    const username = typeof first.username === 'string' ? first.username : null
    const group = typeof first.group === 'string' ? first.group : null
    if (id === null || username === null || group === null) return null
    return { id, username, group, quota: typeof first.quota === 'number' ? first.quota : 0 }
  }

  /** Persist the resolved user beside the session so the panels can show their points. */
  const writeNewApiUser = async (phone: string, user: { id: number; username: string; group: string; quota: number }): Promise<void> => {
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'newapi-user.json'), `${JSON.stringify({ phone, ...user }, null, 2)}\n`, { mode: 0o600 })
  }

  const reply = (response: ServerResponse, result: PlatformResult): void => {
    json(response, 200, {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      code: result.code,
      message: result.message ?? result.code,
      retryAfterSeconds: result.retryAfterSeconds,
      payload: result.body,
    })
  }

  const sessionExpired = (response: ServerResponse): void => {
    json(response, 200, { ok: false, code: 'SESSION_INVALID', message: 'session expired', sessionInvalid: true })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request, response) => {
      if (!originAllowed(request.headers.origin)) {
        json(response, 403, { ok: false, code: 'FORBIDDEN_ORIGIN' })
        return
      }
          /**
           * Anything that would leave the machine is refused before it is built:
           * the deployment runs against the local stack, and a production origin
           * must never be reachable from this plugin again.
           */
          if (!isLoopbackOrigin(resolved.baseUrl)) {
            json(response, 200, {
              ok: false,
              code: 'PLATFORM_DISABLED',
              message: '远程平台未启用：本部署只连接本机服务（baseUrl 必须是 127.0.0.1/localhost）。',
            })
            return
          }
          /**
           * One address, and it is this machine's. The product ships with a
           * single relay baked in; a configuration that points somewhere else
           * is refused here rather than quietly sending a customer's prompts to
           * a host nobody chose.
           */
          if (!isLoopbackOrigin(resolved.newApiBaseUrl)) {
            json(response, 200, {
              ok: false,
              code: 'RELAY_DISABLED',
              message: '本产品只允许连接内置的中转地址（本机 new-api），不能改成其他请求地址。',
            })
            return
          }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const route = url.pathname.slice(ROUTE_PREFIX.length)
      const method = request.method ?? 'GET'

      try {
        if (route === '/api/session' && method === 'GET') {
          const session = await liveSession()
          if (session === null) {
            json(response, 200, {
              ok: true,
              signedIn: false,
              signOutReason: 'no-session',
              creditsPerYuan: resolved.creditsPerYuan,
              statePath: store.path,
              payload: { signedIn: false, creditsPerYuan: resolved.creditsPerYuan, account: null, expiresAt: null },
            })
            return
          }
          /**
           * The product decides whether this client is signed in; the backend is
           * consulted only so the account facts stay honest. A backend that is
           * briefly unreachable — or a service credential that lapsed — leaves
           * the sign-in standing and reports `unknown`, because the alternative
           * is throwing an operator out of their own product over a hiccup in
           * the service that merely holds their balance.
           */
          const backend = await lookupNewApiUser(session.account.phone).catch(() => null)
          const self = backend === null && session.upstream?.token !== undefined
            ? await readSelf(session.upstream.token)
            : null
          const account = backend === null
            ? session.account
            : { id: String(backend.id), phone: session.account.phone }
          const liveness = backend !== null || self !== null ? 'verified' : 'unknown'
          json(response, 200, {
            ok: true,
            signedIn: true,
            liveness,
            creditsPerYuan: resolved.creditsPerYuan,
            account,
            expiresAt: session.expiresAt,
            statePath: store.path,
            // The panels read the `payload` envelope, so the same facts ship
            // both flat (handy from curl) and wrapped (what the UI consumes).
            payload: {
              signedIn: true,
              liveness,
              creditsPerYuan: resolved.creditsPerYuan,
              account,
              expiresAt: session.expiresAt,
            },
          })
          return
        }

        if (route === '/api/session/challenge' && method === 'POST') {
          const body = await readJson(request)
          const phone = readString(body, 'phone')
          const key = readString(body, 'idempotencyKey')
          if (phone === null || key === null) {
            json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: 'phone 与 idempotencyKey 必填' })
            return
          }
          challengePhone = phone
          // Phone sign-in now lives in new-api itself; the Bridge is out of the picture.
          const challenge = await fetch(`${resolved.newApiBaseUrl}/api/user/phone/challenge`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ phone_e164: phone }),
            signal: AbortSignal.timeout(resolved.timeoutMs),
          })
          // A 429 answers with an empty body, so parsing must never be the thing
          // that reports the failure.
          const challengeText = await challenge.text()
          let challengeBody: {
            success?: boolean
            message?: string
            data?: { resend_after_seconds?: unknown; expires_in_minutes?: unknown; dev_code?: unknown; challenge_id?: unknown }
          } = {}
          try {
            if (challengeText !== '') challengeBody = JSON.parse(challengeText) as typeof challengeBody
          } catch {
            challengeBody = {}
          }
          if (challengeBody.success === true) {
            json(response, 200, {
              ok: true,
              payload: {
                challenge_id: typeof challengeBody.data?.challenge_id === 'string' ? challengeBody.data.challenge_id : phone,
                phone,
                resend_after_seconds: typeof challengeBody.data?.resend_after_seconds === 'number' ? challengeBody.data.resend_after_seconds : 60,
                dev_code: typeof challengeBody.data?.dev_code === 'string' ? challengeBody.data.dev_code : null,
              },
            })
          } else {
            json(response, 200, {
              ok: false,
              code: challenge.status === 429 ? 'PHONE_RATE_LIMITED' : 'PHONE_CHALLENGE_FAILED',
              message: challengeBody.message
                ?? (challenge.status === 429
                  ? '发码过于频繁（每 IP 20 次/20 分钟，每个号码 60 秒冷却），请稍后再试。'
                  : `发码失败（HTTP ${String(challenge.status)}）`),
            })
          }
          return
        }

        if (route === '/api/session/verify' && method === 'POST') {
          const body = await readJson(request)
          const challengeId = readString(body, 'challengeId')
          const code = readString(body, 'code')
          const key = readString(body, 'idempotencyKey')
          if (challengeId === null || code === null || key === null) {
            json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: 'challengeId、code 与 idempotencyKey 必填' })
            return
          }
          const phoneForLogin = challengePhone ?? challengeId
          const login = await fetch(`${resolved.newApiBaseUrl}/api/user/phone/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ phone_e164: phoneForLogin, code }),
            signal: AbortSignal.timeout(resolved.timeoutMs),
          })
          /**
           * A limited or throttled backend answers with an empty body, so the
           * reply is read as text and parsed only when there is something to
           * parse. `login.json()` on an empty body throws away the status that
           * explains what actually happened.
           */
          const loginText = await login.text()
          let loginBody: {
            success?: boolean
            message?: string
            data?: {
              access_token?: unknown
              access_expires_at?: unknown
              relay_key?: unknown
              relay_key_id?: unknown
              user?: { id?: unknown; username?: unknown; phone_e164?: unknown; group?: unknown; quota?: unknown }
            }
          } = {}
          try {
            if (loginText !== '') loginBody = JSON.parse(loginText) as typeof loginBody
          } catch {
            loginBody = {}
          }
          if (loginBody.success !== true && login.status === 429) {
            json(response, 200, {
              ok: false,
              code: 'PHONE_RATE_LIMITED',
              message: '验证码请求过于频繁（每 IP 20 次/20 分钟、每个号码 60 秒冷却），请稍后再试。',
            })
            return
          }
          const payload = loginBody.data ?? null
          const token = typeof payload?.access_token === 'string' ? payload.access_token : null
          const rawPhone = typeof payload?.user?.phone_e164 === 'string' ? payload.user.phone_e164 : phoneForLogin
          const account = { id: String(payload?.user?.id ?? ''), phone: rawPhone }
          const expiresAtSeconds = typeof payload?.access_expires_at === 'number' ? payload.access_expires_at : null
          const expiresAt = expiresAtSeconds === null ? '' : new Date(expiresAtSeconds * 1000).toISOString()
          if (loginBody.success === true && token !== null && account.id !== '') {
            /**
             * The phone exchange authenticates; it does not become the session.
             * What is stored is this product's own token with its own thirty-day
             * life, beside the backend credential the exchange produced — the
             * one is the login, the other is how the account's balance is read.
             * Conflating them is what made a fifteen-minute backend token end a
             * desktop session.
             */
            const sessionToken = randomBytes(32).toString('hex')
            const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
            const refresh = refreshFromSetCookie(login) ?? undefined
            /**
             * The account's own relay credential, when the backend mints one.
             * It is what makes "signed in" and "being billed" the same person:
             * the product sends every request with it, so usage lands on this
             * account and the balance on screen is the balance being spent.
             */
            const relayKey = typeof payload?.relay_key === 'string' && payload.relay_key !== ''
              ? payload.relay_key
              : undefined
            const relayId = typeof payload?.relay_key_id === 'number' ? payload.relay_key_id : undefined
            await store.write({
              token: sessionToken,
              expiresAt: sessionExpiresAt,
              account,
              upstream: {
                token,
                ...refresh === undefined ? {} : { refresh },
                ...expiresAt === '' ? {} : { expiresAt },
              },
              ...relayKey === undefined ? {} : { relay: { key: relayKey, ...relayId === undefined ? {} : { id: relayId } } },
            })
            /**
             * Deliberately not written into the shared credential document: that
             * file also carries the desktop shell's own browser session, and a
             * plugin rewriting it can drop entries it does not know about. The
             * account's key lives in this product's own session file, which is
             * the one place that describes who is signed in.
             */
            // Resolve the phone to its new-api user now, so the panels can show
            // that person's quota and model group from the first render.
            const user = await lookupNewApiUser(rawPhone).catch(() => null)
            if (user !== null) await writeNewApiUser(rawPhone, user)
            json(response, 200, { ok: true, payload: { status: 'authorized', expiresAt: sessionExpiresAt, account } })
          } else {
            json(response, 200, { ok: false, code: 'PHONE_LOGIN_FAILED', message: loginBody.message ?? '验证码错误或已过期' })
          }
          return
        }

        if (route === '/api/session/logout' && method === 'POST') {
          // Sign-out happens on new-api like everything else; the local sign-in
          // is cleared regardless of what the server answers, because a failed
          // revoke must not leave the operator stuck signed in.
          const session = await liveSession()
          let result: PlatformResult = { status: 204, code: null, message: null, retryAfterSeconds: null, body: null }
          if (session?.token !== undefined) {
            const response_ = await fetch(`${resolved.newApiBaseUrl}/api/user/logout`, {
              method: 'POST',
              headers: { authorization: `Bearer ${(session.upstream?.token ?? '')}`, 'content-type': 'application/json', accept: 'application/json' },
              body: '{}',
              signal: AbortSignal.timeout(resolved.timeoutMs),
            }).catch(() => null)
            result = {
              status: response_?.status ?? 503,
              code: null,
              message: null,
              retryAfterSeconds: null,
              body: null,
            }
          }
          await store.clear()
          await releaseAccountCredential()
          reply(response, result)
          return
        }

        if (route === '/api/summary' && method === 'GET') {
          // The signed-in user's own quota is the balance of record: one ledger,
          // read straight from new-api, never recomputed from usage here.
          //
          // It is read live rather than from the sign-in snapshot, because the
          // panels poll this while a generation runs: a frozen number would keep
          // showing the balance someone had before they spent anything.
          const live = await liveSession()
          /**
           * No sign-in, no balance. The panel's state and its number come from
           * the same place, so a signed-out surface can never show a leftover
           * figure from whoever was signed in before.
           */
          if (live?.token === undefined) {
            json(response, 200, {
              ok: true,
              source: 'signed-out',
              signedIn: false,
              creditsPerYuan: resolved.creditsPerYuan,
              account: null,
              balance: null,
              payload: { signedIn: false, balance_points: null, yuan: null, source: 'signed-out' },
            })
            return
          }
          {
            /**
             * The backend is asked about *this account*, by the identity the
             * product signed in — not by a client session it happens to hold.
             * The read-only account lookup is the primary path (it needs no
             * per-user credential to stay alive), with this account's own
             * backend session as the fallback.
             */
            const account = await lookupNewApiUser(live.account.phone).catch(() => null)
            const self = account ?? (live.upstream?.token === undefined ? null : await readSelf(live.upstream.token))
            if (self !== null) {
              const converted = await convertQuota(self.quota)
              await writeNewApiUser(live.account.phone, {
                id: self.id,
                username: self.username,
                group: self.group,
                quota: self.quota,
              }).catch(() => undefined)
              const group = account === null ? (self as { group?: string }).group ?? '' : account.group
              json(response, 200, {
                ok: true,
                source: 'newapi-account',
                creditsPerYuan: resolved.creditsPerYuan,
                account: { phone: live.account.phone, group },
                balance: { credits: converted.points, yuan: converted.yuan },
                payload: { balance_points: converted.points, yuan: converted.yuan, source: 'newapi-account' },
              })
              return
            }
          }
          try {
            const stored = JSON.parse(await readFile(join(stateDir, 'newapi-user.json'), 'utf8')) as {
              phone?: unknown
              username?: unknown
              group?: unknown
              quota?: unknown
            }
            if (typeof stored.quota === 'number') {
              const converted = await convertQuota(stored.quota)
              json(response, 200, {
                ok: true,
                source: 'newapi-user',
                creditsPerYuan: resolved.creditsPerYuan,
                account: { phone: typeof stored.phone === 'string' ? stored.phone : '', group: typeof stored.group === 'string' ? stored.group : '' },
                balance: { credits: converted.points, yuan: converted.yuan },
                payload: { balance_points: converted.points, yuan: converted.yuan, source: 'newapi-user' },
              })
              return
            }
          } catch {
            // No resolved user yet: fall through to the token-scoped read.
          }
          // The deployment's balance of record is the local new-api user quota;
          // the platform balance stays available as a secondary reading.
          const local = await readNewApiBalance()
          if (local.ok && local.points !== undefined && local.yuan !== undefined) {
            json(response, 200, {
              ok: true,
              source: 'newapi',
              creditsPerYuan: resolved.creditsPerYuan,
              balance: { credits: local.points, yuan: local.yuan },
              payload: { balance_points: local.points, yuan: local.yuan, source: 'newapi' },
            })
            return
          }
          const { result, sessionInvalid } = await withToken(token => platformCall(resolved.baseUrl, '/api/v1/account/balance', {
            method: 'GET', token, timeoutMs: resolved.timeoutMs,
          }))
          if (sessionInvalid) { sessionExpired(response); return }
          const payload = result.body !== null && typeof result.body === 'object' ? result.body as Record<string, unknown> : null
          const points = typeof payload?.balance_points === 'number' ? payload.balance_points : null
          json(response, 200, {
            ok: result.status === 200,
            code: result.code,
            message: result.message,
            creditsPerYuan: resolved.creditsPerYuan,
            source: 'platform',
            localError: local.message ?? null,
            balance: points === null ? null : { credits: points, yuan: points / resolved.creditsPerYuan },
            payload: points === null ? null : { balance_points: points, yuan: points / resolved.creditsPerYuan, source: 'platform' },
            asOf: readString(payload, 'as_of'),
          })
          return
        }

        if (route === '/api/models' && method === 'GET') {
          // The live channel list wins over the platform catalog: the local
          // new-api is the deployment's own model source.
          if (url.searchParams.get('source') === 'newapi') {
            const live = await readNewApiModels()
            json(response, 200, { ...live, baseUrl: resolved.newApiBaseUrl })
            return
          }
          // The public catalog needs no session; it is the picker's model list.
          const catalog = await platformCall(resolved.baseUrl, '/api/v1/models/catalog', {
            method: 'GET', timeoutMs: resolved.timeoutMs,
          })
          const payload = catalog.body !== null && typeof catalog.body === 'object' ? catalog.body as Record<string, unknown> : null
          const models = Array.isArray(payload?.models)
            ? (payload.models as unknown[]).flatMap(entry => {
              if (entry === null || typeof entry !== 'object') return []
              const item = entry as Record<string, unknown>
              const id = readString(item, 'id')
              if (id === null) return []
              return [{
                id,
                displayName: readString(item, 'display_name') ?? id,
                supportsVision: item.supports_vision === true,
                enabled: item.enabled === true,
                selectable: item.selectable === true,
                inputPrice: typeof item.input_price_points_per_million === 'number' ? item.input_price_points_per_million : null,
                outputPrice: typeof item.output_price_points_per_million === 'number' ? item.output_price_points_per_million : null,
              }]
            })
            : []
          json(response, 200, {
            ok: catalog.status === 200,
            code: catalog.code,
            message: catalog.message,
            catalogVersion: readString(payload, 'catalog_version'),
            defaultModelId: readString(payload, 'default_model_id'),
            models,
          })
          return
        }

        if (route === '/api/grant' && method === 'POST') {
          const body = await readJson(request)
          const outcome = await ensureGrant(body.refresh === true)
          if (!outcome.ok) {
            json(response, 200, {
              ok: false,
              code: outcome.code ?? 'GRANT_FAILED',
              message: outcome.message ?? 'model grant unavailable',
              sessionInvalid: outcome.sessionInvalid === true,
            })
            return
          }
          // The gateway key stays host-side; only its shape and lifetime surface.
          json(response, 200, {
            ok: true,
            expiresAt: grant?.expiresAt ?? null,
            defaultModelId: grant?.defaultModelId ?? null,
            models: grant?.models ?? [],
            gatewayHost: grant === null ? null : new URL(grant.baseUrl).host,
          })
          return
        }

        if (route === '/api/recharge/options' && method === 'GET') {
          // WeChat Native now lives in new-api; the platform's option/order flow
          // stays out of the product path entirely.
        }

        if (route === '/api/recharge/wechat' && method === 'POST') {
          const session = await liveSession()
          if (session?.upstream?.token === undefined) { sessionExpired(response); return }
          const body = await readJson(request)
          const amount = typeof body.amount === 'number' ? Math.round(body.amount) : Number.NaN
          if (!Number.isInteger(amount) || amount < 1 || amount > 100_000) {
            json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: '金额需为 1–100000 的整数（元）' })
            return
          }
          const created = await fetch(`${resolved.newApiBaseUrl}/api/user/wechat/native`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${(session.upstream?.token ?? '')}`,
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify({ amount }),
            signal: AbortSignal.timeout(resolved.timeoutMs),
          })
          const text = await created.text()
          let payload: {
            success?: boolean
            message?: string
            data?: { out_trade_no?: unknown; code_url?: unknown; expires_at?: unknown; quota?: unknown; amount?: unknown }
          } = {}
          try {
            if (text !== '') payload = JSON.parse(text) as typeof payload
          } catch {
            payload = {}
          }
          if (payload.success !== true) {
            json(response, 200, {
              ok: false,
              code: created.status === 429 ? 'RECHARGE_RATE_LIMITED' : 'RECHARGE_FAILED',
              message: payload.message ?? `下单失败（HTTP ${String(created.status)}）`,
            })
            return
          }
          const codeUrl = typeof payload.data?.code_url === 'string' ? payload.data.code_url : null
          let qr: string | null = null
          if (codeUrl !== null) {
            try {
              qr = await QRCode.toDataURL(codeUrl, { margin: 1, width: 320 })
            } catch {
              qr = null
            }
          }
          json(response, 200, {
            ok: true,
            payload: {
              outTradeNo: typeof payload.data?.out_trade_no === 'string' ? payload.data.out_trade_no : null,
              amount: typeof payload.data?.amount === 'number' ? payload.data.amount : amount,
              quota: typeof payload.data?.quota === 'number' ? payload.data.quota : null,
              expiresAt: typeof payload.data?.expires_at === 'number' ? payload.data.expires_at : null,
              qrCodeDataUrl: qr,
            },
          })
          return
        }

        if (route === '/api/recharge/wechat/order' && method === 'GET') {
          const session = await liveSession()
          if (session?.upstream?.token === undefined) { sessionExpired(response); return }
          const orderNo = url.searchParams.get('outTradeNo')
          if (orderNo === null || orderNo === '') {
            json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: 'outTradeNo 必填' })
            return
          }
          const polled = await fetch(
            `${resolved.newApiBaseUrl}/api/user/wechat/order?out_trade_no=${encodeURIComponent(orderNo)}`,
            { headers: { authorization: `Bearer ${(session.upstream?.token ?? '')}`, accept: 'application/json' }, signal: AbortSignal.timeout(resolved.timeoutMs) },
          )
          const text = await polled.text()
          let payload: { success?: boolean; message?: string; data?: Record<string, unknown> } = {}
          try {
            if (text !== '') payload = JSON.parse(text) as typeof payload
          } catch {
            payload = {}
          }
          json(response, 200, {
            ok: payload.success === true,
            code: payload.success === true ? null : 'ORDER_QUERY_FAILED',
            message: payload.message ?? null,
            payload: payload.success === true ? payload.data ?? null : null,
          })
          return
        }

        if (route === '/api/recharge/options' && method === 'GET') {
          const { result, sessionInvalid } = await withToken(token => platformCall(resolved.baseUrl, '/api/v2/account/recharge-options', {
            method: 'GET', token, timeoutMs: resolved.timeoutMs,
          }))
          if (sessionInvalid) { sessionExpired(response); return }
          reply(response, result)
          return
        }

        if (route === '/api/assets' && method === 'POST') {
          const mediaType = String(request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
          const filename = String(request.headers['x-file-name'] ?? '')
          const idempotencyKey = String(request.headers['x-idempotency-key'] ?? '')
          const allowedTypes = resolved.baseUrl === ''
            ? new Set([...ALLOWED_ASSET_TYPES, ...ALLOWED_REFERENCE_VIDEO_TYPES])
            : ALLOWED_ASSET_TYPES
          if (!allowedTypes.has(mediaType) || filename === '' || idempotencyKey === '') {
            json(response, 200, {
              ok: false,
              code: 'MEDIA_ASSET_REQUEST_INVALID',
              message: '需要 Content-Type（png/jpeg/webp/mp4/mov）、x-file-name 与 x-idempotency-key',
            })
            return
          }

          // The local stack keeps reference media on this machine: new-api
          // receives bytes inline with the generation call, so nothing has to be
          // published to a remote asset store first. The platform branch stays
          // for a deployment that configures one.
          if (resolved.baseUrl === '') {
            const session = await liveSession()
            if (session?.upstream?.token === undefined) { sessionExpired(response); return }
            const bytes = await readRaw(request, 32 * 1024 * 1024)
            if (bytes.length === 0) {
              json(response, 200, { ok: false, code: 'MEDIA_ASSET_REQUEST_INVALID', message: '上传内容为空' })
              return
            }
            const assetId = `ma_${idempotencyKey.replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}`
            const stored = await storeReference(assetId, bytes, mediaType, filename)
            json(response, 200, {
              ok: true,
              status: 201,
              asset: {
                assetId,
                kind: 'reference_image',
                contentType: mediaType,
                sizeBytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
                filename: stored.filename,
              },
            })
            return
          }

          const session = await liveSession()
          if (session?.upstream?.token === undefined) { sessionExpired(response); return }
          const bytes = await readRaw(request, 32 * 1024 * 1024)
          if (bytes.length === 0) {
            json(response, 200, { ok: false, code: 'MEDIA_ASSET_REQUEST_INVALID', message: '上传内容为空' })
            return
          }
          const result = await platformUpload(resolved.baseUrl, '/v1/media/assets', {
            token: (session.upstream?.token ?? ''),
            idempotencyKey,
            mediaType,
            filename,
            bytes,
            timeoutMs: resolved.timeoutMs,
          })
          if (result.status === 401 && result.code === 'SESSION_INVALID') {
            await store.clear()
            sessionExpired(response)
            return
          }
          const payload = result.body !== null && typeof result.body === 'object' ? result.body as Record<string, unknown> : null
          json(response, 200, {
            ok: result.status === 201,
            status: result.status,
            code: result.code,
            message: result.message,
            asset: result.status === 201
              ? {
                assetId: readString(payload, 'asset_id'),
                kind: readString(payload, 'kind'),
                contentType: readString(payload, 'content_type'),
                sizeBytes: typeof payload?.size_bytes === 'number' ? payload.size_bytes : null,
                sha256: readString(payload, 'sha256'),
              }
              : null,
          })
          return
        }

        if (route === '/api/media/catalog' && method === 'GET') {
          // The panels render one dropdown per kind from this answer, so it
          // ships the parameter menus too: what a model accepts is the model's
          // own business, and the deployment is asked each time.
          const catalog = await readMediaCatalog()
          json(response, 200, {
            ok: catalog.ok,
            code: catalog.code ?? null,
            message: catalog.message ?? null,
            source: 'newapi-pricing',
            baseUrl: resolved.newApiBaseUrl,
            group: catalog.group,
            payload: {
              group: catalog.group,
              image: catalog.models.filter(model => model.kind === 'image'),
              video: catalog.models.filter(model => model.kind === 'video'),
            },
          })
          return
        }

        if (route === '/api/image/pricing' && method === 'GET') {
          // The local new-api channel is the deployment's own image source; ask
          // it first so the panel stops depending on the platform quote flow.
          if (url.searchParams.get('source') === 'newapi') {
            const key = await deploymentKey()
            if (key === null) { json(response, 200, { ok: false, code: 'NO_KEY', message: 'new-api key 未配置' }); return }
            const live = await readNewApiModels()
            const model = live.image[0] ?? null
            json(response, 200, {
              ok: live.ok && model !== null,
              source: 'newapi',
              baseUrl: resolved.newApiBaseUrl,
              model,
              imageModels: live.image,
            })
            return
          }
          const { result, sessionInvalid } = await withToken(token => platformCall(
            resolved.baseUrl, '/v1/media/images/pricing', { method: 'GET', token, timeoutMs: resolved.timeoutMs },
          ))
          if (sessionInvalid) { sessionExpired(response); return }
          reply(response, result)
          return
        }

        if (route === '/api/image/generate' && method === 'POST') {
          const owned = await accountKey()
          if ('reason' in owned) {
            json(response, 200, { ok: false, ...noCredential(owned.reason) })
            return
          }
          const key = owned.key
          const body = await readJson(request)
          const outcome = await runImageGeneration(key, body)
          json(response, 200, {
            ok: outcome.ok,
            source: 'newapi',
            model: outcome.model ?? null,
            mode: outcome.mode ?? null,
            code: outcome.code ?? null,
            message: outcome.message ?? null,
            payload: outcome.ok ? { path: outcome.path, paths: outcome.paths, model: outcome.model } : null,
          })
          return
        }

        if (route === '/api/image/tasks' && method === 'POST') {
          const body = await readJson(request)
          const operationId = readString(body, 'operationId')
          const prompt = readString(body, 'prompt')
          const aspectRatio = readString(body, 'aspectRatio') ?? '1:1'
          const references = Array.isArray(body.references)
            ? body.references.filter((item): item is string => typeof item === 'string' && item.startsWith('ma_'))
            : []
          if (operationId === null || prompt === null || !/^[A-Za-z0-9._:-]{1,96}$/.test(operationId)) {
            json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: 'operationId 与 prompt 必填' })
            return
          }
          if (new Set(references).size !== references.length || references.length > 6) {
            // The schema allows ten; the current image adapter serves six, and the
            // stricter capability is the one this client advertises.
            json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: '参考图最多 6 张且不能重复' })
            return
          }
          const session = await liveSession()
          const token = session?.token
          if (token === undefined) { sessionExpired(response); return }
          // The quote is taken host-side, immediately before submission, and
          // carried verbatim as the contract's `billing` snapshot.
          const quote = await platformCall(resolved.baseUrl, '/v1/media/images/pricing', {
            method: 'GET', token, timeoutMs: resolved.timeoutMs,
          })
          if (quote.status === 401 && quote.code === 'SESSION_INVALID') { await store.clear(); sessionExpired(response); return }
          const quoteBody = quote.body !== null && typeof quote.body === 'object' ? quote.body as Record<string, unknown> : null
          const pricedModel = readString(quoteBody, 'model_id')
          const billing = quoteBody?.billing
          if (quote.status !== 200 || billing === undefined) {
            json(response, 200, { ok: false, code: quote.code ?? 'IMAGE_PRICING_FAILED', message: quote.message ?? '报价不可用' })
            return
          }
          const created = await platformCall(resolved.baseUrl, '/v1/media/images/tasks', {
            method: 'POST',
            token,
            body: {
              schema: 'yunshu.media.image-operation/v1',
              operation_id: operationId,
              prompt,
              aspect_ratio: aspectRatio,
              references,
              mode: references.length === 0 ? 'generate' : 'edit',
              billing,
            },
            timeoutMs: resolved.timeoutMs,
          })
          if (created.status === 401 && created.code === 'SESSION_INVALID') { await store.clear(); sessionExpired(response); return }
          const createdBody = created.body !== null && typeof created.body === 'object' ? created.body as Record<string, unknown> : null
          json(response, 200, {
            ok: created.status === 200 || created.status === 202,
            status: created.status,
            code: created.code,
            message: created.message,
            retryAfterSeconds: created.retryAfterSeconds,
            operationId,
            modelId: pricedModel,
            quote: billing,
            task: createdBody,
          })
          return
        }

        if (route.startsWith('/api/image/tasks/') && method === 'GET') {
          const taskId = decodeURIComponent(route.slice('/api/image/tasks/'.length))
          const { result, sessionInvalid } = await withToken(token => platformCall(
            resolved.baseUrl, `/v1/media/images/tasks/${encodeURIComponent(taskId)}`,
            { method: 'GET', token, timeoutMs: resolved.timeoutMs },
          ))
          if (sessionInvalid) { sessionExpired(response); return }
          reply(response, result)
          return
        }

        if (route.startsWith('/api/image/operations/') && method === 'GET') {
          const operationId = decodeURIComponent(route.slice('/api/image/operations/'.length))
          const { result, sessionInvalid } = await withToken(token => platformCall(
            resolved.baseUrl, `/v1/media/images/operations/${encodeURIComponent(operationId)}`,
            { method: 'GET', token, timeoutMs: resolved.timeoutMs },
          ))
          if (sessionInvalid) { sessionExpired(response); return }
          reply(response, result)
          return
        }

        if (route === '/api/video/tasks' && method === 'POST') {
          if (url.searchParams.get('source') === 'newapi-generate') {
            const owned = await accountKey()
            if ('reason' in owned) { json(response, 200, { ok: false, ...noCredential(owned.reason) }); return }
            const key = owned.key
            const body = await readJson(request)
            const prompt = readString(body, 'prompt')
            if (prompt === null || prompt.trim() === '') {
              json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: 'prompt 必填' })
              return
            }
            const capability = await capabilityFor('video', readString(body, 'model'))
            if (!capability.ok) {
              json(response, 200, {
                ok: false,
                code: capability.code,
                message: capability.message,
                models: capability.catalog.map(entry => entry.id),
              })
              return
            }
            const built = await buildVideoRequest(capability.model, body)
            if (!built.ok) {
              json(response, 200, { ok: false, code: built.code, message: built.message })
              return
            }
            const outcome = await runVideoTask(key, built.request)
            json(response, 200, {
              ok: outcome.ok,
              source: 'newapi',
              model: capability.model.id,
              code: outcome.code ?? null,
              message: outcome.message ?? null,
              taskId: outcome.taskId ?? null,
              payload: outcome.ok ? { path: outcome.path, taskId: outcome.taskId } : null,
            })
            return
          }
          if (url.searchParams.get('source') === 'newapi') {
            const owned = await accountKey()
            if ('reason' in owned) { json(response, 200, { ok: false, ...noCredential(owned.reason) }); return }
            const key = owned.key
            const body = await readJson(request)
            const prompt = readString(body, 'prompt')
            if (prompt === null) { json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: 'prompt 必填' }); return }
            const capability = await capabilityFor('video', readString(body, 'model'))
            if (!capability.ok) {
              json(response, 200, { ok: false, code: capability.code, message: capability.message })
              return
            }
            const built = await buildVideoRequest(capability.model, body)
            if (!built.ok) {
              json(response, 200, { ok: false, code: built.code, message: built.message })
              return
            }
            const created = await fetch(`${resolved.newApiBaseUrl}/v1/videos`, {
              method: 'POST',
              headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify(built.request),
              signal: AbortSignal.timeout(resolved.timeoutMs),
            })
            const text = await created.text()
            let parsed: unknown = null
            try { parsed = JSON.parse(text) } catch { parsed = text }
            json(response, 200, { ok: created.ok, status: created.status, source: 'newapi', task: parsed })
            return
          }
          const body = await readJson(request)
          const operationId = readString(body, 'operationId')
          const prompt = readString(body, 'prompt')
          const duration = typeof body.durationSeconds === 'number' ? body.durationSeconds : 10
          const aspectRatio = readString(body, 'aspectRatio') ?? '16:9'
          const watermark = body.watermark === true
          const references = Array.isArray(body.references)
            ? body.references.filter((item): item is string => typeof item === 'string' && item.startsWith('ma_'))
            : []
          if (operationId === null || !/^[A-Za-z0-9._:-]{1,96}$/.test(operationId) || prompt === null || prompt.length === 0) {
            json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: 'operationId 与 prompt 必填' })
            return
          }
          if (prompt.length > 7000) {
            // The schema allows 8000, the current adapter 7000; the client stays
            // on the stricter side rather than discovering it at submission.
            json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: '提示词最长 7000 字符' })
            return
          }
          if (!Number.isInteger(duration) || duration < 4 || duration > 15) {
            json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: '时长须为 4–15 秒的整数' })
            return
          }
          if (aspectRatio !== '16:9' && aspectRatio !== '9:16') {
            json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: '比例只支持 16:9 或 9:16' })
            return
          }
          if (new Set(references).size !== references.length || references.length > 9) {
            json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: '参考图最多 9 张且不能重复' })
            return
          }
          const session = await liveSession()
          if (session?.token === undefined) { sessionExpired(response); return }
          const manifest: VideoManifest = {
            schema: 'yunshu.media.video-confirmation/v1',
            operation_id: operationId,
            prompt,
            options: { duration_seconds: duration, aspect_ratio: aspectRatio, generate_audio: true, watermark },
            assets: references.map((assetId, index) => ({ kind: 'reference_image' as const, asset_id: assetId, order: index })),
            expected_counts: { reference_image: references.length, reference_video: 0, reference_audio: 0 },
            billing: {
              reserve_points: 0,
              points_per_second: 300,
              settlement: 'actual_duration_seconds',
              pricing_version: 'yunshu-video-v3',
              billing_mode: 'charge_on_success',
              estimated_cost_points: duration * 300,
            },
          }
          const fingerprint = createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex')
          const created = await platformCall(resolved.baseUrl, '/v1/media/videos/tasks', {
            method: 'POST',
            token: session.token,
            body: {
              operation_id: operationId,
              manifest,
              confirmation: { user_confirmed: true, precharge_points: 0, fingerprint },
            },
            timeoutMs: resolved.timeoutMs,
          })
          if (created.status === 401 && created.code === 'SESSION_INVALID') {
            await store.clear()
            sessionExpired(response)
            return
          }
          const createdBody = created.body !== null && typeof created.body === 'object' ? created.body as Record<string, unknown> : null
          json(response, 200, {
            ok: created.status === 200 || created.status === 202,
            status: created.status,
            code: created.code,
            message: created.message,
            retryAfterSeconds: created.retryAfterSeconds,
            operationId,
            estimatedCostPoints: duration * 300,
            task: createdBody,
          })
          return
        }

        if (route.startsWith('/api/video/tasks/') && method === 'GET') {
          const taskId = decodeURIComponent(route.slice('/api/video/tasks/'.length))
          const { result, sessionInvalid } = await withToken(token => platformCall(
            resolved.baseUrl, `/v1/media/videos/tasks/${encodeURIComponent(taskId)}`,
            { method: 'GET', token, timeoutMs: resolved.timeoutMs },
          ))
          if (sessionInvalid) { sessionExpired(response); return }
          reply(response, result)
          return
        }

        if (route.startsWith('/api/video/operations/') && method === 'GET') {
          const operationId = decodeURIComponent(route.slice('/api/video/operations/'.length))
          const { result, sessionInvalid } = await withToken(token => platformCall(
            resolved.baseUrl, `/v1/media/videos/operations/${encodeURIComponent(operationId)}`,
            { method: 'GET', token, timeoutMs: resolved.timeoutMs },
          ))
          if (sessionInvalid) { sessionExpired(response); return }
          reply(response, result)
          return
        }

        if (route === '/api/media/save' && method === 'POST') {
          // new-api answers images inline; this branch exists for the platform's
          // relative download paths only.
          const body = await readJson(request)
          const downloadPath = readString(body, 'downloadPath')
          if (downloadPath === null || !downloadPath.startsWith('/')) {
            json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: 'downloadPath 必须是服务端返回的相对路径' })
            return
          }
          const session = await liveSession()
          if (session?.token === undefined) { sessionExpired(response); return }
          const target = new URL(downloadPath, resolved.baseUrl)
          const saved = await downloadToFile(target, resolved.baseUrl, session.token, join(stateDir, 'media'), resolved.timeoutMs)
          json(response, 200, saved.ok
            ? { ok: true, path: saved.path, bytes: saved.bytes, mediaType: saved.mediaType }
            : { ok: false, code: saved.code, message: saved.message })
          return
        }

        if (route === '/api/recharge/orders' && method === 'POST') {
          const body = await readJson(request)
          const amount = typeof body.amountCents === 'number' ? body.amountCents : Number.NaN
          const key = readString(body, 'idempotencyKey')
          if (!Number.isInteger(amount) || key === null) {
            json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: 'amountCents 与 idempotencyKey 必填' })
            return
          }
          const { result, sessionInvalid } = await withToken(token => platformCall(resolved.baseUrl, '/api/v1/payments/wechat/native', {
            method: 'POST', token, idempotencyKey: key, body: { amount_cents: amount }, timeoutMs: resolved.timeoutMs,
          }))
          if (sessionInvalid) { sessionExpired(response); return }
          const payload = result.body !== null && typeof result.body === 'object' ? result.body as Record<string, unknown> : null
          const codeUrl = readString(payload, 'code_url')
          let qrCodeDataUrl: string | null = null
          if (result.status === 201 && codeUrl !== null) {
            try {
              qrCodeDataUrl = await QRCode.toDataURL(codeUrl, { margin: 1, width: 320 })
            } catch {
              qrCodeDataUrl = null
            }
          }
          json(response, 200, {
            ok: result.status === 201,
            status: result.status,
            code: result.code,
            message: result.message,
            retryAfterSeconds: result.retryAfterSeconds,
            order: result.status === 201 && payload !== null ? { ...payload, qrCodeDataUrl } : null,
          })
          return
        }

        if (route.startsWith('/api/recharge/orders/') && method === 'GET') {
          const orderNo = decodeURIComponent(route.slice('/api/recharge/orders/'.length))
          if (!/^[A-Z0-9][A-Z0-9_-]{5,31}$/.test(orderNo)) {
            json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: 'merchantOrderNo 格式非法' })
            return
          }
          const { result, sessionInvalid } = await withToken(token => platformCall(
            resolved.baseUrl,
            `/api/v1/payments/recharge-orders/${encodeURIComponent(orderNo)}`,
            { method: 'GET', token, timeoutMs: resolved.timeoutMs },
          ))
          if (sessionInvalid) { sessionExpired(response); return }
          reply(response, result)
          return
        }

        json(response, 404, { ok: false, code: 'NOT_FOUND', message: 'unknown credits route' })
      } catch (error) {
        json(response, 200, {
          ok: false,
          code: 'TRANSPORT',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }), 'credits-index: routes')

  /**
   * The chat model list belongs to the deployment, not to a config file.
   *
   * The LLM adapter can be asked what an endpoint serves, and it reads its
   * routes from the settings document. Once at boot and then once a minute, the
   * list configured for this provider is replaced by the list new-api actually
   * publishes — so a channel or model added on the new-api side appears in the
   * picker with nobody editing anything.
   *
   * Both services are optional. Without them the sync simply does not run and
   * the configured list stands, which is also what happens while the gateway is
   * unreachable.
   */
  ctx.effect(() => {
    const namespace = resolved.chatSettingsNamespace
    const route = resolved.chatProviderRoute

    const sync = async (): Promise<void> => {
      // Resolved per tick: this plugin may be applied before the settings and
      // LLM services finish mounting, and a one-shot read at boot would then
      // give up for the life of the process.
      const settings = ctx.get('settings') as {
        describe?: (options?: { redactSecrets?: boolean }) => { ns: string; value?: unknown; revision?: number }[]
        replace?: (ns: string, section: object, expectedRevision?: number) => Promise<void>
      } | undefined
      const llm = ctx.get('llm') as {
        discoverModels?: (
          ns: string,
          request: { provider?: string; baseURL?: string; api?: string; apiKey?: string },
          signal?: AbortSignal,
        ) => Promise<{ id: string }[]>
      } | undefined
      if (settings?.describe === undefined || settings.replace === undefined || llm?.discoverModels === undefined) return
      try {
        // Called through the service object: these methods are bound to the
        // provider that owns them, and a detached reference loses its `this`.
        const descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === namespace)
        const value = descriptor?.value as { providers?: Record<string, Record<string, unknown>> } | undefined
        const providers = value?.providers
        const current = providers?.[route]
        if (providers === undefined || current === undefined) return
        // The route is this deployment's own, so the adapter has no built-in
        // catalogue to answer from: hand it the endpoint, the protocol and a
        // one-shot credential, which is exactly what the Models page's "fetch
        // available models" action does.
        const baseURL = typeof current.baseURL === 'string' && current.baseURL !== ''
          ? current.baseURL
          : `${resolved.newApiBaseUrl}/v1`
        const api = typeof current.api === 'string' ? current.api : 'openai-completions'
        const key = await deploymentKey()
        const discovered = await llm.discoverModels(
          namespace,
          {
            provider: route,
            baseURL,
            api,
            ...key === null ? {} : { apiKey: key },
          },
          AbortSignal.timeout(resolved.timeoutMs),
        )
        /**
         * Chat only. new-api answers `/v1/models` with everything it serves,
         * and an image model carries `openai` in its endpoint types too, so the
         * generators are subtracted by asking the pricing table which ids the
         * media classifier recognises — the same judgement the image and video
         * panels make. An unreachable pricing table subtracts nothing rather
         * than emptying the picker.
         */
        const media = new Set<string>()
        try {
          const pricing = await fetch(`${resolved.newApiBaseUrl}/api/pricing`, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(resolved.timeoutMs),
          })
          if (pricing.ok) {
            const body = await pricing.json() as { data?: unknown }
            for (const id of mediaModelIds(Array.isArray(body.data) ? body.data : [])) media.add(id)
          }
        } catch {
          // Keep every model rather than hiding the ones that might be chat.
        }
        const ids = discovered
          .map(model => model.id)
          .filter(id => id !== '' && !media.has(id))
        if (ids.length === 0) return
        const idsOf = (profile: Record<string, unknown>): string[] => Array.isArray(profile.models)
          ? (profile.models as unknown[])
            .map(model => model !== null && typeof model === 'object' ? (model as { id?: unknown }).id : null)
            .filter((id): id is string => typeof id === 'string')
          : []
        /**
         * Every profile that points at this deployment's new-api follows the
         * same list. A profile whose endpoint differs is left exactly as it is:
         * this sync owns the deployment's relay, not the operator's other
         * routes.
         */
        const endpoint = baseURL.replace(/\/+$/, '')
        const next = { ...providers }
        let updated = 0
        let previous = 0
        for (const [name, profile] of Object.entries(providers)) {
          if (typeof profile?.baseURL !== 'string' || profile.baseURL.replace(/\/+$/, '') !== endpoint) continue
          const configured = idsOf(profile)
          if (configured.length === ids.length && configured.every((id, index) => id === ids[index])) continue
          next[name] = { ...profile, models: ids.map(id => ({ id })) }
          updated += 1
          previous += configured.length
        }
        if (updated === 0) return
        await settings.replace(namespace, { providers: next }, descriptor?.revision)
        console.log(
          `[credits-index] chat models synced from new-api: ${String(ids.length)} chat into ${String(updated)} route(s)`
          + ` (skipped ${String(media.size)} media, was ${String(previous)})`,
        )
      } catch (error) {
        // Discovery is a convenience: an unreachable gateway keeps the last list.
        console.log(`[credits-index] chat model sync failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const timer = setInterval(() => { void sync() }, 60_000)
    void sync()
    return () => { clearInterval(timer) }
  }, 'credits-index: model sync')

  /** The signed-in token, or null with a message the model can relay. */
  const requireToken = async (): Promise<{ token: string } | { error: string }> => {
    const session = await store.read()
    if (session?.token === undefined) {
      return { error: '未登录：请让用户在「额度」面板用手机号登录后再生成。' }
    }
    return { token: session.token }
  }

  /** The new-api relay key, or a message the model can relay. */
  const requireRelayKey = async (): Promise<{ key: string } | { error: string }> => {
    const owned = await accountKey()
    if ('reason' in owned) return { error: noCredential(owned.reason).message }
    return { key: owned.key }
  }

  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: 'Generate images from a text prompt through the local new-api relay, save every result into the artifacts directory, and return the paths. Which image models exist, and what each one accepts, is the deployment’s own answer: ask for a model only when the user names one.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'What the image should show.' },
      model: { type: 'string', description: 'Optional image model id such as gpt-image-2. Defaults to the first image model the deployment serves for this account.' },
      size: { type: 'string', description: 'Optional output size such as 1024x1024 or auto. A value the chosen model does not support is refused with that model’s own menu.' },
      count: { type: 'number', description: 'How many images to render, within the model’s limit (usually 1–4).' },
      reference_images: { type: 'array', items: { type: 'string' }, description: 'Optional stored reference ids (ma_…) from the AI 生图 panel’s upload; present means the request is an edit.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          path: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
          model: { type: 'string' },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const session = await requireToken()
      if ('error' in session) return { status: 'unauthorized', message: session.error }
      const relay = await requireRelayKey()
      if ('error' in relay) return { status: 'failed', message: relay.error }
      const outcome = await runImageGeneration(relay.key, {
        prompt: args.prompt,
        ...args.model === undefined ? {} : { model: args.model },
        ...args.size === undefined ? {} : { size: args.size },
        ...args.count === undefined ? {} : { count: args.count },
        ...args.reference_images === undefined ? {} : { references: args.reference_images },
      })
      if (!outcome.ok) {
        return { status: 'failed', model: outcome.model ?? '', message: outcome.message ?? outcome.code ?? '生成失败' }
      }
      const paths = [...outcome.paths ?? []]
      return {
        status: 'succeeded',
        path: outcome.path ?? '',
        paths,
        model: outcome.model ?? '',
        message: `图片已保存到产物目录（共 ${String(paths.length)} 张）。`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'generate_video',
    description: 'Generate one video through the local new-api relay, wait for it, save it into the artifacts directory, and return its path. The chosen model decides which parameters exist: duration, resolution, ratio, first/last frames and reference media are validated against what that model actually accepts.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'What the video should show.' },
      model: { type: 'string', description: 'Optional video model id such as MiniMax-H3. Defaults to the first video model the deployment serves for this account.' },
      duration_seconds: { type: 'number', description: 'Clip length in seconds; only values the chosen model declares are accepted.' },
      resolution: { type: 'string', description: 'Output resolution such as 768P or 2K, when the model offers choices.' },
      ratio: { type: 'string', description: 'Aspect ratio such as 16:9 or 9:16; adaptive inherits it from the reference media.' },
      frame_images: { type: 'array', items: { type: 'string' }, description: 'Optional stored ids (ma_…) used as first/last frame.' },
      reference_images: { type: 'array', items: { type: 'string' }, description: 'Optional stored ids (ma_…) used as multimodal subject/style references, when the model supports them.' },
      reference_videos: { type: 'array', items: { type: 'string' }, description: 'Optional stored ids (ma_…) used as a reference video, when the model supports video-to-video.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          path: { type: 'string' },
          model: { type: 'string' },
          task_id: { type: 'string' },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const session = await requireToken()
      if ('error' in session) return { status: 'unauthorized', message: session.error }
      const relay = await requireRelayKey()
      if ('error' in relay) return { status: 'failed', message: relay.error }
      const capability = await capabilityFor('video', args.model ?? null)
      if (!capability.ok) return { status: 'failed', message: capability.message }
      const built = await buildVideoRequest(capability.model, {
        prompt: args.prompt,
        ...args.duration_seconds === undefined ? {} : { durationSeconds: args.duration_seconds },
        ...args.resolution === undefined ? {} : { resolution: args.resolution },
        ...args.ratio === undefined ? {} : { ratio: args.ratio },
        ...args.frame_images === undefined ? {} : { frameImages: args.frame_images },
        ...args.reference_images === undefined ? {} : { referenceImages: args.reference_images },
        ...args.reference_videos === undefined ? {} : { referenceVideos: args.reference_videos },
      })
      if (!built.ok) return { status: 'failed', model: capability.model.id, message: built.message }
      const outcome = await runVideoTask(relay.key, built.request, exec.signal)
      if (!outcome.ok) {
        return {
          status: outcome.code === 'TIMEOUT' ? 'running' : 'failed',
          model: capability.model.id,
          task_id: outcome.taskId ?? '',
          message: outcome.message ?? outcome.code ?? '生成失败',
        }
      }
      return {
        status: 'succeeded',
        path: outcome.path ?? '',
        model: capability.model.id,
        task_id: outcome.taskId ?? '',
        message: '视频已保存到产物目录。',
      }
    },
  }))
}
