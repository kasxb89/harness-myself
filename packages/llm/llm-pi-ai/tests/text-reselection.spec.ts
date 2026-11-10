/** Replay actual disposable-Go HTTP responses and fail closed on incomplete zero-send evidence. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmTextReselectionProof, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles, type PiAiProviderProfile } from '../src/config.ts'
import { harnessFetch } from '../src/harness-fetch.ts'
import { memoryAuth } from './auth-double.ts'

interface GoCase {
  name: string
  path: string
  request: { model: string; max_tokens: number; messages: { role: string; content: string }[]; stream: boolean }
  request_headers: Record<string, string>
  status: number
  headers: Record<string, string>
  body: string
  proof_expected: boolean
  provider_posts: number
  consumption_logs: number
}
const rawFixture = readFileSync(new URL('./fixtures/text-reselection-go-http.json', import.meta.url))
const fixture = JSON.parse(rawFixture.toString('utf8')) as { cases: GoCase[] }
const baseUrl = 'https://8.133.202.230/harness/v1'
const scope = 'synthetic-backend-account'
const first = fixture.cases[0]!
const firstBody: unknown = JSON.parse(first.body)
if (!isRecord(firstBody) || !isRecord(firstBody.text_reselection)) throw new Error('Expected a captured Go proof object')
const proofFields = firstBody.text_reselection

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

afterEach(() => { vi.unstubAllGlobals() })

function responseFor(item: GoCase): Response {
  return new Response(item.body, { status: item.status, headers: item.headers })
}
function adapterFor(model: string, patch: Partial<PiAiProviderProfile> = {}, withManagedScope = true): PiAiAdapter {
  const profiles = resolveProfiles({ product: {
    api: 'openai-completions', baseURL: baseUrl, apiKeyEnv: 'SYNTHETIC',
    ...withManagedScope ? { managedLimitsScope: scope } : {},
    models: [{ id: model, managedLimits: { scope, authoritative: true, contextWindow: 32768, maxTokens: 8192 } }],
    ...patch,
  } })
  return new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'synthetic-test-key', auth: memoryAuth() })
}
async function stream(item: GoCase, patch?: Partial<PiAiProviderProfile>, withManagedScope = true): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapterFor(item.request.model, patch, withManagedScope).stream({ provider: 'product', model: item.request.model, messages: [] })) {
    chunks.push(chunk)
  }
  return chunks
}
async function validate(item: GoCase, enabled = true): Promise<LlmTextReselectionProof | undefined> {
  let proof: LlmTextReselectionProof | undefined
  const transport = vi.fn<typeof fetch>(async (_input, init) => {
    const headers = new Headers(init?.headers)
    const isChat = item.path === '/v1/chat/completions'
    expect(headers.get('X-Yunshu-Text-Reselection')).toBe(isChat ? '1' : null)
    return responseFor(item)
  })
  vi.stubGlobal('fetch', transport)
  const guarded = harnessFetch(baseUrl, (_response, value) => { proof = value },
    enabled ? { model: item.request.model, managedScope: scope } : undefined)
  if (guarded === undefined) throw new Error('Expected the confined Harness transport')
  const response = await guarded('https://8.133.202.230/harness' + item.path, {
    method: 'POST', headers: item.request_headers, body: JSON.stringify(item.request),
  })
  expect(await response.text()).toBe(item.body)
  expect(response.status).toBe(item.status)
  expect(transport).toHaveBeenCalledOnce()
  return proof
}

describe('actual Go text-reselection HTTP fixtures', () => {
  it('pins the unmodified 16-case Go capture from the API text-reselection candidate', () => {
    expect(createHash('sha256').update(rawFixture).digest('hex')).toBe('00745e8cd6575ce9442d82b818e046799ac60fb0bf859456023c3b5b02476d1a')
    expect(fixture.cases).toHaveLength(16)
  })
  it.each(fixture.cases)('accepts evidence only when the Go handler supplied it: $name', async (item) => {
    const proof = await validate(item, item.request_headers['X-Yunshu-Text-Reselection'] === '1')
    expect(proof !== undefined).toBe(item.proof_expected)
    if (proof !== undefined) {
      expect(item.provider_posts).toBe(0)
      expect(item.consumption_logs).toBe(0)
      expect(proof).toMatchObject({ model: item.request.model, managedScope: scope, origin: 'https://8.133.202.230' })
      expect(Object.isFrozen(proof)).toBe(true)
    }
  })
  it.each(fixture.cases.filter(item => item.path === '/v1/chat/completions'))(
    'carries the real SDK terminal outcome without another POST: $name', async (item) => {
      const transport = vi.fn<typeof fetch>(async () => responseFor(item))
      vi.stubGlobal('fetch', transport)
      const chunks = await stream(item)
      const terminal = chunks.find(chunk => chunk.type === 'finish')
      if (terminal?.type !== 'finish') throw new Error('Expected terminal outcome')
      const proof = terminal.reason.kind === 'error' ? terminal.reason.failure.textReselection : undefined
      expect(proof !== undefined).toBe(item.proof_expected)
      if (proof !== undefined && terminal.reason.kind === 'error') {
        expect(terminal.reason.failure).toMatchObject({ code: 'MODEL_UNAVAILABLE_NOT_SUBMITTED', status: item.status,
          requestId: item.headers['X-Oneapi-Request-Id'], textReselection: { model: item.request.model, managedScope: scope } })
        expect(chunks).toHaveLength(1)
        expect(JSON.stringify(chunks)).not.toContain('No available channel')
      }
      expect(transport).toHaveBeenCalledOnce()
    },
  )
})

describe('closed zero-send proof validation', () => {
  const mutations: [string, Record<string, unknown>][] = [
    ...Object.keys(proofFields).map(key => [key + ' missing', Object.fromEntries(Object.entries(proofFields).filter(([field]) => field !== key))] as [string, Record<string, unknown>]),
    ['schema string', { ...proofFields, schema_version: '1' }],
    ['other model', { ...proofFields, model: 'other-model' }],
    ['other request', { ...proofFields, request_id: 'other-request' }],
    ['submitted upstream', { ...proofFields, upstream_submitted: true }],
    ['reserved billing', { ...proofFields, billing_reserved: true }],
    ['unknown submission', { ...proofFields, submission_state: 'unknown' }],
    ['other reason', { ...proofFields, reason: 'rate_limit' }],
    ['additional field', { ...proofFields, secret: 'synthetic-private-detail' }],
  ]
  it.each(mutations)('refuses $0 without consuming the original error', async (_name, proof) => {
    expect(await validate({ ...first, body: JSON.stringify({ text_reselection: proof }) })).toBeUndefined()
  })
  it.each([200, 307, 401, 402, 403, 404, 408, 409, 410, 422, 429, 500, 502, 504])(
    'never enables reselection for HTTP%s even with receipt fields', async (status) => {
      expect(await validate({ ...first, status })).toBeUndefined()
    },
  )
  it.each(['', 'other-request', 'two ids', 'a'.repeat(65)])('refuses mismatched or malformed header id %s', async (requestId) => {
    expect(await validate({ ...first, headers: { 'X-Oneapi-Request-Id': requestId } })).toBeUndefined()
  })
  it.each(['', 'null', '[]', '{', JSON.stringify({ error: { code: 'model_not_found' } }),
    JSON.stringify({ text_reselection: proofFields, padding: '界'.repeat(12000) })])(
    'leaves malformed, missing and over-32KiB envelopes opaque', async (body) => {
      expect(await validate({ ...first, body })).toBeUndefined()
    },
  )
  it('refuses an absent header and never infers evidence from an old code or message', async () => {
    expect(await validate({ ...first, headers: {} })).toBeUndefined()
    expect(await validate(first, false)).toBeUndefined()
  })
  it('counts the complete error envelope in UTF8 bytes and accepts exactly 32KiB', async () => {
    const prefix = JSON.stringify({ text_reselection: proofFields, padding: '界' })
    const body = prefix.replace('界', '界' + 'x'.repeat(32 * 1024 - Buffer.byteLength(prefix)))
    expect(Buffer.byteLength(body)).toBe(32 * 1024)
    expect(await validate({ ...first, body })).toBeDefined()
    expect(await validate({ ...first, body: body + ' ' })).toBeUndefined()
  })
  it.each([
    { method: 'GET', path: '/chat/completions', body: undefined },
    { method: 'POST', path: '/responses', body: JSON.stringify(first.request) },
    { method: 'POST', path: '/chat/completions?model=other', body: JSON.stringify(first.request) },
    { method: 'POST', path: '/chat/completions', body: JSON.stringify({ model: 'other-model' }) },
    { method: 'POST', path: '/chat/completions', body: '{}' },
  ])('withholds recovery for another operation or payload: $method $path', async ({ method, path, body }) => {
    const transport = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get('X-Yunshu-Text-Reselection'))
        .toBe(method === 'POST' && path.split('?')[0] === '/chat/completions' ? '1' : null)
      return responseFor(first)
    })
    vi.stubGlobal('fetch', transport)
    let proof: LlmTextReselectionProof | undefined
    const guarded = harnessFetch(baseUrl, (_response, value) => { proof = value }, { model: first.request.model, managedScope: scope })!
    await guarded(baseUrl + path, { method, ...body === undefined ? {} : { body }, headers: { 'X-Yunshu-Text-Reselection': '1' } })
    expect(proof).toBeUndefined()
  })
  it('leaves custom upstream transports outside the proof protocol', () => {
    expect(harnessFetch('https://custom.invalid/harness/v1', undefined, { model: first.request.model, managedScope: scope })).toBeUndefined()
  })
  it('keeps stale unscoped routes single-attempt without accepting evidence', async () => {
    const transport = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get('X-Yunshu-Text-Reselection')).toBe('1')
      return responseFor(first)
    })
    vi.stubGlobal('fetch', transport)
    const chunks = await stream(first, {}, false)
    expect(JSON.stringify(chunks)).not.toContain('textReselection')
    expect(transport).toHaveBeenCalledOnce()
  })
  it('protects a Request body from server retries without accepting unbound evidence', async () => {
    const body = JSON.stringify(first.request)
    const input = new Request(baseUrl + '/chat/completions', { method: 'POST', body })
    const transport = vi.fn<typeof fetch>(async (request, init) => {
      const forwarded = new Request(request, init)
      expect(forwarded.headers.get('X-Yunshu-Text-Reselection')).toBe('1')
      expect(forwarded.redirect).toBe('error')
      expect(await forwarded.text()).toBe(body)
      return responseFor(first)
    })
    vi.stubGlobal('fetch', transport)
    let proof: LlmTextReselectionProof | undefined
    const guarded = harnessFetch(baseUrl, (_response, value) => { proof = value }, { model: first.request.model, managedScope: scope })!
    await guarded(input)
    expect(proof).toBeUndefined()
    expect(transport).toHaveBeenCalledOnce()
  })
  it('protects an opaque streaming body from server retries without inspecting or replacing it', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(first.request))
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } })
    const transport = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get('X-Yunshu-Text-Reselection')).toBe('1')
      expect(init?.body).toBe(body)
      expect(init?.redirect).toBe('error')
      expect(await new Response(body).text()).toBe(JSON.stringify(first.request))
      return responseFor(first)
    })
    vi.stubGlobal('fetch', transport)
    let proof: LlmTextReselectionProof | undefined
    const guarded = harnessFetch(baseUrl, (_response, value) => { proof = value }, { model: first.request.model, managedScope: scope })!
    await guarded(baseUrl + '/chat/completions', { method: 'POST', body })
    expect(proof).toBeUndefined()
    expect(transport).toHaveBeenCalledOnce()
  })
  it('drops valid HTTP evidence when cancellation wins before SDK settlement', async () => {
    const cancellation = new AbortController()
    const transport = vi.fn<typeof fetch>(async () => {
      cancellation.abort('synthetic caller cancellation')
      return responseFor(first)
    })
    vi.stubGlobal('fetch', transport)
    const chunks: StreamChunk[] = []
    for await (const chunk of adapterFor(first.request.model).stream({ provider: 'product', model: first.request.model,
      messages: [], signal: cancellation.signal })) chunks.push(chunk)
    expect(JSON.stringify(chunks)).not.toContain('textReselection')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    expect(transport).toHaveBeenCalledOnce()
  })
  it('does not infer zero-send evidence from a failed network request', async () => {
    const transport = vi.fn<typeof fetch>(async () => { throw new TypeError('synthetic fetch failure') })
    vi.stubGlobal('fetch', transport)
    const chunks = await stream(first)
    expect(JSON.stringify(chunks)).not.toContain('textReselection')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(transport).toHaveBeenCalledOnce()
  })
  it('retains the prepared account scope after the provider profile changes', async () => {
    const profile: PiAiProviderProfile = { api: 'openai-completions', baseURL: baseUrl, managedLimitsScope: scope,
      models: [{ id: first.request.model, managedLimits: { scope, contextWindow: 32768, maxTokens: 8192 } }] }
    let profiles = resolveProfiles({ product: profile })
    const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'synthetic-test-key', auth: memoryAuth() })
    const prepared = await adapter.prepareCall('product', first.request.model)
    profiles = resolveProfiles({ product: { ...profile, managedLimitsScope: 'other-account' } })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => responseFor(first)))
    const chunks: StreamChunk[] = []
    for await (const chunk of prepared.stream({ provider: 'product', model: first.request.model, messages: [] })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { textReselection: { managedScope: scope } } } })
  })
  it.each([{ mode: 'always' as const }, { mode: 'normal' as const, maxRetries: 5 }])(
    'disables generic retries only for the confined product route: $mode', (retryPolicy) => {
      expect(adapterFor(first.request.model, { retryPolicy }).providerRetryPolicy('product')).toMatchObject({ mode: 'normal', maxRetries: 0, retryableCodes: [] })
      expect(adapterFor(first.request.model, { retryPolicy, baseURL: 'https://custom.invalid/v1' }).providerRetryPolicy('product')).toMatchObject(retryPolicy)
    },
  )
})
