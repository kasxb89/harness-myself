/** Community workflow isolation, original mutation identities and explicit recovery. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-credits/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCommunityController, type CommunityController } from '../src/client/community-controller.ts'
import type { CommunityOwner, CommunityRequest, CommunityResult } from '../src/client/community-api.ts'
import type { CommunityAttachment, CommunityListing, CommunityMessage, CommunityOrder } from '../src/client/community-types.ts'
import { createCommunityJournal, type CommunityJournal } from '../src/client/community-pending.ts'
import { communityMemory, exampleCommunityConfig as configuration, exampleCommunityListing as listing,
  exampleCommunityMessage as message, exampleCommunityOrder as order } from './community-model-fixtures.client.ts'

type Account = ReturnType<Context['creditsSession']['getSnapshot']>
const hash = 'a'.repeat(64)
const ok = (payload: unknown): CommunityResult => ({ ok: true, payload })
const unknown = (): CommunityResult => ({ ok: false, code: 'COMMUNITY_TIMEOUT', httpStatus: 0, unknown: true })
function account(id = '1', epoch = 1, accountOwner = hash): Account {
  return { accountEpoch: epoch, loaded: true, balance: null, failure: null,
    session: { signedIn: true, creditsPerYuan: 1000, account: { id, phone: '' }, accountOwner } }
}
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Uninitialized deferred') }
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const controls: CommunityController[] = []
afterEach(async () => { await Promise.all(controls.splice(0).map(value => value.dispose())); vi.useRealTimers() })
function harness(options: {
  enabled?: boolean
  rows?: CommunityOrder[]
  publicRows?: CommunityListing[]
  journal?: CommunityJournal
  intercept?: (owner: CommunityOwner, input: CommunityRequest) => CommunityResult | undefined | Promise<CommunityResult | undefined>
} = {}) {
  const source = createSnapshotStore(account()), rows = options.rows ?? [order()]
  const publicRows = options.publicRows ?? [listing({ id: 'foreign-order', publisher: { id: 2, display_name: 'Example other publisher' }, can_accept: true })]
  const messages = new Map<string, CommunityMessage[]>(rows.map(row => [row.id, row.last_seq === 0 ? [] : [message({ order_id: row.id })]]))
  const journal = options.journal ?? createCommunityJournal(communityMemory())
  let nonce = 0
  const request = vi.fn(async (owner: CommunityOwner, input: CommunityRequest): Promise<CommunityResult> => {
    const answer = await options.intercept?.(owner, input)
    if (answer !== undefined) return answer
    if (input.path === '/config') return ok(configuration(options.enabled ?? true))
    if (input.path.startsWith('/listings?')) return ok({ items: publicRows, next_cursor: '', has_more: false })
    if (input.path.startsWith('/orders?')) {
      const view = new URLSearchParams(input.path.split('?')[1]).get('view')
      return ok({ items: rows.filter(row => view === 'published' ? String(row.publisher.id) === owner.id
        : view === 'accepted' ? String(row.acceptor?.id) === owner.id : String(row.publisher.id) === owner.id || String(row.acceptor?.id) === owner.id),
      next_cursor: '', has_more: false })
    }
    const id = input.path.split('/')[2], row = rows.find(value => value.id === id)
    if (input.path.startsWith('/listings/') && input.method === 'GET') {
      const found = publicRows.find(value => value.id === id)
      return found === undefined ? { ok: false, code: 'COMMUNITY_NOT_FOUND', httpStatus: 404, unknown: false } : ok({ listing: found })
    }
    if (row !== undefined && input.path.includes('/messages?')) {
      const after = Number(new URLSearchParams(input.path.split('?')[1]).get('after_seq'))
      return ok({ items: (messages.get(row.id) ?? []).filter(value => value.seq > after), order: row,
        last_seq: row.last_seq, next_after_seq: row.last_seq, has_more: false })
    }
    if (row !== undefined && input.path.endsWith('/read')) return ok({ last_read_seq: row.last_seq, unread_count: 0 })
    if (row !== undefined && input.method === 'GET') return ok({ order: row })
    return { ok: false, code: 'COMMUNITY_NOT_FOUND', httpStatus: 404, unknown: false }
  })
  const control = createCommunityController(source, { enabled: true, foregroundPollMs: 60_000, backgroundPollMs: 60_000 }, {
    request, journal, uuid: () => `00000000-0000-4000-8000-${String(++nonce).padStart(12, '0')}`, isForeground: () => true,
  })
  controls.push(control); control.start()
  const snapshot = () => control.hooks.community.getSnapshot()
  const ready = async () => { await vi.waitFor(() => { expect(snapshot().availability).toBe(options.enabled === false ? 'disabled' : 'ready') }) }
  const open = async (id = 'community-order') => {
    control.openOrder(id)
    await vi.waitFor(() => { expect(snapshot().selectedOrderStatus).toBe('ready'); expect(snapshot().conversation?.messages).toHaveLength(1) })
  }
  return { control, source, request, rows, publicRows, journal, messages, snapshot, ready, open }
}
function publicationBody(input: CommunityRequest): Record<string, unknown> { return JSON.parse(input.body ?? '{}') as Record<string, unknown> }
function publishedReceipt(input: CommunityRequest, id: string): CommunityResult {
  const body = publicationBody(input)
  const value = order({ id, number: id, title: String(body.title), status: 'open', revision: 1, acceptor: null, last_seq: 0,
    last_read_seq: 0, unread_count: 0, private_text: String(body.private_text), accepted_at: 0,
    listing: listing({ id, number: id, title: String(body.title),
      public_summary: String(body.public_summary), public_budget: String(body.public_budget),
      expected_delivery_date: typeof body.expected_delivery_date === 'string' ? body.expected_delivery_date : '' }) })
  return ok({ order: value, message: null, replayed: true })
}

describe('community controller', () => {
  it('probes exact new config shape and retains disabled participant messages without fake engineers', async () => {
    const h = harness({ enabled: false }); await h.ready(); await h.open()
    expect(h.snapshot().conversation?.order.acceptor?.id).toBe(2)
    expect(h.snapshot().conversation?.messages[0]).toMatchObject({ author_kind: 'acceptor', author_name: 'Actual historical acceptor', isSelf: false })
    h.control.startPublication(); expect(h.snapshot().publications).toHaveLength(0)
    expect(h.snapshot().orders.published.items).toHaveLength(1)
    expect(h.request.mock.calls.some(([, input]) => input.path.startsWith('/listings'))).toBe(false)
  })
  it('gracefully stops unsupported 404 or false-capability probes without sending old private requests', async () => {
    const h = harness({ intercept: (_owner, input) => input.path === '/config'
      ? { ok: false, code: 'COMMUNITY_NOT_FOUND', httpStatus: 404, unknown: false } : undefined })
    await vi.waitFor(() => { expect(h.snapshot().availability).toBe('unavailable') })
    h.control.startPublication(); h.control.acceptListing('foreign-order')
    expect(h.request.mock.calls).toHaveLength(1)
    expect(h.snapshot().publications).toHaveLength(0)
  })
  it('opens only retained participant orders after config disappears, including an unopened history and a cached conversation', async () => {
    let unavailable = false
    const second = order({ id: 'second-history', listing: listing({ id: 'second-history', status: 'accepted' }) })
    const h = harness({ rows: [order(), second], intercept: (_owner, input) => input.path === '/config' && unavailable
      ? { ok: false, code: 'COMMUNITY_NOT_FOUND', httpStatus: 404, unknown: false } : undefined })
    await h.ready(); await h.open()
    await vi.waitFor(() => { expect(h.snapshot().orders.published.items).toHaveLength(2) })
    unavailable = true; h.control.refresh()
    await vi.waitFor(() => { expect(h.snapshot().availability).toBe('unavailable') })
    expect(h.snapshot().listings.items).toHaveLength(0)
    const before = h.request.mock.calls.length
    h.control.startPublication(); h.control.acceptListing('foreign-order'); h.control.openListing('foreign-order')
    h.control.setListingFilter('not-dispatched'); h.control.loadMoreListings()
    await h.open('second-history')
    expect(h.snapshot().conversation?.order.private_text).toBe(second.private_text)
    await h.open()
    expect(h.snapshot().conversation?.messages[0]?.text).toBe('Example response')
    const reads = h.request.mock.calls.slice(before).map(([, input]) => input)
    expect(reads.some(input => input.path === '/orders/second-history')).toBe(true)
    expect(reads.every(input => input.method === 'GET' && input.path.startsWith('/orders/'))).toBe(true)
    expect(h.snapshot().publications).toHaveLength(0)
  })
  it('reports an unavailable cold order without a request while retaining exact original acceptance recovery', async () => {
    const originalId = '00000000-0000-4000-8000-000000000097', target = 'hidden-original'
    const body = JSON.stringify({ client_action_id: originalId }), journal = createCommunityJournal(communityMemory())
    journal.put({ id: '1', owner: hash }, { version: 1, operationId: originalId, scopeKey: `accept:${target}`,
      orderId: target, kind: 'accept', path: `/orders/${target}/accept`, createdAt: 100, body })
    const accepted = order({ id: target, publisher: { id: 2, display_name: 'Publisher' },
      acceptor: { id: 1, display_name: 'Current acceptor' }, my_role: 'acceptor',
      listing: listing({ id: target, publisher: { id: 2, display_name: 'Publisher' }, status: 'accepted' }),
      last_seq: 0, last_read_seq: 0, unread_count: 0 })
    const h = harness({ rows: [], journal, intercept: (_owner, input) => {
      if (input.path === '/config') return { ok: false, code: 'COMMUNITY_NOT_FOUND', httpStatus: 404, unknown: false }
      if (input.path === `/orders/${target}/accept`) return ok({ order: accepted, replayed: true })
      if (input.path.startsWith(`/orders/${target}/messages?`)) return ok({ items: [], order: accepted,
        last_seq: 0, next_after_seq: 0, has_more: false })
      return undefined
    } })
    await vi.waitFor(() => { expect(h.snapshot().availability).toBe('unavailable') })
    h.control.openOrder('unverified-order')
    expect(h.snapshot()).toMatchObject({ selectedOrderId: 'unverified-order', selectedOrderStatus: 'error',
      selectedOrderError: { code: 'COMMUNITY_UNAVAILABLE' }, conversation: null })
    expect(h.request.mock.calls).toHaveLength(1)
    expect(h.snapshot().pending[0]?.operationId).toBe(originalId)
    h.control.retryOperation(originalId)
    await vi.waitFor(() => { expect(h.snapshot().conversation?.order.id).toBe(target); expect(h.snapshot().pending).toHaveLength(0) })
    const writes = h.request.mock.calls.filter(([, input]) => input.method === 'POST')
    expect(writes).toHaveLength(1)
    expect(writes[0]?.[1]).toMatchObject({ path: `/orders/${target}/accept`, body })
    expect(h.request.mock.calls.some(([, input]) => input.path.startsWith('/listings'))).toBe(false)
  })
  it('clears retained order authorization on account changes before an unavailable-history selection', async () => {
    let unavailable = false
    const h = harness({ intercept: (_owner, input) => input.path === '/config' && unavailable
      ? { ok: false, code: 'COMMUNITY_NOT_FOUND', httpStatus: 404, unknown: false } : undefined })
    await h.ready(); await h.open()
    unavailable = true; h.source.set(account('3', 2, 'b'.repeat(64)))
    await vi.waitFor(() => { expect(h.snapshot()).toMatchObject({ accountId: '3', availability: 'unavailable' }) })
    const before = h.request.mock.calls.length
    h.control.openOrder('community-order')
    expect(h.snapshot()).toMatchObject({ selectedOrderStatus: 'error', selectedOrderError: { code: 'COMMUNITY_UNAVAILABLE' },
      conversation: null, pending: [] })
    expect(h.snapshot().orders.all.items).toHaveLength(0)
    expect(h.request.mock.calls).toHaveLength(before)
  })
  it('keeps participant history on an older server while gating the moderated square and new submissions', async () => {
    const legacy = { ...configuration(), capabilities: { ...configuration().capabilities } }
    delete legacy.capabilities.community_approval_v1; delete legacy.publication_policy
    const h = harness({ intercept: (_owner, input) => input.path === '/config' ? ok(legacy) : undefined })
    await h.ready(); await h.open()
    h.control.startPublication(); h.control.acceptListing('foreign-order'); h.control.openListing('foreign-order')
    expect(h.snapshot().publications).toHaveLength(0)
    expect(h.snapshot().conversation?.order.id).toBe('community-order')
    expect(h.request.mock.calls.some(([, input]) => input.path.startsWith('/listings'))).toBe(false)
    expect(h.request.mock.calls.some(([, input]) => input.method === 'POST')).toBe(false)
    expect(h.snapshot().selectedListingError?.code).toBe('COMMUNITY_APPROVAL_REQUIRED')
  })
  it('validates expected delivery before dispatch and freezes it through unknown-result recovery', async () => {
    let first = true
    const h = harness({ rows: [], intercept: (_owner, input) => {
      if (input.path !== '/orders' || input.method !== 'POST') return undefined
      if (first) { first = false; return unknown() }
      return publishedReceipt(input, 'dated-order')
    } }); await h.ready(); h.control.startPublication()
    const scope = h.snapshot().activePublicationScope ?? ''
    h.control.updatePublication(scope, { publishToCommunity: true, title: 'Date original', publicSummary: 'Public brief',
      expectedDeliveryDate: '2026-02-29' }); h.control.publish(scope)
    expect(h.snapshot().publications[0]?.error?.code).toBe('COMMUNITY_INVALID_INPUT')
    expect(h.request.mock.calls.some(([, input]) => input.method === 'POST')).toBe(false)
    h.control.updatePublication(scope, { expectedDeliveryDate: '2026-12-08' }); h.control.publish(scope)
    await vi.waitFor(() => { expect(h.snapshot().pending[0]?.error?.unknown).toBe(true) })
    h.control.updatePublication(scope, { expectedDeliveryDate: '2027-01-01' })
    h.control.retryOperation(h.snapshot().pending[0]?.operationId ?? '')
    await vi.waitFor(() => { expect(h.snapshot().publications[0]?.orderId).toBe('dated-order') })
    const posts = h.request.mock.calls.filter(([, input]) => input.path === '/orders' && input.method === 'POST')
    expect(posts).toHaveLength(2); expect(posts[0]?.[1].body).toBe(posts[1]?.[1].body)
    expect(publicationBody(posts[1]?.[1] ?? { method: 'POST', path: '', signal: new AbortController().signal })
      .expected_delivery_date).toBe('2026-12-08')
  })
  it('recovers an older frozen publication without adding a date or changing its UUID on a legacy-capability response', async () => {
    const journal = createCommunityJournal(communityMemory()), originalId = '00000000-0000-4000-8000-000000000099'
    const originalBody = JSON.stringify({ client_request_id: originalId, publish_to_community: true, title: 'Original old title',
      public_summary: 'Original old brief', public_budget: 'Negotiable', private_text: '', public_attachment_ids: [], private_attachment_ids: [] })
    journal.put({ id: '1', owner: hash }, { version: 1, operationId: originalId, scopeKey: 'publication:legacy',
      orderId: null, kind: 'publication', path: '/orders', createdAt: 100, body: originalBody })
    const legacy = { ...configuration(), capabilities: { ...configuration().capabilities } }
    delete legacy.capabilities.community_approval_v1; delete legacy.publication_policy
    const h = harness({ rows: [], journal, intercept: (_owner, input) => input.path === '/config' ? ok(legacy)
      : input.path === '/orders' && input.method === 'POST' ? publishedReceipt(input, 'old-confirmed') : undefined })
    await h.ready()
    expect(h.request.mock.calls.some(([, input]) => input.method === 'POST')).toBe(false)
    expect(journal.read({ id: '1', owner: hash })[0]?.body).toBe(originalBody)
    h.control.updatePublication('publication:legacy', { expectedDeliveryDate: '2026-12-08' })
    h.control.retryOperation(originalId)
    await vi.waitFor(() => { expect(h.snapshot().publications[0]?.orderId).toBe('old-confirmed') })
    const posts = h.request.mock.calls.filter(([, input]) => input.path === '/orders' && input.method === 'POST')
    expect(posts).toHaveLength(1); expect(posts[0]?.[1].body).toBe(originalBody)
  })
  it('checks a restored acceptance with its exact original path and body without public discovery or another submit key', async () => {
    const originalId = '00000000-0000-4000-8000-000000000098', target = 'hidden-order'
    const body = JSON.stringify({ client_action_id: originalId }), journal = createCommunityJournal(communityMemory())
    journal.put({ id: '1', owner: hash }, { version: 1, operationId: originalId, scopeKey: `accept:${target}`,
      orderId: target, kind: 'accept', path: `/orders/${target}/accept`, createdAt: 100, body })
    const legacy = { ...configuration(), capabilities: { ...configuration().capabilities } }
    delete legacy.capabilities.community_approval_v1; delete legacy.publication_policy
    const accepted = order({ id: target, publisher: { id: 2, display_name: 'Publisher' },
      acceptor: { id: 1, display_name: 'Current acceptor' }, my_role: 'acceptor',
      listing: listing({ id: target, publisher: { id: 2, display_name: 'Publisher' }, status: 'accepted', approval_status: 'rejected' }),
      last_seq: 0, last_read_seq: 0, unread_count: 0 })
    let attempt = 0
    const h = harness({ rows: [], journal, intercept: (_owner, input) => {
      if (input.path === '/config') return ok(legacy)
      if (input.path === `/orders/${target}/accept` && input.method === 'POST') {
        attempt += 1
        return attempt === 1 ? unknown() : attempt === 2
          ? { ok: false, code: 'COMMUNITY_ALREADY_ACCEPTED', httpStatus: 409, unknown: false }
          : ok({ order: accepted, replayed: true })
      }
      if (input.path.startsWith(`/orders/${target}/messages?`)) return ok({ items: [], order: accepted,
        last_seq: 0, next_after_seq: 0, has_more: false })
      return undefined
    } }); await h.ready()
    expect(h.request.mock.calls.some(([, input]) => input.method === 'POST')).toBe(false)
    h.control.retryOperation(originalId); h.control.retryOperation(originalId)
    await vi.waitFor(() => { expect(h.snapshot().pending[0]?.error?.code).toBe('COMMUNITY_TIMEOUT') })
    expect(attempt).toBe(1)
    h.control.retryOperation(originalId)
    await vi.waitFor(() => { expect(h.snapshot().pending[0]?.error).toMatchObject({ code: 'COMMUNITY_ALREADY_ACCEPTED', unknown: false }) })
    h.control.retryOperation(originalId)
    await vi.waitFor(() => { expect(h.snapshot().pending).toHaveLength(0) })
    expect(h.snapshot().selectedOrderId).toBe(target)
    const posts = h.request.mock.calls.filter(([, input]) => input.method === 'POST')
    expect(posts).toHaveLength(3)
    expect(posts.every(([, input]) => input.path === `/orders/${target}/accept` && input.body === body)).toBe(true)
    expect(h.request.mock.calls.some(([, input]) => input.path.startsWith('/listings'))).toBe(false)
  })
  it('publishes only after explicit opt-in and reuses the exact original UUID/body after unknown results', async () => {
    let first = true
    const h = harness({ rows: [], intercept: (_owner, input) => {
      if (input.path !== '/orders' || input.method !== 'POST') return undefined
      if (first) { first = false; return unknown() }
      return publishedReceipt(input, 'new-order')
    } }); await h.ready()
    h.control.startPublication(); const scope = h.snapshot().activePublicationScope ?? ''
    h.control.updatePublication(scope, { title: 'Public title', publicSummary: 'Public summary' }); h.control.publish(scope)
    expect(h.request.mock.calls.filter(([, input]) => input.method === 'POST')).toHaveLength(0)
    expect(h.snapshot().publications[0]?.error?.code).toBe('COMMUNITY_EXPLICIT_PUBLICATION_REQUIRED')
    h.control.updatePublication(scope, { publishToCommunity: true }); h.control.publish(scope)
    await vi.waitFor(() => { expect(h.snapshot().pending[0]?.error?.unknown).toBe(true) })
    h.control.updatePublication(scope, { title: 'Must not replace frozen body' })
    const pending = h.snapshot().pending[0]
    h.control.startPublication(); expect(h.snapshot().publications).toHaveLength(2)
    h.control.retryOperation(pending?.operationId ?? '')
    await vi.waitFor(() => { expect(h.snapshot().publications[0]?.orderId).toBe('new-order') })
    const posts = h.request.mock.calls.filter(([, input]) => input.path === '/orders' && input.method === 'POST')
    expect(posts).toHaveLength(2); expect(posts[0]?.[1].body).toBe(posts[1]?.[1].body)
  })
  it('preflights acceptance once and recovers the original accept body without re-reading a hidden listing', async () => {
    let first = true
    const accepted = order({ id: 'foreign-order', publisher: { id: 2, display_name: 'Other' }, acceptor: { id: 1, display_name: 'Me' },
      my_role: 'acceptor', listing: listing({ id: 'foreign-order', publisher: { id: 2, display_name: 'Other' }, status: 'accepted' }),
      last_seq: 0, last_read_seq: 0, unread_count: 0 })
    const h = harness({ rows: [], intercept: (_owner, input) => {
      if (!input.path.endsWith('/accept')) return undefined
      if (first) { first = false; return unknown() }
      return ok({ order: accepted, replayed: true })
    } }); await h.ready(); h.control.acceptListing('foreign-order')
    await vi.waitFor(() => { expect(h.snapshot().pending[0]?.error?.unknown).toBe(true) })
    h.control.retryOperation(h.snapshot().pending[0]?.operationId ?? '')
    await vi.waitFor(() => { expect(h.snapshot().selectedOrderId).toBe('foreign-order'); expect(h.snapshot().pending).toHaveLength(0) })
    const posts = h.request.mock.calls.filter(([, input]) => input.path.endsWith('/accept'))
    expect(posts).toHaveLength(2); expect(posts[0]?.[1].body).toBe(posts[1]?.[1].body)
    expect(h.request.mock.calls.filter(([, input]) => input.path === '/listings/foreign-order')).toHaveLength(1)
  })
  it('keeps self-accept and another winner failures distinct', async () => {
    const self = harness({ publicRows: [listing({ can_accept: true })] }); await self.ready(); self.control.acceptListing('community-order')
    await vi.waitFor(() => { expect(self.snapshot().selectedListingError?.code).toBe('COMMUNITY_SELF_ACCEPT_FORBIDDEN') })
    expect(self.request.mock.calls.some(([, input]) => input.path.endsWith('/accept'))).toBe(false)
    const other = harness({ intercept: (_owner, input) => input.path.endsWith('/accept')
      ? { ok: false, code: 'COMMUNITY_ALREADY_ACCEPTED', httpStatus: 409, unknown: false } : undefined })
    await other.ready(); other.control.acceptListing('foreign-order')
    await vi.waitFor(() => { expect(other.snapshot().pending[0]?.error).toMatchObject({ code: 'COMMUNITY_ALREADY_ACCEPTED', unknown: false }) })
  })
  it('exposes selected-order failure even without a retained order record', async () => {
    const h = harness({ rows: [] }); await h.ready(); h.control.openOrder('missing-order')
    await vi.waitFor(() => { expect(h.snapshot().selectedOrderStatus).toBe('error') })
    expect(h.snapshot().selectedOrderError?.code).toBe('COMMUNITY_NOT_FOUND'); expect(h.snapshot().conversation).toBeNull()
  })
  it('retains unknown local bubbles then reconciles actual sender/client key without a new post', async () => {
    const h = harness({ intercept: (_owner, input) => input.method === 'POST' && input.path.endsWith('/messages') ? unknown() : undefined })
    await h.ready(); await h.open(); h.control.updateMessageDraft('community-order', 'Original message'); h.control.sendMessage('community-order')
    await vi.waitFor(() => { expect(h.snapshot().conversation?.pendingMessages[0]?.state).toBe('unknown') })
    const original = h.snapshot().pending[0]?.operationId ?? ''
    h.rows[0] = order({ last_seq: 2 })
    h.messages.set('community-order', [message(), message({ id: 'confirmed-message', seq: 2, sender_id: 1,
      author_kind: 'publisher', text: 'Original message', client_message_id: original })])
    h.control.refresh()
    await vi.waitFor(() => {
      expect(h.snapshot().conversation?.pendingMessages).toHaveLength(0); expect(h.snapshot().conversation?.messages).toHaveLength(2)
    })
    expect(h.request.mock.calls.filter(([, input]) => input.method === 'POST' && input.path.endsWith('/messages'))).toHaveLength(1)
    expect(h.snapshot().conversation?.messages[1]?.isSelf).toBe(true)
  })
  it('does not read-mark hidden or different orders and preserves the explicit foreground guard', async () => {
    const h = harness(); await h.ready(); await h.open()
    h.control.markRead('community-order', 1)
    expect(h.request.mock.calls.some(([, input]) => input.path.endsWith('/read'))).toBe(false)
    h.control.setVisible(true); h.control.markRead('another-order', 1); h.control.markRead('community-order', 1)
    await vi.waitFor(() => { expect(h.request.mock.calls.filter(([, input]) => input.path.endsWith('/read'))).toHaveLength(1) })
    h.control.setVisible(false); h.control.markRead('community-order', 1)
    expect(h.request.mock.calls.filter(([, input]) => input.path.endsWith('/read'))).toHaveLength(1)
  })
  it('aborts account-owned reads, rejects late replies and joins disposal', async () => {
    const pending = deferred<CommunityResult>(), entered = deferred<undefined>()
    let signal: AbortSignal | undefined
    const h = harness({ intercept: (_owner, input) => {
      if (input.path !== '/orders/slow') return undefined
      signal = input.signal; entered.resolve(undefined); return pending.promise
    } }); await h.ready(); h.control.openOrder('slow'); await entered.promise
    h.source.set(account('2', 2, 'b'.repeat(64)))
    expect(signal?.aborted).toBe(true)
    let disposed = false
    const closing = h.control.dispose().then(() => { disposed = true })
    await Promise.resolve(); expect(disposed).toBe(false)
    pending.resolve(ok({ order: order({ id: 'slow', listing: listing({ id: 'slow' }) }) })); await closing
    expect(h.snapshot().accountId).toBeNull(); expect(h.snapshot().conversation).toBeNull()
  })
  it('reserves staged attachments for a single submission while allowing a new independent text message', async () => {
    const held = deferred<CommunityResult>(), posts: CommunityRequest[] = []
    let offset = 0, digest = ''
    const file = new File(['file'], 'example.png', { type: 'image/png', lastModified: 1 })
    const upload = (ready = false) => ({ id: 'upload', attachment_id: 'asset', offset, chunk_bytes: 4,
      status: ready ? 'ready' : 'uploading', expires_at: 1000,
      attachment: ready ? { id: 'asset', name: file.name, kind: 'image', mime_type: file.type, size_bytes: file.size,
        status: 'ready', sha256: digest, scope: 'conversation' } : null })
    const h = harness({ intercept: (_owner, input) => {
      if (input.path === '/uploads') return ok(upload())
      if (input.path === '/uploads/upload/content') { offset = 4; return ok(upload()) }
      if (input.path === '/uploads/upload/complete') { digest = String(publicationBody(input).sha256); return ok(upload(true)) }
      if (input.method === 'POST' && input.path.endsWith('/messages')) { posts.push(input); return held.promise }
      return undefined
    } }); await h.ready(); await h.open()
    h.control.addAttachments({ kind: 'order', orderId: 'community-order' }, 'conversation', [file])
    await vi.waitFor(() => { expect(h.snapshot().uploads[0]?.status).toBe('ready') })
    h.control.sendMessage('community-order'); h.control.sendMessage('community-order')
    await Promise.resolve(); const initialPosts = posts.length
    held.resolve(unknown())
    expect(initialPosts).toBe(1)
    h.control.updateMessageDraft('community-order', 'Independent next text'); h.control.sendMessage('community-order')
    await vi.waitFor(() => { expect(posts).toHaveLength(2) })
    expect(publicationBody(posts[1] ?? { method: 'POST', path: '', signal: new AbortController().signal }).attachment_ids).toEqual([])
    const initial = publicationBody(posts[0] ?? { method: 'POST', path: '', signal: new AbortController().signal })
    h.rows[0] = order({ last_seq: 2 })
    const confirmed: CommunityAttachment = { id: 'asset', name: file.name, kind: 'image', mime_type: file.type,
      size_bytes: file.size, status: 'ready', sha256: digest, scope: 'conversation' }
    h.messages.set('community-order', [message(), message({ id: 'accepted-upload-message', seq: 2, sender_id: 1,
      author_kind: 'publisher', text: '', client_message_id: String(initial.client_message_id), attachments: [confirmed] })])
    h.control.refresh()
    await vi.waitFor(() => { expect(h.snapshot().uploads).toHaveLength(0) })
    h.control.sendMessage('community-order'); expect(posts).toHaveLength(2)

  })
  it('ignores an aborted old listing query after a newer query resolves with its own cursor', async () => {
    const old = deferred<CommunityResult>(), entered = deferred<undefined>()
    let oldSignal: AbortSignal | undefined
    const fresh = listing({ id: 'new-result' })
    const h = harness({ intercept: (_owner, input) => {
      if (input.path.includes('q=old')) { oldSignal = input.signal; entered.resolve(undefined); return old.promise }
      if (input.path.includes('q=new')) return ok({ items: [fresh], next_cursor: 'new-cursor', has_more: true })
      return undefined
    } }); await h.ready(); h.control.setListingFilter('old'); await entered.promise
    h.control.setListingFilter('new')
    await vi.waitFor(() => { expect(h.snapshot().listings.items[0]?.id).toBe('new-result') })
    expect(oldSignal?.aborted).toBe(true)
    old.resolve(ok({ items: [listing({ id: 'old-result' })], next_cursor: 'old-cursor', has_more: true }))
    await Promise.resolve(); await Promise.resolve()
    expect(h.snapshot().listingQuery).toBe('new'); expect(h.snapshot().listings.items[0]?.id).toBe('new-result')
  })
  it('stops after an unknown binary attempt and resumes only after explicit GET-offset verification', async () => {
    let offset = 0, digest = '', puts = 0, checks = 0
    const file = new File(['file'], 'example.png', { type: 'image/png', lastModified: 1 })
    const dto = (ready = false) => ({ id: 'upload', attachment_id: 'asset', offset, chunk_bytes: 4,
      status: ready ? 'ready' : 'uploading', expires_at: 1000, attachment: ready ? {
        id: 'asset', name: file.name, kind: 'image', mime_type: file.type, size_bytes: file.size, status: 'ready', sha256: digest, scope: 'conversation',
      } : null })
    const h = harness({ intercept: (_owner, input) => {
      if (input.path === '/uploads') return ok(dto())
      if (input.path === '/uploads/upload' && input.method === 'GET') { checks += 1; return ok(dto()) }
      if (input.path.endsWith('/content')) { puts += 1; offset = 4; return unknown() }
      if (input.path.endsWith('/complete')) { digest = String(publicationBody(input).sha256); return ok(dto(true)) }
      return undefined
    } }); await h.ready(); await h.open()
    h.control.addAttachments({ kind: 'order', orderId: 'community-order' }, 'conversation', [file])
    await vi.waitFor(() => { expect(h.snapshot().uploads[0]?.error?.unknown).toBe(true) })
    expect(puts).toBe(1); expect(checks).toBe(0)
    h.control.retryUpload(h.snapshot().uploads[0]?.operationId ?? '')
    await vi.waitFor(() => { expect(h.snapshot().uploads[0]?.status).toBe('ready') })
    expect(puts).toBe(1); expect(checks).toBe(1)
  })
  it('requires the documented create-prefix for a nonnull private initial message', async () => {
    const h = harness({ rows: [], intercept: (_owner, input) => {
      if (input.path !== '/orders' || input.method !== 'POST') return undefined
      const body = publicationBody(input), receipt = publishedReceipt(input, 'published-with-private')
      if (!receipt.ok) return receipt
      const payload = receipt.payload as { order: CommunityOrder }
      return ok({ ...payload, order: { ...payload.order, last_seq: 1 }, replayed: false,
        message: message({ id: 'private-first', order_id: 'published-with-private', sender_id: 1, author_kind: 'publisher',
          text: String(body.private_text), client_message_id: `create:${String(body.client_request_id)}` }) })
    } }); await h.ready(); h.control.startPublication(); const key = h.snapshot().activePublicationScope ?? ''
    h.control.updatePublication(key, { publishToCommunity: true, title: 'Public title', publicSummary: 'Public summary', privateText: 'Private only' })
    h.control.publish(key)
    await vi.waitFor(() => { expect(h.snapshot().publications[0]?.orderId).toBe('published-with-private') })
    expect(h.snapshot().conversation?.messages[0]?.text).toBe('Private only')
  })

  it('keeps the newer read cursor and unread count paired when an older order GET arrives late', async () => {
    let hold = false
    const late = deferred<CommunityResult>(), entered = deferred<undefined>()
    const h = harness({ intercept: (_owner, input) => {
      if (hold && input.path === '/orders/community-order') { entered.resolve(undefined); return late.promise }
      return undefined
    } }); await h.ready(); await h.open(); h.control.setVisible(true)
    hold = true; h.control.openOrder('community-order'); await entered.promise
    h.control.markRead('community-order', 1)
    await vi.waitFor(() => { expect(h.snapshot().conversation?.order.last_read_seq).toBe(1) })
    late.resolve(ok({ order: order({ last_read_seq: 0, unread_count: 1 }) }))
    await vi.waitFor(() => { expect(h.snapshot().selectedOrderStatus).toBe('ready') })
    expect(h.snapshot().conversation?.order.last_read_seq).toBe(1)
    expect(h.snapshot().conversation?.order.unread_count).toBe(0)
  })

  it('restores an unresolved message as unknown with its original key and no automatic resend', async () => {
    const journal = createCommunityJournal(communityMemory())
    const first = harness({ journal, intercept: (_owner, input) => input.method === 'POST' && input.path.endsWith('/messages') ? unknown() : undefined })
    await first.ready(); await first.open()
    first.control.updateMessageDraft('community-order', 'Keep this original message'); first.control.sendMessage('community-order')
    await vi.waitFor(() => { expect(first.snapshot().conversation?.pendingMessages[0]?.state).toBe('unknown') })
    const original = first.snapshot().pending[0]?.operationId ?? ''
    const originalBody = first.request.mock.calls.find(([, input]) => input.method === 'POST' && input.path.endsWith('/messages'))?.[1].body
    await first.control.dispose()
    const next = harness({ journal }); await next.ready(); await next.open()
    expect(next.snapshot().conversation?.pendingMessages[0]).toMatchObject({ operationId: original, text: 'Keep this original message',
      state: 'unknown', error: { code: 'COMMUNITY_RESULT_UNKNOWN', unknown: true, operationId: original } })
    expect(next.request.mock.calls.some(([, input]) => input.method === 'POST')).toBe(false)
    expect(next.journal.read({ id: '1', owner: hash })[0]?.body).toBe(originalBody)
  })

  it('publishes per-listing claiming state throughout a held preflight without creating another submit key', async () => {
    const held = deferred<CommunityResult>(), entered = deferred<undefined>()
    const fresh = listing({ id: 'foreign-order', publisher: { id: 2, display_name: 'Other' }, can_accept: true })
    const h = harness({ intercept: (_owner, input) => {
      if (input.path === '/listings/foreign-order') { entered.resolve(undefined); return held.promise }
      if (input.path.endsWith('/accept')) return unknown()
      return undefined
    } }); await h.ready(); h.control.acceptListing('foreign-order'); await entered.promise
    try {
      expect(h.snapshot().claimingListingIds).toEqual(['foreign-order'])
      expect(h.snapshot().pending).toHaveLength(0)
      expect(h.request.mock.calls.some(([, input]) => input.method === 'POST')).toBe(false)
      h.control.acceptListing('foreign-order')
      expect(h.request.mock.calls.filter(([, input]) => input.path === '/listings/foreign-order')).toHaveLength(1)
    } finally { held.resolve(ok({ listing: fresh })) }
    await vi.waitFor(() => {
      expect(h.snapshot().claimingListingIds).toEqual([])
      expect(h.snapshot().pending[0]?.error?.unknown).toBe(true)
    })
    expect(h.request.mock.calls.filter(([, input]) => input.path.endsWith('/accept'))).toHaveLength(1)
  })

})
