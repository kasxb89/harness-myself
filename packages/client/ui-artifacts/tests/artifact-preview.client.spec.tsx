// @vitest-environment jsdom
/** Selected-file previews keep local file access bounded and retain a download fallback. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactPreview } from '../src/client/ArtifactPreview.tsx'
import type { ArtifactEntry, ArtifactsInjected } from '../src/client/ArtifactsPage.tsx'
import { zh } from '../src/client/locales.ts'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'

type PdfRenderer = PropsRenderSlots<'artifacts.preview.pdf'>['renderSlot']
/** The generic dispatcher narrows its concrete PDF owner before rendering the test view. */
function pdfView(owner: object) {
  if (!('url' in owner) || typeof owner.url !== 'string' || !('name' in owner) || typeof owner.name !== 'string') {
    throw new Error('PDF reader requires a name and URL')
  }
  return <section aria-label={owner.name} data-preview-url={owner.url} />
}

const renderPdf: PdfRenderer = (_key, owner) => pdfView(owner)

/** Record concrete dispatches behind an adapter that preserves the generic renderSlot signature. */
function recordedPdfRenderer() {
  const dispatch = vi.fn<(key: string, owner: object, options?: object) => void>()
  const renderSlot: PdfRenderer = (key, owner, options) => {
    dispatch(key, owner, options)
    return pdfView(owner)
  }
  return { dispatch, renderSlot }
}

let createDescriptor: PropertyDescriptor | undefined
let revokeDescriptor: PropertyDescriptor | undefined
const create = vi.fn<(blob: Blob) => string>()
const revoke = vi.fn<(url: string) => void>()
const copy: Readonly<Record<string, string>> = zh
const t: ArtifactsInjected['t'] = (key, values) => (copy[key] ?? key).replace(/\{(\w+)\}/gu, (_match, name: string) => values?.[name] ?? '')

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  create.mockReset().mockImplementation(() => `blob:https://preview.invalid/${create.mock.calls.length}`)
  revoke.mockReset()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
})

afterEach(() => {
  try { cleanup() } finally {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (createDescriptor === undefined) Reflect.deleteProperty(URL, 'createObjectURL')
    else Object.defineProperty(URL, 'createObjectURL', createDescriptor)
    if (revokeDescriptor === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL')
    else Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor)
  }
})

/** A workspace file deliberately uses a Windows path and a group id requiring URL encoding. */
function file(name: string, kind: ArtifactEntry['kind'] = 'document'): ArtifactEntry {
  return { name, kind, path: `D:\\动漫项目\\输出\\${name}`, workspaceId: 'workspace:动漫', size: 8, mtimeMs: 0 }
}

/** PDF conversion returns bytes; the preview must not reinterpret Office files as text. */
function convertedPdf(headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('content-type', 'application/pdf')
  return new Response('%PDF-1.7\n%%EOF\n', { headers: responseHeaders })
}

/** The fallback always points at the original authorized workspace file. */
function expectDownload(entry: ArtifactEntry): void {
  const link = screen.getByRole<HTMLAnchorElement>('link', { name: zh['preview.download'] })
  const url = new URL(link.href)
  expect(url.pathname).toBe('/artifacts/api/raw')
  expect(url.searchParams.get('path')).toBe(entry.path)
  expect(url.searchParams.get('workspaceId')).toBe(entry.workspaceId)
  expect(url.searchParams.get('download')).toBe('1')
  expect(link.download).toBe(entry.name)
}

describe('Artifact preview formats and isolation', () => {
  it('keeps the document read, relative image and original download under the public mount', async () => {
    const base = document.createElement('base')
    base.href = new URL('/tools/dsh/', location.href).href
    document.head.append(base)
    try {
      const entry = file('剧情.md')
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('![剧情分镜](images/frame.png)'))
      vi.stubGlobal('fetch', fetcher)
      render(<ArtifactPreview entry={entry} t={t} renderSlot={renderPdf} />)
      const image = await screen.findByRole<HTMLImageElement>('img', { name: '剧情分镜' })
      const read = new URL(String(fetcher.mock.calls[0]?.[0]), location.href)
      const relativeImage = new URL(image.src)
      const download = new URL(screen.getByRole<HTMLAnchorElement>('link', { name: zh['preview.download'] }).href)
      for (const url of [read, relativeImage, download]) {
        expect(url.pathname).toBe('/tools/dsh/artifacts/api/raw')
        expect(url.searchParams.get('workspaceId')).toBe(entry.workspaceId)
      }
      expect(read.searchParams.get('path')).toBe(entry.path)
      expect(relativeImage.searchParams.get('path')).toBe('D:/动漫项目/输出/images/frame.png')
      expect(download.searchParams.get('path')).toBe(entry.path)
      expect(download.searchParams.get('download')).toBe('1')
    } finally { cleanup(); base.remove() }
  })

  it.each(['html', 'svg'])('loads %s through its native frame and preserves the workspace download', (extension) => {
    const entry = file(`preview.${extension}`, extension === 'svg' ? 'image' : 'document')
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetcher)
    render(<ArtifactPreview entry={entry} t={t} renderSlot={renderPdf} />)
    const frame = screen.getByTitle<HTMLIFrameElement>(entry.name)
    const url = new URL(frame.src)
    expect(url.pathname).toBe('/artifacts/api/raw')
    expect(url.searchParams.get('path')).toBe(entry.path)
    expect(url.searchParams.get('workspaceId')).toBe(entry.workspaceId)
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(fetcher).not.toHaveBeenCalled()
    expectDownload(entry)
  })

  it('dispatches a raw PDF to the keyed reader with its authorized workspace URL', () => {
    const entry = file('剧情.pdf')
    const fetcher = vi.fn<typeof fetch>()
    const { dispatch, renderSlot } = recordedPdfRenderer()
    vi.stubGlobal('fetch', fetcher)
    const { container } = render(<ArtifactPreview entry={entry} t={t} renderSlot={renderSlot} />)
    expect(dispatch).toHaveBeenCalledExactlyOnceWith('artifacts.preview.pdf', {
      url: `/artifacts/api/raw?path=${encodeURIComponent(entry.path)}&workspaceId=${encodeURIComponent(entry.workspaceId!)}`,
      name: entry.name,
    }, expect.objectContaining({ entryKey: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/artifact-pdf' }))
    expect(screen.getByRole('region', { name: entry.name })).toBeTruthy()
    expect(container.querySelector('iframe')).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
    expectDownload(entry)
  })

  it('renders Markdown headings even when the listing classifies the file as a document', async () => {
    const entry = file('剧情.md')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('# 第一幕\n\n人物对白与字幕。'))
    vi.stubGlobal('fetch', fetcher)
    render(<ArtifactPreview entry={entry} t={t} renderSlot={renderPdf} />)
    expect(await screen.findByRole('heading', { name: '第一幕', level: 1 })).toBeTruthy()
    expect(screen.getByText('人物对白与字幕。')).toBeTruthy()
    expect(fetcher).toHaveBeenCalledWith(`/artifacts/api/raw?path=${encodeURIComponent(entry.path)}&workspaceId=${encodeURIComponent(entry.workspaceId!)}`,
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }))
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expectDownload(entry)
  })

  it.each(['http://localhost/', 'dsh-app://app/'])('resolves Markdown images beside their workspace document under %s', async (base) => {
    vi.stubGlobal('location', new URL(base))
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('![剧情分镜](images/frame.png)')))
    render(<ArtifactPreview entry={file('剧情.md')} t={t} renderSlot={renderPdf} />)
    const image = await screen.findByRole<HTMLImageElement>('img', { name: '剧情分镜' })
    const url = new URL(image.src)
    expect(url.protocol).toBe(new URL(base).protocol)
    expect(url.host).toBe(new URL(base).host)
    expect(url.pathname).toBe('/artifacts/api/raw')
    expect(url.searchParams.get('path')).toBe('D:/动漫项目/输出/images/frame.png')
    expect(url.searchParams.get('workspaceId')).toBe('workspace:动漫')
  })

  it.each(['javascript:alert(1)', 'file:///tmp/graph.png', 'data:image/png;base64,AAAA',
    '//outside.example/tracking.png', 'dsh-app://app/artifacts/api/raw?path=%2Fprivate%2Fgraph.png',
    'dsh-app://app/assets/image.png'])('keeps an authored %s image inert instead of granting local file access', async (source) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(`![受限图片](${source})`)))
    const { container } = render(<ArtifactPreview entry={file('图片说明.md')} t={t} renderSlot={renderPdf} />)
    await screen.findByText('受限图片')
    expect(container.querySelector('img')).toBeNull()
    expectDownload(file('图片说明.md'))
  })

  it('renders a txt document as literal text rather than executing its markup', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('<script>window.stolen = true</script>')))
    const { container } = render(<ArtifactPreview entry={file('说明.txt')} t={t} renderSlot={renderPdf} />)
    await waitFor(() => { expect(container.querySelector('pre')?.textContent).toBe('<script>window.stolen = true</script>') })
    expect(container.querySelector('script')).toBeNull()
    expect(screen.queryByText(zh['preview.unsupported'])).toBeNull()
  })

  it('bounds the actual response stream even when the listing reports a small file', async () => {
    const prefix = '可预览内容\n'
    const prefixBytes = new TextEncoder().encode(prefix)
    const first = new Uint8Array(256 * 1024)
    first.fill(65)
    first.set(prefixBytes)
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(first); controller.enqueue(new TextEncoder().encode('UNREAD_TAIL_MARKER')) },
      cancel,
    })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)))
    const { container } = render(<ArtifactPreview entry={file('增长中的文件.txt')} t={t} renderSlot={renderPdf} />)
    await screen.findByText(zh['preview.truncated'])
    const content = container.querySelector('pre')?.textContent ?? ''
    expect(content.startsWith(prefix)).toBe(true)
    expect(new TextEncoder().encode(content)).toHaveLength(256 * 1024)
    expect(content).not.toContain('UNREAD_TAIL_MARKER')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('refuses embedded NUL bytes instead of displaying binary content as text', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([65, 0, 66]))))
    const entry = file('损坏的文本.txt')
    const { container } = render(<ArtifactPreview entry={entry} t={t} renderSlot={renderPdf} />)
    await screen.findByText(zh['preview.binary'])
    expect(container.querySelector('pre')).toBeNull()
    expectDownload(entry)
  })

  it.each(['zip', '7z', 'unknown'])('leaves %s files downloadable without fetching their binary bodies', (extension) => {
    const entry = file(`source.${extension}`, extension === 'unknown' ? 'other' : 'archive')
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetcher)
    render(<ArtifactPreview entry={entry} t={t} renderSlot={renderPdf} />)
    expect(screen.getByText(zh['preview.unsupported'])).toBeTruthy()
    expect(fetcher).not.toHaveBeenCalled()
    expectDownload(entry)
  })

  it.each([['png', 'image'], ['mp4', 'video'], ['mp3', 'audio']] as const)('retains an original-file fallback after a %s decoder error', (extension, kind) => {
    const entry = file(`unreadable.${extension}`, kind)
    const { container } = render(<ArtifactPreview entry={entry} t={t} renderSlot={renderPdf} />)
    const media = container.querySelector('img, video, audio')
    expect(media).not.toBeNull()
    fireEvent.error(media!)
    expect(screen.getByText(zh['preview.invalid'])).toBeTruthy()
    expect(container.querySelector('img, video, audio')).toBeNull()
    expectDownload(entry)
  })
})

describe('Artifact Office conversion', () => {
  it.each(['docx', 'xlsx', 'pptx'])('requests only a local PDF conversion for %s and releases its Blob URL on unmount', async (extension) => {
    const entry = file(`report.${extension}`)
    const response = convertedPdf()
    const text = vi.spyOn(response, 'text')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
    const { dispatch, renderSlot } = recordedPdfRenderer()
    vi.stubGlobal('fetch', fetcher)
    const { unmount } = render(<ArtifactPreview entry={entry} t={t} renderSlot={renderSlot} />)
    const reader = await screen.findByRole('region', { name: entry.name })
    expect(reader.getAttribute('data-preview-url')).toBe('blob:https://preview.invalid/1')
    expect(dispatch).toHaveBeenCalledWith('artifacts.preview.pdf', { url: 'blob:https://preview.invalid/1', name: entry.name },
      expect.objectContaining({ entryKey: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/artifact-pdf' }))
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/artifacts/api/preview?path=${encodeURIComponent(entry.path)}&workspaceId=${encodeURIComponent(entry.workspaceId!)}`,
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }))
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(text).not.toHaveBeenCalled()
    expect(create.mock.calls[0]?.[0].type).toBe('application/pdf')
    expectDownload(entry)
    unmount()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:https://preview.invalid/1')
  })

  it.each([
    [503, 'preview-unavailable', 'preview.unavailable'],
    [413, 'preview-too-large', 'preview.tooLarge'],
    [409, 'preview-stale', 'preview.stale'],
    [429, 'preview-busy', 'preview.busy'],
    [422, 'preview-invalid', 'preview.invalid'],
    [500, 'converter-internal-error', 'preview.failed'],
  ] as const)('shows safe localized recovery for conversion status %i', async (status, code, key) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code, message: '/private/converter/secret: internal failure' }),
      { status, headers: { 'content-type': 'application/json' } })))
    const entry = file('report.xlsx')
    render(<ArtifactPreview entry={entry} t={t} renderSlot={renderPdf} />)
    await screen.findByText(zh[key])
    expect(document.body.textContent).not.toContain('/private/converter/secret')
    expect(create).not.toHaveBeenCalled()
    expectDownload(entry)
  })

  it('warns when conversion substitutes unavailable fonts', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(convertedPdf({ 'x-artifact-preview-missing-fonts': '2' })))
    const entry = file('字体报告.docx')
    render(<ArtifactPreview entry={entry} t={t} renderSlot={renderPdf} />)
    await screen.findByRole('region', { name: entry.name })
    expect(screen.getByText(zh['preview.fonts'])).toBeTruthy()
    expectDownload(entry)
  })

  it('revokes the previous document URL when selection changes and aborts its request', async () => {
    const first = file('one.docx')
    const second = file('two.xlsx')
    const signals: (AbortSignal | null | undefined)[] = []
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => { signals.push(init?.signal); return convertedPdf() })
    vi.stubGlobal('fetch', fetcher)
    const { rerender, unmount } = render(<ArtifactPreview entry={first} t={t} renderSlot={renderPdf} />)
    await screen.findByRole('region', { name: first.name })
    rerender(<ArtifactPreview entry={second} t={t} renderSlot={renderPdf} />)
    await screen.findByRole('region', { name: second.name })
    await waitFor(() => { expect(create).toHaveBeenCalledTimes(2) })
    expect(signals[0]?.aborted).toBe(true)
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:https://preview.invalid/1')
    unmount()
    expect(signals[1]?.aborted).toBe(true)
    expect(revoke.mock.calls.map(([url]) => url)).toEqual(['blob:https://preview.invalid/1', 'blob:https://preview.invalid/2'])
  })

  it('does not allocate a Blob URL when a cancelled document body finishes late', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; controller.enqueue(new TextEncoder().encode('%PDF-1.7\n')) } })
    const response = new Response(stream, { headers: { 'content-type': 'application/pdf' } })
    const blob = vi.spyOn(response, 'blob')
    let signal: AbortSignal | null | undefined
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => { signal = init?.signal; return response }))
    const { unmount } = render(<ArtifactPreview entry={file('pending.pptx')} t={t} renderSlot={renderPdf} />)
    await waitFor(() => { expect(blob).toHaveBeenCalledOnce() })
    unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => { streamController.close(); await blob.mock.results[0]?.value })
    expect(create).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
  })
})
