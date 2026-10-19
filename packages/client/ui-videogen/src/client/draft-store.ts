/** Video composer drafts survive image/video mode changes within one window. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** One uploaded reference and its window-owned preview URL. */
export interface Reference {
  assetId: string
  name: string
  url: string
  bytes: number
  converted?: boolean
  firstFrameOnly?: boolean
}

/** Supported composer input arrangements; these are not model API parameters. */
export type Workflow = 'text' | 'image' | 'frames' | 'reference'
/** Reference media kinds accepted by the existing asset route. */
export type Slot = 'image' | 'video' | 'audio'
/** Local camera-script category filter. */
export type Category = string

/** Viewing state only; catalog and artifact records remain query-owned. */
export interface VideoDraft {
  modelId: string
  prompt: string
  duration: number
  resolution: string
  ratio: string
  mode: string
  seed: string
  audio: boolean
  workflow: Workflow
  firstFrame: Reference | null
  lastFrame: Reference | null
  slots: Record<Slot, Reference[]>
  referenceAccountId: string | null
  referenceEpoch: number
  category: Category
  uploading: string | null
  promptAssisting: boolean
  phase: 'idle' | 'running' | 'done'
  startedAt: number
  message: string | null
  failure: string | null
  /** Per-file upload failures survive successful later items in the same batch. */
  uploadFailures: readonly { readonly name: string; readonly reason: string }[]
  /** Selected mounted outputs retain their workspace coordinate for media reads. */
  result: { path: string; workspaceId?: string } | null
}

type DraftActions = {
  patch: (draft: VideoDraft, values: Partial<VideoDraft>) => void
  setReferenceAccount: (draft: VideoDraft, accountId: string | null) => void
  appendPrompt: (draft: VideoDraft, suffix: string) => void
  addReferences: (draft: VideoDraft, slot: Slot, references: Reference[], limit: number) => void
  removeReference: (draft: VideoDraft, slot: Slot, assetId: string) => void
}

/**
 * Declare one root-scoped composer store without disk persistence.
 * @returns a store handle retaining draft fields and operation feedback across panel remounts.
 */
export function createVideoDraftStore(): EngineStoreHandle<VideoDraft, DraftActions> {
  return defineStore({
    init: (): VideoDraft => ({
      modelId: '', prompt: '', duration: 0, resolution: '', ratio: '', mode: '', seed: '', audio: true,
      workflow: 'text', firstFrame: null, lastFrame: null, slots: { image: [], video: [], audio: [] },
      category: 'all', uploading: null, phase: 'idle', startedAt: 0, message: null, failure: null, result: null,
      uploadFailures: [],
      referenceAccountId: null, referenceEpoch: 0, promptAssisting: false,
    }),
    actions: {
      patch: (draft, values: Partial<VideoDraft>) => { Object.assign(draft, values) },
      setReferenceAccount: (draft, accountId: string | null) => {
        if (draft.referenceAccountId === accountId) return
        draft.referenceAccountId = accountId
        draft.referenceEpoch += 1
        draft.promptAssisting = false
        draft.firstFrame = null
        draft.lastFrame = null
        draft.slots = { image: [], video: [], audio: [] }
        draft.uploading = null
        draft.uploadFailures = []
      },
      appendPrompt: (draft, suffix: string) => {
        if (!draft.prompt.includes(suffix)) draft.prompt += suffix
      },
      addReferences: (draft, slot: Slot, references: Reference[], limit: number) => {
        draft.slots[slot] = [...draft.slots[slot], ...references].slice(0, limit)
      },
      removeReference: (draft, slot: Slot, assetId: string) => {
        draft.slots[slot] = draft.slots[slot].filter(reference => reference.assetId !== assetId)
      },
    },
  })
}
