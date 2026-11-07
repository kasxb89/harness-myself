/** Opt-in server sampling through the current chat route and approval service. */
import type { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, type RequestMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { CreateMessageRequest, CreateMessageResult } from '@modelcontextprotocol/client'

const MAX_INPUT_BYTES = 8_192
const MAX_OUTPUT_TOKENS = 512

/**
 * Create bounded text sampling that requires one active MCP call and approval before generation and result sharing.
 * @param ctx - Context providing the approval and language model services.
 * @param server - Server name included in approval prompts and sampling message metadata.
 * @returns Sampling handler with active-call tracking and reset commands.
 */
export function createSampling(ctx: Context, server: string): {
  reset: () => void
  aroundCall<T>(this: void, exec: ToolExecution, call: () => Promise<T>): Promise<T>
  sample(params: CreateMessageRequest['params'], requestSignal: AbortSignal): Promise<CreateMessageResult>
} {
  const active = new Map<ToolExecution, { used: boolean }>()
  return {
    reset: () => { active.clear() },
    async aroundCall<T>(this: void, exec: ToolExecution, call: () => Promise<T>): Promise<T> {
      active.set(exec, { used: false })
      try {
        return await call()
      } finally {
        active.delete(exec)
      }
    },
    // oxlint-disable-next-line typescript/no-deprecated -- both wire revisions still use this SDK sampling handler.
    async sample(params: CreateMessageRequest['params'], requestSignal: AbortSignal): Promise<CreateMessageResult> {
      const parent = active.size === 1 ? active.entries().next().value : undefined
      const exec = parent?.[0]
      const approval = ctx.get('approval')
      const llm = ctx.get('llm')
      const agent = exec?.agent
      if (!parent || !exec || !agent || parent[1].used || !approval || !llm) throw new Error('No unambiguous approved MCP sampling route')
      if (params.tools?.length || params.toolChoice || (params.includeContext && params.includeContext !== 'none')) {
        throw new Error('MCP sampling accepts text without tools or conversation context')
      }
      const messages: RequestMessage[] = params.messages.map(({ role, content }) => {
        const blocks = Array.isArray(content) ? content : [content]
        const text = blocks.map((block) => {
          if (block.type !== 'text') throw new Error('MCP sampling accepts only text')
          return { type: 'text' as const, text: block.text }
        })
        return role === 'assistant'
          ? createAssistantMessage({ content: text, source: { provider: 'mcp-sampling', model: server } })
          : { role, content: text }
      })
      const preview = JSON.stringify({ system: params.systemPrompt, messages })
      if (Buffer.byteLength(preview) > MAX_INPUT_BYTES) throw new Error('MCP sampling input is too large')
      const maxTokens = Math.min(MAX_OUTPUT_TOKENS, params.maxTokens)
      if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new Error('Invalid MCP sampling token limit')
      const route = agent.session.requestHeader()?.config ?? agent.options
      const { provider, model } = route
      if (provider === undefined || model === undefined) throw new Error('The chat model is unavailable for MCP sampling')
      parent[1].used = true
      const signal = AbortSignal.any([requestSignal, exec.signal, AbortSignal.timeout(120_000)])
      const approve = async (reason: string, details: { en: string; zh: string }): Promise<void> => {
        signal.throwIfAborted()
        if (await approval.request({ agent, toolName: exec.name, callId: exec.callId, reason, displayReason: details, signal }) !== 'allowed-once') {
          throw new Error('The user did not approve MCP sampling')
        }
        signal.throwIfAborted()
        if (!active.has(exec)) throw new Error('The parent MCP call has ended')
      }
      await approve(`MCP sampling request from "${server}"`, {
        en: `Allow ${server} to sample with ${model} (up to ${maxTokens} output tokens)? This may use credits. Request: ${preview}`,
        zh: `允许 ${server} 使用 ${model} 生成内容吗？最多 ${maxTokens} 个输出 Token，可能消耗积分。请求内容：${preview}`,
      })
      let text = ''
      let stopReason: 'endTurn' | 'maxTokens' | undefined
      for await (const chunk of llm.stream({
        provider, model, messages, maxTokens, signal,
        sessionId: agent.session.id,
        ...params.systemPrompt === undefined ? {} : { system: params.systemPrompt },
      })) {
        if (chunk.type === 'block-end' && chunk.block.type === 'text') {
          text += chunk.block.text
          if (Buffer.byteLength(text) > MAX_INPUT_BYTES) throw new Error('MCP sampling response is too large')
        }
        if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'stop') stopReason = 'endTurn'
          if (chunk.reason.kind === 'max-tokens') stopReason = 'maxTokens'
        }
      }
      if (!stopReason || !text) throw new Error('The chat model did not return a usable sampling response')
      await approve(`Send sampling result to "${server}"`, {
        en: `Send this result to ${server}? ${JSON.stringify(text)}`,
        zh: `允许把以下结果发送给 ${server} 吗？${JSON.stringify(text)}`,
      })
      return { model, role: 'assistant', stopReason, content: { type: 'text', text } }
    },
  }
}
