/** Model recovery before a human prompt is admitted to the Agent inbox. */
import type { Context } from '@deepseek-ai/cordis'
import {
  LlmError, effectiveTextCapability, textCapabilityImageAvailable, textCapabilityRouteAvailable,
} from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, RequestMessage } from '@deepseek-ai/dsh-llm'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { buildModelCatalog } from './catalog.ts'
import type { ModelSelection, PromptContentPart } from './types.ts'

/**
 * Stop awaiting metadata when its admission is cancelled; late results retain no commit permission.
 * @param operation - model or directory query, with its own late-completion guard.
 * @param signal - cancellation of the initiating admission.
 * @returns the query result or the caller's cancellation.
 */
export function awaitPromptModel<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort)
      const reason: unknown = signal.reason
      reject(reason instanceof Error ? reason : new LlmError('模型准备已取消。', 'ABORTED', { cause: reason }))
    }
    signal.addEventListener('abort', abort, { once: true })
    operation.then((value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error instanceof Error ? error : new LlmError('模型准备失败。', 'MODEL_PREPARATION_FAILED', { cause: error }))
      })
    if (signal.aborted) abort()
  })
}

/** Resolve the current model, retaining the admission errors for unsupported inputs. */
async function validatePromptModel(
  ctx: Context,
  selection: ModelSelection,
  content: readonly PromptContentPart[],
  history: readonly RequestMessage[],
  signal: AbortSignal | undefined,
  recovering = false,
): Promise<LlmResolvedModelInfo | undefined> {
  const hasImage = content.some(part => part.type === 'image')
  const model = hasImage || ctx.llm.listProviders().some(provider => provider.id === selection.provider)
    ? await ctx.llm.resolveModelInfo(selection.provider, selection.model, signal).catch((error: unknown) => {
      if (error instanceof LlmError && error.code === 'UNKNOWN_MODEL') {
        throw new RemoteError('session/model-unavailable', 'Select an available model before sending a message.',
          { provider: selection.provider, model: selection.model, reason: 'UNKNOWN_MODEL' })
      }
      throw error
    }) : undefined
  const capabilities = model?.textCapabilities
  const historyHasImages = recovering && history.some(message => message.content.some(part => part.type === 'image'))
  const historyHasFiles = recovering && history.some(message => message.content.some(part => part.type === 'file'))
  if (capabilities !== undefined) {
    if (!textCapabilityRouteAvailable(capabilities)) throw new RemoteError(
      'session/model-capability-invalid', '当前模型渠道暂不可用，请切换模型；文字草稿已保留。', { reason: 'MODEL_ROUTE_UNAVAILABLE' },
    )
    if ((hasImage || historyHasImages) && !textCapabilityImageAvailable(capabilities)) throw new RemoteError(
      'session/model-capability-invalid', '当前渠道图片输入暂不可用，请稍后重试或切换模型；草稿及已有附件已保留。',
      { reason: 'MODEL_CAPABILITY_INPUT_UNAVAILABLE' },
    )
    if (effectiveTextCapability(capabilities, 'tools') === false && history.some(message => message.role === 'tool'
      || message.role === 'assistant' && message.content.some(part => part.type === 'tool-call'))) {
      throw new RemoteError('session/model-capability-invalid', '当前模型渠道未开放此聊天所需的工具能力，请切换支持工具的模型，或新建纯文本聊天。',
        { reason: 'MODEL_CAPABILITY_HISTORY_UNSUPPORTED' })
    }
    if (content.some(part => part.type === 'image' && effectiveTextCapability(capabilities, 'vision') === false
      || part.type === 'file' && effectiveTextCapability(capabilities, 'tools') === false)
      || historyHasImages && effectiveTextCapability(capabilities, 'vision') === false
      || historyHasFiles && effectiveTextCapability(capabilities, 'tools') === false) {
      throw new RemoteError('session/model-capability-invalid', '当前模型渠道未开放所需的图片或文件能力，请移除附件或切换模型；文字草稿已保留。',
        { reason: 'MODEL_CAPABILITY_INPUT_UNSUPPORTED' })
    }
    if (recovering && !capabilities.stream) throw new RemoteError(
      'session/model-capability-invalid', '当前模型未开放流式对话。', { reason: 'MODEL_CAPABILITY_STREAM_UNSUPPORTED' },
    )
  }
  if ((hasImage || historyHasImages) && model?.inputModalities !== undefined && !model.inputModalities.includes('image')) {
    throw new RemoteError('session/attachment-invalid', `Model "${selection.model}" does not support image input.`,
      { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' })
  }
  if (recovering) await ctx.llm.resolveCallConfig({ provider: selection.provider, model: selection.model }, signal)
  return model
}

/** Additional constraints only for a gateway-proven, not-submitted model request. */
export interface PromptModelRecoveryConstraints {
  readonly confirmedUnavailable: { readonly provider: string; readonly model: string }
  readonly managedScope: string
  readonly inputPressure: (selection: Pick<ModelSelection, 'provider' | 'model'>, model: LlmResolvedModelInfo) => number
  readonly requireTools: boolean
}

function recoverable(error: unknown): boolean {
  const failure = remoteErrorOf(error)
  return failure?.code === 'session/model-unavailable' && failure.details.reason === 'UNKNOWN_MODEL'
    || failure?.code === 'session/model-capability-invalid' && failure.details.reason === 'MODEL_ROUTE_UNAVAILABLE'
}

function incompatible(error: unknown): boolean {
  const failure = remoteErrorOf(error)
  return failure?.code === 'session/model-unavailable' && failure.details.reason === 'UNKNOWN_MODEL'
    || failure?.code === 'session/model-capability-invalid'
    || failure?.code === 'session/attachment-invalid' && failure.details.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES'
}

/**
 * Keep a usable selection, or find a catalogued replacement after a confirmed pre-admission outage.
 * No model generation is performed and no global default or user preference is persisted.
 * @param ctx - Host registry and live model directory.
 * @param current - Session selection to preserve while it remains usable.
 * @param content - Exact incoming human content, including pending attachment descriptors.
 * @param history - Retained tool and image history whose requirements survive a model change.
 * @param signal - Cancellation for metadata and call configuration resolution.
 * @param assertCurrent - rejects cancellation or an account/credential change before any selection is committed.
 * @param constraints - source-request scope, capacity and tool requirements after a verified zero-send refusal.
 * @returns a replacement without the previous model's reasoning controls, or no change.
 */
export async function recoverPromptModel(
  ctx: Context,
  current: ModelSelection,
  content: readonly PromptContentPart[],
  history: readonly RequestMessage[],
  signal: AbortSignal | undefined,
  assertCurrent: () => void,
  constraints?: PromptModelRecoveryConstraints,
): Promise<Pick<ModelSelection, 'provider' | 'model'> | undefined> {
  assertCurrent()
  if (constraints === undefined) {
    try {
      await validatePromptModel(ctx, current, content, history, signal)
      assertCurrent()
      return undefined
    } catch (error) {
      assertCurrent()
      if (!recoverable(error)) throw error
    }
  }
  const catalog = await buildModelCatalog(ctx)
  assertCurrent()
  const sameProvider = catalog.groups.find(group => group.id === current.provider)
  const candidates = [catalog.default, ...(sameProvider?.models.map(model => ({ provider: sameProvider.id, model: model.id })) ?? [])]
  const visited = new Set<string>()
  let unresolved: Error | undefined
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.provider, candidate.model])
    if (visited.has(key)) continue
    visited.add(key)
    if (constraints?.confirmedUnavailable.provider === candidate.provider
      && constraints.confirmedUnavailable.model === candidate.model) continue
    const declared = catalog.groups.find(group => group.id === candidate.provider)?.models.find(model => model.id === candidate.model)
    if (declared === undefined || declared.executionCapabilities?.available === false
      || declared.inputModalities !== undefined && !declared.inputModalities.includes('text')) continue
    const selection = { provider: candidate.provider, model: candidate.model }
    try {
      const model = await validatePromptModel(ctx, selection, content, history, signal, true)
      assertCurrent()
      if (constraints !== undefined) {
        if (model?.limits?.managedScope !== constraints.managedScope
          || constraints.requireTools && effectiveTextCapability(model.textCapabilities, 'tools') === false) continue
        const input = model.context === undefined ? undefined
          : Math.min(model.context.contextWindow, model.textCapabilities?.maxInputTokens ?? Number.POSITIVE_INFINITY)
        if (input === undefined || input < constraints.inputPressure(selection, model)) continue
      }
      return current.provider === selection.provider && current.model === selection.model ? undefined : selection
    } catch (error) {
      assertCurrent()
      if (!incompatible(error)) unresolved ??= error instanceof Error ? error
        : new LlmError('模型准备失败。', 'MODEL_PREPARATION_FAILED', { cause: error })
    }
  }
  if (unresolved !== undefined) throw unresolved
  const relevantFailure = catalog.failures.find(failure => failure.id === current.provider
    || failure.id === catalog.default.provider)
  if (relevantFailure !== undefined) throw new RemoteError('session/provider-models-unavailable',
    '暂时无法读取当前账号的可用模型，请稍后重试；输入和附件已保留。', { provider: relevantFailure.id })
  throw new RemoteError('session/model-unavailable', '当前账号暂无可用的兼容文本模型，请稍后重试；输入和附件已保留。',
    { provider: current.provider, model: current.model, reason: 'NO_AVAILABLE_MODEL' })
}
