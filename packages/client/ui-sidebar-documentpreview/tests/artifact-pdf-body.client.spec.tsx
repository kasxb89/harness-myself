// @vitest-environment jsdom
/** Artifact PDFs share the mature PDF reader without fabricating Session or tab props. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { openPdf } from '../src/client/pdf/runtime.ts'
import type { renderPdfPage, PdfDocument } from '../src/client/pdf/document.ts'

const engine = vi.hoisted(() => ({ open: vi.fn<typeof openPdf>(), render: vi.fn<typeof renderPdfPage>() }))
vi.mock('../src/client/pdf/runtime.ts', () => ({ openPdf: engine.open }))
vi.mock('../src/client/pdf/document.ts', () => ({ renderPdfPage: engine.render }))
vi.mock('../src/client/pdf/text.ts', () => ({ pdfTextRenderer: () => () => ({ promise: Promise.resolve(), cancel() {} }) }))
import { ArtifactPdfBody, type ArtifactPdfBodyProps } from '../src/client/pdf/pdf.tsx'
import { ZoomViewport, zoomSurfaceClass } from '../src/client/zoom/ZoomViewport.tsx'
import { en } from '../src/client/pdf/locales.ts'
import { LoadingIndicator } from '../src/client/LoadingIndicator.tsx'

const loads: { document: ReturnType<typeof Promise.withResolvers<PdfDocument>>; dispose: ReturnType<typeof vi.fn> }[] = []
const fetcher = vi.fn<typeof fetch>()
const bytes = () => new Response(new Uint8Array([1, 2, 3]))
const props = (url = '/report.pdf'): ArtifactPdfBodyProps => ({
  url, name: 'report.pdf', maxBytes: 3, t: makeTranslate(en), ZoomViewport, zoomSurfaceClass,
} as ArtifactPdfBodyProps)
const loading = <LoadingIndicator label={en.loading} />

beforeEach(() => {
  loads.length = 0
  fetcher.mockReset().mockImplementation(async () => bytes())
  vi.stubGlobal('fetch', fetcher)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(124)
  const context: Pick<CanvasRenderingContext2D, 'drawImage'> = { drawImage: () => {} }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D)
  engine.open.mockReset().mockImplementation(() => {
    const document = Promise.withResolvers<PdfDocument>()
    const dispose = vi.fn(async () => {})
    loads.push({ document, dispose })
    return { document: document.promise, dispose }
  })
  engine.render.mockReset().mockImplementation(async (_document, _page, canvas, _signal, ratio) => {
    canvas.width = canvas.height = 100 * ratio
    return { width: 100, height: 100 }
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('loads bytes, renders every PDF page and retains component-local zoom', async () => {
  const view = render(<ArtifactPdfBody {...props()} loading={loading} />)
  expect(screen.getByRole('status', { name: en.loading })).toBeTruthy()
  await waitFor(() => { expect(engine.open).toHaveBeenCalledOnce() })
  await act(async () => { loads[0]?.document.resolve({ numPages: 2, getPage: vi.fn() }) })
  await waitFor(() => { expect(screen.getAllByRole('img')).toHaveLength(2) })
  expect(screen.getAllByRole('img').map(node => node.getAttribute('aria-label'))).toEqual(['PDF page 1', 'PDF page 2'])
  fireEvent.click(screen.getByRole('button', { name: 'Choose zoom' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '150%' }))
  expect((view.container.querySelector('[data-document-zoom-frame]') as HTMLElement).style.getPropertyValue('--document-zoom')).toBe('1.5')
  view.unmount()
  expect(engine.open.mock.calls[0]?.[1].aborted).toBe(true)
  expect(loads[0]?.dispose).toHaveBeenCalledOnce()
})

it('aborts stale artifact reads, ignores their late completion, and resets for the new source', async () => {
  const stale = Promise.withResolvers<Response>()
  fetcher.mockReturnValueOnce(stale.promise)
  const view = render(<ArtifactPdfBody {...props('/old.pdf')} loading={loading} />)
  const oldSignal = fetcher.mock.calls[0]?.[1]?.signal
  view.rerender(<ArtifactPdfBody {...props('/new.pdf')} loading={loading} />)
  expect(oldSignal?.aborted).toBe(true)
  await waitFor(() => { expect(engine.open).toHaveBeenCalledOnce() })
  await act(async () => { stale.resolve(bytes()) })
  expect(engine.open).toHaveBeenCalledOnce()
})

it('shows a safe retryable read failure and can recover without leaking transport details', async () => {
  fetcher.mockRejectedValueOnce(new Error('private host diagnostics'))
  render(<ArtifactPdfBody {...props()} loading={loading} />)
  expect((await screen.findByRole('alert')).textContent).toContain(en.sourceFailed)
  expect(screen.getByRole('alert').textContent).not.toContain('private host')
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  await waitFor(() => { expect(engine.open).toHaveBeenCalledOnce() })
})

it('reports the configured byte limit before starting a PDF worker', async () => {
  fetcher.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4])))
  render(<ArtifactPdfBody {...props()} loading={loading} />)
  expect((await screen.findByRole('alert')).textContent).toContain(en.tooLarge)
  expect(engine.open).not.toHaveBeenCalled()
})
