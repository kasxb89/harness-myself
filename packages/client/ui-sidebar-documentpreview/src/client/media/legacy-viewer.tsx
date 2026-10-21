/** Optional media viewer for the public better-sidebar 0.19.1/0.25 custom-loader API. */
import { useEffect, useState, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId, WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import { MediaPlayer, type MediaFile } from './MediaPlayer.tsx'

/** The shared public descriptor fields implemented by both supported legacy releases. */
interface LegacyMediaDescriptor {
  readonly id: string
  readonly title: () => string
  readonly exts: readonly string[]
  readonly priority: number
  readonly fetchStrategy: 'custom'
  readonly load: (path: string, scope: { readonly sessionId: string }, signal?: AbortSignal) => Promise<unknown>
  readonly component: (props: { readonly customData?: unknown }) => ReactNode
}

interface LegacyViewerService {
  registerFileViewer(descriptor: LegacyMediaDescriptor): () => void
}

/** External plugins are optional and do not participate in this package's compile graph. */
function isLegacyViewerService(value: unknown): value is LegacyViewerService {
  return typeof value === 'object' && value !== null
    && 'registerFileViewer' in value && typeof value.registerFileViewer === 'function'
}

type TranslateMedia = PropsLocale<'sidebarMedia'>['t']

/** One custom-loader result, privately returned to the matching component. */
class LegacyMediaLoad {
  constructor(
    readonly id: number,
    readonly name: string,
    readonly signal: AbortSignal,
    readonly file: MediaFile | undefined,
    readonly reload: (signal: AbortSignal) => Promise<MediaFile | undefined>,
  ) {}
}

/** Wait for actual Session membership; the current Workspace and cwd never confer access. */
async function sessionWorkspace(source: WorkspaceSource, sessionId: SessionId, signal: AbortSignal): Promise<WorkspaceId | undefined> {
  const aborted = (): boolean => signal.aborted
  if (aborted()) return undefined
  const settled = (): boolean => {
    const snapshot = source.getSnapshot()
    return snapshot.phase === 'ready' || snapshot.state === 'error'
  }
  if (!settled()) await new Promise<void>((resolve) => {
    const release = (): void => { unsubscribe(); signal.removeEventListener('abort', abort) }
    const abort = (): void => { release(); resolve() }
    const unsubscribe = source.subscribe(() => { if (settled()) { release(); resolve() } })
    signal.addEventListener('abort', abort, { once: true })
    if (aborted()) abort()
    else if (settled()) { release(); resolve() }
  })
  if (aborted()) return undefined
  return source.getSnapshot().items.find(workspace =>
    workspace.sessionIds.some(member => member === sessionId))?.workspaceId
}

/** The legacy host has no reload callback in 0.19.1, so retries own a fresh metadata read. */
function LegacyMediaBody(props: { readonly data: LegacyMediaLoad; readonly t: TranslateMedia }): ReactNode {
  const [attempt, setAttempt] = useState(0)
  const [prepared, setPrepared] = useState<{ readonly attempt: number; readonly file: MediaFile | undefined }>(
    { attempt: 0, file: props.data.file },
  )
  const pending = prepared.attempt !== attempt
  useEffect(() => {
    if (!pending) return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, props.data.signal])
    void props.data.reload(signal).then((file) => {
      if (!signal.aborted) setPrepared({ attempt, file })
    })
    return () => { controller.abort() }
  }, [attempt, pending, props.data])
  return <MediaPlayer key={attempt} name={props.data.name} revision={String(attempt)}
    signal={props.data.signal} file={pending ? undefined : prepared.file} pending={pending} t={props.t}
    loaded={() => {}} failed={() => {}} reload={() => { setAttempt(value => value + 1) }} />
}

/**
 * Supply streamed media only while a compatible legacy viewer service is present.
 * @param ctx - Owning plugin context with Host file metadata and Workspace services.
 * @param extensions - Existing native media suffixes, without leading dots.
 */
export function registerLegacyMediaViewer(ctx: Context, extensions: readonly string[]): void {
  ctx.inject(['betterSidebar', 'remote.workspaceFiles', 'workspaces'], (scope) => {
    const candidate: unknown = scope.get('betterSidebar')
    if (!isLegacyViewerService(candidate)) return
    const service = candidate
    const t = scope.locale.bind('sidebarMedia')
    scope.effect(() => {
      const controller = new AbortController()
      let loadSequence = 0
      const requests = new Set<Promise<MediaFile | undefined>>()
      const read = (path: string, sessionId: SessionId, signal: AbortSignal): Promise<MediaFile | undefined> => {
        const aborted = (): boolean => signal.aborted
        const request = (async (): Promise<MediaFile | undefined> => {
          if (aborted()) return undefined
          const metadata = await scope.remote.workspaceFiles.stat(sessionId, path, signal)
          if (aborted() || !metadata.ok) return undefined
          const workspaceId = await sessionWorkspace(scope.workspaces.list, sessionId, signal)
          if (aborted()) return undefined
          return { absolutePath: metadata.value.absolutePath, version: metadata.value.version, workspaceId }
        })()
        requests.add(request)
        void request.then(() => { requests.delete(request) }, () => { requests.delete(request) })
        return request
      }
      const unregister = service.registerFileViewer({
        id: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/media', title: () => t('title'),
        exts: extensions, priority: 10, fetchStrategy: 'custom',
        load: async (path, address, hostSignal) => {
          const signal = hostSignal === undefined ? controller.signal : AbortSignal.any([controller.signal, hostSignal])
          // SessionScope.sessionId is the legacy plugin's string API input.
          const sessionId = address.sessionId as SessionId
          const reload = (nextSignal: AbortSignal): Promise<MediaFile | undefined> => read(path, sessionId, nextSignal)
          const file = await reload(signal)
          return new LegacyMediaLoad(++loadSequence, pathPartsOf(path).name, signal, file, reload)
        },
        component: ({ customData }) => {
          if (!(customData instanceof LegacyMediaLoad)) throw new Error('document-media: invalid legacy loader result')
          return <LegacyMediaBody key={customData.id} data={customData} t={t} />
        },
      })
      return async () => {
        unregister()
        controller.abort()
        await Promise.allSettled(requests)
      }
    }, 'document-media: legacy viewer')
  })
}
