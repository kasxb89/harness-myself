/**
 * ModelDirectoryResolver (`ctx.modelDirectories`): the root owner of per-session
 * {@link ModelDirectory} instances. Both selection entries (the /model popup
 * and the composer model seat) resolve their session's directory through
 * this service, which is what makes the dual entry one shared state.
 *
 * Per-session storage follows the client service pattern (InputTriggerService /
 * CommandUiRuntime): a lazy service-internal map whose entry is deleted by the
 * owning scope's disposer. The host `dsh-scope` ScopedLayers registry does
 * does not belong here: it derives scope from the host carrier mechanism
 * (object-keyed), while client scopes tag contexts with branded SessionId
 * strings, and it models global+shadow named registries — this is a
 * per-session singleton with no global layer to merge.
 */
import type {} from '@deepseek-ai/dsh-client-product-analytics/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Service } from '@deepseek-ai/cordis'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WeakMapWithValues } from '@deepseek-ai/dsh-util-values'
import { ModelCatalogDirectory } from './catalog.ts'
import { ModelDirectory } from './directory.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelDirectories: ModelDirectoryResolver
  }
}

/** Live mutable state in one holder (service methods run behind the caller-ctx tracker). */
interface LiveState {
  /** Directories keyed by Client binding, removed by their scope disposer. */
  readonly directories: WeakMapWithValues<SessionBinding, ModelDirectory>
  /** Session-owned input bridges joined when the model service unloads. */
  readonly inputBridges: Set<Fiber>
}

/** The `ctx.modelDirectories` session model-selection service. */
export class ModelDirectoryResolver extends Service {
  static inject = ['sessions', 'remote', 'remote.session']

  private readonly live: LiveState = { directories: new WeakMapWithValues(), inputBridges: new Set() }
  /** Shared Host catalog used by session selectors and the Settings directory. */
  readonly catalog: ModelCatalogDirectory

  /**
   * @param ctx - owning root context (the service registers itself as `modelDirectories`).
   */
  constructor(ctx: Context) {
    super(ctx, 'modelDirectories')
    this.catalog = new ModelCatalogDirectory(ctx)
    ctx.effect(() => async () => {
      await Promise.all([...this.live.inputBridges].map(bridge => bridge.dispose()))
      this.live.inputBridges.clear()
      for (const directory of this.live.directories.values) directory.dispose()
      this.live.directories.clear()
    }, 'ui-model-selection: directory and input bridge lifetime')
    void this.catalog.load().catch(() => { /* selectors expose the shared error */ })
    ctx.on('connection/reset', () => {
      this.catalog.resetGeneration()
      for (const directory of this.live.directories.values) directory.resetConnected()
    })
    ctx.remote.$on('llm/adapters-updated', () => { this.catalog.refresh() })
    ctx.remote.$on('api-session/model-catalog-changed', () => { this.catalog.refresh() })
    ctx.remote.$on('settings/document-updated', () => { this.catalog.refresh() })
    ctx.remote.$on('credentials/record-updated', () => { this.catalog.refresh() })
    ctx.remote.$on('credentials/reference-updated', () => { this.catalog.refresh() })
  }

  /**
   * Resolve the per-session shared directory (lazy; the scope disposer
   * removes and disposes it). Unknown sessions fail loud.
   * @param sessionId - the owning session.
   * @returns the resident directory both entries share.
   */
  directoryFor(sessionId: SessionId): ModelDirectory {
    const { live } = this
    const sessions = this.ctx.sessions
    const actx = sessions.scope(sessionId)
    if (actx === undefined) throw new Error(`ui-model-selection: session "${String(sessionId)}" resolved no scope`)
    const binding = sessions.binding(sessionId)
    if (binding === undefined) throw new Error(`ui-model-selection: session "${String(sessionId)}" resolved no binding`)
    const existing = live.directories.get(binding)
    if (existing !== undefined) return existing
    const directory = new ModelDirectory(
      this.ctx.remote.session,
      sessionId,
      () => sessions.subagentAddress(sessionId) === undefined,
      this.catalog,
      binding.session.projections.faceOf('modelSelection'),
      () => binding.session.getSnapshot().blank,
      (name, attributes) => this.ctx.get('productAnalytics')?.track(name, attributes),
    )
    live.directories.set(binding, directory)
    const inputBridge = actx.inject(['conversation'], (scope) => {
      scope.conversation.input.for(scope)
      const publish = (): void => {
        const state = directory.store.getSnapshot()
        const group = state.groups.find(value => value.id === state.current?.provider)
        const model = group?.models.find(value => value.id === state.current?.model)
        const declared = model?.textCapabilities !== undefined || model?.inputModalities !== undefined
        const legacy = model?.textCapabilities === undefined || model.textCapabilities.schemaVersion === 2 ? {}
          : { tools: model.textCapabilities.tools, vision: model.textCapabilities.vision }
        scope.emit(scope, 'conversation/input-model-capabilities', !declared ? undefined : {
          ...model.executionCapabilities ?? legacy,
          ...model.textCapabilities?.verification === undefined ? {} : { verification: { ...model.textCapabilities.verification } },
          ...model.textCapabilities?.revision === undefined ? {} : { revision: model.textCapabilities.revision },
          ...model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] },
        })
      }
      scope.effect(() => {
        publish()
        const off = directory.store.subscribe(publish)
        return () => {
          off()
          scope.emit(scope, 'conversation/input-model-capabilities', undefined)
        }
      }, 'ui-model-selection: input capabilities')
    })
    live.inputBridges.add(inputBridge)
    actx.effect(() => () => {
      live.inputBridges.delete(inputBridge)
      directory.dispose()
      live.directories.delete(binding)
    }, 'ui-model-selection: session directory')
    return directory
  }
}
