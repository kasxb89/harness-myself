/** Unknown JSON is validated before any server entity reaches presentation state. */
import { describe, expect, it, vi, afterEach } from 'vitest'
import * as wire from '../src/client/wire.ts'
import { demandContentUrl, requestDemand } from '../src/client/api.ts'

afterEach(() => { vi.unstubAllGlobals() })
const engineer = { id: 'example-engineer', display_name: 'Example engineer', category_ids: ['software'], introduction: '',
  service_hours: '', presence: 'offline', accepting: true, can_start: true, capacity: 4 }
const demand = { id: 'example-demand', number: 'YS-EXAMPLE', engineer_id: engineer.id, engineer, user_id: 1, priority: 'normal',
  status: 'communicating', revision: 1, last_seq: 1, last_read_seq: 0, unread_count: 0, title: '', preview: '', created_at: 100, updated_at: 100 }
const message = { id: 'example-message', demand_id: demand.id, seq: 1, sender_id: 1, author: 'user', kind: 'message', text: 'Example request',
  attachments: [], created_at: 100, client_message_id: 'example-operation', read: false }
const owner = { id: '1', owner: 'a'.repeat(64), epoch: 1 }

describe('demand wire and Host adapter', () => {
  it('rejects malformed counts, unknown states, inconsistent assignments, and unsafe attachment sizes', () => {
    expect(() => wire.demand({ ...demand, last_seq: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
    expect(() => wire.demand({ ...demand, status: 'invented' })).toThrow()
    expect(() => wire.demand({ ...demand, engineer_id: 'different' })).toThrow()
    expect(() => wire.attachment({ id: 'file', name: 'example.png', kind: 'image', mime_type: 'image/png', size_bytes: 3,
      uploaded_bytes: 4, status: 'uploading' })).toThrow()
  })

  it('rejects cross-demand or nonmonotonic message pages and preserves confirmed receipt data', () => {
    const page = { items: [message], demand, next_after_seq: 1, last_seq: 1, has_more: false }
    expect(wire.messages(page, demand.id).items[0]?.read).toBe(false)
    expect(() => wire.messages({ ...page, items: [{ ...message, demand_id: 'different' }] }, demand.id)).toThrow()
    expect(() => wire.messages({ ...page, items: [message, message] }, demand.id)).toThrow()
    expect(() => wire.sendReceipt({ demand, message: { ...message, demand_id: 'different' }, replayed: true })).toThrow()
    expect(wire.sendReceipt({ demand, message, replayed: true }).replayed).toBe(true)
  })

  it('preserves the optional backend author name verbatim and accepts older messages without it', () => {
    expect(wire.message({ ...message, author: 'engineer', author_name: '  Engineer A  ' }).author_name).toBe('  Engineer A  ')
    expect(wire.message({ ...message, author: 'engineer' }).author_name).toBe('')
    expect(() => wire.message({ ...message, author_name: 'A'.repeat(201) })).toThrow()
    expect(() => wire.message({ ...message, author_name: null })).toThrow()
  })

  it('sends account guards without a bearer and rejects a successful reply for another owner', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, payload: { items: [] },
      account: { id: owner.id }, accountOwner: 'b'.repeat(64) }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const result = await requestDemand(owner, { method: 'GET', path: '?limit=30', signal: new AbortController().signal })
    expect(result).toMatchObject({ ok: false, code: 'ACCOUNT_CHANGED' })
    const options = fetch.mock.calls[0]?.[1]
    expect(options?.headers).toMatchObject({ 'x-yunshu-account-id': owner.id, 'x-yunshu-account-owner': owner.owner })
    expect(options?.headers).not.toHaveProperty('authorization')
    expect(fetch.mock.calls[0]?.[0]).toEqual(expect.stringContaining('/credits/api/demands?limit=30'))
  })

  it('retains unknown outcomes and creates only local media paths with owner guards', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: false,
      code: 'DEMAND_TIMEOUT', outcome: 'unknown' }))))
    expect(await requestDemand(owner, { method: 'POST', path: '', body: '{}', signal: new AbortController().signal }))
      .toMatchObject({ ok: false, unknown: true })
    const url = demandContentUrl(owner, 'example-image', 'attachment')
    expect(url).toContain('/credits/api/demands/attachments/example-image/content?')
    expect(url).toContain('account_id=1')
    expect(url).toContain(`account_owner=${owner.owner}`)
    expect(url).toContain('disposition=attachment')
    expect(url).not.toContain('Bearer')
  })
})

const service = { id: 'service-web', code: 'YS-SVC-001', display_name: 'Website service', service_direction: 'Website requests',
  introduction: 'Platform reception', category_ids: ['software'], avatar_attachment_id: 'service-avatar',
  enabled: true, published: true, intake_mode: 'platform', can_start: true }

describe('additive platform directory contract', () => {
  it('reads the fixed unassigned projection separately from its immutable service source and accepts legacy direct rows', () => {
    const platform = { ...demand, engineer_id: 'platform-intake', engineer: { ...engineer, id: 'platform-intake', accepting: false,
      can_start: false, capacity: 0 }, intake_mode: 'platform', assigned: false, service_profile_id: service.id,
    service_profile_name: 'Original service name' }
    expect(wire.demand(platform)).toMatchObject({ assigned: false, intake_mode: 'platform', service_profile_id: service.id,
      service_profile_name: 'Original service name', engineer_id: 'platform-intake' })
    expect(wire.demand(demand)).toMatchObject({ assigned: true, intake_mode: 'direct', service_profile_id: '' })
    expect(() => wire.demand({ ...platform, assigned: true })).toThrow()
    expect(() => wire.demand({ ...platform, intake_mode: 'direct' })).toThrow()
    expect(() => wire.demand({ ...platform, service_profile_id: '' })).toThrow()
  })

  it('keeps platform capability and filter-bound cursors explicit without leaking private or live-person fields', () => {
    const config = { config: { enabled: true, categories: [], upload_rules: { max_image_bytes: 10, max_video_bytes: 20,
      max_attachments: 1, chunk_bytes: 4, allowed_mime_types: ['image/png'], upload_ttl_seconds: 100 } },
    capabilities: { polling: true, resumable_upload: true }, server_time: 100 }
    expect(wire.configuration(config).service_profiles).toBe(false)
    expect(wire.configuration({ ...config, capabilities: { ...config.capabilities, service_profiles: true } }).service_profiles).toBe(true)
    const parsed = wire.serviceDirectory({ items: [{ ...service, presence: 'online', user_id: 98, notes: 'Internal only' }],
      next_after_id: 'opaque/cursor+==', has_more: true, total: 2, server_time: 100 })
    expect(parsed.next_after_id).toBe('opaque/cursor+==')
    expect(parsed.items[0]).not.toHaveProperty('presence')
    expect(parsed.items[0]).not.toHaveProperty('user_id')
    expect(parsed.items[0]).not.toHaveProperty('notes')
    expect(() => wire.serviceDirectory({ items: [service], next_after_id: '', has_more: true, total: 2, server_time: 100 })).toThrow()
    expect(() => wire.serviceDirectory({ items: [service, service], next_after_id: '', has_more: false, total: 2, server_time: 100 })).toThrow()
  })

  it('transports a URLSearchParams query containing spaces and punctuation exactly once through the guarded Host', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true,
      payload: { items: [] }, account: { id: owner.id }, accountOwner: owner.owner })))
    vi.stubGlobal('fetch', fetch)
    const path = `/service-profiles?${new URLSearchParams({ q: 'React + .NET*', after_id: 'opaque/cursor+==', limit: '30' })}`
    expect(await requestDemand(owner, { method: 'GET', path, signal: new AbortController().signal })).toMatchObject({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toEqual(expect.stringContaining(path))
  })
})
