// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installSkill, readInstalledSkills, readRecommendedSkills, searchSkills } from '../src/client/api.ts'
import type { InstalledSkill, SkillHubSkill } from '../src/types.ts'

const skill: SkillHubSkill = { slug: '@community/review', name: 'Review', description: 'Review changes', version: '1.2.0', source: 'SkillHub' }
const installed: InstalledSkill = { slug: skill.slug, name: skill.name, version: skill.version, installedAt: '2026-10-16T12:00:00Z' }

afterEach(() => { vi.unstubAllGlobals() })

function respond(body: unknown, status = 200) {
  const fetch = vi.fn(async (_request: Request) => Response.json(body, { status }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('SkillHub same-origin requests', () => {
  it('reads official recommendations without a query or an installation request', async () => {
    const fetch = respond({ ok: true, skills: [skill] })
    const controller = new AbortController()
    expect(await readRecommendedSkills(controller.signal)).toEqual({ ok: true, skills: [skill] })
    const request = fetch.mock.calls[0]![0]
    const url = new URL(request.url)
    expect(url.origin).toBe(window.location.origin)
    expect(url.pathname).toBe('/api/skillhub/recommendations')
    expect(url.search).toBe('')
    expect(request.method).toBe('GET')
    expect(request.credentials).toBe('same-origin')
    expect(request.cache).toBe('no-store')
    controller.abort()
    expect(request.signal.aborted).toBe(true)
  })

  it('contains recommendation failures and rejects malformed cards', async () => {
    const fetch = respond({ ok: false, code: 'recommendations-failed' }, 502)
    expect(await readRecommendedSkills(new AbortController().signal)).toEqual({ ok: false, code: 'recommendations-failed' })
    fetch.mockResolvedValueOnce(Response.json({ ok: true, skills: [{ ...skill, description: null }] }))
    expect(await readRecommendedSkills(new AbortController().signal)).toEqual({ ok: false, code: 'unexpected' })
    fetch.mockResolvedValueOnce(Response.json({ ok: true, skills: [] }))
    expect(await readRecommendedSkills(new AbortController().signal)).toEqual({ ok: true, skills: [] })
  })

  it('encodes an explicit search while preserving the canonical skill identity', async () => {
    const fetch = respond({ ok: true, skills: [skill] })
    const controller = new AbortController()
    expect(await searchSkills('  review & code  ', controller.signal)).toEqual({ ok: true, skills: [skill] })
    const request = fetch.mock.calls[0]![0]
    expect(new URL(request.url).origin).toBe(window.location.origin)
    expect(new URL(request.url).pathname).toBe('/api/skillhub/search')
    expect(new URL(request.url).searchParams.get('q')).toBe('review & code')
    expect(request.method).toBe('GET')
    expect(request.credentials).toBe('same-origin')
    expect(request.cache).toBe('no-store')
    controller.abort()
    expect(request.signal.aborted).toBe(true)
  })

  it('does not request an empty search or a pre-cancelled operation', async () => {
    const fetch = respond({ ok: true, skills: [] })
    expect(await searchSkills('   ', new AbortController().signal)).toEqual({ ok: false, code: 'invalid-request' })
    const controller = new AbortController()
    controller.abort()
    expect(await readInstalledSkills(controller.signal)).toEqual({ ok: false, code: 'cancelled' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('loads installed skills and posts only the selected slug without force', async () => {
    const fetch = respond({ ok: true, skills: [installed] })
    expect(await readInstalledSkills(new AbortController().signal)).toEqual({ ok: true, skills: [installed] })
    expect(new URL(fetch.mock.calls[0]![0].url).pathname).toBe('/api/skillhub/installed')
    fetch.mockResolvedValueOnce(Response.json({ ok: true, skill: installed }))
    expect(await installSkill(skill.slug, new AbortController().signal)).toEqual({ ok: true, skill: installed })
    const request = fetch.mock.calls[1]![0]
    expect(new URL(request.url).pathname).toBe('/api/skillhub/install')
    expect(request.method).toBe('POST')
    expect(request.headers.get('content-type')).toBe('application/json')
    expect(await request.json()).toEqual({ slug: '@community/review' })
  })

  it.each([
    { body: { ok: false, code: 'timeout' }, status: 504, expected: 'timeout' },
    { body: { ok: false, code: 'private-diagnostic' }, status: 502, expected: 'unexpected' },
    { body: { ok: true, skills: [{ ...skill, source: null }] }, status: 200, expected: 'unexpected' },
    { body: { ok: true, skills: [skill] }, status: 500, expected: 'unexpected' },
    { body: null, status: 200, expected: 'unexpected' },
  ])('returns safe failure codes for status $status and invalid payloads', async ({ body, status, expected }) => {
    respond(body, status)
    expect(await searchSkills('review', new AbortController().signal)).toEqual({ ok: false, code: expected })
  })

  it('rejects malformed installed inventories and installation receipts', async () => {
    const fetch = respond({ ok: true, skills: [{ ...installed, installedAt: 42 }] })
    expect(await readInstalledSkills(new AbortController().signal)).toEqual({ ok: false, code: 'unexpected' })
    fetch.mockResolvedValueOnce(Response.json({ ok: true, skill: { ...installed, slug: '' } }))
    expect(await installSkill(skill.slug, new AbortController().signal)).toEqual({ ok: false, code: 'unexpected' })
    fetch.mockResolvedValueOnce(Response.json({ ok: true, skill: { ...installed, slug: 'another-skill' } }))
    expect(await installSkill(skill.slug, new AbortController().signal)).toEqual({ ok: false, code: 'unexpected' })
  })

  it('contains malformed JSON, network failures and cancellation after response arrival', async () => {
    const fetch = vi.fn<(request: Request) => Promise<Response>>()
    vi.stubGlobal('fetch', fetch)
    fetch.mockResolvedValueOnce(new Response('invalid JSON'))
    expect(await readInstalledSkills(new AbortController().signal)).toEqual({ ok: false, code: 'unexpected' })
    fetch.mockRejectedValueOnce(new Error('private transport details'))
    expect(await readInstalledSkills(new AbortController().signal)).toEqual({ ok: false, code: 'unexpected' })
    const controller = new AbortController()
    fetch.mockImplementationOnce(async () => {
      controller.abort()
      return Response.json({ ok: true, skills: [] })
    })
    expect(await readInstalledSkills(controller.signal)).toEqual({ ok: false, code: 'cancelled' })
  })
})
