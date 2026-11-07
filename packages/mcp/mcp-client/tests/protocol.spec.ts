import { z } from 'zod'
/** Real SDK negotiation, subscription, and cancellation through the connection supervisor. */

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { InMemoryTransport, type Transport } from '@modelcontextprotocol/client'
import { inputRequired, inputResponse, McpServer, type CreateMessageResult } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { ToolCallId, type GenerateOptions, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import { startConnection, resolveReconnectPolicy } from '../src/connection.ts'
import type { Config } from '../src/index.ts'

const { mockTransport } = vi.hoisted(() => ({ mockTransport: vi.fn<() => Transport>() }))
vi.mock('../src/transport.ts', () => ({ createTransport: mockTransport }))

const config: Config = {
  transport: 'stdio', serverName: 'fixture', command: 'fixture', args: [], env: {}, cwd: '',
  toolCallTimeoutMs: 60_000, failOnStartupError: true,
}

async function connect(
  server: McpServer, options?: { resources?: true; sampling?: true; configure?: (ctx: Context) => void },
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const serving = serveStdio(() => server, { transport: serverTransport })
  mockTransport.mockReturnValue(clientTransport)
  options?.configure?.(ctx)
  const connection = startConnection(ctx, { ...config, ...options?.sampling && { sampling: true } }, resolveReconnectPolicy({ enabled: false }, 'fixture'))
  onTestFinished(async () => {
    await connection.dispose()
    await serving.close()
    await ctx.fiber.dispose()
  })
  expect(await connection.ready).toEqual({})
  if (options?.resources) {
    await ctx.plugin(McpResources)
    ctx.mcpResources.register('fixture', connection.resources)
  }
  return ctx
}

describe('modern MCP connections', () => {
  it('keeps a resource-only server connected without requesting tools', async () => {
    const server = new McpServer({ name: 'resources', version: '1' })
    server.registerResource('memo', 'memo://readme', {}, async () => ({
      contents: [{ uri: 'memo://readme', text: 'memo' }],
    }))
    const ctx = await connect(server)
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('keeps shared resource tools for a configured server without resource capability', async () => {
    const server = new McpServer({ name: 'tools-only', version: '1' })
    server.registerTool('ping', { inputSchema: z.object({}) }, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }))
    const ctx = await connect(server, { resources: true })
    const names = ctx.tools.schemas().map(tool => tool.name)
    expect(names.toSorted()).toEqual([
      'get_mcp_prompt', 'list_mcp_prompts', 'list_mcp_resource_templates', 'list_mcp_resources',
      'mcp__fixture__ping', 'mcp_resource_subscription_status', 'read_mcp_resource',
      'subscribe_mcp_resource', 'unsubscribe_mcp_resource',
    ])
    for (const [name, expected] of [
      ['list_mcp_resources', { resources: [] }],
      ['list_mcp_resource_templates', { resourceTemplates: [] }],
    ] as const) {
      const result = await ctx.tools.execute({
        name, arguments: { server: 'fixture' },
        callId: ToolCallId(name), signal: new AbortController().signal,
      })
      expect(result).toMatchObject({ isError: false, value: expected })
    }
    const read = await ctx.tools.execute({
      name: 'read_mcp_resource', arguments: { server: 'fixture', uri: 'memo://readme' },
      callId: ToolCallId('unsupported-resource-read'), signal: new AbortController().signal,
    })
    expect(read.isError).toBe(true)
    if (read.isError) expect(read.error.message).toContain('Method not found')
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(names)
    const ping = await ctx.tools.execute({
      name: 'mcp__fixture__ping', arguments: {},
      callId: ToolCallId('ping-after-resource-errors'), signal: new AbortController().signal,
    })
    expect(ping).toMatchObject({ isError: false, value: { content: [{ type: 'text', text: 'pong' }] } })
  })

  it('reads resources and preserves explicit list and template cursors through the SDK', async () => {
    const server = new McpServer({ name: 'resources', version: '1' })
    server.registerResource('memo', 'memo://readme', {}, async () => ({
      contents: [{ uri: 'memo://readme', text: 'memo' }],
    }))
    const seen: (string | undefined)[] = []
    server.server.setRequestHandler('resources/list', async (request) => {
      const cursor = request.params?.cursor
      seen.push(cursor)
      return { resources: [{ name: 'memo', uri: 'memo://readme' }] }
    })
    server.server.setRequestHandler('resources/templates/list', async (request) => {
      seen.push(request.params?.cursor)
      return { resourceTemplates: [] }
    })
    const ctx = await connect(server, { resources: true })
    for (const name of ['list_mcp_resources', 'list_mcp_resource_templates']) {
      for (const cursor of [undefined, 'opaque-page']) {
        const result = await ctx.tools.execute({
          name, arguments: { server: 'fixture', ...cursor === undefined ? {} : { cursor } },
          callId: ToolCallId(name), signal: new AbortController().signal,
        })
        expect(result.isError).toBe(false)
      }
    }
    expect(seen).toEqual([undefined, 'opaque-page', undefined, 'opaque-page'])
    const read = await ctx.tools.execute({
      name: 'read_mcp_resource', arguments: { server: 'fixture', uri: 'memo://readme' },
      callId: ToolCallId('read-resource'), signal: new AbortController().signal,
    })
    expect(read).toMatchObject({ isError: false, value: { contents: [{ uri: 'memo://readme', text: 'memo' }] } })
  })

  it('discovers prompt templates and sends their arguments only after approval', async () => {
    const server = new McpServer({ name: 'prompts', version: '1' })
    const render = vi.fn(({ topic }: { topic: string }) => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Discuss ${topic}` } }],
    }))
    server.registerPrompt('review', { argsSchema: z.object({ topic: z.string() }) }, render)
    const approve = vi.fn().mockResolvedValueOnce('rejected').mockResolvedValueOnce('allowed-once')
    const ctx = await connect(server, {
      resources: true, configure: (inner) => { inner.provide('approval', { request: approve } as never) },
    })
    const agent = { session: { id: 'prompt-owner' } } as ToolExecution['agent']
    const run = (name: string, args: object) => ctx.tools.execute({
      name, arguments: { server: 'fixture', ...args }, ...(agent === undefined ? {} : { agent }),
      callId: ToolCallId(name), signal: new AbortController().signal,
    })
    const list = await run('list_mcp_prompts', {})
    expect(list, JSON.stringify(list)).toMatchObject({
      isError: false, value: { prompts: [{ name: 'review', arguments: [{ name: 'topic', required: true }] }] },
    })
    const args = { name: 'review', arguments: { topic: 'Office' } }
    expect((await run('get_mcp_prompt', args)).isError).toBe(true)
    expect(render).not.toHaveBeenCalled()
    expect(await run('get_mcp_prompt', args)).toMatchObject({
      isError: false, value: { messages: [{ content: { text: 'Discuss Office' } }] },
    })
  })

  it('tracks modern resource subscriptions per chat and receives actual update notifications', async () => {
    const server = new McpServer({ name: 'subscription', version: '1' }, { capabilities: { resources: { subscribe: true } } })
    server.registerResource('memo', 'memo://readme', {}, async () => ({ contents: [{ uri: 'memo://readme', text: 'memo' }] }))
    const ctx = await connect(server, { resources: true })
    const run = (name: string, id: string) => ctx.tools.execute({
      name, arguments: { server: 'fixture', uri: 'memo://readme' },
      agent: { session: { id } } as NonNullable<ToolExecution['agent']>,
      callId: ToolCallId(name), signal: new AbortController().signal,
    })
    expect(await run('subscribe_mcp_resource', 'first')).toMatchObject({ isError: false, value: { subscribed: true, updates: 0 } })
    expect(await run('mcp_resource_subscription_status', 'second')).toMatchObject({ isError: false, value: { subscribed: false } })
    await server.server.sendResourceUpdated({ uri: 'memo://readme' })
    await vi.waitFor(async () => {
      expect(await run('mcp_resource_subscription_status', 'first')).toMatchObject({ isError: false, value: { subscribed: true, updates: 1 } })
    })
    expect(await run('subscribe_mcp_resource', 'second')).toMatchObject({ isError: false, value: { subscribed: true, updates: 0 } })
    expect(await run('unsubscribe_mcp_resource', 'first')).toMatchObject({ isError: false, value: { subscribed: false } })
    expect(await run('unsubscribe_mcp_resource', 'second')).toMatchObject({ isError: false, value: { subscribed: false } })
  })

  it('asks before running sampling on the active model and before sharing the result', async () => {
    const server = new McpServer({ name: 'sampling', version: '1' })
    server.registerTool('sample', { inputSchema: z.object({}) }, async (_args, ctx) => {
      const response = inputResponse(ctx.mcpReq.inputResponses, 'sample')
      if (response.kind !== 'sampling') return inputRequired({
        inputRequests: {
          sample: inputRequired.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: 'Summarize this' } }], maxTokens: 2000,
          }),
        },
      })
      // oxlint-disable-next-line typescript/no-deprecated -- this fixture exercises the modern embedded sampling response.
      const sampled = response.result as CreateMessageResult
      return { content: Array.isArray(sampled.content) ? sampled.content : [sampled.content] }
    })
    const approve = vi.fn().mockResolvedValueOnce('rejected').mockResolvedValueOnce('allowed-once').mockResolvedValueOnce('allowed-once')
    const stream = vi.fn(async function* (_options: GenerateOptions) {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Local summary' } } as const
      yield { type: 'finish', reason: { kind: 'stop' } } as const
    })
    const ctx = await connect(server, {
      sampling: true, configure: (inner) => {
        inner.provide('approval', { request: approve } as never)
        inner.provide('llm', { stream } as unknown as LlmRuntime)
      },
    })
    const agent = {
      session: { id: 'sampling-owner', requestHeader: () => undefined }, options: { provider: 'fixture', model: 'selected-model' },
    } as unknown as NonNullable<ToolExecution['agent']>
    const run = () => ctx.tools.execute({
      name: 'mcp__fixture__sample', arguments: {}, agent,
      callId: ToolCallId('sample'), signal: new AbortController().signal,
    })
    expect((await run()).isError).toBe(true)
    expect(stream).not.toHaveBeenCalled()
    const result = await run()
    expect(result, JSON.stringify(result)).toMatchObject({
      isError: false, value: { content: [{ type: 'text', text: 'Local summary' }] },
    })
    expect(stream).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      provider: 'fixture', model: 'selected-model', maxTokens: 512,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarize this' }] }],
    }))
    expect(approve).toHaveBeenCalledTimes(3)
  })

  it('updates tools through the SDK modern list-change subscription', async () => {
    const server = new McpServer({ name: 'tools', version: '1' })
    server.registerTool('first', { inputSchema: z.object({}) }, async () => ({ content: [] }))
    const ctx = await connect(server)
    expect(ctx.tools.get('mcp__fixture__first')).toBeDefined()
    server.registerTool('second', { inputSchema: z.object({}) }, async () => ({ content: [] }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__fixture__second')).toBeDefined() })
  })

  it('delivers caller cancellation to an executing modern tool', async () => {
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const cancelled: PromiseWithResolvers<void> = Promise.withResolvers()
    const server = new McpServer({ name: 'cancel', version: '1' })
    server.registerTool('wait', { inputSchema: z.object({}) }, async (_args, context) => {
      const signal = context.mcpReq.signal
      signal.addEventListener('abort', () => { cancelled.resolve() }, { once: true })
      entered.resolve()
      await cancelled.promise
      return { content: [] }
    })
    const ctx = await connect(server)
    const controller = new AbortController()
    const result = ctx.tools.execute({
      callId: ToolCallId('cancel'), name: 'mcp__fixture__wait', arguments: {}, signal: controller.signal,
    })
    await entered.promise
    controller.abort(new Error('caller stopped'))
    expect((await result).isError).toBe(true)
    await cancelled.promise
  })
})
