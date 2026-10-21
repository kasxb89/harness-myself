/**
 * Browse and manage artifacts through injected Host callbacks: choose where
 * future output saves, search retained roots, preview, rename, and recover
 * deleted files. Filters, selection, and form drafts belong to this page;
 * the plugin's apply lifetime owns the mutation lock and shell notices.
 * Cancellable reads keep previous data visible and discard stale responses.
 * The list and preview remain separate scrollable panes.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import {
  appPath,
  Button,
  FileTypeIcon,
  IconFolderOpenRegular,
  IconInspectOutlineRegular,
  IconRefreshOutlineRegular,
  IconEditOutlineRegular,
  IconSearchOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  Modal,
  Pill,
  TextShimmer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ArtifactErrorCode, ArtifactListing, ArtifactOrigin, ArtifactResult, ArtifactStorage, ArtifactWorkspace, RootDirectoryListing, TrashedArtifact, WorkspaceListing } from './api.ts'
import { ArtifactFinder } from './ArtifactFinder.tsx'
import { ArtifactChatLink } from './ArtifactChatLink.tsx'
import { ArtifactPreview } from './ArtifactPreview.tsx'
import { VideoThumbnail } from './VideoPoster.tsx'
import { VideoPosterPool, type ReadVideoPoster } from './video-poster.ts'
import css from './ArtifactsPage.module.css'

/** Artifact kinds the host derives from file extensions. */
export type ArtifactKind =
  | 'image' | 'video' | 'audio' | 'document' | 'sheet' | 'slides' | 'archive' | 'code' | 'text' | 'other'

/** One artifact as the host listing reports it. */
export interface ArtifactEntry {
  readonly path: string
  readonly name: string
  readonly kind: ArtifactKind
  readonly size: number
  readonly mtimeMs: number
  /** Present only for files explicitly authorized through a registered workspace. */
  readonly workspaceId?: string
}

/** What the plugin injects into the page. */
export interface ArtifactsInjected {
  /** Deployment-configured cadence for checking new files while this page is visible. */
  readonly pollIntervalMs: number
  /** Maximum time for a queued first-frame decode, including its browser media read. */
  readonly videoPosterTimeoutMs: number
  /** Translate one key of this plugin's namespace. */
  readonly t: (key: string, values?: Record<string, string>) => string
  /** Read operations belong to the mounted page and can be superseded. */
  readonly readListing: (signal: AbortSignal) => Promise<ArtifactResult<ArtifactListing>>
  readonly readStorage: (signal: AbortSignal) => Promise<ArtifactResult<ArtifactStorage>>
  readonly readTrash: (signal: AbortSignal) => Promise<ArtifactResult<readonly TrashedArtifact[]>>
  readonly readWorkspace: (
    workspaceId: string, directory: string, signal: AbortSignal, offset?: number,
  ) => Promise<ArtifactResult<WorkspaceListing>>
  readonly readRootDirectory: (
    root: string, directory: string, signal: AbortSignal, offset?: number,
  ) => Promise<ArtifactResult<RootDirectoryListing>>
  readonly readDesktop: () => Promise<boolean>
  readonly readOrigin: (entry: ArtifactEntry, signal: AbortSignal) => Promise<ArtifactResult<ArtifactOrigin | null>>
  /** Revalidate the selected source, load its history and switch to the exact generating Turn. */
  readonly returnToChat: (entry: ArtifactEntry) => Promise<ArtifactResult<null>>
  /** Mutations outlive the page, are never retried automatically, and publish shell notices. */
  readonly saveStorage: (directory: string, revision: number) => Promise<ArtifactResult<ArtifactStorage>>
  readonly rename: (entry: ArtifactEntry, name: string) => Promise<ArtifactResult<ArtifactEntry>>
  readonly trash: (entry: ArtifactEntry) => Promise<ArtifactResult<string>>
  readonly restore: (id: string) => Promise<ArtifactResult<ArtifactEntry>>
  readonly reveal: (path: string) => Promise<ArtifactResult<null>>
  /** Optional local desktop chooser; browsers retain the explicit path form. */
  readonly pickDirectory?: () => Promise<string | null>
}

/** Operations plus a stable revision of framework-owned conversation and workspace facts. */
export type ArtifactsPageProps = ArtifactsInjected & { active: boolean; refreshKey: string; workspaces: readonly ArtifactWorkspace[] }
  & PropsRenderSlots<'artifacts.preview.pdf'>

type FileDialog = { kind: 'rename' | 'trash'; entry: ArtifactEntry } | { kind: 'storage' }

const FILTERS: readonly (ArtifactKind | 'all')[] = [
  'all', 'image', 'video', 'document', 'sheet', 'slides', 'audio', 'archive', 'code', 'text', 'other',
]

/** Largest image the list decodes for a row thumbnail, in bytes. */
const THUMBNAIL_MAX_BYTES = 8 * 1024 * 1024

function entryKey(entry: ArtifactEntry): string {
  return JSON.stringify([entry.workspaceId ?? null, entry.path])
}

/** Raw URL for one artifact. */
function rawUrl(path: string, workspaceId?: string): string {
  return appPath(`/artifacts/api/raw?path=${encodeURIComponent(path)}${workspaceId === undefined ? '' : `&workspaceId=${encodeURIComponent(workspaceId)}`}`)
}

/** Human-readable size for one entry. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** Formatting time for one entry. */
function formatTime(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** One artifact's kind, size, and time on a single line. */
function metaLine(entry: ArtifactEntry, t: ArtifactsInjected['t']): string {
  return `${t(`kind.${entry.kind}`)} · ${formatSize(entry.size)} · ${formatTime(entry.mtimeMs)}`
}

/** Centered glyph plus one localized line: the page's empty and pending states. */
function Placeholder({ icon, text }: { icon: ReactNode; text: string }): ReactNode {
  return (
    <div className={css.placeholder}>
      <span className={css.placeholderGlyph}>{icon}</span>
      <p className={css.placeholderText}>{text}</p>
    </div>
  )
}

/** A filename, deletion, or future-output preference confirmed in one focused dialog. */
function ArtifactDialog({ request, storage, pending, uncertain, pickDirectory, submit, refresh, close, t }: {
  request: FileDialog
  storage: ArtifactStorage | null
  pending: boolean
  uncertain: boolean
  pickDirectory: ArtifactsInjected['pickDirectory']
  submit: (value: string) => Promise<ArtifactErrorCode | null>
  refresh: () => void
  close: () => void
  t: ArtifactsInjected['t']
}): ReactNode {
  const [draft, setDraft] = useState(request.kind === 'storage' ? storage?.directory ?? '' : request.entry.name)
  const [error, setError] = useState<ArtifactErrorCode | null>(null)
  const [picking, setPicking] = useState(false)
  const pickingRef = useRef(false)
  const submitting = useRef(false)
  const alive = useRef(true)
  const composing = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => { if (!uncertain && error === 'ARTIFACT_OPERATION_UNKNOWN') setError(null) }, [uncertain, error])
  const busy = pending || picking
  const invalid = request.kind !== 'trash' && draft.trim() === ''
  const confirm = (): void => {
    if (busy || submitting.current || uncertain || invalid) return
    submitting.current = true
    setError(null)
    void submit(draft.trim()).then((code) => { if (alive.current) setError(code) }).finally(() => { submitting.current = false })
  }
  const pick = (): void => {
    if (pickDirectory === undefined || busy || pickingRef.current) return
    pickingRef.current = true
    setPicking(true)
    setError(null)
    void pickDirectory().then((path) => {
      if (alive.current && path !== null) setDraft(path)
    }).catch(() => { if (alive.current) setError('ARTIFACT_STORAGE_UNAVAILABLE') }).finally(() => {
      pickingRef.current = false
      if (alive.current) setPicking(false)
    })
  }
  const title = t(request.kind === 'storage' ? 'storage.title' : request.kind === 'rename' ? 'rename.title' : 'trash.title')
  return (
    <Modal open title={title} closeLabel={t('close')} onClose={() => { if (!busy && !submitting.current) close() }}
      {...request.kind === 'storage' ? { description: t('storage.hint') }
        : request.kind === 'trash' ? { description: t('trash.confirm', { name: request.entry.name }) } : {}}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={close}>{t('cancel')}</Button>
          {(error !== null || uncertain) && <Button variant="outline" disabled={busy} onClick={refresh}>{t('refresh')}</Button>}
          <Button variant={request.kind === 'trash' ? 'outline' : 'primary'} className={request.kind === 'trash' ? css.danger : undefined}
            disabled={busy || uncertain || invalid} onClick={confirm} aria-busy={pending}>
            {t(request.kind === 'storage' ? 'save' : request.kind === 'rename' ? 'rename.action' : 'trash.action')}
          </Button>
        </>
      )}>
      {request.kind !== 'trash' && (
        <div className={css.form}>
          {request.kind === 'storage' && <p className={css.scopeLabel}>{t('storage.global')}</p>}
          <Input value={draft} aria-label={t(request.kind === 'storage' ? 'storage.path' : 'rename.name')}
            data-modal-autofocus disabled={busy} onFocus={(event) => { event.target.select() }}
            onChange={(event) => { setDraft(event.currentTarget.value); setError(null) }}
            onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !composing.current && !event.nativeEvent.isComposing
                && Reflect.get(event.nativeEvent, 'keyCode') !== 229) {
                event.preventDefault(); confirm()
              }
            }} />
          {request.kind === 'storage' && (
            <>
              <div className={css.formActions}>
                {pickDirectory !== undefined && <Button variant="outline" size="sm" disabled={busy} onClick={pick}>{t('storage.choose')}</Button>}
                {storage !== null && <Button size="sm" disabled={busy} onClick={() => { setDraft(storage.defaultDirectory); setError(null) }}>{t('storage.reset')}</Button>}
              </div>
              {storage !== null && <p className={css.hint}>{t('storage.original', { path: storage.defaultDirectory })}</p>}
            </>
          )}
        </div>
      )}
      {error !== null && <p className={css.formError} role="alert">{t(`error.${error}`)}</p>}
      {uncertain && error !== 'ARTIFACT_OPERATION_UNKNOWN' && <p className={css.formError} role="alert">{t('error.ARTIFACT_OPERATION_UNKNOWN')}</p>}
    </Modal>
  )
}

/**
 * Browse generated files in one library, including authorized workspace outputs.
 * @param props - Injected Host operations, copy, and framework-derived workspace facts.
 * @returns The artifact library with previews and recoverable file management.
 */
export function ArtifactsPage(props: ArtifactsPageProps): ReactNode {
  const { t, readListing, readStorage, readTrash, readDesktop } = props
  const [listing, setListing] = useState<ArtifactListing | null>(null)
  const [storage, setStorage] = useState<ArtifactStorage | null>(null)
  const [trash, setTrash] = useState<readonly TrashedArtifact[]>([])
  const [loading, setLoading] = useState(true)
  const [errors, setErrors] = useState<Partial<Record<'listing' | 'storage' | 'trash', ArtifactErrorCode>>>({})
  const [filter, setFilter] = useState<ArtifactKind | 'all'>('all')
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<string | null>(null)
  const [previewRevision, setPreviewRevision] = useState(0)
  const [dialog, setDialog] = useState<FileDialog | null>(null)
  const [finderOpen, setFinderOpen] = useState(false)
  const [discovered, setDiscovered] = useState<readonly { entry: ArtifactEntry; root?: string }[]>([])
  const [discoveredReset, setDiscoveredReset] = useState(false)
  const [pending, setPending] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [restoreError, setRestoreError] = useState<ArtifactErrorCode | null>(null)
  const [canReveal, setCanReveal] = useState(false)
  const [opening, setOpening] = useState(false)
  const alive = useRef(false)
  const isMounted = (): boolean => alive.current
  const request = useRef<AbortController | null>(null)
  const operation = useRef(false)
  const openingRequest = useRef(false)
  const generation = useRef(0)
  const posters = useRef<VideoPosterPool | null>(null)
  const readVideoPoster = useCallback<ReadVideoPoster>((entry, signal) => {
    if (signal.aborted) return Promise.resolve(null)
    posters.current ??= new VideoPosterPool(props.videoPosterTimeoutMs)
    return posters.current.read(entry, signal)
  }, [props.videoPosterTimeoutMs])
  useEffect(() => () => { posters.current?.dispose(); posters.current = null }, [props.videoPosterTimeoutMs])
  const discoveredNow = useRef<readonly ArtifactEntry[]>([])
  const roots = listing?.roots ?? []
  const retainedDiscovered = discovered.filter(item => item.entry.workspaceId === undefined
    ? item.root !== undefined && roots.includes(item.root)
    : props.workspaces.some(workspace => workspace.id === item.entry.workspaceId))
  discoveredNow.current = retainedDiscovered.map(item => item.entry)

  useEffect(() => {
    setDiscovered((previous) => {
      const retained = previous.filter(item => item.entry.workspaceId === undefined
        ? item.root !== undefined && roots.includes(item.root)
        : props.workspaces.some(workspace => workspace.id === item.entry.workspaceId))
      return retained.length === previous.length ? previous : retained
    })
    setDialog(previous => previous !== null && previous.kind !== 'storage' && previous.entry.workspaceId !== undefined
      && !props.workspaces.some(workspace => workspace.id === previous.entry.workspaceId) ? null : previous)
  }, [roots, props.workspaces])

  useEffect(() => {
    let disposed = false
    void readDesktop().then((value) => { if (!disposed) setCanReveal(value) }).catch(() => {})
    return () => { disposed = true }
  }, [readDesktop])

  const refresh = useCallback(async (explicit = false, background = false): Promise<ArtifactListing | null> => {
    if (operation.current || (background && request.current !== null)) return null
    request.current?.abort()
    const current = new AbortController()
    const revision = ++generation.current
    request.current = current
    if (!background) setLoading(true)
    try {
      const currentRead = (): boolean => alive.current && !current.signal.aborted && revision === generation.current
      const filesRead = readListing(current.signal)
        .catch(() => ({ ok: false as const, code: 'ARTIFACT_OPERATION_FAILED' as const }))
        .then((files) => {
          if (!currentRead()) return files
          if (files.ok) {
            const loaded = [...files.value.items, ...(explicit ? [] : discoveredNow.current)]
            if (explicit) {
              setDiscoveredReset(discoveredNow.current.some(entry => !files.value.items.some(item => entryKey(item) === entryKey(entry))))
              setDiscovered([])
            }
            setListing(files.value)
            if (explicit) setPreviewRevision(value => value + 1)
            setSelection(previous => loaded.some(entry => entryKey(entry) === previous) ? previous : null)
            setDialog((previous) => {
              if (previous === null || previous.kind === 'storage') return previous
              const entry = loaded.find(item => entryKey(item) === entryKey(previous.entry))
              return entry === undefined ? null : { ...previous, entry }
            })
          }
          // File cards become usable independently of slow recovery/preference reads.
          setLoading(false)
          return files
        })
      const storageRead = readStorage(current.signal)
        .catch(() => ({ ok: false as const, code: 'ARTIFACT_OPERATION_FAILED' as const }))
        .then((value) => { if (currentRead() && value.ok) setStorage(value.value); return value })
      const trashRead = readTrash(current.signal)
        .catch(() => ({ ok: false as const, code: 'ARTIFACT_OPERATION_FAILED' as const }))
        .then((value) => { if (currentRead() && value.ok) setTrash(value.value); return value })
      const [files, destination, deleted] = await Promise.all([filesRead, storageRead, trashRead])
      if (!currentRead()) return null
      const nextErrors: typeof errors = {}
      if (!files.ok) nextErrors.listing = files.code
      if (!destination.ok) nextErrors.storage = destination.code
      if (!deleted.ok) nextErrors.trash = deleted.code
      setErrors(nextErrors)
      if (explicit && Object.keys(nextErrors).length === 0 && files.ok && (files.value.issues?.length ?? 0) === 0) {
        setUncertain(false)
        setRestoreError(null)
      }
      return files.ok ? files.value : null
    } finally {
      if (request.current === current) {
        request.current = null
        if (alive.current) setLoading(false)
      }
    }
  }, [readListing, readStorage, readTrash])

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; request.current?.abort(); generation.current++ }
  }, [])

  // Read after conversation completion and workspace registration changes without a second event feed.
  useEffect(() => {
    if (props.active && document.visibilityState !== 'hidden') void refresh()
    else { request.current?.abort(); setLoading(false) }
  }, [refresh, props.refreshKey, props.active])

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const clear = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
    const schedule = (): void => {
      clear()
      if (!disposed && props.active && document.visibilityState !== 'hidden') timer = setTimeout(() => { void check() }, props.pollIntervalMs)
    }
    const check = async (): Promise<void> => {
      if (disposed || !props.active || document.visibilityState === 'hidden') return
      await refresh(false, true)
      schedule()
    }
    const foreground = (): void => {
      clear()
      if (!props.active || document.visibilityState === 'hidden') {
        request.current?.abort()
        setLoading(false)
      } else void check()
    }
    schedule()
    document.addEventListener('visibilitychange', foreground)
    window.addEventListener('focus', foreground)
    return () => {
      disposed = true
      clear()
      document.removeEventListener('visibilitychange', foreground)
      window.removeEventListener('focus', foreground)
    }
  }, [refresh, props.active, props.pollIntervalMs])

  /** Serialize mutations; a lost receipt requires an explicit successful library refresh. */
  const mutate = async <T,>(run: () => Promise<ArtifactResult<T>>): Promise<ArtifactResult<T>> => {
    if (operation.current || uncertain) return { ok: false, code: 'ARTIFACT_OPERATION_UNKNOWN' }
    operation.current = true
    setPending(true)
    request.current?.abort()
    generation.current++
    try {
      let result: ArtifactResult<T>
      try { result = await run() } catch (_error) { result = { ok: false, code: 'ARTIFACT_OPERATION_UNKNOWN' } }
      if (alive.current && !result.ok && result.code === 'ARTIFACT_OPERATION_UNKNOWN') setUncertain(true)
      return result
    } finally {
      operation.current = false
      if (alive.current) { setPending(false); setLoading(false) }
    }
  }

  const visibleFiles = [...new Map([...discoveredNow.current, ...(listing?.items ?? [])].map(entry => [entryKey(entry), entry])).values()]
    .filter(entry => entry.workspaceId === undefined || props.workspaces.some(workspace => workspace.id === entry.workspaceId))
  const remember = (entry: ArtifactEntry, root?: string): void => {
    setDiscoveredReset(false)
    setDiscovered(previous => [...previous.filter(item => entryKey(item.entry) !== entryKey(entry)),
      { entry, ...root === undefined ? {} : { root } }])
  }
  const replaceDiscovered = (before: ArtifactEntry, after: ArtifactEntry | null): void => {
    setDiscovered(previous => previous.flatMap(item => entryKey(item.entry) !== entryKey(before) ? [item]
      : after === null ? [] : [{ ...item, entry: after }]))
  }
  const updateFiles = (replace: (items: readonly ArtifactEntry[]) => readonly ArtifactEntry[]): void => {
    setListing(previous => previous === null ? null : { ...previous, items: replace(previous.items) })
  }
  const submitDialog = async (value: string): Promise<ArtifactErrorCode | null> => {
    const current = dialog
    if (current === null) return 'ARTIFACT_OPERATION_FAILED'
    if (current.kind === 'storage') {
      if (storage === null) return 'ARTIFACT_STORAGE_UNAVAILABLE'
      const result = await mutate(() => props.saveStorage(value, storage.revision))
      if (!alive.current) return null
      if (!result.ok) return result.code
      setStorage(result.value)
    } else if (current.kind === 'rename') {
      const result = await mutate(() => props.rename(current.entry, value))
      if (!alive.current) return null
      if (!result.ok) return result.code
      updateFiles(items => items.map(entry => entry.path === current.entry.path ? result.value : entry))
      replaceDiscovered(current.entry, result.value)
      setSelection(entryKey(result.value))
    } else {
      const result = await mutate(() => props.trash(current.entry))
      if (!alive.current) return null
      if (!result.ok) return result.code
      updateFiles(items => items.filter(entry => entry.path !== current.entry.path))
      replaceDiscovered(current.entry, null)
      setSelection(previous => previous === entryKey(current.entry) ? null : previous)
    }
    setDialog(null)
    void refresh()
    return null
  }

  const restore = async (item: TrashedArtifact): Promise<void> => {
    if (operation.current || uncertain) return
    setRestoreError(null)
    const result = await mutate(() => props.restore(item.id))
    if (!isMounted()) return
    if (!result.ok) { setRestoreError(result.code); return }
    setTrash(previous => previous.filter(entry => entry.id !== item.id))
    const refreshed = await refresh()
    if (!isMounted()) return
    const restored = result.value.workspaceId !== undefined ? result.value
      : refreshed?.items.find(entry => entry.path === result.value.path) ?? result.value
    const root = (refreshed?.roots ?? roots).find(candidate => restored.path.replaceAll('\\', '/')
      .startsWith(candidate.replaceAll('\\', '/').replace(/\/$/u, '') + '/'))
    if (restored.workspaceId !== undefined || root !== undefined) {
      remember(restored, root)
      setSelection(entryKey(restored))
    }
  }

  const reveal = async (entry: ArtifactEntry): Promise<void> => {
    if (openingRequest.current || pending) return
    openingRequest.current = true
    setOpening(true)
    try { await props.reveal(entry.path) }
    finally { openingRequest.current = false; if (alive.current) setOpening(false) }
  }
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const items = useMemo(() => visibleFiles.filter(entry => (filter === 'all' || entry.kind === filter)
    && (normalizedQuery === '' || `${entry.name}\n${entry.path}`.toLocaleLowerCase().includes(normalizedQuery))), [visibleFiles, filter, normalizedQuery])
  const counts = useMemo(() => {
    const map = new Map<ArtifactKind | 'all', number>()
    map.set('all', visibleFiles.length)
    for (const entry of visibleFiles) map.set(entry.kind, (map.get(entry.kind) ?? 0) + 1)
    return map
  }, [visibleFiles])
  const selected = visibleFiles.find(entry => entryKey(entry) === selection) ?? null
  useEffect(() => { posters.current?.retain(visibleFiles) }, [visibleFiles])
  const loaded = listing !== null
  const truncated = listing?.truncated === true

  return (
    <div className={css.page}>
      <header className={css.header}>
        <h1 className={css.title}>{t('title')}</h1>
        {loaded && <span className={css.count}>{t('count', { count: String(visibleFiles.length) })}</span>}
        <div className={css.headerActions}>
          {(truncated || discoveredReset) && <Button size="sm" variant="ghost" icon={<IconSearchOutlineRegular />} disabled={pending}
            aria-haspopup="dialog" aria-expanded={finderOpen} onClick={() => { setFinderOpen(true) }}>{t('finder.title')}</Button>}
          <Button size="sm" variant="ghost" icon={<IconFolderOpenRegular />} disabled={pending || uncertain || storage === null}
            aria-haspopup="dialog" aria-expanded={dialog?.kind === 'storage'}
            onClick={() => { setDialog({ kind: 'storage' }) }}>{t('storage.title')}</Button>
          <Button size="sm" variant="ghost" icon={<IconRefreshOutlineRegular />}
            onClick={() => { void refresh(true) }} disabled={loading || pending}>{t('refresh')}</Button>
        </div>
      </header>
      {[...new Set(Object.values(errors))].map(code => <p key={code} className={css.banner} data-tone="error" role="alert">{t(`error.${code}`)}</p>)}
      {listing?.issues !== undefined && listing.issues.length > 0 && <div className={css.sourceIssues} role="status"
        aria-label={t('source.issues')}>
        {listing.issues.map(issue => <p key={`${issue.workspaceId}:${issue.code}`} className={css.banner}>
          {t('source.issue', { name: issue.title })} {t(`error.${issue.code}`)}
        </p>)}
      </div>}
      {uncertain && <p className={css.banner} data-tone="error" role="alert">{t('error.ARTIFACT_OPERATION_UNKNOWN')}</p>}
      {discoveredReset && <p className={css.banner} role="status">{t('finder.refreshNotice')}</p>}
      <Input className={css.search ?? ''} icon={<IconSearchOutlineRegular />} type="search"
        aria-label={t('search')} placeholder={t('search')}
        value={query} onChange={(event) => { setQuery(event.currentTarget.value) }} />
      <nav className={css.filters} aria-label={t('filter')}>
        {FILTERS.map((kind) => {
          const count = counts.get(kind) ?? 0
          if (kind !== 'all' && kind !== filter && count === 0) return null
          return <Pill key={kind} active={kind === filter} onClick={() => { setFilter(kind) }}>
            {t(`kind.${kind}`)}<span className={css.filterCount}>{count}</span>
          </Pill>
        })}
      </nav>
      <div className={css.body}>
        <div className={css.listPane} aria-busy={loading}>
          {!loaded && loading && <TextShimmer active className={css.hint}>{t('loading')}</TextShimmer>}
          {loaded && visibleFiles.length === 0 && <Placeholder icon={<IconFolderOpenRegular size={28} />} text={t('empty')} />}
          {loaded && visibleFiles.length > 0 && items.length === 0
            && <Placeholder icon={<IconSearchOutlineRegular size={28} />} text={t('noResults')} />}
          {items.length > 0 && <ul className={css.rows}>
            {items.map(entry => <li key={entryKey(entry)}>
              <button type="button" className={selected !== null && entryKey(entry) === entryKey(selected) ? css.rowActive : css.row}
                onClick={() => { setSelection(entryKey(entry)) }}>
                {entry.kind === 'video' ? <VideoThumbnail entry={entry} read={readVideoPoster} /> : <span className={css.thumb}>
                  {entry.kind === 'image' && !/\.svg$/iu.test(entry.name) && entry.size <= THUMBNAIL_MAX_BYTES
                    ? <img className={css.thumbImage} src={rawUrl(entry.path, entry.workspaceId)} alt="" loading="lazy" /> : <FileTypeIcon path={entry.name} size={18} />}
                </span>}
                <span className={css.rowText}>
                  <span className={css.rowName}>{entry.name}</span><span className={css.rowMeta}>{metaLine(entry, t)}</span>
                </span>
              </button>
            </li>)}
          </ul>}
          {truncated && <p className={css.hint}>{t('truncated')}</p>}
        </div>
        <section className={css.preview} aria-label={t('preview')}>
          {selected === null ? <Placeholder icon={<IconInspectOutlineRegular size={28} />} text={t('previewHint')} /> : <>
            <header className={css.previewBar}>
              <div className={css.previewHeading}>
                <span className={css.previewName}>{selected.name}</span><span className={css.previewMeta}>{metaLine(selected, t)}</span>
                <details key={entryKey(selected)} className={css.fileLocation}>
                  <summary>{t('preview.location')}</summary>
                  <code className={css.storagePath}>{selected.path}</code>
                </details>
              </div>
              <div className={css.fileActions}>
                <ArtifactChatLink key={entryKey(selected)} entry={selected}
                  readOrigin={props.readOrigin} returnToChat={props.returnToChat} t={t} />
                {canReveal && <Button size="sm" disabled={pending || opening} onClick={() => { void reveal(selected) }}>{t('workspace.reveal')}</Button>}
                <Button size="sm" icon={<IconEditOutlineRegular />} disabled={pending || uncertain}
                  onClick={() => { setDialog({ kind: 'rename', entry: selected }) }}>{t('rename.action')}</Button>
                <Button size="sm" icon={<IconTrashOutlineRegular />} disabled={pending || uncertain}
                  onClick={() => { setDialog({ kind: 'trash', entry: selected }) }}>{t('trash.action')}</Button>
              </div>
            </header>
            <div className={css.previewBody}><ArtifactPreview
              key={`${entryKey(selected)}:${String(selected.size)}:${String(selected.mtimeMs)}:${String(previewRevision)}`}
              entry={selected} t={t} renderSlot={props.renderSlot} readVideoPoster={readVideoPoster} /></div>
          </>}
        </section>
      </div>
      <details className={css.trash}>
        <summary>{t('trash.section', { count: String(trash.length) })}</summary>
        {trash.length === 0 && !loading && <p className={css.hint}>{t('trash.empty')}</p>}
        {restoreError !== null && <p className={css.formError} role="alert">{t(`error.${restoreError}`)}</p>}
        {trash.length > 0 && <ul className={css.trashRows}>{trash.map(item => <li key={item.id} className={css.trashRow}>
          <div className={css.storageInfo}><span className={css.rowName}>{item.name}</span>
            <code className={css.trashPath}>{item.originalPath}</code></div>
          <Button variant="outline" size="sm" disabled={pending || uncertain} onClick={() => { void restore(item) }}>{t('trash.restore')}</Button>
        </li>)}</ul>}
      </details>
      {finderOpen && <ArtifactFinder roots={roots} workspaces={props.workspaces} readWorkspace={props.readWorkspace}
        readRootDirectory={props.readRootDirectory} t={t} close={() => { setFinderOpen(false) }} select={(entry, root) => {
          remember(entry, root); setSelection(entryKey(entry)); setQuery(''); setFilter('all'); setFinderOpen(false)
        }} />}
      {dialog !== null && <ArtifactDialog key={dialog.kind === 'storage' ? 'storage' : `${dialog.kind}:${dialog.entry.path}`}
        request={dialog} storage={storage} pending={pending} uncertain={uncertain} pickDirectory={props.pickDirectory}
        submit={submitDialog} refresh={() => { void refresh(true) }} close={() => { setDialog(null) }} t={t} />}
    </div>
  )
}
