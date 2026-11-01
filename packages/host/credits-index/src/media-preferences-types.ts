/** Browser-safe personal media choices, separate from platform access and financial approval. @module */
import type { ImageParams, VideoParams } from './media.ts'
import type { MediaDefaultSelection } from './media-defaults.ts'

/** Static public controls; reference media, prompts and secrets are never preferences. */
export interface MediaPreferenceSelection {
  readonly model: string
  readonly parameters: Readonly<Record<string, string | number | boolean>>
}

/** One account/deployment's saved preferences and compare-and-swap revision. */
export interface MediaPreferences {
  readonly schema_version: 1
  readonly scope: string
  readonly revision: string
  readonly image: MediaPreferenceSelection | null
  readonly video: MediaPreferenceSelection | null
}

/** Public default-retail unit reference for one legal specification and input context. */
export interface MediaPreferencePriceRow {
  readonly parameters: Readonly<Record<string, string | number | boolean>>
  readonly points: string
  readonly input: 'text' | 'reference' | 'unspecified'
}

/** Optional display metadata; it never authorizes generation or enters saved choices. */
export interface MediaPreferencePricing {
  readonly schema_version: 1
  readonly status: 'available' | 'unavailable'
  readonly basis: 'default'
  readonly source: 'public-retail'
  readonly unit: 'points/image' | 'points/second'
  readonly credits_per_yuan?: string
  readonly coverage: 'complete' | 'partial' | 'none'
  readonly rows: readonly MediaPreferencePriceRow[]
}

/** Current-account public parameter menus, without private routing or costs. */
export type MediaPreferenceModel = {
  readonly id: string
  readonly displayName: string
  readonly verified: boolean
  readonly source: string
  readonly notes: readonly string[]
  readonly pricing?: MediaPreferencePricing
} & ({ readonly kind: 'image'; readonly params: ImageParams } | { readonly kind: 'video'; readonly params: VideoParams })

/** Authorized directory and deployment defaults returned with saved preferences. */
export interface MediaPreferencesCatalog extends MediaPreferences {
  readonly catalog: { readonly image: readonly MediaPreferenceModel[]; readonly video: readonly MediaPreferenceModel[] }
  readonly defaults: { readonly image: MediaDefaultSelection; readonly video: MediaDefaultSelection }
}

/** Logged choices for one submitted human RPC; unavailable metadata does not reject ordinary text. */
export type MediaRequestSelection = {
  readonly schema_version: 1
  readonly requestId: string
} & ({ readonly state: 'selected'
  readonly scope: string
  readonly revision: string
  readonly image: MediaPreferenceSelection | null
  readonly video: MediaPreferenceSelection | null }
  | { readonly state: 'unavailable'
    readonly code: 'MEDIA_PREFERENCES_UNAVAILABLE' | 'ACCOUNT_CHANGED' | 'MEDIA_PREFERENCES_CONFLICT' })

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Required execution choices captured before this human request enters the agent inbox. */
    'media/request-selection': MediaRequestSelection
  }
}
