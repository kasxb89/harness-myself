/** Human-request attribution and bounded video-work counts, reconstructed from existing Session events. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

const NUMBER = '(?:[1-9]\\d*|[一二两三四五六七八九十]+)'
const DURATION = `(?:(?:\\d+(?:\\.\\d+)?|${NUMBER})\\s*(?:秒钟?|s|分钟|min)\\s*的?\\s*)?`
const VIDEO_NOUN = '(?:短视频|带货视频|广告视频|动画视频|视频|短片|成片)'
const VIDEO = `(?:(?:MiniMax-H3|H3)\\s*)?${VIDEO_NOUN}`
const REQUEST_PREFIX = '(?:请|帮我|给我|麻烦|替我|直接|立即|现在|只|再|重新|另外|额外|分别'
  + '|在(?:当前|这个)?(?:聊天|对话)(?:框)?(?:里|中))'
const VERB = '(?:生成|制作|创作|做|输出|来)(?:出|成|给我)?\\s*'
const MEDIA_COUNT = new RegExp(`(${NUMBER})\\s*(?:条|个|支)\\s*([\\p{Script=Han}]{0,16}?)${DURATION}${VIDEO}`, 'giu')
const SHORT_COUNT = new RegExp(`${VERB}(${NUMBER})\\s*(?:条|版|支)\\s*$`, 'giu')

function countOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (/^[1-9]\d*$/u.test(value)) {
    const result = Number(value)
    return Number.isSafeInteger(result) ? result : undefined
  }
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (value === '十') return 10
  if (value.length === 1) return digits[value]
  const parts = /^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/u.exec(value)
  if (parts === null) return undefined
  const left = parts[1]
  const right = parts[2]
  const tens = left === '' ? 1 : left === undefined ? undefined : digits[left]
  const ones = right === '' ? 0 : right === undefined ? undefined : digits[right]
  return tens === undefined || ones === undefined ? undefined : tens * 10 + ones
}

/**
 * Recognize a small set of explicit work-count phrases in the original human text.
 * @param text - Original human text, never model arguments or plan names.
 * @returns Explicit consistent count, or one when quantities are absent or ambiguous.
 */
export function explicitVideoWorkCount(text: string): number {
  const normalized = text.normalize('NFKC').replaceAll(/"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|`[^`]*`/gu, '')
  if (/[<>≤≥]/u.test(normalized)
    || /比较|对比|最多|至少|至多|多于|少于|超过|或|还是|改成|改为/u.test(normalized)) return 1
  const counts: number[] = []
  for (const clause of normalized.split(/[\n，,。；;！？!?]/u)) {
    if (/不要|不需|无需|不必|不能|不是|并非|而非|(?<!分)别|勿|取消/u.test(clause)
      && (new RegExp(VERB, 'iu').test(clause) || new RegExp(MEDIA_COUNT.source, 'iu').test(clause))) return 1
    for (const match of clause.matchAll(MEDIA_COUNT)) {
      if (/人物|角色|商品|产品|物品|模型|镜头|分镜|片段/u.test(match[2] ?? '')) continue
      const count = countOf(match[1])
      if (count === undefined) return 1
      counts.push(count)
    }
    for (const match of clause.matchAll(SHORT_COUNT)) {
      const count = countOf(match[1])
      if (count === undefined) return 1
      counts.push(count)
    }
  }
  const first = counts[0]
  return first !== undefined && counts.every(count => count === first) ? first : 1
}

/**
 * Distinguish new creation requests from recovery, observation, cancellation, or uncertain text.
 * @param text - Original human text.
 * @returns The bounded grammar's work count, or zero when no new generation is established.
 */
export function videoWorkAllowance(text: string): number {
  const value = text.normalize('NFKC').trim()
  const clauses = value.split(/[：:\n，,。；;]/u)
  const primary = clauses[0] ?? ''
  const address = `^(?:${REQUEST_PREFIX}\\s*)*`
  const modelPrefix = '(?:(?:用|使用|采用)\\s*[a-z][a-z0-9._/-]*\\s*)?'
  const artifact = '(?:代码|脚本|提示词|说明|教程|示例)'
  if (new RegExp(`${address}(?:翻译|改写|润色|解释|说明)`, 'u').test(primary)
    || /^(?:please\s+)?(?:translate|rewrite|explain)\b/iu.test(primary)
    || clauses.some(clause => new RegExp(`${address}${modelPrefix}(?:生成|制作|创作|新做|做|来|写|编写|提供|继续(?:生成|制作)|补拍)`
      + `.*(?:${artifact}[.!！]?$|${VIDEO}的?${artifact})`, 'iu').test(clause))) return 0
  const remaining = '(?:剩余|剩下|未完成)(?:的)?'
  const existing = `(?:这个|这条|那个|那条|上一个|上一条|之前的|原来的|原)${VIDEO_NOUN}`
  const recovery = new RegExp(`${address}${modelPrefix}(?:(?:继续|接着|恢复)(?:生成|制作|创作)|补拍`
    + `|(?:生成|制作|创作)\\s*(?:${remaining}|${existing}\\s*${remaining}))`, 'iu')
  const newAttempt = new RegExp(`${address}(?:另外|额外|再|重新)${modelPrefix}(?:生成|制作|创作|做)`, 'iu')
  if (clauses.some(clause => recovery.test(clause.trim()) && !newAttempt.test(clause.trim()))) return 0
  const noGeneration = new RegExp('(?:不要|不需要|无需|不必|不用|(?<!分)别|勿)'
    + `(?:(?:${REQUEST_PREFIX}|继续|重复)\\s*)*(?:生成|制作|创作|重做|做|来)`, 'u')
  const noEn = /\b(?:do not|don't|never|stop|cancel)\s+(?:re-?generate|generating|generate|re-?make|make|create|produce|render|start)\b/iu
  const confirmation = '(?:等|等待)我(?:确认|同意|批准)'
  const awaitingGeneration = new RegExp(`${confirmation}(?:(?:之|以)?后)?[\\s，,。；;]*(?:再|才)\\s*`
    + '(?:(?:开始|继续)\\s*)?(?:生成|制作|创作)', 'u')
  if (awaitingGeneration.test(value.replaceAll(/"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|`[^`]*`/gu, ''))) return 0
  if (value === '' || noGeneration.test(value)
    || /(?:停止|取消)(?:本次|整个|所有)?(?:任务|生成|创作)|^(?:停止|取消)[。！!]?$/u.test(value)
    || new RegExp(`${address}(?:告诉我|看看|看一下|查看|查询|展示|播放|分析|解释|评价|检查|为什么|怎么|如何|示例|例如|假如|如果)`, 'u')
      .test(value)
    || /哪个好|挑最好的|选(?:出)?最好的|为什么|怎么这么慢|不是(?:要)?(?:生成|制作|做)/u.test(value)
    || /^(?:please\s+)?(?:show|read|check|inspect|analyse|analyze|explain|tell|compare|play|review|what|why|how|which)\b/iu.test(value)
    || noEn.test(value)
    || /^(?:stop|cancel)[.!]?$/iu.test(value)) return 0
  const commandPrefix = '(?:^|[，,。；;！？!?])\\s*'
    + `(?:(?:${REQUEST_PREFIX}|用H3|使用H3|用MiniMax-H3|使用MiniMax-H3|H3`
    + '|(?:用|使用|采用)\\s*[a-z][a-z0-9._/-]*|按此提示词|按这个提示词|按以下提示词|根据此提示词)\\s*)*'
  const command = new RegExp(`${commandPrefix}(?:生成|制作|创作|新做|做|重做|来\\s*(?:${NUMBER}\\s*)?(?:条|个|支))`, 'iu')
  const commandMatch = command.exec(value)
  if (commandMatch !== null) {
    const preceding = value.slice(0, commandMatch.index).split(/[：:\n，,。；;！？!?]/u)
    const condition = new RegExp(`${address}(?:如果|假如|${confirmation})`, 'u')
    if (preceding.some(clause => condition.test(clause.trim()))) return 0
  }
  const explicit = commandMatch !== null
    || /(?:^|[.;!?]\s*)(?:please\s+)?(?:generate|create|make|start|produce|render)\b/iu.test(value)
  if (!explicit && /进度|状态|这么慢|多久|完成了|完成没有|好了没|好了没有|已有成片|已有视频|现有视频/u.test(value)) return 0
  if (/[?？吗]\s*$/u.test(value) && !/^(?:请|帮我|给我)/u.test(value)) return 0
  const video = new RegExp(VIDEO, 'u').test(value) || /\b(?:videos?|MiniMax-H3|H3)\b/iu.test(value)
  const briefPattern = `^(?:(?:请|帮我|给我)\\s*)?(?:(?:用|使用)?(?:H3|MiniMax-H3)\\s*)?(?:${NUMBER}\\s*(?:条|个|支)\\s*)?`
    + `\\d+(?:\\.\\d+)?\\s*(?:秒钟?|s|分钟|min)\\s*的?\\s*${VIDEO}[。.!！]?$`
  const brief = new RegExp(briefPattern, 'iu').test(value)
    || new RegExp(`^${NUMBER}\\s*(?:条|个|支)\\s*${VIDEO}[。.!！]?$`, 'u').test(value)
  const repeat = /^(?:请|帮我|给我)?\s*(?:再(?:生成|做|来)(?:一|1)(?:条|版)?|(?:另外|再)生成|重新(?:生成|做)|新做|重做(?:这(?:一)?条)?)[。.!！]?$/u.test(value)
  return explicit && (video || new RegExp(SHORT_COUNT.source, 'iu').test(value)) || brief || repeat
    ? explicitVideoWorkCount(value) : 0
}

/**
 * Read one explicit duration per finished video without treating clip lengths as output lengths.
 * @param text - Original human text, never a plan or model arguments.
 * @returns Duration in seconds, or absence when missing, negated, quoted, or conflicting.
 */
export function humanVideoDurationSeconds(text: string): number | undefined {
  const value = text.normalize('NFKC')
  if (videoWorkAllowance(value) < 1) return undefined
  const affirmative = value.replaceAll(/"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|`[^`]*`/gu, '')
    .split(/[，,。；;\n]/u).filter(clause => !/不要|不需|无需|不用|(?<!分)别|勿|而非|不是/u.test(clause)).join(' ')
  if (/或|还是|比较|对比|最多|至少|至多|多于|少于|超过/u.test(affirmative)
    || /(?<![a-z0-9._/])[0-9一二两三四五六七八九十]+\s*(?:秒钟?|s|分钟|min)?\s*(?:到|至|[-~～—])\s*[0-9一二两三四五六七八九十]+\s*(?:秒钟?|s\b|分钟|min\b)/iu
      .test(affirmative)) return undefined
  const amount = `(?:\\d+(?:\\.\\d+)?|${NUMBER})`
  const units = '(?:秒钟?|seconds?|secs?|s|分钟|min(?:ute)?s?)'
  const duration = `(?<![0-9a-z.+一二两三四五六七八九十百千万亿零-])(${amount})\\s*(${units})`
  const prefix = new RegExp(`${duration}\\s*的?\\s*${VIDEO}`, 'giu')
  const specified = new RegExp('(?:每(?:条|个|支)(?:视频)?|(?:视频|成片|全片)(?:的)?(?:总)?时长|总时长|片长)'
    + `\\s*(?:为|是|[:：])?\\s*${duration}`, 'giu')
  const seconds = [...affirmative.matchAll(prefix), ...affirmative.matchAll(specified)].flatMap((match) => {
    const raw = match[1]
    const unit = match[2]
    if (raw === undefined || unit === undefined) return []
    const amount = /^[0-9]/u.test(raw) ? Number(raw) : countOf(raw)
    if (amount === undefined || !Number.isFinite(amount) || amount <= 0) return [NaN]
    return [amount * (/^(?:分|min)/iu.test(unit) ? 60 : 1)]
  })
  const first = seconds[0]
  return first !== undefined && Number.isFinite(first) && seconds.every(value => value === first) ? first : undefined
}

/**
 * Read a single affirmative tier in a human video request without retaining its text.
 * @param text - Original human text, never the model's selected parameters.
 * @returns Canonical tier, or absence for negated, quoted, or conflicting specifications.
 */
export function humanVideoResolution(text: string): string | undefined {
  const value = text.normalize('NFKC')
  if (videoWorkAllowance(value) < 1) return undefined
  const affirmative = value.replaceAll(/"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|`[^`]*`/gu, '')
    .split(/[，,。；;\n]/u).filter(clause => !/不要|不需|无需|不用|(?<!分)别|勿|而非|不是/u.test(clause)).join(' ')
  const pattern = /(?<![a-z0-9._/-])(?:\d+[pk]|\d+\s*[x×]\s*\d+)(?![a-z0-9._/-])/giu
  const tiers = [...affirmative.matchAll(pattern)]
    .map(match => /^768[pk]$/iu.test(match[0]) ? '768P'
      : match[0].replaceAll(/\s+/gu, '').toUpperCase().replace(/[X×]/u, 'x'))
  const first = tiers[0]
  return first !== undefined && tiers.every(tier => tier === first) ? first : undefined
}

/**
 * Preserve an explicitly named exact video model from a bounded human selection phrase.
 * @param text - Original human text.
 * @returns One unambiguous exact id; generic vendor and comparative requests are not inferred.
 */
export function humanVideoModel(text: string): string | undefined {
  const value = text.normalize('NFKC')
  if (videoWorkAllowance(value) < 1) return undefined
  const clauses = value.replaceAll(/"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|`[^`]*`/gu, '')
    .split(/[，,。；;\n]/u).filter(clause => !/不要|不需|无需|不用|(?<!分)别|勿|而非|不是/u.test(clause))
  const model = '(?:MiniMax-H3|H3|[a-z][a-z0-9._/-]*[0-9._/-][a-z0-9._/-]*)'
  const pattern = new RegExp(`(?:使用|采用|选择|换成|改用|用|\\b(?:use|using|model)\\s*:?\\s+)\\s*(${model})`, 'giu')
  const values = clauses.flatMap(clause => [...clause.matchAll(pattern)]
    .flatMap(match => match[1] === undefined ? [] : [match[1].replace(/[.]+$/u, '')]))
  if (/^(?:MiniMax-H3|H3)\s/iu.test(value)) values.push('MiniMax-H3')
  if (clauses.some(clause => new RegExp(`(?<![a-z0-9._/-])(?:MiniMax-H3|H3)\\s*${VIDEO_NOUN}`, 'iu').test(clause))) {
    values.push('MiniMax-H3')
  }
  const models = values.map(id => /^(?:MiniMax-H3|H3)$/iu.test(id) ? 'MiniMax-H3' : id)
  const first = models[0]
  return first !== undefined && models.every(id => id === first) ? first : undefined
}

const requestSchema = z.object({
  messageId: z.string().min(1), sourceSeq: z.number().int().nonnegative(),
  maxWorks: z.number().int().nonnegative(), turn: z.number().int().nonnegative(),
  requestedResolution: z.string().min(1).optional(),
  requestedDurationSeconds: z.number().positive().optional(),
  requestedModel: z.string().min(1).optional(),
  cancelled: z.literal(true).optional(),
}).strict()
const callSchema = z.object({ callId: z.string().min(1), messageId: z.string().min(1), name: z.string(),
  rootCallSeq: z.number().int().nonnegative().optional(), turn: z.number().int().nonnegative().optional(),
  native: z.literal(true).optional(), pending: z.literal(true).optional() }).strict()
const evidenceSchema = z.object({
  callId: z.string().min(1), messageId: z.string().min(1),
  rootCallSeq: z.number().int().nonnegative().optional(),
  operationId: z.string().optional(), videoProjectId: z.string().optional(),
}).strict()
const stateSchema = z.object({
  inherited: z.number().int().nonnegative(), turn: z.number().int().nonnegative(),
  requests: z.array(requestSchema), calls: z.array(callSchema), evidence: z.array(evidenceSchema),
}).strict()
type VideoIntentState = z.infer<typeof stateSchema>

/** Private v1 operation attribution, committed before a new video work may submit. */
export interface VideoRequestGrant {
  readonly schema: 1
  readonly messageId: string
  readonly sourceSeq: number
  readonly maxWorks: number
  readonly turn: number
  readonly callId: string
  readonly rootCallId: string
  /** Exact native tool/call event; older private records may omit it. */
  readonly rootCallSeq?: number
}

/** Same-process request attribution plus existing logged operation evidence. */
export interface VideoGenerationIntent {
  readonly grant: VideoRequestGrant
  /** Unambiguous output tier from the original human text, never model tool arguments. */
  readonly requestedResolution?: string
  /** Explicit duration of each finished video from the original human request. */
  readonly requestedDurationSeconds?: number
  /** Exact id explicitly selected in the original human request. */
  readonly requestedModel?: string
  readonly calls: readonly z.infer<typeof callSchema>[]
  readonly evidence: readonly z.infer<typeof evidenceSchema>[]
}

const grantSchema = requestSchema.omit({
  requestedResolution: true, requestedDurationSeconds: true, requestedModel: true, cancelled: true,
}).extend({
  schema: z.literal(1), callId: z.string().min(1), rootCallId: z.string().min(1),
  rootCallSeq: z.number().int().nonnegative().optional(),
  maxWorks: z.number().int().positive(),
}).strict()

/**
 * Validate optional private-record attribution without changing older v1 records.
 * @param value - Stored request attribution.
 * @returns A validated grant, undefined for old absence, or null for malformed data.
 */
export function parseVideoRequestGrant(value: unknown): VideoRequestGrant | undefined | null {
  if (value === undefined) return undefined
  const result = grantSchema.safeParse(value)
  if (!result.success) return null
  const { rootCallSeq, ...grant } = result.data
  return { ...grant, ...rootCallSeq === undefined ? {} : { rootCallSeq } }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function evidenceOf(
  content: readonly { type: string; text?: string }[], call: z.infer<typeof callSchema>,
): z.infer<typeof evidenceSchema> | undefined {
  if (call.name !== 'generate_video' && call.name !== 'generate_video_project') return undefined
  for (const block of content) {
    if (block.type !== 'text' || block.text === undefined) continue
    let value: unknown
    try { value = JSON.parse(block.text) } catch (_error) { continue }
    if (!record(value)) continue
    const operationId = typeof value.operation_id === 'string' && /^op_[A-Za-z0-9_-]+$/u.test(value.operation_id)
      ? value.operation_id : undefined
    const videoProjectId = typeof value.project_id === 'string' && /^vp_[a-f0-9-]{36}$/u.test(value.project_id)
      ? value.project_id : undefined
    if (operationId !== undefined || videoProjectId !== undefined) return {
      callId: call.callId, messageId: call.messageId,
      ...call.rootCallSeq === undefined ? {} : { rootCallSeq: call.rootCallSeq },
      ...operationId === undefined ? {} : { operationId }, ...videoProjectId === undefined ? {} : { videoProjectId },
    }
  }
  return undefined
}

/** Only a native generation result can revoke the request after its real selection card is cancelled. */
function cancelledModelChoice(content: readonly { type: string; text?: string }[], call: z.infer<typeof callSchema>): boolean {
  if (call.name !== 'generate_video' && call.name !== 'generate_video_project') return false
  return content.some((block) => {
    if (block.type !== 'text' || block.text === undefined) return false
    let value: unknown
    try { value = JSON.parse(block.text) } catch (_error) { return false }
    return record(value) && value.status === 'failed' && value.code === 'USER_CANCELLED'
  })
}

/** Existing-event fold; it adds no Session vocabulary or model-supplied authorization. */
export const videoGenerationIntentProjection = {
  key: 'videoGenerationIntent', stateVersion: 8, stateSchema,
  init: (_header, inherited) => ({ inherited, turn: 0, requests: [], calls: [], evidence: [] }),
  apply(state, event) {
    if (event.seq < state.inherited) return state
    if (event.type === 'turn/start') return { ...state, turn: event.data.turn }
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      const requestedResolution = humanVideoResolution(text)
      const requestedDurationSeconds = humanVideoDurationSeconds(text)
      const requestedModel = humanVideoModel(text)
      return { ...state, requests: [...state.requests, { messageId: event.data.id, sourceSeq: event.seq,
        maxWorks: videoWorkAllowance(text), turn: state.turn,
        ...requestedResolution === undefined ? {} : { requestedResolution },
        ...requestedDurationSeconds === undefined ? {} : { requestedDurationSeconds },
        ...requestedModel === undefined ? {} : { requestedModel } }] }
    }
    if (event.type === 'tool/call') {
      const request = state.requests.at(-1)
      return request === undefined ? state : { ...state, calls: [...state.calls,
        { callId: event.data.callId, messageId: request.messageId, name: event.data.name, rootCallSeq: event.seq,
          turn: event.data.turn, native: true }] }
    }
    if (event.type === 'tool/result') {
      const matching = state.calls.filter(call => call.callId === event.data.message.toolCallId)
      const call = event.sourceEventSeqs === undefined
        ? matching.length === 1 ? matching[0] : undefined
        : matching.findLast(call => call.rootCallSeq !== undefined
          && event.sourceEventSeqs?.some(seq => seq === call.rootCallSeq))
      if (call !== undefined && cancelledModelChoice(event.data.message.content, call)) {
        return { ...state, requests: state.requests.map(request => request.messageId === call.messageId
          ? { ...request, maxWorks: 0, cancelled: true } : request) }
      }
      const evidence = call === undefined ? undefined : evidenceOf(event.data.message.content, call)
      return evidence === undefined || state.evidence.some(item => item.callId === evidence.callId
        && item.rootCallSeq === evidence.rootCallSeq)
        ? state : { ...state, evidence: [...state.evidence, evidence] }
    }
    if (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') {
      const pending = state.calls.filter(call => call.callId === event.data.subCallId && call.name === event.data.name && call.pending)
      if (event.type === 'tool/ptc-dispatch' && pending.length > 1) return state
      const parent = state.calls.findLast(call => call.callId === event.data.parentCallId)
        ?? state.calls.findLast(call => call.callId === event.data.rootCallId)
      const started = event.type === 'tool/ptc-dispatch' ? pending[0] : undefined
      if (parent === undefined && started === undefined) return state
      const existing = started ?? state.calls.findLast(call => call.callId === event.data.subCallId
        && call.rootCallSeq === parent?.rootCallSeq)
      const attributed: z.infer<typeof callSchema> | undefined = existing ?? (parent === undefined ? undefined
        : { callId: event.data.subCallId, messageId: parent.messageId, name: event.data.name,
          ...parent.rootCallSeq === undefined ? {} : { rootCallSeq: parent.rootCallSeq },
          ...parent.turn === undefined ? {} : { turn: parent.turn } })
      if (attributed === undefined) return state
      const { pending: _pending, ...settled } = attributed
      const call = event.type === 'tool/ptc-dispatch-start' ? { ...settled, pending: true as const } : settled
      const calls = existing === undefined ? [...state.calls, call] : state.calls.map(value => value === existing ? call : value)
      if (event.type === 'tool/ptc-dispatch-start') return { ...state, calls }
      if (cancelledModelChoice(event.data.content, call)) return { ...state, calls,
        requests: state.requests.map(request => request.messageId === call.messageId
          ? { ...request, maxWorks: 0, cancelled: true } : request) }
      const evidence = evidenceOf(event.data.content, call)
      return { ...state, calls, evidence: evidence === undefined
        || state.evidence.some(item => item.callId === call.callId && item.rootCallSeq === call.rootCallSeq)
        ? state.evidence : [...state.evidence, evidence] }
    }
    return state
  },
} satisfies ProjectionDefinition<'videoGenerationIntent', VideoIntentState>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Original human video-work allowance and exact logged tool attribution. */
    videoGenerationIntent: VideoIntentState
  }
}

/**
 * Read the original human request owning this exact tool execution.
 * @param exec - Calling tool, including nested executions and their root call.
 * @returns Attributed work allowance, or absence when no trusted request is available.
 */
export function videoGenerationIntentOf(exec: ToolExecution): VideoGenerationIntent | undefined {
  const agent = exec.agent
  if (agent === undefined) return undefined
  const identity = executionOwners.get(agent.ctx.root)?.get(exec.token)
  if (identity === undefined) return undefined
  const state = agent.ctx.get('sessionProjections')?.stateOf(agent.session, 'videoGenerationIntent')
  const request = state?.requests.find(request => request.messageId === identity.messageId)
  if (state === undefined || request === undefined || request.maxWorks < 1) return undefined
  const requestedResolution = request.requestedResolution
  return { grant: { schema: 1, messageId: request.messageId, sourceSeq: request.sourceSeq,
    maxWorks: request.maxWorks, turn: request.turn, callId: exec.callId, rootCallId: exec.rootCallId, rootCallSeq: identity.rootCallSeq },
  ...requestedResolution === undefined ? {} : { requestedResolution },
  ...request.requestedDurationSeconds === undefined ? {} : { requestedDurationSeconds: request.requestedDurationSeconds },
  ...request.requestedModel === undefined ? {} : { requestedModel: request.requestedModel }, calls: state.calls, evidence: state.evidence }
}

/**
 * Preserve a real selection-card cancellation for this original human request across later tool calls.
 * @param exec - Current native generation call.
 * @returns Whether its attributed human request was explicitly cancelled.
 */
export function videoModelChoiceCancelled(exec: ToolExecution): boolean {
  const agent = exec.agent
  if (agent === undefined) return false
  const identity = executionOwners.get(agent.ctx.root)?.get(exec.token)
  if (identity === undefined) return false
  const state = agent.ctx.get('sessionProjections')?.stateOf(agent.session, 'videoGenerationIntent')
  return state?.requests.find(request => request.messageId === identity.messageId)?.cancelled === true
}

interface ExecutionOwner { readonly messageId: string; readonly rootCallSeq: number }
const executionOwners = new WeakMap<Context, Map<ToolExecutionToken, ExecutionOwner>>()

/**
 * Register durable request attribution and execution-token capture until each final result.
 * @param ctx - Owning credits-plugin context.
 */
export function registerVideoGenerationIntent(ctx: Context): void {
  ctx.inject(['sessionProjections'], (owner) => {
    owner.sessionProjections.register(videoGenerationIntentProjection)
    const owners = new Map<ToolExecutionToken, ExecutionOwner>()
    owner.effect(() => {
      executionOwners.set(owner.root, owners)
      return () => {
        owners.clear()
        if (executionOwners.get(owner.root) === owners) executionOwners.delete(owner.root)
      }
    })
    owner.on('tools/pre-execute', async (exec, next) => {
      const state = exec.agent === undefined ? undefined : owner.sessionProjections.stateOf(exec.agent.session, 'videoGenerationIntent')
      const call = exec.parent === undefined
        ? state?.calls.findLast(call => call.callId === exec.rootCallId && call.name === exec.name) : undefined
      const identity = exec.parent === undefined
        ? call?.rootCallSeq === undefined ? undefined : { messageId: call.messageId, rootCallSeq: call.rootCallSeq }
        : owners.get(exec.parent)
      if (identity !== undefined) owners.set(exec.token, identity)
      try { return await next() } catch (error) { owners.delete(exec.token); throw error }
    }, { prepend: true })
    owner.on('tools/result', (exec) => { owners.delete(exec.token) })
  })
}
