/** Human selection before a chat workflow may charge a non-default video model. @module */
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { z } from 'zod'
import { CreativeError } from './creative-store.ts'

/** Exact account model and output tier used for an unspecified chat video. */
export const DEFAULT_CHAT_VIDEO_MODEL = 'MiniMax-H3'
/** H3's actual published tier; the human shorthand “768k” denotes this tier. */
export const DEFAULT_CHAT_VIDEO_RESOLUTION = '768P'

/** Prepared, validated paid clip plan for one finished work, before any submission. */
export interface VideoModelCandidate {
  readonly model: string
  readonly resolution?: string
  readonly durations: readonly number[]
}

/** Native parameter summaries accepted by the gateway's free quotation route. */
export interface VideoQuoteSegment {
  readonly id: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly reference_counts?: { readonly images: number; readonly videos: number; readonly audios: number }
}

/** Known H3 input usage that cannot be priced without measuring private reference media. */
export class VideoQuoteUnsupportedError extends CreativeError {
  constructor() { super('CREATIVE_VIDEO_QUOTE_UNAVAILABLE', 409, '当前参考视频或音频用量无法可靠报价，尚未提交生成。') }
}

/**
 * Summarize the exact prepared native request without exposing private multipart bytes or paths.
 * @param request - Validated request that would be sent by the existing native serializer.
 * @param index - Stable zero-based clip position in this one-work plan.
 * @returns Native parameters plus actual multipart reference counts.
 */
export function videoModelQuoteSegment(request: Readonly<Record<string, unknown>>, index: number): VideoQuoteSegment {
  if (!Number.isSafeInteger(index) || index < 0 || typeof request.model !== 'string') throw quoteUnavailable()
  const id = `clip-${String(index + 1)}`
  if (request._blackrxReferences !== undefined) {
    if (!Array.isArray(request._blackrxReferences)) throw quoteUnavailable()
    const counts = { images: 0, videos: 0, audios: 0 }
    const references: readonly unknown[] = request._blackrxReferences
    for (const reference of references) {
      if (reference === null || typeof reference !== 'object' || !('kind' in reference)) throw quoteUnavailable()
      if (reference.kind === 'image') counts.images += 1
      else if (reference.kind === 'video') counts.videos += 1
      else if (reference.kind === 'audio') counts.audios += 1
      else throw quoteUnavailable()
    }
    return { id, parameters: { seconds: request.seconds, size: request.size, gen_type: request.gen_type, n: request.n },
      reference_counts: counts }
  }
  if (request.model !== DEFAULT_CHAT_VIDEO_MODEL) throw quoteUnavailable()
  const metadata = request.metadata !== null && typeof request.metadata === 'object' && !Array.isArray(request.metadata)
    ? request.metadata as Record<string, unknown> : {}
  let images = 0
  for (const field of ['first_frame_image', 'last_frame_image']) {
    if (metadata[field] !== undefined) {
      if (typeof metadata[field] !== 'string' || metadata[field] === '') throw quoteUnavailable()
      images += 1
    }
  }
  if (metadata.content !== undefined) {
    if (!Array.isArray(metadata.content)) throw quoteUnavailable()
    const contents: readonly unknown[] = metadata.content
    for (const content of contents) {
      if (content === null || typeof content !== 'object' || !('type' in content)) throw quoteUnavailable()
      if (content.type === 'image_url') images += 1
      else if (content.type === 'video_url' || content.type === 'audio_url') throw new VideoQuoteUnsupportedError()
      else if (content.type !== 'text') throw quoteUnavailable()
    }
  }
  const fields = Object.fromEntries(['resolution', 'ratio'].filter(field => metadata[field] !== undefined)
    .map(field => [field, metadata[field]]))
  return { id, parameters: { seconds: request.seconds, metadata: fields },
    reference_counts: { images, videos: 0, audios: 0 } }
}

const decimalSchema = z.string().max(128).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u)
const referenceCountSchema = z.object({
  images: z.number().int().nonnegative(), videos: z.number().int().nonnegative(), audios: z.number().int().nonnegative(),
}).strict()
const gatewayQuoteSchema = z.object({
  object: z.literal('video.quote'), schema_version: z.literal(1), quote_id: z.string().min(1).max(256),
  account_binding: z.string().min(1).max(256), model: z.string().min(1), works_count: z.number().int().positive(),
  segments: z.array(z.object({ id: z.string().min(1), parameters: z.record(z.string(), z.unknown()),
    usage: z.record(z.string(), z.unknown()), quota: z.number().int().nonnegative(), estimated_amount: decimalSchema,
    reference_counts: referenceCountSchema,
  }).strict()).min(1),
  one_work_quota: z.number().int().nonnegative(), total_quota: z.number().int().nonnegative(),
  currency: z.enum(['CNY', 'USD']), quota_per_usd: z.number().positive(), usd_exchange_rate: z.number().positive(),
  estimated_one_work: decimalSchema, estimated_total: decimalSchema, pricing_revision: z.string().min(1).max(256),
  created_at: z.number().int().positive(), expires_at: z.number().int().positive(),
  estimate_only: z.literal(true), charged: z.literal(false), submitted: z.literal(false), reserved: z.literal(false),
}).strict()

/** Native workload sent to the free, authenticated quote route. */
export interface VideoQuoteRequest {
  readonly model: string
  readonly works_count: number
  readonly segments: readonly VideoQuoteSegment[]
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

/**
 * Validate the gateway's exact native quote contract without evaluating or inventing a tariff.
 * @param value - Actual JSON response body, not a test evidence container.
 * @param request - Complete workload that was quoted.
 * @param candidate - Validated output plan corresponding to that workload.
 * @param accountId - Captured local account identity, separate from the server's opaque binding.
 * @param now - Current wall-clock milliseconds.
 * @returns An exact-decimal, account-bound estimate for the existing selection service.
 */
export function parseVideoModelQuote(
  value: unknown, request: VideoQuoteRequest, candidate: VideoModelCandidate, accountId: string, now = Date.now(),
): VideoModelQuote {
  const parsed = gatewayQuoteSchema.safeParse(value)
  if (!parsed.success) throw quoteUnavailable()
  const quote = parsed.data
  if (quote.model !== candidate.model || quote.model !== request.model || quote.works_count !== request.works_count
    || quote.segments.length !== request.segments.length || quote.segments.length !== candidate.durations.length
    || quote.expires_at - quote.created_at !== 60
    || quote.created_at * 1000 > now + 300_000 || quote.expires_at * 1000 <= now
    || !Number.isSafeInteger(quote.total_quota) || !Number.isSafeInteger(quote.one_work_quota)
    || quote.total_quota !== quote.one_work_quota * quote.works_count
    || quote.one_work_quota !== quote.segments.reduce((sum, segment) => sum + segment.quota, 0)) throw quoteUnavailable()
  for (const [index, segment] of quote.segments.entries()) {
    const expected = request.segments[index]
    if (expected === undefined || segment.id !== expected.id || Number(segment.parameters.seconds) !== candidate.durations[index]
      || canonicalJson(segment.parameters) !== canonicalJson(expected.parameters)
      || canonicalJson(segment.reference_counts) !== canonicalJson(expected.reference_counts ?? { images: 0, videos: 0, audios: 0 })) {
      throw quoteUnavailable()
    }
  }
  return { ...candidate, accountId, accountBinding: quote.account_binding, workCount: quote.works_count,
    estimatedAmount: quote.estimated_total, currency: quote.currency, pricingVersion: quote.pricing_revision,
    specificationKey: canonicalJson({ segments: quote.segments, one_work_quota: quote.one_work_quota,
      total_quota: quote.total_quota, estimated_one_work: quote.estimated_one_work,
      quota_per_usd: quote.quota_per_usd, usd_exchange_rate: quote.usd_exchange_rate }), expiresAt: quote.expires_at * 1000 }
}

/**
 * Read a bounded real HTTP quote. Only the gateway's explicit unavailable contract yields no candidate.
 * @param input - Complete native request, captured account, and the authenticated Host transport.
 * @returns A validated estimate, or absence for an explicitly unsupported quotation.
 */
export async function readVideoModelQuote(input: {
  readonly request: VideoQuoteRequest
  readonly candidate: VideoModelCandidate
  readonly accountId: string
  readonly signal: AbortSignal
  readonly transport: (request: VideoQuoteRequest, signal: AbortSignal) => Promise<Response>
  readonly now?: () => number
}): Promise<VideoModelQuote | undefined> {
  if (Buffer.byteLength(JSON.stringify(input.request)) > 65_536) throw quoteUnavailable()
  const response = await input.transport(input.request, input.signal)
  if (response.body === null) throw quoteUnavailable()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      input.signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.length
      if (bytes > 262_144) throw quoteUnavailable()
      chunks.push(chunk.value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  let body: unknown
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (_invalidBody) { throw quoteUnavailable() }
  if (!response.ok) {
    const unavailable = z.object({ error: z.object({ type: z.literal('video_quote_error'), code: z.literal('quote_unavailable'),
      message: z.string() }).strict() }).strict().safeParse(body)
    if (response.status === 422 && unavailable.success) return undefined
    throw quoteUnavailable()
  }
  return parseVideoModelQuote(body, input.request, input.candidate, input.accountId, input.now?.())
}

/** Account-bound estimate supplied by the gateway's free quotation operation. */
export interface VideoModelQuote extends VideoModelCandidate {
  readonly accountId: string
  readonly accountBinding: string
  readonly specificationKey: string
  readonly workCount: number
  readonly estimatedAmount: string
  readonly currency: 'CNY' | 'USD'
  readonly pricingVersion: string
  readonly expiresAt: number
}

/** Trusted Host callbacks; none is accepted from model tool arguments. */
export interface VideoModelChoiceOptions {
  readonly target: VideoModelCandidate
  readonly baseline?: VideoModelCandidate | undefined
  readonly accountId: string
  readonly workCount: number
  readonly signal: AbortSignal
  readonly assertCurrent: () => Promise<void>
  readonly quote?: ((candidate: VideoModelCandidate, workCount: number, signal: AbortSignal)
  => Promise<VideoModelQuote | undefined>) | undefined
  readonly ask?: ((questions: AskUserQuestionItem[], signal: AbortSignal) => Promise<AskUserQuestionAnswer>) | undefined
  readonly now?: () => number
  readonly baselineRequiresReplan?: boolean
  /** Retain only a process-local check for the exact quote the human selected. */
  readonly onApproved?: (approval: { assertCurrent(signal: AbortSignal): Promise<void> }) => void
}

/**
 * Resolve only the documented H3 shorthand; preserve any other explicit tier.
 * @param resolution - Tool or trusted human-selected resolution.
 * @param model - Exact resolved video model.
 * @param requestedResolution - Optional tier from the original human request.
 * @returns Explicit resolution, or the H3 default when omitted.
 */
export function chatVideoResolution(
  resolution: string | undefined, model: string, requestedResolution?: string,
): string | undefined {
  const selected = requestedResolution ?? (model === DEFAULT_CHAT_VIDEO_MODEL ? DEFAULT_CHAT_VIDEO_RESOLUTION : resolution)
  return selected !== undefined && /^768[pk]$/iu.test(selected.trim()) ? DEFAULT_CHAT_VIDEO_RESOLUTION : selected
}

const quoteSchema = z.object({
  model: z.string().min(1), resolution: z.string().min(1).optional(), durations: z.array(z.number().int().positive()).min(1),
  accountId: z.string().min(1), workCount: z.number().int().positive(),
  estimatedAmount: z.string().max(128).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u), currency: z.enum(['CNY', 'USD']),
  accountBinding: z.string().min(1), specificationKey: z.string().min(1),
  pricingVersion: z.string().trim().min(1), expiresAt: z.number().int().positive(),
}).strict()

function sameCandidate(left: VideoModelCandidate, right: VideoModelCandidate): boolean {
  return left.model === right.model && left.resolution === right.resolution
    && left.durations.length === right.durations.length
    && left.durations.every((duration, index) => duration === right.durations[index])
}

function quoteUnavailable(): CreativeError {
  return new CreativeError('CREATIVE_VIDEO_QUOTE_UNAVAILABLE', 409,
    '当前无法核实这次视频的完整价格，尚未提交生成；请稍后查看报价，或明确使用 H3 768P。')
}

async function isHumanQuestionCancellation(error: unknown): Promise<boolean> {
  try {
    const { UserQuestionError } = await import('@deepseek-ai/dsh-user-questions')
    return error instanceof UserQuestionError && error.code === 'ASK_CANCELLED'
  } catch (_optionalQuestionServiceUnavailable) { return false }
}

function checkedQuote(
  value: VideoModelQuote | undefined, candidate: VideoModelCandidate, options: VideoModelChoiceOptions,
): VideoModelQuote {
  const now = options.now?.() ?? Date.now()
  const parsed = quoteSchema.safeParse(value)
  if (!parsed.success || value === undefined) throw quoteUnavailable()
  if (!sameCandidate(value, candidate) || value.accountId !== options.accountId
    || value.workCount !== options.workCount || !Number.isSafeInteger(value.workCount) || value.workCount < 1
    || value.pricingVersion.trim() === '' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now) {
    throw quoteUnavailable()
  }
  return value
}

function unchangedQuote(left: VideoModelQuote, right: VideoModelQuote): boolean {
  return sameCandidate(left, right) && left.accountId === right.accountId && left.workCount === right.workCount
    && left.accountBinding === right.accountBinding && left.specificationKey === right.specificationKey
    && left.estimatedAmount === right.estimatedAmount && left.currency === right.currency
    && left.pricingVersion === right.pricingVersion
}

function money(amount: string, currency: 'CNY' | 'USD'): string {
  const [whole = '0', fraction = ''] = amount.split('.')
  const decimals = fraction.replace(/0+$/u, '').padEnd(2, '0')
  return `${currency === 'CNY' ? '¥' : 'US$'}${whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ',')}.${decimals}`
}

/** Only exact explicit cancellation from the trusted current card revokes this request. */
const CUSTOM_MODEL_CHOICE_CANCELLATIONS = new Set(['取消本次生成', '取消', '不用了', '暂不生成', 'cancel', 'stop'])

/**
 * Require a real, price-informed human choice before using any non-H3 model.
 * @param options - Validated alternatives and trusted quote, question, and account callbacks.
 * @returns The exact human-selected candidate, or H3 without an extra question.
 * @throws {CreativeError} when estimates or human choice cannot be verified; no submission occurs here.
 */
export async function chooseChatVideoModel(options: VideoModelChoiceOptions): Promise<VideoModelCandidate> {
  options.signal.throwIfAborted()
  await options.assertCurrent()
  for (const candidate of [options.target, ...options.baseline === undefined ? [] : [options.baseline]]) {
    if (candidate.model.trim() === '' || candidate.durations.length === 0
      || candidate.durations.some(duration => !Number.isSafeInteger(duration) || duration < 1)) throw quoteUnavailable()
  }
  if (options.target.model === DEFAULT_CHAT_VIDEO_MODEL) return options.target
  if (options.baseline !== undefined && options.baseline.model !== DEFAULT_CHAT_VIDEO_MODEL) throw quoteUnavailable()
  if (options.quote === undefined) throw quoteUnavailable()
  const ask = options.ask
  if (ask === undefined) throw new CreativeError('CREATIVE_VIDEO_MODEL_CHOICE_UNAVAILABLE', 409,
    '使用其他视频型号前需要由你查看报价并选择；当前无法显示选择卡，尚未提交生成。')
  const quote = options.quote
  const readEstimates = async (): Promise<readonly [VideoModelQuote | undefined, VideoModelQuote]> => {
    try {
      const [baselineValue, targetValue] = await Promise.all([
        options.baseline === undefined ? undefined : quote(options.baseline, options.workCount, options.signal),
        quote(options.target, options.workCount, options.signal),
      ])
      const baseline = baselineValue === undefined || options.baseline === undefined ? undefined
        : checkedQuote(baselineValue, options.baseline, options)
      const target = checkedQuote(targetValue, options.target, options)
      if (baseline !== undefined
        && (baseline.accountBinding !== target.accountBinding || baseline.currency !== target.currency)) {
        throw quoteUnavailable()
      }
      return [baseline, target]
    } catch (_error) {
      options.signal.throwIfAborted()
      throw quoteUnavailable()
    }
  }
  let estimates = await readEstimates()
  for (let revision = 0; revision < 2; revision += 1) {
    options.signal.throwIfAborted()
    const baseline = estimates[0]
    const target = estimates[1]
    const baselineLabel = baseline === undefined ? undefined
      : `保留 H3 ${baseline.resolution ?? DEFAULT_CHAT_VIDEO_RESOLUTION}（约 ${money(baseline.estimatedAmount, baseline.currency)}）`
    const targetLabel = `使用 ${target.model}（约 ${money(target.estimatedAmount, target.currency)}）`
    const cancelLabel = '取消本次生成'
    const seconds = target.durations.reduce((sum, duration) => sum + duration, 0)
    const questionId = 'video-model-price-choice'
    let answer: AskUserQuestionAnswer
    try { answer = await ask([{
      id: questionId, header: '视频型号与价格', question: '请选择本次视频使用的型号。',
      detail: `每件作品计划 ${String(seconds)} 秒、${String(target.durations.length)} 个生成片段；`
        + `本次按 ${String(options.workCount)} 件作品估算总价。并发不会增加作品数量。`
        + '这是生成前估算，最终按实际用量结算；本调用只开始一件作品。'
        + (baseline === undefined ? ' H3 不支持当前组合或暂无法核实报价，本次保留素材和规格，只提供所选型号与取消。' : ''),
      options: [
        ...baselineLabel === undefined ? [] : [{ label: baselineLabel, description: options.baselineRequiresReplan === true
          ? '按 H3 的合法片段估算；现有分镜需要重新规划，选择后本次不提交生成。' : '使用 H3 的已核实规格和本次总价。' }],
        { label: targetLabel, description: `使用所选型号${target.resolution === undefined ? '' : ` · ${target.resolution}`}。` },
        { label: cancelLabel, description: '不提交本次生成。' },
      ], multiSelect: false,
    }], options.signal) } catch (error) {
      options.signal.throwIfAborted()
      if (await isHumanQuestionCancellation(error)) throw new CreativeError('USER_CANCELLED', 409,
        '已取消本次视频生成，未提交模型请求。')
      throw new CreativeError('CREATIVE_VIDEO_MODEL_CHOICE_UNAVAILABLE', 409,
        '型号选择未完成，尚未提交生成；请重新查看报价并选择。')
    }
    const selected = answer.answers.length === 1 && answer.answers[0]?.id === questionId ? answer.answers[0] : undefined
    const customCancellation = typeof selected?.custom === 'string'
      && CUSTOM_MODEL_CHOICE_CANCELLATIONS.has(selected.custom.normalize('NFKC').trim().toLowerCase())
    const label = selected?.selected.length === 1 && selected.custom === undefined ? selected.selected[0] : undefined
    if (customCancellation || label === cancelLabel) throw new CreativeError('USER_CANCELLED', 409,
      '已取消本次视频生成，未提交模型请求。')
    if (label === undefined || label !== baselineLabel && label !== targetLabel) {
      throw new CreativeError('CREATIVE_VIDEO_MODEL_CHOICE_UNAVAILABLE', 409, '未收到明确的型号选择，尚未提交生成。')
    }
    options.signal.throwIfAborted()
    await options.assertCurrent()
    const fresh = await readEstimates()
    if (estimates.every((estimate, index) => {
      const current = fresh[index]
      if (estimate === undefined) return current === undefined
      return estimate.expiresAt > (options.now?.() ?? Date.now()) && current !== undefined && unchangedQuote(estimate, current)
    })) {
      const candidate = label === baselineLabel ? options.baseline : options.target
      const approved = label === baselineLabel ? fresh[0] : fresh[1]
      if (approved === undefined || candidate === undefined) throw quoteUnavailable()
      options.onApproved?.({ async assertCurrent(signal) {
        signal.throwIfAborted()
        await options.assertCurrent()
        const current = checkedQuote(await quote(candidate, options.workCount, signal), candidate, options)
        await options.assertCurrent()
        signal.throwIfAborted()
        checkedQuote(current, candidate, options)
        if (!unchangedQuote(approved, current)) throw new CreativeError('CREATIVE_VIDEO_QUOTE_CHANGED', 409,
          '视频报价已变化，尚未提交新的生成请求；请重新查看报价并选择。')
      } })
      return candidate
    }
    estimates = fresh
  }
  throw new CreativeError('CREATIVE_VIDEO_QUOTE_CHANGED', 409,
    '视频报价发生变化，尚未提交生成；请重新查看当前报价后选择。')
}
