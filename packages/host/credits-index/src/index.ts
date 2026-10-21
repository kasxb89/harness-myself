/**
 * Account and creation routes for the sidebar Credits panel.
 * Backend requests retain the configured deployment prefix. Access tokens and
 * rotating refresh cookies stay in the Host; model requests use the signed-in
 * account's relay key. Private session files restore the same backend-bound
 * account, while live status parameters convert its current quota to points.
 * @module @deepseek-ai/dsh-credits-index
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { addAbortSignal } from 'node:stream'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-artifacts-index'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import QRCode from 'qrcode'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { HarnessAccount } from '@deepseek-ai/dsh-llm-pi-ai'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apiUrl, normalizeApiBaseUrl } from './api-url.ts'
import { parseClientModelConfigStatus } from './client-model-config.ts'
import { orderProductModels, preferredProductModel, type ProductModelPresentation } from './model-presentation.ts'
import { isAccountBalanceRejectionText } from './account-balance.ts'
import { ClientActivitySessions, parseClientActivity, type ClientActivitySample } from './client-activity.ts'
import { parseUsageWindow, readAccountUsage } from './usage.ts'
import { ChatUsageReader, parseChatUsageQuery } from './chat-usage-reader.ts'
import { chatReceiptProjection, selectChatReceipts } from './chat-usage-projection.ts'
export type { ChatReceiptState } from './chat-usage-projection.ts'
import { assistPrompt, parsePromptAssist, promptAssistFailure } from './prompt-assist.ts'
import { isPromptAssistSelectionCurrent, resolvePromptAssistSelection } from './prompt-assist-selection.ts'
import { relayCreationContent } from './creation-content.ts'
import { createVideoEditor } from './video-edit.ts'
import { registerVideoProjectTools } from './video-project-tools.ts'
import { registerCreationWorkflows } from './creation-workflows.ts'
import { recoverVideoProjectOutputs, VideoProjectError } from './video-project.ts'
import { createVideoProjectRelay } from './video-project-provider.ts'
import { bindVideoAccount } from './video-project-account.ts'
import { captureMediaOutput } from './media-output.ts'
import type { VideoProjectIdentity, VideoProjectOptions, VideoProjectRequest, VideoRequestValue } from './video-project-types.ts'
import { CreativeError, CreativeStore, parseCreativePlanChange, type CreativeOperation, type CreativeOwner } from './creative-store.ts'
import { creativeOwner, registerCreativeTools } from './creative-tools.ts'
import { creativePanelOwner } from './creative-panel.ts'
import { readChatImageReference } from './chat-image-references.ts'
import { normalizeReferenceImage, ReferenceImageError, REFERENCE_IMAGE_INPUT_LIMIT } from './reference-image.ts'
import {
  catalogFromPricing,
  mediaModelIds,
  pickModel,
  videoDurations,
  type ImageParams,
  type ModelCapability,
  type VideoParams,
} from './media.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'credits-index'

/** The route carrier this plugin registers into. */
export const inject = ['webServer', 'tools']

const MEDIA_FAILURE_GUIDANCE = ' For Yunshu platform, relay or upstream failures, give users only a safe Simplified Chinese summary such as “服务器繁忙，请稍后重试”; never repeat raw HTTP responses, diagnostic JSON, error codes, stacks, internal paths or credentials. Keep actionable guidance for confirmed sign-in, product-credit, file-validation and cancellation failures. When submission or billing outcome is unknown, check existing tasks and artifacts first; do not immediately retry or automatically resubmit. Preserve real tool results. This restriction does not prevent software or code diagnostics explicitly requested by the user.'

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
  /** HTTPS API base including the deployment prefix; HTTP is restricted to loopback. */
  newApiBaseUrl?: string
  /** Legacy deployment-key setting; account requests never resolve it. */
  newApiKeyEnv?: string
  /** Local Bridge origin serving the SMS login contract. */
  bridgeBaseUrl?: string
  /** Legacy admin-token setting; product account reads use only the signed-in user's access token. */
  newApiAdminTokenFile?: string
  /** LLM provider route whose model list follows this deployment's new-api. */
  chatProviderRoute?: string
  /** Settings namespace holding that provider profile. */
  chatSettingsNamespace?: string
  /** Legacy setting retained for compatibility; prompt assistance follows the current chat model. */
  promptAssistantModel?: string
  /** Legacy setting retained for compatibility; reference assistance requires image input on the current chat model. */
  promptAssistantVisionModel?: string
  /** Deadline for one prompt-assistance operation, independent of account and media timeouts. */
  promptAssistantTimeoutMs?: number
  /** Maximum model output tokens for one prompt-assistance request. */
  promptAssistantMaxTokens?: number
  /** Settled chat result and receipt cache lifetime, in milliseconds. */
  chatUsageCacheTtlMs?: number
  /** Maximum simultaneous exact-request ledger reads shared by all chat views. */
  chatUsageConcurrency?: number
  /** Maximum final length accepted by natural-language video projects. */
  videoProjectMaxSeconds?: number
  /** Maximum separately billable clips in one video project. */
  videoProjectMaxSegments?: number
  /** Delay between read-only provider task status requests. */
  videoProjectPollIntervalMs?: number
  /** Complete deadline for one generated clip, including saving it. */
  videoProjectTaskTimeoutMs?: number
  /** Maximum bytes saved for each generated clip. */
  videoProjectDownloadMaxBytes?: number
  /** Maximum bytes of a workspace reference copied into one provider request. */
  videoProjectReferenceMaxBytes?: number
  /** Workspace-relative directory for completed video files. */
  videoProjectOutputDirectory?: string
  /** Configured local edit deadline, including subprocess cleanup. */
  videoEditTimeoutMs?: number
  /** Common frame rate used when joining clips. */
  videoEditFps?: number
  /** Maximum inputs decoded together in one final encode; larger edits retain serial normalization. */
  videoEditSinglePassMaxInputs?: number
  /** Explicit bundled video runtime; empty uses the Desktop-provided runtime root. */
  videoRuntimeRoot?: string
}

export const Config: z<Config> = z.object({
  // The former account platform is separate from the model and account API.
  baseUrl: z.string().default(''),
  creditsPerYuan: z.number().min(1).default(1000),
  stateDir: z.string().default(''),
  timeoutMs: z.number().step(1).min(1).default(15_000),
  relayPort: z.number().step(1).min(1).default(8791),
  relayTokenEnv: z.string().default('YUNSHU_RELAY_TOKEN'),
  newApiBaseUrl: z.string().default('https://8.133.202.230/harness'),
  newApiKeyEnv: z.string().default('YUNSHU_NEWAPI_KEY'),
  bridgeBaseUrl: z.string().default('http://127.0.0.1:4310'),
  newApiAdminTokenFile: z.string().default(''),
  chatProviderRoute: z.string().default('yunshu-local'),
  chatSettingsNamespace: z.string().default('llm-pi-ai'),
  promptAssistantModel: z.string().max(256).pattern(/^(?!.*[\u0000-\u001f\u007f])\S*$/u).default(''),
  promptAssistantVisionModel: z.string().max(256).pattern(/^(?!.*[\u0000-\u001f\u007f])\S*$/u).default(''),
  promptAssistantTimeoutMs: z.number().step(1).min(1).max(120_000).default(60_000),
  promptAssistantMaxTokens: z.number().step(1).min(512).max(16_384).default(8192),
  chatUsageCacheTtlMs: z.number().step(1).min(1).max(60_000).default(5000),
  chatUsageConcurrency: z.number().step(1).min(1).max(8).default(4),
  videoProjectMaxSeconds: z.natural().min(1).default(300),
  videoProjectMaxSegments: z.natural().min(1).max(32).default(32),
  videoProjectPollIntervalMs: z.natural().min(1).default(6000),
  videoProjectTaskTimeoutMs: z.natural().min(1).default(900_000),
  videoProjectDownloadMaxBytes: z.natural().min(12).default(536_870_912),
  videoProjectReferenceMaxBytes: z.natural().min(12).max(67_108_864).default(20_971_520),
  videoProjectOutputDirectory: z.string().default('artifacts/videos'),
  videoEditTimeoutMs: z.natural().min(1).default(300_000),
  videoEditFps: z.natural().min(1).max(120).default(30),
  videoEditSinglePassMaxInputs: z.natural().min(1).max(32).default(3),
  videoRuntimeRoot: z.string().default(''),
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
const TOKEN_REF = credentialRef('YUNSHU_SESSION_TOKEN')

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
  /** Product-local sign-in token; upstream access and refresh credentials stay Host-side. */
  readonly token?: string | undefined
  /** Backend base that authenticated this session; credentials never migrate to another base. */
  readonly backendBaseUrl?: string | undefined
  /** Short-lived access token and rotating refresh cookie for this same account. */
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
   * deployment has no per-account credential, in which case generation is
   * refused until the user signs in again.
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

/** Wait without leaving a timer or abort listener after completion or owner disposal. */
function waitForMedia(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = (): void => { signal.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, milliseconds)
    const abort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      const reason: unknown = signal.reason
      reject(reason instanceof Error ? reason : new Error('Media generation cancelled'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
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
    }, (response) => {
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
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Omit<Partial<StoredSession>, 'upstream' | 'relay'> & {
        upstream?: StoredSession['upstream'] | null
        relay?: StoredSession['relay'] | null
      }
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
        ...typeof parsed.backendBaseUrl === 'string' ? { backendBaseUrl: parsed.backendBaseUrl } : {},
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
    backendBaseUrl?: string | undefined
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
      ...session.backendBaseUrl === undefined ? {} : { backendBaseUrl: session.backendBaseUrl },
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
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, '{}\n', { mode: 0o600 })
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

  /** The stored session reference, or null while no credential provider is mounted. */
  private async readCredential(): Promise<string | null> {
    try {
      return (await this.ctx.get('credentials')?.resolve(TOKEN_REF))?.value ?? null
    } catch {
      return null
    }
  }

  /** Store the session reference; the private session file also retains it. */
  private async writeCredential(token: string): Promise<boolean> {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) return false
    try {
      await credentials.set(TOKEN_REF, token)
      return true
    } catch {
      return false
    }
  }

  /** Remove the reference key, independently of the credential record key space. */
  private async deleteCredential(): Promise<void> {
    try {
      await this.ctx.get('credentials')?.unset(TOKEN_REF)
    } catch {
      // The private session file is cleared even when the credential provider is unavailable.
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
    }, (response) => {
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
 * Reference video types accepted by the account relay. Clips remain in local
 * storage until a generation request sends their bytes to the configured API.
 */
const ALLOWED_REFERENCE_VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime'])

/** Audio references remain private local uploads, with bounded MP3/WAV inputs. */
const ALLOWED_REFERENCE_AUDIO_TYPES = new Set(['audio/mpeg', 'audio/wav'])

/** Check the declared media family before including stored bytes in a paid request. */
function referenceSignature(bytes: Buffer, mediaType: string): boolean {
  if (mediaType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mediaType === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (mediaType === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (ALLOWED_REFERENCE_VIDEO_TYPES.has(mediaType)) return bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp'
  if (mediaType === 'audio/wav') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
  if (mediaType === 'audio/mpeg') {
    if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'ID3') {
      return (bytes[3] === 2 || bytes[3] === 3 || bytes[3] === 4) && bytes.subarray(6, 10).every(value => value < 128)
    }
    const second = bytes[1] ?? 0
    const third = bytes[2] ?? 0
    return bytes.length >= 4 && bytes[0] === 255 && (second & 0xe0) === 0xe0
      && (second & 0x18) !== 0x08 && (second & 0x06) !== 0 && (third & 0xf0) !== 0 && (third & 0xf0) !== 0xf0 && (third & 0x0c) !== 0x0c
  }
  return false
}

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
    }, (response) => {
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
      const mediaType = response.headers['content-type'] ?? 'application/octet-stream'
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const filename = `gen-${stamp}-${randomBytes(3).toString('hex')}${extensionFor(mediaType)}`
      const target = join(directory, filename)
      void (async () => {
        await mkdir(directory, { recursive: true })
        const sink = createWriteStream(target)
        let bytes = 0
        response.on('data', (chunk) => { bytes += (chunk as Buffer).length })
        response.pipe(sink)
        sink.on('finish', () => { resolve({ ok: true, path: target, bytes, mediaType }) })
        sink.on('error', (error) => { resolve({ ok: false, code: 'WRITE_FAILED', message: error.message }) })
      })().catch(reject)
    })
    request.on('timeout', () => { request.destroy(new Error('artifact download timed out')) })
    request.on('error', (error) => { resolve({ ok: false, code: 'TRANSPORT', message: error.message }) })
    request.end()
  })
}

export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  registerCreationWorkflows(ctx)
  const apiBaseUrl = normalizeApiBaseUrl(resolved.newApiBaseUrl)
  const stateDir = resolved.stateDir === ''
    ? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugin-data', 'credits')
    : resolved.stateDir
  const store = new SessionStore(ctx, join(stateDir, 'session.json'))
  const relayRef = credentialRef(resolved.relayTokenEnv)
  let identityVersion = 0
  let productModelPresentation: ProductModelPresentation = { defaultChatModel: null, modelOrder: [] }
  let productDefault: { version: number; selection: ModelSelection } | undefined
  ctx.inject(['agentDefaultModel'], (child) => {
    child.effect(() => child.agentDefaultModel.registerPolicySelection(() =>
      productDefault?.version === identityVersion ? productDefault.selection : undefined),
    'credits-index: account-authorized deployment default')
  })
  const chatUsage = new ChatUsageReader({ baseUrl: apiBaseUrl, timeoutMs: resolved.timeoutMs,
    cacheTtlMs: resolved.chatUsageCacheTtlMs, concurrency: resolved.chatUsageConcurrency })
  ctx.effect(() => () => chatUsage.dispose(), 'credits-index: current-account chat ledger')
  ctx.inject(['sessionProjections'], (projectionContext) => {
    projectionContext.sessionProjections.register(chatReceiptProjection)
  })
  let sessionMutations = Promise.resolve()
  /** Serialize session and credential writes so logout cannot be overwritten by an older exchange. */
  const mutateSession = async <T>(run: () => Promise<T>): Promise<T> => {
    const operation = sessionMutations.then(run)
    sessionMutations = operation.then(() => undefined, (_failure: unknown) => undefined)
    return await operation
  }

  /** Backend requests preserve the validated deployment path and never follow redirects. */
  const apiFetch = async (route: string, init: RequestInit = {}): Promise<Response> =>
    await fetch(apiUrl(apiBaseUrl, route), { ...init, redirect: 'error' })

  /** Remote artifact redirects cannot move a request onto another service. */
  const mediaFetch = async (url: string, init: RequestInit): Promise<Response> => {
    const target = new URL(url)
    if (target.hostname === '8.133.202.230') {
      if (target.origin !== 'https://8.133.202.230' || !target.pathname.startsWith('/harness/')) {
        throw new Error('artifact URL leaves the harness deployment')
      }
      apiUrl('https://8.133.202.230/harness', target.pathname.slice('/harness'.length) + target.search)
    }
    return await fetch(target, { ...init, redirect: 'error' })
  }

  /**
   * The signed-in account's own relay credential, or null when nobody is.
   *
   * This is the only key generation ever uses: the product's rule is that using
   * it requires a sign-in, and that whatever the account spends is what its
   * balance shows. There is deliberately no fallback — a fallback would mean a
   * request billed to the operator while the panel displays someone else.
   */
  const accountKey = async (live?: StoredSession): Promise<{ key: string } | { reason: 'signed-out' | 'no-credential' }> => {
    const session = live ?? await liveSession()
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

  /** Remove the model-route reference when the account signs out. */
  const releaseAccountCredential = async (): Promise<void> => {
    try { await ctx.get('credentials')?.unset(relayRef) } catch (_unwritableCredentialReference: unknown) {
      // A read-only environment reference cannot authorize this session-owned model route.
    }
  }

  /** Publish only this signed-in account's relay key to the model route. */
  const holdAccountCredential = async (key: string): Promise<void> => {
    try { await ctx.get('credentials')?.set(relayRef, key) } catch (_unwritableCredentialReference: unknown) {
      // Live session resolution remains authoritative when the optional reference cache is unwritable.
    }
  }

  /**
   * Ask the configured API which models it serves, split by the endpoint types
   * each one declares. This is the live source the model pickers follow, so a
   * channel added on the new-api side shows up here without any config edit.
   */
  const readNewApiModels = async (session?: StoredSession, signal?: AbortSignal): Promise<{
    ok: boolean
    code?: string
    message?: string
    chat: string[]
    image: string[]
    video: string[]
  }> => {
    const owned = await accountKey(session)
    if ('reason' in owned) return { ok: false, ...noCredential(owned.reason), chat: [], image: [], video: [] }
    const key = owned.key
    try {
      const response = await apiFetch('/v1/models', {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: signal ?? AbortSignal.timeout(resolved.timeoutMs),
      })
      if (!response.ok) return { ok: false, code: `HTTP_${String(response.status)}`, message: 'new-api 模型列表不可用', chat: [], image: [], video: [] }
      const payload: unknown = await response.json()
      const data = payload !== null && typeof payload === 'object' && 'data' in payload ? payload.data : undefined
      if (!Array.isArray(data)) return { ok: false, code: 'MODEL_CATALOG_INVALID', message: '模型列表格式无效', chat: [], image: [], video: [] }
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
        else if (endpoints.some(endpoint => ['video', 'video-generation', 'openai-video'].includes(endpoint))) video.push(id)
        else chat.push(id)
      }
      return { ok: true, chat, image, video }
    } catch (error) {
      return { ok: false, code: 'TRANSPORT', message: error instanceof Error ? error.message : String(error), chat: [], image: [], video: [] }
    }
  }

  /** The current account's live model group; another account's cached group is never reused. */
  const readUserGroup = async (): Promise<string | null> => {
    const session = await liveSession()
    if (session === null) return null
    return (await readSelf(session))?.group ?? null
  }

  /**
   * The deployment's own media catalog: `/api/pricing` is public on new-api, so
   * this read needs no credential and follows the running gateway — add a
   * channel on the new-api side and its declared image and video models appear
   * in the panels. Submission still validates account access and billing.
   */
  const readMediaCatalog = async (signal?: AbortSignal): Promise<{
    ok: boolean
    code?: string
    message?: string
    group: string | null
    models: ModelCapability[]
  }> => {
    const group = await readUserGroup()
    try {
      const response = await apiFetch('/api/pricing', {
        headers: { accept: 'application/json' },
        signal: signal === undefined ? AbortSignal.timeout(resolved.timeoutMs)
          : AbortSignal.any([signal, AbortSignal.timeout(resolved.timeoutMs)]),
      })
      if (!response.ok) {
        return { ok: false, code: `HTTP_${String(response.status)}`, message: 'new-api 定价表不可用', group, models: [] }
      }
      const body = await response.json() as { data?: unknown }
      const rows = Array.isArray(body.data) ? body.data : []
      const order = new Map(productModelPresentation.modelOrder.map((id, index) => [id, index]))
      const last = order.size
      const models = catalogFromPricing(rows, group).toSorted((left, right) =>
        (order.get(left.id) ?? last) - (order.get(right.id) ?? last))
      return { ok: true, group, models }
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
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
  }

  /** Persist one uploaded reference and report where it landed. */
  const storeReference = async (
    assetId: string,
    bytes: Buffer,
    mediaType: string,
    originalName: string,
    accountId?: string,
  ): Promise<{ path: string; filename: string }> => {
    await mkdir(referenceDir, { recursive: true, mode: 0o700 })
    const extension = Object.entries(MEDIA_TYPE_BY_EXTENSION).find(([, type]) => type === mediaType)?.[0] ?? 'bin'
    const filename = `${assetId}.${extension}`
    const target = join(referenceDir, filename)
    await writeFile(target, bytes, { mode: 0o600 })
    await writeFile(`${target}.json`, `${JSON.stringify({ mediaType, originalName, ...accountId === undefined ? {} : { accountId } }, null, 2)}\n`, { mode: 0o600 })
    return { path: target, filename }
  }

  /** Read one stored reference back, with the media type it was uploaded as. */
  const readReference = async (assetId: string): Promise<{
    bytes: Buffer
    mediaType: string
    filename: string
    accountId?: string
  } | null> => {
    if (!/^ma_[A-Za-z0-9]{1,64}$/.test(assetId)) return null
    try {
      const entries = await readdir(referenceDir)
      const match = entries.find(entry => entry.startsWith(`${assetId}.`) && !entry.endsWith('.json'))
      if (match === undefined) return null
      const bytes = await readFile(join(referenceDir, match))
      const meta = JSON.parse(await readFile(join(referenceDir, `${match}.json`), 'utf8')) as { mediaType?: unknown; originalName?: unknown; accountId?: unknown }
      const extension = match.split('.').pop() ?? 'bin'
      return {
        bytes,
        mediaType: typeof meta.mediaType === 'string' ? meta.mediaType : MEDIA_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream',
        filename: typeof meta.originalName === 'string' ? meta.originalName : match,
        ...typeof meta.accountId === 'string' ? { accountId: meta.accountId } : {},
      }
    } catch {
      return null
    }
  }

  /** Snapshot only an authorized workspace file, sharing upload signatures and byte limits. */
  const normalizeVideoReference = async (
    value: string,
    kind: 'image' | 'video' | 'audio',
    workspaceRoot: string | undefined,
    references: Map<string, string>,
    signal: AbortSignal,
  ): Promise<string> => {
    const maxBytes = Math.min(resolved.videoProjectReferenceMaxBytes, (kind === 'image' ? 6 : kind === 'audio' ? 15 : 32) * 1024 * 1024)
    if (/^ma_[A-Za-z0-9]{1,64}$/u.test(value)) {
      const stored = await readReference(value)
      signal.throwIfAborted()
      if (stored === null || !stored.mediaType.startsWith(`${kind}/`) || !referenceSignature(stored.bytes, stored.mediaType) || stored.bytes.length > maxBytes) {
        throw new VideoProjectError('VIDEO_REFERENCE_INVALID', '参考素材不存在、类型不匹配或超过大小限制，请重新添加对应素材')
      }
      return value
    }
    if (workspaceRoot === undefined || !isAbsolute(workspaceRoot)) throw new VideoProjectError('WORKSPACE_REQUIRED', '请先选择工作区文件夹，再使用参考素材路径')
    const fileSystem = ctx.get('fs')
    if (fileSystem === undefined) throw new VideoProjectError('VIDEO_EDIT_SERVICE_UNAVAILABLE', '当前工作区的文件服务未准备好，请联系管理员')
    const cacheKey = `${kind}:${value}`
    const cached = references.get(cacheKey)
    if (cached !== undefined) return cached
    const root = await fileSystem.resolve(workspaceRoot, { signal })
    const target = await fileSystem.resolve(value, { cwd: workspaceRoot, signal })
    const entry = await fileSystem.lstat(value, { cwd: workspaceRoot }, signal)
    if (entry?.type !== 'file' || !fileSystem.contains(root, target)) {
      throw new VideoProjectError('VIDEO_REFERENCE_INVALID', '参考素材必须是当前工作区内可读取的普通文件')
    }
    if (entry.size !== undefined && entry.size > maxBytes) throw new VideoProjectError('VIDEO_REFERENCE_INVALID', '参考素材超过大小限制，请缩小后重试')
    const bytes = Buffer.from(await fileSystem.readBytes(target, signal, maxBytes))
    const mediaType = [...ALLOWED_ASSET_TYPES, ...ALLOWED_REFERENCE_VIDEO_TYPES, ...ALLOWED_REFERENCE_AUDIO_TYPES]
      .find(type => referenceSignature(bytes, type))
    if (mediaType === undefined || !mediaType.startsWith(`${kind}/`)) {
      throw new VideoProjectError('VIDEO_REFERENCE_INVALID', '请提供对应类型的 PNG、JPEG、WebP 图片、MP4/MOV 视频或 WAV/MP3 音频')
    }
    const id = 'ma_' + randomBytes(16).toString('hex')
    signal.throwIfAborted()
    await storeReference(id, bytes, mediaType, basename(fileSystem.processPath(target)))
    references.set(cacheKey, id)
    return id
  }

  /** One published media capability, or a readable catalog lookup failure. */
  const capabilityFor = async (
    kind: 'image' | 'video',
    id: string | null,
    signal?: AbortSignal,
  ): Promise<{ ok: true; model: ModelCapability } | { ok: false; code: string; message: string; catalog: ModelCapability[] }> => {
    const catalog = await readMediaCatalog(signal)
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
   * Submit one prepared video job to the configured API and wait for its file.
   * The server's task plugin maps the prepared fields to its selected upstream.
   */
  const runVideoTask = async (
    key: string,
    route: string,
    request: Record<string, unknown>,
    signal = new AbortController().signal,
    submitting?: () => Promise<void>,
  ): Promise<MediaOutcome> => {
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' }
    try {
      const output = await captureMediaOutput(ctx.get('artifactStorage'), join(stateDir, 'media'), signal)
      signal.throwIfAborted()
      await submitting?.()
      signal.throwIfAborted()
      const created = await apiFetch(route, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(resolved.timeoutMs, 120_000))]),
      })
      const createdText = await created.text()
      if (!created.ok) {
        const balanceRejected = isAccountBalanceRejectionText(createdText, created.status)
        return { ok: false, code: balanceRejected ? 'INSUFFICIENT_BALANCE' : `HTTP_${String(created.status)}`, message: balanceRejected ? '余额不足，请充值；提交结果尚未确认，请先检查已有任务，不要重复提交。' : createdText.slice(0, 400) }
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
        if (signal.aborted) return { ok: false, code: 'ABORTED', message: '任务已取消', taskId }
        await waitForMedia(attempt === 0 ? 4000 : 6000, signal)
        const read = await apiFetch(`${route}/${encodeURIComponent(taskId)}`, {
          headers, signal: AbortSignal.any([signal, AbortSignal.timeout(resolved.timeoutMs)]),
        })
        const readText = await read.text()
        let readBody: Record<string, unknown> | null = null
        try { readBody = JSON.parse(readText) as Record<string, unknown> } catch { readBody = null }
        const readNested = readBody?.data !== null && typeof readBody?.data === 'object'
          ? readBody.data as Record<string, unknown>
          : null
        const status = (readString(readBody, 'task_status') ?? readString(readBody, 'status')
          ?? readString(readNested, 'task_status') ?? readString(readNested, 'status'))?.toLowerCase()
        const result = readNested?.task_result ?? readBody?.task_result
        const videos = result !== null && typeof result === 'object' ? (result as Record<string, unknown>).videos : null
        const first = Array.isArray(videos) ? videos[0] as Record<string, unknown> | undefined : undefined
        const remote = typeof first?.url === 'string' ? first.url : null
        // The gateway answers with `completed`, the vendors with `succeed` /
        // `succeeded` / `success`; all three mean the file is ready, and a
        // body that already carries a URL is ready whatever it calls itself.
        if (status === 'succeed' || status === 'succeeded' || status === 'success' || status === 'completed' || remote !== null) {
          const filename = `vid-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.mp4`
          const response_ = remote === null
            ? await apiFetch(`/v1/videos/${encodeURIComponent(taskId)}/content`, {
              headers, signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
            })
            : await mediaFetch(remote, { signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]) })
          if (!response_.ok) {
            return { ok: false, code: 'CONTENT_FAILED', message: `取回视频失败（HTTP ${String(response_.status)}）`, taskId }
          }
          const saved = await output.write(filename, Buffer.from(await response_.arrayBuffer()))
          return { ok: true, taskId, path: saved.path }
        }
        if (status === 'failed' || status === 'failure' || status === 'fail' || status === 'error' || status === 'cancelled' || status === 'canceled') {
          return { ok: false, code: 'TASK_FAILED', message: readText.slice(0, 400), taskId }
        }
      }
      return { ok: false, code: 'TIMEOUT', message: '任务仍在运行，稍后可在「产物」面板查看。', taskId }
    } catch (error) {
      return { ok: false, code: error instanceof VideoProjectError ? error.code : 'TRANSPORT', message: error instanceof Error ? error.message : String(error) }
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
    const resolution = readString(body, 'resolution')
    if (resolution !== null && params.resolutions.length > 0 && !params.resolutions.includes(resolution)) {
      return { ok: false, code: 'RESOLUTION_NOT_SUPPORTED', message: `${model.id} 的分辨率可选：${params.resolutions.join('、')}` }
    }
    const durations = videoDurations(params, resolution)
    const duration = body.durationSeconds === undefined ? durations[0] : body.durationSeconds
    if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || !durations.includes(duration)) {
      return { ok: false, code: 'DURATION_NOT_SUPPORTED', message: `${model.id} 当前分辨率的时长可选：${durations.join('、') || '无'} 秒，请选择受支持的分辨率和时长` }
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
    if (audio !== null && !params.audioToggle && audio !== params.audio) {
      return { ok: false, code: 'AUDIO_NOT_SUPPORTED', message: params.audio ? `${model.id} 原生生成音频，不能关闭音轨` : `${model.id} 不支持生成音频` }
    }
    for (const field of ['frameImages', 'referenceImages', 'referenceVideos', 'referenceAudios']) {
      const ids = body[field]
      if (ids !== undefined && (!Array.isArray(ids)
        || ids.some(id => typeof id !== 'string' || !/^ma_[A-Za-z0-9]{1,64}$/u.test(id)))) {
        return { ok: false, code: 'REFERENCE_MISSING', message: '参考素材编号无效，请重新添加对应素材' }
      }
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
    if (ratio === 'adaptive' && frames.length + referenceImages.length + referenceVideos.length === 0) {
      return { ok: false, code: 'RATIO_NOT_SUPPORTED', message: '自适应比例需要实际提交图片或视频参考' }
    }

    let referenceBytes = 0
    let imageBytes = 0
    /** Validate the stored kind, signature and complete byte budget before billing. */
    const inline = async (ids: readonly string[], kind: 'image' | 'video' | 'audio'): Promise<string[] | null> => {
      const values: string[] = []
      for (const id of ids) {
        const value = await readReference(id)
        if (value === null || !value.mediaType.startsWith(`${kind}/`) || !referenceSignature(value.bytes, value.mediaType)) return null
        const limit = (kind === 'image' ? 6 : kind === 'audio' ? 15 : 32) * 1024 * 1024
        referenceBytes += value.bytes.length
        if (kind === 'image') imageBytes += value.bytes.length
        if (value.bytes.length > limit || referenceBytes > 48 * 1024 * 1024 || imageBytes > 12 * 1024 * 1024) return null
        values.push(`data:${value.mediaType};base64,${value.bytes.toString('base64')}`)
      }
      return values
    }
    const frameUrls = await inline(frames, 'image')
    const imageUrls = await inline(referenceImages, 'image')
    const videoUrls = await inline(referenceVideos, 'video')
    const audioUrls = await inline(referenceAudios, 'audio')
    if (frameUrls === null || imageUrls === null || videoUrls === null || audioUrls === null) {
      return { ok: false, code: 'REFERENCE_MISSING', message: '参考素材已失效、类型不匹配或超过大小限制，请重新添加对应素材' }
    }

    const metadata: Record<string, unknown> = {}
    if (ratio !== null) metadata.ratio = ratio
    // The frame images are named explicitly: the gateway's video plugins read
    // `metadata.first_frame_image` / `last_frame_image` in preference to the
    // positional `images` array, so a model with two slots gets the shot it was
    // told to make rather than whichever one happened to be first.
    if (frameUrls[0] !== undefined) metadata.first_frame_image = frameUrls[0]
    if (frameUrls[1] !== undefined) metadata.last_frame_image = frameUrls[1]
    if (model.id === 'MiniMax-H3' && imageUrls.length + videoUrls.length + audioUrls.length > 0) {
      // H3 treats content as the complete reference list and ignores the flat fields once it exists.
      metadata.content = [
        { type: 'text', text: prompt },
        ...imageUrls.map(url => ({ type: 'image_url', role: 'reference_image', image_url: { url } })),
        ...videoUrls.map(url => ({ type: 'video_url', role: 'reference_video', video_url: { url } })),
        ...audioUrls.map(url => ({ type: 'audio_url', role: 'reference_audio', audio_url: { url } })),
      ]
    } else if (imageUrls.length > 0) {
      metadata.content = [{ type: 'text', text: prompt }, ...imageUrls.map(url => ({ type: 'image_url', role: 'reference_image', image_url: { url } }))]
    }
    if (model.id !== 'MiniMax-H3') {
      if (videoUrls.length > 0) metadata.reference_video = videoUrls
      if (audioUrls.length > 0) metadata.reference_audio = audioUrls
    }

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
    if (Buffer.byteLength(JSON.stringify(request)) > 64 * 1024 * 1024) {
      return { ok: false, code: 'REFERENCE_REQUEST_TOO_LARGE', message: '参考素材编码后超过请求大小限制，请减少素材后重试；尚未提交生成' }
    }
    return { ok: true, request }
  }

  /**
   * Generate images on the local new-api, one entry point for the panel and the
   * tool. Text-to-image posts the documented JSON body; a request carrying
   * reference images posts multipart to `/images/edits`, which is the shape
   * new-api's own image adapter reads. The internal task model instead uploads
   * authorized references through this gateway before sending receipt URLs.
   */
  const runImageGeneration = async (
    key: string,
    body: Record<string, unknown>,
    signal = new AbortController().signal,
    savedOutput?: (path: string) => Promise<void>,
    submitting?: () => Promise<void>,
  ): Promise<MediaOutcome & { paths?: readonly string[]; mode?: string }> => {
    signal.throwIfAborted()
    const prompt = readString(body, 'prompt')
    if (prompt === null) return { ok: false, code: 'INVALID_REQUEST', message: 'prompt 必填' }
    const capability = await capabilityFor('image', readString(body, 'model'), signal)
    if (!capability.ok) {
      return {
        ok: false,
        code: capability.code,
        message: `${capability.message}${capability.catalog.length === 0 ? '' : `（可用：${capability.catalog.map(entry => entry.id).join('、')}）`}`,
      }
    }
    const params = capability.model.params as ImageParams
    const model = capability.model.id
    const internalImage = model === 'yunshu-internal-gpt-image-2'
    const size = internalImage ? null : readString(body, 'size')
    if (size !== null && params.sizes.length > 0 && !params.sizes.includes(size)) {
      return { ok: false, code: 'SIZE_NOT_SUPPORTED', message: `${model} 不支持 ${size}，可选：${params.sizes.join('、')}` }
    }
    const quality = internalImage ? null : readString(body, 'quality')
    if (quality !== null && params.qualities.length > 0 && !params.qualities.includes(quality)) {
      return { ok: false, code: 'QUALITY_NOT_SUPPORTED', message: `${model} 不支持 ${quality}，可选：${params.qualities.join('、')}` }
    }
    // Every optional field below is "not sent" unless the caller chose one, so
    // a model that has never heard of `background` is never asked about it.
    const background = internalImage ? null : readString(body, 'background')
    if (background !== null && params.backgrounds.length > 0 && !params.backgrounds.includes(background)) {
      return { ok: false, code: 'BACKGROUND_NOT_SUPPORTED', message: `${model} 不支持背景 ${background}，可选：${params.backgrounds.join('、')}` }
    }
    const format = internalImage ? null : readString(body, 'format')
    if (format !== null && params.formats.length > 0 && !params.formats.includes(format)) {
      return { ok: false, code: 'FORMAT_NOT_SUPPORTED', message: `${model} 不支持输出格式 ${format}，可选：${params.formats.join('、')}` }
    }
    const moderation = internalImage ? null : readString(body, 'moderation')
    if (moderation !== null && params.moderations.length > 0 && !params.moderations.includes(moderation)) {
      return { ok: false, code: 'MODERATION_NOT_SUPPORTED', message: `${model} 不支持审核级别 ${moderation}，可选：${params.moderations.join('、')}` }
    }
    const rawCompression = !internalImage && typeof body.compression === 'number' ? Math.round(body.compression) : null
    if (rawCompression !== null && (rawCompression < 0 || rawCompression > 100)) {
      return { ok: false, code: 'COMPRESSION_NOT_SUPPORTED', message: '压缩质量需要在 0–100 之间' }
    }
    const compression = rawCompression !== null && format !== null && format !== 'png' ? rawCompression : null
    const seed = !internalImage && typeof body.seed === 'number' && Number.isInteger(body.seed) ? body.seed : null
    if (seed !== null && !params.seed) {
      return { ok: false, code: 'SEED_NOT_SUPPORTED', message: `${model} 不支持随机种子` }
    }
    const count = typeof body.count === 'number' && Number.isInteger(body.count) ? body.count : 1
    if (count < 1 || count > params.maxCount) {
      return { ok: false, code: 'COUNT_NOT_SUPPORTED', message: `${model} 一次可出 1–${String(params.maxCount)} 张` }
    }
    const references = referenceIds(body.references)
    if (internalImage && body.references !== undefined && (!Array.isArray(body.references)
      || references.length !== body.references.length)) {
      return { ok: false, model, code: 'IMAGE_REFERENCE_INVALID', message: '参考图编号无效，请重新添加图片；尚未提交生成。' }
    }
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
      const output = await captureMediaOutput(ctx.get('artifactStorage'), join(stateDir, 'media'), signal)
      const beforeSubmission = async (): Promise<void> => {
        signal.throwIfAborted()
        await submitting?.()
        signal.throwIfAborted()
      }
      // A plugin-served model answers on its own path and hands back a task;
      // the OpenAI host protocol answers inline on `/v1/images/generations`.
      if (capability.model.route !== '/v1/images/generations') {
        const referenceUrls: string[] = []
        if (internalImage && references.length > 0) {
          const prepared: { bytes: Buffer; mediaType: string; filename: string }[] = []
          const session = await liveSession()
          for (const [index, assetId] of references.entries()) {
            const file = await readReference(assetId)
            const filename = file === null ? `参考图 ${String(index + 1)}`
              : basename(file.filename.replace(/\\/gu, '/')).replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 256) || `参考图 ${String(index + 1)}`
            const invalid = file === null ? '已失效，请重新上传'
              : file.accountId !== undefined && file.accountId !== session?.account.id ? '不属于当前账号，请重新上传'
                : !ALLOWED_ASSET_TYPES.has(file.mediaType) ? '只支持 PNG、JPEG 或 WebP 图片'
                  : file.bytes.length === 0 ? '内容为空，请重新选择图片'
                    : file.bytes.length > 10 * 1024 * 1024 ? '超过 10 MB，请缩小后重新上传'
                      : !referenceSignature(file.bytes, file.mediaType) ? '内容与图片格式不匹配，请重新上传' : undefined
            if (file === null || invalid !== undefined) {
              return { ok: false, model, code: 'IMAGE_REFERENCE_INVALID', message: `参考图「${filename}」${invalid ?? '不可读取'}；尚未提交生成。` }
            }
            prepared.push({ ...file, filename })
          }
          // Validate every local image before sending any bytes. Uploads have
          // no generation charge; only the later generation POST is dispatched.
          for (const file of prepared) {
            if ((await liveSession())?.relay?.key !== key) {
              return { ok: false, model, code: 'AUTH_REQUIRED', message: '登录状态已变化，请重新登录；尚未提交生成。' }
            }
            const form = new FormData()
            form.set('model', model)
            const extension = file.mediaType === 'image/jpeg' ? 'jpg' : file.mediaType === 'image/webp' ? 'webp' : 'png'
            form.set('file', new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }), `reference.${extension}`)
            let uploaded: Response
            let receipt: unknown
            try {
              signal.throwIfAborted()
              uploaded = await apiFetch('/v1/uploads/images', {
                method: 'POST', headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, body: form,
                signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(resolved.timeoutMs, 60_000))]),
              })
              receipt = uploaded.ok ? await uploaded.json() : null
            } catch {
              signal.throwIfAborted()
              return { ok: false, model, code: 'IMAGE_REFERENCE_UPLOAD_FAILED', message: `参考图「${file.filename}」上传未完成，请稍后重试；尚未提交生成。` }
            }
            if (!uploaded.ok) {
              const reason = uploaded.status === 401 ? '登录已失效，请重新登录'
                : uploaded.status === 403 ? '当前账号无权上传图片'
                  : uploaded.status === 413 ? '超过上传大小限制，请缩小图片'
                    : uploaded.status === 400 || uploaded.status === 415 ? '图片格式或内容不受支持，请重新选择'
                      : uploaded.status === 429 ? '上传过于频繁，请稍后重试' : '服务器繁忙，请稍后重试'
              return { ok: false, model, code: 'IMAGE_REFERENCE_UPLOAD_FAILED', message: `参考图「${file.filename}」${reason}；尚未提交生成。` }
            }
            const result = receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt) ? receipt as Record<string, unknown> : null
            const data = result?.data !== null && typeof result?.data === 'object' && !Array.isArray(result.data) ? result.data as Record<string, unknown> : null
            const remote = readString(data, 'url')
            let validUrl = false
            if (remote !== null && remote.length <= 2048 && !/[\u0000-\u0020\u007f\\?#]/u.test(remote)) {
              try {
                const url = new URL(remote)
                validUrl = (url.origin === 'https://files.toapis.cn' || url.origin === 'https://files.toapis.com')
                  && url.pathname.startsWith('/uploads/') && url.pathname.length > '/uploads/'.length
                  && url.username === '' && url.password === '' && url.search === '' && url.hash === ''
              } catch { validUrl = false }
            }
            if (result?.success !== true || !validUrl || remote === null || readString(data, 'id') === null
              || data?.mime_type !== file.mediaType || data.size !== file.bytes.length) {
              return { ok: false, model, code: 'IMAGE_REFERENCE_UPLOAD_INVALID', message: `参考图「${file.filename}」上传回执无效，请稍后重试；尚未提交生成。` }
            }
            referenceUrls.push(remote)
          }
        }
        await beforeSubmission()
        const submitted = await apiFetch(capability.model.route, {
          method: 'POST',
          headers,
          body: JSON.stringify(internalImage
            ? { model, prompt, n: 1, ...referenceUrls.length === 0 ? {} : { reference_images: referenceUrls } }
            : { model, prompt, n: count, ...extras }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(resolved.timeoutMs, 60_000))]),
        })
        const submittedText = await submitted.text()
        if (!submitted.ok) {
          const balanceRejected = isAccountBalanceRejectionText(submittedText, submitted.status)
          return { ok: false, model, code: balanceRejected ? 'INSUFFICIENT_BALANCE' : `HTTP_${String(submitted.status)}`, message: balanceRejected ? '余额不足，请充值' : submittedText.slice(0, 400) }
        }
        let submittedBody: Record<string, unknown> | null = null
        try { submittedBody = JSON.parse(submittedText) as Record<string, unknown> } catch { submittedBody = null }
        const taskId = readString(submittedBody, 'id') ?? readString(submittedBody, 'task_id')
        if (taskId === null) {
          return { ok: false, model, code: 'NO_TASK_ID', message: submittedText.slice(0, 400) }
        }
        for (let attempt = 0; attempt < 120; attempt += 1) {
          if (attempt > 0) await waitForMedia(attempt < 5 ? 2000 : 4000, signal)
          const read = await apiFetch(
            `${capability.model.route}/${encodeURIComponent(taskId)}`,
            { headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(resolved.timeoutMs)]) },
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
          for (const [index, item] of items.entries()) {
            if (item === null || typeof item !== 'object') continue
            const entry = item as Record<string, unknown>
            const remote = readString(entry, 'url')
            const b64 = readString(entry, 'b64_json')
            let bytes: Buffer | null = null
            if (b64 !== null) bytes = Buffer.from(b64, 'base64')
            else if (remote !== null) {
              const image = await mediaFetch(remote, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) })
              if (image.ok) bytes = Buffer.from(await image.arrayBuffer())
            }
            if (bytes === null) continue
            const suffix = format === 'jpeg' ? 'jpg' : format === 'webp' ? 'webp' : 'png'
            const filename = `gen-${new Date().toISOString().replace(/[:.]/g, '-')}-${String(index)}-${randomBytes(3).toString('hex')}.${suffix}`
            const path = (await output.write(filename, bytes)).path
            await savedOutput?.(path)
            saved.push(path)
          }
          if (saved.length > 0) {
            return { ok: true, model, path: saved[0], paths: saved, mode: referenceUrls.length === 0 ? 'generate' : 'edit' }
          }
        }
        return { ok: false, model, code: 'TIMEOUT', message: '任务仍在运行，稍后可重试。' }
      }
      const upstream = references.length === 0
        ? await (async (): Promise<Response> => {
          await beforeSubmission()
          return apiFetch('/v1/images/generations', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model,
              prompt,
              n: count,
              response_format: 'b64_json',
              ...extras,
            }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(resolved.timeoutMs, 180_000))]),
          })
        })()
        : await (async (): Promise<Response> => {
          const form = new FormData()
          form.set('model', model)
          form.set('prompt', prompt)
          form.set('n', String(count))
          for (const [field, value] of Object.entries(extras)) form.set(field, String(value))
          for (const assetId of references) {
            const file = await readReference(assetId)
            if (file === null) throw new Error(`参考图 ${assetId} 已失效，请重新上传`)
            const extension = file.mediaType === 'image/jpeg' ? 'jpg' : file.mediaType === 'image/webp' ? 'webp' : 'png'
            form.append('image[]', new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }), `reference-${String(form.getAll('image[]').length + 1)}.${extension}`)
          }
          await beforeSubmission()
          return await apiFetch('/v1/images/edits', {
            method: 'POST',
            headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
            body: form,
            signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(resolved.timeoutMs, 300_000))]),
          })
        })()
      const text = await upstream.text()
      if (!upstream.ok) {
        const balanceRejected = isAccountBalanceRejectionText(text, upstream.status)
        return { ok: false, model, code: balanceRejected ? 'INSUFFICIENT_BALANCE' : `HTTP_${String(upstream.status)}`, message: balanceRejected ? '余额不足，请充值' : text.slice(0, 400) }
      }
      let payload: unknown = null
      try { payload = JSON.parse(text) } catch { payload = null }
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
            const image = await mediaFetch(remote, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) })
            if (!image.ok) continue
            bytes = Buffer.from(await image.arrayBuffer())
          }
          if (bytes === null) continue
          const filename = `gen-${stamp}-${String(saved.length)}-${randomBytes(3).toString('hex')}.${extension}`
          const path = (await output.write(filename, bytes)).path
          await savedOutput?.(path)
          saved.push(path)
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
            if (attempt > 0) await waitForMedia(attempt < 5 ? 2000 : 4000, signal)
            const read = await apiFetch(`${capability.model.route}/${encodeURIComponent(taskId)}`, {
              headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
              signal: AbortSignal.any([signal, AbortSignal.timeout(resolved.timeoutMs)]),
            })
            if (!read.ok) {
              const body = await read.text()
              return {
                ok: false,
                model,
                code: 'ASYNC_TASK_NOT_READABLE',
                message: `上游把生图做成了异步任务（task ${taskId}），而本机 new-api 没有回读路由（${capability.model.route}/{id} 返回 HTTP ${String(read.status)}）。`
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
            if (await saveImages(list) > 0) {
              return { ok: true, model, path: saved[0], paths: saved, mode: 'generate' }
            }
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
      return { ok: false, code: error instanceof VideoProjectError ? error.code : 'TRANSPORT', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Cookie rotation and logout declare the backend origin, without its deployment path. */
  const declaredOrigin = { origin: new URL(apiBaseUrl).origin }

  /** Live quota conversion parameters; unavailable status never supplies a guessed rate. */
  const readQuotaRate = async (): Promise<{ quotaPerUnit: number; usdExchangeRate: number }> => {
    const status = await apiFetch('/api/status', { signal: AbortSignal.timeout(resolved.timeoutMs) })
    const body = await status.json() as { success?: unknown; data?: { quota_per_unit?: unknown; usd_exchange_rate?: unknown } } | null
    const quotaPerUnit = body?.data?.quota_per_unit
    const usdExchangeRate = body?.data?.usd_exchange_rate
    if (!status.ok || body?.success !== true || typeof quotaPerUnit !== 'number' || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0
      || typeof usdExchangeRate !== 'number' || !Number.isFinite(usdExchangeRate) || usdExchangeRate <= 0) {
      throw new Error('BALANCE_UNAVAILABLE')
    }
    return { quotaPerUnit, usdExchangeRate }
  }

  /** Convert quota using the current backend parameters and the configured product units. */
  const convertQuota = (quota: number, rate: { quotaPerUnit: number; usdExchangeRate: number }): { points: number; yuan: number } => {
    if (!Number.isFinite(quota) || quota < 0) throw new Error('BALANCE_UNAVAILABLE')
    const yuan = quota / rate.quotaPerUnit * rate.usdExchangeRate
    if (!Number.isFinite(yuan)) throw new Error('BALANCE_UNAVAILABLE')
    return { yuan, points: Math.round(yuan * resolved.creditsPerYuan) }
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

  /** Only one refresh exchange may rotate a given account's cookie at a time. */
  let renewal: { token: string; promise: Promise<StoredSession | null> } | null = null

  const refreshSession = async (previous: StoredSession): Promise<StoredSession | null> => {
    const owner = previous.token
    const refresh = previous.upstream?.refresh
    const current = await store.read()
    if (owner === undefined || refresh === undefined || current?.token !== owner) return null
    if (current.upstream?.token !== previous.upstream?.token) return current
    const version = identityVersion
    if (renewal !== null) {
      if (renewal.token !== owner) { await renewal.promise; return null }
      const result = await renewal.promise
      return version === identityVersion ? result : null
    }
    const attempt = exchangeRefreshToken(previous, version)
    renewal = { token: owner, promise: attempt }
    try {
      const result = await attempt
      return version === identityVersion ? result : null
    } finally {
      renewal = null
    }
  }

  const exchangeRefreshToken = async (previous: StoredSession, version: number): Promise<StoredSession | null> => {
    try {
      const answered = await apiFetch('/api/user/auth/refresh', {
        method: 'POST', headers: { cookie: `new_api_refresh=${previous.upstream?.refresh ?? ''}`,
          ...declaredOrigin, 'content-type': 'application/json', accept: 'application/json' },
        body: '{}', signal: AbortSignal.timeout(resolved.timeoutMs),
      })
      const payload = await answered.json() as {
        success?: unknown
        data?: { access_token?: unknown; access_expires_at?: unknown; user?: { id?: unknown } }
      } | null
      const token = payload?.data?.access_token
      const expiry = payload?.data?.access_expires_at
      const id = payload?.data?.user?.id
      if (!answered.ok || payload?.success !== true || typeof token !== 'string' || token.trim() === ''
        || typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry * 1000 <= Date.now()
        || !Number.isFinite(new Date(expiry * 1000).getTime()) || String(id) !== previous.account.id) return null
      const rotated = refreshFromSetCookie(answered) ?? previous.upstream?.refresh
      const candidate: StoredSession = { ...previous, backendBaseUrl: apiBaseUrl,
        upstream: { token, refresh: rotated, expiresAt: new Date(expiry * 1000).toISOString() } }
      await mutateSession(async () => {
        const current = await store.read()
        if (version === identityVersion && current?.token === previous.token && candidate.token !== undefined) {
          await store.write({ ...candidate, token: candidate.token })
        }
      })
      return candidate
    } catch {
      return null
    }
  }

  /** A stored login belongs to one backend, and awaits renewal before protected calls. */
  const liveSession = async (): Promise<StoredSession | null> => {
    const session = await store.read()
    if (session?.token === undefined) return null
    const bound = session.backendBaseUrl ?? (isLoopbackOrigin(apiBaseUrl) ? apiBaseUrl : undefined)
    const expiry = Date.parse(session.upstream?.expiresAt ?? '')
    if (bound !== apiBaseUrl || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()
      || (!Number.isFinite(expiry) && !isLoopbackOrigin(apiBaseUrl))) {
      await mutateSession(async () => {
        if ((await store.read())?.token !== session.token) return
        identityVersion += 1
        chatUsage.reset()
        await store.clear()
        await releaseAccountCredential()
      })
      return null
    }
    if (Number.isFinite(expiry) && expiry - Date.now() < 60_000) {
      const renewed = await refreshSession(session)
      return renewed
    }
    return session
  }

  /** Replay only an explicitly rejected access request, once, after serialized renewal. */
  const accountFetch = async (session: StoredSession, route: string, init: RequestInit = {}): Promise<Response> => {
    const send = async (current: StoredSession): Promise<Response> => await apiFetch(route, { ...init,
      headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${current.upstream?.token ?? ''}` },
      signal: init.signal ?? AbortSignal.timeout(resolved.timeoutMs) })
    const answered = await send(session)
    if (answered.status !== 401) return answered
    const renewed = await refreshSession(session)
    if (renewed === null || (await store.read())?.token !== session.token) return answered
    return await send(renewed)
  }

  const activityLife = new AbortController()
  const activitySessions = new ClientActivitySessions()
  const activityOperations = new Set<Promise<unknown>>()
  let previousActivity: { session: StoredSession; sample: ClientActivitySample } | undefined
  /** An activity failure never changes login, balance, model calls, or user-visible operation results. */
  const sendActivity = async (session: StoredSession, sample: ClientActivitySample, signal: AbortSignal): Promise<void> => {
    const response = await apiFetch('/api/client-activity/heartbeat', {
      method: 'POST', headers: { authorization: `Bearer ${session.upstream?.token ?? ''}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(sample), signal,
    })
    await response.body?.cancel()
    if (!response.ok) throw new Error('Client activity unavailable')
  }
  const stopActivity = async (token?: string): Promise<void> => {
    const previous = previousActivity
    if (previous === undefined || (token !== undefined && previous.session.token !== token)) return
    previousActivity = undefined
    activitySessions.clear()
    try { await sendActivity(previous.session, { ...previous.sample, event: 'stop', foreground: false }, AbortSignal.timeout(2_000)) }
    catch (_unavailableActivityServer: unknown) { /* Server heartbeat expiry represents an unconfirmed exit. */ }
  }
  ctx.effect(() => async () => {
    activityLife.abort()
    await Promise.allSettled([...activityOperations])
    await stopActivity()
  }, 'credits-index: current-account Desktop activity')

  let modelCatalogClosed = false
  let modelCatalogFlight: { version: number; token: string; controller: AbortController; promise: Promise<readonly string[]> } | null = null
  const modelCatalogOperations = new Set<Promise<readonly string[]>>()

  const reportModelRefreshFailure = (error: unknown): void => {
    if (!modelCatalogClosed) {
      ctx.logger.warn(`credits-index: model sync unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Cancel discovery when its owning login is invalidated; late results still require an identity check. */
  const invalidateModelCatalog = (): void => {
    modelCatalogFlight?.controller.abort(new Error('product account changed'))
    modelCatalogFlight = null
  }

  /** Read exact model input declarations from installed catalogs without querying provider endpoints. */
  const installedModelInputs = async (ids: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, readonly string[]>> => {
    const llm = ctx.get('llm')
    if (llm === undefined) return new Map()
    const wanted = new Set(ids)
    const inputs = new Map<string, readonly string[] | null>()
    for (const entry of llm.listConfigurableProviders()) {
      if (entry.settingsNs !== resolved.chatSettingsNamespace || entry.declared !== false) continue
      signal.throwIfAborted()
      const catalog = await llm.discoverModels(entry.settingsNs, { provider: entry.provider }, signal)
      for (const model of catalog) {
        if (!wanted.has(model.id) || model.inputModalities === undefined || model.inputModalities.length === 0) continue
        const input = [...new Set(model.inputModalities)].sort((left, right) => left === right ? 0 : left === 'text' ? -1 : 1)
        const previous = inputs.get(model.id)
        if (previous === undefined) inputs.set(model.id, input)
        else if (previous !== null && (previous.length !== input.length || previous.some((value, index) => value !== input[index]))) {
          inputs.set(model.id, null)
        }
      }
    }
    return new Map([...inputs].flatMap(([id, input]) => input === null ? [] : [[id, input] as const]))
  }

  /** Preserve model overrides while filling missing inputs; empty live catalogs mask old configuration. */
  const writeProductModels = async (
    ids: readonly string[] | undefined,
    defaults: ReadonlyMap<string, readonly string[]> = new Map(),
  ): Promise<void> => {
    const settings = ctx.get('settings') as {
      describe?: (options?: { redactSecrets?: boolean }) => { ns: string; value?: unknown; revision?: number }[]
      replace?: (ns: string, section: object, expectedRevision?: number) => Promise<void>
    } | undefined
    if (settings?.describe === undefined || settings.replace === undefined) throw new Error('模型配置服务尚未就绪，请重试。')
    const descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === resolved.chatSettingsNamespace)
    const value = descriptor?.value as { providers?: Record<string, Record<string, unknown>> } | undefined
    const providers = value?.providers
    const route = resolved.chatProviderRoute
    const current = providers?.[route]
    if (providers === undefined || current === undefined) throw new Error('产品模型路由尚未配置，请联系管理员。')
    const baseURL = apiUrl(apiBaseUrl, '/v1')
    const api = 'openai-completions'
    const configured: readonly unknown[] = Array.isArray(current.models) ? current.models : []
    const previous = new Map<string, Record<string, unknown>>()
    for (const model of configured) {
      if (model !== null && typeof model === 'object' && 'id' in model && typeof model.id === 'string') {
        previous.set(model.id, model)
      }
    }
    const models = ids === undefined || ids.length === 0 ? configured : ids.map((id) => {
      const currentModel = previous.get(id) ?? { id }
      const input = defaults.get(id)
      return Array.isArray(currentModel.input) && currentModel.input.length > 0 || input === undefined
        ? currentModel
        : { ...currentModel, input: [...input] }
    })
    const sameModels = JSON.stringify(configured) === JSON.stringify(models)
    if (sameModels && current.baseURL === baseURL && current.api === api && current.apiKeyEnv === resolved.relayTokenEnv) return
    await settings.replace(resolved.chatSettingsNamespace, { providers: { ...providers,
      [route]: { ...current, baseURL, api, apiKeyEnv: resolved.relayTokenEnv,
        ...ids === undefined || ids.length === 0 ? {} : { models } },
    } }, descriptor?.revision)
  }

  /** A fresh catalog is committed only for the login that requested it. */
  const refreshProductModels = async (baseURL = apiUrl(apiBaseUrl, '/v1')): Promise<readonly string[]> => {
    if (modelCatalogClosed || baseURL.replace(/\/+$/u, '') !== apiUrl(apiBaseUrl, '/v1')) {
      throw new Error('产品模型地址或生命周期已变化，请重新读取模型列表。')
    }
    await sessionMutations
    const version = identityVersion
    const session = await liveSession()
    await sessionMutations
    if (version !== identityVersion) throw new Error('登录账号已变化，请重新读取模型列表。')
    if (session?.token === undefined) {
      await mutateSession(async () => {
        if (modelCatalogClosed || version !== identityVersion || (await store.read())?.token !== undefined) return
        await writeProductModels([])
      })
      throw new Error('请先登录产品账号，再读取可用模型。')
    }
    const ownerToken = session.token
    if (modelCatalogFlight?.version === version && modelCatalogFlight.token === ownerToken) return await modelCatalogFlight.promise
    invalidateModelCatalog()
    const controller = new AbortController()
    const promise = (async (): Promise<readonly string[]> => {
      const currentIdentity = async (): Promise<void> => {
        const current = await store.read()
        const bound = current?.backendBaseUrl ?? (isLoopbackOrigin(apiBaseUrl) ? apiBaseUrl : undefined)
        if (current === null || modelCatalogClosed || controller.signal.aborted || version !== identityVersion
          || current.token !== ownerToken || bound !== apiBaseUrl
          || !Number.isFinite(Date.parse(current.expiresAt))
          || Date.parse(current.expiresAt) <= Date.now()) throw new Error('登录账号已变化，请重新读取模型列表。')
      }
      await mutateSession(async () => { await currentIdentity(); await writeProductModels(undefined) })
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(resolved.timeoutMs)])
      const discovered = await readNewApiModels(session, signal)
      if (!discovered.ok) throw new Error('无法读取当前账号模型列表，请稍后重试。')
      const media = new Set<string>()
      const pricing = await apiFetch('/api/pricing', { headers: { accept: 'application/json' }, signal })
      if (!pricing.ok) throw new Error('无法核对聊天模型类型，请稍后重试。')
      const body = await pricing.json() as { data?: unknown }
      if (!Array.isArray(body.data)) throw new Error('模型类型列表无效，请稍后重试。')
      for (const id of mediaModelIds(body.data)) media.add(id)
      const chatIds = discovered.chat.filter(id => id !== '' && !media.has(id))
      const defaults = await installedModelInputs(chatIds, signal)
      let presentation = productModelPresentation
      try {
        const response = await apiFetch('/api/status', { headers: { accept: 'application/json' }, signal })
        if (!response.ok || response.body === null) throw new Error('Client model configuration unavailable')
        const chunks: Uint8Array[] = []
        let size = 0
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > 1024 * 1024) throw new Error('Client model configuration response exceeds the limit')
          chunks.push(chunk)
        }
        presentation = parseClientModelConfigStatus(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          ?? { defaultChatModel: null, modelOrder: [] }
      } catch (_unavailableClientModelConfiguration: unknown) {
        ctx.logger.warn('credits-index: client model configuration unavailable; retaining the last valid preferences')
      }
      const ids = orderProductModels(chatIds, presentation)
      const preferred = preferredProductModel(ids, presentation)
      await mutateSession(async () => {
        await currentIdentity()
        const previousDefault = ctx.get('agentDefaultModel')?.currentSelection()
        await writeProductModels(ids, defaults)
        await currentIdentity()
        productModelPresentation = presentation
        productDefault = preferred === undefined ? undefined
          : { version, selection: { provider: resolved.chatProviderRoute, model: preferred } }
        const nextDefault = ctx.get('agentDefaultModel')?.currentSelection()
        if (previousDefault?.provider !== nextDefault?.provider || previousDefault?.model !== nextDefault?.model
          || previousDefault?.reasoningEffort !== nextDefault?.reasoningEffort) {
          const warn = (): void => { ctx.logger.warn('credits-index: a model catalog change observer failed') }
          for (const listener of ctx.events.dispatch('emit', ['api-session/model-catalog-changed']) as Array<() => unknown>) {
            try { void Promise.resolve(listener()).catch(warn) } catch { warn() }
          }
        }
      })
      return ids
    })()
    const flight = { version, token: ownerToken, controller, promise }
    modelCatalogFlight = flight
    modelCatalogOperations.add(promise)
    try { return await promise }
    finally {
      modelCatalogOperations.delete(promise)
      if (modelCatalogFlight === flight) modelCatalogFlight = null
    }
  }

  const harnessAccount: HarnessAccount = {
    provider: resolved.chatProviderRoute,
    refreshModels: baseURL => refreshProductModels(baseURL),
    async resolveRelayKey(baseURL) {
      if (baseURL.replace(/\/+$/u, '') !== apiUrl(apiBaseUrl, '/v1')) return undefined
      await sessionMutations
      const version = identityVersion
      const session = await liveSession()
      await sessionMutations
      const current = await store.read()
      if (version !== identityVersion || session?.token === undefined || current?.token !== session.token) return undefined
      const key = session.relay?.key
      return typeof key === 'string' && /^sk-\S+$/u.test(key) ? key : undefined
    },
  }
  ctx.provide('harnessAccount', harnessAccount)

  /** Read the same signed-in account's live quota; no admin search or cached balance is accepted. */
  const readSelf = async (session: StoredSession): Promise<{
    id: number
    username: string
    group: string
    quota: number
    phone: string
  } | null> => {
    try {
      const answered = await accountFetch(session, '/api/user/self', { headers: { accept: 'application/json' } })
      const body = await answered.json() as {
        success?: unknown
        data?: { id?: unknown; username?: unknown; group?: unknown; quota?: unknown; phone_e164?: unknown }
      } | null
      const data = body?.data
      if (!answered.ok || body?.success !== true || typeof data?.id !== 'number' || !Number.isSafeInteger(data.id)
        || data.id <= 0 || String(data.id) !== session.account.id || typeof data.quota !== 'number'
        || !Number.isFinite(data.quota) || data.quota < 0) return null
      return { id: data.id, username: typeof data.username === 'string' ? data.username : '',
        group: typeof data.group === 'string' ? data.group : '', quota: data.quota,
        phone: typeof data.phone_e164 === 'string' ? data.phone_e164 : session.account.phone }
    } catch {
      return null
    }
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

  const promptAssistantLife = new AbortController()
  const promptAssistantRequests = new Set<Promise<unknown>>()
  ctx.effect(() => async () => {
    promptAssistantLife.abort()
    await Promise.allSettled([...promptAssistantRequests])
  }, 'credits-index: prompt assistance')

  const contentLife = new AbortController()
  const contentRequests = new Set<Promise<void>>()
  let projectOptions: VideoProjectOptions | undefined
  const projectPublicationLife = new AbortController()
  const projectPublications = new Set<Promise<unknown>>()
  ctx.effect(() => async () => {
    projectPublicationLife.abort()
    await Promise.allSettled([...projectPublications])
  }, 'credits-index: retained project clip publication')
  /** Local views and mutation admission use the same non-secret login identity. */
  const creativeIdentity = async (): Promise<VideoProjectIdentity | undefined> => {
    const session = await liveSession()
    return session?.token === undefined ? undefined : { accountId: session.account.id, sessionFingerprint: createHash('sha256').update(session.token).digest('hex') }
  }
  const creative = new CreativeStore({
    directory: join(stateDir, 'creative-projects'), current: creativeIdentity,
    video: async (id, owner) => {
      if (projectOptions === undefined) throw new CreativeError('CREATIVE_UNAVAILABLE', 503, '视频项目服务尚未准备好，请稍后重试。')
      const identity = await creativeIdentity()
      if (identity?.accountId !== owner.accountId) throw new CreativeError('CREATIVE_ACCOUNT_CHANGED', 409, '登录状态已变化，请刷新后查看当前账号。')
      const operation = recoverVideoProjectOutputs(projectOptions, id, owner.sessionId, owner.workspaceRoot, identity,
        projectPublicationLife.signal, async () => {
          const current = await creativeIdentity()
          if (current?.accountId !== identity.accountId || current.sessionFingerprint !== identity.sessionFingerprint) {
            throw new CreativeError('CREATIVE_ACCOUNT_CHANGED', 409, '登录状态已变化，已停止保存本次创作。')
          }
        })
      projectPublications.add(operation)
      try { return await operation } finally { projectPublications.delete(operation) }
    },
  })
  registerCreativeTools(ctx, creative, creativeIdentity)
  /** Generated outputs grant reference access only through their exact creation owner and record. */
  const creativeImageReference = async (owner: CreativeOwner, planId: string, value: string): Promise<string | undefined> => {
    if (value.startsWith('ma_')) return value
    const source = await creative.imageReference(owner, planId, value)
    if (source === undefined) return undefined
    const mediaType = [...ALLOWED_ASSET_TYPES].find(type => referenceSignature(source.bytes, type))
    if (mediaType === undefined) throw new CreativeError('CREATIVE_REFERENCE_INVALID', 400, '已生成的图片不是受支持的 PNG、JPEG 或 WebP，请检查原文件。')
    const id = `ma_${randomBytes(20).toString('hex')}`
    await storeReference(id, source.bytes, mediaType, basename(source.path))
    return id
  }
  const panelLife = new AbortController()
  const panelOperations = new Set<Promise<unknown>>()
  ctx.effect(() => async () => {
    panelLife.abort()
    await Promise.allSettled([...panelOperations])
  }, 'credits-index: owned AI creation generation')
  /** Both ordinary media composers register the same durable planning and saved-output facts as chat tools. */
  const generateForPanel = async <T extends MediaOutcome & { paths?: readonly string[] }>(
    owner: CreativeOwner, kind: 'image' | 'video', body: Record<string, unknown>,
    run: (operation: CreativeOperation, signal: AbortSignal) => Promise<T>,
  ): Promise<T & { planId: string }> => {
    const work = (async () => {
      panelLife.signal.throwIfAborted()
      const prompt = readString(body, 'prompt') ?? ''
      const refs = [...new Set(['references', 'frameImages', 'referenceImages', 'referenceVideos', 'referenceAudios']
        .flatMap(key => referenceIds(body[key])))]
      const assets = await Promise.all(refs.map(async (source, index) => {
        const reference = await readReference(source)
        return { id: `reference_${String(index + 1)}`, name: reference?.filename ?? `参考素材 ${String(index + 1)}`,
          kind: reference?.mediaType.startsWith('video/') ? 'video' as const : reference?.mediaType.startsWith('audio/') ? 'audio' as const : 'image' as const,
          role: '参考素材', description: '', sourcePathOrAssetId: source }
      }))
      const durationSeconds = typeof body.durationSeconds === 'number' ? body.durationSeconds : undefined
      const planId = await creative.updatePlan(owner, {
        kind, title: `${kind === 'image' ? '图片' : '视频'} · ${prompt.trim().split('\n')[0]?.slice(0, 40) ?? ''}`,
        brief: prompt, style: '', characters: [], assets,
        shots: [{ id: 'shot_1', order: 1, title: kind === 'image' ? '画面' : '镜头 1', prompt, camera: '', scene: '', action: '',
          dialogue: '', subtitles: '', characterIds: [], assetIds: assets.map(asset => asset.id),
          ...durationSeconds === undefined ? {} : { durationSeconds } }],
      })
      const operation = await creative.begin(owner, { kind, prompt, planId, shotIds: ['shot_1'],
        shots: [{ prompt, ...durationSeconds === undefined ? {} : { durationSeconds } }],
        ...typeof body.model === 'string' ? { model: body.model } : {} })
      try {
        const outcome = await run(operation, panelLife.signal)
        const paths = outcome.paths ?? (outcome.path === undefined ? [] : [outcome.path])
        await creative.finish(operation, { kind, paths, status: outcome.ok ? 'completed' : panelLife.signal.aborted ? 'cancelled'
          : ['TIMEOUT', 'TRANSPORT', 'NO_TASK_ID'].includes(outcome.code ?? '') || kind === 'video' && outcome.code === 'INSUFFICIENT_BALANCE' ? 'unknown' : 'failed',
        ...outcome.code === undefined ? {} : { errorCode: outcome.code } })
        return { ...outcome, planId }
      } finally { creative.release(operation) }
    })()
    panelOperations.add(work)
    try { return await work } finally { panelOperations.delete(work) }
  }
  ctx.effect(() => async () => {
    contentLife.abort()
    await Promise.allSettled([...contentRequests])
  }, 'credits-index: creation publication transfers')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request, response) => {
      if (!originAllowed(request.headers.origin)) {
        json(response, 403, { ok: false, code: 'FORBIDDEN_ORIGIN' })
        return
      }
      /** Only the separate legacy account platform is limited to loopback. */
      if (!isLoopbackOrigin(resolved.baseUrl)) {
        json(response, 200, {
          ok: false,
          code: 'PLATFORM_DISABLED',
          message: '旧账户平台 baseUrl 仅支持本机地址；harness-api 请通过 newApiBaseUrl 配置。',
        })
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const route = url.pathname.slice(ROUTE_PREFIX.length)
      const method = request.method ?? 'GET'
      if (resolved.baseUrl === '' && (route === '/api/grant' || route === '/api/recharge/options'
        || route.startsWith('/api/recharge/orders') || route.startsWith('/api/video/tasks/')
        || route.startsWith('/api/video/operations/') || route === '/api/media/save')) {
        json(response, 200, { ok: false, code: 'UNSUPPORTED', message: '当前账户服务不提供旧版平台接口。' })
        return
      }


      try {
        if (route === '/api/activity') {
          const connection = ctx.get('connection')
          const rejected = connection === undefined ? 403 : connection.requestRejection(request)
          if (rejected !== undefined) { json(response, rejected, { ok: false, code: 'ACTIVITY_HOST_AUTH_REQUIRED' }); return }
          if (method !== 'POST') { json(response, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' }); return }
          const lifetime = new AbortController()
          const disconnected = (): void => { lifetime.abort() }
          response.once('close', disconnected)
          const operation = (async () => {
            const signal = AbortSignal.any([activityLife.signal, lifetime.signal, AbortSignal.timeout(2_000)])
            addAbortSignal(signal, request)
            let value: unknown
            try { value = JSON.parse((await readRaw(request, 1024)).toString('utf8')) }
            catch (_invalidActivityJson: unknown) { if (!response.destroyed) json(response, 400, { ok: false, code: 'INVALID_REQUEST' }); return }
            const sample = parseClientActivity(value)
            if (sample === null) { json(response, 400, { ok: false, code: 'INVALID_REQUEST' }); return }
            const version = identityVersion
            const isCurrent = (): boolean => version === identityVersion && !signal.aborted
            const session = await store.read()
            const backendBase = session?.backendBaseUrl ?? (isLoopbackOrigin(apiBaseUrl) ? apiBaseUrl : undefined)
            const accessExpiry = Date.parse(session?.upstream?.expiresAt ?? '')
            if (session?.token === undefined || session.upstream?.token === undefined || backendBase !== apiBaseUrl
              || !(Date.parse(session.expiresAt) > Date.now()) || !(accessExpiry > Date.now()) || !isCurrent()) {
              if (!response.destroyed) json(response, 200, { ok: true, recorded: false })
              return
            }
            if (previousActivity !== undefined && previousActivity.session.token !== session.token) await stopActivity()
            const forwarded = { ...sample, session_id: activitySessions.resolve(sample.session_id, session.token) }
            if (!isCurrent()) {
              if (!response.destroyed) json(response, 200, { ok: true, recorded: false })
              return
            }
            previousActivity = sample.event === 'stop' ? undefined : { session, sample: forwarded }
            if (sample.event === 'stop') activitySessions.clear()
            try {
              await sendActivity(session, forwarded, signal)
              if (!response.destroyed) json(response, 200, { ok: true })
            } catch (_unavailableActivityServer: unknown) {
              if (!response.destroyed) json(response, 200, { ok: true, recorded: false })
            }
          })()
          activityOperations.add(operation)
          try { await operation } finally { activityOperations.delete(operation); response.off('close', disconnected) }
          return
        }

        if (route === '/api/creative/projects' || route === '/api/creative/media' || route === '/api/creative/plan' || route === '/api/creative/reference') {
          const connection = ctx.get('connection')
          const rejected = connection === undefined ? 403 : connection.requestRejection(request)
          if (rejected !== undefined) { json(response, rejected, { ok: false, code: 'CREATIVE_HOST_AUTH_REQUIRED', message: '请从已连接的云枢客户端查看创作。' }); return }
          const writing = route === '/api/creative/plan'
          if (writing ? method !== 'POST' : method !== 'GET' && method !== 'HEAD' || route === '/api/creative/projects' && method !== 'GET') { json(response, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '该创作操作不支持此请求方式。' }); return }
          const identity = await creativeIdentity()
          if (identity === undefined) { json(response, 401, { ok: false, code: 'AUTH_REQUIRED', message: '请登录后查看本账号的创作。' }); return }
          const body = writing ? await readJson(request) : undefined
          const sessionId = writing ? readString(body ?? null, 'session_id') ?? '' : url.searchParams.get('session_id') ?? ''
          if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) { json(response, 400, { ok: false, code: 'CREATIVE_SESSION_INVALID', message: '请选择有效的聊天。' }); return }
          const owner = { ...identity, sessionId }
          try {
            if (writing || route === '/api/creative/projects') {
              if (body !== undefined) {
                const projectId = readString(body, 'project_id') ?? ''
                const captured = await creative.owner(identity, projectId, sessionId)
                await creative.revise(captured, projectId, readString(body, 'expected_revision') ?? '', parseCreativePlanChange(body.change))
              }
              const projects = await creative.projects(owner)
              const current = await creativeIdentity()
              if (current?.accountId !== identity.accountId || current.sessionFingerprint !== identity.sessionFingerprint) { json(response, 409, { ok: false, code: 'CREATIVE_ACCOUNT_CHANGED', message: '登录已变化，请刷新后查看当前账号。' }); return }
              json(response, 200, { ok: true, payload: { accountId: identity.accountId, projects } })
            } else if (route === '/api/creative/reference') {
              const projectId = url.searchParams.get('project_id') ?? ''
              const captured = await creative.owner(identity, projectId, sessionId)
              const plan = await creative.plan(captured, projectId)
              const asset = plan.assets.find(item => item.id === url.searchParams.get('asset_id') && item.kind === 'image')
              const reference = asset === undefined ? null : await readReference(asset.sourcePathOrAssetId)
              if (reference === null || !['image/png', 'image/jpeg', 'image/webp'].includes(reference.mediaType)
                || reference.bytes.length === 0 || reference.bytes.length > 6 * 1024 * 1024
                || !referenceSignature(reference.bytes, reference.mediaType)) {
                throw new CreativeError('CREATIVE_REFERENCE_UNAVAILABLE', 404, '参考图已不可用，请重新上传素材。')
              }
              const current = await creativeIdentity()
              if (current?.accountId !== identity.accountId || current.sessionFingerprint !== identity.sessionFingerprint) throw new CreativeError('CREATIVE_ACCOUNT_CHANGED', 409, '登录已变化，请刷新后查看当前账号。')
              response.writeHead(200, { 'content-type': reference.mediaType, 'content-length': reference.bytes.length,
                'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
              response.end(method === 'HEAD' ? undefined : reference.bytes)
            } else {
              const rawFrame = url.searchParams.get('frame')
              await creative.serve(request, response, owner, url.searchParams.get('project_id') ?? '', url.searchParams.get('output_id') ?? '', rawFrame === null ? undefined : Number(rawFrame))
            }
          } catch (error) {
            if (response.headersSent) { response.destroy(); return }
            json(response, error instanceof CreativeError ? error.status : 503, error instanceof CreativeError
              ? { ok: false, code: error.code, message: error.message }
              : { ok: false, code: 'CREATIVE_READ_FAILED', message: '创作记录暂时无法读取，请检查本机存储后重试。' })
          }
          return
        }
        if ((route === '/api/creation/content' && method === 'GET')
          || (route.startsWith('/api/creation/assets/') && (method === 'GET' || method === 'HEAD'))) {
          const operation = relayCreationContent(request, response, route, apiBaseUrl, resolved.timeoutMs, contentLife.signal)
          contentRequests.add(operation)
          try { await operation } finally { contentRequests.delete(operation) }
          return
        }
        if (route === '/api/prompt/assist' && method === 'POST') {
          const peer = new AbortController()
          const deadline = AbortSignal.timeout(resolved.promptAssistantTimeoutMs)
          const signal = AbortSignal.any([peer.signal, promptAssistantLife.signal, deadline])
          const disconnected = (): void => { if (!response.writableEnded) peer.abort() }
          response.once('close', disconnected)
          const operation = (async (): Promise<void> => {
            try {
              const live = await liveSession()
              if (live?.token === undefined) {
                json(response, 200, { ok: false, code: 'SESSION_REQUIRED', sessionInvalid: true, message: '请先用手机号登录后再使用 AI 帮写。' })
                return
              }
              let value: unknown
              try {
                addAbortSignal(signal, request)
                value = JSON.parse((await readRaw(request, 32 * 1024)).toString('utf8'))
              } catch (error) {
                // Invalid JSON and excessive input have the same safe, localized handling identity.
                void error
                if (!response.destroyed) json(response, 200, promptAssistFailure(signal.aborted
                  ? deadline.aborted ? 'PROMPT_ASSIST_TIMEOUT' : 'PROMPT_ASSIST_CANCELLED'
                  : 'INVALID_REQUEST'))
                return
              }
              const parsed = parsePromptAssist(value)
              if (!parsed.ok) { json(response, 200, parsed); return }
              const expectedIdentityVersion = identityVersion
              const current = await liveSession()
              if (current?.token === undefined) {
                json(response, 200, { ok: false, code: 'SESSION_REQUIRED', sessionInvalid: true, message: '请先用手机号登录后再使用 AI 帮写。' })
                return
              }
              if (current.account.id === '' || parsed.expectedAccountId !== current.account.id) {
                json(response, 200, { ok: false, code: 'ACCOUNT_CHANGED', message: '登录账号已变更，请确认当前账号后重新操作。' })
                return
              }
              const owned = await accountKey(current)
              if ('reason' in owned) { json(response, 200, { ok: false, ...noCredential(owned.reason) }); return }
              const controller = ctx.get('sessionController')
              const llm = ctx.get('llm')
              const defaultModel = ctx.get('agentDefaultModel')
              if (controller === undefined || llm === undefined || defaultModel === undefined) {
                json(response, 200, promptAssistFailure('PROMPT_ASSIST_MODEL_UNAVAILABLE'))
                return
              }
              const readProjections = (sessionId: NonNullable<typeof parsed.sessionId>, operationSignal: AbortSignal) =>
                controller.projections({ sessionId }, operationSignal)
              const selected = await resolvePromptAssistSelection({
                sessionId: parsed.sessionId, expectedSelection: parsed.expectedSelection,
                hasReferences: parsed.input.references.length > 0, provider: resolved.chatProviderRoute, signal,
                readCatalog: () => controller.modelCatalog(), readProjections,
                readModelInfo: (provider, model, operationSignal) => llm.resolveModelInfo(provider, model, operationSignal),
              })
              if (!selected.ok) { json(response, 200, selected); return }
              const outcome = await assistPrompt({
                input: parsed.input, key: owned.key, accountId: current.account.id,
                baseUrl: apiBaseUrl, selection: selected.selection, sessionId: parsed.sessionId,
                isSelectionCurrent: async () => {
                  if (identityVersion !== expectedIdentityVersion) return false
                  const live = await liveSession()
                  if (live?.token === undefined || live.account.id !== current.account.id
                    || identityVersion !== expectedIdentityVersion) return false
                  return await isPromptAssistSelectionCurrent({
                    sessionId: parsed.sessionId, selection: selected.selection, signal, readProjections,
                    readDefaultSelection: () => defaultModel.currentSelection(),
                  })
                },
                stateDir, timeoutMs: resolved.promptAssistantTimeoutMs, maxTokens: resolved.promptAssistantMaxTokens,
                signal, readReference,
              })
              if (!response.destroyed) json(response, 200, outcome)
            } catch (error) {
              // Route containment never forwards session, storage, or provider exception text.
              void error
              if (!response.destroyed) json(response, 200, promptAssistFailure(signal.aborted
                ? deadline.aborted ? 'PROMPT_ASSIST_TIMEOUT' : 'PROMPT_ASSIST_CANCELLED'
                : 'PROMPT_ASSIST_UNAVAILABLE'))
            }
          })()
          promptAssistantRequests.add(operation)
          try { await operation } finally {
            promptAssistantRequests.delete(operation)
            response.off('close', disconnected)
          }
          return
        }

        if (route === '/api/session' && method === 'GET') {
          const session = await liveSession()
          if (session === null) {
            const stored = await store.read()
            if (stored?.token !== undefined) {
              json(response, 200, { ok: false, code: 'ACCOUNT_UNAVAILABLE', signedIn: true, liveness: 'unknown',
                message: '账户凭据暂时无法续期，请重试或重新登录。',
                payload: { signedIn: true, liveness: 'unknown', account: stored.account, expiresAt: stored.expiresAt } }); return
            }
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
          const self = await readSelf(session)
          const account = session.account
          const liveness = self === null ? 'unknown' : 'verified'
          json(response, 200, {
            ok: self !== null,
            code: self === null ? 'ACCOUNT_UNAVAILABLE' : null,
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
          if (phone === null || !/^\+[1-9]\d{7,14}$/u.test(phone) || key === null) {
            json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: 'phone 与 idempotencyKey 必填' })
            return
          }
          challengePhone = phone
          // Phone sign-in now lives in new-api itself; the Bridge is out of the picture.
          const challenge = await apiFetch('/api/user/phone/challenge', {
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
          if (challenge.ok && challengeBody.success === true) {
            json(response, 200, {
              ok: true,
              payload: {
                challenge_id: typeof challengeBody.data?.challenge_id === 'string' ? challengeBody.data.challenge_id : phone,
                phone,
                resend_after_seconds: typeof challengeBody.data?.resend_after_seconds === 'number' ? challengeBody.data.resend_after_seconds : 60,
                expires_in_minutes: typeof challengeBody.data?.expires_in_minutes === 'number' ? challengeBody.data.expires_in_minutes : null,
                dev_code: typeof challengeBody.data?.dev_code === 'string' ? challengeBody.data.dev_code : null,
              },
            })
          } else {
            json(response, 200, {
              ok: false,
              code: challenge.status === 429 ? 'PHONE_RATE_LIMITED' : 'PHONE_CHALLENGE_FAILED',
              message: challengeBody.message
                ?? (challenge.status === 429
                  ? '发码过于频繁，请等待重发冷却结束后再试。'
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
          const phoneForLogin = challengePhone === challengeId ? challengePhone : challengeId
          if (!/^\+[1-9]\d{7,14}$/u.test(phoneForLogin)) {
            json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: '手机号需使用 E.164 格式。' }); return
          }
          const version = ++identityVersion
          chatUsage.reset()
          const login = await apiFetch('/api/user/phone/login', {
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
              message: '验证码请求过于频繁，请稍后再试。',
            })
            return
          }
          const payload = loginBody.data ?? null
          const token = payload?.access_token
          const rawPhone = typeof payload?.user?.phone_e164 === 'string' ? payload.user.phone_e164 : phoneForLogin
          const accountId = payload?.user?.id
          const id = typeof accountId === 'number' && Number.isSafeInteger(accountId) && accountId > 0 ? String(accountId)
            : typeof accountId === 'string' && /^[1-9]\d*$/u.test(accountId) && Number.isSafeInteger(Number(accountId)) ? accountId : null
          const expiry = payload?.access_expires_at
          const relayKey = payload?.relay_key
          if (login.ok && loginBody.success === true && typeof token === 'string' && token.trim() !== '' && id !== null
            && typeof expiry === 'number' && Number.isFinite(expiry) && expiry * 1000 > Date.now()
            && Number.isFinite(new Date(expiry * 1000).getTime()) && typeof relayKey === 'string' && /^sk-\S+$/u.test(relayKey)) {
            if (version !== identityVersion) {
              json(response, 200, { ok: false, code: 'ACCOUNT_CHANGED', message: '登录状态已变更，请重新操作。' }); return
            }
            const account = { id, phone: rawPhone }
            const sessionToken = randomBytes(32).toString('hex')
            const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
            const refresh = refreshFromSetCookie(login) ?? undefined
            const relayId = typeof payload?.relay_key_id === 'number' && Number.isSafeInteger(payload.relay_key_id) && payload.relay_key_id > 0
              ? payload.relay_key_id : undefined
            await mutateSession(async () => {
              if (version !== identityVersion) return
              await releaseAccountCredential()
              await store.write({ token: sessionToken, expiresAt: sessionExpiresAt, account, backendBaseUrl: apiBaseUrl,
                upstream: { token, refresh, expiresAt: new Date(expiry * 1000).toISOString() },
                relay: { key: relayKey, ...relayId === undefined ? {} : { id: relayId } } })
              await holdAccountCredential(relayKey)
              invalidateModelCatalog()
              await writeProductModels([]).catch(reportModelRefreshFailure)
            })
            if (version !== identityVersion) {
              json(response, 200, { ok: false, code: 'ACCOUNT_CHANGED', message: '登录状态已变更，请重新操作。' }); return
            }
            json(response, 200, { ok: true, payload: { status: 'authorized', expiresAt: sessionExpiresAt, account } })
          } else {
            json(response, 200, { ok: false, code: 'PHONE_LOGIN_FAILED', message: loginBody.message ?? '验证码错误或已过期' })
          }
          return
        }

        if (route === '/api/session/logout' && method === 'POST') {
          const previous = await store.read()
          identityVersion += 1
          chatUsage.reset()
          await stopActivity(previous?.token)
          invalidateModelCatalog()
          const pending = renewal !== null && renewal.token === previous?.token ? renewal.promise : null
          await mutateSession(async () => {
            await store.clear()
            await releaseAccountCredential()
            await writeProductModels([]).catch(reportModelRefreshFailure)
          })
          const renewed = pending === null ? null : await pending
          const session = renewed ?? previous
          let result: PlatformResult = { status: 204, code: null, message: null, retryAfterSeconds: null, body: null }
          const bound = session?.backendBaseUrl ?? (isLoopbackOrigin(apiBaseUrl) ? apiBaseUrl : undefined)
          if (session?.token !== undefined && bound === apiBaseUrl) {
            const response_ = await apiFetch('/api/user/auth/logout', {
              method: 'POST', headers: { authorization: `Bearer ${session.upstream?.token ?? ''}`,
                ...session.upstream?.refresh === undefined ? {} : { cookie: `new_api_refresh=${session.upstream.refresh}` },
                ...declaredOrigin, 'content-type': 'application/json', accept: 'application/json' },
              body: '{}', signal: AbortSignal.timeout(resolved.timeoutMs),
            }).catch(() => null)
            result = { status: response_?.status ?? 503, code: response_ === null ? 'LOGOUT_UNCONFIRMED' : null,
              message: response_ === null ? '本地已退出，服务端会话撤销结果未确认。' : null, retryAfterSeconds: null, body: null }
          }
          reply(response, result)
          return
        }

        if (route === '/api/chat-usage') {
          const connection = ctx.get('connection')
          const rejected = connection === undefined ? 403 : connection.requestRejection(request)
          if (rejected !== undefined) { json(response, rejected, { ok: false, code: 'CHAT_USAGE_HOST_AUTH_REQUIRED' }); return }
          if (method !== 'GET') { json(response, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' }); return }
          const query = parseChatUsageQuery(url.searchParams)
          if (query === undefined) { json(response, 400, { ok: false, code: 'INVALID_REQUEST' }); return }
          const version = identityVersion
          const live = await liveSession()
          if (version !== identityVersion) { json(response, 200, { ok: false, code: 'ACCOUNT_CHANGED' }); return }
          if (live?.token === undefined || live.upstream?.token === undefined) { json(response, 200, { ok: false, code: 'SESSION_REQUIRED' }); return }
          if (query.accountId !== undefined && query.accountId !== live.account.id) { json(response, 200, { ok: false, code: 'ACCOUNT_CHANGED' }); return }
          const attached = ctx.get('sessions')?.get(SessionId(query.sessionId))
          const receipts = attached === undefined ? undefined : ctx.get('sessionProjections')?.stateOf(attached, 'chatReceipts')
          const outcome = attached === undefined || receipts === undefined
            ? { ok: true as const, payload: { scope: 'chat-model' as const, status: 'unavailable' as const, settledRequests: 0, totalRequests: 0 } }
            : await chatUsage.read({ identity: JSON.stringify([version, live.account.id]), account: live.account,
              upstreamToken: live.upstream.token, sessionId: attached.id, ...selectChatReceipts(receipts, query.turn),
              ...query.turn === undefined ? {} : { turn: query.turn } })
          const current = await store.read()
          if (version !== identityVersion || current?.token !== live.token || current.account.id !== live.account.id) {
            if (!response.destroyed) json(response, 200, { ok: false, code: 'ACCOUNT_CHANGED' })
            return
          }
          if (!response.destroyed) {
            json(response, 200, outcome.ok ? { ...outcome, payload: { ...outcome.payload, accountId: live.account.id } } : outcome)
          }
          return
        }

        if (route === '/api/usage' && method === 'GET') {
          const parsed = parseUsageWindow(url.searchParams)
          if (!parsed.ok) { json(response, 200, parsed); return }
          const live = await liveSession()
          if (live?.token === undefined) {
            json(response, 200, { ok: false, code: 'SESSION_REQUIRED', message: '请先登录后查看使用量分析。' })
            return
          }
          const outcome = await readAccountUsage({
            ...parsed.window,
            baseUrl: apiBaseUrl,
            timeoutMs: resolved.timeoutMs,
            account: live.account,
            upstreamToken: live.upstream?.token,
          })
          json(response, 200, outcome)
          return
        }

        if (route === '/api/summary' && method === 'GET') {
          const live = await liveSession()
          if (live === null) {
            if ((await store.read())?.token !== undefined) {
              json(response, 200, { ok: false, code: 'BALANCE_UNAVAILABLE',
                message: '无法续期账户凭据，当前余额不可用。', balance: null, payload: null }); return
            }
            json(response, 200, { ok: true, source: 'signed-out', signedIn: false,
              creditsPerYuan: resolved.creditsPerYuan, account: null, balance: null,
              payload: { signedIn: false, balance_points: null, yuan: null, source: 'signed-out' } })
            return
          }
          try {
            const [self, rate] = await Promise.all([readSelf(live), readQuotaRate()])
            if (self === null) throw new Error('BALANCE_UNAVAILABLE')
            const converted = convertQuota(self.quota, rate)
            json(response, 200, { ok: true, source: 'newapi-account', signedIn: true,
              creditsPerYuan: resolved.creditsPerYuan, account: { ...live.account, group: self.group },
              balance: { credits: converted.points, yuan: converted.yuan },
              payload: { balance_points: converted.points, yuan: converted.yuan, source: 'newapi-account' } })
          } catch {
            json(response, 200, { ok: false, code: 'BALANCE_UNAVAILABLE', message: '无法读取当前账号余额，请稍后重试。', balance: null, payload: null })
          }
          return
        }

        if (route === '/api/models' && method === 'GET') {
          // The live channel list wins over the platform catalog: the local
          // new-api is the deployment's own model source.
          if (url.searchParams.get('source') === 'newapi' || resolved.baseUrl === '') {
            const live = await readNewApiModels()
            json(response, 200, { ...live, chat: orderProductModels(live.chat, productModelPresentation),
              image: orderProductModels(live.image, productModelPresentation),
              video: orderProductModels(live.video, productModelPresentation), baseUrl: apiBaseUrl })
            return
          }
          // The public catalog needs no session; it is the picker's model list.
          const catalog = await platformCall(resolved.baseUrl, '/api/v1/models/catalog', {
            method: 'GET', timeoutMs: resolved.timeoutMs,
          })
          const payload = catalog.body !== null && typeof catalog.body === 'object' ? catalog.body as Record<string, unknown> : null
          const models = Array.isArray(payload?.models)
            ? (payload.models as unknown[]).flatMap((entry) => {
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
          json(response, 200, { ok: false, code: 'UNSUPPORTED', message: '当前账户服务直接使用登录返回的中转凭据。' })
          return
        }

        if (route === '/api/recharge/wechat' && method === 'POST') {
          const session = await liveSession()
          if (session?.upstream?.token === undefined) { sessionExpired(response); return }
          const body = await readJson(request)
          const amount = body.amount
          if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > 100_000) {
            json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: '金额需为 1–100000 的整数（元）' }); return
          }
          let rate: { quotaPerUnit: number; usdExchangeRate: number }
          try { rate = await readQuotaRate() } catch {
            json(response, 200, { ok: false, code: 'BALANCE_UNAVAILABLE', message: '无法读取积分换算参数，尚未创建订单。' }); return
          }
          let created: Response
          try {
            created = await accountFetch(session, '/api/user/wechat/native', { method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ amount }) })
          } catch {
            json(response, 200, { ok: false, code: 'RECHARGE_OUTCOME_UNKNOWN',
              message: '订单提交结果无法确认，请先核对订单状态，勿重复下单。' }); return
          }
          const payload = await created.json().catch(() => null) as {
            success?: unknown
            message?: unknown
            data?: { out_trade_no?: unknown; code_url?: unknown; expires_at?: unknown; quota?: unknown; amount?: unknown }
          } | null
          if (!created.ok || payload?.success !== true) {
            json(response, 200, { ok: false, code: created.status === 429 ? 'RECHARGE_RATE_LIMITED' : created.status >= 500 || payload === null
              ? 'RECHARGE_OUTCOME_UNKNOWN' : 'RECHARGE_FAILED',
            message: typeof payload?.message === 'string' ? payload.message : '下单结果未确认，请先核对订单，勿重复提交。' }); return
          }
          const order = payload.data
          if (typeof order?.out_trade_no !== 'string' || order.out_trade_no.trim() === ''
            || typeof order.code_url !== 'string' || !/^(?:weixin|https):\/\/\S+$/u.test(order.code_url)
            || typeof order.expires_at !== 'number' || !Number.isFinite(order.expires_at) || order.expires_at * 1000 <= Date.now()
            || typeof order.quota !== 'number' || !Number.isFinite(order.quota) || order.quota <= 0 || order.amount !== amount) {
            json(response, 200, { ok: false, code: 'RECHARGE_OUTCOME_UNKNOWN', message: '订单响应不完整，请先核对订单状态，勿重复下单。' }); return
          }
          let qrCodeDataUrl: string
          try { qrCodeDataUrl = await QRCode.toDataURL(order.code_url, { margin: 1, width: 320 }) } catch {
            json(response, 200, { ok: false, code: 'RECHARGE_QR_UNAVAILABLE', message: '二维码生成失败，请核对已有订单，勿重复下单。',
              payload: { outTradeNo: order.out_trade_no } }); return
          }
          json(response, 200, { ok: true, payload: { outTradeNo: order.out_trade_no, amount: order.amount,
            points: convertQuota(order.quota, rate).points, expiresAt: order.expires_at, qrCodeDataUrl } })
          return
        }

        if (route === '/api/recharge/wechat/order' && method === 'GET') {
          const session = await liveSession()
          if (session?.upstream?.token === undefined) { sessionExpired(response); return }
          const orderNo = url.searchParams.get('outTradeNo')
          if (orderNo === null || orderNo === '') {
            json(response, 200, { ok: false, code: 'INVALID_REQUEST', message: 'outTradeNo 必填' }); return
          }
          try {
            const [polled, rate] = await Promise.all([
              accountFetch(session, `/api/user/wechat/order?out_trade_no=${encodeURIComponent(orderNo)}`, { headers: { accept: 'application/json' } }),
              readQuotaRate(),
            ])
            const payload = await polled.json() as { success?: unknown; message?: unknown; data?: Record<string, unknown> } | null
            const order = payload?.data
            if (!polled.ok || payload?.success !== true || order?.out_trade_no !== orderNo || typeof order.status !== 'string'
              || typeof order.amount !== 'number' || !Number.isFinite(order.amount) || order.amount <= 0
              || typeof order.quota !== 'number' || !Number.isFinite(order.quota) || order.quota < 0) {
              json(response, 200, { ok: false, code: 'ORDER_QUERY_FAILED', message: '无法读取订单状态，请稍后重试。' }); return
            }
            json(response, 200, { ok: true, payload: { ...order, status: order.status, amount: order.amount,
              points: convertQuota(order.quota, rate).points } })
          } catch {
            json(response, 200, { ok: false, code: 'ORDER_QUERY_FAILED', message: '无法读取订单状态，请稍后重试。' })
          }
          return
        }

        if (route === '/api/assets/preview' && (method === 'GET' || method === 'HEAD')) {
          const connection = ctx.get('connection')
          const rejected = connection === undefined ? 403 : connection.requestRejection(request)
          if (rejected !== undefined) {
            json(response, rejected, { ok: false, code: 'IMAGE_PREVIEW_HOST_AUTH_REQUIRED', message: '请从已连接的云枢客户端查看图片' }); return
          }
          const session = await liveSession()
          if (session?.upstream?.token === undefined) { sessionExpired(response); return }
          const assetId = url.searchParams.get('asset_id') ?? ''
          const reference = await readReference(assetId)
          if (reference === null || reference.accountId !== session.account.id
            || !ALLOWED_ASSET_TYPES.has(reference.mediaType)) {
            json(response, 404, { ok: false, code: 'IMAGE_PREVIEW_UNAVAILABLE', message: '图片预览已失效，请重新上传' }); return
          }
          if ((await liveSession())?.account.id !== session.account.id) { sessionExpired(response); return }
          response.writeHead(200, { 'content-type': reference.mediaType, 'content-length': reference.bytes.length,
            'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
          response.end(method === 'HEAD' ? undefined : reference.bytes)
          return
        }

        if (route === '/api/assets' && method === 'POST') {
          let mediaType = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
          let filename: string
          try { filename = decodeURIComponent(String(request.headers['x-file-name'] ?? '')) } catch {
            json(response, 400, { ok: false, code: 'MEDIA_ASSET_REQUEST_INVALID', message: '素材文件名编码无效，请重新选择文件。' }); return
          }
          if (filename.trim() === '' || filename.length > 256 || /[\u0000-\u001f\u007f]/u.test(filename)) {
            json(response, 400, { ok: false, code: 'MEDIA_ASSET_REQUEST_INVALID', message: '素材文件名为空、过长或包含控制字符。' }); return
          }
          const idempotencyKey = String(request.headers['x-idempotency-key'] ?? '')
          const imageUpload = !ALLOWED_REFERENCE_VIDEO_TYPES.has(mediaType) && !ALLOWED_REFERENCE_AUDIO_TYPES.has(mediaType)
          if (idempotencyKey === '' || !imageUpload && resolved.baseUrl !== '') {
            json(response, 200, { ok: false, code: 'MEDIA_ASSET_REQUEST_INVALID', message: '素材上传参数无效，请重新选择文件' }); return
          }
          const session = await liveSession()
          if (session?.upstream?.token === undefined) { sessionExpired(response); return }
          if (Number(request.headers['content-length']) > REFERENCE_IMAGE_INPUT_LIMIT) {
            json(response, 200, { ok: false, code: 'IMAGE_INPUT_TOO_LARGE', filename, message: '原图超过 32 MB，请缩小后重试' }); return
          }
          let bytes = await readRaw(request, REFERENCE_IMAGE_INPUT_LIMIT)
          let normalized: Awaited<ReturnType<typeof normalizeReferenceImage>> | undefined
          if (imageUpload) {
            try { normalized = await normalizeReferenceImage(bytes, filename) } catch (error) {
              const reason = error instanceof ReferenceImageError ? error.code : 'IMAGE_CONVERSION_FAILED'
              const code = reason === 'IMAGE_FORMAT_UNSUPPORTED' && /^(audio|video)\//u.test(mediaType)
                ? 'MEDIA_ASSET_REQUEST_INVALID' : reason
              json(response, 200, { ok: false, code, filename, message: '图片无法处理，请检查图片格式、完整性和大小后重试' }); return
            }
            bytes = normalized.bytes
            mediaType = normalized.mediaType
          } else {
            const limit = (ALLOWED_REFERENCE_AUDIO_TYPES.has(mediaType) ? 15 : 32) * 1024 * 1024
            if (bytes.length === 0 || bytes.length > limit || !referenceSignature(bytes, mediaType)) {
              json(response, 200, { ok: false, code: 'MEDIA_ASSET_REQUEST_INVALID', filename,
                message: '上传内容为空、文件类型不匹配或超过大小限制' }); return
            }
          }
          const imageFacts = normalized === undefined ? {} : {
            originalName: filename, sourceFormat: normalized.sourceFormat, converted: normalized.converted,
            firstFrameOnly: normalized.firstFrameOnly, width: normalized.width, height: normalized.height,
          }
          const saveUpload = async (assetId: string): Promise<{ path: string; filename: string } | null> => {
            try { return await storeReference(assetId, bytes, mediaType, filename, session.account.id) } catch {
              json(response, 200, { ok: false, code: 'IMAGE_STORAGE_FAILED', filename,
                message: '图片未能保存，请检查保存目录权限和磁盘空间' }); return null
            }
          }
          if (resolved.baseUrl === '') {
            const assetId = `ma_${idempotencyKey.replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}`
            const stored = await saveUpload(assetId)
            if (stored === null) return
            json(response, 200, { ok: true, status: 201, asset: {
              assetId, kind: mediaType.startsWith('audio/') ? 'reference_audio'
                : mediaType.startsWith('video/') ? 'reference_video' : 'reference_image',
              contentType: mediaType, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
              filename: stored.filename, ...imageFacts,
              ...normalized === undefined ? {} : { previewUrl: `/credits/api/assets/preview?asset_id=${encodeURIComponent(assetId)}` },
            } })
            return
          }
          const uploadFilename = normalized === undefined ? filename
            : `${filename.replace(/\.[^./\\]*$/u, '')}.${mediaType === 'image/jpeg' ? 'jpg' : 'png'}`
          const result = await platformUpload(resolved.baseUrl, '/v1/media/assets', {
            token: session.upstream.token, idempotencyKey, mediaType, filename: uploadFilename, bytes, timeoutMs: resolved.timeoutMs,
          })
          if (result.status === 401 && result.code === 'SESSION_INVALID') {
            await store.clear(); sessionExpired(response); return
          }
          const payload = result.body !== null && typeof result.body === 'object' ? result.body as Record<string, unknown> : null
          const assetId = readString(payload, 'asset_id')
          if (result.status === 201 && normalized !== undefined && typeof assetId === 'string' && /^ma_[A-Za-z0-9]{1,64}$/u.test(assetId)) {
            if (await saveUpload(assetId) === null) return
            json(response, 200, { ok: true, status: 201, asset: {
              assetId, kind: 'reference_image', contentType: mediaType, sizeBytes: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'), ...imageFacts,
              previewUrl: `/credits/api/assets/preview?asset_id=${encodeURIComponent(assetId)}`,
            } }); return
          }
          json(response, 200, { ok: false, status: result.status, code: result.code ?? 'IMAGE_UPLOAD_FAILED',
            filename, message: result.message ?? '图片上传失败，请稍后重试', asset: null })
          return
        }

        if (route === '/api/media/catalog' && method === 'GET') {
          // The panels render one dropdown per kind from this answer, so it
          // ships the declared parameter menus too; account access and billing
          // remain the server's responsibility when generation is submitted.
          const catalog = await readMediaCatalog()
          json(response, 200, {
            ok: catalog.ok,
            code: catalog.code ?? null,
            message: catalog.message ?? null,
            source: 'newapi-pricing',
            baseUrl: apiBaseUrl,
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
          if (url.searchParams.get('source') === 'newapi' || resolved.baseUrl === '') {
            const live = await readNewApiModels()
            const model = live.image[0] ?? null
            json(response, 200, {
              ok: live.ok && model !== null,
              source: 'newapi',
              baseUrl: apiBaseUrl,
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
          const binding = body.session_id === undefined && body.account_id === undefined ? undefined : await bindCurrentVideoAccount()
          const owner = binding === undefined ? undefined : creativePanelOwner(ctx, request, body, binding.identity)
          const outcome = owner === undefined || binding === undefined ? await runImageGeneration(key, body)
            : await generateForPanel(owner, 'image', body, async (operation, signal) => runImageGeneration(await binding.key(), body, signal,
              path => creative.saved(operation, path, 'image'), async () => {
                await binding.key()
                await creative.dispatched(operation)
              }))
          json(response, 200, {
            ok: outcome.ok,
            source: 'newapi',
            model: outcome.model ?? null,
            mode: outcome.mode ?? null,
            code: outcome.code ?? null,
            message: outcome.message ?? null,
            payload: outcome.ok ? { path: outcome.path, paths: outcome.paths, model: outcome.model, ...'planId' in outcome ? { plan_id: outcome.planId } : {} } : null,
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
            const binding = body.session_id === undefined && body.account_id === undefined ? undefined : await bindCurrentVideoAccount()
            const owner = binding === undefined ? undefined : creativePanelOwner(ctx, request, body, binding.identity)
            const outcome = owner === undefined || binding === undefined ? await runVideoTask(key, capability.model.route, built.request)
              : await generateForPanel(owner, 'video', body, async (operation, signal) => runVideoTask(await binding.key(), capability.model.route, built.request, signal,
                async () => {
                  await binding.key()
                  await creative.dispatched(operation)
                }))
            json(response, 200, {
              ok: outcome.ok,
              source: 'newapi',
              model: capability.model.id,
              code: outcome.code ?? null,
              message: outcome.message ?? null,
              taskId: outcome.taskId ?? null,
              payload: outcome.ok ? { path: outcome.path, taskId: outcome.taskId, ...'planId' in outcome ? { plan_id: outcome.planId } : {} } : null,
            })
            return
          }
          if (url.searchParams.get('source') === 'newapi' || resolved.baseUrl === '') {
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
            const created = await apiFetch(capability.model.route, {
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
          const signal = new AbortController().signal
          const storage = ctx.get('artifactStorage')
          const output = await captureMediaOutput(storage, join(stateDir, 'media'), signal)
          const directory = join(stateDir, storage === undefined ? 'media' : 'downloads')
          let saved = await downloadToFile(target, resolved.baseUrl, session.token, directory, resolved.timeoutMs)
          if (saved.ok) saved = { ...saved, path: (await output.publish(saved.path, basename(saved.path))).path }
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
        if (error instanceof CreativeError) {
          json(response, error.status, { ok: false, code: error.code, message: error.message }); return
        }
        json(response, 200, {
          ok: false,
          code: error instanceof Error && error.message === 'ACCOUNT_UNAVAILABLE' ? 'ACCOUNT_UNAVAILABLE' : 'TRANSPORT',
          message: error instanceof Error && error.message === 'ACCOUNT_UNAVAILABLE' ? '账户凭据暂时无法续期，请重试或重新登录。'
            : error instanceof Error ? error.message : String(error),
        })
      }
    },
  }), 'credits-index: routes')

  ctx.effect(() => {
    const timer = setInterval(() => { void refreshProductModels().catch(reportModelRefreshFailure) }, 60_000)
    void refreshProductModels().catch(reportModelRefreshFailure)
    return async () => {
      modelCatalogClosed = true
      clearInterval(timer)
      const pending = modelCatalogFlight
      pending?.controller.abort(new Error('model catalog owner disposed'))
      await Promise.allSettled([...modelCatalogOperations])
    }
  }, 'credits-index: model sync')

  /** The signed-in token, or null with a message the model can relay. */
  const requireToken = async (): Promise<{ token: string } | { error: string }> => {
    const session = await liveSession()
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

  /** Keep reference preparation and subsequent billing bound to the initiating login. */
  const bindCurrentVideoAccount = () => bindVideoAccount(async () => {
    const current = await liveSession()
    if (current?.token === undefined) return undefined
    const owned = await accountKey(current)
    return 'reason' in owned ? undefined : { accountId: current.account.id, token: current.token, key: owned.key }
  })

  // Keep registration visible in custom deployments; missing local capabilities fail before generation.
  {
    const videoContext = ctx
    const projectState = join(stateDir, 'video-projects')
    projectOptions = {
      creative,
      creativeImageReference,
      stateDirectory: projectState,
      outputDirectory: resolved.videoProjectOutputDirectory,
      get publication() { return videoContext.get('artifactStorage') },
      maxTotalSeconds: resolved.videoProjectMaxSeconds,
      maxSegments: resolved.videoProjectMaxSegments,
      pollIntervalMs: resolved.videoProjectPollIntervalMs,
      taskTimeoutMs: resolved.videoProjectTaskTimeoutMs,
      editor: (workspaceRoot, session, ownedMediaRoots) => {
        for (const name of ['jobs', 'fs', 'subprocess', 'sandboxPolicy', 'sandbox'] as const) {
          if (videoContext.get(name) === undefined) throw new VideoProjectError('VIDEO_EDIT_SERVICE_UNAVAILABLE', '当前工作区的视频处理服务未准备好，请联系管理员')
        }
        return createVideoEditor(videoContext, {
          workspaceRoot, session, fps: resolved.videoEditFps, timeoutMs: resolved.videoEditTimeoutMs,
          singlePassMaxInputs: resolved.videoEditSinglePassMaxInputs,
          ...(resolved.videoRuntimeRoot === '' ? {} : { runtimeRoot: resolved.videoRuntimeRoot }),
          ...(ownedMediaRoots === undefined ? {} : { ownedMediaRoots }),
        })
      },
      acquireProvider: async (workspaceRoot, _session) => {
        const fileSystem = videoContext.get('fs')
        if (fileSystem === undefined) throw new VideoProjectError('VIDEO_EDIT_SERVICE_UNAVAILABLE', '当前工作区的文件服务未准备好，请联系管理员')
        const binding = await bindCurrentVideoAccount()
        const relay = createVideoProjectRelay({
          origin: apiBaseUrl, timeoutMs: resolved.timeoutMs, downloadTimeoutMs: Math.max(resolved.timeoutMs, 300_000),
          maxDownloadBytes: resolved.videoProjectDownloadMaxBytes, cacheRoot: projectState, key: () => binding.key(),
        })
        const models = new Map<string, ModelCapability>()
        /** Resolve the saved model again when resuming a project with a fresh provider. */
        const requestRoute = async (request: VideoProjectRequest): Promise<string> => {
          if (typeof request.model !== 'string') throw new VideoProjectError('VIDEO_REQUEST_INVALID', '视频请求缺少原始模型，已停止操作')
          const cached = models.get(request.model)
          if (cached !== undefined) return cached.route
          const capability = await capabilityFor('video', request.model)
          if (!capability.ok) throw new VideoProjectError(capability.code, capability.message)
          models.set(request.model, capability.model)
          return capability.model.route
        }
        const references = new Map<string, string>()
        let preparedBytes = 0
        /** Materialize only serializable provider fields, preserving exact reference bytes without credentials. */
        const requestValue = (value: unknown): VideoRequestValue => {
          if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
          if (typeof value === 'number' && Number.isFinite(value)) return value
          if (Array.isArray(value)) return value.map(requestValue)
          if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, requestValue(item)]))
          throw new VideoProjectError('VIDEO_REQUEST_INVALID', '视频请求包含无法保存的参数，尚未提交生成')
        }
        return {
          identity: binding.identity,
          assertCurrent: async () => { await binding.key() },
          model: async (id, signal, resolution) => {
            const allowed = new Set(await relay.modelIds(signal))
            const catalog = await readMediaCatalog(signal)
            signal.throwIfAborted()
            if (!catalog.ok) throw new VideoProjectError('VIDEO_MODELS_UNAVAILABLE', '无法读取视频模型参数，请稍后重试')
            const selected = pickModel(catalog.models.filter(model => allowed.has(model.id)), 'video', id ?? null)
            if (selected === null) throw new VideoProjectError('VIDEO_MODEL_UNAVAILABLE', '当前登录账户没有可用的所选视频模型，请检查后台模型配置')
            models.set(selected.id, selected)
            const params = selected.params as VideoParams
            return { id: selected.id, durations: videoDurations(params, resolution ?? null) }
          },
          build: async (input, model, prompt, durationSeconds, signal): Promise<VideoProjectRequest> => {
            await binding.key()
            const capability = models.get(model)
            if (capability === undefined) throw new VideoProjectError('VIDEO_MODEL_UNAVAILABLE', '请先确认当前账户的视频模型参数')
            const normalize = async (values: readonly string[] | undefined, kind: 'image' | 'video' | 'audio'): Promise<string[]> => {
              const result: string[] = []
              for (const value of values ?? []) result.push(await normalizeVideoReference(value, kind, workspaceRoot, references, signal))
              return result
            }
            const built = await buildVideoRequest(capability, {
              prompt, durationSeconds,
              ...input.resolution === undefined ? {} : { resolution: input.resolution },
              ...input.ratio === undefined ? {} : { ratio: input.ratio },
              ...input.audio === undefined ? {} : { audio: input.audio },
              frameImages: await normalize(input.frameImages, 'image'), referenceImages: await normalize(input.referenceImages, 'image'),
              referenceVideos: await normalize(input.referenceVideos, 'video'),
              referenceAudios: await normalize(input.referenceAudios, 'audio'),
            })
            signal.throwIfAborted()
            if (!built.ok) throw new VideoProjectError(built.code, built.message)
            const value = requestValue(built.request)
            if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new VideoProjectError('VIDEO_REQUEST_INVALID', '视频请求无法保存，尚未提交生成')
            preparedBytes += Buffer.byteLength(JSON.stringify(value))
            if (preparedBytes > 67_108_864) throw new VideoProjectError('VIDEO_PROJECT_INPUT_LIMIT', '项目素材过大，请减少参考素材或分镜数量后重试；尚未提交生成')
            return value
          },
          submit: async (request, signal) => relay.submit(request, await requestRoute(request), signal),
          check: async (taskId, request, signal) => relay.check(taskId, await requestRoute(request), signal),
          download: (taskId, _request, destination, signal) => relay.download(taskId, destination, signal),
        }
      },
    }
    registerVideoProjectTools(videoContext, projectOptions)
  }

  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: 'Generate images or edit reference images through the signed-in account relay, save every result into the artifacts directory, and return the paths. For image-to-image requests, pass the current-chat user attachment or an authorized workspace image in reference_images. Which image models exist, and what each one accepts, is the deployment’s own answer: ask for a model only when the user names one.' + MEDIA_FAILURE_GUIDANCE,
    parameters: {
      plan_id: { type: 'string', description: 'Explicit update_creation_plan id for this generation. Also provide exactly one of shot_id or asset_id.' },
      shot_id: { type: 'string', description: 'Exact shot id in the explicit plan; never guess a latest project.' },
      asset_id: { type: 'string', description: 'Exact image asset id in plan_id, including a video plan. Mutually exclusive with shot_id. Creates or reconstructs this source asset, not a finished shot.' },
      prompt: { type: 'string', required: true, description: 'What the image should show.' },
      model: { type: 'string', description: 'Optional image model id such as gpt-image-2. Defaults to the first image model the deployment serves for this account.' },
      size: { type: 'string', description: 'Optional output size such as 1024x1024 or auto. A value the chosen model does not support is refused with that model’s own menu. For yunshu-internal-gpt-image-2, omit pixel size; the server controls output settings.' },
      count: { type: 'number', description: 'How many images to render, within the model’s limit (usually 1–4).' },
      reference_images: { type: 'array', items: { type: 'string' }, description: 'Reference images for editing: current-chat user image attachment ids or their exact read-only paths, readable PNG/JPEG/WebP files inside the current workspace, uploaded ma_ ids, or real generated image output ids/paths owned by the same explicit plan_id. Other-chat attachments, unrelated local paths and URLs are refused.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          path: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
          model: { type: 'string' },
          plan_id: { type: 'string' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      let operation: CreativeOperation | undefined
      try {
        const binding = await bindCurrentVideoAccount()
        const owner = creativeOwner(exec, binding.identity)
        const references: string[] = []
        const referenceCache = new Map<string, string>()
        for (const value of args.reference_images ?? []) {
          let source = value.startsWith('ma_') ? value : args.plan_id === undefined ? undefined : await creativeImageReference(owner, args.plan_id, value)
          if (source === undefined) {
            const attached = await readChatImageReference(value, exec.agent?.session, ctx.get('attachments'), ctx.get('fs'), Math.min(resolved.videoProjectReferenceMaxBytes, 6 * 1024 * 1024), exec.signal)
            if (attached !== undefined) {
              const bytes = Buffer.from(attached.data)
              if (!ALLOWED_ASSET_TYPES.has(attached.ref.mediaType) || !referenceSignature(bytes, attached.ref.mediaType)) {
                throw new CreativeError('CREATIVE_REFERENCE_INVALID', 400, '参考图须为可读取的 PNG、JPEG 或 WebP 图片，请重新上传。')
              }
              source = `ma_${randomBytes(20).toString('hex')}`
              exec.signal.throwIfAborted()
              await storeReference(source, bytes, attached.ref.mediaType, attached.ref.name ?? 'chat-image')
            }
          }
          references.push(await normalizeVideoReference(source ?? value, 'image', exec.agent?.session.header.cwd, referenceCache, exec.signal))
        }
        operation = await creative.begin(owner, { kind: 'image', prompt: args.prompt, shots: [{ prompt: args.prompt }], ...args.model === undefined ? {} : { model: args.model }, ...args.plan_id === undefined ? {} : { planId: args.plan_id }, ...args.shot_id === undefined ? {} : { shotIds: [args.shot_id] }, ...args.asset_id === undefined ? {} : { assetId: args.asset_id } })
        const creation = operation
        const outcome = await runImageGeneration(await binding.key(), {
          prompt: args.prompt,
          ...args.model === undefined ? {} : { model: args.model },
          ...args.size === undefined ? {} : { size: args.size },
          ...args.count === undefined ? {} : { count: args.count },
          ...args.reference_images === undefined ? {} : { references },
        }, exec.signal, path => creative.saved(creation, path, 'image'), () => creative.dispatched(creation))
        const paths = [...outcome.paths ?? []]
        await creative.finish(operation, { status: outcome.ok ? 'completed' : exec.signal.aborted ? 'cancelled' : ['TIMEOUT', 'TRANSPORT', 'NO_TASK_ID'].includes(outcome.code ?? '') ? 'unknown' : 'failed', paths, kind: 'image', ...outcome.code === undefined ? {} : { errorCode: outcome.code } })
        if (!outcome.ok) return { status: 'failed', plan_id: operation.projectId, model: outcome.model ?? '', ...outcome.code === undefined ? {} : { code: outcome.code }, message: outcome.message ?? outcome.code ?? '生成失败' }
        return { status: 'succeeded', plan_id: operation.projectId, path: outcome.path ?? '', paths, model: outcome.model ?? '', message: `图片已保存到产物目录（共 ${String(paths.length)} 张）。` }
      } catch (error) {
        if (operation !== undefined) creative.release(operation)
        return error instanceof CreativeError || error instanceof VideoProjectError
          ? { status: 'failed', code: error.code, message: error.message }
          : { status: 'failed', code: operation === undefined ? 'CREATIVE_OPERATION_UNAVAILABLE' : 'CREATIVE_OUTCOME_UNKNOWN', message: '图片生成或创作记录未完成，请检查产物和原始任务；不要重复提交结果未知的生成。' }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'generate_video',
    description: 'Generate, poll and save one short video clip through the account relay. Call this native tool directly for a simple short-video brief; do not write submission, polling or download scripts. For story direction, character/reference continuity, dialogue or subtitles, use the yunshu-video-director skill. For a complete video such as 40 seconds or automatic assembly, use generate_video_project instead; several camera beats may fit one clip. Edit existing clips with edit_video. This single-clip tool accepts only the chosen model’s declared duration, resolution, ratio, frames and references.' + MEDIA_FAILURE_GUIDANCE,
    parameters: {
      plan_id: { type: 'string', description: 'Explicit update_creation_plan id for this generation. Also provide shot_id.' },
      shot_id: { type: 'string', description: 'Exact shot id in the explicit plan; never guess a latest project.' },
      prompt: { type: 'string', required: true, description: 'What the video should show. Before calling, script user-delegated narrative or dialogue scenes with stable character ids, language, brief exact lines and their timing, identifying on-screen speakers versus narration; preserve user-supplied wording. Do not reduce a story requiring voices to a music montage. Respect silent/no-dialogue requests and do not add dialogue or subtitles to unrelated nonverbal videos. Include requested lip-sync and subtitle requirements. These request native model generation, not separate speech, lip-sync or subtitle processing; verify the rendered result before claiming they are met.' },
      model: { type: 'string', description: 'Optional video model id such as MiniMax-H3. Defaults to the first video model the deployment serves for this account.' },
      duration_seconds: { type: 'number', description: 'Clip length in seconds; only values the chosen model declares are accepted.' },
      resolution: { type: 'string', description: 'Output resolution such as 768P or 2K, when the model offers choices.' },
      ratio: { type: 'string', description: 'Aspect ratio such as 16:9 or 9:16; adaptive inherits it from the reference media.' },
      audio: { type: 'boolean', description: 'Optional requested audio state. Sent as a switch only when the chosen model declares one; fixed native audio accepts only its declared state. An audio stream does not verify dialogue, lip-sync or subtitles.' },
      frame_images: { type: 'array', items: { type: 'string' }, description: 'Optional stored ids (ma_…) used as first/last frame.' },
      reference_images: { type: 'array', items: { type: 'string' }, description: 'Optional stored ids (ma_…) used as multimodal subject/style references, when the model supports them.' },
      reference_videos: { type: 'array', items: { type: 'string' }, description: 'Optional stored ids (ma_…) used as a reference video, when the model supports video-to-video.' },
      reference_audios: { type: 'array', items: { type: 'string' }, description: 'Optional uploaded ma_ audio ids or workspace WAV/MP3 paths, when the model supports audio references. First copy a user-supplied, read-authorized chat attachment outside the workspace into the workspace using existing file tools; do not copy unrelated files. References do not guarantee copied speech, matching mouth movements or subtitles.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          path: { type: 'string' },
          model: { type: 'string' },
          task_id: { type: 'string' },
          plan_id: { type: 'string' },
          code: { type: 'string' },
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
      let operation: CreativeOperation | undefined
      try {
        const binding = await bindCurrentVideoAccount()
        const capability = await capabilityFor('video', args.model ?? null)
        if (!capability.ok) return { status: 'failed', code: capability.code, message: capability.message }
        const referenceAudios: string[] = []
        const references = new Map<string, string>()
        for (const value of args.reference_audios ?? []) {
          referenceAudios.push(await normalizeVideoReference(value, 'audio', exec.agent?.session.header.cwd, references, exec.signal))
        }
        const owner = creativeOwner(exec, binding.identity)
        const images = async (values: readonly string[] | undefined): Promise<string[]> => {
          const result: string[] = []
          for (const value of values ?? []) {
            const source = value.startsWith('ma_') ? value : args.plan_id === undefined ? undefined : await creativeImageReference(owner, args.plan_id, value)
            if (source === undefined) throw new CreativeError('CREATIVE_REFERENCE_INVALID', 400, '请使用已上传的图片，或同一创作计划内实际生成的图片。')
            result.push(source)
          }
          return result
        }
        const built = await buildVideoRequest(capability.model, {
          prompt: args.prompt,
          ...args.duration_seconds === undefined ? {} : { durationSeconds: args.duration_seconds },
          ...args.resolution === undefined ? {} : { resolution: args.resolution },
          ...args.ratio === undefined ? {} : { ratio: args.ratio },
          ...args.audio === undefined ? {} : { audio: args.audio },
          ...args.frame_images === undefined ? {} : { frameImages: await images(args.frame_images) },
          ...args.reference_images === undefined ? {} : { referenceImages: await images(args.reference_images) },
          ...args.reference_videos === undefined ? {} : { referenceVideos: args.reference_videos },
          referenceAudios,
        })
        if (!built.ok) return { status: 'failed', code: built.code, model: capability.model.id, message: built.message }
        exec.signal.throwIfAborted()
        operation = await creative.begin(creativeOwner(exec, binding.identity), { kind: 'video', model: capability.model.id, prompt: args.prompt, shots: [{ prompt: args.prompt, ...args.duration_seconds === undefined ? {} : { durationSeconds: args.duration_seconds } }], ...args.plan_id === undefined ? {} : { planId: args.plan_id }, ...args.shot_id === undefined ? {} : { shotIds: [args.shot_id] } })
        await creative.dispatched(operation)
        const outcome = await runVideoTask(await binding.key(), capability.model.route, built.request, exec.signal)
        await creative.finish(operation, { status: outcome.ok ? 'completed' : exec.signal.aborted ? 'cancelled' : ['TIMEOUT', 'TRANSPORT', 'NO_TASK_ID', 'INSUFFICIENT_BALANCE'].includes(outcome.code ?? '') ? 'unknown' : 'failed', kind: 'video', ...outcome.path === undefined ? {} : { paths: [outcome.path] }, ...outcome.code === undefined ? {} : { errorCode: outcome.code } })
        if (!outcome.ok) {
          return {
            status: outcome.code === 'TIMEOUT' ? 'running' : 'failed',
            plan_id: operation.projectId,
            model: capability.model.id,
            task_id: outcome.taskId ?? '',
            ...outcome.code === undefined ? {} : { code: outcome.code },
            message: outcome.message ?? outcome.code ?? '生成失败',
          }
        }
        if (outcome.path !== undefined && exec.agent !== undefined) {
          const savedPath = outcome.path
          const session = exec.agent.session
          const owner = operation.owner
          const creation = operation
          await creative.preview(operation, savedPath, async () => {
            const editor = createVideoEditor(ctx, { workspaceRoot: owner.workspaceRoot, session, ownedMediaRoots: [dirname(savedPath)], fps: resolved.videoEditFps, timeoutMs: resolved.videoEditTimeoutMs, singlePassMaxInputs: resolved.videoEditSinglePassMaxInputs, ...resolved.videoRuntimeRoot === '' ? {} : { runtimeRoot: resolved.videoRuntimeRoot } })
            if (editor.preview === undefined) throw new CreativeError('CREATIVE_PREVIEW_UNAVAILABLE', 503, '本地视频预览工具暂时不可用。')
            return editor.preview(savedPath, join(owner.workspaceRoot, '.yunshu-creative', 'previews', creation.operationId), exec.signal)
          }).catch((error: unknown) => { ctx.logger.warn('Video saved; optional creation preview was not recorded.', error) })
        }
        return {
          status: 'succeeded',
          plan_id: operation.projectId,
          path: outcome.path ?? '',
          model: capability.model.id,
          task_id: outcome.taskId ?? '',
          message: '视频已保存到产物目录。',
        }
      } catch (error) {
        if (operation !== undefined) creative.release(operation)
        if (error instanceof VideoProjectError || error instanceof CreativeError) return { status: 'failed', code: error.code, message: error.message }
        throw error
      }
    },
  }))
}
