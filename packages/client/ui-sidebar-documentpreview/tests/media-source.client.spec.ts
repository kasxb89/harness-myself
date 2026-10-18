/** Native media URLs preserve file names, Range delivery, and existing authorization scopes. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mediaUrl, resolveMediaSource } from '../src/client/media/source.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('streamed media sources', () => {
  it('encodes a Windows path and version without corrupting spaces, Unicode, or fragments', () => {
    const path = 'D:\\云枢\\media\\角色 #1.mp4'
    const url = new URL(mediaUrl(path, 'version #2', 'workspace-one'), 'https://app.invalid')
    expect(url.pathname).toBe('/artifacts/api/raw')
    expect(url.searchParams.get('path')).toBe(path)
    expect(url.searchParams.get('version')).toBe('version #2')
    expect(url.searchParams.get('workspaceId')).toBe('workspace-one')
    expect(url.hash).toBe('')
  })

  it('uses HEAD to authorize managed output without downloading its body', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const signal = new AbortController().signal
    expect(await resolveMediaSource('/managed/long.mp4', 'v1', 'workspace-one', signal)).toBe(mediaUrl('/managed/long.mp4', 'v1'))
    expect(fetch).toHaveBeenCalledExactlyOnceWith(mediaUrl('/managed/long.mp4', 'v1'), {
      method: 'HEAD', signal, credentials: 'same-origin', cache: 'no-store',
    })
  })

  it.each([403, 404])('uses the real Workspace scope after a managed-root %s response', async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const signal = new AbortController().signal
    const url = await resolveMediaSource('/mounted/long.mp4', 'v2', 'workspace-one', signal)
    expect(url).toBe(mediaUrl('/mounted/long.mp4', 'v2', 'workspace-one'))
    expect(fetch.mock.calls[1]?.[0]).toBe(url)
  })

  it.each([401, 500])('does not change authorization scopes after a %s response', async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status }))
    vi.stubGlobal('fetch', fetch)
    expect(await resolveMediaSource('/file.mp4', 'v1', 'workspace-one', new AbortController().signal)).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not invent a Workspace when the addressed Session has no membership', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 403 }))
    vi.stubGlobal('fetch', fetch)
    expect(await resolveMediaSource('/file.mp4', 'v1', undefined, new AbortController().signal)).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('returns no stream after denial, a transport failure, or cancellation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    expect(await resolveMediaSource('/file.mp4', 'v1', 'workspace-one', controller.signal)).toBeUndefined()
    expect(await resolveMediaSource('/file.mp4', 'v1', undefined, controller.signal)).toBeUndefined()
    controller.abort()
    expect(await resolveMediaSource('/file.mp4', 'v1', undefined, controller.signal)).toBeUndefined()
  })
})
