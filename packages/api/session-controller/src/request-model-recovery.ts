/** One same-turn model reselection after the gateway proves zero upstream and billing effects. */
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { LlmError, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-token-meter'
import { ApiSessionAgentController, hasApiSessionSubagentOwner } from './agent.ts'
import { awaitPromptModel, recoverPromptModel } from './prompt-model.ts'
import type {} from './peer-projection.ts'

interface AttemptOwner {
  readonly turn: number
  readonly step: number
  readonly provider: string
  readonly model: string
  readonly owner: string | undefined
  readonly managedScope: string | undefined
  used: boolean
}

/**
 * Register product-gateway recovery on the existing failed-attempt hook.
 * Only a confined zero-send receipt can authorize one replacement; ordinary retries remain separate.
 * @param ctx - Session Controller owner, including its lifetime and account-binding event.
 * @param agents - Session-local model selection owner; global defaults are never saved here.
 */
export function registerRequestModelRecovery(ctx: Context, agents: ApiSessionAgentController): void {
  const attempts = new WeakMap<Agent, AttemptOwner>()
  const guards = new WeakMap<Agent, { turn: number; model: string; provider: string; owner: string; managedScope: string }>()
  const active = new Set<Promise<RequestErrorAction>>()
  const preparations = new Set<Promise<void>>()
  const lifetime = new AbortController()
  const ownerFiber = ctx.fiber
  ctx.on('internal/status', (fiber) => {
    if (fiber === ownerFiber && fiber.state === FiberState.UNLOADING) lifetime.abort(new Error('Session model recovery unloading'))
  })
  const owner = (): string | undefined => ctx.waterfall('api-session/prompt-owner', () => undefined)
  ctx.on('agent/request', async ({ agent, turn, step, signal }, next) => {
    const capturedOwner = owner()
    const config = await next()
    const model = await ctx.llm.resolveModelInfo(config.provider, config.model, signal).catch(() => undefined)
    const previous = attempts.get(agent)
    attempts.set(agent, {
      turn, step, provider: config.provider, model: config.model, owner: capturedOwner,
      managedScope: model?.limits?.managedScope,
      used: previous?.turn === turn && previous.used,
    })
    if (guards.get(agent)?.turn !== turn) guards.delete(agent)
    return config
  })

  async function recover(
    payload: Parameters<import('@deepseek-ai/cordis').Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    const { agent, turn, step, provider, model, failure, hasOutput, signal } = payload
    if (failure.code !== 'MODEL_UNAVAILABLE_NOT_SUBMITTED' || failure.textReselection === undefined) return next()
    const proof = failure.textReselection
    const captured = attempts.get(agent)
    const combined = AbortSignal.any([signal, lifetime.signal])
    if (combined.aborted || hasOutput !== false || model === undefined || captured === undefined || captured.used
      || captured.turn !== turn || captured.step !== step || captured.provider !== provider || captured.model !== model
      || proof.model !== model || proof.requestId !== failure.requestId || failure.status !== 400 && failure.status !== 503
      || proof.origin !== 'https://8.133.202.230' || proof.managedScope !== captured.managedScope
      || captured.owner === undefined || captured.owner === 'signed-out' || captured.owner !== owner()
      || hasApiSessionSubagentOwner(ctx, agent.session, agent)) return
    const meter = ctx.get('tokenMeter')
    if (meter === undefined) return
    const capturedOwner = captured.owner
    const authority = ctx.sessionProjections.stateOf(agent.session, 'peerSessionRelay')
    if (authority === undefined) throw new Error('api-session: required peerSessionRelay projection is not registered')
    if (!authority.open || authority.turn !== turn || authority.human === undefined) return
    captured.used = true
    const assertCurrent = (): void => {
      combined.throwIfAborted()
      if (captured.owner !== owner()) throw new LlmError('登录账号已变化，本次不再提交。', 'ABORTED')
    }
    assertCurrent()
    const selection = agents.selectionFor(agent)
    const current = selection.current
    const revision = selection.revision
    // An explicit selection made while HTTP was pending owns the next request.
    if (current.provider !== provider || current.model !== model) return
    try {
      const replacement = await awaitPromptModel(recoverPromptModel(
        ctx, current, [], agent.session.deriveMessages(), combined, assertCurrent, {
          confirmedUnavailable: { provider, model }, managedScope: proof.managedScope,
          inputPressure: (selected, target) => {
            const tools = agent.session.requestHeader()?.tools
            const output = target.maxOutputTokens ?? target.defaultMaxTokens
            return meter.measure(agent.session, { config: { ...selected, ...output === undefined ? {} : { maxTokens: output } },
              ...tools === undefined ? {} : { tools } }).totalTokens
          },
          requireTools: (agent.session.requestHeader()?.tools?.length ?? 0) > 0,
        }), combined)
      assertCurrent()
      if (replacement === undefined) return
      return await awaitPromptModel(agents.serializeImageAdmission(agent, (): RequestErrorAction => {
        assertCurrent()
        const latest = selection.current
        if (revision !== selection.revision || latest.provider !== current.provider || latest.model !== current.model
          || latest.reasoningEffort !== current.reasoningEffort) return
        agents.selectForNextRequest(agent, replacement)
        guards.set(agent, { ...replacement, turn, owner: capturedOwner, managedScope: proof.managedScope })
        return { kind: 'retry', reassemble: true, signal: lifetime.signal }
      }), combined)
    } catch (error) {
      if (signal.aborted || lifetime.signal.aborted) return
      throw new LlmError('当前暂无可用且容量兼容的文本模型，请稍后重试；原输入已保留。',
        'MODEL_RESELECTION_UNAVAILABLE', { cause: error })
    }
  }

  ctx.on('llm/stream', async function* (request, next) {
    if (!isAgentLoopRequest(request)) { yield* next(); return }
    const agent = ctx.agents.currentInitiator()
    const guard = agent === undefined ? undefined : guards.get(agent)
    if (guard === undefined || agent === undefined || request.provider !== guard.provider || request.model !== guard.model) {
      yield* next(); return
    }
    const combined = request.signal === undefined ? lifetime.signal : AbortSignal.any([request.signal, lifetime.signal])
    const preparation = (async () => {
      combined.throwIfAborted()
      if (guard.owner !== owner()) throw new LlmError('登录账号已变化，本次不再提交。', 'ABORTED')
      const target = await ctx.llm.resolveModelInfo(request.provider, request.model, combined)
      const meter = ctx.get('tokenMeter')
      const output = request.maxTokens
      const prepared = agent.session.requestContext()
      const preparedWindow = prepared?.provider === request.provider && prepared.model === request.model
        ? prepared.contextWindow : undefined
      const pressure = meter?.measure(agent.session).totalTokens
      if (target.limits?.managedScope !== guard.managedScope || target.context === undefined || preparedWindow === undefined
        || output !== undefined && target.maxOutputTokens !== undefined && output > target.maxOutputTokens
        || pressure === undefined || pressure > Math.min(preparedWindow, target.context.contextWindow)
        || pressure > (target.textCapabilities?.maxInputTokens ?? Number.POSITIVE_INFINITY)) {
        throw new LlmError('原输入超出替代模型的可用容量，本次未发送；原内容已保留。', 'MODEL_RESELECTION_CAPACITY')
      }
      combined.throwIfAborted()
      if (guard.owner !== owner()) throw new LlmError('登录账号已变化，本次不再提交。', 'ABORTED')
    })()
    preparations.add(preparation)
    try { await preparation } finally { preparations.delete(preparation) }
    combined.throwIfAborted()
    yield* next()
  }, { prepend: true })

  ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve<RequestErrorAction>(undefined)
    const operation = recover(payload, next).finally(() => { active.delete(operation) })
    active.add(operation)
    return operation
  }, { prepend: true })
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Session model recovery disposed'))
    await Promise.allSettled([...active, ...preparations])
  }, 'session-controller: drain model recovery')
}
