/**
 * Browse and manage artifacts through injected Host callbacks: choose where
 * future output saves, search retained roots, preview, rename, and recover
 * deleted files. Filters, selection, and form drafts belong to this page;
 * the plugin's apply lifetime owns the mutation lock and shell notices.
 * Cancellable reads keep previous data visible and discard stale responses.
 * The list and preview remain separate scrollable panes.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ArtifactErrorCode, ArtifactListing, ArtifactResult, ArtifactStorage, TrashedArtifact } from './api.ts'
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
}

/** What the plugin injects into the page. */
export interface ArtifactsInjected {
  /** Translate one key of this plugin's namespace. */
  readonly t: (key: string, values?: Record<string, string>) => string
  /** Read operations belong to the mounted page and can be superseded. */
  readonly readListing: (signal: AbortSignal) => Promise<ArtifactResult<ArtifactListing>>
  readonly readStorage: (signal: AbortSignal) => Promise<ArtifactResult<ArtifactStorage>>
  readonly readTrash: (signal: AbortSignal) => Promise<ArtifactResult<readonly TrashedArtifact[]>>
  /** Mutations outlive the page, are never retried automatically, and publish shell notices. */
  readonly saveStorage: (directory: string, revision: number) => Promise<ArtifactResult<ArtifactStorage>>
  readonly rename: (entry: ArtifactEntry, name: string) => Promise<ArtifactResult<ArtifactEntry>>
  readonly trash: (entry: ArtifactEntry) => Promise<ArtifactResult<string>>
  readonly restore: (id: string) => Promise<ArtifactResult<ArtifactEntry>>
  /** Optional local desktop chooser; browsers retain the explicit path form. */
  readonly pickDirectory?: () => Promise<string | null>
}

type FileDialog = { kind: 'rename' | 'trash'; entry: ArtifactEntry } | { kind: 'storage' }

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
function rawUrl(path: string): string {
  return `/artifacts/api/raw?path=${encodeURIComponent(path)}`
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
  const url = rawUrl(entry.path)
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
  const title = t(request.kind === 'storage' ? 'storage.change' : request.kind === 'rename' ? 'rename.title' : 'trash.title')
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

/** Browse, find, rename, and recover files while keeping future saves under explicit user control. */
export function ArtifactsPage(props: ArtifactsInjected): ReactNode {
  const { t, readListing, readStorage, readTrash } = props
  const [listing, setListing] = useState<ArtifactListing | null>(null)
  const [storage, setStorage] = useState<ArtifactStorage | null>(null)
  const [trash, setTrash] = useState<readonly TrashedArtifact[]>([])
  const [loading, setLoading] = useState(true)
  const [errors, setErrors] = useState<Partial<Record<'listing' | 'storage' | 'trash', ArtifactErrorCode>>>({})
  const [filter, setFilter] = useState<ArtifactKind | 'all'>('all')
  const [query, setQuery] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [dialog, setDialog] = useState<FileDialog | null>(null)
  const [pending, setPending] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [restoreError, setRestoreError] = useState<ArtifactErrorCode | null>(null)
  const alive = useRef(false)
  const request = useRef<AbortController | null>(null)
  const operation = useRef(false)
  const generation = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    request.current?.abort()
    const current = new AbortController()
    const revision = ++generation.current
    request.current = current
    setLoading(true)
    const [files, destination, deleted] = await Promise.all([
      readListing(current.signal).catch(() => ({ ok: false as const, code: 'ARTIFACT_OPERATION_FAILED' as const })),
      readStorage(current.signal).catch(() => ({ ok: false as const, code: 'ARTIFACT_OPERATION_FAILED' as const })),
      readTrash(current.signal).catch(() => ({ ok: false as const, code: 'ARTIFACT_OPERATION_FAILED' as const })),
    ])
    if (!alive.current || current.signal.aborted || revision !== generation.current) return
    const nextErrors: Partial<Record<'listing' | 'storage' | 'trash', ArtifactErrorCode>> = {}
    if (files.ok) {
      const value = files.value
      setListing(value)
      setSelectedPath(previous => value.items.some(entry => entry.path === previous) ? previous : null)
      setDialog(previous => previous === null || previous.kind === 'storage' ? previous
        : value.items.some(entry => entry.path === previous.entry.path)
          ? { ...previous, entry: value.items.find(entry => entry.path === previous.entry.path) as ArtifactEntry } : null)
    } else nextErrors.listing = files.code
    if (destination.ok) setStorage(destination.value)
    else nextErrors.storage = destination.code
    if (deleted.ok) setTrash(deleted.value)
    else nextErrors.trash = deleted.code
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length === 0) { setUncertain(false); setRestoreError(null) }
    setLoading(false)
  }, [readListing, readStorage, readTrash])

  useEffect(() => {
    alive.current = true
    void refresh()
    return () => { alive.current = false; request.current?.abort(); generation.current++ }
  }, [refresh])

  /** Serialize all mutations; a lost receipt blocks another attempt until a successful explicit refresh. */
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

  const submitDialog = async (value: string): Promise<ArtifactErrorCode | null> => {
    const current = dialog
    if (current === null) return 'ARTIFACT_REQUEST_INVALID'
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
      setListing(previous => previous === null ? null : { ...previous,
        items: previous.items.map(entry => entry.path === current.entry.path ? result.value : entry) })
      setSelectedPath(result.value.path)
    } else {
      const result = await mutate(() => props.trash(current.entry))
      if (!alive.current) return null
      if (!result.ok) return result.code
      setListing(previous => previous === null ? null : { ...previous,
        items: previous.items.filter(entry => entry.path !== current.entry.path) })
      setSelectedPath(previous => previous === current.entry.path ? null : previous)
    }
    setDialog(null)
    void refresh()
    return null
  }

  const restore = async (item: TrashedArtifact): Promise<void> => {
    if (operation.current || uncertain) return
    setRestoreError(null)
    const result = await mutate(() => props.restore(item.id))
    if (!alive.current) return
    if (!result.ok) { setRestoreError(result.code); return }
    setTrash(previous => previous.filter(entry => entry.id !== item.id))
    setListing(previous => previous === null ? null : { ...previous,
      items: [result.value, ...previous.items.filter(entry => entry.path !== result.value.path)] })
    setSelectedPath(result.value.path)
    void refresh()
  }

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const items = useMemo(() => (listing?.items ?? []).filter(entry =>
    (filter === 'all' || entry.kind === filter)
    && (normalizedQuery === '' || `${entry.name}\n${entry.path}`.toLocaleLowerCase().includes(normalizedQuery))), [listing, filter, normalizedQuery])
  const counts = useMemo(() => {
    const map = new Map<ArtifactKind | 'all', number>()
    map.set('all', listing?.items.length ?? 0)
    for (const entry of listing?.items ?? []) map.set(entry.kind, (map.get(entry.kind) ?? 0) + 1)
    return map
  }, [listing])
  const selected = listing?.items.find(entry => entry.path === selectedPath) ?? null

  return (
    <div className={css.page}>
      <header className={css.header}>
        <h1 className={css.title}>{t('title')}</h1>
        {listing !== null && <span className={css.count}>{t('count', { count: String(listing.items.length) })}</span>}
        <Button className={css.refresh} size="sm" variant="ghost" icon={<IconRefreshOutlineRegular />}
          onClick={() => { void refresh() }} disabled={loading || pending}>{t('refresh')}</Button>
      </header>
      <section className={css.storage} aria-label={t('storage.title')}>
        <div className={css.storageInfo}>
          <span className={css.storageLabel}>{t('storage.title')}</span>
          <code className={css.storagePath}>{storage?.directory ?? t(loading ? 'loading' : 'storage.unavailable')}</code>
          <span className={css.hint}>{t('storage.hint')}</span>
        </div>
        <Button variant="outline" size="sm" icon={<IconFolderOpenRegular />} disabled={pending || uncertain || storage === null}
          onClick={() => { setDialog({ kind: 'storage' }) }}>{t('storage.change')}</Button>
      </section>
      {[...new Set(Object.values(errors))].map(code => <p key={code} className={css.banner} data-tone="error" role="alert">{t(`error.${code}`)}</p>)}
      {uncertain && <p className={css.banner} data-tone="error" role="alert">{t('error.ARTIFACT_OPERATION_UNKNOWN')}</p>}
      <Input className={css.search ?? ''} icon={<IconSearchOutlineRegular />} type="search" aria-label={t('search')}
        placeholder={t('search')} value={query} onChange={(event) => { setQuery(event.currentTarget.value) }} />
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
          {listing === null && loading && <TextShimmer active className={css.hint}>{t('loading')}</TextShimmer>}
          {listing !== null && listing.items.length === 0 && <Placeholder icon={<IconFolderOpenRegular size={28} />} text={t('empty')} />}
          {listing !== null && listing.items.length > 0 && items.length === 0 && <Placeholder icon={<IconSearchOutlineRegular size={28} />} text={t('noResults')} />}
          {items.length > 0 && <ul className={css.rows}>
            {items.map(entry => <li key={entry.path}>
              <button type="button" className={entry.path === selectedPath ? css.rowActive : css.row}
                onClick={() => { setSelectedPath(entry.path) }} title={entry.path}>
                <span className={css.thumb}>
                  {entry.kind === 'image' && !/\.svg$/iu.test(entry.name) && entry.size <= THUMBNAIL_MAX_BYTES
                    ? <img className={css.thumbImage} src={rawUrl(entry.path)} alt="" loading="lazy" /> : <FileTypeIcon path={entry.name} size={18} />}
                </span>
                <span className={css.rowText}>
                  <span className={css.rowName}>{entry.name}</span>
                  <span className={css.rowMeta}>{metaLine(entry, t)}</span>
                </span>
              </button>
            </li>)}
          </ul>}
          {listing?.truncated === true && <p className={css.hint}>{t('truncated', { count: String(listing.items.length) })}</p>}
        </div>
        <section className={css.preview} aria-label={t('preview')}>
          {selected === null ? <Placeholder icon={<IconInspectOutlineRegular size={28} />} text={t('previewHint')} /> : <>
            <header className={css.previewBar}>
              <div className={css.previewHeading}>
                <span className={css.previewName} title={selected.path}>{selected.name}</span>
                <span className={css.previewMeta}>{metaLine(selected, t)}</span>
              </div>
              <div className={css.fileActions}>
                <Button size="sm" icon={<IconEditOutlineRegular />} disabled={pending || uncertain} onClick={() => { setDialog({ kind: 'rename', entry: selected }) }}>{t('rename.action')}</Button>
                <Button size="sm" icon={<IconTrashOutlineRegular />} disabled={pending || uncertain} onClick={() => { setDialog({ kind: 'trash', entry: selected }) }}>{t('trash.action')}</Button>
              </div>
            </header>
            <div className={css.previewBody}><Preview key={selected.path} entry={selected} t={t} /></div>
          </>}
        </section>
      </div>
      <details className={css.trash}>
        <summary>{t('trash.section', { count: String(trash.length) })}</summary>
        {trash.length === 0 && !loading && <p className={css.hint}>{t('trash.empty')}</p>}
        {restoreError !== null && <p className={css.formError} role="alert">{t(`error.${restoreError}`)}</p>}
        {trash.length > 0 && <ul className={css.trashRows}>{trash.map(item => <li key={item.id} className={css.trashRow}>
          <div className={css.storageInfo}>
            <span className={css.rowName}>{item.name}</span>
            <code className={css.trashPath}>{item.originalPath}</code>
          </div>
          <Button variant="outline" size="sm" disabled={pending || uncertain} onClick={() => { void restore(item) }}>{t('trash.restore')}</Button>
        </li>)}</ul>}
      </details>
      {dialog !== null && <ArtifactDialog key={dialog.kind === 'storage' ? 'storage' : `${dialog.kind}:${dialog.entry.path}`}
        request={dialog} storage={storage} pending={pending} uncertain={uncertain} pickDirectory={props.pickDirectory}
        submit={submitDialog} refresh={() => { void refresh() }} close={() => { setDialog(null) }} t={t} />}
    </div>
  )
}
