/** Account-owned community workflow, separate from official demand state and AI sessions. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-credits/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  communityContentUrl, requestCommunity, type CommunityOwner, type CommunityRequest, type CommunityResult,
} from './community-api.ts'
import {
  createCommunityJournal, communityFileDigest, communitySliceDigest, matchesCommunityUpload,
  type CommunityJournal, type CommunityOperation,
} from './community-pending.ts'
import type {
  CommunityAttachment, CommunityConfig, CommunityConversation, CommunityFace, CommunityIssue,
  CommunityListing, CommunityLocalMessage, CommunityMessage, CommunityOrder, CommunityPage, CommunityPublicationDraft,
  CommunityPublicationFields, CommunityState, CommunityUploadTarget, CommunityUploadView,
} from './community-types.ts'
import * as wire from './community-wire.ts'

/** Validated local feature and I/O deadlines; server config remains the authority for new publication. */
export interface CommunityControllerConfig {
  readonly enabled: boolean
  readonly requestTimeoutMs?: number
  readonly uploadTimeoutMs?: number
  readonly foregroundPollMs?: number
  readonly backgroundPollMs?: number
  readonly listPollMs?: number
}
/** Replaceable one-attempt transport, durable storage and clock; contains no user credentials. */
export interface CommunityControllerDependencies {
  readonly request?: typeof requestCommunity
  readonly journal?: CommunityJournal
  readonly uuid?: () => string
  readonly now?: () => number
  readonly isForeground?: () => boolean
  readonly download?: (url: string) => void
}
/** Model face with explicit subscription, visibility and joined cancellation. */
export interface CommunityController extends CommunityFace {
  readonly start: () => () => void
  readonly setVisible: (visible: boolean) => void
  readonly dispose: () => Promise<void>
}
type OrderView = 'published' | 'accepted' | 'all'
interface Page<T> {
  items: T[]
  cursor: string
  hasMore: boolean
  status: 'loading' | 'ready' | 'error'
  loadingMore: boolean
  error: CommunityIssue | null
  epoch: number
  flight: AbortController | null
}
interface Conversation {
  status: 'loading' | 'ready' | 'error'
  hasMore: boolean
  loadingMore: boolean
  cursor: number
  text: string
  error: CommunityIssue | null
}
const page = <T>(): Page<T> => ({ items: [], cursor: '', hasMore: false, status: 'ready', loadingMore: false,
  error: null, epoch: 0, flight: null })
const presentation = <T>(value: Page<T>): CommunityPage<T> => ({ items: value.items, status: value.status,
  hasMore: value.hasMore, loadingMore: value.loadingMore, error: value.error })
const fields = (): CommunityPublicationFields => ({ publishToCommunity: false, title: '', publicSummary: '',
  publicBudget: '', expectedDeliveryDate: '', serviceProfileId: '', privateText: '' })
const issue = (code: string, unknown = false, operationId: string | null = null): CommunityIssue => ({ code, unknown, operationId })
const blank = (availability: CommunityState['availability']): CommunityState => ({ availability, accountId: null, config: null,
  error: null, listingQuery: '', listingServiceProfileId: '', listings: presentation(page()),
  orders: { published: presentation(page()), accepted: presentation(page()), all: presentation(page()) },
  selectedListing: null, selectedListingStatus: 'ready', selectedListingError: null, claimingListingIds: [], selectedOrderId: null,
  selectedOrderStatus: 'ready', selectedOrderError: null, conversation: null,
  activePublicationScope: null, publications: [], uploads: [], pending: [] })
const sameTarget = (a: CommunityUploadTarget, b: CommunityUploadTarget): boolean => a.kind === 'publication'
  ? b.kind === 'publication' && a.scopeKey === b.scopeKey : b.kind === 'order' && a.orderId === b.orderId
const targetKey = (value: CommunityUploadTarget): string => value.kind === 'publication' ? value.scopeKey : `order:${value.orderId}`
const views: readonly OrderView[] = ['published', 'accepted', 'all']
const decodeConfigReply = (value: unknown): unknown => value
const decodeListingReply = (value: unknown): unknown => wire.communityObject(value).listing
const decodeOrderReply = (value: unknown): unknown => wire.communityObject(value).order

/**
 * Create an account-isolated community model without subscribing or dispatching until start.
 * @param accountSource - Shared existing product-login source.
 * @param config - Validated local polling and transport configuration.
 * @param deps - Testable transport, persistence and lifecycle adapters.
 * @returns Observable model, independent commands and joined disposal.
 */
export function createCommunityController(accountSource: Context['creditsSession'], config: CommunityControllerConfig,
  deps: CommunityControllerDependencies = {}): CommunityController {
  for (const value of [config.requestTimeoutMs, config.uploadTimeoutMs, config.foregroundPollMs,
    config.backgroundPollMs, config.listPollMs]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000)) throw new Error('COMMUNITY_CONFIG_INVALID')
  }
  const source = createSnapshotStore<CommunityState>(blank(config.enabled ? 'loading' : 'unavailable'))
  const request = deps.request ?? requestCommunity, journal = deps.journal ?? createCommunityJournal()
  const newId = (): string => wire.communityUuid((deps.uuid ?? randomUUID)()), now = deps.now ?? Date.now
  const clock = (): number => wire.communityInteger(now(), 8_640_000_000_000_000)
  let active = false, visible = false, owner: CommunityOwner | null = null, unsubscribe: (() => void) | undefined
  let closed: Promise<void> | undefined, accountAbort = new AbortController(), timer: ReturnType<typeof setTimeout> | undefined
  let availability: CommunityState['availability'] = config.enabled ? 'loading' : 'unavailable', error: CommunityIssue | null = null
  let server: CommunityConfig | null = null, unsupported = false, storageFailed = false, refreshTask: Promise<void> | undefined
  let listingQuery = '', serviceId = '', listingEpoch = 0, detailEpoch = 0, selectedOrderId: string | null = null
  let selectedListing: CommunityListing | null = null, selectedListingStatus: 'loading' | 'ready' | 'error' = 'ready'
  let selectedOrderStatus: 'loading' | 'ready' | 'error' = 'ready', selectedOrderError: CommunityIssue | null = null
  let selectedListingError: CommunityIssue | null = null, activePublicationScope: string | null = null, lastRefresh = 0
  let listings = page<CommunityListing>()
  const orders: Record<OrderView, Page<CommunityOrder>> = { published: page(), accepted: page(), all: page() }
  const orderRecords = new Map<string, CommunityOrder>(), conversations = new Map<string, Conversation>()
  const histories = new Map<string, Map<number, CommunityMessage>>(), publications = new Map<string, CommunityPublicationDraft>()
  const operations = new Map<string, CommunityOperation>(), operationErrors = new Map<string, CommunityIssue>()
  const inflight = new Set<string>(), confirmed = new Set<string>(), assets = new Map<string, CommunityAttachment>()
  const files = new Map<string, File>(), progress = new Map<string, number>(), uploadFlights = new Map<string, AbortController>()
  const messageFlights = new Map<string, Promise<void>>(), readFlights = new Set<string>(), claiming = new Set<string>()
  const tasks = new Set<Promise<void>>(), flights = new Set<AbortController>()
  const foreground = (): boolean => visible && (deps.isForeground?.() ?? (typeof document === 'undefined'
    || document.visibilityState !== 'hidden' && document.hasFocus()))
  const sameOwner = (captured: CommunityOwner): boolean => {
    const current = accountSource.getSnapshot(), session = current.session
    return active && owner === captured && current.accountEpoch === captured.epoch && session?.signedIn === true
      && session.account?.id === captured.id && session.accountOwner === captured.owner
  }
  const pending = (scopeKey: string, kind?: CommunityOperation['kind']): CommunityOperation[] => [...operations.values()]
    .filter(item => item.scopeKey === scopeKey && !confirmed.has(item.operationId) && (kind === undefined || item.kind === kind))
  const draftConversation = (id: string): Conversation => {
    let result = conversations.get(id)
    if (result === undefined) {
      result = { status: 'ready', hasMore: false, loadingMore: false, cursor: 0, text: '', error: null }; conversations.set(id, result)
    }
    return result
  }
  const reservedAssets = (): Set<string> => {
    const result = new Set<string>()
    for (const item of operations.values()) {
      if (confirmed.has(item.operationId) || item.kind === 'upload' || item.kind === 'accept') continue
      const body = wire.communityObject(wire.communityJson(item.body))
      const ids = item.kind === 'publication' ? [
        ...wire.communityArray(body.public_attachment_ids, 8, wire.communityId),
        ...wire.communityArray(body.private_attachment_ids, 8, wire.communityId),
      ] : wire.communityArray(body.attachment_ids, 8, wire.communityId)
      for (const id of ids) result.add(id)
    }
    return result
  }
  const uploadViews = (): CommunityUploadView[] => [...operations.values()].flatMap((operation) => {
    const data = operation.upload
    if (data === undefined || confirmed.has(operation.operationId)) return []
    const failure = operationErrors.get(operation.operationId) ?? null
    return [{ operationId: operation.operationId, target: data.target, scope: data.scope,
      attachment: data.attachmentId === null ? null : assets.get(data.attachmentId) ?? null,
      name: data.file.name, sizeBytes: data.file.size, mimeType: data.file.type,
      progressPercent: data.ready ? 100 : progress.get(operation.operationId) ?? 0,
      status: data.ready ? 'ready' : uploadFlights.has(operation.operationId) ? 'uploading'
        : files.has(operation.operationId) ? 'failed' : 'reselect',
      reserved: data.attachmentId !== null && reservedAssets().has(data.attachmentId), error: failure }]
  })
  const localMessages = (id: string): CommunityLocalMessage[] => pending(`order:${id}`, 'message').map((operation) => {
    const body = wire.communityObject(wire.communityJson(operation.body)), failure = operationErrors.get(operation.operationId) ?? null
    return { operationId: operation.operationId, orderId: id, text: wire.communityText(body.text, 12_000, true),
      attachments: wire.communityArray(body.attachment_ids, 8, wire.communityId).flatMap((id) => {
        const asset = assets.get(id); return asset === undefined ? [] : [asset]
      }),
      createdAt: operation.createdAt, state: inflight.has(operation.operationId) ? 'sending'
        : failure === null || failure.unknown ? 'unknown' : 'failed',
      error: failure ?? (inflight.has(operation.operationId) ? null : issue('COMMUNITY_RESULT_UNKNOWN', true, operation.operationId)) }
  })
  const publish = (): void => {
    let conversation: CommunityConversation | null = null
    const record = selectedOrderId === null ? undefined : orderRecords.get(selectedOrderId)
    if (record !== undefined && owner !== null) {
      const state = draftConversation(record.id)
      conversation = { order: record, messages: [...(histories.get(record.id)?.values() ?? [])].sort((a, b) => a.seq - b.seq)
        .map(item => ({ ...item, isSelf: String(item.sender_id) === owner?.id })), pendingMessages: localMessages(record.id),
      status: state.status, hasMore: state.hasMore, loadingMore: state.loadingMore, draftText: state.text, error: state.error }
    }
    source.set({ availability, accountId: owner?.id ?? null, config: server, error, listingQuery, listingServiceProfileId: serviceId,
      listings: presentation(listings), orders: { published: presentation(orders.published),
        accepted: presentation(orders.accepted), all: presentation(orders.all) },
      selectedListing, selectedListingStatus, selectedListingError, claimingListingIds: [...claiming],
      selectedOrderId, selectedOrderStatus, selectedOrderError,
      conversation, activePublicationScope,
      publications: [...publications.values()].map((item) => {
        const original = pending(item.scopeKey, 'publication')[0]
        return { ...item, sending: original !== undefined && inflight.has(original.operationId), locked: original !== undefined,
          error: original === undefined ? item.error : operationErrors.get(original.operationId) ?? null }
      }), uploads: uploadViews(), pending: [...operations.values()].filter(item => !confirmed.has(item.operationId)).map(item => ({
        operationId: item.operationId, scopeKey: item.scopeKey, orderId: item.orderId, kind: item.kind,
        inflight: inflight.has(item.operationId) || uploadFlights.has(item.operationId),
        error: operationErrors.get(item.operationId) ?? null,
      })) })
  }
  const track = (work: () => Promise<void>): void => {
    const captured = owner
    const task = work().catch((_failure: unknown) => {
      if (captured !== null && sameOwner(captured)) { error = issue('COMMUNITY_PROTOCOL_INVALID'); publish() }
    })
    tasks.add(task); void task.finally(() => { tasks.delete(task) })
  }
  const perform = async (captured: CommunityOwner, input: Omit<CommunityRequest, 'signal'>,
    signal?: AbortSignal): Promise<CommunityResult> => {
    const flight = new AbortController(), cancel = (): void => { flight.abort() }
    const deadlineState = { expired: false }
    const deadline = setTimeout(() => { deadlineState.expired = true; flight.abort() }, input.blob === undefined
      ? config.requestTimeoutMs ?? 20_000 : config.uploadTimeoutMs ?? 120_000)
    accountAbort.signal.addEventListener('abort', cancel, { once: true }); signal?.addEventListener('abort', cancel, { once: true })
    flights.add(flight)
    if (!sameOwner(captured) || signal?.aborted === true || accountAbort.signal.aborted) flight.abort()
    try {
      const answer = await request(captured, { ...input, signal: flight.signal })
      return deadlineState.expired ? { ok: false, code: 'COMMUNITY_TIMEOUT', httpStatus: 0, unknown: input.method !== 'GET' } : answer
    } finally {
      clearTimeout(deadline); accountAbort.signal.removeEventListener('abort', cancel)
      signal?.removeEventListener('abort', cancel); flights.delete(flight)
    }
  }
  const save = (captured: CommunityOwner, operation: CommunityOperation): boolean => {
    if (!sameOwner(captured)) return false
    try { journal.put(captured, operation); operations.set(operation.operationId, operation); return true }
    catch (_storage: unknown) { storageFailed = true; error = issue('COMMUNITY_PENDING_STORAGE_FAILED'); publish(); return false }
  }
  const remove = (captured: CommunityOwner, operationId: string): void => {
    if (!sameOwner(captured) || !operations.has(operationId) || confirmed.has(operationId)) return
    try { journal.remove(captured, operationId); operations.delete(operationId); operationErrors.delete(operationId) }
    catch (_storage: unknown) { confirmed.add(operationId); storageFailed = true; error = issue('COMMUNITY_PENDING_STORAGE_FAILED') }
  }
  const mergeOrder = (incoming: CommunityOrder): CommunityOrder => {
    const previous = orderRecords.get(incoming.id)
    if (previous !== undefined && (incoming.revision < previous.revision || incoming.last_seq < previous.last_seq)) return previous
    const result = previous !== undefined && incoming.last_read_seq < previous.last_read_seq
      ? { ...incoming, last_read_seq: previous.last_read_seq, unread_count: previous.unread_count } : incoming
    orderRecords.set(result.id, result)
    for (const view of views) orders[view].items = orders[view].items.map(item => item.id === result.id ? result : item)
    for (const attachment of incoming.listing.public_attachments) assets.set(attachment.id, attachment)
    return result
  }
  const reconcileMessages = (captured: CommunityOwner, id: string, values: readonly CommunityMessage[]): void => {
    let history = histories.get(id)
    if (history === undefined) { history = new Map(); histories.set(id, history) }
    for (const message of values) {
      const previous = history.get(message.seq)
      if (previous !== undefined && previous.id !== message.id
        || [...history.values()].some(item => item.id === message.id && item.seq !== message.seq)) throw new wire.CommunityWireError()
      history.set(message.seq, message)
      for (const attachment of message.attachments) assets.set(attachment.id, attachment)
      const original = operations.get(message.client_message_id)
      if (original?.kind === 'message' && original.orderId === id && String(message.sender_id) === captured.id) {
        const body = wire.communityObject(wire.communityJson(original.body))
        if (body.text !== message.text || JSON.stringify(wire.communityArray(body.attachment_ids, 8, wire.communityId).slice().sort())
          !== JSON.stringify(message.attachments.map(item => item.id).sort())) throw new wire.CommunityWireError()
        clearConsumedUploads(captured, message.attachments.map(item => item.id))
        remove(captured, original.operationId)
      }
    }
  }
  const readListings = async (captured: CommunityOwner, more = false): Promise<void> => {
    if (!sameOwner(captured) || unsupported || server?.enabled !== true || !wire.communityApprovalAvailable(server)
      || listings.flight !== null || more && !listings.hasMore) return
    const epoch = listingEpoch, current = listings, flight = new AbortController()
    current.flight = flight; current.loadingMore = more; current.status = current.items.length === 0 ? 'loading' : current.status
    current.error = null; publish()
    try {
      const query = new URLSearchParams({ limit: '30' })
      if (more) query.set('cursor', current.cursor)
      if (listingQuery !== '') query.set('q', listingQuery)
      if (serviceId !== '') query.set('service_profile_id', serviceId)
      const answer = await perform(captured, { method: 'GET', path: `/listings?${query}` }, flight.signal)
      if (!sameOwner(captured) || epoch !== listingEpoch || flight.signal.aborted) return
      if (!answer.ok) { current.error = issue(answer.code); current.status = 'error'; return }
      const result = wire.communityPage(answer.payload, wire.communityListing)
      if (result.items.some(item => item.approval_status !== 'approved')) throw new wire.CommunityWireError()
      const values = new Map((more ? current.items : []).map(item => [item.id, item]))
      for (const item of result.items) {
        values.set(item.id, item)
        for (const asset of item.public_attachments) assets.set(asset.id, asset)
      }
      current.items = [...values.values()]; current.cursor = result.next_cursor; current.hasMore = result.has_more; current.status = 'ready'
    } catch (_protocol: unknown) {
      if (sameOwner(captured) && epoch === listingEpoch) { current.error = issue('COMMUNITY_PROTOCOL_INVALID'); current.status = 'error' }
    } finally {
      if (sameOwner(captured) && epoch === listingEpoch) { current.flight = null; current.loadingMore = false; publish() }
    }
  }
  const readOrders = async (captured: CommunityOwner, view: OrderView, more = false): Promise<void> => {
    const current = orders[view], epoch = current.epoch
    if (!sameOwner(captured) || unsupported || current.flight !== null || more && !current.hasMore) return
    const flight = new AbortController(); current.flight = flight; current.loadingMore = more
    if (current.items.length === 0) current.status = 'loading'
    current.error = null; publish()
    try {
      const query = new URLSearchParams({ view, limit: '30' })
      if (more) query.set('cursor', current.cursor)
      const answer = await perform(captured, { method: 'GET', path: `/orders?${query}` }, flight.signal)
      if (!sameOwner(captured) || current.epoch !== epoch || flight.signal.aborted) return
      if (!answer.ok) { current.status = 'error'; current.error = issue(answer.code); return }
      const result = wire.communityPage(answer.payload, value => wire.communityOrder(value, captured.id))
      const values = new Map((more ? current.items : []).map(item => [item.id, item]))
      for (const item of result.items) {
        if (view === 'published' && String(item.publisher.id) !== captured.id
          || view === 'accepted' && String(item.acceptor?.id) !== captured.id) throw new wire.CommunityWireError()
        values.set(item.id, mergeOrder(item))
      }
      current.items = [...values.values()]; current.cursor = result.next_cursor; current.hasMore = result.has_more; current.status = 'ready'
    } catch (_protocol: unknown) {
      if (sameOwner(captured) && current.epoch === epoch) { current.status = 'error'; current.error = issue('COMMUNITY_PROTOCOL_INVALID') }
    } finally {
      if (sameOwner(captured) && current.epoch === epoch) { current.flight = null; current.loadingMore = false; publish() }
    }
  }
  const readListing = async (captured: CommunityOwner, id: string): Promise<CommunityListing | null> => {
    const epoch = ++detailEpoch
    selectedListingStatus = 'loading'; selectedListingError = null; publish()
    try {
      const answer = await perform(captured, { method: 'GET', path: `/listings/${id}` })
      if (!sameOwner(captured) || epoch !== detailEpoch) return null
      if (!answer.ok) { selectedListingStatus = 'error'; selectedListingError = issue(answer.code); return null }
      const result = wire.communityListing(decodeListingReply(answer.payload))
      if (result.id !== id) throw new wire.CommunityWireError()
      if (result.approval_status !== 'approved') {
        selectedListingStatus = 'error'; selectedListingError = issue('COMMUNITY_APPROVAL_REQUIRED'); return null
      }
      selectedListing = result; selectedListingStatus = 'ready'
      for (const asset of result.public_attachments) assets.set(asset.id, asset)
      return result
    } catch (_protocol: unknown) {
      if (sameOwner(captured) && epoch === detailEpoch) {
        selectedListingStatus = 'error'; selectedListingError = issue('COMMUNITY_PROTOCOL_INVALID')
      }
      return null
    } finally { if (sameOwner(captured) && epoch === detailEpoch) publish() }
  }
  const readMessages = async (captured: CommunityOwner, id: string, more = false): Promise<void> => {
    if (!sameOwner(captured) || messageFlights.has(id)) return
    const state = draftConversation(id), after = state.cursor
    if (more && !state.hasMore) return
    if ((histories.get(id)?.size ?? 0) === 0) state.status = 'loading'
    state.loadingMore = more; state.error = null; publish()
    const task = (async () => {
      try {
        const query = new URLSearchParams({ after_seq: String(after), limit: '100' })
        const answer = await perform(captured, { method: 'GET', path: `/orders/${id}/messages?${query}` })
        if (!sameOwner(captured)) return
        if (!answer.ok) { state.status = 'error'; state.error = issue(answer.code); return }
        const result = wire.communityMessages(answer.payload, id, captured.id, after)
        mergeOrder(result.order); reconcileMessages(captured, id, result.items)
        state.cursor = result.next_after_seq; state.hasMore = result.has_more; state.status = 'ready'
      } catch (_protocol: unknown) {
        if (sameOwner(captured)) { state.status = 'error'; state.error = issue('COMMUNITY_PROTOCOL_INVALID') }
      } finally {
        if (sameOwner(captured)) { state.loadingMore = false; messageFlights.delete(id); publish() }
      }
    })()
    messageFlights.set(id, task); await task
  }
  const readOrder = async (captured: CommunityOwner, id: string): Promise<void> => {
    selectedOrderId = id; selectedOrderStatus = 'loading'; selectedOrderError = null
    activePublicationScope = null; draftConversation(id); publish()
    try {
      const answer = await perform(captured, { method: 'GET', path: `/orders/${id}` })
      if (!sameOwner(captured) || selectedOrderId !== id) return
      if (!answer.ok) {
        selectedOrderStatus = 'error'; selectedOrderError = issue(answer.code)
        draftConversation(id).error = issue(answer.code); publish(); return
      }
      const result = wire.communityOrder(decodeOrderReply(answer.payload), captured.id)
      if (result.id !== id) throw new wire.CommunityWireError()
      mergeOrder(result); selectedOrderStatus = 'ready'; publish(); await readMessages(captured, id)
    } catch (_protocol: unknown) {
      if (sameOwner(captured) && selectedOrderId === id) {
        selectedOrderStatus = 'error'; selectedOrderError = issue('COMMUNITY_PROTOCOL_INVALID')
        draftConversation(id).error = selectedOrderError; publish()
      }
    }
  }
  const closePublicDiscovery = (code: string): void => {
    listingEpoch += 1; detailEpoch += 1; listings.flight?.abort(); listings = page(); selectedListing = null
    selectedListingStatus = 'error'; selectedListingError = issue(code)
  }
  const refreshAll = async (): Promise<void> => {
    if (refreshTask !== undefined) return refreshTask
    const captured = owner
    if (captured === null || !sameOwner(captured) || !config.enabled) return
    const task = (async () => {
      try {
        const answer = await perform(captured, { method: 'GET', path: '/config' })
        if (!sameOwner(captured)) return
        if (!answer.ok) {
          if (answer.httpStatus === 404) {
            unsupported = true; availability = 'unavailable'; error = null
            closePublicDiscovery('COMMUNITY_UNAVAILABLE'); return
          }
          availability = 'error'; error = issue(answer.code); return
        }
        const next = wire.communityConfig(decodeConfigReply(answer.payload))
        if (!next.capabilities.community_orders_v1 || !next.capabilities.explicit_publication
          || !next.capabilities.single_acceptor || !next.capabilities.private_participant_messages) {
          unsupported = true; availability = 'unavailable'; error = null
          closePublicDiscovery('COMMUNITY_UNAVAILABLE'); return
        }
        server = next; unsupported = false; availability = storageFailed ? 'error' : next.enabled ? 'ready' : 'disabled'
        if (!storageFailed) error = null
        if (!next.enabled || !wire.communityApprovalAvailable(next)) {
          closePublicDiscovery(next.enabled ? 'COMMUNITY_APPROVAL_REQUIRED' : 'COMMUNITY_DISABLED')
        }
        publish()
        await Promise.all([...views.map(view => readOrders(captured, view)), ...next.enabled ? [readListings(captured)] : []])
        if (selectedOrderId !== null && sameOwner(captured)) await readMessages(captured, selectedOrderId)
        if (sameOwner(captured)) lastRefresh = clock()
      } catch (_protocol: unknown) {
        if (sameOwner(captured)) { availability = 'error'; error = issue('COMMUNITY_PROTOCOL_INVALID') }
      } finally { if (sameOwner(captured)) publish() }
    })().finally(() => { if (refreshTask === task) refreshTask = undefined })
    refreshTask = task; return task
  }
  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    if (!active || owner === null || unsupported || !config.enabled) return
    timer = setTimeout(() => {
      timer = undefined
      track(async () => {
        const captured = owner
        if (captured === null) return
        if (clock() - lastRefresh >= (config.listPollMs ?? 15_000) || server === null) await refreshAll()
        else if (selectedOrderId !== null) await readMessages(captured, selectedOrderId)
        schedule()
      })
    }, foreground() ? config.foregroundPollMs ?? 3000 : config.backgroundPollMs ?? 15_000)
  }
  const clearConsumedUploads = (captured: CommunityOwner, ids: readonly string[]): void => {
    for (const item of operations.values()) if (item.upload?.attachmentId !== null && item.upload?.attachmentId !== undefined
      && ids.includes(item.upload.attachmentId)) { remove(captured, item.operationId); files.delete(item.operationId) }
  }
  const execute = async (operation: CommunityOperation): Promise<void> => {
    const captured = owner
    if (captured === null || !sameOwner(captured) || operation.kind === 'upload' || inflight.has(operation.operationId)) return
    inflight.add(operation.operationId); operationErrors.delete(operation.operationId); publish()
    try {
      const answer = await perform(captured, { method: 'POST', path: operation.path, body: operation.body })
      if (!sameOwner(captured)) return
      if (!answer.ok) {
        if (operations.has(operation.operationId)) {
          operationErrors.set(operation.operationId, issue(answer.code, answer.unknown, operation.operationId))
        }
        return
      }
      const receipt = wire.communityReceipt(answer.payload, captured.id), body = wire.communityObject(wire.communityJson(operation.body))
      if (operation.orderId !== null && receipt.order.id !== operation.orderId) throw new wire.CommunityWireError()
      if (operation.kind === 'publication') {
        if (receipt.order.my_role !== 'publisher' || String(receipt.order.publisher.id) !== captured.id
          || receipt.order.title !== body.title || receipt.order.listing.public_summary !== body.public_summary
          || receipt.order.listing.public_budget !== body.public_budget
          || (receipt.order.listing.expected_delivery_date ?? '') !== (body.expected_delivery_date ?? '')
          || receipt.order.private_text !== body.private_text
          || receipt.order.listing.service_profile_id !== (body.service_profile_id ?? '')) throw new wire.CommunityWireError()
        const publicIds = wire.communityArray(body.public_attachment_ids, 8, wire.communityId).sort()
        if (JSON.stringify(publicIds) !== JSON.stringify(receipt.order.listing.public_attachments.map(item => item.id).sort())) {
          throw new wire.CommunityWireError()
        }
        const privateIds = wire.communityArray(body.private_attachment_ids, 8, wire.communityId).sort()
        if (receipt.message === null && (body.private_text !== '' || privateIds.length > 0)) throw new wire.CommunityWireError()
        if (receipt.message !== null && (receipt.message.client_message_id !== `create:${operation.operationId}`
          || receipt.message.text !== body.private_text || String(receipt.message.sender_id) !== captured.id
          || JSON.stringify(receipt.message.attachments.map(item => item.id).sort()) !== JSON.stringify(privateIds))) {
          throw new wire.CommunityWireError()
        }
        const draft = publications.get(operation.scopeKey)
        if (draft !== undefined) publications.set(operation.scopeKey, { ...draft, orderId: receipt.order.id, error: null })
        clearConsumedUploads(captured, [...publicIds, ...privateIds])
      } else if (operation.kind === 'accept') {
        if (receipt.order.my_role !== 'acceptor' || String(receipt.order.acceptor?.id) !== captured.id) throw new wire.CommunityWireError()
      } else if (operation.kind === 'message') {
        const ids = wire.communityArray(body.attachment_ids, 8, wire.communityId).sort()
        if (receipt.message === null || receipt.message.client_message_id !== operation.operationId
          || receipt.message.text !== body.text || String(receipt.message.sender_id) !== captured.id
          || JSON.stringify(receipt.message.attachments.map(item => item.id).sort()) !== JSON.stringify(ids)) {
          throw new wire.CommunityWireError()
        }
        clearConsumedUploads(captured, ids)
      } else clearConsumedUploads(captured, wire.communityArray(body.attachment_ids, 8, wire.communityId))
      const current = mergeOrder(receipt.order)
      if (receipt.message !== null) reconcileMessages(captured, current.id, [receipt.message])
      remove(captured, operation.operationId)
      if (operation.kind === 'accept' || operation.kind === 'publication') {
        selectedOrderId = current.id; activePublicationScope = null
        for (const view of views) {
          if (view === 'all' || view === 'published' && String(current.publisher.id) === captured.id
            || view === 'accepted' && String(current.acceptor?.id) === captured.id) {
            if (!orders[view].items.some(item => item.id === current.id)) orders[view].items = [current, ...orders[view].items]
          }
        }
      }
      publish(); await readMessages(captured, current.id)
    } catch (_receipt: unknown) {
      if (sameOwner(captured) && operations.has(operation.operationId)) {
        operationErrors.set(operation.operationId, issue('COMMUNITY_PROTOCOL_INVALID', true, operation.operationId))
      }
    } finally { if (sameOwner(captured)) { inflight.delete(operation.operationId); publish() } }
  }
  const uploadFile = async (operationId: string): Promise<void> => {
    const captured = owner, original = operations.get(operationId)
    if (captured === null || original?.upload === undefined || uploadFlights.has(operationId) || !sameOwner(captured)) return
    if (original.upload.ready) return
    const abort = new AbortController(); uploadFlights.set(operationId, abort); operationErrors.delete(operationId); publish()
    let operation = original
    const valid = (): boolean => sameOwner(captured) && !abort.signal.aborted && operations.has(operationId)
    const update = (patch: Partial<NonNullable<CommunityOperation['upload']>>): boolean => {
      if (!valid() || operation.upload === undefined) return false
      const next = { ...operation, upload: { ...operation.upload, ...patch } }
      if (!save(captured, next)) return false
      operation = next; return true
    }
    const checked = (status: wire.CommunityWireUpload): void => {
      const data = operation.upload
      if (data === undefined || status.offset > data.file.size || data.uploadId !== null && data.uploadId !== status.id
        || data.attachmentId !== null && data.attachmentId !== status.attachment_id) throw new wire.CommunityWireError()
      if (status.attachment !== null && (status.attachment.scope !== data.scope || status.attachment.name !== data.file.name
        || status.attachment.mime_type !== data.file.type || status.attachment.size_bytes !== data.file.size
        || status.attachment.sha256 !== data.sha256)) throw new wire.CommunityWireError()
    }
    try {
      const file = files.get(operationId), upload = operation.upload
      if (file === undefined || upload === undefined) {
        operationErrors.set(operationId, issue('COMMUNITY_UPLOAD_RESELECT', false, operationId)); return
      }
      if (!await matchesCommunityUpload(file, upload, abort.signal)) {
        operationErrors.set(operationId, issue('COMMUNITY_UPLOAD_FILE_MISMATCH', false, operationId)); return
      }
      if (upload.sha256 === null) {
        const digest = await communityFileDigest(file, abort.signal)
        if (!update({ sha256: digest })) return
      }
      if (!valid()) return
      const answer = await perform(captured, upload.uploadId === null ? { method: 'POST', path: '/uploads', body: operation.body }
        : { method: 'GET', path: `/uploads/${upload.uploadId}` }, abort.signal)
      if (!valid()) return
      if (!answer.ok) { operationErrors.set(operationId, issue(answer.code, answer.unknown, operationId)); return }
      let status = wire.communityUpload(answer.payload); checked(status)
      const boundaries = new Set([0, ...upload.parts.map(part => part.offset + part.size)])
      if (!boundaries.has(status.offset)) throw new wire.CommunityWireError()
      if (!update({ uploadId: status.id, attachmentId: status.attachment_id })) return
      if (status.status === 'ready') {
        if (status.attachment === null || status.offset !== file.size) throw new wire.CommunityWireError()
        if (update({ ready: true, attachment: status.attachment })) assets.set(status.attachment.id, status.attachment)
        return
      }
      let offset = status.offset
      while (offset < file.size) {
        const previous = operation.upload?.parts.find(part => part.offset === offset)
        const bytes = previous?.size ?? Math.min(status.chunk_bytes, file.size - offset)
        if (bytes > status.chunk_bytes) throw new wire.CommunityWireError()
        const digest = await communitySliceDigest(file, offset, bytes)
        if (!valid()) return
        if (previous !== undefined && previous.sha256 !== digest) throw new Error('COMMUNITY_UPLOAD_FILE_MISMATCH')
        if (previous === undefined && !update({ parts: [...operation.upload?.parts ?? [],
          { offset, size: bytes, sha256: digest }] })) return
        const start = offset
        const part = await perform(captured, { method: 'PUT', path: `/uploads/${status.id}/content`,
          blob: file.slice(offset, offset + bytes), offset, onProgress: (sent) => {
            if (valid()) { progress.set(operationId, Math.min(100, (start + sent) / file.size * 100)); publish() }
          } }, abort.signal)
        if (!valid()) return
        if (!part.ok) { operationErrors.set(operationId, issue(part.code, part.unknown, operationId)); return }
        status = wire.communityUpload(part.payload); checked(status)
        if (status.offset !== offset + bytes) throw new wire.CommunityWireError()
        offset = status.offset; progress.set(operationId, offset / file.size * 100); publish()
      }
      if (operation.upload?.completeBody == null && !update({ completeBody: JSON.stringify({ sha256: operation.upload?.sha256 }) })) return
      const completeBody = operation.upload?.completeBody
      if (completeBody == null) throw new wire.CommunityWireError()
      const complete = await perform(captured, { method: 'POST', path: `/uploads/${status.id}/complete`, body: completeBody }, abort.signal)
      if (!valid()) return
      if (!complete.ok) { operationErrors.set(operationId, issue(complete.code, complete.unknown, operationId)); return }
      const ready = wire.communityUpload(complete.payload); checked(ready)
      if (ready.status !== 'ready' || ready.attachment === null || ready.offset !== file.size) throw new wire.CommunityWireError()
      if (update({ ready: true, attachment: ready.attachment })) {
        assets.set(ready.attachment.id, ready.attachment); files.delete(operationId)
      }
    } catch (_upload: unknown) {
      if (valid()) operationErrors.set(operationId, issue('COMMUNITY_UPLOAD_FAILED', true, operationId))
    } finally { if (sameOwner(captured)) { uploadFlights.delete(operationId); publish() } }
  }
  const restore = (captured: CommunityOwner): void => {
    for (const item of journal.read(captured)) {
      operations.set(item.operationId, item)
      operationErrors.set(item.operationId, issue('COMMUNITY_RESULT_UNKNOWN', true, item.operationId))
      const body = wire.communityObject(wire.communityJson(item.body))
      if (item.kind === 'publication') publications.set(item.scopeKey, { scopeKey: item.scopeKey, createdAt: item.createdAt,
        orderId: null, publishToCommunity: true, title: wire.communityText(body.title, 200),
        publicSummary: wire.communityText(body.public_summary, 4000), publicBudget: wire.communityText(body.public_budget, 100, true),
        expectedDeliveryDate: body.expected_delivery_date === undefined ? '' : wire.communityCalendarDate(body.expected_delivery_date),
        serviceProfileId: body.service_profile_id === undefined ? '' : wire.communityText(body.service_profile_id, 128, true),
        privateText: wire.communityText(body.private_text, 12_000, true), sending: false, locked: true, error: null })
      if (item.upload !== undefined) {
        if (item.upload.attachment !== null) assets.set(item.upload.attachment.id, item.upload.attachment)
        if (item.upload.target.kind === 'publication' && !publications.has(item.scopeKey)) publications.set(item.scopeKey, {
          ...fields(), scopeKey: item.scopeKey, createdAt: item.createdAt, orderId: null, sending: false, locked: false, error: null })
      }
    }
  }
  const clear = (): void => {
    accountAbort.abort(); accountAbort = new AbortController(); listingEpoch += 1; detailEpoch += 1
    for (const flight of flights) flight.abort()
    for (const flight of uploadFlights.values()) flight.abort()
    listings.flight?.abort()
    for (const view of views) { orders[view].flight?.abort(); orders[view] = page() }
    if (timer !== undefined) clearTimeout(timer); timer = undefined
    server = null; unsupported = false; storageFailed = false; error = null; refreshTask = undefined; lastRefresh = 0
    listings = page(); listingQuery = ''; serviceId = ''; selectedListing = null
    selectedListingStatus = 'ready'; selectedListingError = null
    selectedOrderId = null; selectedOrderStatus = 'ready'; selectedOrderError = null; activePublicationScope = null
    orderRecords.clear(); conversations.clear(); histories.clear(); publications.clear(); operations.clear(); operationErrors.clear()
    inflight.clear(); confirmed.clear(); assets.clear(); files.clear(); progress.clear(); uploadFlights.clear(); messageFlights.clear()
    readFlights.clear(); claiming.clear()
  }
  const observe = (): void => {
    const snapshot = accountSource.getSnapshot(), session = snapshot.session
    const next = session?.signedIn === true && session.account !== undefined && /^[1-9][0-9]*$/u.test(session.account.id)
      && Number.isSafeInteger(Number(session.account.id)) && typeof session.accountOwner === 'string'
      && /^[a-f0-9]{64}$/u.test(session.accountOwner)
      ? { id: session.account.id, owner: session.accountOwner, epoch: snapshot.accountEpoch } : null
    if (owner?.id === next?.id && owner?.owner === next?.owner && owner?.epoch === next?.epoch) {
      if (next === null) { availability = !config.enabled ? 'unavailable' : snapshot.loaded ? 'login-required' : 'loading'; publish() }
      return
    }
    clear(); owner = next
    availability = !config.enabled ? 'unavailable' : next === null ? snapshot.loaded ? 'login-required' : 'loading' : 'loading'
    if (next !== null && config.enabled) {
      try { restore(next) } catch (_storage: unknown) { storageFailed = true; error = issue('COMMUNITY_PENDING_STORAGE_FAILED') }
      track(async () => { await refreshAll(); schedule() })
    }
    publish()
  }
  const dispose = (): Promise<void> => {
    if (closed !== undefined) return closed
    active = false; unsubscribe?.(); unsubscribe = undefined; owner = null; clear()
    source.set(blank(config.enabled ? 'login-required' : 'unavailable'))
    closed = Promise.allSettled([...tasks]).then(() => undefined)
    return closed
  }
  const mutationReady = (): boolean => owner !== null && sameOwner(owner) && !storageFailed
    && server !== null && server.capabilities.community_orders_v1 && !unsupported
  const staged = (target: CommunityUploadTarget, scope?: 'listing' | 'conversation'): CommunityUploadView[] => uploadViews()
    .filter(item => !item.reserved && sameTarget(item.target, target) && (scope === undefined || item.scope === scope))
  const readyIds = (target: CommunityUploadTarget, scope: 'listing' | 'conversation'): readonly string[] => {
    const values = staged(target, scope)
    if (values.some(item => item.status !== 'ready' || item.attachment === null)) throw new Error('COMMUNITY_ATTACHMENT_NOT_READY')
    return values.flatMap(item => item.attachment === null ? [] : [item.attachment.id])
  }
  const setOperation = (captured: CommunityOwner, data: Omit<CommunityOperation, 'version' | 'createdAt'>): CommunityOperation | null => {
    const operation: CommunityOperation = { ...data, version: 1, createdAt: clock() }
    return save(captured, operation) ? operation : null
  }
  const acceptListing = (id: string): void => {
    if (!mutationReady() || owner === null) return
    const captured = owner
    const existing = pending(`accept:${id}`, 'accept')[0]
    if (existing !== undefined) { track(() => execute(existing)); return }
    const accepted = orderRecords.get(id)
    if (accepted?.my_role === 'acceptor' && String(accepted.acceptor?.id) === captured.id) { track(() => readOrder(captured, id)); return }
    if (!wire.communityApprovalAvailable(server)) { selectedListingError = issue('COMMUNITY_APPROVAL_REQUIRED'); publish(); return }
    if (server?.enabled !== true || claiming.has(id)) return
    claiming.add(id); publish()
    track(async () => {
      try {
        wire.communityId(id)
        const answer = await perform(captured, { method: 'GET', path: `/listings/${id}` })
        if (!sameOwner(captured)) return
        if (!answer.ok) { selectedListingError = issue(answer.code); return }
        const fresh = wire.communityListing(decodeListingReply(answer.payload))
        if (fresh.id !== id) throw new wire.CommunityWireError()
        if (fresh.approval_status !== 'approved') { selectedListingError = issue('COMMUNITY_APPROVAL_REQUIRED'); return }
        if (String(fresh.publisher.id) === captured.id) { selectedListingError = issue('COMMUNITY_SELF_ACCEPT_FORBIDDEN'); return }
        if (!fresh.can_accept || fresh.status !== 'open') { selectedListingError = issue('COMMUNITY_ORDER_NOT_OPEN'); return }
        const operationId = newId(), operation = setOperation(captured, { operationId, scopeKey: `accept:${id}`,
          orderId: id, kind: 'accept', path: `/orders/${id}/accept`, body: JSON.stringify({ client_action_id: operationId }) })
        if (operation !== null) await execute(operation)
      } catch (_protocol: unknown) { if (sameOwner(captured)) selectedListingError = issue('COMMUNITY_PROTOCOL_INVALID') }
      finally { if (sameOwner(captured)) { claiming.delete(id); publish() } }
    })
  }
  return {
    hooks: { community: source },
    start: () => {
      if (closed !== undefined) throw new Error('COMMUNITY_CONTROLLER_DISPOSED')
      if (!active) { active = true; unsubscribe = accountSource.subscribe(observe); observe() }
      return () => { void dispose() }
    }, dispose,
    setVisible: (next) => {
      visible = next
      if (active && next) track(async () => { await refreshAll(); schedule() })
      else schedule()
    },
    refresh: () => { unsupported = false; if (active) track(async () => { await refreshAll(); schedule() }) },
    setListingFilter: (query, profile = '') => {
      try { wire.communityText(query, 100, true); if (profile !== '') wire.communityId(profile) }
      catch (_input: unknown) { error = issue('COMMUNITY_INVALID_INPUT'); publish(); return }
      if (!active || owner === null || query === listingQuery && profile === serviceId) return
      listingQuery = query; serviceId = profile; listingEpoch += 1; listings.flight?.abort(); listings = page(); publish()
      const captured = owner; track(() => readListings(captured))
    },
    loadMoreListings: () => { const captured = owner; if (captured !== null) track(() => readListings(captured, true)) },
    loadOrders: (view, more = false) => { const captured = owner; if (captured !== null) track(() => readOrders(captured, view, more)) },
    openListing: (id) => {
      const captured = owner
      try { wire.communityId(id) } catch (_input: unknown) { return }
      if (captured !== null && !unsupported && server?.enabled === true && wire.communityApprovalAvailable(server)) {
        track(async () => { await readListing(captured, id) })
      }
    }, acceptListing,
    openOrder: (id) => {
      const captured = owner
      try { wire.communityId(id) } catch (_input: unknown) { return }
      if (captured === null || !sameOwner(captured)) return
      if (server !== null && !unsupported || orderRecords.has(id)) track(() => readOrder(captured, id))
      else {
        selectedOrderId = id; selectedOrderStatus = 'error'; selectedOrderError = issue('COMMUNITY_UNAVAILABLE')
        activePublicationScope = null; publish()
      }
    },
    startPublication: () => {
      if (!mutationReady() || server?.enabled !== true || !wire.communityApprovalAvailable(server)) {
        error = issue('COMMUNITY_APPROVAL_REQUIRED'); publish(); return
      }
      const scopeKey = `publication:${newId()}`
      publications.set(scopeKey, { ...fields(), scopeKey, createdAt: clock(), orderId: null, sending: false, locked: false, error: null })
      activePublicationScope = scopeKey; selectedOrderId = null; publish()
    },
    openPublication: (scopeKey) => {
      if (publications.has(scopeKey)) { activePublicationScope = scopeKey; selectedOrderId = null; publish() }
    },
    updatePublication: (scopeKey, patch) => {
      const draft = publications.get(scopeKey)
      if (draft === undefined || draft.orderId !== null || pending(scopeKey, 'publication').length > 0) return
      publications.set(scopeKey, { ...draft, ...patch, error: null }); publish()
    },
    publish: (scopeKey) => {
      if (!mutationReady() || owner === null) return
      const captured = owner, original = pending(scopeKey, 'publication')[0]
      if (original !== undefined) { track(() => execute(original)); return }
      const draft = publications.get(scopeKey)
      if (draft === undefined || draft.orderId !== null) return
      try {
        if (server?.enabled !== true) throw new Error('COMMUNITY_DISABLED')
        if (!wire.communityApprovalAvailable(server)) throw new Error('COMMUNITY_APPROVAL_REQUIRED')
        if (!draft.publishToCommunity) throw new Error('COMMUNITY_EXPLICIT_PUBLICATION_REQUIRED')
        const title = wire.communityText(draft.title, 200).trim(), summary = wire.communityText(draft.publicSummary, 4000).trim()
        const budget = wire.communityText(draft.publicBudget, 100, true), privateText = wire.communityText(draft.privateText, 12_000, true)
        const expectedDate = wire.communityCalendarDate(draft.expectedDeliveryDate ?? '')
        const profile = draft.serviceProfileId === '' ? '' : wire.communityId(draft.serviceProfileId)
        const operationId = newId(), target: CommunityUploadTarget = { kind: 'publication', scopeKey }
        const operation = setOperation(captured, { operationId, scopeKey, orderId: null, kind: 'publication', path: '/orders',
          body: JSON.stringify({ client_request_id: operationId, publish_to_community: true, title, public_summary: summary,
            public_budget: budget, ...expectedDate === '' ? {} : { expected_delivery_date: expectedDate },
            ...profile === '' ? {} : { service_profile_id: profile },
            public_attachment_ids: readyIds(target, 'listing'), private_text: privateText,
            private_attachment_ids: readyIds(target, 'conversation') }) })
        if (operation !== null) track(() => execute(operation))
      } catch (failure: unknown) {
        const code = failure instanceof wire.CommunityWireError ? 'COMMUNITY_INVALID_INPUT'
          : failure instanceof Error && failure.message.startsWith('COMMUNITY_') ? failure.message : 'COMMUNITY_INVALID_INPUT'
        publications.set(scopeKey, { ...draft, error: issue(code) }); publish()
      }
    },
    updateMessageDraft: (id, text) => {
      try { wire.communityText(text, 12_000, true) } catch (_input: unknown) { return }
      if (orderRecords.has(id)) { draftConversation(id).text = text; publish() }
    },
    sendMessage: (id) => {
      if (!mutationReady() || owner === null) return
      const record = orderRecords.get(id), state = draftConversation(id), captured = owner
      if (record?.can_send !== true) { state.error = issue('COMMUNITY_READ_ONLY'); publish(); return }
      try {
        const text = wire.communityText(state.text, 12_000, true), ids = readyIds({ kind: 'order', orderId: id }, 'conversation')
        if (text.trim() === '' && ids.length === 0) return
        const operationId = newId(), operation = setOperation(captured, { operationId, scopeKey: `order:${id}`, orderId: id,
          kind: 'message', path: `/orders/${id}/messages`,
          body: JSON.stringify({ client_message_id: operationId, text, attachment_ids: ids }) })
        if (operation !== null) { state.text = ''; publish(); track(() => execute(operation)) }
      } catch (_input: unknown) { state.error = issue('COMMUNITY_ATTACHMENT_NOT_READY'); publish() }
    },
    loadMoreMessages: (id) => {
      const captured = owner
      if (captured !== null && orderRecords.has(id)) track(() => readMessages(captured, id, true))
    },
    markRead: (id, seq) => {
      const captured = owner, record = orderRecords.get(id)
      if (captured === null || !foreground() || selectedOrderId !== id || record === undefined || readFlights.has(id)) return
      const loaded = Math.max(0, ...(histories.get(id)?.keys() ?? []))
      if (!Number.isSafeInteger(seq) || seq <= record.last_read_seq || seq > record.last_seq || seq > loaded) return
      readFlights.add(id)
      track(async () => {
        try {
          const answer = await perform(captured, { method: 'POST', path: `/orders/${id}/read`,
            body: JSON.stringify({ last_read_seq: seq }) })
          if (!sameOwner(captured) || !answer.ok) return
          const payload = wire.communityObject(answer.payload), current = orderRecords.get(id)
          const read = wire.communityInteger(payload.last_read_seq, record.last_seq), unread = wire.communityInteger(payload.unread_count)
          if (read < seq || current === undefined) throw new wire.CommunityWireError()
          mergeOrder({ ...current, last_read_seq: Math.max(current.last_read_seq, read), unread_count: unread })
        } finally { if (sameOwner(captured)) { readFlights.delete(id); publish() } }
      })
    },
    performAction: (id, action, text = '', attachmentIds) => {
      if (!mutationReady() || owner === null) return
      const captured = owner, record = orderRecords.get(id)
      if (record === undefined) return
      const original = pending(`order:${id}`, 'action')[0]
      if (original !== undefined) { draftConversation(id).error = issue('COMMUNITY_OPERATION_PENDING'); publish(); return }
      const allowed = action === 'cancel' ? record.can_cancel : action === 'reopen' ? record.can_reopen && server?.enabled === true
        : action === 'deliver' ? record.can_deliver : record.can_accept_delivery
      if (!allowed) { draftConversation(id).error = issue('COMMUNITY_READ_ONLY'); publish(); return }
      try {
        const message = wire.communityText(text, 12_000, action !== 'request_changes')
        const ids = attachmentIds === undefined ? readyIds({ kind: 'order', orderId: id }, 'conversation')
          : wire.communityArray(attachmentIds, 8, wire.communityId)
        if (ids.some(value => !assets.has(value) || assets.get(value)?.scope !== 'conversation')) throw new wire.CommunityWireError()
        if (action === 'deliver' && message.trim() === '' && ids.length === 0) throw new wire.CommunityWireError()
        const operationId = newId(), operation = setOperation(captured, { operationId, scopeKey: `order:${id}`, orderId: id,
          kind: 'action', path: `/orders/${id}/actions`, body: JSON.stringify({ client_action_id: operationId,
            revision: record.revision, action, text: message, attachment_ids: ids }) })
        if (operation !== null) track(() => execute(operation))
      } catch (_input: unknown) { draftConversation(id).error = issue('COMMUNITY_INVALID_INPUT'); publish() }
    },
    retryOperation: (id) => {
      const operation = operations.get(id)
      if (operation === undefined || confirmed.has(id)) return
      if (operation.kind === 'upload') track(() => uploadFile(id))
      else track(() => execute(operation))
    },
    addAttachments: (target, scope, values) => {
      if (!mutationReady() || owner === null || server === null || !server.capabilities.resumable_upload) return
      const captured = owner, scopeKey = targetKey(target), destination = target.kind === 'order' ? target.orderId : null
      if (target.kind === 'publication' && (!publications.has(target.scopeKey) || !server.enabled || !wire.communityApprovalAvailable(server)
        || pending(scopeKey, 'publication').length > 0) || target.kind === 'order' && (scope !== 'conversation'
          || orderRecords.get(target.orderId)?.can_send !== true)) return
      for (const file of values) {
        if (staged(target, scope).length >= server.upload_rules.max_attachments) { error = issue('COMMUNITY_UPLOAD_TOO_MANY'); break }
        const max = file.type.startsWith('image/') ? server.upload_rules.max_image_bytes : server.upload_rules.max_video_bytes
        if (!server.upload_rules.allowed_mime_types.includes(file.type) || file.size < 1 || file.size > max) {
          error = issue(file.size > max ? 'COMMUNITY_UPLOAD_TOO_LARGE' : 'COMMUNITY_UPLOAD_UNSUPPORTED'); continue
        }
        const operationId = newId(), operation = setOperation(captured, {
          operationId, scopeKey, orderId: destination, kind: 'upload', path: '/uploads',
          body: JSON.stringify({ client_upload_id: operationId, scope, ...destination === null ? {} : { order_id: destination },
            name: file.name, mime_type: file.type, size_bytes: file.size }),
          upload: { target, scope, file: { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified },
            parts: [], uploadId: null, attachmentId: null, sha256: null, attachment: null, completeBody: null, ready: false } })
        if (operation !== null) { files.set(operationId, file); track(() => uploadFile(operationId)) }
      }
      publish()
    },
    retryUpload: (id, file) => {
      const operation = operations.get(id)
      if (operation?.upload === undefined || uploadFlights.has(id)) return
      if (file !== undefined) files.set(id, file)
      track(() => uploadFile(id))
    },
    removeUpload: (id) => {
      const captured = owner, operation = operations.get(id)
      if (captured === null || operation?.upload === undefined || uploadFlights.has(id)) return
      const assetId = operation.upload.attachmentId
      const referenced = assetId !== null && reservedAssets().has(assetId)
      if (referenced || !operation.upload.ready && operation.upload.sha256 !== null && operationErrors.get(id)?.unknown !== false) return
      remove(captured, id); files.delete(id); progress.delete(id); publish()
    },
    contentUrl: (id, disposition = 'inline') => owner === null || !assets.has(id) ? null : communityContentUrl(owner, id, disposition),
    downloadAttachment: (id) => {
      if (owner === null || !assets.has(id)) return
      const url = communityContentUrl(owner, id, 'attachment')
      if (deps.download !== undefined) deps.download(url)
      else if (typeof document !== 'undefined') {
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = ''; anchor.click()
      }
    },
  }
}
