/** Image composer choices retained while the creation module changes modes. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** A locally uploaded reference selected by this composer. */
export interface ImageReference {
  readonly assetId: string
  readonly name: string
  readonly url: string
}

/** Composer choices and visible operation feedback shared across panel mounts. */
export type ImageDraft = {
  prompt: string
  modelId: string
  size: string
  quality: string
  background: string
  format: string
  compression: number
  moderation: string
  seed: string
  count: number
  references: readonly ImageReference[]
  referenceLimit: number
  uploading: boolean
  generationStartedAt: number | null
  sessionInvalid: boolean
  message: string | null
  failure: string | null
  resultPaths: readonly string[]
}

type DraftActions = {
  patch: (draft: ImageDraft, values: Partial<ImageDraft>) => void
  appendReference: (draft: ImageDraft, reference: ImageReference, modelId: string, limit: number) => void
  removeReference: (draft: ImageDraft, assetId: string) => void
}

/**
 * Create the registration-owned composer draft without persisting reference URLs.
 * @returns a store handle shared by successive mounts of the image panel.
 */
export function createImageDraftStore(): EngineStoreHandle<ImageDraft, DraftActions> {
  return defineStore({
    init: (): ImageDraft => ({
      prompt: '', modelId: '', size: '', quality: '', background: '', format: '',
      compression: 90, moderation: '', seed: '', count: 1, references: [], referenceLimit: 0,
      uploading: false, generationStartedAt: null, sessionInvalid: false, message: null, failure: null, resultPaths: [],
    }),
    actions: {
      patch: (draft, values: Partial<ImageDraft>) => { Object.assign(draft, values) },
      appendReference: (draft, reference: ImageReference, modelId: string, limit: number) => {
        if (draft.modelId !== modelId || draft.references.length >= Math.min(limit, draft.referenceLimit)) return
        draft.references = [...draft.references, reference]
      },
      removeReference: (draft, assetId: string) => {
        draft.references = draft.references.filter(reference => reference.assetId !== assetId)
      },
    },
  })
}
