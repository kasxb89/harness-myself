import { describe, expect, it } from 'vitest'
import { demandQuery, demandRequest, demandResponse } from '../src/demand-protocol.ts'

const key = '11111111-2222-4333-8444-555555555555'
describe('frozen customer demand protocol', () => {
  it('keeps a single stable submit identity and strips caller-supplied account and admin fields', () => {
    expect(demandRequest('create', { client_request_id: key, engineer_id: 'engineer-1', text: 'Build a report',
      attachment_ids: [], user_id: 999, internal_note: 'private', authorization: 'never-forward' }))
      .toEqual({ client_request_id: key, engineer_id: 'engineer-1', text: 'Build a report', attachment_ids: [] })
    expect(demandRequest('message', { client_message_id: key, attachment_ids: ['asset-1'] }))
      .toEqual({ client_message_id: key, text: '', attachment_ids: ['asset-1'] })
  })
  it('rejects empty submissions, invalid dates and engineer/admin actions on the user surface', () => {
    expect(() => demandRequest('message', { client_message_id: key, text: ' ' })).toThrow()
    expect(() => demandRequest('create', { client_request_id: key, engineer_id: 'eng', text: 'Hi', expected_date: '2026-02-30' })).toThrow()
    expect(() => demandRequest('action', { client_action_id: key, action: 'assign', revision: 1, engineer_id: 'someone' })).toThrow()
    expect(() => demandRequest('action', { client_action_id: key, action: 'accept_delivery', revision: 1 })).toThrow()
  })
  it('accepts only declared cursors and preserves exact resumable upload identities', () => {
    expect(demandQuery('messages', new URLSearchParams('after_seq=8&limit=100')).toString()).toBe('after_seq=8&limit=100')
    expect(() => demandQuery('messages', new URLSearchParams('user_id=2'))).toThrow()
    expect(() => demandQuery('messages', new URLSearchParams('limit=1&limit=2'))).toThrow()
    expect(() => demandQuery('messages', new URLSearchParams('limit=0'))).toThrow()
    expect(demandRequest('upload-init', { client_upload_id: key, name: '原视频.mp4', mime_type: 'video/mp4', size_bytes: 100 }))
      .toEqual({ client_upload_id: key, name: '原视频.mp4', mime_type: 'video/mp4', size_bytes: 100 })
    expect(demandRequest('upload-complete', {})).toEqual({})
  })
  it('projects typed public data without passing arbitrary remote fields or credentials', () => {
    expect(demandResponse('unread', { success: true, data: { unread_count: 2, unread_demands: 1, server_time: 100,
      access_token: 'secret', internal_note: 'hidden' } }))
      .toEqual({ unread_count: 2, unread_demands: 1, server_time: 100 })
    expect(demandResponse('engineers', { success: true, data: { server_time: 100, items: [{ id: 'eng', display_name: 'Alice',
      category_ids: ['software'], introduction: 'Writes applications', presence: 'offline', accepting: true, can_start: true,
      capacity: 2, service_hours: '', avatar_attachment_id: 'avatar', private_phone: 'secret', avatar_url: 'https://untrusted.invalid/' }] } }))
      .toEqual({ server_time: 100, items: [{ id: 'eng', display_name: 'Alice', category_ids: ['software'], introduction: 'Writes applications',
        presence: 'offline', accepting: true, can_start: true, capacity: 2, service_hours: '', avatar_attachment_id: 'avatar' }] })
    expect(() => demandResponse('unread', { success: true, data: { unread_count: '2', unread_demands: 1, server_time: 100 } })).toThrow()
    expect(() => demandResponse('config', { success: true, data: {} })).toThrow()
  })
  it('preserves an optional historical author name without deriving it from the current assignee', () => {
    const engineer = { id: 'engineer-B', display_name: 'Engineer B', category_ids: [], introduction: '',
      presence: 'online', accepting: true, can_start: true, capacity: 2, service_hours: '' }
    const demand = { id: 'demand-1', number: 'REQ-1', engineer_id: engineer.id, engineer,
      user_id: 7, status: 'communicating', priority: 'normal', revision: 2, last_seq: 1, last_read_seq: 0,
      unread_count: 1, preview: 'Original author', created_at: 100, updated_at: 101 }
    const message = { id: 'message-1', demand_id: demand.id, seq: 1, author: 'engineer', sender_id: 8,
      text: 'Original author', kind: 'message', attachments: [], created_at: 100, client_message_id: key, read: false }
    const decode = (item: unknown) => demandResponse('message', { success: true, data: { demand, message: item, replayed: false } })
    expect(decode({ ...message, author_name: 'Engineer A' })).toMatchObject({ message: { author_name: 'Engineer A' } })
    expect(decode(message).message).not.toHaveProperty('author_name')
    expect(decode({ ...message, author_name: 'A'.repeat(200) })).toMatchObject({ message: { author_name: 'A'.repeat(200) } })
    for (const invalid of [null, 8, {}, 'A'.repeat(201), 'name\u0000hidden']) {
      expect(() => decode({ ...message, author_name: invalid })).toThrow('Invalid demand protocol data')
    }
  })

})
