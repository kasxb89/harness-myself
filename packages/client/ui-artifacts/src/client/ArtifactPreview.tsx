/** Extension-driven previews; binary Office files never enter the text reader. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { appPath, CodeBlock, FileTypeIcon, MarkdownText, TextShimmer, languageForPath } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ArtifactEntry, ArtifactsInjected } from './ArtifactsPage.tsx'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { useVideoPoster } from './VideoPoster.tsx'
import { videoPosterKey, videoSourceUrl, type ReadVideoPoster } from './video-poster.ts'
import css from './ArtifactPreview.module.css'

const TEXT_PREVIEW_MAX_BYTES = 256 * 1024
const OFFICE = /\.(?:docx?|xlsx?|pptx?)$/iu
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt', 'md', 'markdown', 'mdx', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'conf',
  'config', 'xml', 'log', 'properties', 'ipynb', 'css', 'scss', 'less', 'sass', 'ts', 'tsx', 'js', 'jsx', 'mjs',
  'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash',
  'zsh', 'fish', 'sql', 'lua', 'vue', 'svelte', 'r', 'tex', 'srt', 'vtt', 'ass', 'bat', 'cmd', 'ps1',
])
type Translate = ArtifactsInjected['t']
type PreviewFailure = 'failed' | 'binary' | 'unavailable' | 'tooLarge' | 'invalid' | 'busy' | 'stale'
type PdfRender = { readonly renderSlot?: PropsRenderSlots<'artifacts.preview.pdf'>['renderSlot'] | undefined }
type PosterRead = { readonly readVideoPoster?: ReadVideoPoster | undefined }

function sourceUrl(entry: ArtifactEntry, route = 'raw'): string {
  return appPath(`/artifacts/api/${route}?path=${encodeURIComponent(entry.path)}${entry.workspaceId === undefined ? '' : `&workspaceId=${encodeURIComponent(entry.workspaceId)}`}`)
}

/** Relative Markdown images use the same file scope as their containing document. */
function markdownImage(entry: ArtifactEntry, value: string): string | undefined {
  const authored = value.replaceAll('\\', '/')
  const drivePath = /^[a-z]:\//iu.test(authored)
  if (authored.startsWith('//') || !drivePath && /^[a-z][a-z\d+.-]*:/iu.test(authored)) return undefined
  const parent = entry.path.replaceAll('\\', '/')
  const path = authored.startsWith('/') || drivePath ? authored : `${parent.slice(0, parent.lastIndexOf('/') + 1)}${authored}`
  return new URL(sourceUrl({ ...entry, path }), globalThis.location.href).href
}

/** Read a bounded prefix from the response, including when a file grows after listing. */
async function readText(response: Response, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  if (response.body === null) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      const remaining = TEXT_PREVIEW_MAX_BYTES - size
      chunks.push(chunk.value.subarray(0, remaining))
      size += Math.min(remaining, chunk.value.byteLength)
      if (chunk.value.byteLength > remaining) { truncated = true; break }
    }
  } finally {
    // Cancellation releases the underlying fetch when the preview only needs a prefix.
    if (truncated || signal.aborted) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  const text = new TextDecoder(encoding).decode(bytes)
  if (text.includes('\0')) throw new Error('binary')
  return { text, truncated }
}

function Notice({ entry, reason, t }: { entry: ArtifactEntry; reason: PreviewFailure | 'unsupported'; t: Translate }): ReactNode {
  return <div className={css.notice} role="status">
    <FileTypeIcon path={entry.name} size={36} />
    <p>{t(`preview.${reason}`)}</p>
  </div>
}

function TextPreview({ entry, t }: { entry: ArtifactEntry; t: Translate }): ReactNode {
  const [value, setValue] = useState<{ text: string; truncated: boolean } | null>(null)
  const [failure, setFailure] = useState<PreviewFailure | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setValue(null)
    setFailure(null)
    void fetch(sourceUrl(entry), { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('failed')
        return await readText(response, controller.signal)
      }).then((result) => { if (!controller.signal.aborted) setValue(result) })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setFailure(error instanceof Error && error.message === 'binary' ? 'binary' : 'failed')
      })
    return () => { controller.abort() }
  }, [entry.path, entry.workspaceId])
  const labels = useMemo(() => ({ code: { copyLabel: t('preview.copy'), copiedLabel: t('preview.copied') },
    footnotes: t('preview.footnotes') }), [t])
  if (failure !== null) return <Notice entry={entry} reason={failure} t={t} />
  if (value === null) return <TextShimmer active className={css.pending}>{t('loading')}</TextShimmer>
  return <div className={css.textPane}>
    {value.truncated && <p className={css.hint} role="status">{t('preview.truncated')}</p>}
    {/\.(?:md|markdown)$/iu.test(entry.name)
      ? <div className={css.markdown}><MarkdownText text={value.text} labels={labels}
        pathImages={{ resolve: path => markdownImage(entry, path) }} /></div>
      : <CodeBlock code={value.text} lang={languageForPath(entry.name) ?? 'text'} lineNumbers
        copyLabel={labels.code.copyLabel} copiedLabel={labels.code.copiedLabel} />}
  </div>
}

function MediaPreview({ entry, t, readVideoPoster }: { entry: ArtifactEntry; t: Translate } & PosterRead): ReactNode {
  const [failed, setFailed] = useState(false)
  const poster = useVideoPoster(entry, readVideoPoster, entry.kind === 'video')
  const player = useRef<HTMLVideoElement>(null)
  const version = videoPosterKey(entry)
  useEffect(() => {
    const video = player.current
    return () => {
      if (video === null) return
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [version])
  const url = sourceUrl(entry)
  if (failed) return <Notice entry={entry} reason="invalid" t={t} />
  if (entry.kind === 'image') return <img className={css.media} src={url} alt={entry.name} onError={() => { setFailed(true) }} />
  if (entry.kind === 'video') return <video key={version} ref={player} className={css.media} src={videoSourceUrl(entry)} controls preload="metadata"
    poster={poster.url} data-artifact-video-preview data-video-poster={poster.state} onError={() => { setFailed(true) }} />
  return <div className={css.audioPane}><FileTypeIcon path={entry.name} size={40} />
    <audio className={css.audio} src={url} controls onError={() => { setFailed(true) }} /></div>
}

function previewFailure(code: unknown): PreviewFailure {
  switch (code) {
    case 'preview-unavailable': return 'unavailable'
    case 'preview-too-large': return 'tooLarge'
    case 'preview-invalid': return 'invalid'
    case 'preview-busy': return 'busy'
    case 'preview-stale': return 'stale'
    default: return 'failed'
  }
}

function OfficePreview({ entry, t, renderSlot }: { entry: ArtifactEntry; t: Translate } & PdfRender): ReactNode {
  const [url, setUrl] = useState<string | null>(null)
  const [failure, setFailure] = useState<PreviewFailure | null>(null)
  const [missingFonts, setMissingFonts] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | undefined
    setUrl(null)
    setFailure(null)
    setMissingFonts(false)
    void fetch(sourceUrl(entry, 'preview'), { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) {
          const body: unknown = await response.json().catch(() => null)
          if (!controller.signal.aborted) setFailure(previewFailure(body !== null && typeof body === 'object' && 'code' in body ? body.code : null))
          return
        }
        if (response.headers.get('content-type')?.split(';', 1)[0] !== 'application/pdf') throw new Error('Invalid preview media type')
        // The Host converter applies its configured input, output, queue and deadline limits.
        const blob = await response.blob()
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setMissingFonts(Number(response.headers.get('x-artifact-preview-missing-fonts') ?? 0) > 0)
        setUrl(objectUrl)
      }).catch(() => { if (!controller.signal.aborted) setFailure('failed') })
    return () => { controller.abort(); if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl) }
  }, [entry.path, entry.workspaceId])
  if (failure !== null) return <Notice entry={entry} reason={failure} t={t} />
  if (url === null) return <TextShimmer active className={css.pending}>{t('preview.converting')}</TextShimmer>
  return <div className={css.documentPane}>
    {missingFonts && <p className={css.hint} role="status">{t('preview.fonts')}</p>}
    {renderSlot?.('artifacts.preview.pdf', { url, name: entry.name }, {
      entryKey: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/artifact-pdf',
      fallback: <Notice entry={entry} reason="unavailable" t={t} />,
    }) ?? <Notice entry={entry} reason="unavailable" t={t} />}
  </div>
}

/**
 * Preview one authorized artifact with an original-file download in every format.
 * @param props - Selected entry and locale-owned preview labels.
 * @returns Local previews without uploading the source to an external viewer.
 */
export function ArtifactPreview({ entry, t, renderSlot, readVideoPoster }: {
  entry: ArtifactEntry
  t: Translate
} & PdfRender & PosterRead): ReactNode {
  let body: ReactNode
  if (/\.(?:html?|svg)$/iu.test(entry.name)) body = <iframe className={css.frame} src={sourceUrl(entry)} title={entry.name} sandbox="" />
  else if (/\.pdf$/iu.test(entry.name)) {
    body = renderSlot?.('artifacts.preview.pdf', { url: sourceUrl(entry), name: entry.name }, {
      entryKey: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/artifact-pdf',
      fallback: <Notice entry={entry} reason="unavailable" t={t} />,
    }) ?? <Notice entry={entry} reason="unavailable" t={t} />
  } else if (OFFICE.test(entry.name)) body = <OfficePreview entry={entry} t={t} renderSlot={renderSlot} />
  else if (entry.kind === 'image' || entry.kind === 'video' || entry.kind === 'audio') {
    body = <MediaPreview entry={entry} t={t} readVideoPoster={readVideoPoster} />
  }
  else if (TEXT_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase())
    || /^(?:readme|license|notice|dockerfile|makefile)$/iu.test(entry.name)) body = <TextPreview entry={entry} t={t} />
  else body = <Notice entry={entry} reason="unsupported" t={t} />
  return <div className={css.surface}><div className={css.content}>{body}</div>
    <footer className={css.footer}><a href={`${sourceUrl(entry)}&download=1`} download={entry.name}>{t('preview.download')}</a></footer>
  </div>
}
