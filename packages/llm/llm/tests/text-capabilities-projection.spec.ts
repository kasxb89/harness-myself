import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, {
  LlmAdapter, ToolCallId, createAssistantMessage, createDeveloperMessage, createToolResultMessage, createUserMessage,
  markAgentLoopRequest, type GenerateOptions, type LlmResolvedModelInfo, type RequestMessage, type StreamChunk,
} from '../src/index.ts'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, inputModalities: model === 'vision-only' ? ['text', 'image'] : ['text'],
      ...model === 'legacy' ? {} : { textCapabilities: {
        tools: model === 'file-tools', vision: model === 'vision-only', reasoning: false, stream: true, maxInputTokens: 32000,
      } } }
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['projection'], adapter)
  return { ctx, adapter }
}
async function chunks(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []
  for await (const chunk of stream) result.push(chunk)
  return result
}
const text = () => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue with a text answer.' }] })
const tool = { name: 'lookup', description: 'Look up a fixture value', parameters: {} }
function delta(type: 'tool-addition' | 'tool-removal') {
  return createDeveloperMessage({ source: { kind: 'system-prompt' }, content: [{ type, toolName: tool.name }] })
}
function binary(kind: 'image' | 'file') {
  const attachmentId = AttachmentId('a'.repeat(64))
  return createUserMessage({ source: { kind: 'user' }, content: [kind === 'image'
    ? { type: 'image', attachment: { attachmentId, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }
    : { type: 'file', attachment: { attachmentId, name: 'notes.txt', bytes: 1 } }] })
}
function request(messages: RequestMessage[], loop = false): GenerateOptions {
  const value: GenerateOptions = { provider: 'projection', model: 'plain', messages }
  return loop ? markAgentLoopRequest(value) : value
}

describe('declared capabilities before generic request projection', () => {
  it.each(['image', 'file'] as const)('rejects raw %s on direct, prepared and marked requests before text substitution', async (kind) => {
    const { ctx, adapter } = await fixture()
    const original = binary(kind)
    const direct = await chunks(ctx.llm.stream(request([original])))
    const prepared = await ctx.llm.prepareCall({ provider: 'projection', model: 'plain' })
    const captured = await chunks(prepared.stream({ ...prepared.config, messages: [original] }))
    const loop = await chunks(ctx.llm.stream(request([original], true)))
    for (const result of [direct, captured, loop]) expect(result).toMatchObject([
      { type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_CAPABILITY_INPUT_UNSUPPORTED' } } },
    ])
    expect(original.content[0]?.type).toBe(kind)
    expect(adapter.requests).toHaveLength(0)
  })

  it.each([false, true])('rejects current definitions and actual tool history regardless of loop marker=%s', async (loop) => {
    const { ctx, adapter } = await fixture()
    const definitions = request([text()], loop)
    definitions.tools = [tool]
    expect(await chunks(ctx.llm.stream(definitions))).toMatchObject([
      { type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_CAPABILITY_TOOLS_UNSUPPORTED' } } },
    ])
    const call = createAssistantMessage({ source: { provider: 'projection', model: 'legacy' },
      content: [{ type: 'tool-call', id: ToolCallId('lookup-call'), name: tool.name, arguments: '{}' }] })
    const result = createToolResultMessage({ callId: ToolCallId('lookup-call'), isError: false, content: [{ type: 'text', text: 'value' }] })
    for (const history of [[call, text()], [result, text()]]) {
      expect(await chunks(ctx.llm.stream(request(history, loop)))).toMatchObject([
        { type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_CAPABILITY_HISTORY_UNSUPPORTED' } } },
      ])
    }
    expect(adapter.requests).toHaveLength(0)
  })

  it.each([
    { model: 'file-tools', allowed: 'file', rejected: 'image' },
    { model: 'vision-only', allowed: 'image', rejected: 'file' },
  ] as const)('uses separate image and file capabilities on $model', async ({ model, allowed, rejected }) => {
    const { ctx, adapter } = await fixture()
    for (const kind of [allowed, rejected]) {
      const prepared = await ctx.llm.prepareCall({ provider: 'projection', model })
      const original = binary(kind)
      const direct = { ...request([original]), model }
      const loop = markAgentLoopRequest({ ...direct })
      for (const result of [
        await chunks(ctx.llm.stream(direct)),
        await chunks(prepared.stream({ ...prepared.config, messages: [original] })),
        await chunks(ctx.llm.stream(loop)),
      ]) {
        expect(result).toMatchObject(kind === allowed
          ? [{ type: 'finish', reason: { kind: 'stop' } }]
          : [{ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_CAPABILITY_INPUT_UNSUPPORTED' } } }])
      }
      expect(original.content[0]?.type).toBe(kind)
    }
    expect(adapter.requests).toHaveLength(3)
    if (allowed === 'file') {
      expect(adapter.requests.every(value => value.messages.every(message =>
        message.content.every(block => block.type === 'text')))).toBe(true)
      const block = adapter.requests[0]?.messages[0]?.content[0]
      expect(block?.type).toBe('text')
      if (block?.type !== 'text') throw new Error('Expected projected file handle text')
      expect(block.text).toContain('notes.txt')
    } else {
      expect(adapter.requests.every(value => value.messages[0]?.content[0]?.type === 'image')).toBe(true)
    }
  })

  it('rejects unmarked SDK tool updates and folded history instead of silently removing them', async () => {
    const { ctx, adapter } = await fixture()
    const added = delta('tool-addition')
    const removed = delta('tool-removal')
    const folded = request([text()])
    folded.toolHistory = { tools: [tool], updates: [] }
    for (const value of [request([added, text()]), request([removed, text()]), folded]) {
      expect(await chunks(ctx.llm.stream(value))).toMatchObject([
        { type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_CAPABILITY_HISTORY_UNSUPPORTED' } } },
      ])
    }
    expect(adapter.requests).toHaveLength(0)
  })

  it('keeps internal registration deltas compatible when a marked text conversation changes models', async () => {
    const { ctx, adapter } = await fixture()
    const first = text()
    await chunks(ctx.llm.stream(markAgentLoopRequest({ provider: 'projection', model: 'legacy', messages: [first], tools: [tool] })))
    const answer = createAssistantMessage({ source: { provider: 'projection', model: 'legacy' }, content: [{ type: 'text', text: 'A normal text answer.' }] })
    const added = delta('tool-addition'), removed = delta('tool-removal')
    const originalMessages = [first, answer, added, removed, text()]
    const next = request(originalMessages, true)
    next.tools = []
    next.toolHistory = { tools: [], updates: [{ messageId: added.id, additions: [tool] }, { messageId: removed.id, additions: [] }] }
    expect(await chunks(ctx.llm.stream(next))).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]?.tools).toEqual([])
    expect(adapter.requests[1]?.messages).toEqual([first, answer, originalMessages[4]])
    expect(next.messages).toEqual(originalMessages)
    expect(next.messages.filter(message => message.role === 'developer')).toHaveLength(2)
  })

  it('keeps plain helpers and undeclared legacy projection working', async () => {
    const { ctx, adapter } = await fixture()
    const helper = request([text()])
    helper.toolHistory = { tools: [], updates: [] }
    expect(await chunks(ctx.llm.stream(helper))).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    const legacy = { ...request([binary('image'), binary('file'), delta('tool-addition'), text()]), model: 'legacy' }
    expect(await chunks(ctx.llm.stream(legacy))).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]?.messages.every(message => message.role !== 'developer'
      && message.content.every(block => block.type !== 'image' && block.type !== 'file'))).toBe(true)
    expect(legacy.messages.some(message => message.role === 'developer')).toBe(true)
  })
})
