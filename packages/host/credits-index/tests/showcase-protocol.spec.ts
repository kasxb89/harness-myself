import { describe, expect, it } from 'vitest'
import { showcaseAssetPath, showcaseQuery, showcaseResponse } from '../src/showcase-protocol.ts'

const caseId = '11111111-1111-4111-8111-111111111111', mediaId = '22222222-2222-4222-8222-222222222222'
const another = '33333333-3333-4333-8333-333333333333', base = 'https://cases.invalid/harness'
const url = (id = mediaId, owner = caseId) => `${base}/api/product/demand-showcases/assets/${owner}/${id}/content`
function item(patch: Record<string, unknown> = {}) {
  return { id: caseId, title: '业务设计案例', description: '实际公开素材', category: 'web', cover_url: url(),
    media: [{ id: mediaId, kind: 'video', mime_type: 'video/mp4', size_bytes: 120, sha256: 'a'.repeat(64), url: url(), poster_url: url(another) }],
    source_name: '公开项目', source_url: 'https://source.invalid/project', attribution: 'Original contributors', synthetic: true,
    created_at: 1, updated_at: 2, phone: 'not-public', storage_key: 'secret', revision: 3, ...patch }
}
describe('public showcase protocol', () => {
  it.each([undefined, true, false])('accepts absent rev2 provenance or a legacy boolean (%s) without public projection', (synthetic) => {
    const result = showcaseResponse('detail', { item: item({ synthetic }) }, base)
    expect(result).toMatchObject({ item: { id: caseId } })
    expect(result.item).not.toHaveProperty('synthetic')
  })
  it.each([null, 0, 'true', {}])('still rejects invalid optional legacy provenance (%s)', (synthetic) => {
    expect(() => showcaseResponse('detail', { item: item({ synthetic }) }, base)).toThrow()
  })
  it('projects capabilities and public cases without admin, login or storage metadata', () => {
    const config = showcaseResponse('config', { capabilities: { showcases_v1: true, pagination: true, public_ready_media: true }, categories: ['web', 'video'], password: 'secret' }, base)
    expect(config).toEqual({ capabilities: { showcases_v1: true, pagination: true, public_ready_media: true }, categories: ['web', 'video'] })
    const result = showcaseResponse('list', { items: [item()], next_cursor: '', has_more: false, total_count: 1 }, base)
    expect(result).toMatchObject({ total_count: 1, items: [{ id: caseId, media: [{ url: `/credits/api/demand-showcases/assets/${caseId}/${mediaId}/content`, poster_url: `/credits/api/demand-showcases/assets/${caseId}/${another}/content` }] }] })
    expect(JSON.stringify(result)).not.toContain('not-public'); expect(JSON.stringify(result)).not.toContain('storage_key')
    expect(JSON.stringify(result)).not.toContain('revision'); expect(JSON.stringify(result)).not.toContain(base)
  })
  it('permits explicit missing capability compatibility but rejects contradictory v1 declarations', () => {
    expect(showcaseResponse('config', {}, base)).toEqual({ capabilities: { showcases_v1: false }, categories: [] })
    expect(() => showcaseResponse('config', { capabilities: { showcases_v1: true }, categories: [] }, base)).toThrow()
    expect(() => showcaseResponse('config', { capabilities: { showcases_v1: true, pagination: true, public_ready_media: true }, categories: ['web', 'web'] }, base)).toThrow()
  })
  it.each([`${url()}?token=secret`, url(mediaId, another), 'https://attacker.invalid/a.png', 'file:///private/a.png',
    `${base}/api/product/demands/attachments/${mediaId}/content`, `${base}/api/product/demand-showcases/assets/${caseId}/../${mediaId}/content`])('rejects non-case or arbitrary media URL %s', (input) => {
    expect(() => showcaseAssetPath(input, caseId, base, mediaId)).toThrow()
  })
  it('binds media IDs exactly and supports only the explicit family-relative public path', () => {
    expect(showcaseAssetPath(`/api/product/demand-showcases/assets/${caseId}/${mediaId}/content`, caseId, base, mediaId))
      .toBe(`/credits/api/demand-showcases/assets/${caseId}/${mediaId}/content`)
    expect(() => showcaseAssetPath(url(another), caseId, base, mediaId)).toThrow()
  })
  it.each([
    { media: [] }, { media: Array.from({ length: 31 }, () => item().media[0]) },
    { media: [{ ...item().media[0], mime_type: 'text/html' }] },
    { media: [{ ...item().media[0], kind: 'image', mime_type: 'image/svg+xml' }] },
    { media: [{ ...item().media[0], sha256: 'bad' }] }, { source_url: 'https://user:secret@source.invalid/' },
  ])('rejects invalid public case media or attribution %#', (patch) => {
    expect(() => showcaseResponse('detail', { item: item(patch) }, base)).toThrow()
  })
  it('rejects duplicate records and invalid pagination without truncating to a fake count', () => {
    for (const patch of [{ items: [item(), item()], total_count: 2 }, { has_more: true }, { next_cursor: 'unexpected' }, { total_count: 0 }]) {
      expect(() => showcaseResponse('list', { items: [item()], next_cursor: '', has_more: false, total_count: 1, ...patch }, base)).toThrow()
    }
    expect(showcaseQuery('list', new URLSearchParams({ limit: '100', cursor: 'opaque', category: 'web', query: '自然视频' })).toString())
      .toBe('limit=100&cursor=opaque&category=web&query=%E8%87%AA%E7%84%B6%E8%A7%86%E9%A2%91')
    for (const query of ['limit=101', 'limit=0', 'limit=1&limit=2', 'admin=true', 'category=private']) {
      expect(() => showcaseQuery('list', new URLSearchParams(query))).toThrow()
    }
    expect(() => showcaseQuery('config', new URLSearchParams('token=secret'))).toThrow()
  })
})
