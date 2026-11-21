/** Service galleries bind public media to one profile, API deployment and captured login. */
import { describe, expect, it } from 'vitest'
import { demandQuery, demandResponse } from '../src/demand-protocol.ts'
import { serviceGalleryContentPath } from '../src/service-gallery-path.ts'

const account = { id: '7', owner: 'a'.repeat(64) }
const base = 'https://api.example.test/harness'
const profile = { id: 'service-web', code: 'SERVICE_WEB', display_name: '网站交付服务', service_direction: '企业网站',
  introduction: '响应式页面和内容管理', category_ids: [], avatar_attachment_id: '', published: true, enabled: true,
  sort: 1, revision: 1, intake_mode: 'platform', can_start: true }
const source = (id: string): string => `/api/product/demand-service-media/${profile.id}/${id}/content`
const local = (id: string): string => serviceGalleryContentPath(profile.id, id, account)
const image = { id: 'cover', kind: 'image', mime_type: 'image/png', size_bytes: 120, sha256: 'b'.repeat(64), url: source('cover') }
const video = { id: 'recording', kind: 'video', mime_type: 'video/mp4', size_bytes: 360, sha256: 'c'.repeat(64),
  url: source('recording'), poster_url: source('poster') }
const gallery = { profile_id: profile.id, revision: 1, cover_attachment_id: image.id, cover_url: image.url, media: [image, video] }
function page(value: unknown) {
  return { success: true, data: { items: [{ ...profile, gallery: value }], has_more: false, next_after_id: '', total: 1, server_time: 100 } }
}

describe('service-gallery-v1 Host projection', () => {
  it('projects original assets and poster paths without signed URLs, original names or private fields', () => {
    const projected = demandResponse('service-profiles', page({ ...gallery, owner_phone: '+0000000000', media: [
      { ...image, name: 'private-customer-name.png', url: source(image.id) + '?token=private-link' }, video,
    ] }), account, base)
    expect(projected).toMatchObject({ items: [{ gallery: { profile_id: profile.id, revision: 1,
      cover_attachment_id: image.id, cover_url: local(image.id), media: [
        { ...image, url: local(image.id) }, { ...video, url: local(video.id), poster_url: local('poster') },
      ] } }] })
    expect(JSON.stringify(projected)).not.toMatch(/private-link|private-customer|owner_phone|api\.example/u)
  })

  it('retains configured deployment prefixes and validates relative, prefixed and absolute URLs against the same origin', () => {
    for (const convert of [(url: string) => url, (url: string) => '/harness' + url,
      (url: string) => 'https://api.example.test/harness' + url]) {
      const value = { ...gallery, cover_url: convert(image.url), media: [
        { ...image, url: convert(image.url) }, { ...video, url: convert(video.url), poster_url: convert(video.poster_url) },
      ] }
      expect(demandResponse('service-profiles', page(value), account, base)).toMatchObject({ items: [{ gallery: { cover_url: local(image.id) } }] })
    }
    expect(() => demandResponse('service-profiles', page({ ...gallery,
      media: [{ ...image, url: 'https://other.example.test/harness' + image.url }] }), account, base)).toThrow()
    expect(() => demandResponse('service-profiles', page({ ...gallery,
      media: [{ ...image, url: 'https://api.example.test' + image.url }] }), account, base)).toThrow()
    expect(() => demandResponse('service-profiles', page({ ...gallery,
      media: [{ ...image, url: 'https://user@api.example.test/harness' + image.url }] }), account, base)).toThrow()
    expect(() => demandResponse('service-profiles', page({ ...gallery,
      media: [{ ...image, url: 'https://api.example.test/harness' + image.url.replace('/cover/', '/temporary/../cover/') }] }), account, base)).toThrow()
    expect(() => demandResponse('service-profiles', page({ ...gallery,
      media: [{ ...image, url: '//api.example.test/harness' + image.url }] }), account, base)).toThrow()
  })

  it('supports absent galleries and explicitly cleared galleries while requiring login ownership for any gallery', () => {
    const legacy = page(gallery)
    expect(demandResponse('service-profiles', { ...legacy, data: { ...legacy.data, items: [profile] } }))
      .toMatchObject({ items: [profile] })
    expect(() => demandResponse('service-profiles', page(gallery), undefined, base)).toThrow()
    const empty = { profile_id: profile.id, revision: 0, cover_attachment_id: '', cover_url: '', media: [] }
    expect(demandResponse('service-profiles', page(empty), account, base)).toMatchObject({ items: [{ gallery: empty }] })
    expect(() => demandResponse('service-profiles', page({ ...empty, cover_url: source('cover') }), account, base)).toThrow()
    expect(demandResponse('service-profiles', page({ ...gallery, cover_attachment_id: 'poster', cover_url: source('poster') }), account, base))
      .toMatchObject({ items: [{ gallery: { cover_attachment_id: 'poster', cover_url: local('poster') } }] })
  })

  it('rejects inconsistent media, cross-profile URLs, unknown covers and private attachment route substitution', () => {
    const invalid = [
      { ...gallery, profile_id: 'another-profile' }, { ...gallery, revision: 0 },
      { ...gallery, media: [image, image] }, { ...gallery, media: Array.from({ length: 31 }, () => image) },
      { ...gallery, media: [{ ...image, size_bytes: 0 }] }, { ...gallery, media: [{ ...image, mime_type: 'video/mp4' }] },
      { ...gallery, media: [{ ...image, sha256: 'not-a-sha256' }] },
      { ...gallery, media: [{ ...image, url: source('different-asset') }] },
      { ...gallery, media: [{ ...image, url: image.url.replace(profile.id, 'another-profile') }] },
      { ...gallery, media: [{ ...image, url: '/api/product/demands/attachments/cover/content' }] },
      { ...gallery, media: [image, { ...video, poster_url: video.poster_url.replace(profile.id, 'another-profile') }] },
      { ...gallery, media: [image, { ...video, poster_url: source(video.id) }] },
      { ...gallery, media: [{ ...image, poster_url: source('poster') }] },
      { ...gallery, cover_attachment_id: 'missing', cover_url: source('missing') },
      { ...gallery, cover_attachment_id: video.id, cover_url: source(video.id) },
    ]
    for (const value of invalid) expect(() => demandResponse('service-profiles', page(value), account, base)).toThrow()
  })

  it('negotiates the exact read-only query value and retains the optional capability without changing legacy config', () => {
    expect(demandQuery('service-profiles', new URLSearchParams('limit=30&include_media=1')).get('include_media')).toBe('1')
    for (const query of ['include_media=0', 'include_media=true', 'include_media=1&include_media=1']) {
      expect(() => demandQuery('service-profiles', new URLSearchParams(query))).toThrow()
    }
    expect(() => demandQuery('engineers', new URLSearchParams('include_media=1'))).toThrow()
    const data = { config: { enabled: true, categories: [], upload_rules: { max_image_bytes: 100, max_video_bytes: 1000,
      max_attachments: 2, chunk_bytes: 100, allowed_mime_types: ['image/png'], upload_ttl_seconds: 300 } },
    server_time: 100, capabilities: { resumable_upload: true, polling: true } }
    expect(demandResponse('config', { success: true, data })).toEqual(data)
    expect(demandResponse('config', { success: true, data: { ...data,
      capabilities: { ...data.capabilities, service_gallery_v1: true } } })).toMatchObject({ capabilities: { service_gallery_v1: true } })
    expect(() => demandResponse('config', { success: true, data: { ...data,
      capabilities: { ...data.capabilities, service_gallery_v1: 'true' } } })).toThrow()
  })
})
