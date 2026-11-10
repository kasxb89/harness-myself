/** Explicit per-model capacity writes over the existing shared settings form queue. */
import type { ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ModelCatalogDirectory } from './catalog.ts'

/** One exact model and the revision on which its parameter draft opened. */
export interface CapacityWriteRequest {
  provider: string
  model: string
  scope: string
  expectedRevision: number
  /** Omission resets this model to current platform defaults. */
  values?: { contextWindow?: number; maxTokens?: number }
}

/** Safe presentation categories; raw Host diagnostics never become interface copy. */
export type CapacityWriteResult = { ok: true } | {
  ok: false
  reason: 'changed' | 'readOnly' | 'conflict' | 'failed'
  revision?: number
}

/**
 * Bind capacity edits to the same settings mirror and serialized write queue as provider editors.
 * @param catalog - shared Host-generation model catalog.
 * @param forms - existing settings service; no second settings reader or catalog is created.
 * @returns the sole parameter mutation callback.
 */
export function capacityWriter(
  catalog: ModelCatalogDirectory, forms: Pick<ConfigForms, 'describe' | 'get'>,
): (request: CapacityWriteRequest) => Promise<CapacityWriteResult> {
  return async (request: CapacityWriteRequest): Promise<CapacityWriteResult> => {
    const snapshot = catalog.store.getSnapshot()
    const model = snapshot.status === 'ready' ? snapshot.value?.groups
      .find(group => group.id === request.provider)?.models.find(value => value.id === request.model) : undefined
    const limits = model?.limits
    const address = model?.limitSettings
    const contextMaximum = limits?.platform.contextWindow
    const outputMaximum = limits?.platform.maxOutputTokens
    if (limits === undefined || limits.managedScope !== request.scope || address === undefined
      || contextMaximum === undefined || outputMaximum === undefined) {
      return { ok: false, reason: 'changed' }
    }
    const mirror = forms.describe().getSnapshot()
    const namespace = mirror.view?.namespaces.find(value => value.ns === address.settingsNs)
    if (mirror.status !== 'ready' || mirror.view?.writable !== true || namespace === undefined) {
      return { ok: false, reason: 'readOnly' }
    }
    if (namespace.revision !== request.expectedRevision) {
      return { ok: false, reason: 'conflict', revision: namespace.revision }
    }
    const values = request.values
    if (values !== undefined) {
      if (values.contextWindow === undefined && values.maxTokens === undefined
        || ([[values.contextWindow, contextMaximum], [values.maxTokens, outputMaximum]] as const)
          .some(([value, maximum]) => value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > maximum))
        || values.maxTokens !== undefined && values.maxTokens > (values.contextWindow ?? contextMaximum)) {
        return { ok: false, reason: 'failed' }
      }
    }
    const path = [...address.settingsPath, 'modelLimitOverrides', request.model]
    try {
      const form = forms.get(address.settingsNs)
      const accepted = await form.mutate(values === undefined ? [{ op: 'unset', path }]
        : [{ op: 'set', path, value: { scope: request.scope, ...values } }], request.expectedRevision)
      if (!accepted) {
        const revision = form.getSnapshot().revision
        return { ok: false, reason: revision !== undefined && revision !== request.expectedRevision ? 'conflict' : 'failed',
          ...revision === undefined ? {} : { revision } }
      }
      void catalog.reload().catch(() => { /* the directory shows its own current read failure */ })
      return { ok: true }
    } catch {
      return { ok: false, reason: 'failed' }
    }
  }
}
