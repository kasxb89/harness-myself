/** Video composer drafts survive image/video mode changes within one window. */
import { defineStore } from '@deepseek-ai/dsh-client-store'

/** One uploaded reference and its window-owned preview URL. */
export interface Reference {
  assetId: string
  name: string
  url: string
}

/** Supported composer input arrangements; these are not model API parameters. */
export type Workflow = 'text' | 'image' | 'frames' | 'reference'
/** Reference media kinds accepted by the existing asset route. */
export type Slot = 'image' | 'video'
/** Local camera-script category filter. */
export type Category = 'all' | 'commerce' | 'story' | 'cinematic'

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
  category: Category
  uploading: string | null
  phase: 'idle' | 'running' | 'done'
  startedAt: number
  message: string | null
  failure: string | null
  result: { path: string } | null
}

/**
 * Declare one root-scoped composer store without disk persistence.
 * @returns draft fields and operation presentation retained across panel remounts.
 */
export function createVideoDraftStore() {
  return defineStore({
    init: (): VideoDraft => ({
      modelId: '', prompt: '', duration: 0, resolution: '', ratio: '', mode: '', seed: '', audio: true,
      workflow: 'text', firstFrame: null, lastFrame: null, slots: { image: [], video: [] },
      category: 'all', uploading: null, phase: 'idle', startedAt: 0, message: null, failure: null, result: null,
    }),
    actions: {
      patch: (draft, values: Partial<VideoDraft>) => { Object.assign(draft, values) },
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
