import { describe, expect, it } from 'vitest'
import { communityId, communityListing, communityQuery, communityRequest, communityResponse } from '../src/community-protocol.ts'
import { DemandProtocolError, demandObject } from '../src/demand-protocol.ts'
import {
  communityAsset, communityConfiguration, communityIds, communityListingFixture, communityMessage, communityOrder, communityUpload,
} from './community-fixtures.ts'

const account = { id: '42' }
const success = (data: unknown): unknown => ({ success: true, data })

describe('community contract is separate from official demand-v1', () => {
  it('uses only the exact direct config and wrapped detail shapes confirmed by the API handlers', () => {
    const config = communityConfiguration(false), listing = communityListingFixture(), current = communityOrder()
    expect(communityResponse('config', success({ ...config, revision: 5, secret: 'hidden' }), account)).toEqual(config)
    expect(communityResponse('listing', success({ listing }), account, { resourceId: communityIds.order })).toEqual({ listing })
    expect(communityResponse('order', success({ order: current }), account, { resourceId: communityIds.order })).toEqual({ order: current })
    expect(() => communityResponse('config', success({ config }), account)).toThrow(DemandProtocolError)
    expect(() => communityResponse('listing', success(listing), account)).toThrow(DemandProtocolError)
    expect(() => communityResponse('order', success(current), account)).toThrow(DemandProtocolError)
    expect(() => communityResponse('listing', success({ listing }), account, { resourceId: communityIds.other })).toThrow(DemandProtocolError)
  })
  it('requires explicit publication and preserves free-text budget and durable identity', () => {
    const source = { client_request_id: communityIds.key, publish_to_community: true, title: '整理资料', public_summary: '公开说明',
      public_budget: '可协商，暂未定价', private_text: '私密补充', public_attachment_ids: [communityIds.asset],
      private_attachment_ids: [], phone: 'never forward', visibility: 'all', engineer_id: 'invented' }
    expect(communityRequest('create', source)).toEqual({ client_request_id: communityIds.key, publish_to_community: true,
      title: '整理资料', public_summary: '公开说明', public_budget: '可协商，暂未定价', private_text: '私密补充',
      public_attachment_ids: [communityIds.asset], private_attachment_ids: [] })
    for (const publication of [false, undefined, 'true']) {
      expect(() => communityRequest('create', { ...source, publish_to_community: publication })).toThrow(DemandProtocolError)
    }
    expect(() => communityRequest('create', { ...source, public_attachment_ids: Array(9).fill(communityIds.asset) })).toThrow(DemandProtocolError)
  })
  it('whitelists user lifecycle actions and requires change-request feedback', () => {
    expect(communityRequest('accept', { client_action_id: communityIds.key, engineer_id: 'spoofed' }))
      .toEqual({ client_action_id: communityIds.key })
    expect(() => communityRequest('action', { client_action_id: communityIds.key, revision: 1, action: 'hide_listing' })).toThrow(DemandProtocolError)
    expect(() => communityRequest('action', { client_action_id: communityIds.key, revision: 1, action: 'request_changes', text: ' ' })).toThrow(DemandProtocolError)
    expect(communityRequest('action', { client_action_id: communityIds.key, revision: 2, action: 'request_changes', text: '请补充示例' }))
      .toEqual({ client_action_id: communityIds.key, revision: 2, action: 'request_changes', text: '请补充示例', attachment_ids: [] })
  })
  it('bounds Unicode filters, opaque cursors, methods and query keys', () => {
    expect(communityQuery('listings', new URLSearchParams({ q: '😀'.repeat(100), limit: '100', cursor: 'opaque+/=' })).get('q')).toBe('😀'.repeat(100))
    for (const query of [new URLSearchParams({ q: '😀'.repeat(101) }), new URLSearchParams({ cursor: 'a'.repeat(257) }),
      new URLSearchParams({ publisher_id: '42' }), new URLSearchParams('limit=1&limit=2'), new URLSearchParams({ limit: '0' })]) {
      expect(() => communityQuery('listings', query)).toThrow(DemandProtocolError)
    }
    expect(() => communityId('../orders')).toThrow(DemandProtocolError)
    expect(() => communityId('official-order')).toThrow(DemandProtocolError)
  })
  it('requires immutable upload scope, bounded media kinds and a completion digest', () => {
    const input = { client_upload_id: communityIds.key, scope: 'conversation', order_id: communityIds.order,
      name: '演示.mp4', mime_type: 'video/mp4', size_bytes: 10 }
    expect(communityRequest('upload-init', input)).toEqual(input)
    expect(() => communityRequest('upload-init', { ...input, scope: 'official' })).toThrow(DemandProtocolError)
    expect(() => communityRequest('upload-init', { ...input, mime_type: 'text/html' })).toThrow(DemandProtocolError)
    expect(() => communityRequest('upload-complete', {})).toThrow(DemandProtocolError)
    expect(communityRequest('upload-complete', { sha256: 'a'.repeat(64), storage_path: 'hidden' })).toEqual({ sha256: 'a'.repeat(64) })
  })
  it('redacts nested private contacts and requires listing-only public attachments', () => {
    const listing = communityListingFixture({ publisher: { id: 42, display_name: '示例', phone: 'private', token: 'secret' },
      public_attachments: [communityAsset({ object_key: '/private/storage', url: 'https://private.invalid' })], private_text: 'hidden', internal_note: 'hidden' })
    const result = communityListing(listing)
    expect(demandObject(result.publisher)).toEqual({ id: 42, display_name: '示例' })
    expect(JSON.stringify(result)).not.toMatch(/private|secret|internal_note|object_key/u)
    expect(() => communityListing({ ...listing, public_attachments: [communityAsset({ scope: 'conversation' })] })).toThrow(DemandProtocolError)
    expect(() => communityListing({ ...listing, schema_version: 2 })).toThrow(DemandProtocolError)
  })
  it('requires current participant roles and keeps ordinary peers out of engineer enums', () => {
    const result = communityResponse('message', success({ order: communityOrder(), message: communityMessage(), replayed: false }), account)
    expect(demandObject(result.message).author_kind).toBe('acceptor')
    expect(JSON.stringify(result)).not.toContain('engineer')
    expect(() => communityResponse('message', success({ order: communityOrder({ my_role: 'acceptor' }), message: communityMessage(), replayed: false }), account)).toThrow(DemandProtocolError)
    expect(() => communityResponse('message', success({ order: communityOrder(), message: communityMessage({ author_kind: 'engineer' }), replayed: false }), account)).toThrow(DemandProtocolError)
    expect(() => communityResponse('message', success({ order: communityOrder(), message: communityMessage({ sender_id: 99 }), replayed: false }), account)).toThrow(DemandProtocolError)
    expect(() => communityResponse('message', success({ order: communityOrder(), message: communityMessage({ order_id: communityIds.other }), replayed: false }), account)).toThrow(DemandProtocolError)
  })
  it('binds existing-object responses to the exact selected route', () => {
    expect(() => communityResponse('accept', success({ order: communityOrder(), replayed: true }), account,
      { resourceId: communityIds.other })).toThrow(DemandProtocolError)
    expect(communityResponse('accept', success({ order: communityOrder(), replayed: true }), account,
      { resourceId: communityIds.order })).toMatchObject({ replayed: true })
  })
  it('does not turn seq or unread fields into public response counts', () => {
    const response = success({ items: [communityListingFixture()], next_cursor: '', has_more: false, views: 999, response_count: 88 })
    const result = communityResponse('listings', response, account)
    expect(result).toEqual({ items: [communityListingFixture()], next_cursor: '', has_more: false })
    expect(() => communityResponse('listings', success({ items: [communityListingFixture(), communityListingFixture()], next_cursor: '', has_more: false }), account)).toThrow(DemandProtocolError)
    expect(() => communityResponse('listings', success({ items: [], next_cursor: '', has_more: true }), account)).toThrow(DemandProtocolError)
  })
  it('requires ascending immutable message seq and seven-field upload receipts', () => {
    expect(communityResponse('messages', success({ order: communityOrder(), items: [communityMessage()], last_seq: 1,
      next_after_seq: 1, has_more: false }), account)).toMatchObject({ last_seq: 1 })
    expect(() => communityResponse('messages', success({ order: communityOrder(), items: [communityMessage(), communityMessage()], last_seq: 1,
      next_after_seq: 1, has_more: false }), account)).toThrow(DemandProtocolError)
    expect(communityResponse('upload-chunk', success(communityUpload({ object_key: 'hidden' })), account)).toEqual(communityUpload())
    expect(() => communityResponse('upload-complete', success(communityUpload({ status: 'ready' })), account)).toThrow(DemandProtocolError)
  })
})
