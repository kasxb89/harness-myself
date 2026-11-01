/** Private account/deployment media choices with atomic compare-and-swap publication. @module */
import { createHash } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { normalizeApiBaseUrl } from './api-url.ts'
import { CreativeError } from './creative-store.ts'
import type { ImageParams, ModelCapability, VideoParams } from './media.ts'
import type { MediaPreferenceSelection, MediaPreferences } from './media-preferences-types.ts'
import { writePrivateState } from './private-state-file.ts'

const scalar = z.union([z.string().min(1).max(128), z.number().refine(value => !Object.is(value, -0)), z.boolean()])
const selection = z.object({ model: z.string().min(1).max(256),
  parameters: z.record(z.string().max(32), scalar).refine(value => Object.keys(value).length <= 20) }).strict()
const document = z.object({ schema_version: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/u),
  image: selection.nullable(), video: selection.nullable() }).strict()
const put = z.object({ schema_version: z.literal(1), expected_account_owner: z.string().regex(/^[a-f0-9]{64}$/u),
  expected_revision: z.string().regex(/^[a-f0-9]{64}$/u), image: selection.nullable(), video: selection.nullable() }).strict()

function invalid(message = '所选模型参数不合法，请按当前模型目录重新选择；尚未提交生成。'): never {
  throw new CreativeError('MEDIA_PARAMETERS_INVALID', 400, message)
}

/**
 * Validate a static selection against one same-modality authorized model and complete specifications.
 * @param kind - Image or native video clip preferences.
 * @param value - Parsed static choices, or null to follow the platform.
 * @param models - Current-account authorized directory.
 */
export function validateMediaPreference(kind: 'image' | 'video', value: MediaPreferenceSelection | null, models: readonly ModelCapability[]): void {
  if (value === null) return
  const model = models.find(model => model.kind === kind && model.id === value.model)
  if (model === undefined) throw new CreativeError('MEDIA_MODEL_UNAVAILABLE', 409,
    '保存的模型当前不在你的可用目录中，请重新选择或跟随平台默认；尚未提交生成。')
  const fields = value.parameters
  const menus: Record<string, readonly (string | number | boolean)[]> = {}
  let seed: boolean
  if (kind === 'image') {
    const params = model.params as ImageParams
    Object.assign(menus, { size: params.sizes, resolution: params.resolutions ?? [], quality: params.qualities,
      background: params.backgrounds, format: params.formats, moderation: params.moderations })
    seed = params.seed
    if (fields.count !== undefined && (typeof fields.count !== 'number' || !Number.isSafeInteger(fields.count)
      || fields.count < 1 || fields.count > params.maxCount)) invalid()
  } else {
    const params = model.params as VideoParams
    Object.assign(menus, { resolution: params.resolutions, ratio: params.ratios, mode: params.modes, quality: params.qualities ?? [],
      seconds: params.durations, size: params.specifications?.flatMap(item => item.size === undefined ? [] : [item.size]) ?? [] })
    seed = params.seed
    if (fields.audio !== undefined && (typeof fields.audio !== 'boolean'
      || !params.audioToggle && (params.audioOutput === 'unknown' || fields.audio !== params.audio))) invalid()
    if (fields.watermark !== undefined && (typeof fields.watermark !== 'boolean' || !params.watermark)) invalid()
  }
  for (const [name, value] of Object.entries(fields)) {
    if (name === 'seed') { if (!seed || typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(); continue }
    if (name === 'count' && kind === 'image' || kind === 'video' && (name === 'audio' || name === 'watermark')) continue
    if (!Object.hasOwn(menus, name) || !menus[name]?.includes(value)) invalid()
  }
  const params = model.params as ImageParams | VideoParams
  const dimensions = ['size', 'resolution', 'seconds', 'ratio', 'quality', 'mode'] as const
  if (params.specifications !== undefined && !params.specifications.some(specification => dimensions.every(field =>
    fields[field] === undefined || fields[field] === specification[field]))) invalid()
  if (kind === 'video' && fields.seconds !== undefined && typeof fields.resolution === 'string') {
    const allowed = (params as VideoParams).durationByResolution?.[fields.resolution]
    if (allowed !== undefined && !allowed.includes(Number(fields.seconds))) invalid()
  }
}

function canonical(value: MediaPreferenceSelection | null): MediaPreferenceSelection | null {
  return value === null ? null : { model: value.model,
    parameters: Object.fromEntries(Object.entries(value.parameters).sort(([left], [right]) => left.localeCompare(right))) }
}

/**
 * Stable scope survives access-token renewal while isolating backend prefixes and accounts.
 * @param backend - Canonical configured API root.
 * @param accountId - Stable authenticated account ID.
 * @returns Opaque private preference key.
 */
export function mediaPreferencesScope(backend: string, accountId: string): string {
  return createHash('sha256').update(JSON.stringify([normalizeApiBaseUrl(backend), accountId])).digest('hex')
}

/** Private schema-1 files are independent from login credentials and Session logs. */
export class MediaPreferencesStore {
  constructor(private readonly directory: string) {}

  /**
   * Read one account's choices without any remote access.
   * @param scope - Stable backend/account scope.
   * @returns Saved choices or an empty platform-following document.
   */
  async read(scope: string): Promise<MediaPreferences> {
    if (!/^[a-f0-9]{64}$/u.test(scope)) throw new Error('Invalid preference scope')
    let text: string
    try {
      const handle = await open(join(this.directory, `${scope}.json`), 'r')
      try {
        const bytes = Buffer.alloc(16_385)
        let length = 0
        while (length < bytes.length) {
          const result = await handle.read(bytes, length, bytes.length - length, length)
          if (result.bytesRead === 0) break
          length += result.bytesRead
        }
        if (length > 16_384) throw new Error('Media preference file exceeds the read limit')
        text = bytes.subarray(0, length).toString('utf8')
      } finally { await handle.close() }
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return this.result(scope, null, null)
      throw new CreativeError('MEDIA_PREFERENCES_UNAVAILABLE', 409, '暂时无法读取图片和视频偏好，请稍后重试；尚未提交生成。')
    }
    let parsed: ReturnType<typeof document.safeParse> | undefined
    try { parsed = text.length <= 16_384 ? document.safeParse(JSON.parse(text)) : undefined }
    catch (_invalidPrivatePreferences: unknown) { parsed = undefined }
    if (parsed?.success !== true || parsed.data.scope !== scope) throw new CreativeError('MEDIA_PREFERENCES_UNAVAILABLE', 409,
      '图片和视频偏好记录暂不可用，请重新保存偏好；尚未提交生成。')
    return this.result(scope, parsed.data.image, parsed.data.video)
  }

  /**
   * Save only current authorized static controls, under an owner recheck and revision lock.
   * @param scope - Stable backend/account scope.
   * @param owner - Ephemeral current-login owner shown to the renderer.
   * @param value - Untrusted HTTP JSON.
   * @param models - Same-modality relay/pricing intersection.
   * @param current - Rechecks account identity before publication.
   * @returns Atomically committed choices and their new revision.
   */
  async save(
    scope: string, owner: string, value: unknown, models: readonly ModelCapability[], current: () => Promise<void>,
  ): Promise<MediaPreferences> {
    const parsed = put.safeParse(value)
    if (!parsed.success) invalid()
    if (parsed.data.expected_account_owner !== owner) throw new CreativeError('ACCOUNT_CHANGED', 409, '登录状态已变化，请刷新后重新选择。')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    return withFileLock(join(this.directory, `${scope}.json`), async () => {
      await current()
      const previous = await this.read(scope)
      if (previous.revision !== parsed.data.expected_revision) throw new CreativeError('MEDIA_PREFERENCES_CONFLICT', 409,
        '图片和视频偏好已在另一窗口变化，请刷新后重新选择。')
      if (JSON.stringify(canonical(previous.image)) !== JSON.stringify(canonical(parsed.data.image))) {
        validateMediaPreference('image', parsed.data.image, models)
      }
      if (JSON.stringify(canonical(previous.video)) !== JSON.stringify(canonical(parsed.data.video))) {
        validateMediaPreference('video', parsed.data.video, models)
      }
      const next = this.result(scope, parsed.data.image, parsed.data.video)
      await current()
      await writePrivateState(join(this.directory, `${scope}.json`), JSON.stringify({ schema_version: 1, scope,
        image: next.image, video: next.video }) + '\n')
      return next
    })
  }

  private result(scope: string, image: MediaPreferenceSelection | null, video: MediaPreferenceSelection | null): MediaPreferences {
    const body = { schema_version: 1 as const, scope, image: canonical(image), video: canonical(video) }
    return { ...body, revision: createHash('sha256').update(JSON.stringify(body)).digest('hex') }
  }
}
