import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseUsageWindow, readAccountUsage, type UsageReadOptions } from '../src/usage.ts'

let root: string | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const start = 1_792_000_800
const end = start + 86_399
const usage = { user_id: 7, username: 'alice', created_at: start, model_name: 'image-model', count: 2, quota: 1, token_used: 15 }

async function options(upstreamToken: string | undefined = 'user-token'): Promise<UsageReadOptions> {
  root = await mkdtemp(join(tmpdir(), 'dsh-account-usage-'))
  const adminTokenFile = join(root, 'admin-token')
  await writeFile(adminTokenFile, 'read-only-test-token', { mode: 0o600 })
  return {
    start, end, baseUrl: 'http://127.0.0.1:3000', timeoutMs: 500,
    creditsPerYuan: 1000, adminTokenFile, account: { id: '7', phone: '+8613800000000' }, upstreamToken,
  }
}

function mockSource(overrides: Record<string, unknown> = {}) {
  const calls: { path: string; token: string | null }[] = []
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    calls.push({ path: `${url.pathname}${url.search}`, token: new Headers(init?.headers).get('authorization') })
    let body: unknown
    if (url.pathname === '/api/user/self') body = { success: true, data: { id: 7 } }
    else if (url.pathname === '/api/data/self' || url.pathname === '/api/data/') body = { success: true, data: [usage] }
    else if (url.pathname === '/api/user/search') body = { success: true, data: { items: [{ id: 8, username: 'other' }, { id: 7, username: 'alice' }] } }
    else if (url.pathname === '/api/status') body = { success: true, data: { enable_data_export: true, quota_per_unit: 500_000, usd_exchange_rate: 7.3 } }
    else throw new Error('unexpected path')
    if (url.pathname in overrides) body = overrides[url.pathname]
    if (body instanceof Error) throw body
    if (body instanceof Response) return body
    return new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal('fetch', fetcher)
  return { calls, fetcher }
}

describe('usage window validation', () => {
  it('accepts exactly 31 inclusive days without choosing a timezone', () => {
    expect(parseUsageWindow(new URLSearchParams({ start: String(start), end: String(start + 31 * 86_400 - 1) })))
      .toEqual({ ok: true, window: { start, end: start + 31 * 86_400 - 1 } })
  })

  it.each([
    '', 'start=1', 'start=1&end=2&userId=7', 'start=1&end=2&username=alice',
    'start=1&start=2&end=3', 'start=0&end=1', 'start=-1&end=2', 'start=1.5&end=2',
    'start=1e3&end=2000', 'start=2&end=1', 'start=1&end=2678401',
    'start=1&end=9007199254740992', 'start=1&end=253402300800',
  ])('rejects invalid or account-selecting parameters: %s', (query) => {
    expect(parseUsageWindow(new URLSearchParams(query))).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
  })
})

describe('readAccountUsage', () => {
  it('reads the verified user and converts every row with one live rate without rounding', async () => {
    const { calls } = mockSource()
    const result = await readAccountUsage(await options())
    expect(result).toMatchObject({
      ok: true,
      payload: { start, end, delayMinutes: 5, rows: [{ timestamp: start, model: 'image-model', billingRecords: 2, consumedPoints: 0.0146, totalTokens: 15 }] },
    })
    expect(calls.map(call => call.path.split('?')[0])).toEqual(['/api/user/self', '/api/data/self', '/api/status'])
    expect(calls[1]?.token).toBe('Bearer user-token')
  })

  it.each([undefined, 'expired-user-token'])('falls back through the exact account when upstream is %s', async (token) => {
    const { calls } = mockSource({ '/api/user/self': { success: false } })
    expect(await readAccountUsage({ ...await options(), upstreamToken: token })).toMatchObject({ ok: true })
    const adminRead = calls.find(call => call.path.startsWith('/api/data/?'))
    expect(adminRead?.path).toContain('username=alice')
    expect(adminRead?.token).toBe('Bearer read-only-test-token')
    expect(calls.some(call => call.path.startsWith('/api/data/self'))).toBe(false)
  })

  it('rejects a self token belonging to another account', async () => {
    const { calls } = mockSource({ '/api/user/self': { success: true, data: { id: 8 } } })
    expect(await readAccountUsage(await options())).toMatchObject({ ok: false, code: 'USAGE_IDENTITY_MISMATCH' })
    expect(calls).toHaveLength(1)
  })

  it('does not use the first fuzzy account search result or the admin own usage', async () => {
    const { calls } = mockSource({
      '/api/user/self': { success: false },
      '/api/user/search': { success: true, data: { items: [{ id: 8, username: 'other' }] } },
    })
    expect(await readAccountUsage(await options())).toMatchObject({ ok: false, code: 'USAGE_UNAVAILABLE' })
    expect(calls.some(call => call.path.startsWith('/api/data/'))).toBe(false)
  })

  it('reports a denied admin usage read without exposing the upstream permission message', async () => {
    mockSource({
      '/api/user/self': { success: false },
      '/api/data/': new Response(JSON.stringify({ message: 'The access token lacks the required permission: log:read' }), { status: 403 }),
    })
    const result = await readAccountUsage(await options())
    expect(result).toMatchObject({ ok: false, code: 'USAGE_ACCESS_DENIED' })
    expect(JSON.stringify(result)).not.toContain('log:read')
    expect(JSON.stringify(result)).not.toContain('read-only-test-token')
    expect(result).not.toHaveProperty('payload')
  })

  it('keeps permission denial visible if the self endpoint is denied and no admin credential exists', async () => {
    mockSource({ '/api/user/self': new Response('{}', { status: 403 }) })
    const config = await options()
    await rm(config.adminTokenFile)
    expect(await readAccountUsage(config)).toMatchObject({ ok: false, code: 'USAGE_ACCESS_DENIED' })
  })

  it('permits an authorized same-account fallback after a denied self read', async () => {
    const { calls } = mockSource({ '/api/data/self': new Response('{}', { status: 403 }) })
    expect(await readAccountUsage(await options())).toMatchObject({ ok: true })
    expect(calls.find(call => call.path.startsWith('/api/data/?'))?.path).toContain('username=alice')
  })

  it('reports permission denial during account lookup', async () => {
    mockSource({
      '/api/user/self': { success: false },
      '/api/user/search': new Response('{}', { status: 403 }),
    })
    expect(await readAccountUsage(await options())).toMatchObject({ ok: false, code: 'USAGE_ACCESS_DENIED' })
  })

  it('resolves a legacy nonnumeric ID only from one exact canonical phone match', async () => {
    const { calls } = mockSource({
      '/api/user/search': { success: true, data: { items: [
        { id: 8, username: 'other', phone_e164: '+8613800000001' },
        { id: 7, username: 'alice', phone_e164: '+8613800000000' },
      ] } },
    })
    const config = await options()
    const account = { id: 'legacy-phone-session', phone: config.account.phone }
    expect(await readAccountUsage({ ...config, account, upstreamToken: undefined })).toMatchObject({ ok: true })
    expect(account.id).toBe('legacy-phone-session')
    expect(calls.find(call => call.path.startsWith('/api/data/?'))?.path).toContain('username=alice')
    expect(calls.filter(call => call.path.startsWith('/api/user/search'))).toHaveLength(1)
  })

  it('verifies the upstream token against the canonical legacy account before reading self usage', async () => {
    const { calls } = mockSource({
      '/api/user/search': { success: true, data: { items: [{ id: 7, username: 'alice', phone_e164: '+8613800000000' }] } },
      '/api/user/self': { success: true, data: { id: 7, phone_e164: '+8613800000000' } },
    })
    const config = await options()
    expect(await readAccountUsage({ ...config, account: { ...config.account, id: 'legacy-id' } })).toMatchObject({ ok: true })
    expect(calls.find(call => call.path.startsWith('/api/data/self'))?.token).toBe('Bearer user-token')
    expect(calls.some(call => call.path.startsWith('/api/data/?'))).toBe(false)
  })

  it.each([
    { items: [{ id: 7, username: 'alice', phone_e164: '+8613800000001' }] },
    { items: [{ id: 7, username: 'alice' }] },
    { items: [{ id: 7, username: 'alice', phone_e164: '+8613800000000' }, { id: 8, username: 'other', phone_e164: '+8613800000000' }] },
  ])('rejects missing, fuzzy, or ambiguous legacy phone identity: %j', async ({ items }) => {
    const { calls } = mockSource({ '/api/user/search': { success: true, data: { items } } })
    const config = await options()
    expect(await readAccountUsage({ ...config, account: { ...config.account, id: 'legacy-id' } }))
      .toMatchObject({ ok: false, code: 'USAGE_UNAVAILABLE' })
    expect(calls.some(call => call.path.startsWith('/api/data/'))).toBe(false)
  })

  it('rejects a foreign upstream token after a legacy identity is canonicalized', async () => {
    const { calls } = mockSource({
      '/api/user/search': { success: true, data: { items: [{ id: 7, username: 'alice', phone_e164: '+8613800000000' }] } },
      '/api/user/self': { success: true, data: { id: 8, phone_e164: '+8613800000001' } },
    })
    const config = await options()
    expect(await readAccountUsage({ ...config, account: { ...config.account, id: 'legacy-id' } }))
      .toMatchObject({ ok: false, code: 'USAGE_IDENTITY_MISMATCH' })
    expect(calls.some(call => call.path.startsWith('/api/data/'))).toBe(false)
  })

  it('does not replace a valid stored ID with a different exact-phone account', async () => {
    const { calls } = mockSource({
      '/api/user/self': { success: false },
      '/api/user/search': { success: true, data: { items: [{ id: 8, username: 'other', phone_e164: '+8613800000000' }] } },
    })
    expect(await readAccountUsage(await options())).toMatchObject({ ok: false, code: 'USAGE_UNAVAILABLE' })
    expect(calls.some(call => call.path.startsWith('/api/data/'))).toBe(false)
  })

  it('returns a real empty dataset only when the enabled source succeeds', async () => {
    mockSource({ '/api/data/self': { success: true, data: [] } })
    expect(await readAccountUsage(await options())).toMatchObject({ ok: true, payload: { rows: [] } })
  })

  it('preserves empty model names for the client unlabelled-model group', async () => {
    mockSource({ '/api/data/self': { success: true, data: [{ ...usage, model_name: '' }] } })
    expect(await readAccountUsage(await options())).toMatchObject({
      ok: true, payload: { rows: [{ model: '', billingRecords: 2, consumedPoints: 0.0146, totalTokens: 15 }] },
    })
  })

  it('reports disabled collection without claiming zero usage', async () => {
    mockSource({ '/api/status': { success: true, data: { enable_data_export: false } } })
    expect(await readAccountUsage(await options())).toMatchObject({ ok: false, code: 'USAGE_UNAVAILABLE' })
  })

  it('keeps permission denial distinguishable from missing conversion settings', async () => {
    mockSource({ '/api/status': new Response('{}', { status: 403 }) })
    expect(await readAccountUsage(await options())).toMatchObject({ ok: false, code: 'USAGE_ACCESS_DENIED' })
  })

  it.each([
    { success: true, data: { enable_data_export: true, quota_per_unit: 0, usd_exchange_rate: 7.3 } },
    { success: true, data: { enable_data_export: true, quota_per_unit: 500_000 } },
    new Error('unreachable'),
  ])('does not guess a conversion when status is unavailable: %j', async (status) => {
    mockSource({ '/api/status': status })
    expect(await readAccountUsage(await options())).toMatchObject({ ok: false, code: 'USAGE_CONVERSION_UNAVAILABLE' })
  })

  it.each([
    { ...usage, created_at: end + 1 }, { ...usage, count: -1 }, { ...usage, token_used: 0.5 },
    { ...usage, quota: null }, { ...usage, model_name: null }, { ...usage, user_id: 8 },
  ])('rejects incomplete, foreign, or out-of-window source rows: %j', async (row) => {
    mockSource({ '/api/data/self': { success: true, data: [usage, row] } })
    const result = await readAccountUsage(await options())
    expect(result).toMatchObject({ ok: false, code: 'USAGE_INVALID_DATA' })
    expect(result).not.toHaveProperty('payload')
  })

  it('keeps an unconfigured read-only credential unavailable', async () => {
    mockSource({ '/api/user/self': new Error('credential expired') })
    const config = await options()
    await rm(config.adminTokenFile)
    expect(await readAccountUsage(config)).toMatchObject({ ok: false, code: 'USAGE_UNAVAILABLE' })
  })
})
