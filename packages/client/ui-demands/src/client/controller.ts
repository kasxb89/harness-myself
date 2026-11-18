/** Account-owned demand state and commands, independent of React and AI conversations. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-credits/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { en } from './locales.ts'
import type {
  DemandAttachment, DemandConversation, DemandDraft, DemandEngineer, DemandMessage, DemandPageFace, DemandPageProps, DemandPageState,
  DemandRouting, DemandServiceProfile,
} from './types.ts'
import { demandContentUrl, requestDemand, type DemandOwner, type DemandRequest, type DemandResult } from './api.ts'
import { createDemandJournal, matchesUpload, sliceDigest, type DemandJournal, type PendingOperation } from './pending.ts'
import * as wire from './wire.ts'

/**
 * Local transport capability and polling deadlines; backend config owns dynamic service availability.
 */
export interface DemandControllerConfig {
  readonly enabled: boolean
  readonly requestTimeoutMs?: number
  /** Binary slices have a separate allowance for slower client networks. */
  readonly uploadTimeoutMs?: number
  readonly foregroundPollMs?: number
  readonly backgroundPollMs?: number
  readonly listPollMs?: number
}
/**
 * Localized callbacks and replaceable transport, persistence and clock adapters.
 */
export interface DemandControllerDependencies {
  readonly translate?: DemandPageProps['t']
  readonly openLogin?: () => void
  readonly journal?: DemandJournal
  readonly request?: typeof requestDemand
  readonly uuid?: () => string
  readonly now?: () => number
  readonly download?: (url: string) => void
  readonly isForeground?: () => boolean
}
/**
 * Stable presentation source and commands with explicit subscription, visibility and joined shutdown.
 */
export interface DemandController extends DemandPageFace {
  readonly start: () => () => void
  readonly dispose: () => Promise<void>
  readonly setVisible: (visible: boolean) => void
}
interface Scope {
  readonly key: string
  readonly createdAt: number
  engineerId: string
  serviceProfileId?: string
  serviceProfileName?: string
  requestId: string | null
  draft: DemandDraft
  error: string | null
  messagesStatus: 'loading' | 'ready' | 'error'
  loadingEarlier: boolean
  earliest: number
}
const emptyState = (availability: DemandPageState['availability']): DemandPageState => ({
  availability, error: null, categories: [], engineers: [], directoryMode: 'engineers', serviceProfiles: [], servicesStatus: 'ready',
  servicesHaveMore: false, loadingMoreServices: false, servicesTotal: 0, serviceQuery: '', serviceCategoryId: '', requests: [], drafts: [], requestsStatus: 'ready', requestsHaveMore: false,
  loadingMoreRequests: false, conversation: null, draft: null,
  uploadRules: { maxFiles: 0, maxFileBytes: 0, maxImageBytes: 0, maxVideoBytes: 0, accept: '' },
})
const emptyDraft = (scopeKey: string): DemandDraft => ({ scopeKey, text: '', title: '', budget: '', expectedDate: '', attachments: [], sending: false, error: null })
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString()
const terminal = (status: string): boolean => ['completed', 'cancelled', 'closed'].includes(status)

/**
 * Create account-isolated demand state; start subscribes, and dispose aborts and joins owned I/O.
 * @param accountSource - Existing product account source, used type-only from the Credits feature.
 * @param config - Local transport capability and validated request/poll timing.
 * @param deps - Optional locale, login, transport, durable journal and test adapters.
 * @returns Stable demand presentation data, pure event callbacks and lifecycle controls.
 */
export function createDemandController(accountSource: Context['creditsSession'], config: DemandControllerConfig,
  deps: DemandControllerDependencies = {}): DemandController {
  const source = createSnapshotStore<DemandPageState>(emptyState(config.enabled ? 'loading' : 'unconfigured'))
  const request = deps.request ?? requestDemand, journal = deps.journal ?? createDemandJournal()
  const newId = deps.uuid ?? randomUUID, now = deps.now ?? Date.now
  const createdAt = (): number => {
    const value = now()
    return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : Date.now()
  }
  const fallback: ReadonlyMap<string, string> = new Map(Object.entries(en))
  const t: DemandPageProps['t'] = deps.translate ?? ((key, params) => (fallback.get(key) ?? key).replace(/\{(\w+)\}/gu,
    (placeholder: string, name: string) => params !== undefined && name in params ? String(params[name]) : placeholder))
  const failureText = (code: string, unknown = false): string => t(unknown ? 'resultUnknown' : code === 'DEMAND_UPLOAD_TOO_LARGE' ? 'uploadTooLarge'
    : code === 'DEMAND_UPLOAD_UNSUPPORTED' ? 'uploadUnsupported' : code === 'DEMAND_ENGINEER_UNAVAILABLE' ? 'notAccepting'
      : code === 'DEMAND_INVALID_INPUT' || code === 'DEMAND_EMPTY_MESSAGE' ? 'invalidRequestFields'
        : code === 'DEMAND_STATUS_CONFLICT' ? 'requestReadOnly' : 'errorHint')
  let active = false, visible = false, owner: DemandOwner | null = null
  let accountAbort = new AbortController(), unsubscribe: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let availability: DemandPageState['availability'] = config.enabled ? 'loading' : 'unconfigured', pageError: string | null = null
  let serverConfig: wire.WireConfig | null = null, directory: readonly wire.WireEngineer[] = [], unsupported = false, storageFailed = false
  let selected: string | null = null, listCursor: string | null = null, haveMore = false, loadingMore = false, listLoaded = false
  let requestsStatus: DemandPageState['requestsStatus'] = 'ready', lastListRead = 0, backoff = 0
  let services: readonly wire.WireServiceProfile[] = [], serviceCursor: string | null = null, serviceTotal = 0
  let servicesHaveMore = false, loadingMoreServices = false, servicesLoaded = false, serviceQuery = '', serviceCategoryId = ''
  let servicesStatus: DemandPageState['servicesStatus'] = 'ready', serviceEpoch = 0, serviceFlight: AbortController | undefined
  let refreshTask: Promise<void> | undefined, closeTask: Promise<void> | undefined
  const tasks = new Set<Promise<void>>(), flights = new Set<AbortController>(), inflight = new Set<string>()
  const scopes = new Map<string, Scope>(), records = new Map<string, wire.WireDemand>(), order: string[] = []
  const history = new Map<string, Map<number, wire.WireMessage>>(), pending = new Map<string, PendingOperation>()
  const files = new Map<string, File>(), uploadProgress = new Map<string, number>(), uploadErrors = new Map<string, string>()
  const uploadsRunning = new Map<string, AbortController>(), lastRead = new Map<string, number>(), readsRunning = new Set<string>()
  const messageReads = new Map<string, Promise<void>>(), confirmed = new Set<string>()
  const foreground = (): boolean => visible && (deps.isForeground?.() ?? (typeof document === 'undefined'
    || document.visibilityState !== 'hidden' && document.hasFocus()))
  const sameOwner = (captured: DemandOwner): boolean => {
    const snapshot = accountSource.getSnapshot(), session = snapshot.session
    return active && owner === captured && snapshot.accountEpoch === captured.epoch && session?.signedIn === true
      && session.account?.id === captured.id && session.accountOwner === captured.owner
  }
  const currentScope = (): Scope | undefined => selected === null ? undefined : scopes.get(selected)
  const profile = (row: wire.WireEngineer): DemandEngineer => ({ id: row.id, displayName: row.display_name,
    avatarUrl: owner === null || row.avatar_attachment_id === '' ? null : demandContentUrl(owner, row.avatar_attachment_id),
    introduction: row.introduction, categoryIds: row.category_ids, skills: [],
    presence: row.presence === 'online' ? 'available' : row.presence, canStart: row.can_start && serverConfig?.enabled === true,
    unavailableReason: row.can_start ? null : t('notAccepting') })
  const serviceProfile = (row: wire.WireServiceProfile): DemandServiceProfile => ({ id: row.id, code: row.code,
    displayName: row.display_name, serviceDirection: row.service_direction, introduction: row.introduction,
    categoryIds: row.category_ids, canStart: row.can_start && serverConfig?.enabled === true,
    avatarUrl: owner === null || row.avatar_attachment_id === '' ? null : demandContentUrl(owner, row.avatar_attachment_id) })
  const routing = (row?: wire.WireDemand, scope?: Scope): DemandRouting => ({
    intakeMode: row?.intake_mode ?? (scope?.serviceProfileId === undefined ? 'direct' : 'platform'),
    assigned: row?.assigned ?? scope?.serviceProfileId === undefined,
    serviceProfileId: row?.service_profile_id || scope?.serviceProfileId || null,
    serviceProfileName: row?.service_profile_name || scope?.serviceProfileName || null,
  })
  const retainTarget = (scope: Scope, row: wire.WireDemand): void => {
    scope.engineerId = row.intake_mode === 'platform' ? '' : row.engineer_id
    if (row.service_profile_id === '') delete scope.serviceProfileId
    else scope.serviceProfileId = row.service_profile_id
    if (row.service_profile_name === '') delete scope.serviceProfileName
    else scope.serviceProfileName = row.service_profile_name
  }
  const operationRouting = (scope: Scope): Pick<PendingOperation, 'version' | 'serviceProfileId' | 'serviceProfileName'> =>
    scope.serviceProfileId === undefined ? { version: 1 } : { version: 2, serviceProfileId: scope.serviceProfileId,
      ...scope.serviceProfileName === undefined ? {} : { serviceProfileName: scope.serviceProfileName } }
  const media = (item: wire.WireAttachment): DemandAttachment => ({ id: item.id, name: item.name, kind: item.kind,
    sizeBytes: item.size_bytes, status: item.status,
    ...owner === null || item.status !== 'ready' ? {} : { previewUrl: demandContentUrl(owner, item.id) } })
  const stagedUpload = (operation: PendingOperation): DemandAttachment => {
    const upload = operation.upload
    if (upload === undefined) throw new Error('DEMAND_PENDING_INVALID')
    const running = uploadsRunning.has(operation.operationId)
    return { id: operation.operationId, name: upload.file.name, kind: upload.file.type.startsWith('video/') ? 'video' : 'image',
      sizeBytes: upload.file.size, status: upload.ready ? 'ready' : running ? 'uploading' : 'failed',
      progressPercent: uploadProgress.get(operation.operationId) ?? (upload.ready ? 100 : 0),
      ...upload.ready ? {} : { error: uploadErrors.get(operation.operationId) ?? t('uploadReselect') } }
  }
  const pendingFor = (scopeKey: string, kind?: PendingOperation['kind']): PendingOperation[] => [...pending.values()]
    .filter(item => item.scopeKey === scopeKey && (kind === undefined || item.kind === kind) && !confirmed.has(item.operationId))
  const draftUploads = (scopeKey: string): PendingOperation[] => {
    const locked = new Set(pendingFor(scopeKey).filter(item => item.kind === 'create' || item.kind === 'message')
      .flatMap(item => wire.array(wire.object(JSON.parse(item.body) as unknown).attachment_ids, 64, wire.id)))
    return pendingFor(scopeKey, 'upload').filter(item => !locked.has(item.upload?.uploadId ?? ''))
  }
  const localMessage = (operation: PendingOperation): DemandMessage => {
    const body = wire.object(JSON.parse(operation.body) as unknown), attachmentIds = wire.array(body.attachment_ids, 64, wire.id)
    const attachments = pendingFor(operation.scopeKey, 'upload').filter(item => item.upload?.uploadId !== null && attachmentIds.includes(item.upload?.uploadId ?? ''))
      .map(stagedUpload)
    return { id: operation.operationId, author: 'user', text: wire.text(body.text, 10_000, true), createdAt: new Date(operation.createdAt).toISOString(),
      state: inflight.has(operation.operationId) ? 'sending' : 'failed', read: false, retryable: !inflight.has(operation.operationId), attachments,
      ...inflight.has(operation.operationId) ? {} : { error: t('resultUnknown') } }
  }
  const publish = (): void => {
    const scope = currentScope()
    const row = scope?.requestId === null || scope?.requestId === undefined ? undefined : records.get(scope.requestId)
    const wireMessages = row === undefined ? [] : [...(history.get(row.id)?.values() ?? [])].sort((a, b) => a.seq - b.seq)
    const persisted: DemandMessage[] = wireMessages.map(item => ({ id: item.id, author: item.author, authorName: item.author_name,
      text: item.text, createdAt: iso(item.created_at), state: 'sent', read: item.read, retryable: false, attachments: item.attachments.map(media) }))
    const scopePending = scope === undefined ? [] : pendingFor(scope.key).filter(item => item.kind === 'create' || item.kind === 'message')
      .filter(item => !wireMessages.some(message => message.client_message_id === item.operationId))
    const deliveryMessage = row === undefined ? undefined : wireMessages.find(item => item.id === row.delivery_id && item.kind === 'delivery')
    const firstUnknown = scopePending.some(item => item.kind === 'create' && !inflight.has(item.operationId))
    const route = routing(row, scope)
    const engineer = route.assigned === false ? undefined : row?.engineer ?? directory.find(item => item.id === scope?.engineerId)
    const conversation: DemandConversation | null = scope === undefined ? null : {
      ...route, scopeKey: scope.key, requestId: scope.requestId, number: row?.number ?? null, title: row?.title ?? scope.draft.title,
      engineer: engineer === undefined ? null : profile(engineer), status: row?.status ?? null,
      messages: [...persisted, ...scopePending.sort((a, b) => a.createdAt - b.createdAt).map(localMessage)],
      messagesStatus: scope.messagesStatus, error: scope.error, hasEarlier: scope.earliest > 1, loadingEarlier: scope.loadingEarlier,
      canSend: !firstUnknown && (row === undefined ? scope.requestId === null : !terminal(row.status)),
      readOnlyReason: firstUnknown ? t('resultUnknown') : row !== undefined && terminal(row.status) ? t('requestReadOnly') : null,
      delivery: deliveryMessage === undefined ? null : { id: deliveryMessage.id, title: '', description: deliveryMessage.text,
        submittedAt: iso(deliveryMessage.created_at), status: row?.status === 'completed' ? 'accepted' : 'pending', attachments: deliveryMessage.attachments.map(media) },
      acceptingDelivery: pendingFor(scope.key, 'action').some(item => inflight.has(item.operationId)),
    }
    const draft = scope === undefined ? null : { ...scope.draft, attachments: draftUploads(scope.key).map(stagedUpload),
      sending: pendingFor(scope.key).some(item => (item.kind === 'create' || item.kind === 'message') && inflight.has(item.operationId)) }
    const rules = serverConfig?.upload_rules
    source.set({ availability, error: pageError,
      categories: serverConfig?.categories.filter(item => item.enabled).map(item => ({ id: item.id, label: item.name })) ?? [],
      drafts: [...scopes.values()].filter(item => item.requestId === null).map((item) => {
        const operations = pendingFor(item.key), firstSend = operations.find(operation => operation.kind === 'create')
        const updatedAt = Math.max(item.createdAt, ...operations.map(operation => operation.createdAt))
        const engineer = item.serviceProfileId === undefined ? directory.find(engineer => engineer.id === item.engineerId) : undefined
        const preview = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(item.draft.text.trim()),
          part => part.segment).slice(0, 80).join('')
        return { ...routing(undefined, item), scopeKey: item.key, title: item.draft.title.trim() || preview || t('newRequest'),
          engineer: engineer === undefined ? null : profile(engineer),
          updatedAt: new Date(updatedAt).toISOString(), pending: firstSend !== undefined,
          error: item.error ?? item.draft.error ?? (firstSend !== undefined && !inflight.has(firstSend.operationId) ? t('resultUnknown') : null) }
      }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      directoryMode: serverConfig?.service_profiles === true ? 'services' : 'engineers',
      serviceProfiles: services.map(serviceProfile), servicesStatus, servicesHaveMore, loadingMoreServices,
      servicesTotal: serviceTotal, serviceQuery, serviceCategoryId,
      engineers: directory.map(profile), requests: order.flatMap((key) => {
        const item = records.get(key)
        return item === undefined ? [] : [{ ...routing(item), id: item.id, number: item.number, title: item.title,
          engineer: item.assigned ? profile(item.engineer) : null, status: item.status,
          updatedAt: iso(item.updated_at), preview: item.preview, unreadCount: item.unread_count }]
      }), requestsStatus, requestsHaveMore: haveMore, loadingMoreRequests: loadingMore, conversation, draft,
      uploadRules: rules === undefined ? emptyState(availability).uploadRules : { maxFiles: rules.max_attachments,
        maxFileBytes: Math.max(rules.max_image_bytes, rules.max_video_bytes),
        maxImageBytes: rules.max_image_bytes, maxVideoBytes: rules.max_video_bytes,
        accept: rules.allowed_mime_types.join(',') } })
  }
  const track = (work: () => Promise<void>): Promise<void> => {
    const task = work().catch((_error: unknown) => {
      if (active) { pageError = t('errorHint'); publish() }
    }).finally(() => { tasks.delete(task) })
    tasks.add(task)
    return task
  }
  const perform = async (captured: DemandOwner, input: Omit<DemandRequest, 'signal'>, extra?: AbortSignal): Promise<DemandResult> => {
    if (!sameOwner(captured)) return { ok: false, code: 'ACCOUNT_CHANGED', httpStatus: 0, unknown: true }
    const abort = new AbortController(); flights.add(abort)
    const timeoutMs = input.blob === undefined ? config.requestTimeoutMs ?? 20_000 : config.uploadTimeoutMs ?? 120_000
    const signal = AbortSignal.any([accountAbort.signal, abort.signal, AbortSignal.timeout(timeoutMs),
      ...extra === undefined ? [] : [extra]])
    try {
      const answer = await request(captured, { ...input, signal })
      return sameOwner(captured) && !signal.aborted ? answer : { ok: false, code: 'DEMAND_CANCELLED', httpStatus: 0, unknown: true }
    } catch (_error: unknown) { return { ok: false, code: 'DEMAND_NETWORK', httpStatus: 0, unknown: true } }
    finally { flights.delete(abort) }
  }
  const loadServices = async (captured: DemandOwner, more = false, periodic = false): Promise<void> => {
    if (serverConfig?.service_profiles !== true || more && (!servicesHaveMore || loadingMoreServices || serviceCursor === null)
      || periodic && serviceFlight !== undefined) return
    serviceFlight?.abort()
    const abort = new AbortController(), epoch = ++serviceEpoch, cursor = more ? serviceCursor : null
    const query = serviceQuery, category = serviceCategoryId
    serviceFlight = abort
    if (more) loadingMoreServices = true
    else if (!servicesLoaded) servicesStatus = 'loading'
    publish()
    try {
      const params = new URLSearchParams({ limit: '30' })
      if (cursor !== null) params.set('after_id', cursor)
      if (query !== '') params.set('q', query)
      if (category !== '') params.set('category_id', category)
      const answer = await perform(captured, { method: 'GET', path: `/service-profiles?${params}` }, abort.signal)
      if (!sameOwner(captured) || epoch !== serviceEpoch || abort.signal.aborted) return
      if (!answer.ok) throw new Error(answer.code)
      const page = wire.serviceDirectory(answer.payload)
      if (more && page.has_more && page.next_after_id === cursor) throw new wire.DemandWireError()
      const preserve = periodic && servicesLoaded && (servicesHaveMore || page.total <= services.length)
      const rows = more ? [...services, ...page.items] : preserve ? [...page.items,
        ...services.filter(item => !page.items.some(fresh => fresh.id === item.id))] : [...page.items]
      services = [...new Map(rows.map(item => [item.id, item])).values()].slice(0, page.total)
      if (more || !preserve) { serviceCursor = page.next_after_id; servicesHaveMore = page.has_more }
      serviceTotal = page.total; servicesStatus = 'ready'; servicesLoaded = true
    } catch (_directory: unknown) {
      if (sameOwner(captured) && epoch === serviceEpoch && !abort.signal.aborted) servicesStatus = 'error'
    } finally {
      if (sameOwner(captured) && epoch === serviceEpoch) { serviceFlight = undefined; loadingMoreServices = false; publish() }
    }
  }
  const save = (captured: DemandOwner, operation: PendingOperation): boolean => {
    if (!sameOwner(captured) || storageFailed) return false
    try { journal.put(captured, operation); pending.set(operation.operationId, operation); return true }
    catch (_storage: unknown) { storageFailed = true; const scope = scopes.get(operation.scopeKey)
      if (scope !== undefined) scope.draft = { ...scope.draft, error: t('pendingStorageFailed') }
      pageError = t('pendingStorageFailed'); publish(); return false }
  }
  const remove = (captured: DemandOwner, operationId: string): void => {
    try { journal.remove(captured, operationId); pending.delete(operationId) }
    catch (_storage: unknown) { confirmed.add(operationId); storageFailed = true; pageError = t('pendingStorageFailed') }
  }
  const mergeRecord = (row: wire.WireDemand, prepend = false): void => {
    const previous = records.get(row.id)
    if (previous === undefined || row.revision >= previous.revision) records.set(row.id, row)
    if (!order.includes(row.id)) { if (prepend) order.unshift(row.id); else order.push(row.id) }
  }
  const mergeMessages = (requestId: string, incoming: readonly wire.WireMessage[]): void => {
    const previous = history.get(requestId) ?? new Map<number, wire.WireMessage>()
    for (const item of incoming) {
      const sameSeq = previous.get(item.seq), sameId = [...previous.values()].find(row => row.id === item.id)
      if (item.demand_id !== requestId || sameSeq !== undefined && sameSeq.id !== item.id || sameId !== undefined && sameId.seq !== item.seq
        || sameSeq !== undefined && (sameSeq.text !== item.text || sameSeq.kind !== item.kind || sameSeq.author !== item.author)) {
        throw new wire.DemandWireError()
      }
    }
    for (const item of incoming) previous.set(item.seq, item)
    history.set(requestId, previous)
  }
  const markRead = async (captured: DemandOwner, scope: Scope): Promise<void> => {
    if (!foreground() || selected !== scope.key || scope.requestId === null || readsRunning.has(scope.requestId)) return
    const requestId = scope.requestId, latest = Math.max(0, ...(history.get(requestId)?.keys() ?? []))
    if (latest <= (lastRead.get(requestId) ?? records.get(requestId)?.last_read_seq ?? 0)) return
    readsRunning.add(requestId)
    try {
      const answer = await perform(captured, { method: 'POST', path: `/${requestId}/read`, body: JSON.stringify({ last_read_seq: latest }) })
      if (!sameOwner(captured) || !answer.ok) return
      const payload = wire.object(answer.payload), read = wire.integer(payload.last_read_seq), unread = wire.integer(payload.unread_count)
      if (read < latest || read > (records.get(requestId)?.last_seq ?? latest)) throw new wire.DemandWireError()
      lastRead.set(requestId, read)
      const record = records.get(requestId)
      if (record !== undefined) records.set(requestId, { ...record, last_read_seq: read, unread_count: unread })
      publish()
    } finally { if (sameOwner(captured)) readsRunning.delete(requestId) }
  }
  const readMessages = (scope: Scope, earlier = false): Promise<void> => {
    if (scope.requestId === null || owner === null) return Promise.resolve()
    const requestId = scope.requestId, key = `${requestId}:${earlier ? 'earlier' : 'latest'}`
    const existing = messageReads.get(key)
    if (existing !== undefined) return existing
    const captured = owner
    const task = (async () => {
      if (earlier) scope.loadingEarlier = true
      else if (!history.has(requestId)) scope.messagesStatus = 'loading'
      publish()
      try {
        let row = records.get(requestId)
        if (row === undefined) {
          const detail = await perform(captured, { method: 'GET', path: `/${requestId}` })
          if (!sameOwner(captured)) return
          if (!detail.ok) throw new Error(detail.code)
          row = wire.detail(detail.payload)
          if (row.id !== requestId) throw new wire.DemandWireError()
          mergeRecord(row)
        }
        let after = earlier ? 0 : Math.max(0, (row.last_seq || 0) - 100)
        const stopBefore = earlier ? scope.earliest : Number.MAX_SAFE_INTEGER
        for (;;) {
          const answer = await perform(captured, { method: 'GET', path: `/${requestId}/messages?after_seq=${after}&limit=100` })
          if (!sameOwner(captured)) return
          if (!answer.ok) throw new Error(answer.code)
          const page = wire.messages(answer.payload, requestId)
          mergeRecord(page.demand); mergeMessages(requestId, page.items)
          const authoritative = records.get(requestId)
          if (sameOwner(captured) && page.demand.status === 'completed' && authoritative?.status === 'completed') {
            for (const operation of pendingFor(scope.key, 'action')) {
              const body = wire.object(JSON.parse(operation.body) as unknown)
              if (operation.path === `/${requestId}/actions` && body.action === 'accept_delivery'
                && page.demand.delivery_id === body.delivery_id && authoritative.delivery_id === body.delivery_id) {
                remove(captured, operation.operationId)
              }
            }
          }
          for (const operation of pendingFor(scope.key, 'message')) {
            const persisted = page.items.find(item => item.author === 'user' && item.client_message_id === operation.operationId)
            if (persisted === undefined) continue
            const body = wire.object(JSON.parse(operation.body) as unknown)
            const attachmentIds = wire.array(body.attachment_ids, 64, wire.id).slice().sort()
            if (persisted.text !== body.text || persisted.attachments.map(item => item.id).sort().join(',') !== attachmentIds.join(',')) throw new wire.DemandWireError()
            for (const upload of pendingFor(scope.key, 'upload')) if (attachmentIds.includes(upload.upload?.uploadId ?? '')) remove(captured, upload.operationId)
            remove(captured, operation.operationId)
          }
          const lowest = Math.min(...(history.get(requestId)?.keys() ?? [1]))
          scope.earliest = Number.isFinite(lowest) ? lowest : 1
          scope.messagesStatus = 'ready'; scope.error = null; backoff = 0
          publish()
          if (!page.has_more || page.next_after_seq >= stopBefore - 1) break
          if (page.next_after_seq <= after) throw new wire.DemandWireError()
          after = page.next_after_seq
        }
        if (!earlier) await markRead(captured, scope)
      } catch (_read: unknown) {
        if (sameOwner(captured)) { scope.messagesStatus = 'error'; scope.error = t('messagesFailed'); backoff = Math.min(4, backoff + 1); publish() }
      } finally { if (sameOwner(captured)) { scope.loadingEarlier = false; publish() } }
    })().finally(() => { if (messageReads.get(key) === task) messageReads.delete(key) })
    messageReads.set(key, task)
    return task
  }
  const loadList = async (captured: DemandOwner, more = false): Promise<void> => {
    if (more && (!haveMore || loadingMore || listCursor === null)) return
    if (more) loadingMore = true
    else if (!listLoaded) requestsStatus = 'loading'
    publish()
    try {
      const answer = await perform(captured, { method: 'GET', path: `?limit=30${more ? `&before_id=${encodeURIComponent(listCursor ?? '')}` : ''}` })
      if (!sameOwner(captured)) return
      if (!answer.ok) throw new Error(answer.code)
      const page = wire.list(answer.payload)
      if (more && page.has_more && page.next_before_id === listCursor) throw new wire.DemandWireError()
      for (const row of page.items) mergeRecord(row)
      if (!more) {
        const incoming = page.items.map(item => item.id)
        const retained = order.filter(key => !incoming.includes(key))
        order.splice(0, order.length, ...incoming, ...retained)
      }
      if (more || !listLoaded) { listCursor = page.next_before_id; haveMore = page.has_more }
      listLoaded = true; requestsStatus = 'ready'; lastListRead = now(); backoff = 0
    } catch (_read: unknown) { if (sameOwner(captured)) { requestsStatus = 'error'; backoff += 1 } }
    finally { if (sameOwner(captured)) { loadingMore = false; publish() } }
  }
  const restoreScopes = (): void => {
    for (const operation of pending.values()) {
      if (!scopes.has(operation.scopeKey)) {
        const body = wire.object(JSON.parse(operation.body) as unknown)
        const requestId = operation.kind === 'message' || operation.kind === 'action' ? operation.path.split('/')[1] ?? null : operation.upload?.requestId ?? null
        scopes.set(operation.scopeKey, { key: operation.scopeKey, createdAt: operation.createdAt, requestId,
          engineerId: operation.version === 2 ? '' : operation.kind === 'create' ? wire.id(body.engineer_id) : operation.upload?.engineerId ?? '',
          ...operation.serviceProfileId === undefined ? {} : { serviceProfileId: operation.serviceProfileId,
            ...operation.serviceProfileName === undefined ? {} : { serviceProfileName: operation.serviceProfileName } },
          draft: emptyDraft(operation.scopeKey),
          error: null, messagesStatus: 'ready', loadingEarlier: false, earliest: 1 })
      }
      const scope = scopes.get(operation.scopeKey)
      if (scope !== undefined && operation.kind === 'create') {
        const body = wire.object(JSON.parse(operation.body) as unknown)
        scope.draft = { ...scope.draft, text: wire.text(body.text, 10_000, true), title: wire.text(body.title, 200, true),
          budget: wire.text(body.budget, 100, true), expectedDate: wire.text(body.expected_date, 10, true) }
      }
    }
    if (selected === null) selected = [...pending.values()].find(item => item.kind === 'create' || item.kind === 'upload')?.scopeKey ?? null
  }
  const refreshAll = (): Promise<void> => {
    if (!active || owner === null || !config.enabled || refreshTask !== undefined) return refreshTask ?? Promise.resolve()
    const captured = owner
    const task = (async () => {
      try {
        const answer = await perform(captured, { method: 'GET', path: '/config' })
        if (!sameOwner(captured)) return
        if (!answer.ok) {
          if (answer.httpStatus === 404 || answer.code === 'DEMAND_NOT_FOUND') { unsupported = true; availability = 'unconfigured'; pageError = null; publish(); return }
          if (answer.code === 'DEMAND_AUTH_REQUIRED' || answer.code === 'ACCOUNT_CHANGED') { availability = 'login-required'; pageError = null; publish(); return }
          throw new Error(answer.code)
        }
        const previousMode = serverConfig?.service_profiles
        serverConfig = wire.configuration(answer.payload); unsupported = false
        availability = storageFailed ? 'error' : serverConfig.enabled ? 'ready' : 'disabled'
        pageError = storageFailed ? t('pendingStorageFailed') : null
        if (serverConfig.service_profiles) {
          if (previousMode !== true) { serviceEpoch += 1; serviceFlight?.abort(); serviceFlight = undefined; servicesLoaded = false }
          if (serviceCategoryId !== '' && !serverConfig.categories.some(item => item.id === serviceCategoryId && item.enabled)) {
            serviceCategoryId = ''; servicesLoaded = false; services = []; serviceCursor = null; servicesHaveMore = false
          }
          await loadServices(captured, false, servicesLoaded)
        } else {
          if (previousMode === true) { serviceEpoch += 1; serviceFlight?.abort(); serviceFlight = undefined
            services = []; serviceCursor = null; serviceTotal = 0; servicesHaveMore = false
            servicesLoaded = false; loadingMoreServices = false }
          const directoryAnswer = await perform(captured, { method: 'GET', path: '/engineers' })
          if (!sameOwner(captured)) return
          if (directoryAnswer.ok) directory = wire.directory(directoryAnswer.payload)
          else if (serverConfig.enabled) throw new Error(directoryAnswer.code)
        }
        if (!sameOwner(captured)) return
        restoreScopes(); publish()
        await loadList(captured)
        const scope = currentScope()
        if (scope?.requestId !== null && scope !== undefined) await readMessages(scope)
      } catch (_read: unknown) {
        if (sameOwner(captured)) { availability = 'error'; pageError = t('errorHint'); backoff += 1; publish() }
      }
    })().finally(() => { if (refreshTask === task) refreshTask = undefined })
    refreshTask = task
    return task
  }
  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    if (!active || owner === null || unsupported || !config.enabled) return
    const delay = (foreground() ? config.foregroundPollMs ?? 3000 : config.backgroundPollMs ?? 15_000) * Math.min(16, 2 ** backoff)
    timer = setTimeout(() => {
      timer = undefined
      void track(async () => {
        if (now() - lastListRead >= (config.listPollMs ?? 15_000) || serverConfig === null) await refreshAll()
        else { const scope = currentScope(); if (scope !== undefined) await readMessages(scope) }
        schedule()
      })
    }, delay)
  }
  const execute = async (operation: PendingOperation): Promise<void> => {
    const captured = owner
    if (captured === null || inflight.has(operation.operationId) || !sameOwner(captured)) return
    inflight.add(operation.operationId)
    const scope = scopes.get(operation.scopeKey)
    if (scope !== undefined) scope.error = null
    publish()
    try {
      const answer = await perform(captured, { method: 'POST', path: operation.path, body: operation.body })
      if (!sameOwner(captured)) return
      if (!answer.ok) { if (scope !== undefined) scope.error = failureText(answer.code, answer.unknown); return }
      if (operation.kind === 'action') {
        const payload = wire.object(answer.payload), row = wire.detail(payload)
        wire.boolean(payload.replayed)
        if (row.id !== operation.path.split('/')[1]) throw new wire.DemandWireError()
        mergeRecord(row)
      } else {
        const receipt = wire.sendReceipt(answer.payload), body = wire.object(JSON.parse(operation.body) as unknown)
        const attachmentIds = wire.array(body.attachment_ids, 64, wire.id).slice().sort()
        if (receipt.message.client_message_id !== operation.operationId || receipt.message.text !== body.text
          || operation.kind === 'create' && operation.version === 2 && receipt.demand.service_profile_id !== operation.serviceProfileId
          || operation.kind === 'message' && receipt.demand.id !== operation.path.split('/')[1]
          || receipt.message.attachments.map(item => item.id).sort().join(',') !== attachmentIds.join(',')) throw new wire.DemandWireError()
        mergeRecord(receipt.demand, true); mergeMessages(receipt.demand.id, [receipt.message])
        if (scope !== undefined) {
          scope.requestId = receipt.demand.id; retainTarget(scope, receipt.demand)
          scope.draft = emptyDraft(scope.key); scope.messagesStatus = 'ready'
        }
        for (const upload of pendingFor(operation.scopeKey, 'upload')) {
          if (attachmentIds.includes(upload.upload?.uploadId ?? '')) { remove(captured, upload.operationId); files.delete(upload.operationId) }
        }
      }
      remove(captured, operation.operationId)
      if (scope !== undefined) { scope.error = null; if (scope.requestId !== null) await readMessages(scope) }
    } catch (_receipt: unknown) { if (sameOwner(captured) && scope !== undefined) scope.error = t('resultUnknown') }
    finally { if (sameOwner(captured)) { inflight.delete(operation.operationId); publish() } }
  }
  const uploadFile = async (operationId: string): Promise<void> => {
    const captured = owner, initial = pending.get(operationId)
    if (captured === null || initial?.upload === undefined || uploadsRunning.has(operationId) || !sameOwner(captured)) return
    const abort = new AbortController(); uploadsRunning.set(operationId, abort); uploadErrors.delete(operationId); publish()
    const valid = (): boolean => sameOwner(captured) && !abort.signal.aborted && pending.has(operationId)
    let operation = initial
    const update = (patch: Partial<NonNullable<PendingOperation['upload']>>): boolean => {
      if (operation.upload === undefined || !valid()) return false
      const next = { ...operation, upload: { ...operation.upload, ...patch } }
      if (!save(captured, next)) return false
      operation = next; return true
    }
    const checked = (item: wire.WireAttachment): void => {
      const metadata = operation.upload?.file
      if (metadata === undefined || item.name !== metadata.name || item.size_bytes !== metadata.size || item.mime_type !== metadata.type
        || operation.upload?.uploadId !== null && item.id !== operation.upload?.uploadId) throw new wire.DemandWireError()
    }
    try {
      const file = files.get(operationId)
      if (file === undefined) { uploadErrors.set(operationId, t('uploadReselect')); return }
      const upload = operation.upload
      if (upload === undefined) return
      if (!await matchesUpload(file, upload, abort.signal)) { uploadErrors.set(operationId, t('uploadFileMismatch')); return }
      if (!valid()) return
      const start = await perform(captured, upload.uploadId === null ? { method: 'POST', path: operation.path, body: operation.body }
        : { method: 'GET', path: `/uploads/${upload.uploadId}` }, abort.signal)
      if (!valid()) return
      if (!start.ok) { uploadErrors.set(operationId, failureText(start.code, start.unknown)); return }
      let status = wire.upload(start.payload); checked(status.attachment)
      if (status.offset > 0) {
        let verified = 0
        for (const part of [...upload.parts].sort((a, b) => a.offset - b.offset)) {
          if (part.offset !== verified) break
          verified += part.size
          if (verified >= status.offset) break
        }
        if (verified !== status.offset) throw new wire.DemandWireError()
      }
      if (!update({ uploadId: status.attachment.id, ready: status.attachment.status === 'ready' })) return
      let offset = status.offset, recoveries = 0
      while (offset < file.size) {
        const bytes = Math.min(status.chunk_bytes, file.size - offset)
        const digest = await sliceDigest(file, offset, bytes)
        if (!valid()) return
        const previous = operation.upload?.parts.find(part => part.offset === offset)
        if (previous !== undefined && (previous.size !== bytes || previous.sha256 !== digest)) { uploadErrors.set(operationId, t('uploadFileMismatch')); return }
        if (previous === undefined && !update({ parts: [...operation.upload?.parts ?? [],
          { offset, size: bytes, sha256: digest }] })) return
        const startOffset = offset
        const answer = await perform(captured, { method: 'PUT', path: `/uploads/${status.attachment.id}/chunks`, blob: file.slice(offset, offset + bytes), offset,
          onProgress: (uploaded) => {
            if (valid()) { uploadProgress.set(operationId, Math.min(100, (startOffset + uploaded) / file.size * 100)); publish() }
          } }, abort.signal)
        if (!valid()) return
        if (!answer.ok) {
          if ((!answer.unknown && answer.code !== 'DEMAND_UPLOAD_OFFSET_CONFLICT') || recoveries >= 2) { uploadErrors.set(operationId, failureText(answer.code, answer.unknown)); return }
          recoveries += 1
          const check = await perform(captured, { method: 'GET', path: `/uploads/${status.attachment.id}` }, abort.signal)
          if (!valid()) return
          if (!check.ok) { uploadErrors.set(operationId, failureText(check.code, check.unknown)); return }
          status = wire.upload(check.payload); checked(status.attachment)
          if (status.offset !== offset && status.offset !== offset + bytes) throw new wire.DemandWireError()
          offset = status.offset
        } else {
          const part = wire.chunkReceipt(answer.payload); checked(part.attachment)
          if (part.offset !== offset + bytes) throw new wire.DemandWireError()
          offset = part.offset; recoveries = 0
        }
        uploadProgress.set(operationId, offset / file.size * 100); publish()
      }
      const complete = await perform(captured, { method: 'POST', path: `/uploads/${status.attachment.id}/complete`, body: '{}' }, abort.signal)
      if (!valid()) return
      if (!complete.ok) { uploadErrors.set(operationId, failureText(complete.code, complete.unknown)); return }
      checked(wire.completedUpload(complete.payload))
      if (update({ ready: true })) { uploadProgress.set(operationId, 100); files.delete(operationId) }
    } catch (_upload: unknown) { if (valid()) uploadErrors.set(operationId, t('uploadFailed')) }
    finally { if (sameOwner(captured)) { uploadsRunning.delete(operationId); publish() } }
  }
  const clear = (): void => {
    accountAbort.abort(); serviceEpoch += 1; serviceFlight?.abort(); serviceFlight = undefined
    for (const flight of flights) flight.abort()
    for (const upload of uploadsRunning.values()) upload.abort()
    accountAbort = new AbortController()
    if (timer !== undefined) clearTimeout(timer); timer = undefined
    scopes.clear(); records.clear(); order.splice(0); history.clear(); pending.clear(); files.clear()
    uploadProgress.clear(); uploadErrors.clear()
    uploadsRunning.clear(); inflight.clear(); lastRead.clear(); readsRunning.clear(); messageReads.clear(); confirmed.clear()
    selected = null; serverConfig = null; directory = []; listCursor = null; haveMore = false; loadingMore = false; listLoaded = false
    services = []; serviceCursor = null; serviceTotal = 0; servicesHaveMore = false; loadingMoreServices = false
    servicesLoaded = false; servicesStatus = 'ready'; serviceQuery = ''; serviceCategoryId = ''
    requestsStatus = 'ready'; lastListRead = 0; backoff = 0; storageFailed = false; unsupported = false; refreshTask = undefined; pageError = null
  }
  const observe = (): void => {
    const snapshot = accountSource.getSnapshot(), session = snapshot.session
    const next = session?.signedIn === true && session.account !== undefined && typeof session.accountOwner === 'string'
      && /^[a-f\d]{64}$/u.test(session.accountOwner)
      ? { id: session.account.id, owner: session.accountOwner, epoch: snapshot.accountEpoch } : null
    if (owner?.id === next?.id && owner?.owner === next?.owner && owner?.epoch === next?.epoch) {
      if (next === null) { availability = !config.enabled ? 'unconfigured' : snapshot.loaded ? 'login-required' : 'loading'; publish() }
      return
    }
    clear(); owner = next
    availability = !config.enabled ? 'unconfigured' : next === null ? snapshot.loaded ? 'login-required' : 'loading' : 'loading'
    if (next !== null && config.enabled) {
      try { for (const item of journal.read(next)) pending.set(item.operationId, item); restoreScopes() }
      catch (_storage: unknown) { storageFailed = true; pageError = t('pendingStorageFailed') }
      void track(async () => { await refreshAll(); schedule() })
    }
    publish()
  }
  const dispose = (): Promise<void> => {
    if (closeTask !== undefined) return closeTask
    active = false; unsubscribe?.(); unsubscribe = undefined; owner = null; clear()
    source.set(emptyState(config.enabled ? 'login-required' : 'unconfigured'))
    closeTask = Promise.allSettled([...tasks]).then(() => undefined)
    return closeTask
  }
  const refresh = (): void => {
    unsupported = false
    serviceEpoch += 1; serviceFlight?.abort(); serviceFlight = undefined; servicesLoaded = false
    serviceCursor = null; servicesHaveMore = false; loadingMoreServices = false
    const running = refreshTask, captured = owner
    void track(async () => {
      if (running !== undefined) {
        if (captured !== null && serverConfig?.service_profiles === true) await loadServices(captured)
        await running
      } else await refreshAll()
      schedule()
    })
  }
  const startRequest = (engineerId: string): void => {
    const engineer = directory.find(item => item.id === engineerId)
    if (!active || owner === null || serverConfig?.enabled !== true || engineer?.can_start !== true) return
    const key = `draft:${newId()}`
    scopes.set(key, { key, createdAt: createdAt(), requestId: null, engineerId, draft: emptyDraft(key),
      error: null, messagesStatus: 'ready', loadingEarlier: false, earliest: 1 })
    selected = key; publish()
  }
  const startServiceRequest = (serviceProfileId: string): void => {
    const item = services.find(row => row.id === serviceProfileId)
    if (!active || owner === null || serverConfig?.enabled !== true
      || !serverConfig.service_profiles || item?.can_start !== true) return
    const key = `draft:${newId()}`
    scopes.set(key, { key, createdAt: createdAt(), requestId: null, engineerId: '', serviceProfileId,
      serviceProfileName: item.display_name, draft: emptyDraft(key), error: null, messagesStatus: 'ready', loadingEarlier: false, earliest: 1 })
    selected = key; publish()
  }
  const setServiceFilter = (query: string, categoryId: string): void => {
    if (!active || owner === null || serverConfig?.service_profiles !== true || Array.from(query).length > 100
      || categoryId !== '' && !serverConfig.categories.some(item => item.id === categoryId && item.enabled)) return
    if (query === serviceQuery && categoryId === serviceCategoryId) return
    serviceQuery = query; serviceCategoryId = categoryId; services = []; serviceCursor = null; serviceTotal = 0
    servicesHaveMore = false; loadingMoreServices = false; servicesLoaded = false
    const captured = owner
    void track(() => loadServices(captured))
  }
  const openRequest = (requestId: string): void => {
    if (!active || owner === null) return
    try { wire.id(requestId) } catch (_id: unknown) { return }
    const key = [...scopes.values()].find(item => item.requestId === requestId)?.key ?? `request:${requestId}`
    if (!scopes.has(key)) scopes.set(key, { key, createdAt: createdAt(), requestId,
      engineerId: records.get(requestId)?.engineer_id ?? '', draft: emptyDraft(key),
      error: null, messagesStatus: 'loading', loadingEarlier: false, earliest: 1 })
    const loaded = records.get(requestId), scope = scopes.get(key)
    if (scope !== undefined && loaded !== undefined) retainTarget(scope, loaded)
    selected = key; publish()
    if (scope !== undefined) void track(() => readMessages(scope))
  }
  return {
    hooks: { demands: source }, refresh, openLogin: deps.openLogin ?? (() => {}),
    startRequest, startServiceRequest, setServiceFilter, openRequest,
    loadMoreServices: () => { const captured = owner; if (captured !== null) void track(() => loadServices(captured, true)) },
    openDraft: (scopeKey: string) => {
      const scope = scopes.get(scopeKey)
      if (!active || owner === null || scope === undefined || scope.requestId !== null) return
      selected = scopeKey; publish()
    },
    loadMoreRequests: () => { const captured = owner; if (captured !== null) void track(() => loadList(captured, true)) },
    updateDraft: (patch) => {
      const scope = currentScope()
      if (scope === undefined || scope.draft.sending || pendingFor(scope.key, 'create').length > 0) return
      scope.draft = { ...scope.draft, ...patch, error: null }; publish()
    },
    send: () => {
      const scope = currentScope(), captured = owner
      if (scope === undefined || captured === null) return
      const firstSubmission = pendingFor(scope.key, 'create')[0]
      if (firstSubmission !== undefined) { void track(() => execute(firstSubmission)); return }
      if (storageFailed
        || pendingFor(scope.key).some(item => item.kind === 'message' && inflight.has(item.operationId))) return
      const record = scope.requestId === null ? undefined : records.get(scope.requestId), fields = scope.draft
      const attachments = draftUploads(scope.key)
      if (record !== undefined && terminal(record.status) || attachments.some(item => item.upload?.ready !== true)) return
      const ids = attachments.flatMap(item => item.upload?.uploadId === null || item.upload?.uploadId === undefined
        ? [] : [item.upload.uploadId])
      const validDate = fields.expectedDate === '' || /^\d{4}-\d{2}-\d{2}$/u.test(fields.expectedDate)
        && Number.isFinite(Date.parse(fields.expectedDate))
        && new Date(fields.expectedDate).toISOString().slice(0, 10) === fields.expectedDate
      if (fields.text.trim() === '' && ids.length === 0) return
      if (fields.text.length > 10_000 || fields.title.length > 200 || fields.budget.length > 100 || !validDate) {
        scope.draft = { ...fields, error: t('invalidRequestFields') }; publish(); return
      }
      const operationId = newId(), kind = scope.requestId === null ? 'create' : 'message'
      const body = JSON.stringify(kind === 'create' ? { client_request_id: operationId,
        ...scope.serviceProfileId === undefined ? { engineer_id: scope.engineerId } : { service_profile_id: scope.serviceProfileId },
        text: fields.text, attachment_ids: ids, title: fields.title, budget: fields.budget, expected_date: fields.expectedDate }
        : { client_message_id: operationId, text: fields.text, attachment_ids: ids })
      const operation: PendingOperation = { ...operationRouting(scope), operationId, scopeKey: scope.key, kind,
        path: scope.requestId === null ? '' : `/${scope.requestId}/messages`, body, createdAt: createdAt() }
      if (!save(captured, operation)) return
      if (kind === 'message') scope.draft = emptyDraft(scope.key)
      void track(() => execute(operation))
    },
    retryMessage: (operationId) => { const operation = pending.get(operationId); if (operation !== undefined && (operation.kind === 'create' || operation.kind === 'message')) void track(() => execute(operation)) },
    addAttachments: (selectedFiles) => {
      const scope = currentScope(), captured = owner, rules = serverConfig?.upload_rules
      if (scope === undefined || captured === null || rules === undefined || storageFailed || pendingFor(scope.key, 'create').length > 0) return
      for (const file of selectedFiles) {
        const recovered = draftUploads(scope.key).find(item => !item.upload?.ready && !uploadsRunning.has(item.operationId)
          && item.upload?.file.name === file.name && item.upload.file.size === file.size && item.upload.file.type === file.type)
        if (recovered !== undefined) {
          files.set(recovered.operationId, file); void track(() => uploadFile(recovered.operationId)); continue
        }
        if (draftUploads(scope.key).length >= rules.max_attachments) break
        const maximum = file.type.startsWith('image/') ? rules.max_image_bytes : rules.max_video_bytes
        if (!rules.allowed_mime_types.includes(file.type) || file.size < 1 || file.size > maximum) {
          scope.draft = { ...scope.draft, error: t(file.size > maximum ? 'uploadTooLarge' : 'uploadUnsupported') }; publish(); continue
        }
        const operationId = newId()
        const operation: PendingOperation = { ...operationRouting(scope), operationId, scopeKey: scope.key, kind: 'upload', path: '/uploads', createdAt: createdAt(),
          body: JSON.stringify({ client_upload_id: operationId, name: file.name, mime_type: file.type, size_bytes: file.size }),
          upload: { engineerId: scope.engineerId,
            ...scope.serviceProfileId === undefined ? {} : { serviceProfileId: scope.serviceProfileId }, requestId: scope.requestId,
            file: { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified },
            parts: [], uploadId: null, ready: false } }
        if (!save(captured, operation)) return
        files.set(operationId, file); void track(() => uploadFile(operationId))
      }
      publish()
    },
    removeAttachment: (operationId) => {
      if (owner === null) return
      const operation = pending.get(operationId)
      if (operation?.kind !== 'upload' || pendingFor(operation.scopeKey).some(item => item.kind === 'create'
        || item.kind === 'message' && wire.array(wire.object(JSON.parse(item.body) as unknown).attachment_ids, 64, wire.id).includes(operation.upload?.uploadId ?? ''))) return
      uploadsRunning.get(operationId)?.abort(); remove(owner, operationId); files.delete(operationId); publish()
    },
    retryAttachment: (operationId) => { if (pending.get(operationId)?.kind === 'upload') void track(() => uploadFile(operationId)) },
    loadEarlierMessages: () => {
      const scope = currentScope()
      if (scope !== undefined && !scope.loadingEarlier) void track(() => readMessages(scope, true))
    },
    downloadAttachment: (attachmentId) => {
      if (owner === null) return
      const scope = currentScope()
      const rows = scope?.requestId === null || scope?.requestId === undefined ? [] : [...(history.get(scope.requestId)?.values() ?? [])]
      if (!rows.some(message => message.attachments.some(item => item.id === attachmentId))) return
      const url = demandContentUrl(owner, attachmentId, 'attachment')
      if (deps.download !== undefined) deps.download(url)
      else { const anchor = document.createElement('a'); anchor.href = url; anchor.download = ''; anchor.click() }
    },
    acceptDelivery: (deliveryId) => {
      const scope = currentScope(), captured = owner
      const record = scope?.requestId === null || scope?.requestId === undefined ? undefined : records.get(scope.requestId)
      if (scope === undefined || captured === null || record === undefined || record.status !== 'awaiting_acceptance' || record.delivery_id !== deliveryId || storageFailed) return
      const previous = pendingFor(scope.key, 'action').find(item => wire.object(JSON.parse(item.body) as unknown).delivery_id === deliveryId)
      if (previous !== undefined) { void track(() => execute(previous)); return }
      const operationId = newId(), operation: PendingOperation = { ...operationRouting(scope), operationId, scopeKey: scope.key, kind: 'action',
        path: `/${record.id}/actions`, createdAt: createdAt(), body: JSON.stringify({ client_action_id: operationId, action: 'accept_delivery', revision: record.revision, delivery_id: deliveryId }) }
      if (save(captured, operation)) void track(() => execute(operation))
    },
    start: () => {
      if (active) return () => { void dispose() }
      active = true; closeTask = undefined; unsubscribe = accountSource.subscribe(observe); observe()
      return () => { void dispose() }
    },
    dispose,
    setVisible: (value) => { const was = foreground(); visible = value; if (active) { if (!was && foreground()) {
      const scope = currentScope(), captured = owner
      if (scope !== undefined && captured !== null) void track(() => readMessages(scope))
    } schedule() } },
  }
}
