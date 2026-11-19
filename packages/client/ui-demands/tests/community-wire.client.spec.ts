/** Strict protocol qualification is independent of upstream generation and legacy demand schemas. */
import { describe, expect, it } from 'vitest'
import * as wire from '../src/client/community-wire.ts'
import { exampleCommunityAttachment as attachment, exampleCommunityConfig as config,
  exampleCommunityListing as listing, exampleCommunityMessage as message, exampleCommunityOrder as order } from './community-model-fixtures.client.ts'

describe('community wire', () => {
  it('keeps the actual acceptor, historical sender name and declared participant permissions', () => {
    expect(wire.communityOrder(order(), '1')).toMatchObject({ my_role: 'publisher', can_send: true,
      acceptor: { id: 2, display_name: 'Example acceptor' } })
    expect(wire.communityMessage(message()).author_name).toBe('Actual historical acceptor')
    expect(wire.communityConfig(config(false)).enabled).toBe(false)
    expect(wire.communityOrder({ ...order(), private_account: 'must not escape' }, '1')).not.toHaveProperty('private_account')
  })
  it('rejects role identity mismatches, old engineer authors and contradictory lifecycle projections', () => {
    expect(() => wire.communityOrder(order(), '2')).toThrow()
    expect(() => wire.communityOrder(order({ my_role: 'acceptor' }), '1')).toThrow()
    expect(() => wire.communityOrder(order({ acceptor: null }), '1')).toThrow()
    expect(() => wire.communityOrder({ ...order(), status: 'in_progress' }, '1')).toThrow()
    expect(() => wire.communityMessage({ ...message(), author_kind: 'engineer' })).toThrow()
    expect(() => wire.communityMessage(message({ sender_id: 0 }))).toThrow()
  })
  it('strips unrequested private listing fields and rejects private public-assets', () => {
    const parsed = wire.communityListing({ ...listing(), private_text: 'private', acceptor: { id: 2 } })
    expect(parsed).not.toHaveProperty('private_text'); expect(parsed).not.toHaveProperty('acceptor')
    expect(() => wire.communityListing(listing({ public_attachments: [attachment()] }))).toThrow()
    expect(wire.communityListing(listing({ public_attachments: [attachment({ scope: 'listing' })] })).public_attachments).toHaveLength(1)
  })
  it('validates increasing message sequences, participant senders and exact order binding', () => {
    const page = { items: [message()], order: order(), next_after_seq: 1, last_seq: 1, has_more: false }
    expect(wire.communityMessages(page, 'community-order', '1', 0).items).toHaveLength(1)
    expect(() => wire.communityMessages({ ...page, items: [message(), message()] }, 'community-order', '1', 0)).toThrow()
    expect(() => wire.communityMessages({ ...page, items: [message({ sender_id: 9 })] }, 'community-order', '1', 0)).toThrow()
    expect(() => wire.communityMessages(page, 'foreign-order', '1', 0)).toThrow()
  })
  it('requires explicit schema flags, safe cursors, complete-ready uploads and real media scope', () => {
    expect(() => wire.communityConfig({ ...config(), schema_version: 2 })).toThrow()
    expect(() => wire.communityPage({ items: [], next_cursor: '', has_more: true }, wire.communityListing)).toThrow()
    expect(() => wire.communityAttachment({ ...attachment(), scope: 'official' })).toThrow()
    const upload = { id: 'upload', attachment_id: 'community-image', offset: 4, chunk_bytes: 4, status: 'ready', expires_at: 200, attachment: attachment() }
    expect(wire.communityUpload(upload).status).toBe('ready')
    expect(() => wire.communityUpload({ ...upload, attachment: null })).toThrow()
    expect(() => wire.communityUpload({ ...upload, attachment_id: 'another' })).toThrow()
  })
  it('counts Unicode scalars without accepting malformed text or implicit flags', () => {
    expect(wire.communityText('😀'.repeat(200), 200)).toHaveLength(400)
    expect(() => wire.communityText('\ud800')).toThrow()
    expect(() => wire.communityText('unsafe\u0000')).toThrow()
    expect(() => wire.communityBoolean(1)).toThrow()
  })
})
