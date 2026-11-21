import { afterEach, describe, expect, it, vi } from 'vitest'
import { createShowcaseController, type ShowcaseController } from '../src/client/showcase-controller.ts'
import type { ShowcaseResult } from '../src/client/showcase-api.ts'
import type { CaseShowcaseItem } from '../src/client/case-showcase-types.ts'
import { showcasePage } from '../src/client/showcase-wire.ts'

const categoryList = ['web', 'video']
const config = { capabilities: { showcases_v1: true, pagination: true, public_ready_media: true }, categories: categoryList }
const ok = (payload: unknown): ShowcaseResult => ({ ok: true, payload })
function row(index: number, category = 'web') {
  const id = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, mediaId = `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  const url = `/credits/api/demand-showcases/assets/${id}/${mediaId}/content`
  return { id, title: `公开案例${index}`, description: `第${index}份独立内容`, category, cover_url: url,
    media: [{ id: mediaId, kind: 'image', mime_type: 'image/png', size_bytes: 100, sha256: 'a'.repeat(64), url }],
    source_name: '来源', source_url: '', attribution: '', synthetic: true, created_at: 1, updated_at: 1 }
}
const legacy: CaseShowcaseItem = { id: 'old-public-reference', title: '旧配置案例', description: '既有公开素材', category: 'web',
  coverUrl: '/old.png', media: [{ kind: 'image', url: '/old.png' }] }
const controllers: ShowcaseController[] = []
afterEach(async () => { await Promise.all(controllers.splice(0).map(item => item.dispose())) })
function setup(request: (path: string, signal: AbortSignal) => Promise<ShowcaseResult>) {
  const model = createShowcaseController({ enabled: true, showcaseItems: [legacy] }, { request })
  controllers.push(model); model.start(); return model
}
describe('capability-owned readonly backend cases', () => {
  it('accepts public rev2 cases without synthetic and keeps older boolean compatibility without a UI label', () => {
    for (const synthetic of [undefined, true, false]) {
      const result = showcasePage({ items: [{ ...row(1), synthetic }], next_cursor: '', has_more: false, total_count: 1 })
      expect(result.items[0]?.id).toBe(row(1).id)
      expect(result.items[0]).not.toHaveProperty('synthetic')
    }
  })
  it('rejects malformed legacy synthetic values rather than loosening synthetic-field validation', () => {
    for (const synthetic of [null, 0, 'true', {}]) {
      expect(() => showcasePage({ items: [{ ...row(1), synthetic }], next_cursor: '', has_more: false, total_count: 1 })).toThrow()
    }
  })
  it('negotiates v1, loads 100 then original cursor, reports total and never reads configured fallback', async () => {
    const request = vi.fn(async (path: string): Promise<ShowcaseResult> => path === '/config' ? ok(config)
      : path.includes('cursor=') ? ok({ items: [row(101)], next_cursor: '', has_more: false, total_count: 101 })
        : ok({ items: Array.from({ length: 100 }, (_, i) => row(i + 1)), next_cursor: 'opaque-next', has_more: true, total_count: 101 }))
    const model = setup(request)
    await vi.waitFor(() => { expect(model.hooks.showcases.getSnapshot().items).toHaveLength(100) })
    expect(model.hooks.showcases.getSnapshot()).toMatchObject({ source: 'backend', total: 101, hasMore: true })
    model.loadMoreShowcases()
    await vi.waitFor(() => { expect(model.hooks.showcases.getSnapshot().items).toHaveLength(101) })
    expect(request.mock.calls.map(row => row[0])).toEqual(['/config', '?limit=100', '?limit=100&cursor=opaque-next'])
    expect(model.hooks.showcases.getSnapshot().items.some(row => row.id === legacy.id)).toBe(false)
  })
  it.each([404, 200])('uses configured cases only for an initial old endpoint/missing capability (%i)', async (status) => {
    const request = vi.fn(async (): Promise<ShowcaseResult> => status === 404 ? { ok: false, code: 'SHOWCASE_NOT_FOUND', httpStatus: 404 } : ok({ capabilities: {} }))
    const model = setup(request)
    await vi.waitFor(() => { expect(model.hooks.showcases.getSnapshot().source).toBe('legacy') })
    expect(model.hooks.showcases.getSnapshot().items).toEqual([legacy]); expect(request).toHaveBeenCalledTimes(1)
  })
  it.each([401, 403, 429, 500, 0])('never converts authorization, network or service error %i into old case success', async (status) => {
    const model = setup(async () => ({ ok: false, code: 'SHOWCASE_FAILURE', httpStatus: status }))
    await vi.waitFor(() => { expect(model.hooks.showcases.getSnapshot().status).toBe('error') })
    expect(model.hooks.showcases.getSnapshot().items).toEqual([])
    expect(model.hooks.showcases.getSnapshot().source).toBe('checking')
  })
  it('keeps backend authority after later missing capability and clears protected failure content', async () => {
    let removed = false
    const model = setup(async path => path === '/config' ? removed ? ok({ capabilities: {} }) : ok(config)
      : ok({ items: [row(1)], next_cursor: '', has_more: false, total_count: 1 }))
    await vi.waitFor(() => { expect(model.hooks.showcases.getSnapshot().items).toHaveLength(1) })
    removed = true; model.refreshShowcases()
    await vi.waitFor(() => { expect(model.hooks.showcases.getSnapshot().status).toBe('error') })
    expect(model.hooks.showcases.getSnapshot()).toMatchObject({ source: 'backend', items: [], error: 'SHOWCASE_CAPABILITY_CHANGED' })
  })
  it('retains only original backend cases on transient refresh failure and removes them on unauthorized refresh', async () => {
    let status = 200
    const model = setup(async path => path === '/config' ? ok(config) : status === 200
      ? ok({ items: [row(1)], next_cursor: '', has_more: false, total_count: 1 })
      : { ok: false, code: 'SHOWCASE_FAILURE', httpStatus: status })
    await vi.waitFor(() => { expect(model.hooks.showcases.getSnapshot().status).toBe('ready') })
    status = 503; model.refreshShowcases()
    await vi.waitFor(() => { expect(model.hooks.showcases.getSnapshot().status).toBe('error') })
    expect(model.hooks.showcases.getSnapshot().items[0]?.id).toBe(row(1).id)
    expect(model.hooks.showcases.getSnapshot().items.some(item => item.id === legacy.id)).toBe(false)
    status = 401; model.refreshShowcases()
    await vi.waitFor(() => { expect(model.hooks.showcases.getSnapshot()).toMatchObject({ status: 'error', items: [] }) })
  })
  it('resets filter cursor and ignores a late response from the previous category', async () => {
    let resolve: (value: ShowcaseResult) => void = () => { throw new Error('No pending response') }
    let calls = 0
    const request = vi.fn(async (path: string): Promise<ShowcaseResult> => {
      if (path === '/config') return ok(config)
      calls += 1
      if (calls === 2) return await new Promise((done) => { resolve = done })
      return ok({ items: [row(calls, path.includes('category=video') ? 'video' : 'web')], next_cursor: '', has_more: false, total_count: 1 })
    })
    const model = setup(request)
    await vi.waitFor(() => { expect(model.hooks.showcases.getSnapshot().status).toBe('ready') })
    model.setShowcaseCategory('web')
    await vi.waitFor(() => { expect(calls).toBe(2) })
    model.setShowcaseCategory('video')
    await vi.waitFor(() => { expect(model.hooks.showcases.getSnapshot().items[0]?.category).toBe('video') })
    resolve(ok({ items: [row(2)], next_cursor: '', has_more: false, total_count: 1 }))
    await Promise.resolve(); await Promise.resolve()
    expect(model.hooks.showcases.getSnapshot().items[0]?.category).toBe('video')
    expect(request.mock.calls.at(-1)?.[0]).toBe('?limit=100&category=video')
  })
  it('retains verified backend rows on a transient failure and rejects a repeated cursor', async () => {
    let calls = 0
    const model = setup(async path => path === '/config' ? ok(config) : ++calls === 1
      ? ok({ items: [row(1)], next_cursor: 'same', has_more: true, total_count: 3 })
      : ok({ items: [row(2)], next_cursor: 'same', has_more: true, total_count: 3 }))
    await vi.waitFor(() => { expect(model.hooks.showcases.getSnapshot().status).toBe('ready') })
    model.loadMoreShowcases()
    await vi.waitFor(() => { expect(model.hooks.showcases.getSnapshot().status).toBe('error') })
    expect(model.hooks.showcases.getSnapshot().items).toHaveLength(1)
  })
  it('does not start reads before start or after disposal and rejects cross-case media', async () => {
    const request = vi.fn(async (): Promise<ShowcaseResult> => ok(config))
    const model = createShowcaseController({ enabled: false }, { request }); controllers.push(model)
    expect(request).not.toHaveBeenCalled(); model.start(); model.refreshShowcases()
    await model.dispose(); model.loadMoreShowcases(); model.refreshShowcases()
    expect(request).not.toHaveBeenCalled()
    expect(() => showcasePage({ items: [{ ...row(1), cover_url: row(2).cover_url }], next_cursor: '', has_more: false, total_count: 1 })).toThrow()
  })
})
