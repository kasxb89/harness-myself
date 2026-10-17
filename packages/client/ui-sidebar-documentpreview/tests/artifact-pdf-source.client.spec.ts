/** Actual-stream byte limits and cancellation for authorized artifact PDF reads. */
import { afterEach, expect, it, vi } from 'vitest'
import { readArtifactPdf } from '../src/client/pdf/artifact-source.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('returns independent complete bytes from the authorized URL', async () => {
  const original = new Uint8Array([1, 2, 3])
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(original))
  vi.stubGlobal('fetch', fetcher)
  const signal = new AbortController().signal
  const bytes = await readArtifactPdf('/artifacts/api/raw?path=%2Freport.pdf&workspaceId=one', signal, 3)
  original.fill(9)
  expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
  expect(bytes.buffer).toBeInstanceOf(ArrayBuffer)
  expect(fetcher).toHaveBeenCalledWith('/artifacts/api/raw?path=%2Freport.pdf&workspaceId=one',
    { signal, headers: { accept: 'application/pdf' } })
})

it.each([undefined, '1', '20'])('rejects actual or advertised overflow with content-length %s and cancels its source', async (length) => {
  const cancel = vi.fn()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4])) },
    cancel,
  })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(stream,
    length === undefined ? undefined : { headers: { 'content-length': length } })))
  await expect(readArtifactPdf('/report.pdf', new AbortController().signal, 3)).rejects.toMatchObject({ code: 'tooLarge' })
  expect(cancel).toHaveBeenCalledOnce()
})

it('cancels an unsettled stream when the selected artifact leaves', async () => {
  const cancel = vi.fn()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }))))
  const controller = new AbortController()
  const read = readArtifactPdf('/report.pdf', controller.signal, 3)
  await Promise.resolve()
  controller.abort(new Error('Selected artifact changed'))
  await expect(read).rejects.toThrow('Selected artifact changed')
  expect(cancel).toHaveBeenCalledOnce()
})

it('keeps failed HTTP and transport diagnostics out of the user-visible failure code', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('private diagnostics', { status: 403 }))
    .mockRejectedValueOnce(new Error('private transport diagnostics'))
  vi.stubGlobal('fetch', fetcher)
  await expect(readArtifactPdf('/report.pdf', new AbortController().signal, 3)).rejects.toMatchObject({ code: 'sourceFailed' })
  await expect(readArtifactPdf('/report.pdf', new AbortController().signal, 3)).rejects.toMatchObject({ code: 'sourceFailed' })
})
