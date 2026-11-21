/** Owner changes, durable mutation identities, read receipts and bounded upload recovery. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-credits/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDemandController, type DemandController } from '../src/client/controller.ts'
import { createDemandJournal, sliceDigest, type DemandJournal, type DemandStorage, type PendingOperation } from '../src/client/pending.ts'
import type { DemandOwner, DemandRequest, DemandResult } from '../src/client/api.ts'

type AccountSnapshot = ReturnType<Context['creditsSession']['getSnapshot']>
const ownerHash = 'a'.repeat(64)
const engineer = { id: 'example-engineer', display_name: 'Example engineer', avatar_attachment_id: 'example-avatar',
  category_ids: ['software'], introduction: 'Example-only test profile', service_hours: '', presence: 'offline', accepting: true, can_start: true, capacity: 4 }
function rawDemand(patch: Record<string, unknown> = {}) {
  return { id: 'example-demand', number: 'YS-EXAMPLE', engineer_id: engineer.id, engineer, user_id: 1, priority: 'normal',
    status: 'communicating', revision: 1, last_seq: 1, last_read_seq: 0, unread_count: 0, title: 'Example request', preview: 'Example message',
    budget: '', expected_date: '', delivery_id: '', created_at: 100, updated_at: 100, ...patch }
}
function rawMessage(patch: Record<string, unknown> = {}) {
  return { id: 'example-message', demand_id: 'example-demand', seq: 1, sender_id: 1, author: 'user', kind: 'message', text: 'Example message',
    attachments: [] as unknown[], created_at: 100, client_message_id: 'example-operation', read: false, ...patch }
}
const configuration = { config: { enabled: true, categories: [{ id: 'software', name: 'Example software', enabled: true }],
  upload_rules: { max_image_bytes: 20_971_520, max_video_bytes: 536_870_912, max_attachments: 8, chunk_bytes: 4,
    allowed_mime_types: ['image/png', 'video/mp4'], upload_ttl_seconds: 86400 } },
server_time: 100, capabilities: { polling: true, resumable_upload: true } }
function account(epoch = 1, hash = ownerHash, signedIn = true): AccountSnapshot {
  return { accountEpoch: epoch, loaded: true, balance: null, failure: null, session: { signedIn, creditsPerYuan: 1000,
    account: { id: '1', phone: '+8600000000000' }, accountOwner: hash } }
}
function memory(): DemandStorage {
  const data = new Map<string, string>()
  return { getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) }, removeItem: (key) => { data.delete(key) } }
}
const ok = (payload: unknown): DemandResult => ({ ok: true, payload })
const unknown = (): DemandResult => ({ ok: false, code: 'DEMAND_TIMEOUT', httpStatus: 0, unknown: true })
const controls: DemandController[] = []
afterEach(async () => { await Promise.all(controls.splice(0).map(control => control.dispose())); vi.useRealTimers() })

function harness(options: {
  journal?: DemandJournal
  intercept?: (owner: DemandOwner, input: DemandRequest) => DemandResult | undefined | Promise<DemandResult | undefined>
  rows?: ReturnType<typeof rawDemand>[]
} = {}) {
  const source = createSnapshotStore(account()), journal = options.journal ?? createDemandJournal(memory())
  const rows = options.rows ?? [rawDemand()]
  const messages = new Map<string, ReturnType<typeof rawMessage>[]>([[rows[0]?.id ?? 'example-demand', [rawMessage()]]])
  let sequence = 0
  const request = vi.fn(async (owner: DemandOwner, input: DemandRequest): Promise<DemandResult> => {
    const intercepted = await options.intercept?.(owner, input)
    if (intercepted !== undefined) return intercepted
    if (input.path === '/config') return ok(configuration)
    if (input.path === '/engineers') return ok({ items: [engineer], server_time: 100 })
    if (input.method === 'GET' && input.path.startsWith('?limit=')) return ok({ items: rows, next_before_id: null, has_more: false })
    const row = rows.find(item => item.id === input.path.split('/')[1])
    if (row !== undefined && input.path.includes('/messages?')) {
      const after = Number(new URLSearchParams(input.path.split('?')[1]).get('after_seq'))
      return ok({ items: (messages.get(row.id) ?? []).filter(item => item.seq > after), demand: row,
        next_after_seq: row.last_seq, last_seq: row.last_seq, has_more: false })
    }
    if (row !== undefined && input.path.endsWith('/read')) return ok({ last_read_seq: row.last_seq, unread_count: 0 })
    if (row !== undefined && input.method === 'GET') return ok({ demand: row })
    return { ok: false, code: 'DEMAND_NOT_FOUND', httpStatus: 404, unknown: false }
  })
  const control = createDemandController(source, { enabled: true, requestTimeoutMs: 20_000,
    foregroundPollMs: 3000, backgroundPollMs: 15_000, listPollMs: 15_000 }, {
    request, journal, uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    translate: key => key, isForeground: () => true,
  })
  controls.push(control); control.start()
  const snapshot = () => control.hooks.demands.getSnapshot()
  const ready = async () => { await vi.waitFor(() => { expect(snapshot().availability).toBe('ready'); expect(snapshot().requestsStatus).toBe('ready'); expect(snapshot().requests.length).toBe(rows.length) }) }
  return { control, source, journal, request, rows, messages, snapshot, ready }
}

describe('demand controller', () => {
  it('projects each demand and draft budget verbatim without borrowing the selected scope values', async () => {
    const h = harness({ rows: [rawDemand({ budget: 'USD 800–1,200, negotiable', expected_date: '2026-12-01' }),
      rawDemand({ id: 'example-other', budget: '', expected_date: '' })] })
    await h.ready()
    expect(h.snapshot().requests.map(({ id, budget, expectedDate }) => ({ id, budget, expectedDate }))).toEqual([
      { id: 'example-demand', budget: 'USD 800–1,200, negotiable', expectedDate: '2026-12-01' },
      { id: 'example-other', budget: '', expectedDate: '' },
    ])
    h.control.startRequest(engineer.id)
    const firstScope = h.snapshot().conversation?.scopeKey
    h.control.updateDraft({ text: 'First private draft', budget: '面议，分期', expectedDate: '2026-12-02' })
    h.control.startRequest(engineer.id)
    const secondScope = h.snapshot().conversation?.scopeKey
    h.control.updateDraft({ text: 'Second private draft', budget: 'RM 500', expectedDate: '' })
    expect(h.snapshot().drafts.find(item => item.scopeKey === firstScope)).toMatchObject({ budget: '面议，分期', expectedDate: '2026-12-02' })
    expect(h.snapshot().drafts.find(item => item.scopeKey === secondScope)).toMatchObject({ budget: 'RM 500', expectedDate: '' })
    h.control.openDraft(firstScope ?? '')
    expect(h.snapshot().draft?.budget).toBe('面议，分期')
    expect(h.request.mock.calls.some(([, input]) => input.method === 'POST' && input.path === '')).toBe(false)
  })

  it('reads the dynamic disabled config and history without inventing people or clearing saved requests', async () => {
    const h = harness({ intercept: (_owner, input) => input.path === '/config' ? ok({ ...configuration,
      config: { ...configuration.config, enabled: false } }) : undefined })
    await vi.waitFor(() => { expect(h.snapshot().availability).toBe('disabled'); expect(h.snapshot().requests).toHaveLength(1) })
    expect(h.snapshot().engineers[0]?.canStart).toBe(false)
    expect(h.snapshot().engineers[0]?.avatarUrl).toContain('/credits/api/demands/attachments/example-avatar/content?')
    expect(h.snapshot().uploadRules.maxImageBytes).toBe(20_971_520)
    expect(h.snapshot().uploadRules.maxVideoBytes).toBe(536_870_912)
    h.control.openRequest('example-demand')
    await vi.waitFor(() => { expect(h.snapshot().conversation?.messagesStatus).toBe('ready') })
    expect(h.snapshot().conversation?.canSend).toBe(true)
  })

  it('stops polling an older Host after its config route returns 404', async () => {
    vi.useFakeTimers()
    const h = harness({ intercept: (_owner, input) => input.path === '/config'
      ? { ok: false, code: 'DEMAND_NOT_FOUND', httpStatus: 404, unknown: false } : undefined })
    await vi.waitFor(() => { expect(h.snapshot().availability).toBe('unconfigured') })
    const count = h.request.mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.request).toHaveBeenCalledTimes(count)
    expect(h.snapshot().engineers).toEqual([])
  })

  it('clears synchronously and aborts the old owner when the same account gets a new owner epoch', async () => {
    let oldSignal: AbortSignal | undefined, release: ((answer: DemandResult) => void) | undefined
    const h = harness({ intercept: (_owner, input) => {
      if (input.path !== '/config' || release !== undefined) return undefined
      oldSignal = input.signal
      return new Promise<DemandResult>((resolve) => { release = resolve })
    } })
    await vi.waitFor(() => { expect(release).toBeTypeOf('function') })
    h.source.set(account(2, 'b'.repeat(64)))
    expect(oldSignal?.aborted).toBe(true)
    expect(h.snapshot().engineers).toEqual([])
    expect(h.snapshot().conversation).toBeNull()
    release?.(ok(configuration))
    await h.ready()
    expect(h.request.mock.calls.some(([owner]) => owner.epoch === 2 && owner.owner === 'b'.repeat(64))).toBe(true)
    h.source.set(account(3, 'b'.repeat(64), false))
    expect(h.snapshot().availability).toBe('login-required')
    expect(h.snapshot().requests).toEqual([])
  })

  it('persists before first POST, freezes unknown create bodies, retries the same key, and allows another new scope', async () => {
    let firstBody = '', attempts = 0
    const h = harness({ intercept: (_owner, input) => {
      if (input.method !== 'POST' || input.path !== '') return undefined
      attempts += 1
      expect(h.journal.read({ id: '1', owner: ownerHash }).some(item => item.body === input.body)).toBe(true)
      const body = JSON.parse(input.body ?? '{}') as { client_request_id: string; text: string }
      if (attempts === 1) { firstBody = input.body ?? ''; return unknown() }
      expect(input.body).toBe(firstBody)
      const row = rawDemand({ id: 'example-new', last_seq: 1, status: 'pending' })
      const item = rawMessage({ id: 'example-new-message', demand_id: row.id, client_message_id: body.client_request_id, text: body.text })
      h.rows.push(row); h.messages.set(row.id, [item])
      return ok({ demand: row, message: item, replayed: true })
    } })
    await h.ready(); h.control.startRequest(engineer.id); h.control.updateDraft({ text: 'Original body' }); h.control.send()
    await vi.waitFor(() => { expect(h.snapshot().conversation?.messages[0]?.state).toBe('failed') })
    const oldScope = h.snapshot().conversation?.scopeKey, operationId = h.snapshot().conversation?.messages[0]?.id ?? ''
    h.control.updateDraft({ text: 'Changed body' })
    expect(h.snapshot().draft?.text).toBe('Original body')
    expect(attempts).toBe(1)
    h.control.startRequest(engineer.id)
    expect(h.snapshot().conversation?.scopeKey).not.toBe(oldScope)
    h.control.updateDraft({ text: 'Separate new request' })
    const newScope = h.snapshot().conversation?.scopeKey ?? ''
    expect(h.snapshot().drafts).toHaveLength(2)
    expect(h.snapshot().drafts.find(item => item.scopeKey === oldScope)).toMatchObject({ title: 'Original body', pending: true })
    h.control.openDraft(oldScope ?? '')
    expect(h.snapshot().conversation?.scopeKey).toBe(oldScope)
    expect(h.snapshot().draft?.text).toBe('Original body')
    expect(attempts).toBe(1)
    h.control.openDraft(newScope)
    expect(h.snapshot().draft?.text).toBe('Separate new request')
    expect(h.snapshot().drafts.every(item => Number.isFinite(Date.parse(item.updatedAt)))).toBe(true)
    h.control.retryMessage(operationId)
    await vi.waitFor(() => { expect(attempts).toBe(2); expect(h.journal.read({ id: '1', owner: ownerHash })).toEqual([]) })
    expect(h.snapshot().draft?.text).toBe('Separate new request')
    expect(h.snapshot().drafts.map(item => item.scopeKey)).toEqual([newScope])
  })

  it('recovers a pending first submission after reload without automatically posting it', async () => {
    const journal = createDemandJournal(memory()), operationId = '00000000-0000-4000-8000-000000000099'
    const operation: PendingOperation = { version: 1, operationId, scopeKey: 'example-restored', kind: 'create', path: '', createdAt: 100,
      body: JSON.stringify({ client_request_id: operationId, engineer_id: engineer.id, text: 'Recovered request', attachment_ids: [], title: '', budget: '', expected_date: '' }) }
    journal.put({ id: '1', owner: ownerHash }, operation)
    const h = harness({ journal, intercept: (_owner, input) => input.path === '' && input.method === 'POST' ? unknown() : undefined })
    await h.ready()
    expect(h.snapshot().conversation?.scopeKey).toBe('example-restored')
    expect(h.snapshot().drafts[0]).toMatchObject({ scopeKey: 'example-restored', pending: true, title: 'Recovered request' })
    expect(h.snapshot().conversation?.messages[0]).toMatchObject({ id: operationId, state: 'failed', text: 'Recovered request', read: false })
    expect(h.request.mock.calls.filter(([, input]) => input.method === 'POST')).toHaveLength(0)
    h.control.retryMessage(operationId)
    await vi.waitFor(() => { expect(h.request.mock.calls.some(([, input]) => input.body === operation.body)).toBe(true) })
    expect(journal.read({ id: '1', owner: ownerHash })[0]?.operationId).toBe(operationId)
  })

  it('uses send to check an unknown first submission with its original body and suppresses concurrent checks', async () => {
    const bodies: string[] = []
    let release: ((result: DemandResult) => void) | undefined
    const h = harness({ intercept: (_owner, input) => {
      if (input.method !== 'POST' || input.path !== '') return undefined
      bodies.push(input.body ?? '')
      if (bodies.length === 1) return unknown()
      return new Promise<DemandResult>((resolve) => { release = resolve })
    } })
    await h.ready(); h.control.startRequest(engineer.id); h.control.updateDraft({ text: 'Frozen first submission' }); h.control.send()
    await vi.waitFor(() => { expect(h.snapshot().conversation?.canSend).toBe(false) })
    const operationId = h.snapshot().conversation?.messages[0]?.id
    h.control.updateDraft({ text: '' }); h.control.send()
    await vi.waitFor(() => { expect(bodies).toHaveLength(2); expect(release).toBeTypeOf('function') })
    h.control.send()
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe(bodies[0])
    expect(h.snapshot().conversation?.messages[0]?.id).toBe(operationId)
    release?.(unknown())
    await vi.waitFor(() => { expect(h.snapshot().draft?.sending).toBe(false) })
    expect(h.snapshot().drafts[0]?.pending).toBe(true)
  })

  it('allows a later independent message while an earlier unknown message keeps its own retry body', async () => {
    const sent: string[] = []
    const h = harness({ intercept: (_owner, input) => {
      if (input.path !== '/example-demand/messages' || input.method !== 'POST') return undefined
      sent.push(input.body ?? '')
      return unknown()
    } })
    await h.ready(); h.control.openRequest('example-demand')
    await vi.waitFor(() => { expect(h.snapshot().conversation?.messagesStatus).toBe('ready') })
    h.control.updateDraft({ text: 'First independent message' }); h.control.send()
    await vi.waitFor(() => { expect(h.snapshot().conversation?.messages.at(-1)?.state).toBe('failed') })
    const firstId = h.snapshot().conversation?.messages.at(-1)?.id ?? ''
    h.control.updateDraft({ text: 'Second independent message' }); h.control.send()
    await vi.waitFor(() => { expect(sent).toHaveLength(2) })
    const first = JSON.parse(sent[0] ?? '{}') as { client_message_id: string }
    const second = JSON.parse(sent[1] ?? '{}') as { client_message_id: string }
    expect(first.client_message_id).not.toBe(second.client_message_id)
    h.control.retryMessage(firstId)
    await vi.waitFor(() => { expect(sent).toHaveLength(3) })
    expect(sent[2]).toBe(sent[0])
    expect(h.snapshot().conversation?.messages.filter(item => item.state === 'sent')).toHaveLength(1)
  })

  it('clears an unknown message journal only after a matching persisted message is read back', async () => {
    let operationId = ''
    const h = harness({ intercept: (_owner, input) => {
      if (input.path !== '/example-demand/messages' || input.method !== 'POST') return undefined
      operationId = (JSON.parse(input.body ?? '{}') as { client_message_id: string }).client_message_id
      return unknown()
    } })
    await h.ready(); h.control.openRequest('example-demand')
    await vi.waitFor(() => { expect(h.snapshot().conversation?.messagesStatus).toBe('ready') })
    h.control.updateDraft({ text: 'Persisted despite lost receipt' }); h.control.send()
    await vi.waitFor(() => { expect(h.snapshot().conversation?.messages.at(-1)?.state).toBe('failed') })
    expect(h.journal.read({ id: '1', owner: ownerHash })).toHaveLength(1)
    const row = h.rows[0]
    if (row === undefined) throw new Error('Missing example row')
    row.last_seq = 2
    h.messages.set(row.id, [rawMessage(), rawMessage({ id: 'example-persisted', seq: 2,
      text: 'Persisted despite lost receipt', client_message_id: operationId })])
    h.control.openRequest(row.id)
    await vi.waitFor(() => { expect(h.journal.read({ id: '1', owner: ownerHash })).toEqual([]) })
    expect(h.snapshot().conversation?.messages.at(-1)).toMatchObject({ id: 'example-persisted', state: 'sent', read: false })
  })

  it('merges paginated requests without duplicates and retains them through a later list failure', async () => {
    let fail = false
    const h = harness({ intercept: (_owner, input) => {
      if (!input.path.startsWith('?limit=')) return undefined
      if (fail) return unknown()
      return input.path.includes('before_id=')
        ? ok({ items: [rawDemand(), rawDemand({ id: 'example-older', number: 'YS-OLDER' })], next_before_id: null, has_more: false })
        : ok({ items: [rawDemand()], next_before_id: 'example-demand', has_more: true })
    } })
    await h.ready(); expect(h.snapshot().requestsHaveMore).toBe(true)
    h.control.loadMoreRequests()
    await vi.waitFor(() => { expect(h.snapshot().requests).toHaveLength(2); expect(h.snapshot().requestsHaveMore).toBe(false) })
    fail = true; h.control.refresh()
    await vi.waitFor(() => { expect(h.snapshot().requestsStatus).toBe('error') })
    expect(h.snapshot().requests.map(item => item.id)).toEqual(['example-demand', 'example-older'])
  })

  it('marks read only after the selected panel is foreground and uses server receipt flags for sent messages', async () => {
    const h = harness(); await h.ready(); h.control.openRequest('example-demand')
    await vi.waitFor(() => { expect(h.snapshot().conversation?.messagesStatus).toBe('ready') })
    expect(h.request.mock.calls.filter(([, input]) => input.path.endsWith('/read'))).toHaveLength(0)
    expect(h.snapshot().conversation?.messages[0]?.read).toBe(false)
    h.messages.set('example-demand', [rawMessage({ read: true })])
    h.control.setVisible(true)
    await vi.waitFor(() => { expect(h.request.mock.calls.filter(([, input]) => input.path.endsWith('/read'))).toHaveLength(1) })
    expect(h.snapshot().conversation?.messages[0]?.read).toBe(true)
    h.control.setVisible(false)
  })

  it('maps historical author A without replacing it with current engineer B and preserves missing names', async () => {
    const row = rawDemand({ engineer_id: 'example-engineer-b', last_seq: 2,
      engineer: { ...engineer, id: 'example-engineer-b', display_name: 'Engineer B' } })
    const h = harness({ rows: [row] })
    h.messages.set(row.id, [rawMessage({ author: 'engineer', author_name: 'Engineer A' }),
      rawMessage({ id: 'example-legacy-message', seq: 2, author: 'engineer' })])
    await h.ready(); h.control.openRequest(row.id)
    await vi.waitFor(() => { expect(h.snapshot().conversation?.messagesStatus).toBe('ready') })
    expect(h.snapshot().conversation?.engineer?.displayName).toBe('Engineer B')
    expect(h.snapshot().conversation?.messages.map(item => item.authorName)).toEqual(['Engineer A', ''])
  })

  it('never sends a mutation when durable storage fails', async () => {
    const journal: DemandJournal = { read: () => [], put: () => { throw new Error('Storage denied') }, remove: () => {} }
    const h = harness({ journal }); await h.ready(); h.control.startRequest(engineer.id); h.control.updateDraft({ text: 'Example body' }); h.control.send()
    expect(h.snapshot().draft?.error).toBe('pendingStorageFailed')
    expect(h.request.mock.calls.filter(([, input]) => input.method === 'POST')).toHaveLength(0)
  })

  it('resumes an unknown chunk only after reading its committed offset and never reads a whole file', async () => {
    let offset = 0, putAttempts = 0
    const attachment = () => ({ id: 'example-upload', name: 'example.png', kind: 'image', mime_type: 'image/png', size_bytes: 8,
      uploaded_bytes: offset, status: offset === 8 ? 'ready' : 'uploading' })
    const h = harness({ intercept: async (_owner, input) => {
      if (input.path === '/uploads' || input.path === '/uploads/example-upload') return ok({ attachment: attachment(), offset, chunk_bytes: 4, expires_at: 1000 })
      if (input.path.endsWith('/chunks')) {
        expect(input.blob?.size).toBe(4); expect(input.offset).toBe(offset)
        putAttempts += 1; offset += 4
        return putAttempts === 1 ? unknown() : ok({ offset, attachment: attachment() })
      }
      if (input.path.endsWith('/complete')) return ok({ attachment: attachment() })
      return undefined
    } })
    await h.ready(); h.control.startRequest(engineer.id)
    const file = new File(['abcdefgh'], 'example.png', { type: 'image/png', lastModified: 100 })
    file.arrayBuffer = () => { throw new Error('Whole-file read forbidden') }
    h.control.addAttachments([file])
    await vi.waitFor(() => { expect(h.snapshot().draft?.attachments[0]?.status).toBe('ready') })
    const calls = h.request.mock.calls.map(([, input]) => input)
    expect(calls.filter(input => input.method === 'PUT').map(input => input.offset)).toEqual([0, 4])
    expect(calls.findIndex(input => input.path === '/uploads/example-upload')).toBeGreaterThan(calls.findIndex(input => input.method === 'PUT'))
    const stored = h.journal.read({ id: '1', owner: ownerHash })[0]
    expect(stored?.upload?.parts).toHaveLength(2)
    expect(stored?.upload?.ready).toBe(true)
    expect(stored?.upload?.engineerId).toBe(engineer.id)
  })

  it('retries an unknown upload initialization with the original durable UUID', async () => {
    const bodies: string[] = []
    const h = harness({ intercept: (_owner, input) => {
      if (input.path !== '/uploads') return undefined
      bodies.push(input.body ?? '')
      return unknown()
    } })
    await h.ready(); h.control.startRequest(engineer.id)
    h.control.addAttachments([new File(['abcd'], 'example.png', { type: 'image/png', lastModified: 100 })])
    await vi.waitFor(() => { expect(h.snapshot().draft?.attachments[0]?.status).toBe('failed') })
    const operationId = h.snapshot().draft?.attachments[0]?.id ?? ''
    h.control.retryAttachment(operationId)
    await vi.waitFor(() => { expect(bodies).toHaveLength(2) })
    expect(bodies[1]).toBe(bodies[0])
    expect(h.journal.read({ id: '1', owner: ownerHash })[0]?.operationId).toBe(operationId)
  })

  it('requires a matching reselected file before resuming a restored upload at its verified offset', async () => {
    const file = new File(['abcdefgh'], 'example.png', { type: 'image/png', lastModified: 100 }), journal = createDemandJournal(memory())
    const operationId = '00000000-0000-4000-8000-000000000090'
    journal.put({ id: '1', owner: ownerHash }, { version: 1, operationId, scopeKey: 'example-restored-upload', kind: 'upload', path: '/uploads', createdAt: 100,
      body: JSON.stringify({ client_upload_id: operationId, name: file.name, mime_type: file.type, size_bytes: file.size }),
      upload: { engineerId: engineer.id, requestId: null, uploadId: 'example-upload', ready: false,
        file: { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified },
        parts: [{ offset: 0, size: 4, sha256: await sliceDigest(file, 0, 4) }] } })
    let offset = 4
    const attachment = () => ({ id: 'example-upload', name: file.name, kind: 'image', mime_type: file.type, size_bytes: 8,
      uploaded_bytes: offset, status: offset === 8 ? 'ready' : 'uploading' })
    const h = harness({ journal, intercept: (_owner, input) => {
      if (input.path === '/uploads/example-upload') return ok({ attachment: attachment(), offset, chunk_bytes: 4, expires_at: 1000 })
      if (input.path.endsWith('/chunks')) { expect(input.offset).toBe(4); offset = 8; return ok({ offset, attachment: attachment() }) }
      if (input.path.endsWith('/complete')) return ok({ attachment: attachment() })
      return undefined
    } })
    await h.ready(); expect(h.snapshot().draft?.attachments[0]?.error).toBe('uploadReselect')
    h.control.addAttachments([new File(['xbcdxxxx'], file.name, { type: file.type, lastModified: 100 })])
    await vi.waitFor(() => { expect(h.snapshot().draft?.attachments[0]?.error).toBe('uploadFileMismatch') })
    expect(h.request.mock.calls.some(([, input]) => input.path.startsWith('/uploads'))).toBe(false)
    h.control.addAttachments([file])
    await vi.waitFor(() => { expect(h.snapshot().draft?.attachments[0]?.status).toBe('ready') })
    expect(h.request.mock.calls.filter(([, input]) => input.method === 'PUT')).toHaveLength(1)
  })

  it('preserves the original delivery action body when a receipt is unknown', async () => {
    const bodies: string[] = [], row = rawDemand({ status: 'awaiting_acceptance', last_seq: 2, delivery_id: 'example-delivery' })
    const h = harness({ rows: [row], intercept: (_owner, input) => {
      if (!input.path.endsWith('/actions')) return undefined
      bodies.push(input.body ?? ''); return unknown()
    } })
    h.messages.set(row.id, [rawMessage(), rawMessage({ id: 'example-delivery', seq: 2, author: 'engineer', kind: 'delivery', text: 'Example delivery' })])
    await h.ready(); h.control.openRequest(row.id)
    await vi.waitFor(() => { expect(h.snapshot().conversation?.delivery?.id).toBe('example-delivery') })
    h.control.acceptDelivery('example-delivery')
    await vi.waitFor(() => { expect(bodies).toHaveLength(1); expect(h.snapshot().conversation?.acceptingDelivery).toBe(false) })
    row.revision = 9
    h.control.refresh()
    await vi.waitFor(() => { expect(h.request.mock.calls.filter(([, input]) => input.path.startsWith('?limit='))).toHaveLength(2) })
    h.control.acceptDelivery('example-delivery')
    await vi.waitFor(() => { expect(bodies).toHaveLength(2) })
    expect(bodies[1]).toBe(bodies[0])
    expect(h.snapshot().conversation?.status).toBe('awaiting_acceptance')
  })

  it('reconciles an unknown acceptance only from the exact completed delivery without a second mutation', async () => {
    const row = rawDemand({ status: 'awaiting_acceptance', last_seq: 2, delivery_id: 'example-delivery' })
    let mutations = 0
    const h = harness({ rows: [row], intercept: (_owner, input) => {
      if (!input.path.endsWith('/actions')) return undefined
      mutations += 1; return unknown()
    } })
    h.messages.set(row.id, [rawMessage(), rawMessage({ id: 'example-delivery', seq: 2, author: 'engineer', kind: 'delivery' })])
    await h.ready(); h.control.openRequest(row.id)
    await vi.waitFor(() => { expect(h.snapshot().conversation?.delivery?.id).toBe('example-delivery') })
    h.control.acceptDelivery('example-delivery')
    await vi.waitFor(() => { expect(h.snapshot().conversation?.acceptingDelivery).toBe(false); expect(mutations).toBe(1) })
    const originalBody = h.journal.read({ id: '1', owner: ownerHash })[0]?.body
    expect(originalBody).toBeTypeOf('string')

    row.status = 'closed'; row.revision = 2; h.control.openRequest(row.id)
    await vi.waitFor(() => { expect(h.snapshot().conversation?.status).toBe('closed') })
    expect(h.journal.read({ id: '1', owner: ownerHash })[0]?.body).toBe(originalBody)
    row.status = 'completed'; row.delivery_id = 'different-delivery'; row.revision = 3; h.control.openRequest(row.id)
    await vi.waitFor(() => { expect(h.snapshot().conversation?.status).toBe('completed') })
    expect(h.journal.read({ id: '1', owner: ownerHash })[0]?.body).toBe(originalBody)

    row.delivery_id = 'example-delivery'; row.revision = 4; h.control.openRequest(row.id)
    await vi.waitFor(() => { expect(h.journal.read({ id: '1', owner: ownerHash })).toEqual([]) })
    expect(h.snapshot().conversation?.delivery?.status).toBe('accepted')
    expect(mutations).toBe(1)
  })

  it('backs off repeated network reads and aborts and joins outstanding work on dispose', async () => {
    vi.useFakeTimers()
    const h = harness({ intercept: (_owner, input) => input.path === '/config' ? unknown() : undefined })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.snapshot().availability).toBe('error')
    h.control.setVisible(true)
    await vi.advanceTimersByTimeAsync(5999)
    expect(h.request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(11_999)
    expect(h.request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.request).toHaveBeenCalledTimes(3)
    await h.control.dispose()

    let aborted = false, signal: AbortSignal | undefined
    const closing = harness({ intercept: (_owner, input) => {
      signal = input.signal
      return new Promise<DemandResult>((resolve) => { input.signal.addEventListener('abort', () => { aborted = true; resolve(unknown()) }, { once: true }) })
    } })
    await vi.advanceTimersByTimeAsync(0)
    expect(signal?.aborted).toBe(false)
    await closing.control.dispose()
    expect(aborted).toBe(true)
    expect(closing.snapshot().requests).toEqual([])
    const count = closing.request.mock.calls.length
    closing.source.set(account(2))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(closing.request).toHaveBeenCalledTimes(count)
  })
})

const platformConfig = { ...configuration,
  capabilities: { ...configuration.capabilities, service_profiles: true, engineer_pagination: true } }
const service = { id: 'service-web', code: 'YS-SVC-001', display_name: 'Original website service',
  service_direction: 'Website requests', introduction: 'Platform evaluates and assigns', category_ids: ['software'],
  avatar_attachment_id: 'service-avatar', intake_mode: 'platform', enabled: true, published: true, can_start: true }

function serviceGallery(owner: DemandOwner, imageId = 'service-image') {
  const url = (id: string): string => `/credits/api/demand-service-media/${service.id}/${id}/content?${new URLSearchParams({
    account_id: owner.id, account_owner: owner.owner, disposition: 'inline',
  })}`
  return { profile_id: service.id, revision: 1, cover_attachment_id: imageId, cover_url: url(imageId), media: [
    { id: imageId, kind: 'image', mime_type: 'image/png', size_bytes: 4, sha256: 'b'.repeat(64), url: url(imageId) },
    { id: 'service-video', kind: 'video', mime_type: 'video/mp4', size_bytes: 8, sha256: 'c'.repeat(64),
      url: url('service-video'), poster_url: url('service-poster') },
  ] }
}

describe('published service gallery reads', () => {
  it('requests gallery metadata only with its capability and maps local image/video paths without original filenames', async () => {
    const h = harness({ intercept: (owner, input) => {
      if (input.path === '/config') return ok({ ...platformConfig,
        capabilities: { ...platformConfig.capabilities, service_gallery_v1: true } })
      if (!input.path.startsWith('/service-profiles?')) return undefined
      expect(new URLSearchParams(input.path.split('?')[1]).get('include_media')).toBe('1')
      return ok(servicePage([{ ...service, gallery: serviceGallery(owner) }]))
    } })
    await h.ready()
    await vi.waitFor(() => { expect(h.snapshot().serviceProfiles[0]?.media).toHaveLength(2) })
    const profile = h.snapshot().serviceProfiles[0]
    expect(profile?.coverUrl).toContain(`/demand-service-media/${service.id}/service-image/content?`)
    expect(profile?.media?.[0]).toMatchObject({ id: 'service-image', kind: 'image', name: `${service.display_name} · serviceMediaIndex` })
    expect(profile?.media?.[1]?.kind).toBe('video')
    expect(profile?.media?.[1]?.posterUrl).toContain('/service-poster/content?')
    expect(h.request.mock.calls.some(([, input]) => input.method !== 'GET')).toBe(false)
  })

  it('keeps legacy directory queries unchanged and drops galleries after the backend withdraws the capability', async () => {
    let enabled = true
    const h = harness({ intercept: (owner, input) => {
      if (input.path === '/config') return ok({ ...platformConfig,
        capabilities: { ...platformConfig.capabilities, service_gallery_v1: enabled } })
      if (!input.path.startsWith('/service-profiles?')) return undefined
      expect(new URLSearchParams(input.path.split('?')[1]).has('include_media')).toBe(enabled)
      return ok(servicePage([{ ...service, ...enabled ? { gallery: serviceGallery(owner) } : {} }]))
    } })
    await h.ready()
    await vi.waitFor(() => { expect(h.snapshot().serviceProfiles[0]?.media).toHaveLength(2) })
    enabled = false; h.control.refresh()
    await vi.waitFor(() => { expect(h.snapshot().serviceProfiles[0]).not.toHaveProperty('media') })
    expect(h.snapshot().serviceProfiles[0]?.displayName).toBe(service.display_name)
    expect(h.request.mock.calls.some(([, input]) => input.method !== 'GET')).toBe(false)
  })

  it('rejects stale-owner gallery URLs and preserves the last verified service without creating a request', async () => {
    let invalid = false
    const h = harness({ intercept: (owner, input) => {
      if (input.path === '/config') return ok({ ...platformConfig,
        capabilities: { ...platformConfig.capabilities, service_gallery_v1: true } })
      if (!input.path.startsWith('/service-profiles?')) return undefined
      return ok(servicePage([{ ...service, gallery: serviceGallery(invalid ? { ...owner, owner: 'c'.repeat(64) } : owner) }]))
    } })
    await h.ready()
    await vi.waitFor(() => { expect(h.snapshot().serviceProfiles[0]?.media).toHaveLength(2) })
    const original = h.snapshot().serviceProfiles[0]
    invalid = true; h.control.refresh()
    await vi.waitFor(() => { expect(h.snapshot().servicesStatus).toBe('error') })
    expect(h.snapshot().serviceProfiles[0]).toEqual(original)
    expect(h.request.mock.calls.some(([, input]) => input.method !== 'GET')).toBe(false)
  })

  it('clears old media immediately on account change and ignores its delayed catalogue response', async () => {
    let release: ((value: DemandResult) => void) | undefined
    let oldOwner: DemandOwner | undefined
    const h = harness({ intercept: (owner, input) => {
      if (input.path === '/config') return ok({ ...platformConfig,
        capabilities: { ...platformConfig.capabilities, service_gallery_v1: true } })
      if (!input.path.startsWith('/service-profiles?')) return undefined
      if (owner.epoch === 1) {
        oldOwner = owner
        return new Promise<DemandResult>((resolve) => { release = resolve })
      }
      return ok(servicePage([{ ...service, gallery: serviceGallery(owner, 'current-image') }]))
    } })
    await vi.waitFor(() => { expect(release).toBeTypeOf('function') })
    h.source.set(account(2, 'd'.repeat(64)))
    expect(h.snapshot().serviceProfiles).toEqual([])
    await h.ready()
    await vi.waitFor(() => { expect(h.snapshot().serviceProfiles[0]?.media?.[0]?.id).toBe('current-image') })
    if (oldOwner === undefined) throw new Error('The original catalogue read captured its owner')
    release?.(ok(servicePage([{ ...service, gallery: serviceGallery(oldOwner) }])))
    await h.control.dispose()
    expect(h.request.mock.calls.some(([, input]) => input.method !== 'GET')).toBe(false)
  })
})
function servicePage(items: readonly (typeof service & { gallery?: ReturnType<typeof serviceGallery> })[] = [service],
  more = false, cursor = '', total = items.length) {
  return { items, next_after_id: cursor, has_more: more, total, server_time: 100 }
}

describe('platform intake and paged service state', () => {
  it('preserves an unknown service create and its display snapshot across reload without contaminating legacy direct storage', async () => {
    const journal = createDemandJournal(memory()), bodies: string[] = []
    const intercept = (_owner: DemandOwner, input: DemandRequest): DemandResult | undefined => {
      if (input.path === '/config') return ok(platformConfig)
      if (input.path.startsWith('/service-profiles?')) return ok(servicePage())
      if (input.path === '' && input.method === 'POST') { bodies.push(input.body ?? ''); return unknown() }
      return undefined
    }
    const h = harness({ journal, intercept }); await h.ready()
    expect(h.snapshot().directoryMode).toBe('services')
    expect(h.request.mock.calls.some(([, input]) => input.path === '/engineers')).toBe(false)
    h.control.startServiceRequest(service.id); h.control.updateDraft({ text: 'Original platform request' }); h.control.send()
    await vi.waitFor(() => { expect(h.snapshot().conversation?.messages[0]?.state).toBe('failed') })
    expect(JSON.parse(bodies[0] ?? '{}')).toHaveProperty('service_profile_id', service.id)
    expect(JSON.parse(bodies[0] ?? '{}')).not.toHaveProperty('engineer_id')
    expect(journal.read({ id: '1', owner: ownerHash })[0]).toMatchObject({ version: 2, serviceProfileId: service.id,
      serviceProfileName: service.display_name })
    await h.control.dispose()
    const restored = harness({ journal, intercept: (owner, input) => input.path.startsWith('/service-profiles?')
      ? ok(servicePage([{ ...service, display_name: 'Changed current catalog name' }])) : intercept(owner, input) })
    await restored.ready()
    expect(restored.snapshot().conversation).toMatchObject({ engineer: null, intakeMode: 'platform', assigned: false,
      serviceProfileId: service.id, serviceProfileName: service.display_name })
    expect(restored.snapshot().draft?.text).toBe('Original platform request')
    expect(bodies).toHaveLength(1)
    restored.control.send()
    await vi.waitFor(() => { expect(bodies).toHaveLength(2) })
    expect(bodies[1]).toBe(bodies[0])
  })

  it('retains the server source snapshot while an unassigned request later receives a real engineer', async () => {
    const projection = { ...engineer, id: 'platform-intake', accepting: false, can_start: false, capacity: 0 }
    const h = harness({ rows: [rawDemand({ engineer_id: 'platform-intake', engineer: projection, intake_mode: 'platform',
      assigned: false, service_profile_id: service.id, service_profile_name: 'Initial service source', status: 'pending' })],
    intercept: (_owner, input) => input.path === '/config' ? ok(platformConfig)
      : input.path.startsWith('/service-profiles?') ? ok(servicePage()) : undefined })
    await h.ready(); h.control.openRequest('example-demand')
    await vi.waitFor(() => { expect(h.snapshot().conversation?.messagesStatus).toBe('ready') })
    expect(h.snapshot().conversation).toMatchObject({ engineer: null, assigned: false, serviceProfileName: 'Initial service source' })
    h.rows[0] = rawDemand({ intake_mode: 'platform', assigned: true, service_profile_id: service.id,
      service_profile_name: 'Initial service source', revision: 2 })
    h.control.refresh()
    await vi.waitFor(() => { expect(h.snapshot().conversation?.assigned).toBe(true) })
    expect(h.snapshot().conversation?.engineer?.id).toBe(engineer.id)
    expect(h.snapshot().conversation?.serviceProfileName).toBe('Initial service source')
  })

  it('encodes opaque cursors, deduplicates page boundaries and discards late pages after a filter change without clearing drafts', async () => {
    const second = { ...service, id: 'service-second', code: 'YS-SVC-002', display_name: 'Second service' }
    let release: ((answer: DemandResult) => void) | undefined, oldSignal: AbortSignal | undefined
    const h = harness({ intercept: (_owner, input) => {
      if (input.path === '/config') return ok(platformConfig)
      if (!input.path.startsWith('/service-profiles?')) return undefined
      const query = new URLSearchParams(input.path.split('?')[1])
      if (query.get('q') === 'React + .NET*') return ok(servicePage([{ ...second, display_name: 'Filtered service' }]))
      if (query.has('after_id')) {
        expect(query.get('after_id')).toBe('opaque/cursor+==')
        oldSignal = input.signal
        return new Promise<DemandResult>((resolve) => { release = resolve })
      }
      return ok(servicePage([service], true, 'opaque/cursor+==', 3))
    } })
    await h.ready(); h.control.startServiceRequest(service.id); h.control.updateDraft({ text: 'Keep this independent draft' })
    const scope = h.snapshot().conversation?.scopeKey
    h.control.loadMoreServices()
    await vi.waitFor(() => { expect(release).toBeTypeOf('function') })
    h.control.setServiceFilter('React + .NET*', 'software')
    expect(oldSignal?.aborted).toBe(true)
    await vi.waitFor(() => { expect(h.snapshot().serviceProfiles[0]?.displayName).toBe('Filtered service') })
    release?.(ok(servicePage([service, second])))
    await vi.waitFor(() => { expect(h.snapshot().loadingMoreServices).toBe(false) })
    expect(h.snapshot().serviceProfiles.map(item => item.id)).toEqual([second.id])
    expect(h.snapshot().servicesTotal).toBe(1)
    expect(h.snapshot().conversation?.scopeKey).toBe(scope)
    expect(h.snapshot().draft?.text).toBe('Keep this independent draft')
    expect(h.snapshot().conversation?.serviceProfileName).toBe(service.display_name)
  })

  it('does not duplicate overlapping profiles when the next page arrives', async () => {
    const second = { ...service, id: 'service-second', code: 'YS-SVC-002', display_name: 'Second service' }
    const h = harness({ intercept: (_owner, input) => input.path === '/config' ? ok(platformConfig)
      : input.path.startsWith('/service-profiles?') ? ok(input.path.includes('after_id=')
        ? servicePage([service, second], false, '', 2) : servicePage([service], true, 'cursor', 2)) : undefined })
    await h.ready(); h.control.loadMoreServices()
    await vi.waitFor(() => { expect(h.snapshot().serviceProfiles).toHaveLength(2) })
    expect(h.snapshot().serviceProfiles.map(item => item.id)).toEqual([service.id, second.id])
    expect(h.snapshot().servicesHaveMore).toBe(false)
  })

  it('recovers a service upload target after reload and reselects its original file without creating a new upload key', async () => {
    const journal = createDemandJournal(memory()), bodies: string[] = []
    const intercept = (_owner: DemandOwner, input: DemandRequest): DemandResult | undefined => {
      if (input.path === '/config') return ok(platformConfig)
      if (input.path.startsWith('/service-profiles?')) return ok(servicePage())
      if (input.path === '/uploads' && input.method === 'POST') { bodies.push(input.body ?? ''); return unknown() }
      return undefined
    }
    const file = new File(['abcd'], 'service.png', { type: 'image/png', lastModified: 100 })
    const first = harness({ journal, intercept }); await first.ready(); first.control.startServiceRequest(service.id)
    first.control.addAttachments([file])
    await vi.waitFor(() => { expect(first.snapshot().draft?.attachments[0]?.status).toBe('failed') })
    expect(journal.read({ id: '1', owner: ownerHash })[0]).toMatchObject({ version: 2, serviceProfileId: service.id,
      upload: { engineerId: '', serviceProfileId: service.id } })
    await first.control.dispose()
    const restored = harness({ journal, intercept }); await restored.ready()
    expect(restored.snapshot().conversation).toMatchObject({ intakeMode: 'platform', assigned: false, serviceProfileId: service.id })
    restored.control.addAttachments([file])
    await vi.waitFor(() => { expect(bodies).toHaveLength(2) })
    expect(bodies[1]).toBe(bodies[0])
  })
})

it('immediately replaces an in-flight service read when refresh is requested, without waiting for the aborted reply', async () => {
  let release: ((answer: DemandResult) => void) | undefined, firstSignal: AbortSignal | undefined, reads = 0
  const h = harness({ intercept: (_owner, input) => {
    if (input.path === '/config') return ok(platformConfig)
    if (!input.path.startsWith('/service-profiles?')) return undefined
    reads += 1
    if (reads === 1) { firstSignal = input.signal; return new Promise<DemandResult>((resolve) => { release = resolve }) }
    return ok(servicePage())
  } })
  await vi.waitFor(() => { expect(release).toBeTypeOf('function') })
  h.control.refresh()
  try {
    await vi.waitFor(() => { expect(reads).toBe(2); expect(h.snapshot().serviceProfiles).toHaveLength(1) })
    expect(firstSignal?.aborted).toBe(true)
  } finally { release?.(unknown()) }
  await h.ready()
})

it('does not acknowledge a create receipt for a different platform source, retaining the original operation for reconciliation', async () => {
  const h = harness({ intercept: (_owner, input) => {
    if (input.path === '/config') return ok(platformConfig)
    if (input.path.startsWith('/service-profiles?')) return ok(servicePage())
    if (input.path !== '' || input.method !== 'POST') return undefined
    const body = JSON.parse(input.body ?? '{}') as { client_request_id: string; text: string }
    const row = rawDemand({ intake_mode: 'platform', assigned: false, service_profile_id: 'other-service',
      service_profile_name: 'Unrelated service', engineer_id: 'platform-intake', status: 'pending',
      engineer: { ...engineer, id: 'platform-intake', accepting: false, can_start: false, capacity: 0 } })
    return ok({ demand: row, message: rawMessage({ client_message_id: body.client_request_id, text: body.text }), replayed: false })
  } })
  await h.ready(); h.control.startServiceRequest(service.id); h.control.updateDraft({ text: 'Keep selected source' }); h.control.send()
  await vi.waitFor(() => { expect(h.snapshot().draft?.sending).toBe(false); expect(h.snapshot().conversation?.error).toBe('resultUnknown') })
  expect(h.snapshot().conversation?.requestId).toBeNull()
  expect(h.journal.read({ id: '1', owner: ownerHash })).toHaveLength(1)
  expect(h.snapshot().conversation?.serviceProfileId).toBe(service.id)
})
