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

describe('free plan editing and uploaded references', () => {
  it('sends exact CAS coordinates and distinguishes conflicting revisions without retrying', async () => {
    const { saveCreativePlan } = await import('../src/client/api.ts')
    const data = project()
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, payload: { accountId: 'account-a', projects: [data] } }))
      .mockResolvedValueOnce(Response.json({ ok: false, code: 'CREATIVE_PLAN_STALE' }, { status: 409 }))
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    const request = { sessionId: SESSION, projectId: data.id, expectedRevision: data.planRevision,
      change: { kind: 'reorder' as const, shotIds: ['s1'] } }
    expect((await saveCreativePlan(request, signal)).ok).toBe(true)
    expect(fetcher).toHaveBeenCalledWith('/credits/api/creative/plan', expect.objectContaining({ method: 'POST', signal,
      body: JSON.stringify({ session_id: SESSION, project_id: data.id, expected_revision: 'revision-1', change: request.change }) }))
    expect(await saveCreativePlan(request, signal)).toEqual({ ok: false, code: 'stale' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([
    { sessionId: 'other' }, { planRevision: 1 }, { completedShots: 2, totalShots: 1 },
    { tasks: [{ id: 'task', status: 'running', shotIds: [], completedShots: -1, totalShots: 1, outputs: [] }] },
    { tasks: [{ id: 'task', status: 'completed', shotIds: ['s1'], completedShots: 1, totalShots: 1,
      outputs: [{ id: 'out1', kind: 'video', name: 'bad.mp4', url: 'https://untrusted.example/secret' }] }] },
  ])('rejects mismatched session, revision, progress or task output facts', async (invalid) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true,
      payload: { accountId: 'account-a', projects: [{ ...project(), ...invalid }] } })))
    expect(await readCreativeProjects(SESSION, new AbortController().signal)).toEqual({ ok: false, code: 'invalid' })
  })

  it('accepts only the exact owner-checked uploaded reference route', async () => {
    const data = project()
    const url = '/credits/api/creative/reference?session_id=session-a&project_id=cp_rain&asset_id=station'
    for (const referenceUrl of [url, url.replace('station', 'other'), 'https://external.example/image.png']) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, payload: { accountId: 'account-a', projects: [
        project({ assets: [{ ...data.assets[0]!, referenceUrl }] }),
      ] } })))
      const result = await readCreativeProjects(SESSION, new AbortController().signal)
      expect(result.ok).toBe(referenceUrl === url)
    }
  })

  it('uploads actual bytes with an idempotency key and accepts only an opaque material id', async () => {
    const { uploadCreativeAsset } = await import('../src/client/api.ts')
    const file = new File(['image'], '人物.png', { type: 'image/png' })
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, asset: { assetId: 'ma_reference' } }))
      .mockResolvedValueOnce(Response.json({ ok: true, asset: { assetId: 'https://untrusted.example/source' } }))
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    expect(await uploadCreativeAsset(file, signal)).toEqual({ ok: true, assetId: 'ma_reference', kind: 'image' })
    expect(fetcher).toHaveBeenCalledWith('/credits/api/assets', expect.objectContaining({ signal, body: file }))
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers)
    expect(headers.get('content-type')).toBe('image/png')
    expect(headers.get('x-file-name')).toBe(encodeURIComponent('人物.png'))
    expect(headers.get('x-idempotency-key')).toMatch(/^yunshu-asset-/u)
    expect(await uploadCreativeAsset(file, signal)).toEqual({ ok: false })
    expect(await uploadCreativeAsset(new File([], 'empty.png', { type: 'image/png' }), signal)).toEqual({ ok: false })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
