/** The production Harness model route shares an authority with an unrelated root-path service. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { discoverModels } from '../src/discovery.ts'
import { harnessFetch } from '../src/harness-fetch.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const nativeFetch = globalThis.fetch

afterEach(async () => {
  vi.unstubAllGlobals()
  await closeMockServers()
})

function adapter(baseURL: string): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles({
      'product-relay': { api: 'openai-completions', baseURL, apiKeyEnv: 'ACCOUNT_RELAY_KEY', models: [{ id: 'deepseek-v4-flash' }] },
    }),
    resolveApiKey: () => Promise.resolve('sk-account-relay-key'),
    auth: memoryAuth(),
  })
}

async function complete(baseURL: string): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter(baseURL).stream({ provider: 'product-relay', model: 'deepseek-v4-flash', messages: [] })) {
    chunks.push(chunk)
  }
  return chunks
}

/** Replace only the destination authority; the real SDK path, headers, body and redirect policy reach local HTTP. */
function localTransport(localBase: string) {
  const target = new URL(localBase)
  const transport = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    expect(url.origin).toBe('https://8.133.202.230')
    expect(url.pathname.startsWith('/harness/v1/')).toBe(true)
    expect(request.redirect).toBe('error')
    url.protocol = target.protocol
    url.host = target.host
    return await nativeFetch(new Request(url, request))
  })
  vi.stubGlobal('fetch', transport)
  return transport
}

describe('Harness model prefix and redirects', () => {
  it.each([
    'https://8.133.202.230/v1/chat/completions', 'https://8.133.202.230/harness/v1/../../v1/chat/completions',
    'https://8.133.202.230/harness/v1/%252e%252e/chat/completions', 'https://another-provider.invalid/harness/v1/chat/completions',
  ])('refuses an SDK request which escapes or obscures the configured prefix: %s', async (url) => {
    const transport = vi.fn(() => Promise.reject(new Error('No production networking permitted in this test')))
    vi.stubGlobal('fetch', transport)
    const guarded = harnessFetch('https://8.133.202.230/harness/v1')
    if (guarded === undefined) throw new Error('Expected the Harness request transport')
    await expect(guarded(url)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('sends the real OpenAI SDK request to /harness/v1/chat/completions with the account relay key', async () => {
    const server = await mockServer([{ events: textEvents }])
    const transport = localTransport(server.url)
    const chunks = await complete('https://8.133.202.230/harness/v1')
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'hello' })
    expect(chunks.find(chunk => chunk.type === 'finish')).toMatchObject({ reason: { kind: 'stop' } })
    expect(server.paths).toEqual(['/harness/v1/chat/completions'])
    expect(server.headers[0]?.authorization).toBe('Bearer sk-account-relay-key')
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it.each(['/v1/chat/completions', 'https://another-provider.invalid/v1/chat/completions'])(
    'refuses an HTTP redirect to %s without following it or repeating the paid POST', async (location) => {
      const server = await mockServer([{ status: 307, headers: { location } }, { events: textEvents }])
      const transport = localTransport(server.url)
      const chunks = await complete('https://8.133.202.230/harness/v1')
      expect(chunks.find(chunk => chunk.type === 'finish')).toMatchObject({ reason: { kind: 'error' } })
      expect(server.paths).toEqual(['/harness/v1/chat/completions'])
      expect(transport).toHaveBeenCalledTimes(1)
    },
  )

  it('keeps authenticated model discovery under /harness/v1 and refuses redirects to root models', async () => {
    const server = await mockServer([
      { body: '{"data":[{"id":"deepseek-v4-flash"}]}' }, { status: 307, headers: { location: '/v1/models' } },
    ])
    const transport = localTransport(server.url)
    const request = { baseURL: 'https://8.133.202.230/harness/v1', api: 'openai-completions', apiKey: 'sk-account-relay-key' }
    expect(await discoverModels(request)).toMatchObject([{ id: 'deepseek-v4-flash' }])
    await expect(discoverModels(request)).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    expect(server.paths).toEqual(['/harness/v1/models', '/harness/v1/models'])
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it.each([
    'https://8.133.202.230/v1', 'https://8.133.202.230', 'http://8.133.202.230/harness/v1',
    'https://8.133.202.230:3010/harness/v1', 'https://user:password@8.133.202.230/harness/v1',
    'https://8.133.202.230/harness/v1?key=secret', 'https://8.133.202.230/harness/v1#fragment',
  ])('rejects unsafe model endpoint %s before resolving any network request', async (baseURL) => {
    const transport = vi.fn(() => Promise.reject(new Error('No production networking permitted in this test')))
    vi.stubGlobal('fetch', transport)
    await expect(complete(baseURL)).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('retains a third-party provider SDK redirect policy and its custom base prefix', async () => {
    const server = await mockServer([
      { status: 307, headers: { location: '/third-party/chat/completions' } }, { events: textEvents },
    ])
    const chunks = await complete(server.url + '/gateway/v1')
    expect(chunks.find(chunk => chunk.type === 'finish')).toMatchObject({ reason: { kind: 'stop' } })
    expect(server.paths).toEqual(['/gateway/v1/chat/completions', '/third-party/chat/completions'])
  })
})
