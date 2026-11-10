/** Public unit price display metadata, separate from saved choices and Session events. @module */
import type {
  MediaPreferenceModel as BaseMediaPreferenceModel,
  MediaPreferencePriceRow as BaseMediaPreferencePriceRow,
  MediaPreferencePricing as BaseMediaPreferencePricing,
} from './media-preferences-types.ts'

/** Public default-retail unit reference with explicit free display evidence. */
export interface MediaPreferencePriceRow extends BaseMediaPreferencePriceRow {
  /** The public retail row explicitly declares an exact zero unit price; display evidence only. */
  readonly is_free?: true
}

/** Optional display metadata with explicit free evidence on each unit row. */
export interface MediaPreferencePricing extends BaseMediaPreferencePricing {
  readonly rows: readonly MediaPreferencePriceRow[]
}

/** Current-account public model with explicit free evidence in its optional price display. */
export type MediaPreferenceModel = BaseMediaPreferenceModel & {
  readonly pricing?: MediaPreferencePricing
}
