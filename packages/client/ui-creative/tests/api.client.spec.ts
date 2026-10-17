import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { readCreativeProjects } from '../src/client/api.ts'
import { mediaUrl, project } from './fixtures.ts'

afterEach(() => { vi.unstubAllGlobals() })
const SESSION = 'session-a' as SessionId

describe('creative project transport', () => {
  it('addresses the exact conversation and validates real saved media routes', async () => {
    const data = { ...project(), outputs: [{ id: 'out1', kind: 'video', name: 'scene.mp4', url: mediaUrl(),
      frames: [{ url: `${mediaUrl()}&frame=0`, timeSeconds: 15.633 }] }] }
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true, payload: { accountId: 'account-a', projects: [data] } }))
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    expect(await readCreativeProjects(SESSION, signal)).toEqual({ ok: true, payload: { accountId: 'account-a', projects: [data] } })
    expect(fetcher).toHaveBeenCalledWith('/credits/api/creative/projects?session_id=session-a', expect.objectContaining({
      signal, credentials: 'same-origin', cache: 'no-store',
    }))
  })
  it.each([
    '/private/cache/image.png', 'https://external.example/image.png', '//external.example/image.png',
    '/credits/api/creative/media-other?file=a', '/credits/api/creative/media?file=a#fragment',
    mediaUrl('another-project'), mediaUrl().replace('session-a', 'another-session'),
    `${mediaUrl()}&session_id=session-a`, `${mediaUrl()}&frame=poster`,
  ])('rejects an unauthorized media destination: %s', async (url) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, payload: { accountId: 'account-a',
      projects: [{ ...project(), outputs: [{ id: 'out1', kind: 'image', name: 'x.png', url }] }] } })))
    expect(await readCreativeProjects(SESSION, new AbortController().signal)).toEqual({ ok: false, code: 'invalid' })
  })
  it.each([
    { projects: null }, { accountId: 1, projects: [] },
    { accountId: 'account-a', projects: [{ ...project(), shots: [{ id: 's1' }] }] },
    { accountId: 'account-a', projects: [{ ...project(), characters: [null] }] },
    { accountId: 'account-a', projects: [{ ...project(), status: 'success' }] },
  ])('rejects malformed wire project fields', async (payload) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, payload })))
    expect(await readCreativeProjects(SESSION, new AbortController().signal)).toEqual({ ok: false, code: 'invalid' })
  })
  it('keeps signed-out, unavailable and malformed responses distinct', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ ok: false }, { status: 503 }))
      .mockResolvedValueOnce(new Response('{'))
      .mockRejectedValueOnce(new Error('private transport details'))
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    expect(await readCreativeProjects(SESSION, signal)).toEqual({ ok: false, code: 'signed-out' })
    for (let i = 0; i < 3; i++) expect(await readCreativeProjects(SESSION, signal)).toEqual({ ok: false, code: 'unavailable' })
  })

  it('accepts optional material output receipts and rejects mismatched or malformed ones', async () => {
    const data = project()
    const material = { ...data.assets[0]!, status: 'completed', outputs: [{ id: 'out1', kind: 'image', name: 'reference.png', url: mediaUrl() }] }
    const payload = (asset: unknown) => ({ ok: true, payload: { accountId: 'account-a', projects: [{ ...data, assets: [asset] }] } })
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(payload(material)))
      .mockResolvedValueOnce(Response.json(payload({ ...material, status: 'success' })))
      .mockResolvedValueOnce(Response.json(payload({ ...material, outputs: [{ ...material.outputs[0], url: mediaUrl('other-project') }] })))
      .mockResolvedValueOnce(Response.json(payload({ ...material, outputs: null })))
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    expect(await readCreativeProjects(SESSION, signal)).toEqual({ ok: true, payload: { accountId: 'account-a',
      projects: [{ ...data, assets: [material] }] } })
    for (let i = 0; i < 3; i++) expect(await readCreativeProjects(SESSION, signal)).toEqual({ ok: false, code: 'invalid' })
  })
})
