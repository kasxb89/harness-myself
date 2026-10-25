/** Real human execution sources and optional video parameter hints from existing Session events. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

const NUMBER = '(?:[1-9]\\d*|[一二两三四五六七八九十]+)'
const DURATION = `(?:(?:\\d+(?:\\.\\d+)?|${NUMBER})\\s*(?:秒钟?|s|分钟|min)\\s*的?\\s*)?`
const VIDEO_NOUN = '(?:短视频|带货视频|广告视频|动画视频|视频|短片|成片)'
const VIDEO = `(?:(?:MiniMax-H3|H3)\\s*)?${VIDEO_NOUN}`
const VIDEO_MODIFIER = '(?:[\\p{Script=Han}]|[23]D|\\s){0,16}?'
const POLITE_REQUEST = '(?:(?:能不能|可不可以|能否|可以|能)\\s*(?:帮我|给我|替我))'
const REQUEST_PREFIX = '(?:请|帮我|给我|麻烦|替我|直接|立即|现在|只|再|重新|另外|额外|分别'
  + `|${POLITE_REQUEST}|在(?:当前|这个)?(?:聊天|对话)(?:框)?(?:里|中))`
const CREATION_SOURCE = '(?:(?:用|使用|采用)\\s*[a-z][a-z0-9._/-]*'
  + '|(?:把|将|用|使用|根据|基于)\\s*(?:(?:这|那)(?:张|个)?|(?:我)?(?:上传|提供)的|已上传的)?(?:图(?:片)?|照片|参考图))'
const VERB = '(?:生成|制作|创作|做|输出|来|整)(?:出|成|给我)?\\s*'
const VIDEO_CONTENT = '(?:(?:视频|成片|短片)的)?(?:字幕|台词|对白|配乐|背景音乐|文字|水印|标题|音频|声音)'
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

function videoDescriptionContext(before: string): string {
  const directive = new RegExp('(?:^|[，,。；;！？!?])\\s*'
    + `(?:(?:${REQUEST_PREFIX}|然后|接着|同时|并且|按此提示词|按这个提示词|按以下提示词|根据此提示词`
    + `|${CREATION_SOURCE})\\s*)*(?:${VERB}|我(?:要|想要|需要)\\s*)`, 'iu')
  return before.split(directive).at(-1) ?? before
}

function isNonOutputVideoDescription(before: string, description: string): boolean {
  const context = videoDescriptionContext(before)
  const modifier = description.trim().replace(/^的\s*/u, '')
  return /参考|素材|片段|分镜|镜头|片名|标题|名字|名称|名为|名叫|叫作?/u.test(context)
    || /讲述|(?:故事|剧情|内容|画面)(?:为|是|写|描述|关于|[:：])/u.test(context)
    || /(?:字幕|台词|对白)(?:里|中)?\s*(?:写(?:成|着|上)?|为|是|内容(?:为|是)|设(?:置)?为|说|念|讲|唱|[:：])/u.test(context)
    || /参考|素材|片段|分镜|镜头/u.test(modifier)
    || /^(?:以前|之前|以后|之后|以内|之内|以外|以下|以上|前|后|内|外)(?:的|在|拍|发布|上传|录制|生成|制作|发生|已经|就|才|完成|结束|开始|$)/u.test(modifier)
}

function unquotedVideoRequest(text: string): string | undefined {
  const value = text.normalize('NFKC').replaceAll(/"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|《[^》]*》|`[^`]*`/gu, '')
  return /["'“”‘’「」『』《》`]/u.test(value) ? undefined : value
}

function withoutContentConstraints(text: string): string {
  return text.replaceAll(new RegExp('(?:不要|不需要|无需|不必|不用|别|勿)\\s*'
    + '(?:(?:生成|制作|创作|输出|做)\\s*)?(?:任何|额外的?|新的?)?'
    + `${VIDEO_CONTENT}(?!${VIDEO_NOUN})`, 'gu'), match => ' '.repeat(match.length))
}

/** Keep stop, query and non-generation prose out of optional video parameter hints. */
function humanVideoGenerationBlocked(text: string): boolean {
  const value = text.normalize('NFKC').trim()
  const request = unquotedVideoRequest(value) ?? value
  const primary = request.split(/[\n，,。；;]/u)[0] ?? ''
  const address = `^(?:${REQUEST_PREFIX}\\s*)*`
  const artifact = '(?:代码|脚本|提示词|说明|教程|示例|例子)'
  const noGeneration = new RegExp('(?:不要|不需要|无需|不必|不用|(?:先|暂时?)不|(?<![特分个性])别|勿)'
    + `(?:(?:${REQUEST_PREFIX}|继续|重复)\\s*)*(?:生成|制作|创作|重做`
    + `|(?:做|整|来)(?=\\s*(?:(?:${NUMBER})?\\s*(?:条|个|支)${DURATION}${VIDEO_MODIFIER}${VIDEO}`
    + `|(?:任何|新的?|额外的?)?${VIDEO})|\\s*$))`, 'gu')
  const awaitingGeneration = /(?:等|等待)我(?:确认|同意|批准)(?:(?:(?:之|以)?后)?[\s，,。；;]*(?:再|才)\s*(?:(?:开始|继续)\s*)?(?:生成|制作|创作)|\s*$)/gu
  const canceled = /(?:停止|取消)(?:本次|整个|所有)?(?:任务|视频|生成|创作)|(?:^|[\n，,。；;])\s*(?:停止|取消)[。！!]?$/gu
  const progress = new RegExp(`${VIDEO_NOUN}\\s*(?:(?:为什么|怎么|为何)\\s*(?:还|一直|总是|会|又|仍然)?\\s*`
    + '(?:没(?:有)?(?:好|生成|完成|反应|响应)|失败|报错|不成功|这么慢)|耗时多久|(?:还要|需要|要)多久)', 'gu')
  const outsideContent = (pattern: RegExp, source = request): boolean => [...source.matchAll(pattern)]
    .some((match) => {
      const before = request.slice(0, match.index).split(/[\n，,。；;]/u).at(-1) ?? ''
      return !isNonOutputVideoDescription(before, '') && !/关于|介绍|解释|演示/u.test(videoDescriptionContext(before))
    })
  if (outsideContent(noGeneration, withoutContentConstraints(request)) || outsideContent(awaitingGeneration)
    || outsideContent(canceled) || outsideContent(progress)) return true
  if (new RegExp(`${address}(?:翻译|改写|润色|解释|说明)`, 'u').test(primary)
    || new RegExp(`${address}(?:告诉我|看看|看一下|查看|查询|展示|播放|分析|解释|评价|检查|为什么|怎么|如何|示例|例如|假如|如果)`, 'u')
      .test(primary)
    || /哪个好|挑最好的|选(?:出)?最好的|^不是(?:要)?(?:生成|制作|做)/u.test(primary)
    || /^(?:please\s+)?(?:translate|rewrite|explain)\b/iu.test(primary)
    || /^(?:please\s+)?(?:show|read|check|inspect|analyse|analyze|tell|compare|play|review|what|why|how|which)\b/iu
      .test(primary)
    || /^(?:stop|cancel)[.!]?$/iu.test(primary)) return true
  const artifactRequest = new RegExp(`${address}(?:${CREATION_SOURCE}\\s*)?`
    + '(?:生成|制作|创作|新做|做|整|来|写|编写|提供|我要|我想要|继续(?:生成|制作)|补拍)'
    + `.*(?:${artifact}[.!！]?$|${VIDEO}的?${artifact})`, 'iu')
  const noEn = new RegExp(/^(?:please\s+)?(?:do not|don't|never|stop|cancel)\s+/u.source
    + /(?:re-?generate|generating|generate|re-?make|make|create|produce|render|start)\b/u.source, 'iu')
  return [...request.matchAll(/[^\n，,。；;]+/gu)].some(item => (artifactRequest.test(item[0]) || noEn.test(item[0].trim()))
    && !isNonOutputVideoDescription(request.slice(0, item.index), ''))
}

/**
 * Read one explicit duration per finished video without treating clip lengths as output lengths.
 * @param text - Original human text, never a plan or model arguments.
 * @returns Duration in seconds, or absence when missing, negated, quoted, or conflicting.
 */
export function humanVideoDurationSeconds(text: string): number | undefined {
  const value = text.normalize('NFKC')
  if (humanVideoGenerationBlocked(value)) return undefined
  const unquoted = unquotedVideoRequest(value)
  if (unquoted === undefined) return undefined
  const clauses = [...unquoted.matchAll(/[^，,。；;\n]+/gu)]
  const affirmative = clauses.map(item => item[0]).join(' ')
  if (/或|还是|比较|对比|最多|至少|至多|多于|少于|超过/u.test(affirmative)
    || /(?<![a-z0-9._/])[0-9一二两三四五六七八九十]+\s*(?:秒钟?|s|分钟|min)?\s*(?:到|至|[-~～—])\s*[0-9一二两三四五六七八九十]+\s*(?:秒钟?|s\b|分钟|min\b)/iu
      .test(affirmative)) return undefined
  const amount = `(?:\\d+(?:\\.\\d+)?|${NUMBER})`
  const units = '(?:秒钟?|seconds?|secs?|s|分钟|min(?:ute)?s?)'
  const duration = `(?<![0-9a-z.+一二两三四五六七八九十百千万亿零-])(${amount})\\s*(${units})`
  const prefix = new RegExp(`${duration}\\s*的?\\s*(${VIDEO_MODIFIER})${VIDEO}`, 'giu')
  const specified = new RegExp('(?:每(?:条|个|支)(?:视频)?|(?:视频|成片|全片)(?:的)?(?:总)?时长|总时长|片长)'
    + `\\s*(?:为|是|[:：])?\\s*${duration}`, 'giu')
  const seconds = clauses.flatMap(item => [...item[0].matchAll(prefix), ...item[0].matchAll(specified)].flatMap((match) => {
    if (isNonOutputVideoDescription(unquoted.slice(0, item.index + match.index), match[3] ?? '')) return []
    const negation = /不要|不需|无需|不用|(?<!分)别|勿|而非|不是/u.exec(withoutContentConstraints(item[0]))
    if (negation !== null && negation.index <= match.index) return []
    const raw = match[1]
    const unit = match[2]
    if (raw === undefined || unit === undefined) return []
    const amount = /^[0-9]/u.test(raw) ? Number(raw) : countOf(raw)
    if (amount === undefined || !Number.isFinite(amount) || amount <= 0) return [NaN]
    return [amount * (/^(?:分|min)/iu.test(unit) ? 60 : 1)]
  }))
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
  if (humanVideoGenerationBlocked(value)) return undefined
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
  if (humanVideoGenerationBlocked(value)) return undefined
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
  turn: z.number().int().nonnegative(),
  requestedResolution: z.string().min(1).optional(),
  requestedDurationSeconds: z.number().positive().optional(),
  requestedModel: z.string().min(1).optional(),
}).strict()
const callSchema = z.object({ callId: z.string().min(1), messageId: z.string().min(1), name: z.string(),
  rootCallSeq: z.number().int().nonnegative().optional(), turn: z.number().int().nonnegative().optional(),
  native: z.literal(true).optional(), pending: z.literal(true).optional(), cancelled: z.literal(true).optional() }).strict()
const evidenceSchema = z.object({
  callId: z.string().min(1), messageId: z.string().min(1),
  rootCallSeq: z.number().int().nonnegative().optional(),
  operationId: z.string().optional(), videoProjectId: z.string().optional(),
}).strict()
const continuedQuestionSchema = z.object({
  callId: z.string().min(1), messageId: z.string().min(1), rootCallSeq: z.number().int().nonnegative(),
}).strict()
const humanRevisionSchema = z.object({ messageId: z.string().min(1), seq: z.number().int().nonnegative() }).strict()
const stateSchema = z.object({
  inherited: z.number().int().nonnegative(), delegated: z.boolean(), turn: z.number().int().nonnegative(),
  activeMessageId: z.string().min(1).optional(),
  activeHumanRevision: humanRevisionSchema.optional(),
  nativeHeads: z.array(z.object({ callId: z.string(), name: z.string(), seq: z.number().int().nonnegative() })),
  requests: z.array(requestSchema), calls: z.array(callSchema), evidence: z.array(evidenceSchema),
  continuedQuestions: z.array(continuedQuestionSchema),
  continuationMessageId: z.string().min(1).optional(),
}).strict()
type VideoIntentState = z.infer<typeof stateSchema>

/** Private v1 attribution of a concrete execution to its real human source. */
export interface VideoRequestGrant {
  readonly schema: 1
  readonly messageId: string
  readonly sourceSeq: number
  /** Legacy private-record field; current execution sources do not impose a work-count limit. */
  readonly maxWorks?: number
  readonly turn: number
  readonly callId: string
  readonly rootCallId: string
  /** Exact native tool/call event; older private records may omit it. */
  readonly rootCallSeq?: number
}

/** Same-process request attribution plus existing logged operation evidence. */
export interface VideoGenerationIntent {
  readonly grant: VideoRequestGrant
  /** Exact real human event captured for this execution, including a late answer to its original request. */
  readonly humanRevision?: { readonly messageId: string; readonly seq: number }
  /** Unambiguous output tier from the human request or its related follow-up, never model arguments. */
  readonly requestedResolution?: string
  /** Explicit duration per finished video from the human request or its related follow-up. */
  readonly requestedDurationSeconds?: number
  /** Exact id explicitly selected by the human in the request or its related follow-up. */
  readonly requestedModel?: string
  readonly calls: readonly z.infer<typeof callSchema>[]
  readonly evidence: readonly z.infer<typeof evidenceSchema>[]
}

const grantSchema = requestSchema.omit({
  requestedResolution: true, requestedDurationSeconds: true, requestedModel: true,
}).extend({
  schema: z.literal(1), callId: z.string().min(1), rootCallId: z.string().min(1),
  rootCallSeq: z.number().int().nonnegative().optional(),
  maxWorks: z.number().int().positive().optional(),
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
  const { rootCallSeq, maxWorks, ...grant } = result.data
  return { ...grant, ...rootCallSeq === undefined ? {} : { rootCallSeq },
    ...maxWorks === undefined ? {} : { maxWorks } }
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

/** A real generation selection cancellation belongs only to its exact logged call. */
function cancelledModelChoice(content: readonly { type: string; text?: string }[], call: z.infer<typeof callSchema>): boolean {
  if (call.name !== 'generate_video' && call.name !== 'generate_video_project') return false
  return content.some((block) => {
    if (block.type !== 'text' || block.text === undefined) return false
    let value: unknown
    try { value = JSON.parse(block.text) } catch (_error) { return false }
    return record(value) && value.status === 'failed' && value.code === 'USER_CANCELLED'
  })
}

/** Only the real pending question result can make a later human answer continue its owning request. */
function pendingQuestion(
  content: readonly { type: string; text?: string }[], call: z.infer<typeof callSchema>,
): z.infer<typeof continuedQuestionSchema> | undefined {
  if (call.name !== 'ask_user_question' || call.rootCallSeq === undefined) return undefined
  for (const block of content) {
    if (block.type !== 'text' || block.text === undefined) continue
    let value: unknown
    try { value = JSON.parse(block.text) } catch (_error) { continue }
    if (record(value) && value.pending === true && value.callId === call.callId) {
      return { callId: call.callId, messageId: call.messageId, rootCallSeq: call.rootCallSeq }
    }
  }
  return undefined
}

function retainPendingQuestion(
  state: VideoIntentState, question: z.infer<typeof continuedQuestionSchema> | undefined,
): VideoIntentState['continuedQuestions'] {
  return question === undefined || state.continuedQuestions.some(value => value.callId === question.callId
    && value.rootCallSeq === question.rootCallSeq) ? state.continuedQuestions : [...state.continuedQuestions, question]
}

type VideoFollowup = Partial<Pick<z.infer<typeof requestSchema>,
  'requestedResolution' | 'requestedDurationSeconds' | 'requestedModel'>>

/** Recognized parameter replies inherit optional hints without reusing the prior human source. */
function humanVideoFollowup(text: string): VideoFollowup | undefined {
  const value = text.normalize('NFKC').trim().replace(/[。.!！?？]+$/u, '')
  if (value === '' || humanVideoGenerationBlocked(text)) return undefined
  const clauses = value.split(/[，,。；;\n]/u).map(clause => clause.trim()).filter(Boolean)
  const result: VideoFollowup = {}
  for (const clause of clauses) {
    const action = clause.replace(/^(?:好的?|可以|行|嗯|那就|没问题|确认了?)\s*/u, '')
    if (action === '' || /^(?:开始(?:生成|制作)?|继续|接着|(?:我)?(?:确认|确定|同意)(?:生成|制作)?|是的|对的?|没错|就这样|谢谢|辛苦了)(?:吧|了|一下)?$/u.test(action)
      || /^(?:继续|接着)(?:生成|制作)?(?:这个|这条|原来的?|刚才的?)?(?:视频|成片|作品)(?:吧)?$/u.test(action)
      || /^(?:就)?按(?:刚才|之前|上面|这个|原来|已确认)的?(?:方案|计划|要求|提示词)(?:来|做|生成|制作|继续|执行|开始)?(?:吧)?$/u.test(action)
      || /^(?:生成|制作|创作)(?:剩余|剩下|未完成)的?.*(?:视频|分镜|片段)$/u.test(action)) {
      continue
    }
    const parameter = action.replace(/^(?:改成|改为|调整为|设置为|换成|就做|总共做|一共做)\s*/u, '')
    const duration = new RegExp('^(?:(?:视频|成片)?(?:总时长|时长|片长|长度)(?:为|是|[:：])?\\s*)?'
      + `((?:\\d+(?:\\.\\d+)?|${NUMBER})\\s*(?:秒钟?|s|分钟|min))(?:的?(?:视频|成片))?$`, 'iu').exec(parameter)
    if (duration !== null) {
      const seconds = humanVideoDurationSeconds(`生成${duration[1] ?? ''}视频`)
      if (seconds === undefined) return undefined
      result.requestedDurationSeconds = seconds
      continue
    }
    const tier = parameter.replace(/^(?:横屏|竖屏|方形)\s*/u, '')
    if (/^(?:(?:分辨率|画质|清晰度)(?:为|是|[:：])?\s*)?(?:\d+[pk]|\d+\s*[x×]\s*\d+)$/iu.test(tier)) {
      const resolution = humanVideoResolution(`生成视频，${tier}`)
      if (resolution === undefined) return undefined
      result.requestedResolution = resolution
      continue
    }
    const bareModel = /^(?:MiniMax-H3|H3|[a-z][a-z0-9._/-]*[0-9._/-][a-z0-9._/-]*)$/iu.test(action)
    const selectedModel = bareModel ? `使用${action}` : action
    const modelSelection = /^(?:改用|使用|采用|换成|改成|用|就用|模型)\s*(?:为|是|[:：])?\s*([a-z][a-z0-9._/-]*)$/iu.exec(selectedModel)
    if (modelSelection !== null) {
      const model = humanVideoModel(`生成视频，使用${modelSelection[1] ?? ''}`)
      if (model === undefined) return undefined
      result.requestedModel = model
      continue
    }
    if (/^(?:横屏|竖屏|方形|[0-9]+\s*[:：]\s*[0-9]+|分成|每段|每个镜头|分镜|镜头|风格|画风|色调|场景|人物|配音|字幕|台词|不要(?:生成)?字幕|无字幕)/u.test(parameter)) {
      continue
    }
    return undefined
  }
  return result
}

/** External asynchronous notifications cannot continue the current human's generation call. */
function isExternalNotice(kind: string): boolean { return kind === 'agent-message' || kind === 'tool-jobs' }

/** Existing-event fold; it adds no Session vocabulary or model-supplied authorization. */
export const videoGenerationIntentProjection = {
  key: 'videoGenerationIntent', stateVersion: 13, stateSchema,
  init: (header, inherited) => ({ inherited, delegated: header.origin === 'subagent', turn: 0,
    nativeHeads: [], requests: [], calls: [], evidence: [], continuedQuestions: [] }),
  apply(state, event) {
    if (event.seq < state.inherited || state.delegated) return state
    if (event.type === 'turn/start') return { ...state, turn: event.data.turn, activeMessageId: undefined, activeHumanRevision: undefined }
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      const prior = state.requests.findLast(request => request.messageId === state.continuationMessageId)
      const followup = prior === undefined ? undefined : humanVideoFollowup(text)
      const requestedResolution = humanVideoResolution(text) ?? followup?.requestedResolution
        ?? (followup === undefined ? undefined : prior?.requestedResolution)
      const requestedDurationSeconds = humanVideoDurationSeconds(text) ?? followup?.requestedDurationSeconds
        ?? (followup === undefined ? undefined : prior?.requestedDurationSeconds)
      const requestedModel = humanVideoModel(text) ?? followup?.requestedModel
        ?? (followup === undefined ? undefined : prior?.requestedModel)
      return { ...state, activeMessageId: event.data.id, continuationMessageId: event.data.id,
        activeHumanRevision: { messageId: event.data.id, seq: event.seq },
        requests: [...state.requests, { messageId: event.data.id, sourceSeq: event.seq, turn: state.turn,
          ...requestedResolution === undefined ? {} : { requestedResolution },
          ...requestedDurationSeconds === undefined ? {} : { requestedDurationSeconds },
          ...requestedModel === undefined ? {} : { requestedModel } }] }
    }
    if (event.type === 'user/message' && event.data.source.kind === 'user-question-reply') {
      const callId = event.data.source.callId
      const matching = state.continuedQuestions.filter(question => question.callId === callId)
      const question = matching.length === 1 ? matching[0] : undefined
      const request = state.requests.findLast(request => request.messageId === question?.messageId)
      return { ...state,
        ...(question !== undefined && request !== undefined && state.continuationMessageId === request.messageId
          ? { activeMessageId: request.messageId, activeHumanRevision: { messageId: event.data.id, seq: event.seq } } : {}),
        continuedQuestions: state.continuedQuestions.filter(question => question.callId !== callId) }
    }
    if (event.type === 'user/message' && isExternalNotice(event.data.source.kind)) {
      return { ...state, activeMessageId: undefined, activeHumanRevision: undefined }
    }
    if (event.type === 'tool/call') {
      const nativeHeads = [...state.nativeHeads.filter(head => head.callId !== event.data.callId),
        { callId: event.data.callId, name: event.data.name, seq: event.seq }]
      const request = state.requests.findLast(request => request.messageId === state.activeMessageId
        && state.turn === event.data.turn)
      return request === undefined ? { ...state, nativeHeads } : { ...state, nativeHeads, calls: [...state.calls,
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
        return { ...state, calls: state.calls.map(value => value === call ? { ...value, cancelled: true } : value) }
      }
      const evidence = call === undefined ? undefined : evidenceOf(event.data.message.content, call)
      const continuedQuestions = retainPendingQuestion(state, call === undefined || event.data.message.isError
        ? undefined : pendingQuestion(event.data.message.content, call))
      const nextEvidence = evidence === undefined || state.evidence.some(item => item.callId === evidence.callId
        && item.rootCallSeq === evidence.rootCallSeq) ? state.evidence : [...state.evidence, evidence]
      return continuedQuestions === state.continuedQuestions && nextEvidence === state.evidence ? state
        : { ...state, evidence: nextEvidence, continuedQuestions }
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
      if (cancelledModelChoice(event.data.content, call)) return { ...state,
        calls: calls.map(value => value === call ? { ...value, cancelled: true } : value) }
      const evidence = evidenceOf(event.data.content, call)
      return { ...state, calls,
        continuedQuestions: retainPendingQuestion(state, event.data.isError ? undefined : pendingQuestion(event.data.content, call)),
        evidence: evidence === undefined
          || state.evidence.some(item => item.callId === call.callId && item.rootCallSeq === call.rootCallSeq)
          ? state.evidence : [...state.evidence, evidence] }
    }
    return state
  },
} satisfies ProjectionDefinition<'videoGenerationIntent', VideoIntentState>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Real human execution sources, optional video hints and exact logged tool attribution. */
    videoGenerationIntent: VideoIntentState
  }
}

/**
 * Check whether this execution was captured under a logged human request.
 * @param exec - Native execution or nested PTC execution with its opaque parent token.
 * @returns Real human ownership; delegated agents and tool or peer messages cannot create it.
 */
export function hasCurrentHumanRequest(exec: ToolExecution): boolean {
  const agent = exec.agent
  if (agent === undefined || delegatedAgent(agent)) return false
  const identity = executionOwners.get(agent.ctx.root)?.get(exec.token)
  if (identity === undefined) return false
  const state = agent.ctx.get('sessionProjections')?.stateOf(agent.session, 'videoGenerationIntent')
  return state?.requests.some(request => request.messageId === identity.messageId) === true
}

/**
 * Read the original human request owning this exact tool execution.
 * @param exec - Calling tool, including nested executions and their root call.
 * @returns Real execution source with optional parameter hints, or absence for non-human execution.
 */
export function videoGenerationIntentOf(exec: ToolExecution): VideoGenerationIntent | undefined {
  const agent = exec.agent
  if (agent === undefined || delegatedAgent(agent)) return undefined
  const identity = executionOwners.get(agent.ctx.root)?.get(exec.token)
  if (identity === undefined) return undefined
  const state = agent.ctx.get('sessionProjections')?.stateOf(agent.session, 'videoGenerationIntent')
  const request = state?.requests.find(request => request.messageId === identity.messageId)
  if (state === undefined || request === undefined) return undefined
  const requestedResolution = request.requestedResolution
  return { grant: { schema: 1, messageId: request.messageId, sourceSeq: request.sourceSeq,
    turn: request.turn, callId: exec.callId, rootCallId: exec.rootCallId, rootCallSeq: identity.rootCallSeq },
  ...identity.humanRevision === undefined ? {} : { humanRevision: identity.humanRevision },
  ...requestedResolution === undefined ? {} : { requestedResolution },
  ...request.requestedDurationSeconds === undefined ? {} : { requestedDurationSeconds: request.requestedDurationSeconds },
  ...request.requestedModel === undefined ? {} : { requestedModel: request.requestedModel }, calls: state.calls, evidence: state.evidence }
}

/**
 * Read a real selection-card cancellation for this exact logged generation call.
 * @param exec - Current generation execution, including an attributed PTC dispatch.
 * @returns Whether this call was cancelled; other works from the same source remain independent.
 */
export function videoModelChoiceCancelled(exec: ToolExecution): boolean {
  const agent = exec.agent
  if (agent === undefined || delegatedAgent(agent)) return false
  const identity = executionOwners.get(agent.ctx.root)?.get(exec.token)
  if (identity === undefined) return false
  const state = agent.ctx.get('sessionProjections')?.stateOf(agent.session, 'videoGenerationIntent')
  return state?.calls.some(call => call.callId === exec.callId && call.rootCallSeq === identity.rootCallSeq
    && call.cancelled === true) === true
}

function delegatedAgent(agent: Agent): boolean {
  if (agent.session.header.origin === 'subagent') return true
  const registry = agent.ctx.get('agents')
  if (registry === undefined) return false
  return registry.list().some(parent => registry.isOwnedBy(agent.id, parent))
}

interface ExecutionOwner {
  readonly messageId: string
  readonly rootCallSeq: number
  readonly humanRevision?: { readonly messageId: string; readonly seq: number }
}
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
      const state = exec.agent === undefined || delegatedAgent(exec.agent) ? undefined
        : owner.sessionProjections.stateOf(exec.agent.session, 'videoGenerationIntent')
      const logged = exec.parent === undefined ? state?.nativeHeads.findLast(head =>
        head.callId === exec.rootCallId && head.name === exec.name) : undefined
      const call = logged === undefined ? undefined : state?.calls.findLast(call => call.rootCallSeq === logged.seq)
      const humanRevision = state?.activeMessageId === call?.messageId ? state?.activeHumanRevision : undefined
      const identity = exec.parent === undefined
        ? call?.rootCallSeq === undefined || call.turn !== state?.turn ? undefined
          : { messageId: call.messageId, rootCallSeq: call.rootCallSeq,
            ...humanRevision === undefined ? {} : { humanRevision: { ...humanRevision } } }
        : exec.agent === undefined || delegatedAgent(exec.agent) ? undefined : owners.get(exec.parent)
      if (identity !== undefined) owners.set(exec.token, identity)
      try { return await next() } catch (error) { owners.delete(exec.token); throw error }
    }, { prepend: true })
    owner.on('tools/result', (exec) => { owners.delete(exec.token) })
  })
}
