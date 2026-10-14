/**
 * The Artifacts page: every file the configured roots hold, filtered by kind,
 * with an inline preview for the formats a browser can render.
 *
 * The page reads one JSON listing on mount and on demand; it keeps no
 * subscription and no cross-entry state, so it stays a plain presentation
 * component that happens to fetch. Layout is one list column and one preview
 * pane: every row carries a thumbnail or a file-type glyph, and the preview
 * pane owns its own header so the selected file stays named while its body
 * scrolls.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Button,
  FileTypeIcon,
  IconFolderOpenRegular,
  IconInspectOutlineRegular,
  IconRefreshOutlineRegular,
  Pill,
  TextShimmer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
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
}

type Listing =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly items: readonly ArtifactEntry[]; readonly truncated: boolean; readonly roots: readonly string[] }
  | { readonly status: 'error'; readonly message: string }

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
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        return await response.text()
      })
      .then(body => { setText(body) })
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => { controller.abort() }
  }, [url])
  if (failed) return <iframe className={css.frame} src={url} title={name} />
  if (text === null) {
    return <TextShimmer active className={css.placeholderText}>{t('loading')}</TextShimmer>
  }
  return <pre className={css.code}>{text}</pre>
}

/** Render one preview body for the selected artifact. */
function Preview({ entry, t }: { entry: ArtifactEntry; t: ArtifactsInjected['t'] }): ReactNode {
  const url = rawUrl(entry.path)
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
      : <iframe className={css.frame} src={url} title={entry.name} />
  }
  return (
    <div className={css.unsupported}>
      <FileTypeIcon path={entry.name} size={40} />
      <p className={css.placeholderText}>{t('unsupported')}</p>
      <code className={css.unsupportedPath}>{entry.path}</code>
    </div>
  )
}

export function ArtifactsPage(props: PropsRuntime<'main'> & ArtifactsInjected): ReactNode {
  const { t } = props
  const [listing, setListing] = useState<Listing>({ status: 'loading' })
  const [filter, setFilter] = useState<ArtifactKind | 'all'>('all')
  const [selected, setSelected] = useState<ArtifactEntry | null>(null)

  const load = useCallback(() => {
    setListing({ status: 'loading' })
    void fetch('/artifacts/api/list', { headers: { accept: 'application/json' } })
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        return await response.json() as { items: ArtifactEntry[]; truncated?: boolean; roots?: string[] }
      })
      .then(payload => {
        setListing({ status: 'ready', items: payload.items ?? [], truncated: payload.truncated === true, roots: payload.roots ?? [] })
      })
      .catch((error: unknown) => {
        setListing({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      })
  }, [])

  useEffect(() => { load() }, [load])

  const items = listing.status === 'ready'
    ? listing.items.filter(entry => filter === 'all' || entry.kind === filter)
    : []
  const counts = useMemo(() => {
    const map = new Map<ArtifactKind | 'all', number>()
    if (listing.status !== 'ready') return map
    map.set('all', listing.items.length)
    for (const entry of listing.items) map.set(entry.kind, (map.get(entry.kind) ?? 0) + 1)
    return map
  }, [listing])

  return (
    <div className={css.page}>
      <header className={css.header}>
        <h1 className={css.title}>{t('title')}</h1>
        {listing.status === 'ready' && (
          <span className={css.count}>{t('count', { count: String(listing.items.length) })}</span>
        )}
        <Button
          className={css.refresh}
          size="sm"
          variant="ghost"
          icon={<IconRefreshOutlineRegular />}
          onClick={load}
          disabled={listing.status === 'loading'}
        >
          {t('refresh')}
        </Button>
      </header>

      {listing.status === 'error' && (
        <p className={css.banner} data-tone="error" role="alert">
          {t('error', { message: listing.message })}
        </p>
      )}

      {listing.status !== 'error' && (
        <nav className={css.filters} aria-label={t('title')}>
          {FILTERS.map(kind => {
            const count = counts.get(kind) ?? 0
            if (kind !== 'all' && count === 0) return null
            return (
              <Pill
                key={kind}
                active={kind === filter}
                onClick={() => { setFilter(kind) }}
              >
                {t(`kind.${kind}`)}
                <span className={css.filterCount}>{count}</span>
              </Pill>
            )
          })}
        </nav>
      )}

      <div className={css.body}>
        <div className={css.listPane}>
          {listing.status === 'loading' && (
            <TextShimmer active className={css.hint}>{t('loading')}</TextShimmer>
          )}
          {listing.status === 'ready' && listing.items.length === 0 && (
            <Placeholder
              icon={<IconFolderOpenRegular size={28} />}
              text={listing.roots.length === 0 ? t('emptyRoots') : t('empty')}
            />
          )}
          {listing.status === 'ready' && items.length > 0 && (
            <ul className={css.rows}>
              {items.map(entry => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className={entry.path === selected?.path ? css.rowActive : css.row}
                    onClick={() => { setSelected(entry) }}
                    title={entry.path}
                  >
                    <span className={css.thumb}>
                      {entry.kind === 'image'
                        ? <img className={css.thumbImage} src={rawUrl(entry.path)} alt="" loading="lazy" />
                        : <FileTypeIcon path={entry.name} size={18} />}
                    </span>
                    <span className={css.rowText}>
                      <span className={css.rowName}>{entry.name}</span>
                      <span className={css.rowMeta}>{metaLine(entry, t)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {listing.status === 'ready' && listing.truncated && (
            <p className={css.hint}>{t('truncated', { count: String(listing.items.length) })}</p>
          )}
        </div>
        <section className={css.preview} aria-label={t('preview')}>
          {selected === null
            ? <Placeholder icon={<IconInspectOutlineRegular size={28} />} text={t('previewHint')} />
            : (
              <>
                <header className={css.previewBar}>
                  <span className={css.previewName} title={selected.path}>{selected.name}</span>
                  <span className={css.previewMeta}>{metaLine(selected, t)}</span>
                </header>
                <div className={css.previewBody}>
                  <Preview entry={selected} t={t} />
                </div>
              </>
            )}
        </section>
      </div>
    </div>
  )
}
