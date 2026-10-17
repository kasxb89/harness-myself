// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ERROR_CODES, readArtifacts, readStorage, readTrash, renameArtifact, restoreArtifact, saveStorage, trashArtifact,
} from '../src/client/api.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { vi.unstubAllGlobals() })

const item = { path: '/产物/动漫.png', name: '动漫.png', kind: 'image', size: 128, mtimeMs: 1234 }
const storage = { directory: '/产物', defaultDirectory: '/初始', revision: 1, roots: ['/产物', '/旧产物'] }

/** Record same-origin transport without opening sockets or reading local files. */
function respond(value: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(value, { status }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('artifact management HTTP boundary', () => {
  it('reads listing, storage preference, and persistent recovery inventory with cancellation and no cache', async () => {
    const fetch = respond({ items: [item], roots: ['/产物'], truncated: false })
    const controller = new AbortController()
    expect(await readArtifacts(controller.signal)).toEqual({ ok: true, value: { items: [item], roots: ['/产物'], truncated: false } })
    expect(fetch).toHaveBeenLastCalledWith('/artifacts/api/list', expect.objectContaining({ method: 'GET', signal: controller.signal, cache: 'no-store', credentials: 'same-origin' }))
    fetch.mockResolvedValueOnce(Response.json(storage))
    expect(await readStorage(controller.signal)).toEqual({ ok: true, value: storage })
    fetch.mockResolvedValueOnce(Response.json({ items: [{ id: 'trash-1', name: item.name, originalPath: item.path, deletedAt: '2026-10-17T04:00:00Z' }] }))
    expect(await readTrash(controller.signal)).toEqual({ ok: true, value: [{ id: 'trash-1', name: item.name, originalPath: item.path, deletedAt: '2026-10-17T04:00:00Z' }] })
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/artifacts/api/list', '/artifacts/api/storage', '/artifacts/api/trash'])
  })

  it('sends the selected directory revision and file fingerprint rather than replacing arbitrary files', async () => {
    const fetch = respond(storage)
    const signal = new AbortController().signal
    expect(await saveStorage('/新目录', 7, signal)).toEqual({ ok: true, value: storage })
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ directory: '/新目录', expectedRevision: 7 })
    fetch.mockResolvedValueOnce(Response.json({ item }))
    const expected = { size: 128, mtimeMs: 1234 }
    expect(await renameArtifact(item.path, '新名称.png', expected, signal)).toEqual({ ok: true, value: item })
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({ path: item.path, name: '新名称.png', expected })
    fetch.mockResolvedValueOnce(Response.json({ trashId: 'trash-1' }))
    expect(await trashArtifact(item.path, expected, signal)).toEqual({ ok: true, value: 'trash-1' })
    expect(JSON.parse(fetch.mock.calls[2]![1]!.body as string)).toEqual({ path: item.path, expected })
    fetch.mockResolvedValueOnce(Response.json({ item }))
    expect(await restoreArtifact('trash-1', signal)).toEqual({ ok: true, value: item })
    expect(JSON.parse(fetch.mock.calls[3]![1]!.body as string)).toEqual({ id: 'trash-1' })
    for (const [, init] of fetch.mock.calls) {
      expect(init).toEqual(expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store', signal }))
      expect(new Headers(init!.headers).get('content-type')).toBe('application/json')
    }
  })

  it.each(ERROR_CODES)('maps %s to product-owned copy and excludes server exception details', async (code) => {
    respond({ code, message: 'private Host stack /Users/private/session.json', stack: 'secret diagnostic' }, 409)
    const result = await renameArtifact(item.path, 'new.png', item, new AbortController().signal)
    expect(result).toEqual({ ok: false, code })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(zh[`error.${code}`]).toBeTruthy()
    expect(en[`error.${code}`]).toBeTruthy()
  })

  it('treats a missing mutation receipt as unknown and does not retry the POST', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('private network failure'))
    vi.stubGlobal('fetch', fetch)
    expect(await trashArtifact(item.path, item, new AbortController().signal)).toEqual({ ok: false, code: 'ARTIFACT_OPERATION_UNKNOWN' })
    expect(fetch).toHaveBeenCalledOnce()
    fetch.mockResolvedValueOnce(Response.json({ item: null }))
    expect(await renameArtifact(item.path, 'new.png', item, new AbortController().signal)).toEqual({ ok: false, code: 'ARTIFACT_OPERATION_UNKNOWN' })
    expect(fetch).toHaveBeenCalledTimes(2)
    fetch.mockResolvedValueOnce(new Response('not JSON', { status: 502 }))
    expect(await saveStorage('/new', 1, new AbortController().signal)).toEqual({ ok: false, code: 'ARTIFACT_OPERATION_UNKNOWN' })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it.each([
    { items: [{ ...item, size: '128' }], roots: [], truncated: false },
    { items: [{ ...item, kind: 'invented' }], roots: [], truncated: false },
    { items: null, roots: [], truncated: false },
  ])('contains malformed listings without exposing them to rendering', async (body) => {
    respond(body)
    expect(await readArtifacts(new AbortController().signal)).toEqual({ ok: false, code: 'ARTIFACT_OPERATION_FAILED' })
  })

  it('contains malformed storage, recovery records, and unknown Host errors', async () => {
    const fetch = respond({ ...storage, revision: -1 })
    expect(await readStorage(new AbortController().signal)).toEqual({ ok: false, code: 'ARTIFACT_OPERATION_FAILED' })
    fetch.mockResolvedValueOnce(Response.json({ items: [{ id: 'trash-1' }] }))
    expect(await readTrash(new AbortController().signal)).toEqual({ ok: false, code: 'ARTIFACT_OPERATION_FAILED' })
    fetch.mockResolvedValueOnce(Response.json({ code: 'PRIVATE_DIAGNOSTIC', message: 'secret' }, { status: 500 }))
    expect(await readStorage(new AbortController().signal)).toEqual({ ok: false, code: 'ARTIFACT_OPERATION_FAILED' })
  })
})
