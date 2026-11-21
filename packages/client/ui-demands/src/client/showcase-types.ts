/** Public case-list state is separate from customer orders and login metadata. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { CaseShowcaseCategory, CaseShowcaseItem } from './case-showcase-types.ts'

/** One public catalog snapshot, retaining its explicitly negotiated data source. */
export interface ShowcaseState {
  readonly source: 'checking' | 'legacy' | 'backend'
  readonly status: 'loading' | 'ready' | 'error'
  readonly items: readonly CaseShowcaseItem[]
  readonly category: CaseShowcaseCategory | null
  readonly categories: readonly CaseShowcaseCategory[]
  readonly total: number
  readonly hasMore: boolean
  readonly loadingMore: boolean
  readonly error: string | null
}
/** Public reads never submit a demand, mutate an account or create a generation task. */
export interface ShowcaseFace {
  readonly hooks: { readonly showcases: ObservableSnapshot<ShowcaseState> }
  readonly refreshShowcases: () => void
  readonly loadMoreShowcases: () => void
  readonly setShowcaseCategory: (category: CaseShowcaseCategory | null) => void
}
