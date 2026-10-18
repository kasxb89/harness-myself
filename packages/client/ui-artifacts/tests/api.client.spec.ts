// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ERROR_CODES, readArtifacts, readRootDirectory, readStorage, readTrash, readWorkspace,
  renameArtifact, restoreArtifact, saveStorage, trashArtifact,
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
  it('reads an exact retained root directory page and rejects mismatched or looping pagination', async () => {
    const body = { root: '/产物', directory: 'deep', absoluteDirectory: '/产物/deep', parentDirectory: '',
      directories: [], items: [item], truncated: true, offset: 2, nextOffset: 4 }
    const fetch = respond(body)
    const signal = new AbortController().signal
    expect(await readRootDirectory('/产物', 'deep', signal, 2)).toEqual({ ok: true, value: body })
    const url = new URL(fetch.mock.calls[0]![0] as string, 'http://localhost')
    expect(url.pathname).toBe('/artifacts/api/directory')
    expect(url.searchParams.get('root')).toBe('/产物')
    expect(url.searchParams.get('directory')).toBe('deep')
    expect(url.searchParams.get('offset')).toBe('2')
    for (const invalid of [{ ...body, root: '/other' }, { ...body, directory: 'other' }, { ...body, offset: 0 },
      { ...body, nextOffset: 2 }, { ...body, nextOffset: 2.5 }, { ...body, items: [{ ...item, workspaceId: 'unexpected' }] }]) {
      fetch.mockResolvedValueOnce(Response.json(invalid))
      expect(await readRootDirectory('/产物', 'deep', signal, 2)).toEqual({ ok: false, code: 'ARTIFACT_OPERATION_FAILED' })
    }
  })
  it('reads exactly the requested workspace directory and binds files to its registered scope', async () => {
    const listing = { workspace: { id: 'workspace-one', title: '项目', path: 'D:\\项目' }, directory: '输出/子目录',
      absoluteDirectory: 'D:\\项目\\输出\\子目录', parentDirectory: '输出', directories: [{ name: 'assets', directory: '输出/子目录/assets' }],
      items: [item], truncated: false }
    const fetch = respond(listing)
    const signal = new AbortController().signal
    expect(await readWorkspace('workspace-one', '输出/子目录', signal)).toEqual({ ok: true,
      value: { ...listing, items: [{ ...item, workspaceId: 'workspace-one' }] } })
    const request = new URL(fetch.mock.calls[0]![0] as string, 'http://localhost')
    expect(request.pathname).toBe('/artifacts/api/workspace')
    expect(request.searchParams.get('workspaceId')).toBe('workspace-one')
    expect(request.searchParams.get('directory')).toBe('输出/子目录')
    fetch.mockResolvedValueOnce(Response.json({ ...listing, workspace: { ...listing.workspace, id: 'other' } }))
    expect(await readWorkspace('workspace-one', '输出/子目录', signal)).toEqual({ ok: false, code: 'ARTIFACT_OPERATION_FAILED' })
    fetch.mockResolvedValueOnce(Response.json({ ...listing, directory: 'other' }))
    expect(await readWorkspace('workspace-one', '输出/子目录', signal)).toEqual({ ok: false, code: 'ARTIFACT_OPERATION_FAILED' })
  })

  it('carries workspace authorization through file mutations and durable recovery inventory', async () => {
    const fetch = respond({ item })
    const signal = new AbortController().signal
    expect(await renameArtifact(item.path, 'new.png', item, signal, 'workspace-one'))
      .toEqual({ ok: true, value: { ...item, workspaceId: 'workspace-one' } })
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({ workspaceId: 'workspace-one' })
    fetch.mockResolvedValueOnce(Response.json({ trashId: 'trash-one' }))
    await trashArtifact(item.path, item, signal, 'workspace-one')
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toMatchObject({ workspaceId: 'workspace-one' })
    const recovery = { id: 'trash-one', name: item.name, originalPath: item.path, deletedAt: '2026-10-17T04:00:00Z', workspaceRoot: '/project' }
    fetch.mockResolvedValueOnce(Response.json({ items: [recovery] }))
    expect(await readTrash(signal)).toEqual({ ok: true, value: [recovery] })
  })

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

  it('accepts workspace-bound output and partial source failures without discarding readable files', async () => {
    const value = { items: [{ ...item, workspaceId: 'workspace-one' }], roots: ['/产物'], truncated: true,
      issues: [{ workspaceId: 'workspace-two', title: '另一个项目', code: 'ARTIFACT_PERMISSION_DENIED' }] }
    respond(value)
    expect(await readArtifacts(new AbortController().signal)).toEqual({ ok: true, value })
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
    { items: [{ ...item, workspaceId: 1 }], roots: [], truncated: false },
    { items: [{ ...item, workspaceId: '' }], roots: [], truncated: false },
    { items: [item], roots: [], truncated: false, issues: null },
    { items: [item], roots: [], truncated: false, issues: [{}] },
    { items: [item], roots: [], truncated: false, issues: [{ workspaceId: '', title: '项目', code: 'ARTIFACT_OPERATION_FAILED' }] },
    { items: [item], roots: [], truncated: false, issues: [{ workspaceId: 'one', title: 1, code: 'ARTIFACT_OPERATION_FAILED' }] },
    { items: [item], roots: [], truncated: false, issues: [{ workspaceId: 'one', title: '项目', code: 'PRIVATE_EXCEPTION' }] },
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
