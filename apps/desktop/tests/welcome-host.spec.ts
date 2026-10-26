/** Native onboarding reuses authenticated Web RPC and never reads credential values. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectDesktopWelcome } from '../src/welcome-backend.ts'

function transport(preference?: string) {
  const keys = new Map<string, string>()
  const namespaces = [
    { ns: 'llm-deepseek', value: { apiKeyEnv: 'CUSTOM_DEEPSEEK_KEY' } },
    { ns: 'llm-pi-ai', value: { profiles: { example: { apiKeyEnv: 'EXAMPLE_API_KEY' } } } },
    { ns: 'locale', value: preference === undefined ? {} : { preference } },
  ]
  const productSession = { ok: true, signedIn: false }
  const send = vi.fn<Parameters<typeof connectDesktopWelcome>[1]>(async (input, init) => {
    if (new URL(input).pathname === '/credits/api/session') return Response.json(productSession)
    if (init?.method !== 'POST') return new Response('index')
    const { rpcId, method, payload } = JSON.parse(init.body as string) as {
      rpcId: string
      method: string
      payload: { args: { ref: string; value: string; refs: string[] } }
    }
    let value: unknown
    if (method === 'account/getState') value = { links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' }, status: 'signed-out', attempt: null }
    else if (method === 'settings/describe') value = { namespaces }
    else if (method === 'llm/listConfigurableProviders') value = [{ settingsNs: 'llm-pi-ai', settingsPath: ['profiles', 'example'] }]
    else if (method === 'productAnalytics/enabled') value = true
    else if (method === 'productAnalytics/report') value = undefined
    else if (method === 'credentials/set') keys.set(payload.args.ref, payload.args.value)
    else value = Object.fromEntries(payload.args.refs.map(ref => [ref, { configured: keys.has(ref), writable: true }]))
    return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } })
  })
  return { send, keys, namespaces, productSession }
}

const url = 'http://127.0.0.1:19387/?token=fixture'
afterEach(() => { vi.restoreAllMocks() })

describe('desktop welcome Web operations', () => {
  it('authenticates through Web and stores only through the configured credential reference', async () => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    expect(host.send).toHaveBeenCalledOnce()
    expect(host.send.mock.calls[0]![0]).toBe(url)
    expect(host.send.mock.calls[0]![1]).toMatchObject({ credentials: 'include' })
    expect(host.send.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal)
    expect(await backend.analyticsEnabled()).toBe(true)
    expect(await backend.save('sk-example')).toEqual({ ok: true })
    expect(host.keys.get('CUSTOM_DEEPSEEK_KEY')).toBe('sk-example')
    expect(await backend.read()).toEqual({ loggedIn: false, hasApiKey: false, writable: false, localePreference: null })
    for (const [input, init] of host.send.mock.calls.slice(1)) {
      expect(input).toMatch(/^http:\/\/127\.0\.0\.1:19387\/(api|credits\/api)\//u)
      expect(init).toMatchObject({ credentials: 'include', redirect: 'error' })
    }
  })

  it('reads the explicit language preference and product login independently of provider keys', async () => {
    const host = transport('zh')
    host.keys.set('EXAMPLE_API_KEY', 'sk-other')
    const backend = await connectDesktopWelcome(url, host.send)
    expect(await backend.read()).toMatchObject({ localePreference: 'zh', hasApiKey: false, loggedIn: false })
    host.productSession.signedIn = true
    expect(await backend.read()).toMatchObject({ loggedIn: true })
    host.keys.clear()
    expect(await backend.read()).toMatchObject({ hasApiKey: false })
    expect(host.send.mock.calls.every(([, init]) => !(init?.body as string | undefined)?.includes('credentials/set'))).toBe(true)
  })

  it('reads language without querying account or model providers', async () => {
    const host = transport('zh')
    const backend = await connectDesktopWelcome(url, host.send)
    host.send.mockClear()
    expect(await backend.readLocalePreference()).toBe('zh')
    expect(host.send).toHaveBeenCalledOnce()
    expect(host.send.mock.calls[0]![0]).toContain('/api/settings/describe')
  })

  it('uses product login in profiles without an official provider', async () => {
    const host = transport()
    host.namespaces.splice(0, 1)
    const backend = await connectDesktopWelcome(url, host.send)
    expect(await backend.read()).toMatchObject({ hasApiKey: false, writable: false })
    host.keys.set('EXAMPLE_API_KEY', 'custom-key')
    host.productSession.signedIn = true
    expect(await backend.read()).toMatchObject({ loggedIn: true, hasApiKey: false, writable: false })
    expect(await backend.save('official-key')).toEqual({ ok: false })
    expect(host.keys.has('undefined')).toBe(false)
  })

  it.each(['', 'bad key', 'key\n'])('rejects malformed keys without contacting a provider: %s', async (value) => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    host.send.mockClear()
    expect(await backend.save(value)).toEqual({ ok: false })
    expect(host.send).not.toHaveBeenCalled()
  })

  it('keeps provider diagnostics out of failures and rejects unmatched RPC envelopes', async () => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    host.send.mockRejectedValueOnce(new Error('private credential sk-must-not-leak'))
    expect(await backend.save('sk-example')).toEqual({ ok: false })
    host.send.mockResolvedValueOnce(Response.json({ type: 'server-response', rpcId: 'other', result: { ok: true } }))
    await expect(backend.read()).rejects.toThrow('Web RPC failed')
  })


  it('submits native analytics through authenticated RPC with a bounded request', async () => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    const event = { eventName: 'desktop_app_launch' as const, timestamp: 100, attributes: {} }
    await backend.report(event)
    const [input, init] = host.send.mock.calls.at(-1)!
    expect(input).toBe('http://127.0.0.1:19387/api/productAnalytics/report')
    expect(init?.credentials).toBe('include')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(init!.body as string)).toMatchObject({ payload: { args: { event } } })
  })

  it.each([new Response(null, { status: 401 }), Response.json({ ok: true, signedIn: 'yes' }), Response.json({ ok: false, signedIn: true })])('rejects unavailable or invalid product login facts', async (response) => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    host.send.mockImplementationOnce(async (_input, init) => {
      const { rpcId } = JSON.parse(init!.body as string) as { rpcId: string }
      return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: { namespaces: host.namespaces } } })
    }).mockResolvedValueOnce(response)
    await expect(backend.read()).rejects.toThrow(/product session/)
  })

  it.each(['network', 'timeout', 'rate_limited', 'upstream_unavailable', 'upstream_rejected', 'protocol',
    'identity_mismatch', 'renewal_unavailable', 'storage'] as const)('keeps an unverified saved session recoverable without signing out: %s', async (reason) => {
    const host = transport('zh')
    const backend = await connectDesktopWelcome(url, host.send)
    const send = host.send.getMockImplementation()!
    let unavailable = true
    host.send.mockImplementation((input, init) => new URL(input).pathname === '/credits/api/session' && unavailable
      ? Promise.resolve(Response.json({ ok: false, code: 'ACCOUNT_UNAVAILABLE', signedIn: true, liveness: 'unknown',
        failure: { reason, stage: 'account-read', status: 503 }, message: 'private upstream response' })) : send(input, init))
    expect(await backend.read()).toEqual({ loggedIn: false, hasApiKey: false, writable: false, localePreference: 'zh', sessionIssue: reason })
    expect(await backend.readLocalePreference()).toBe('zh')
    unavailable = false
    host.productSession.signedIn = true
    expect(await backend.read()).toEqual({ loggedIn: true, hasApiKey: false, writable: false, localePreference: 'zh' })
    expect(host.send.mock.calls.some(([, init]) => /signOut|credentials\/(?:set|delete)/u.test(typeof init?.body === 'string' ? init.body : ''))).toBe(false)
  })

  it.each([
    { code: 'ACCOUNT_NETWORK_ERROR', reason: 'network' },
    { code: 'ACCOUNT_TIMEOUT', reason: 'timeout', status: 408 },
    { code: 'ACCOUNT_RATE_LIMITED', reason: 'rate_limited', status: 429 },
    { code: 'ACCOUNT_AUTH_REQUIRED', reason: 'upstream_rejected', status: 401 },
    { code: 'ACCOUNT_ACCESS_DENIED', reason: 'upstream_rejected', status: 403 },
    { code: 'ACCOUNT_INVALID_RESPONSE', reason: 'protocol', status: 200 },
  ])('keeps the current account-read response recoverable: $code', async ({ code, reason, status }) => {
    const host = transport('zh')
    const send = host.send.getMockImplementation()!
    let unavailable = true
    host.send.mockImplementation((input, init) => new URL(input).pathname === '/credits/api/session' && unavailable
      ? Promise.resolve(Response.json({ ok: false, code, signedIn: true, liveness: 'unknown',
        failure: { reason, stage: 'account-read', ...status === undefined ? {} : { status } } })) : send(input, init))
    const backend = await connectDesktopWelcome(url, host.send)
    try {
      expect(await backend.read()).toMatchObject({ loggedIn: false, sessionIssue: reason, localePreference: 'zh' })
      unavailable = false
      host.productSession.signedIn = true
      expect(await backend.read()).toMatchObject({ loggedIn: true, localePreference: 'zh' })
      expect(host.send.mock.calls.some(([, init]) => /signOut|credentials\/(?:set|delete)/u.test(typeof init?.body === 'string' ? init.body : ''))).toBe(false)
    } finally { backend.dispose() }
  })

  it('accepts the legacy unknown-session response while refusing contradictory authentication claims', async () => {
    const host = transport()
    const send = host.send.getMockImplementation()!
    let product: unknown = { ok: false, code: 'ACCOUNT_UNAVAILABLE', signedIn: true, liveness: 'unknown' }
    host.send.mockImplementation((input, init) => new URL(input).pathname === '/credits/api/session' ? Promise.resolve(Response.json(product)) : send(input, init))
    const backend = await connectDesktopWelcome(url, host.send)
    expect(await backend.read()).toMatchObject({ loggedIn: false, sessionIssue: 'account_unavailable' })
    for (product of [{ ok: true, signedIn: true, liveness: 'unknown' },
      { ok: false, code: 'ACCOUNT_UNKNOWN_FAILURE', signedIn: true, liveness: 'unknown' },
      { ok: false, code: 'ACCOUNT_UNAVAILABLE', signedIn: false, liveness: 'unknown' },
      { ok: false, code: 'ACCOUNT_UNAVAILABLE', signedIn: true, liveness: 'unknown', failure: { reason: 'not-a-code', stage: 'renewal' } }]) {
      await expect(backend.read()).rejects.toThrow('invalid product session')
    }
  })

  it('contains local session transport failures, retries explicitly, and reads locale independently', async () => {
    const host = transport('en')
    const send = host.send.getMockImplementation()!
    let fail = true
    host.send.mockImplementation((input, init) => new URL(input).pathname === '/credits/api/session' && fail
      ? Promise.reject(new Error('private transport detail')) : send(input, init))
    const backend = await connectDesktopWelcome(url, host.send)
    expect(await backend.readLocalePreference()).toBe('en')
    expect(await backend.read()).toMatchObject({ loggedIn: false, sessionIssue: 'network', localePreference: 'en' })
    fail = false
    host.productSession.signedIn = true
    expect(await backend.read()).toMatchObject({ loggedIn: true })
    const request = host.send.mock.calls.find(([input]) => new URL(input).pathname === '/credits/api/session')!
    expect(request[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('keeps the system locale and recovery actions available after initial local authentication transport failure', async () => {
    const host = transport()
    host.send.mockRejectedValueOnce(new Error('offline'))
    const backend = await connectDesktopWelcome(url, host.send)
    expect(await backend.read()).toMatchObject({ loggedIn: false, localePreference: null, sessionIssue: 'network' })
    expect(await backend.read()).toMatchObject({ loggedIn: false })
  })

  it('bounds a session read and aborts pending work when its native owner is disposed', async () => {
    const host = transport()
    const send = host.send.getMockImplementation()!
    const started = Promise.withResolvers<undefined>()
    host.send.mockImplementation((input, init) => {
      if (new URL(input).pathname !== '/credits/api/session') return send(input, init)
      started.resolve(undefined)
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => {
          const reason: unknown = init!.signal!.reason
          reject(reason instanceof Error ? reason : new Error('fixture request aborted'))
        }, { once: true })
      })
    })
    const backend = await connectDesktopWelcome(url, host.send)
    const reading = backend.read()
    await started.promise
    backend.dispose()
    expect(await reading).toMatchObject({ loggedIn: false, sessionIssue: 'timeout' })
  })

  it('contains an interrupted settings body while keeping malformed settings fatal', async () => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    host.send.mockResolvedValueOnce({ ok: true, json: () => Promise.reject(new TypeError('connection reset')) } as Response)
    expect(await backend.read()).toMatchObject({ loggedIn: false, localePreference: null })
    host.send.mockResolvedValueOnce(Response.json({ type: 'server-response', result: { ok: true, value: null } }))
    await expect(backend.read()).rejects.toThrow('Web RPC failed')
  })

  it('forwards only native activity through the authenticated local Host', async () => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    host.send.mockResolvedValueOnce(Response.json({ ok: true }))
    const signal = AbortSignal.timeout(1000)
    const sample = { session_id: '01234567-89ab-4cde-8fab-0123456789ab', event: 'heartbeat' as const,
      foreground: false, platform: 'win32' as const, app_version: '1.2.3' }
    await backend.activity(sample, signal)
    expect(host.send.mock.lastCall).toEqual(['http://127.0.0.1:19387/credits/api/activity', {
      method: 'POST', credentials: 'include', redirect: 'error', signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample),
    }])
    host.send.mockResolvedValueOnce(new Response(null, { status: 404 }))
    await expect(backend.activity(sample, signal)).rejects.toThrow('Host unavailable')
  })

  it('refuses an unauthenticated Web launch', async () => {
    const send = vi.fn<Parameters<typeof connectDesktopWelcome>[1]>(async () => new Response(null, { status: 401 }))
    await expect(connectDesktopWelcome(url, send)).rejects.toThrow('Web authentication failed')
  })
})
