/** Administrator-authored Chinese copy with optional English translation. */
export interface LocalizedText { readonly zh: string; readonly en?: string }

/** A published-content category. */
export interface CreationCategory {
  readonly id: string
  readonly label: LocalizedText
  readonly sortOrder: number
  readonly enabled: boolean
}

/** A reusable creation brief and its uploaded preview media. */
export interface CreationTemplate {
  readonly id: string
  readonly categoryId: string | null
  readonly title: LocalizedText
  readonly description: LocalizedText
  readonly prompt: LocalizedText
  readonly coverAssetId: string | null
  readonly demoVideoAssetId: string | null
  readonly sortOrder: number
  readonly status: 'draft' | 'published'
}

/** An administrator-authored addition to the current creation brief. */
export interface CreationPreset {
  readonly id: string
  readonly label: LocalizedText
  readonly promptSuffix: LocalizedText
  readonly sortOrder: number
  readonly status: 'draft' | 'published'
}

/** Page copy and published content for one creation mode. */
export interface ModeContent {
  readonly title: LocalizedText
  readonly description: LocalizedText
  readonly promptPlaceholder: LocalizedText
  readonly categories: readonly CreationCategory[]
  readonly templates: readonly CreationTemplate[]
  readonly presets: readonly CreationPreset[]
}

/** Versioned content published by the local administration service. */
export interface CreationContent {
  readonly schemaVersion: 1
  readonly revision: string
  readonly image: ModeContent
  readonly video: ModeContent
}

/** Shared live content; failures retain the last successfully validated document. */
export interface CreationContentSnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  readonly content: CreationContent | null
}

/** React-free published content source, shared by image and video workspaces. */
export interface CreationContentCatalog {
  /** Read the stable snapshot until its state changes. @returns Current catalog state. */
  getSnapshot(): CreationContentSnapshot
  /** Observe state changes. @param listener Change callback. @returns Subscription disposer. */
  subscribe(listener: () => void): () => void
  /** Fetch the latest publication, coalescing concurrent readers. @returns Resolves after the read settles. */
  refresh(): Promise<void>
}
