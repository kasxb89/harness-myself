/** Unknown gallery JSON must already contain profile- and account-bound local Host URLs. */
import { describe, expect, it } from 'vitest'
import * as wire from '../src/client/wire.ts'

const account = { id: '7', owner: 'a'.repeat(64) }
const local = (assetId: string): string => `/credits/api/demand-service-media/service-web/${assetId}/content?${new URLSearchParams({
  account_id: account.id, account_owner: account.owner, disposition: 'inline',
})}`
const image = { id: 'cover', kind: 'image', mime_type: 'image/png', size_bytes: 120, sha256: 'b'.repeat(64), url: local('cover') }
const video = { id: 'recording', kind: 'video', mime_type: 'video/mp4', size_bytes: 360, sha256: 'c'.repeat(64),
  url: local('recording'), poster_url: local('poster') }
const gallery = { profile_id: 'service-web', revision: 1, cover_attachment_id: 'cover', cover_url: local('cover'), media: [image, video] }
const profile = { id: 'service-web', code: 'SERVICE_WEB', display_name: '网站交付服务', service_direction: '企业网站',
  introduction: '公开服务目录', category_ids: [], avatar_attachment_id: '', published: true, enabled: true, intake_mode: 'platform', can_start: true }

describe('service-gallery-v1 client decoder', () => {
  it('retains verified gallery metadata without unknown filenames or owner data', () => {
    const result = wire.serviceDirectory({ items: [{ ...profile, gallery: { ...gallery, secret: 'not-public',
      media: [{ ...image, name: 'private.png' }, video] } }], has_more: false, next_after_id: '', total: 100, server_time: 100 }, account)
    expect(result.items[0]?.gallery).toEqual(gallery)
    expect(JSON.stringify(result)).not.toMatch(/private\.png|not-public/u)
    expect(result.total).toBe(100)
    expect(wire.serviceProfile(profile)).not.toHaveProperty('gallery')
    const empty = { profile_id: profile.id, revision: 0, cover_attachment_id: '', cover_url: '', media: [] }
    expect(wire.serviceProfile({ ...profile, gallery: empty }, account).gallery).toEqual(empty)
    expect(wire.serviceProfile({ ...profile, gallery: { ...gallery, cover_attachment_id: 'poster', cover_url: local('poster') } }, account).gallery)
      .toMatchObject({ cover_url: local('poster') })
  })

  it('rejects remote, cross-profile, private-namespace, stale-account and undeclared-query URLs', () => {
    for (const url of ['https://remote.invalid' + image.url, '//remote.invalid/file', image.url.replace('service-web', 'different-service'),
      '/credits/api/demands/attachments/cover/content', image.url.replace('account_id=7', 'account_id=8'),
      image.url.replace('/cover/content', '/temporary/../cover/content'),
      image.url.replace('account_owner=' + account.owner, 'account_owner=' + 'c'.repeat(64)), image.url + '&token=unexpected',
      image.url + '&account_id=7', image.url + '#unexpected']) {
      expect(() => wire.serviceProfile({ ...profile, gallery: { ...gallery, media: [{ ...image, url }] } }, account)).toThrow()
    }
    expect(() => wire.serviceProfile({ ...profile, gallery })).toThrow()
    expect(() => wire.serviceProfile({ ...profile, gallery: { ...gallery,
      media: [image, { ...video, poster_url: video.poster_url.replace('service-web', 'other-service') }] } }, account)).toThrow()
  })

  it('rejects invalid ready metadata, duplicate media and an empty gallery retaining a cover', () => {
    for (const value of [{ ...gallery, media: [image, image] }, { ...gallery, media: [{ ...image, size_bytes: 0 }] },
      { ...gallery, media: [{ ...image, mime_type: 'text/plain' }] }, { ...gallery, media: [{ ...image, sha256: '' }] },
      { ...gallery, media: Array.from({ length: 31 }, () => image) }, { ...gallery, profile_id: 'other-service' },
      { ...gallery, media: [] }, { ...gallery, cover_attachment_id: video.id, cover_url: local(video.id) },
      { ...gallery, media: [image, { ...video, poster_url: video.url }] }, { ...gallery, revision: 0 }]) {
      expect(() => wire.serviceProfile({ ...profile, gallery: value }, account)).toThrow()
    }
  })
})
