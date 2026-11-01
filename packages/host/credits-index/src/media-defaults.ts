/** Account-bound public defaults; explicit model choices bypass this optional lookup. @module */
import { CreativeError } from './creative-store.ts'
import { parseClientMediaDefaultsStatus, type ClientMediaDefaults } from './client-model-config.ts'
import type { ModelCapability } from './media.ts'
import { DEFAULT_CHAT_VIDEO_MODEL } from './video-model-choice.ts'

/** A displayed default is not permission to access or generate with that model. */
export interface MediaDefaultSelection {
  readonly model: string | null
  readonly configured: boolean
  readonly available: boolean
}

/**
 * Select one deployment default only from this account's same-modality directory.
 * @param defaults - The validated current backend document, absent on older servers.
 * @param kind - Requested media modality.
 * @param models - Current group-filtered parameter catalog.
 * @param visible - IDs served to the captured account, across legacy endpoint declarations.
 * @returns Exact default ID, its source and availability; no alternative is substituted.
 */
export function mediaDefaultSelection(
  defaults: ClientMediaDefaults | undefined, kind: 'image' | 'video', models: readonly ModelCapability[], visible: ReadonlySet<string>,
): MediaDefaultSelection {
  const configured = kind === 'image' ? defaults?.defaultImageModel : defaults?.defaultVideoModel
  const available = models.filter(model => model.kind === kind && visible.has(model.id))
  const model = configured ?? (kind === 'video' ? DEFAULT_CHAT_VIDEO_MODEL : available[0]?.id ?? null)
  return { model, configured: configured !== undefined && configured !== null,
    available: model !== null && available.some(value => value.id === model) }
}

/**
 * Require the configured model without silently replacing an unavailable deployment choice.
 * @param selected - Captured current-account default lookup.
 * @returns The exact model, or absence when a legacy image directory has no default.
 */
export function requireMediaDefault(selected: MediaDefaultSelection): string | null {
  if (selected.configured && !selected.available) throw new CreativeError('DEFAULT_MEDIA_MODEL_UNAVAILABLE', 409,
    '后台设置的默认模型当前不在你的可用目录中；尚未提交生成。请查看可用模型并明确选择，或联系管理员调整默认模型。')
  return selected.model
}

/** One owner-bound read; invalid/unavailable present configuration never becomes a paid fallback. */
export class MediaDefaultsCache {
  private cached: { owner: string; expires: number; value: ClientMediaDefaults | undefined } | undefined
  constructor(private readonly ttlMs: number) {}

  /** Forget account-owned defaults when login, backend or plugin lifetime changes. */
  clear(): void { this.cached = undefined }

  /**
   * Read bounded public status under the caller's lifecycle, then publish only for the same owner.
   * @param owner - Backend/account/login/epoch key captured by the current operation.
   * @param send - Credential-free fixed status request.
   * @param signal - Initiating operation and plugin lifetime.
   * @param current - Rechecks captured login after transport and parsing.
   * @returns Detached current configuration, or absence only when the old API omits it.
   */
  async read(
    owner: string, send: () => Promise<Response>, signal: AbortSignal, current: () => Promise<void>,
  ): Promise<ClientMediaDefaults | undefined> {
    signal.throwIfAborted()
    await current()
    if (this.cached?.owner === owner && this.cached.expires > Date.now()) return this.cached.value
    let response: Response
    try { response = await send() } catch (_error: unknown) {
      signal.throwIfAborted()
      throw new CreativeError('DEFAULT_MEDIA_CONFIG_UNAVAILABLE', 409,
        '暂时无法读取默认模型配置；尚未提交生成。请稍后重试，或明确选择当前目录中的模型。')
    }
    try {
      if (!response.ok || response.body === null) throw new Error('Default model status unavailable')
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const chunk of response.body) {
        signal.throwIfAborted()
        size += chunk.length
        if (size > 1_048_576) throw new Error('Default model status exceeds the limit')
        chunks.push(chunk)
      }
      const value = parseClientMediaDefaultsStatus(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      signal.throwIfAborted()
      await current()
      this.cached = { owner, expires: Date.now() + this.ttlMs, value }
      return value
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof CreativeError) throw error
      throw new CreativeError('DEFAULT_MEDIA_CONFIG_UNAVAILABLE', 409,
        '默认模型配置暂不可用或格式无效；尚未提交生成。请稍后重试，或明确选择当前目录中的模型。')
    } finally { await response.body?.cancel().catch(() => {}) }
  }
}
