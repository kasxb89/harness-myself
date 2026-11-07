import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialRecord, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createOAuth, oauthBrowser } from '../src/oauth.ts'
import { startConnection, resolveReconnectPolicy } from '../src/connection.ts'
import type { StreamableHttpConfig } from '../src/index.ts'

afterEach(() => vi.restoreAllMocks())

it('authorizes a protected HTTP MCP connection with PKCE and refreshes without opening the browser again', async () => {
  let acceptedToken = 'initial-token'
  let challenge: string | null = null
  const grants: URLSearchParams[] = []
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const json = (value: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
    if (req.url === '/.well-known/oauth-protected-resource/mcp') {
      json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
      return
    }
    if (req.url === '/.well-known/oauth-authorization-server') {
      json({
        issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'], registration_endpoint: `${origin}/register`,
      })
      return
    }
    let body = ''
    for await (const chunk of req as AsyncIterable<Buffer>) body += chunk.toString('utf8')
    if (req.url === '/register') {
      json({ ...JSON.parse(body) as Record<string, unknown>, client_id: 'yunshu-test' })
      return
    }
    if (req.url === '/token') {
      const form = new URLSearchParams(body)
      grants.push(form)
      const first = form.get('grant_type') === 'authorization_code'
      json({
        access_token: first ? 'initial-token' : 'renewed-token',
        ...(first ? { refresh_token: 'refresh-token' } : {}), token_type: 'Bearer',
      })
      return
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    if (req.headers.authorization !== `Bearer ${acceptedToken}`) {
      res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    const request = JSON.parse(body) as { id?: number; method: string }
    if (request.id === undefined) { res.writeHead(202).end(); return }
    const result = request.method === 'initialize'
      ? { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-11-25', serverInfo: { name: 'fixture', version: '1' }, capabilities: {} } }
      : { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown method' } }
    json(result)
  }
  const fixture = createServer((req, res) => {
    void handle(req, res).catch(() => { res.writeHead(500).end() })
  }).listen(0, '127.0.0.1')
  onTestFinished(() => { fixture.closeAllConnections(); fixture.close() })
  await once(fixture, 'listening')
  const address = fixture.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind')
  const origin = `http://127.0.0.1:${address.port}`

  const browser = vi.spyOn(oauthBrowser, 'open').mockImplementation(async (url) => {
    expect(url.origin).toBe(origin)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    challenge = url.searchParams.get('code_challenge')
    const callback = new URL(url.searchParams.get('redirect_uri')!)
    callback.searchParams.set('code', 'test-code')
    callback.searchParams.set('state', 'mismatched')
    expect((await fetch(callback)).status).toBe(400)
    callback.searchParams.set('state', url.searchParams.get('state')!)
    expect((await fetch(callback)).status).toBe(200)
  })
  const ctx = new Context()
  await ctx.plugin(ToolRuntime)
  let saved: CredentialRecord | undefined
  ctx.provide('credentials', {
    readRecord: async () => saved,
    modifyRecord: async (_key, mutate) => { saved = await mutate(saved); return saved },
  } as Pick<CredentialProvider, 'readRecord' | 'modifyRecord'> as CredentialProvider)
  onTestFinished(() => ctx.fiber.dispose())
  const config: StreamableHttpConfig = {
    transport: 'streamable-http', serverName: 'fixture', url: `${origin}/mcp`, headers: {},
    oauth: { authorizationOrigin: origin },
    failOnStartupError: true, toolCallTimeoutMs: 2_000,
  }
  const connection = startConnection(ctx, config, resolveReconnectPolicy({ enabled: false }, 'fixture'))
  onTestFinished(() => connection.dispose())
  expect(await connection.ready).toEqual({})
  expect(grants[0]?.get('code')).toBe('test-code')
  expect(createHash('sha256').update(grants[0]!.get('code_verifier')!).digest('base64url')).toBe(challenge)
  expect(grants[0]?.get('resource')).toBe(config.url)
  expect(browser).toHaveBeenCalledTimes(1)

  // A second authorization challenge exercises the refresh path with the same credential owner.
  const next = createOAuth(ctx, config, new AbortController().signal)
  const response = () => new Response(null, {
    status: 401, headers: { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` },
  })
  const rejectRequest = { response: response(), serverUrl: new URL(config.url), fetchFn: fetch }
  expect(await next.token()).toBe('initial-token')
  acceptedToken = 'renewed-token'
  await next.onUnauthorized!(rejectRequest)
  expect(grants.at(-1)?.get('refresh_token')).toBe('refresh-token')
  expect(await next.token()).toBe('renewed-token')
  expect(browser).toHaveBeenCalledTimes(1)
})

it('rejects an insecure remote OAuth origin before sending requests', () => {
  const ctx = new Context()
  expect(() => createOAuth(ctx, {
    transport: 'streamable-http', serverName: 'fixture', url: 'https://mcp.example/mcp', headers: {},
    oauth: { authorizationOrigin: 'http://auth.example' }, failOnStartupError: true, toolCallTimeoutMs: 2_000,
  }, new AbortController().signal)).toThrow(/requires HTTPS/u)
})
