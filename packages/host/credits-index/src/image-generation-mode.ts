/** Image input mode validation before reserving or submitting paid work. @module */
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { CreativeError } from './creative-store.ts'
import { videoGenerationIntentOf } from './video-generation-intent.ts'
import type {} from './media-request-selection.ts'
import type { ImageParams, ModelCapability } from './media.ts'
import { imageSpecifications } from './media-request-specification.ts'

/** Public input modes are separate from provider-specific quality controls. */
export type ImageGenerationMode = 'text-to-image' | 'image-to-image'

/**
 * Publish only input modes executable through the selected image route and declared controls.
 * @param model - One image capability from the account-authorized catalog.
 * @returns Supported public input modes; an edits-only route never offers text generation.
 */
export function imageGenerationModes(model: ModelCapability): readonly ImageGenerationMode[] {
  const params = model.params as ImageParams
  const standard = model.route === '/v1/images/generations' || model.route === '/v1/images/edits'
  const editing = (standard || model.id === 'yunshu-internal-gpt-image-2') && params.maxEdits > 0
    && imageSpecifications(params, true)?.length !== 0
  return [...model.route === '/v1/images/edits' || params.specifications?.length === 0 ? [] : ['text-to-image' as const],
    ...editing ? ['image-to-image' as const] : []]
}

function humanEditingChoice(text: string): boolean | undefined {
  const clauses = text.normalize('NFKC')
    .replaceAll(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』|《[^》\n]*》|`[^`\n]*`/gu, '')
    .split(/[，,。；;\n]/u)
  if (!clauses.some(clause => /图生图/u.test(clause))) return undefined
  const modes = clauses.filter(clause => !/不要|不需要|无需|不用|而非|不是/u.test(clause)).flatMap((clause) => {
    const instruction = clause.replace(/^\s*(?:(?:请|帮我|这次|我要)\s*)*/u, '')
    return [...instruction.matchAll(
      /(?:^|先|再|然后|接着|随后|之后|后)\s*(?:(?:用|使用|采用)\s*)?(文生图|图生图)(?=\s*(?:$|生成|制作|创作|输出|绘制|画|处理|编辑|修改|重绘|改|调整|做|换|把|将|先|再|然后|接着|随后|之后|后))/gu,
    )]
      .map(match => match[1])
  })
  return modes.includes('图生图') && !modes.includes('文生图')
}

function humanRequestsImageEditing(exec: ToolExecution | undefined): boolean {
  if (exec === undefined) return false
  const intent = videoGenerationIntentOf(exec)
  const state = exec.agent?.ctx.get('sessionProjections')?.stateOf(exec.agent.session, 'mediaRequestSelections')
  if (intent === undefined || state === undefined) return false
  const human = state.humans.find(value => value.seq === intent.grant.sourceSeq)
  const revision = intent.humanRevision === undefined ? undefined : state.humans.find(value => value.seq === intent.humanRevision?.seq)
  return (revision === undefined ? undefined : humanEditingChoice(revision.text))
    ?? (human === undefined ? undefined : humanEditingChoice(human.text)) ?? false
}

/**
 * Require real references for an explicit edit and reject contradictory text-only controls.
 * @param requested - Optional public generation_mode from the tool or panel JSON.
 * @param referenceCount - Number of supplied reference images; actual bytes are validated separately.
 * @param exec - Exact logged human execution; absent for panel requests.
 * @returns Explicit or reference-derived input mode without selecting any image.
 */
export function imageGenerationMode(
  requested: unknown, referenceCount: number, exec?: ToolExecution,
): ImageGenerationMode {
  if (requested !== undefined && requested !== 'text-to-image' && requested !== 'image-to-image') {
    throw new CreativeError('IMAGE_GENERATION_MODE_NOT_SUPPORTED', 400, '图片生成模式须为文生图或图生图；尚未提交生成。')
  }
  if (referenceCount === 0 && (requested === 'image-to-image' || humanRequestsImageEditing(exec))) {
    throw new CreativeError('IMAGE_REFERENCE_REQUIRED', 400,
      '图生图需要传入真实参考图，请在 reference_images 中补充当前聊天图片或授权图片引用；尚未提交生成。')
  }
  if (referenceCount > 0 && requested === 'text-to-image') {
    throw new CreativeError('IMAGE_GENERATION_MODE_CONFLICT', 400,
      '文生图模式不能携带参考图，请按本次要求选择图生图模式；尚未提交生成。')
  }
  return referenceCount > 0 ? 'image-to-image' : 'text-to-image'
}
