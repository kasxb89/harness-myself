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
