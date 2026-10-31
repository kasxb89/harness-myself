/** Account-bound text-model capabilities applied before prompt admission and tool dispatch. @module */
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { cloneTextCapabilities, effectiveTextCapability, textCapabilityImageAvailable, textCapabilityRouteAvailable, isAgentLoopRequest, LlmError, type LlmTextCapabilities, type RequestMessage } from '@deepseek-ai/dsh-llm'

const capabilityContextName = 'product-model-capabilities'
const toolDenial = '当前渠道不可执行工具；请切换到可用的模型后重试。'

interface CapturedPolicy {
  readonly provider: string
  readonly model: string
  readonly revision: number
  readonly capabilities?: LlmTextCapabilities
}

/** Synchronous login revision supplied by the account owner, without retaining credentials. */
export interface ProductTextModelPolicyOptions {
  /** @returns Current local account generation; a changed value invalidates an unsubmitted request. */
  readonly revision: () => number
}


function hasToolHistory(messages: readonly RequestMessage[]): boolean {
  return messages.some(message => message.role === 'tool'
    || message.role === 'assistant' && message.content.some(block => block.type === 'tool-call'))
}

function hasUnsupportedBinaryInput(messages: readonly RequestMessage[], capabilities: LlmTextCapabilities): boolean {
  return messages.some(message => message.content.some(block => block.type === 'image' && effectiveTextCapability(capabilities, 'vision') === false
    || block.type === 'file' && effectiveTextCapability(capabilities, 'tools') === false))
}

function capabilityNotice(value: LlmTextCapabilities): string {
  if (value.schemaVersion === 2) {
    const facts = [`Gateway input ceiling: ${String(value.maxInputTokens)} tokens.`]
    for (const feature of ['tools', 'vision', 'reasoning'] as const) {
      const status = value.verification?.[feature] ?? 'unverified'
      facts.push(`This route's ${feature} verification: ${status}.`)
      if (status === 'unverified') facts.push(`Do not describe ${feature} as unsupported or verified; evidence is pending.`)
      if (effectiveTextCapability(value, feature) === false) facts.push(`${feature} execution is unavailable on this route; suggest a compatible route when needed.`)
    }
    if (value.reasoningMode === 'always_on') facts.push('Reasoning is always on; no off control is offered. Declared effort settings only adjust strength. Auto omits all reasoning controls.')
    if (value.reasoningMode === 'automatic') facts.push('Reasoning is automatic; no on/off or effort setting is offered.')
    if (!textCapabilityImageAvailable(value)) facts.push('Image input is temporarily unavailable on this route; text, tools and file handles remain independently available. This is not evidence that the model lacks vision.')
    if (!textCapabilityRouteAvailable(value)) facts.push('The fixed route is temporarily unavailable; this does not establish missing model capabilities.')
    return facts.join('\n')
  }
  const facts = [`Gateway input ceiling: ${String(value.maxInputTokens)} tokens.`]
  if (!value.tools && !value.vision) facts.push('This gateway currently permits text conversation only; these legacy flags describe execution policy, not verified native support.')
  if (!value.tools) facts.push('Tools, file operations and artifact generation are disabled on this gateway route. '
    + 'When the user requests an operation requiring tools, explain briefly that they can switch to a tool-capable model. '
    + 'Do not claim to have executed tools or produced files.')
  if (!value.vision) facts.push(value.tools ? 'Image input is unavailable; do not claim to have inspected images.'
    : 'Image and file input is unavailable; do not claim to have inspected attachments.')
  if (!value.reasoning) facts.push('Configurable reasoning is disabled on this gateway route.')
  return facts.join('\n')
}

function changed(): LlmError {
  return new LlmError('模型能力或登录状态已变化，本次尚未发送；请确认当前模型后重试。', 'MODEL_CAPABILITIES_CHANGED')
}

function assertSupportedInput(policy: CapturedPolicy, history: readonly RequestMessage[], incoming: readonly RequestMessage[]): void {
  const capabilities = policy.capabilities
  if (capabilities === undefined) return
  if (!textCapabilityRouteAvailable(capabilities)) throw new LlmError(
    '当前渠道暂不可用，请稍后重试或切换模型。', 'MODEL_ROUTE_UNAVAILABLE')
  if (!textCapabilityImageAvailable(capabilities) && [...history, ...incoming].some(message => message.content.some(block => block.type === 'image'))) throw new LlmError(
    '当前渠道的图片输入暂不可用，请稍后重试或切换模型。', 'MODEL_CAPABILITY_INPUT_UNAVAILABLE')
  if (effectiveTextCapability(capabilities, 'tools') === false && hasToolHistory(history)) throw new LlmError(
    '当前聊天包含工具记录，而所选渠道未开放工具调用；请切换可用模型，或新建纯文本聊天。原记录已保留。',
    'MODEL_CAPABILITY_HISTORY_UNSUPPORTED',
  )
  if (hasUnsupportedBinaryInput(history, capabilities) || hasUnsupportedBinaryInput(incoming, capabilities)) throw new LlmError(
    '当前模型不支持聊天中的图片或文件；请移除本次附件、切换支持附件的模型，或新建纯文本聊天。',
    'MODEL_CAPABILITY_INPUT_UNSUPPORTED',
  )
  if (!capabilities.stream) throw new LlmError('当前模型不支持本客户端的流式对话，请选择其他模型。',
    'MODEL_CAPABILITY_STREAM_UNSUPPORTED')
}

/**
 * Couple the selected model's declared capabilities to logged prompts and actual tool execution.
 * Requests without a declaration retain their existing behavior. A captured route applies to its
 * complete step; a later selection takes effect at the next assembly instead of changing an
 * already admitted request. Accepted background tasks are never cancelled by this policy.
 * @param ctx - Credits plugin context owning every registration and its disposal.
 * @param options - Account owner's synchronous revision, checked around asynchronous metadata reads.
 */
export function registerProductTextModelPolicy(ctx: Context, options: ProductTextModelPolicyOptions): void {
  ctx.inject(['systemPrompt', 'tools', 'llm'], (policyCtx) => {
    const policies = new WeakMap<Agent, CapturedPolicy>()
    let active = true
    policyCtx.effect(() => () => { active = false }, 'product text capability lifetime')
    const metadata = async (provider: string, model: string, signal?: AbortSignal): Promise<LlmTextCapabilities | undefined> => {
      try { return (await policyCtx.llm.resolveModelInfo(provider, model, signal)).textCapabilities }
      catch (error) {
        // A middleware-owned legacy route can legitimately have no registered adapter.
        if (error instanceof LlmError && error.code === 'NO_ADAPTER') return undefined
        throw error
      }
    }

    // The registered required name also retains the post-resolution value when optional contexts are suppressed.
    policyCtx.systemPrompt.context({ name: capabilityContextName,
      order: policyCtx.systemPrompt.getContextOrder('APPROVAL_POLICY'), required: true, text: (context) => {
        const capabilities = context.agent === undefined ? undefined : policies.get(context.agent)?.capabilities
        return capabilities === undefined ? '' : capabilityNotice(capabilities)
      } })
    policyCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      const agent = context.agent
      if (agent === undefined) return assembled
      const provider = assembled.variables.provider ?? agent.options.provider
      const model = assembled.variables.model ?? agent.options.model
      if (!provider || !model) { policies.delete(agent); return assembled }
      const revision = options.revision()
      const resolved = await metadata(provider, model, context.signal)
      if (revision !== options.revision() || !active && resolved !== undefined) throw changed()
      const capabilities = resolved === undefined ? undefined : cloneTextCapabilities(resolved)
      policies.set(agent, { provider, model, revision, ...capabilities === undefined ? {} : { capabilities } })
      if (capabilities === undefined) {
        const contexts = assembled.contexts.filter(context => context.name !== capabilityContextName)
        return contexts.length === assembled.contexts.length ? assembled : { ...assembled, contexts }
      }
      return {
        ...assembled,
        tools: effectiveTextCapability(capabilities, 'tools') === false ? [] : assembled.tools,
        sections: effectiveTextCapability(capabilities, 'tools') !== false ? assembled.sections : assembled.sections.filter(section =>
          section.name !== 'tools:sdk' && section.name !== 'tools:ptc-only'),
        contexts: [...assembled.contexts.filter(context => context.name !== capabilityContextName),
          { name: capabilityContextName, text: capabilityNotice(capabilities), interpolate: false }],
      }
    }, { prepend: true })

    policyCtx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      const policy = policies.get(agent)
      if (policy?.capabilities !== undefined) {
        if (policy.revision !== options.revision()) throw changed()
        assertSupportedInput(policy, agent.session.deriveMessages(), decision.messages)
      }
      return decision
    }, { prepend: true })

    policyCtx.on('agent/request', async ({ agent, signal }, next) => {
      const config = await next()
      const captured = policies.get(agent)
      if (captured === undefined) return config
      const current = await metadata(config.provider, config.model, signal)
      if (captured.capabilities === undefined && current === undefined) return config
      if (!active || captured.provider !== config.provider || captured.model !== config.model
        || captured.revision !== options.revision()
        || !isDeepStrictEqual(captured.capabilities, current)) throw changed()
      if (effectiveTextCapability(current, 'reasoning') === false && config.reasoningEffort !== undefined
        && config.reasoningEffort !== 'off' && config.reasoningEffort !== 'none') throw new LlmError(
        '当前模型不支持推理档位，请关闭推理选项或切换模型。', 'MODEL_CAPABILITY_REASONING_UNSUPPORTED')
      return config
    }, { prepend: true })

    // This immutable loop request is observed after every request middleware has returned.
    policyCtx.on('llm/stream', async function* (request, next) {
      if (!isAgentLoopRequest(request)) { yield* next(); return }
      const agent = policyCtx.get('agents')?.currentInitiator()
      if (agent === undefined || request.sessionId !== agent.session.id) { yield* next(); return }
      const captured = policies.get(agent)
      const current = await metadata(request.provider, request.model, request.signal)
      if (captured?.capabilities === undefined && current === undefined) { yield* next(); return }
      if (!active || captured === undefined || captured.provider !== request.provider || captured.model !== request.model
        || captured.revision !== options.revision()
        || !isDeepStrictEqual(captured.capabilities, current)) throw changed()
      assertSupportedInput(captured, request.messages, [])
      if (effectiveTextCapability(current, 'tools') === false && request.tools !== undefined && request.tools.length > 0) throw new LlmError(
        toolDenial, 'MODEL_CAPABILITY_TOOLS_UNSUPPORTED')
      yield* next()
    }, { prepend: true })

    const deniesExecution = (agent: Agent | undefined): boolean => agent !== undefined
      && (effectiveTextCapability(policies.get(agent)?.capabilities, 'tools') === false
        || !textCapabilityRouteAvailable(policies.get(agent)?.capabilities))
    policyCtx.on('tools/pre-execute', async (execution, next) => {
      const decision = await next()
      if (!deniesExecution(execution.agent) || decision.kind === 'cancel' || decision.kind === 'deny') return decision
      return { kind: 'deny', reason: toolDenial, info: { name: 'ModelCapabilityError', code: 'MODEL_CAPABILITY_TOOLS_UNSUPPORTED' } }
    }, { prepend: true })
    policyCtx.tools.guard(execution => deniesExecution(execution.agent) ? toolDenial : undefined)
  })
}
