import { describe, expect, it, vi } from 'vitest'
import { resolveDesktopUpdateConfigOrigin, resolveDesktopUpdateSource } from '../src/update-source.ts'

const options = { origin: 'https://api.example.com', platform: 'darwin', arch: 'arm64', allowLoopbackHttp: false } as const
const feeds = { 'mac-arm64': 'https://updates.example.com/mac-arm64/', 'mac-x64': 'https://updates.example.com/mac-x64/', 'win-x64': 'https://updates.example.com/win-x64/' }
const response = (desktop_update: unknown) => Response.json({ success: true, data: { desktop_update } })
const enabled = { enabled: true, channel: 'nightly', feeds }

it('binds packaged authority to the manifest and development authority to explicit child environment', () => {
  const env = { DSH_DESKTOP_UPDATE_CONFIG_ORIGIN: 'http://127.0.0.1:3000' }
  expect(resolveDesktopUpdateConfigOrigin(true, { dshDesktopUpdateConfigOrigin: options.origin }, env)).toBe(options.origin)
  expect(resolveDesktopUpdateConfigOrigin(true, {}, env)).toBeUndefined()
  expect(resolveDesktopUpdateConfigOrigin(false, {}, env)).toBe(env.DSH_DESKTOP_UPDATE_CONFIG_ORIGIN)
})

it('fetches anonymously without redirects and selects only the current target from data.desktop_update', async () => {
  const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response(enabled))
  await expect(resolveDesktopUpdateSource(options, fetcher)).resolves.toEqual({ url: feeds['mac-arm64'], channel: 'nightly' })
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  expect(fetcher).toHaveBeenCalledWith('https://api.example.com/api/status', expect.objectContaining({ redirect: 'error', credentials: 'omit', cache: 'no-store' }))
  await expect(resolveDesktopUpdateSource({ ...options, platform: 'win32', arch: 'x64' }, async () => response(enabled)))
    .resolves.toMatchObject({ url: feeds['win-x64'] })
})

describe('untrusted source configuration', () => {
  it.each(['http://updates.example.com/', 'https://user:pass@example.com/', 'https://example.com/?token=secret',
    'https://example.com/#a', 'https://example.com/?', 'https://example.com/#', 'https:example.com/', 'https://example.com/path\\dir/', 'https://example.com/a\nb/', 'https://example.com/nightly.yml',
    'https://example.com/%0a/', 'file:///tmp/'])('rejects unsafe feed %s', async (url) => {
    await expect(resolveDesktopUpdateSource(options, async () => response({ ...enabled, feeds: { ...feeds, 'mac-arm64': url } })))
      .rejects.toMatchObject({ kind: 'source-invalid' })
  })
  it.each(['http://api.example.com', 'https://api.example.com/path', 'https://u:p@api.example.com', 'https://api.example.com/?secret=1', 'https://api.example.com\\evil'])
  ('rejects unsafe authority %s before any request', async (origin) => {
    const fetcher = vi.fn()
    await expect(resolveDesktopUpdateSource({ ...options, origin }, fetcher)).rejects.toMatchObject({ kind: 'source-invalid' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('permits loopback HTTP only for explicit development/test configuration', async () => {
    const local = { ...options, origin: 'http://127.0.0.1:3000', allowLoopbackHttp: true }
    const config = { ...enabled, feeds: { ...feeds, 'mac-arm64': 'http://127.0.0.1:4000/feed/' } }
    await expect(resolveDesktopUpdateSource(local, async () => response(config))).resolves.toMatchObject({ url: config.feeds['mac-arm64'] })
    await expect(resolveDesktopUpdateSource({ ...local, allowLoopbackHttp: false }, vi.fn())).rejects.toMatchObject({ kind: 'source-invalid' })
    await expect(resolveDesktopUpdateSource({ ...local, origin: 'http://192.168.1.5' }, vi.fn())).rejects.toMatchObject({ kind: 'source-invalid' })
  })
  it('distinguishes unbound, disabled, missing target, unsupported target, malformed and offline states', async () => {
    await expect(resolveDesktopUpdateSource({ ...options, origin: undefined }, vi.fn())).rejects.toMatchObject({ kind: 'source-unbound' })
    await expect(resolveDesktopUpdateSource(options, async () => response({ ...enabled, enabled: false }))).rejects.toMatchObject({ kind: 'source-disabled' })
    await expect(resolveDesktopUpdateSource(options, async () => response({ ...enabled, feeds: { ...feeds, 'mac-arm64': '' } }))).rejects.toMatchObject({ kind: 'source-target-missing' })
    await expect(resolveDesktopUpdateSource({ ...options, platform: 'linux' }, vi.fn())).rejects.toMatchObject({ kind: 'source-unsupported-target' })
    await expect(resolveDesktopUpdateSource(options, async () => Response.json({ desktop_update: enabled }))).rejects.toMatchObject({ kind: 'source-invalid' })
    await expect(resolveDesktopUpdateSource(options, async () => response({ ...enabled, channel: 'latest' }))).rejects.toMatchObject({ kind: 'source-invalid' })
    await expect(resolveDesktopUpdateSource(options, async () => { throw new Error('private URL') })).rejects.toMatchObject({ kind: 'source-unavailable', message: 'source-unavailable' })
  })
  it('rejects oversized and redirected responses without exposing response text', async () => {
    await expect(resolveDesktopUpdateSource(options, async () => new Response('x'.repeat(524_289)))).rejects.toMatchObject({ kind: 'source-invalid' })
    await expect(resolveDesktopUpdateSource(options, async () => new Response('', { status: 302, headers: { location: 'https://evil.example' } })))
      .rejects.toMatchObject({ kind: 'source-unavailable' })
  })
})


it('aborts a stalled status request at its total deadline', async () => {
  vi.useFakeTimers()
  try {
    const fetcher = vi.fn(async (
      _input: string | URL | Request, init?: RequestInit,
    ): Promise<Response> => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    }))
    const checked = expect(resolveDesktopUpdateSource(options, fetcher)).rejects.toMatchObject({ kind: 'source-unavailable' })
    await vi.advanceTimersByTimeAsync(8_000)
    await checked
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  } finally { vi.useRealTimers() }
})


it('normalizes a directory without a trailing slash without dropping its last path segment', async () => {
  await expect(resolveDesktopUpdateSource(options, async () => response({ ...enabled, feeds: { ...feeds, 'mac-arm64': 'https://updates.example.com/mac-arm64' } })))
    .resolves.toMatchObject({ url: 'https://updates.example.com/mac-arm64/' })
})
