/** A readonly backend showcase model negotiates legacy compatibility explicitly. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CaseShowcaseItem } from './case-showcase-types.ts'
import type { ShowcaseFace, ShowcaseState } from './showcase-types.ts'
import { requestShowcase } from './showcase-api.ts'
import { showcaseConfig, showcasePage } from './showcase-wire.ts'

/** Existing public carrier settings; fallback cases are used only when v1 is not supported. */
export interface ShowcaseControllerConfig {
  readonly enabled: boolean
  readonly requestTimeoutMs?: number
  readonly showcaseItems?: readonly CaseShowcaseItem[]
}
/** Synthetic one-shot reads can be supplied without mounting a server or handling credentials. */
export interface ShowcaseControllerDependencies { readonly request?: typeof requestShowcase }
/** Shared model lifecycle and readonly commands. */
export interface ShowcaseController extends ShowcaseFace {
  readonly start: () => () => void
  readonly dispose: () => Promise<void>
}
/**
 * Build an independent public case model without starting reads until its lifecycle begins.
 * @param config - Validated carrier limits and old configured public references.
 * @param dependencies - Optional one-shot read seam for focused tests.
 * @returns Stable snapshots and public GET commands, never order or media mutations.
 */
export function createShowcaseController(
  config: ShowcaseControllerConfig, dependencies: ShowcaseControllerDependencies = {},
): ShowcaseController {
  const source = createSnapshotStore<ShowcaseState>({ source: 'checking', status: 'loading', items: [], category: null,
    categories: [], total: 0, hasMore: false, loadingMore: false, error: null })
  const request = dependencies.request ?? requestShowcase
  let value = source.getSnapshot(), active = false, disposed = false, epoch = 0, cursor = '', declared = false
  let flight: AbortController | null = null
  const tasks = new Set<Promise<void>>()
  const publish = (patch: Partial<ShowcaseState>): void => { value = { ...value, ...patch }; source.set(value) }
  const run = (task: () => Promise<void>): void => {
    const promise = task(); tasks.add(promise); void promise.finally(() => { tasks.delete(promise) })
  }
  const valid = (generation: number): boolean => active && !disposed && generation === epoch
  const fallback = (): void => {
    const all = config.enabled ? [...config.showcaseItems ?? []] : []
    const available = [...new Set(all.map(item => item.category))]
    const items = value.category === null ? all : all.filter(item => item.category === value.category)
    publish({ source: 'legacy', status: 'ready', items, categories: available, total: items.length, hasMore: false, loadingMore: false, error: null })
  }
  const load = async (more: boolean): Promise<void> => {
    if (!active || disposed || value.source !== 'backend' || more && (!value.hasMore || flight !== null)) return
    flight?.abort(); const abort = new AbortController(), generation = ++epoch, originalCursor = cursor, selectedCategory = value.category
    flight = abort
    publish({ status: more && value.items.length > 0 ? value.status : 'loading', loadingMore: more, error: null })
    try {
      const query = new URLSearchParams({ limit: '100' })
      if (more) query.set('cursor', originalCursor)
      if (selectedCategory !== null) query.set('category', selectedCategory)
      const response = await request('?' + query.toString(), AbortSignal.any([abort.signal, AbortSignal.timeout(config.requestTimeoutMs ?? 20_000)]))
      if (!valid(generation) || abort.signal.aborted) return
      if (!response.ok) {
        publish({ status: 'error', error: response.code, loadingMore: false,
          ...[401, 403].includes(response.httpStatus) ? { items: [], total: 0, hasMore: false } : {} }); return
      }
      const page = showcasePage(response.payload)
      if (more && page.more && page.cursor === originalCursor || selectedCategory !== null && page.items.some(item => item.category !== selectedCategory)) throw new Error('SHOWCASE_PROTOCOL_INVALID')
      const rows = new Map((more ? value.items : []).map(item => [item.id, item]))
      for (const item of page.items) rows.set(item.id, item)
      cursor = page.cursor
      publish({ source: 'backend', status: 'ready', items: [...rows.values()], total: page.total, hasMore: page.more, loadingMore: false, error: null })
    } catch (_error: unknown) {
      if (valid(generation) && !abort.signal.aborted) publish({ status: 'error', error: 'SHOWCASE_PROTOCOL_INVALID', loadingMore: false })
    } finally { if (generation === epoch) flight = null }
  }
  const probe = async (): Promise<void> => {
    flight?.abort(); const abort = new AbortController(), generation = ++epoch; flight = abort
    publish({ status: 'loading', error: null, loadingMore: false })
    try {
      const response = await request('/config', AbortSignal.any([abort.signal, AbortSignal.timeout(config.requestTimeoutMs ?? 20_000)]))
      if (!valid(generation) || abort.signal.aborted) return
      if (!response.ok) {
        if (!declared && response.httpStatus === 404) { fallback(); return }
        publish({ status: 'error', error: response.code, ...[401, 403].includes(response.httpStatus) ? { items: [], total: 0, hasMore: false } : {} }); return
      }
      const caps = showcaseConfig(response.payload)
      if (!caps.supported) {
        if (declared) { publish({ status: 'error', error: 'SHOWCASE_CAPABILITY_CHANGED', items: [], total: 0, hasMore: false }); return }
        fallback(); return
      }
      declared = true; cursor = ''; flight = null
      const selected = value.category !== null && caps.categories.includes(value.category) ? value.category : null
      const retained = value.source === 'backend' && selected === value.category
      publish({ source: 'backend', categories: caps.categories, category: selected,
        ...retained ? {} : { items: [], total: 0, hasMore: false } })
      await load(false)
    } catch (_error: unknown) {
      if (valid(generation) && !abort.signal.aborted) publish({ status: 'error', error: 'SHOWCASE_PROTOCOL_INVALID' })
    } finally { if (generation === epoch) flight = null }
  }
  return {
    hooks: { showcases: source },
    start: () => {
      if (disposed || active) return () => {}
      active = true
      if (config.enabled) run(probe); else fallback()
      return () => { active = false; epoch += 1; flight?.abort(); flight = null }
    },
    async dispose(): Promise<void> { disposed = true; active = false; epoch += 1; flight?.abort(); await Promise.allSettled([...tasks]) },
    refreshShowcases: () => { if (active && !disposed && config.enabled) run(probe) },
    loadMoreShowcases: () => { run(() => load(true)) },
    setShowcaseCategory: (category) => {
      if (!active || disposed || category === value.category || category !== null && !value.categories.includes(category)) return
      flight?.abort(); flight = null; epoch += 1; cursor = ''
      publish({ category, items: [], total: 0, hasMore: false, loadingMore: false, error: null })
      if (value.source === 'legacy') fallback(); else if (value.source === 'backend') run(() => load(false))
    },
  }
}
