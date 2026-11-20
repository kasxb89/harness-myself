/** Read-only presentation metadata for explicitly configured public case materials. */

/** Product category used only for local filtering, never inferred from a filename. */
export type CaseShowcaseCategory = 'pc' | 'web' | 'miniapp' | 'exe' | 'game' | 'image' | 'video'

/** One explicitly published media URL; local filesystem paths and credentials stay with the host. */
export interface CaseShowcaseMedia {
  /** Media presentation used by the case viewer. */
  readonly kind: 'image' | 'video'
  /** Explicitly public media URL served by the configured content origin. */
  readonly url: string
  /** Optional public preview image for a video. */
  readonly posterUrl?: string
}

/** A configured case and its source attribution, independent of customer demand records. */
export interface CaseShowcaseItem {
  /** Stable identifier for this configured case. */
  readonly id: string
  /** Public title displayed on the case card. */
  readonly title: string
  /** Short explanation of the case and its result. */
  readonly description: string
  /** Product category used by the case filters. */
  readonly category: CaseShowcaseCategory
  /** Public cover image displayed before opening the case. */
  readonly coverUrl: string
  /** Ordered images and videos available in the case viewer. */
  readonly media: readonly CaseShowcaseMedia[]
  /** Name of the public source or material owner. */
  readonly sourceName?: string
  /** Optional public source page for attribution. */
  readonly sourceUrl?: string
  /** Additional attribution shown with the case materials. */
  readonly attribution?: string
}
