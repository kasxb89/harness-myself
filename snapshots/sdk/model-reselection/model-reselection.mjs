/** Controlled provider failure and recovery hook over the shipped SDK/AgentLoop path. */
import { writeFile } from 'node:fs/promises'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

const provider = 'deepseek-official'
const source = 'deepseek-v4-flash'
const target = 'deepseek-v4-pro'
const selections = new WeakMap()
const recovered = new WeakSet()

export const inject = ['llm', 'agents', 'systemPrompt']

/**
 * The normalized receipt is synthetic here; raw Go HTTP trust is covered by the
 * dedicated Host SDK integration. No network or credential provider is used.
 * @param {import('@deepseek-ai/cordis').Context} ctx - scenario plugin owner.
 * @param {{traceFile?: string}} config - optional external request oracle for SDK consumers.
 */
export function apply(ctx, config = {}) {
  const requests = []
  ctx.llm.registerAdapter([provider], new class extends LlmAdapter {
    providerRetryPolicy() { return { mode: 'normal', maxRetries: 0 } }
    async resolveModel(route, model) {
      const output = model === source ? 32768 : 4096
      return { provider: route, id: model, name: model,
        context: { contextWindow: model === source ? 1048576 : 131072 },
        defaultMaxTokens: output, maxOutputTokens: output }
    }
    async *stream(request) {
      request.signal?.throwIfAborted()
      requests.push({ provider: request.provider, model: request.model, maxTokens: request.maxTokens,
        system: request.system, messages: request.messages, tools: request.tools?.map(tool => tool.name) })
      if (config.traceFile !== undefined) await writeFile(config.traceFile, JSON.stringify(requests, null, 2) + '\n')
      if (request.model === source) {
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: 'MODEL_UNAVAILABLE_NOT_SUBMITTED', message: 'Synthetic model unavailable before submission.',
          status: 503, requestId: 'snapshot-zero-send', textReselection: {
            schemaVersion: 1, model: source, requestId: 'snapshot-zero-send', origin: 'https://8.133.202.230',
            managedScope: 'snapshot-account', submissionState: 'not_submitted', upstreamSubmitted: false,
            billingReserved: false, reason: 'model_unavailable',
          },
        } } }
        return
      }
      if (request.model !== target) throw new Error('Unexpected snapshot model')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'SDK snapshot OK' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'SDK snapshot OK' } }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }())
  ctx.on('agent/created', ({ agent }) => {
    const selection = { current: { provider, model: source }, assembled: undefined }
    selections.set(agent, selection)
    installModelSelection(agent.ctx, selection)
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const selected = selections.get(context.agent)?.current
    if (selected === undefined) return assembled
    const names = selected.model === source ? ['glob', 'read'] : ['read']
    const tools = assembled.tools.filter(tool => names.includes(tool.name))
    if (tools.length !== names.length) throw new Error('Expected the shipped cross-platform read/glob declarations')
    return { ...assembled, tools,
      variables: { ...assembled.variables, ...selected },
      sections: [...assembled.sections, { name: 'snapshot:model-route', text: `Current snapshot model: ${selected.model}.` }] }
  })
  ctx.on('agent/request', async ({ agent }, next) => {
    const resolved = await next()
    const selected = selections.get(agent)?.assembled
    if (selected === undefined) return resolved
    const { reasoningEffort: _inheritedEffort, maxTokens: _inheritedOutput, ...fresh } = resolved
    return { ...fresh, ...selected }
  })
  ctx.on('agent/request-error', async ({ agent, failure, hasOutput }, next) => {
    const proof = failure.textReselection
    if (failure.code !== 'MODEL_UNAVAILABLE_NOT_SUBMITTED' || hasOutput !== false || recovered.has(agent)
      || proof?.model !== source || proof.submissionState !== 'not_submitted'
      || proof.upstreamSubmitted !== false || proof.billingReserved !== false) return next()
    const selection = selections.get(agent)
    if (selection === undefined) throw new Error('Expected the SDK model selection')
    recovered.add(agent)
    selection.current = { provider, model: target }
    return { kind: 'retry', reassemble: true }
  })
}
