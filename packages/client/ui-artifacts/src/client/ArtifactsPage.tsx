/**
 * Browse and manage artifacts through injected Host callbacks: choose where
 * future output saves, search retained roots, preview, rename, and recover
 * deleted files. Filters, selection, and form drafts belong to this page;
 * the plugin's apply lifetime owns the mutation lock and shell notices.
 * Cancellable reads keep previous data visible and discard stale responses.
 * The list and preview remain separate scrollable panes.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
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
  SegmentedTabs,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ArtifactErrorCode, ArtifactListing, ArtifactResult, ArtifactStorage, ArtifactWorkspace, TrashedArtifact, WorkspaceListing } from './api.ts'
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
  /** Translate one key of this plugin's namespace. */
  readonly t: (key: string, values?: Record<string, string>) => string
  /** Read operations belong to the mounted page and can be superseded. */
  readonly readListing: (signal: AbortSignal) => Promise<ArtifactResult<ArtifactListing>>
  readonly readStorage: (signal: AbortSignal) => Promise<ArtifactResult<ArtifactStorage>>
  readonly readTrash: (signal: AbortSignal) => Promise<ArtifactResult<readonly TrashedArtifact[]>>
  readonly readWorkspace: (workspaceId: string, directory: string, signal: AbortSignal) => Promise<ArtifactResult<WorkspaceListing>>
  readonly readDesktop: () => Promise<boolean>
  /** Mutations outlive the page, are never retried automatically, and publish shell notices. */
  readonly saveStorage: (directory: string, revision: number) => Promise<ArtifactResult<ArtifactStorage>>
  readonly rename: (entry: ArtifactEntry, name: string) => Promise<ArtifactResult<ArtifactEntry>>
  readonly trash: (entry: ArtifactEntry) => Promise<ArtifactResult<string>>
  readonly restore: (id: string) => Promise<ArtifactResult<ArtifactEntry>>
  readonly reveal: (path: string) => Promise<ArtifactResult<null>>
  /** Optional local desktop chooser; browsers retain the explicit path form. */
  readonly pickDirectory?: () => Promise<string | null>
}

/** Plain workspace projection derived by the framework-hook wrapper, never a second subscription. */
export interface ArtifactWorkspaceState {
  items: readonly ArtifactWorkspace[]
  currentWorkspaceId: string | null
  currentSessionKey: string | null
  ready: boolean
}

/** Operations plus workspace facts owned by the enclosing registered main panel. */
export type ArtifactsPageProps = ArtifactsInjected & { workspaces: ArtifactWorkspaceState }

type FileDialog = ({ kind: 'rename' | 'trash'; entry: ArtifactEntry } | { kind: 'storage' }) & { scope: string }

const FILTERS: readonly (ArtifactKind | 'all')[] = [
  'all', 'image', 'video', 'document', 'sheet', 'slides', 'audio', 'archive', 'code', 'text', 'other',
]

/** Kinds the page reads as text rather than handing to a frame. */
const TEXT_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>(['text', 'code', 'sheet'])

/**
 * Largest artifact the page reads into its own code surface, in bytes. Above
 * it the raw URL still renders, served by the frame instead of held in memory.
 */
const TEXT_PREVIEW_MAX_BYTES = 256 * 1024

/** Largest image the list decodes for a row thumbnail, in bytes. */
const THUMBNAIL_MAX_BYTES = 8 * 1024 * 1024

/** Raw URL for one artifact. */
function rawUrl(path: string, workspaceId?: string): string {
  return `/artifacts/api/raw?path=${encodeURIComponent(path)}${workspaceId === undefined ? '' : `&workspaceId=${encodeURIComponent(workspaceId)}`}`
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

/**
 * Read one text artifact onto the page's own code surface. The frame stays the
 * fallback: it is the only way to show a file the page declines to hold, and
 * the only way to show anything when the read fails.
 */
function TextPreview({ url, name, t }: { url: string; name: string; t: ArtifactsInjected['t'] }): ReactNode {
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setText(null)
    setFailed(false)
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        return await response.text()
      })
      .then((body) => { setText(body) })
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => { controller.abort() }
  }, [url])
  if (failed) return <iframe className={css.frame} src={url} title={name} sandbox="" />
  if (text === null) {
    return <TextShimmer active className={css.placeholderText}>{t('loading')}</TextShimmer>
  }
  return <pre className={css.code}>{text}</pre>
}

/** Render one preview body for the selected artifact. */
function Preview({ entry, t }: { entry: ArtifactEntry; t: ArtifactsInjected['t'] }): ReactNode {
  const url = rawUrl(entry.path, entry.workspaceId)
  if (/\.(?:html?|svg)$/iu.test(entry.name)) return <iframe className={css.frame} src={url} title={entry.name} sandbox="" />
  if (entry.kind === 'image') return <img className={css.media} src={url} alt={entry.name} />
  if (entry.kind === 'video') return <video className={css.media} src={url} controls />
  if (entry.kind === 'audio') {
    return (
      <div className={css.audioPane}>
        <FileTypeIcon path={entry.name} size={40} />
        <audio className={css.audio} src={url} controls />
      </div>
    )
  }
  if (TEXT_KINDS.has(entry.kind)) {
    return entry.size <= TEXT_PREVIEW_MAX_BYTES
      ? <TextPreview url={url} name={entry.name} t={t} />
      : <iframe className={css.frame} src={url} title={entry.name} sandbox="" />
  }
  return (
    <div className={css.unsupported}>
      <FileTypeIcon path={entry.name} size={40} />
      <p className={css.placeholderText}>{t('unsupported')}</p>
      <code className={css.unsupportedPath}>{entry.path}</code>
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
 * Browse managed output and explicitly selected workspace directories as separate file scopes.
 * @param props - Injected Host operations, copy, and framework-derived workspace facts.
 * @returns The file browser with scope-bound selection, preview, and recoverable mutations.
 */
export function ArtifactsPage(props: ArtifactsPageProps): ReactNode {
  const { t, readListing, readStorage, readTrash, readWorkspace, readDesktop } = props
  const tabId = useId()
  const [view, setView] = useState<'library' | 'workspace'>('library')
  const [workspaceId, setWorkspaceId] = useState<string | null>(props.workspaces.currentWorkspaceId)
  const [directory, setDirectory] = useState('')
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceListing | null>(null)
  const [listing, setListing] = useState<ArtifactListing | null>(null)
  const [storage, setStorage] = useState<ArtifactStorage | null>(null)
  const [trash, setTrash] = useState<readonly TrashedArtifact[]>([])
  const [loading, setLoading] = useState(true)
  const [errors, setErrors] = useState<Partial<Record<'listing' | 'storage' | 'trash' | 'workspace', ArtifactErrorCode>>>({})
  const [filter, setFilter] = useState<ArtifactKind | 'all'>('all')
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<{ scope: string; path: string } | null>(null)
  const [dialog, setDialog] = useState<FileDialog | null>(null)
  const [pending, setPending] = useState(false)
  const [uncertainSource, setUncertainSource] = useState<{
    view: 'library' | 'workspace'
    workspaceId: string | null
    workspacePath: string | null
    directory: string
    key: string
  } | null>(null)
  const [restoreError, setRestoreError] = useState<ArtifactErrorCode | null>(null)
  const [canReveal, setCanReveal] = useState(false)
  const [opening, setOpening] = useState(false)
  const alive = useRef(false)
  const request = useRef<AbortController | null>(null)
  const operation = useRef(false)
  const openingRequest = useRef(false)
  const generation = useRef(0)
  const currentSelection = useRef({ session: props.workspaces.currentSessionKey, workspace: props.workspaces.currentWorkspaceId })
  const selectedWorkspace = props.workspaces.items.find(item => item.id === workspaceId)
  const availableWorkspace = props.workspaces.ready && selectedWorkspace !== undefined
  const scope = view === 'library' ? 'library' : `workspace:${workspaceId ?? ''}:${directory}`
  const scopeNow = useRef(scope)
  scopeNow.current = scope
  const uncertain = uncertainSource !== null

  useEffect(() => {
    let disposed = false
    void readDesktop().then((value) => { if (!disposed) setCanReveal(value) }).catch(() => {})
    return () => { disposed = true }
  }, [readDesktop])

  // The current Session remains retained while this global panel occupies main.
  // A new conversation wins over a prior manual workspace choice; a removed registration cannot linger as a file scope.
  useEffect(() => {
    const next = { session: props.workspaces.currentSessionKey, workspace: props.workspaces.currentWorkspaceId }
    if (next.session !== currentSelection.current.session || next.workspace !== currentSelection.current.workspace) {
      currentSelection.current = next
      setWorkspaceId(next.workspace)
      setDirectory('')
    } else if (props.workspaces.ready && workspaceId !== null && !props.workspaces.items.some(item => item.id === workspaceId)) {
      setWorkspaceId(null)
      setDirectory('')
    }
  }, [props.workspaces, workspaceId])

  // Re-registering the same directory changes its id but does not make a lost receipt safe to retry.
  // Only a later explicit read of that directory can release the operation lock.
  useEffect(() => {
    setUncertainSource((previous) => {
      if (previous?.view !== 'workspace' || previous.workspacePath === null
        || props.workspaces.items.some(item => item.id === previous.workspaceId)) return previous
      const replacement = props.workspaces.items.find(item => item.path === previous.workspacePath)
      return replacement === undefined ? previous : { ...previous, workspaceId: replacement.id,
        key: `workspace:${replacement.id}:${previous.directory}` }
    })
  }, [props.workspaces.items, uncertainSource?.workspaceId, uncertainSource?.workspacePath])

  useEffect(() => { setSelection(null); setDialog(null); setQuery(''); setFilter('all') }, [scope])

  const refresh = useCallback(async (explicit = false): Promise<void> => {
    request.current?.abort()
    const current = new AbortController()
    const revision = ++generation.current
    request.current = current
    setLoading(true)
    const [files, destination, deleted, workspace] = await Promise.all([
      view === 'library' ? readListing(current.signal).catch(() => ({ ok: false as const, code: 'ARTIFACT_OPERATION_FAILED' as const }))
        : Promise.resolve(null),
      readStorage(current.signal).catch(() => ({ ok: false as const, code: 'ARTIFACT_OPERATION_FAILED' as const })),
      readTrash(current.signal).catch(() => ({ ok: false as const, code: 'ARTIFACT_OPERATION_FAILED' as const })),
      view === 'workspace' && workspaceId !== null && availableWorkspace
        ? readWorkspace(workspaceId, directory, current.signal).catch(() => ({ ok: false as const, code: 'ARTIFACT_OPERATION_FAILED' as const }))
        : Promise.resolve(null),
    ])
    if (!alive.current || current.signal.aborted || revision !== generation.current || scopeNow.current !== scope) return
    const nextErrors: typeof errors = {}
    const loaded = files?.ok === true ? files.value.items : workspace?.ok === true ? workspace.value.items : null
    if (files !== null) { if (files.ok) setListing(files.value); else nextErrors.listing = files.code }
    if (workspace !== null) {
      if (workspace.ok) setWorkspaceFiles(workspace.value)
      else {
        nextErrors.workspace = workspace.code
        if (workspace.code === 'ARTIFACT_WORKSPACE_UNAVAILABLE' || workspace.code === 'ARTIFACT_WORKSPACE_REMOTE_UNSUPPORTED') setWorkspaceFiles(null)
      }
    }
    if (loaded !== null) {
      setSelection(previous => previous?.scope !== scope ? previous : loaded.some(entry => entry.path === previous.path) ? previous : null)
      setDialog((previous) => {
        if (previous === null || previous.scope !== scope || previous.kind === 'storage') return previous
        const entry = loaded.find(item => item.path === previous.entry.path)
        return entry === undefined ? null : { ...previous, entry }
      })
    }
    if (destination.ok) setStorage(destination.value); else nextErrors.storage = destination.code
    if (deleted.ok) setTrash(deleted.value); else nextErrors.trash = deleted.code
    setErrors(nextErrors)
    if (explicit && Object.keys(nextErrors).length === 0) {
      setUncertainSource(previous => previous?.key === scope ? null : previous)
      setRestoreError(null)
    }
    setLoading(false)
  }, [readListing, readStorage, readTrash, readWorkspace, view, workspaceId, availableWorkspace, directory, scope])

  useEffect(() => {
    alive.current = true
    void refresh()
    return () => { alive.current = false; request.current?.abort(); generation.current++ }
  }, [refresh])

  /** Serialize mutations and require inspecting their original scope if a receipt is lost. */
  const mutate = async <T,>(run: () => Promise<ArtifactResult<T>>): Promise<ArtifactResult<T>> => {
    if (operation.current || uncertain) return { ok: false, code: 'ARTIFACT_OPERATION_UNKNOWN' }
    const origin = { view, workspaceId, workspacePath: selectedWorkspace?.path ?? null, directory, key: scope }
    operation.current = true
    setPending(true)
    request.current?.abort()
    generation.current++
    try {
      let result: ArtifactResult<T>
      try { result = await run() } catch (_error) { result = { ok: false, code: 'ARTIFACT_OPERATION_UNKNOWN' } }
      if (alive.current && !result.ok && result.code === 'ARTIFACT_OPERATION_UNKNOWN') setUncertainSource(origin)
      return result
    } finally {
      operation.current = false
      if (alive.current) { setPending(false); setLoading(false) }
    }
  }

  const currentDirectory = view === 'workspace' && workspaceFiles?.workspace.id === workspaceId && workspaceFiles.directory === directory
    && availableWorkspace ? workspaceFiles : null
  const visibleFiles = view === 'library' ? listing?.items ?? [] : currentDirectory?.items ?? []
  const visibleDirectories = view === 'workspace' ? currentDirectory?.directories ?? [] : []
  const updateFiles = (replace: (items: readonly ArtifactEntry[]) => readonly ArtifactEntry[]): void => {
    if (view === 'library') setListing(previous => previous === null ? null : { ...previous, items: replace(previous.items) })
    else setWorkspaceFiles(previous => previous === null ? null : { ...previous, items: replace(previous.items) })
  }
  const submitDialog = async (value: string): Promise<ArtifactErrorCode | null> => {
    const current = dialog
    if (current === null || current.scope !== scopeNow.current) return 'ARTIFACT_WORKSPACE_UNAVAILABLE'
    if (current.kind === 'storage') {
      if (storage === null) return 'ARTIFACT_STORAGE_UNAVAILABLE'
      const result = await mutate(() => props.saveStorage(value, storage.revision))
      if (!alive.current || current.scope !== scopeNow.current) return null
      if (!result.ok) return result.code
      setStorage(result.value)
    } else if (current.kind === 'rename') {
      const result = await mutate(() => props.rename(current.entry, value))
      if (!alive.current || current.scope !== scopeNow.current) return null
      if (!result.ok) return result.code
      updateFiles(items => items.map(entry => entry.path === current.entry.path ? result.value : entry))
      setSelection({ scope, path: result.value.path })
    } else {
      const result = await mutate(() => props.trash(current.entry))
      if (!alive.current || current.scope !== scopeNow.current) return null
      if (!result.ok) return result.code
      updateFiles(items => items.filter(entry => entry.path !== current.entry.path))
      setSelection(previous => previous?.path === current.entry.path ? null : previous)
    }
    setDialog(null)
    void refresh()
    return null
  }

  const restore = async (item: TrashedArtifact): Promise<void> => {
    if (operation.current || uncertain) return
    const originalScope = scope
    setRestoreError(null)
    const result = await mutate(() => props.restore(item.id))
    if (!alive.current) return
    if (!result.ok) { setRestoreError(result.code); return }
    setTrash(previous => previous.filter(entry => entry.id !== item.id))
    if (scopeNow.current !== originalScope) return
    if (view === 'library' || result.value.workspaceId === workspaceId) {
      updateFiles(items => [result.value, ...items.filter(entry => entry.path !== result.value.path)])
      setSelection({ scope, path: result.value.path })
    }
    void refresh()
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
  const directories = visibleDirectories.filter(item => normalizedQuery === ''
    || `${item.name}\n${item.directory}`.toLocaleLowerCase().includes(normalizedQuery))
  const counts = useMemo(() => {
    const map = new Map<ArtifactKind | 'all', number>()
    map.set('all', visibleFiles.length)
    for (const entry of visibleFiles) map.set(entry.kind, (map.get(entry.kind) ?? 0) + 1)
    return map
  }, [visibleFiles])
  const selected = selection?.scope === scope ? visibleFiles.find(entry => entry.path === selection.path) ?? null : null
  const breadcrumbs = currentDirectory === null ? [] : currentDirectory.directory.split('/').filter(Boolean)
  const title = selectedWorkspace?.title || selectedWorkspace?.path || ''
  const loaded = view === 'library' ? listing !== null : currentDirectory !== null
  const truncated = view === 'library' ? listing?.truncated === true : currentDirectory?.truncated === true

  return (
    <div className={css.page}>
      <header className={css.header}>
        <h1 className={css.title}>{t('title')}</h1>
        {loaded && <span className={css.count}>{t(view === 'library' ? 'count' : 'workspace.count', {
          count: String(visibleFiles.length), folders: String(visibleDirectories.length),
        })}</span>}
        <div className={css.headerActions}>
          <Button size="sm" variant="ghost" icon={<IconFolderOpenRegular />} disabled={pending || uncertain || storage === null}
            aria-haspopup="dialog" aria-expanded={dialog?.kind === 'storage'}
            onClick={() => { setDialog({ kind: 'storage', scope }) }}>{t('storage.title')}</Button>
          <Button size="sm" variant="ghost" icon={<IconRefreshOutlineRegular />}
            onClick={() => { void refresh(true) }} disabled={loading || pending}>{t('refresh')}</Button>
        </div>
      </header>
      <SegmentedTabs value={view} label={t('scope.title')}
        items={[{ value: 'library', label: t('scope.library'), id: `${tabId}-library`, panelId: `${tabId}-library-panel` },
          { value: 'workspace', label: t('scope.workspace'), id: `${tabId}-workspace`, panelId: `${tabId}-workspace-panel` }]}
        onChange={setView} />
      <p className={css.locationHint}>{t('scope.hint')}</p>
      {view === 'workspace' && <section className={css.workspaceScope} aria-label={t('workspace.scope')}>
        <label className={css.workspaceSelect}>
          <span>{t('workspace.choose')}</span>
          <select aria-label={t('workspace.choose')} value={selectedWorkspace?.id ?? ''} disabled={!props.workspaces.ready || pending}
            onChange={(event) => { setWorkspaceId(event.currentTarget.value || null); setDirectory('') }}>
            <option value="">{t(props.workspaces.ready ? 'workspace.chooseHint' : 'workspace.loading')}</option>
            {props.workspaces.items.map(item => <option key={item.id} value={item.id}>{item.title || item.path}</option>)}
          </select>
        </label>
        {selectedWorkspace !== undefined && <code className={css.storagePath}>{selectedWorkspace.path}</code>}
        {currentDirectory !== null && <>
          <nav className={css.breadcrumbs} aria-label={t('workspace.breadcrumb')}>
            {currentDirectory.parentDirectory !== null && <Button size="sm" disabled={pending}
              onClick={() => { setDirectory(currentDirectory.parentDirectory ?? '') }}>{t('workspace.parent')}</Button>}
            <Button size="sm" disabled={pending} onClick={() => { setDirectory('') }}>{title}</Button>
            {breadcrumbs.map((part, index) => <Button key={`${String(index)}:${part}`} size="sm" disabled={pending}
              onClick={() => { setDirectory(breadcrumbs.slice(0, index + 1).join('/')) }}>{part}</Button>)}
          </nav>
          <code className={css.storagePath}>{currentDirectory.absoluteDirectory}</code>
        </>}
      </section>}
      {[...new Set(Object.values(errors))].map(code => <p key={code} className={css.banner} data-tone="error" role="alert">{t(`error.${code}`)}</p>)}
      {uncertainSource !== null && <div className={css.banner} data-tone="error" role="alert">
        {t('error.ARTIFACT_OPERATION_UNKNOWN')}
        {uncertainSource.key !== scope && <Button size="sm" onClick={() => {
          setView(uncertainSource.view); setWorkspaceId(uncertainSource.workspaceId); setDirectory(uncertainSource.directory)
        }}>{t('scope.inspectUncertain')}</Button>}
      </div>}
      <Input className={css.search ?? ''} icon={<IconSearchOutlineRegular />} type="search"
        aria-label={t(view === 'library' ? 'search' : 'workspace.search')} placeholder={t(view === 'library' ? 'search' : 'workspace.search')}
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
      <div className={css.body} role="tabpanel" id={`${tabId}-${view}-panel`} aria-labelledby={`${tabId}-${view}`}>
        <div className={css.listPane} aria-busy={loading}>
          {!loaded && loading && <TextShimmer active className={css.hint}>{t('loading')}</TextShimmer>}
          {view === 'workspace' && !availableWorkspace && !loading && <Placeholder icon={<IconFolderOpenRegular size={28} />} text={t('workspace.selectFirst')} />}
          {loaded && visibleFiles.length === 0 && visibleDirectories.length === 0 && <div className={css.emptyPane}>
            <Placeholder icon={<IconFolderOpenRegular size={28} />} text={t(view === 'library' ? 'empty' : 'workspace.empty')} />
            {view === 'library' && <Button variant="outline" size="sm" onClick={() => { setView('workspace') }}>{t('workspace.viewFiles')}</Button>}
          </div>}
          {loaded && (visibleFiles.length > 0 || visibleDirectories.length > 0) && items.length === 0 && directories.length === 0
            && <Placeholder icon={<IconSearchOutlineRegular size={28} />} text={t('noResults')} />}
          {(items.length > 0 || directories.length > 0) && <ul className={css.rows}>
            {directories.map(folder => <li key={`directory:${folder.directory}`}>
              <button type="button" className={css.row} disabled={pending} onClick={() => { setDirectory(folder.directory) }}
                aria-label={t('workspace.openDirectory', { name: folder.name })}>
                <span className={css.thumb}><IconFolderOpenRegular size={18} /></span>
                <span className={css.rowText}><span className={css.rowName}>{folder.name}</span></span>
              </button>
            </li>)}
            {items.map(entry => <li key={entry.path}>
              <button type="button" className={entry.path === selected?.path ? css.rowActive : css.row}
                onClick={() => { setSelection({ scope, path: entry.path }) }}>
                <span className={css.thumb}>
                  {entry.kind === 'image' && !/\.svg$/iu.test(entry.name) && entry.size <= THUMBNAIL_MAX_BYTES
                    ? <img className={css.thumbImage} src={rawUrl(entry.path, entry.workspaceId)} alt="" loading="lazy" /> : <FileTypeIcon path={entry.name} size={18} />}
                </span>
                <span className={css.rowText}>
                  <span className={css.rowName}>{entry.name}</span><span className={css.rowMeta}>{metaLine(entry, t)}</span>
                </span>
              </button>
            </li>)}
          </ul>}
          {truncated && <p className={css.hint}>{t('truncated', { count: String(visibleFiles.length) })}</p>}
        </div>
        <section className={css.preview} aria-label={t('preview')}>
          {selected === null ? <Placeholder icon={<IconInspectOutlineRegular size={28} />} text={t('previewHint')} /> : <>
            <header className={css.previewBar}>
              <div className={css.previewHeading}>
                <span className={css.previewName}>{selected.name}</span><span className={css.previewMeta}>{metaLine(selected, t)}</span>
                <code className={css.storagePath}>{selected.path}</code>
              </div>
              <div className={css.fileActions}>
                {canReveal && <Button size="sm" disabled={pending || opening} onClick={() => { void reveal(selected) }}>{t('workspace.reveal')}</Button>}
                <Button size="sm" icon={<IconEditOutlineRegular />} disabled={pending || uncertain}
                  onClick={() => { setDialog({ kind: 'rename', entry: selected, scope }) }}>{t('rename.action')}</Button>
                <Button size="sm" icon={<IconTrashOutlineRegular />} disabled={pending || uncertain}
                  onClick={() => { setDialog({ kind: 'trash', entry: selected, scope }) }}>{t('trash.action')}</Button>
              </div>
            </header>
            <div className={css.previewBody}><Preview key={`${scope}:${selected.path}`} entry={selected} t={t} /></div>
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
      {dialog !== null && dialog.scope === scope && <ArtifactDialog key={dialog.kind === 'storage' ? 'storage' : `${dialog.kind}:${dialog.entry.path}`}
        request={dialog} storage={storage} pending={pending} uncertain={uncertain} pickDirectory={props.pickDirectory}
        submit={submitDialog} refresh={() => { void refresh(true) }} close={() => { setDialog(null) }} t={t} />}
    </div>
  )
}
