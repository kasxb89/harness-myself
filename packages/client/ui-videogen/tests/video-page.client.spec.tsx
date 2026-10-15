// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '../../ui-renderer/src/client/bind.ts'
import { createVideoDraftStore } from '../src/client/draft-store.ts'
import { VideoPage } from '../src/client/VideoPage.tsx'
import { zh } from '../src/client/locales.ts'

const params = {
  durations: [5, 10], resolutions: ['720p', '1080p'], ratios: ['16:9', '9:16'], frameSlots: 2,
  maxReferenceImages: 3, maxReferenceVideos: 1, maxReferenceAudios: 1,
  audio: true, audioToggle: true, modes: ['normal', 'pro'], seed: true,
}
const json = (value: object): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const t: Parameters<typeof VideoPage>[0]['t'] = (key, values) => zh[key].replace(/\{(\w+)\}/g, (match, name: string) => values?.[name] ?? match)
let fetcher = vi.fn<typeof fetch>()

function setup(overrides: Partial<typeof params> = {}) {
  const task = vi.fn(async (_init?: RequestInit): Promise<Response> => json({ ok: true, payload: { path: '/credits/media/new.mp4' } }))
  const asset = vi.fn(async (): Promise<Response> => json({ ok: true, asset: { assetId: 'ma_image' } }))
  fetcher = vi.fn(async (input, init) => {
    const path = String(input)
    if (path === '/credits/api/session') return json({ ok: true, payload: { signedIn: true, creditsPerYuan: 1000 } })
    if (path === '/credits/api/summary') return json({ ok: true, payload: { balance_points: 2000 } })
    if (path === '/credits/api/media/catalog') return json({ ok: true, payload: { video: [
      { id: 'video-real', displayName: 'Real video model', source: 'local-config', verified: true, params: { ...params, ...overrides } },
      { id: 'video-smaller', displayName: 'Smaller video model', source: 'local-config', verified: true, params: { ...params, ...overrides, maxReferenceImages: 3 } },
    ] } })
    if (path === '/artifacts/api/list') return json({ items: [] })
    if (path === '/credits/api/assets') return asset()
    if (path.startsWith('/credits/api/video/tasks')) return task(init)
    throw new Error(`Unexpected route: ${path}`)
  })
  vi.stubGlobal('fetch', fetcher)
  const store = createVideoDraftStore().create()
  const props = {
    t, openImage: vi.fn(), createPreview: vi.fn((file: File) => `blob:${file.name}`), releasePreview: vi.fn(),
    useStore: bindSnapshotSelector(store), actions: store.actions,
  } as Parameters<typeof VideoPage>[0]
  return { store, props, task, asset, mount: () => render(<VideoPage {...props} />) }
}
const ready = async (): Promise<void> => { await waitFor(() => { expect(screen.getByRole('button', { name: zh.model }).textContent).toContain('Real video model') }) }
const writePrompt = (): void => { fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: 'A continuous tracking shot' } }) }

beforeEach(() => { vi.useRealTimers() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('video composer', () => {
  it('shows only supported media arrangements and omits audio references the upload route cannot accept', async () => {
    const view = setup({ frameSlots: 0, maxReferenceImages: 0, maxReferenceVideos: 0 }).mount()
    await ready()
    expect(screen.queryByRole('button', { name: zh['workflow.image'] })).toBeNull()
    expect(screen.queryByRole('button', { name: zh['workflow.frames'] })).toBeNull()
    expect(screen.queryByRole('button', { name: zh['workflow.reference'] })).toBeNull()
    expect(view.container.querySelector('input[accept*="audio"]')).toBeNull()
    expect(screen.queryByText('local-config')).toBeNull()
  })

  it('submits the latest tier, seed and audio once and keeps a running task across mode remounts', async () => {
    const { mount, store, task } = setup()
    let complete: ((response: Response) => void) | undefined
    task.mockImplementationOnce(async () => await new Promise<Response>((resolve) => { complete = resolve }))
    const first = mount()
    await ready()
    writePrompt()
    fireEvent.click(screen.getByText('16:9 · 720p · 5 秒'))
    fireEvent.click(screen.getByRole('button', { name: 'pro' }))
    fireEvent.change(screen.getByPlaceholderText(zh.seedHint), { target: { value: '73' } })
    fireEvent.click(screen.getByRole('checkbox', { name: zh.audio }))
    const submit = screen.getByRole('button', { name: zh.submit })
    fireEvent.click(submit)
    fireEvent.click(submit)
    await waitFor(() => { expect(task).toHaveBeenCalledTimes(1) })
    expect(JSON.parse(String(task.mock.calls[0]?.[0]?.body))).toMatchObject({ mode: 'pro', seed: 73, audio: false, frameImages: [], referenceAudios: [] })
    first.unmount()
    mount()
    await ready()
    expect((screen.getByRole('textbox', { name: zh.prompt }) as HTMLTextAreaElement).value).toBe('A continuous tracking shot')
    expect((screen.getByRole('button', { name: zh.runningShort }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { complete?.(json({ ok: true, payload: { path: '/credits/media/new.mp4' } })) })
    await waitFor(() => { expect(store.getSnapshot().phase).toBe('idle') })
    expect(store.getSnapshot().result?.path).toBe('/credits/media/new.mp4')
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('retains a previous clip and draft after a failed request without retrying generation', async () => {
    const { mount, store, task } = setup()
    store.actions.patch({ result: { path: '/credits/media/previous.mp4' } })
    task.mockRejectedValueOnce(new Error('connection closed'))
    mount()
    await ready()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh.outcomeUnknown) })
    expect(store.getSnapshot()).toMatchObject({ phase: 'idle', prompt: 'A continuous tracking shot', result: { path: '/credits/media/previous.mp4' } })
    expect(task).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: zh.submit }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps successful earlier uploads when the next file fails and releases the busy state', async () => {
    const { mount, store, asset } = setup()
    asset.mockResolvedValueOnce(json({ ok: true, asset: { assetId: 'ma_first' } })).mockRejectedValueOnce(new Error('offline'))
    mount()
    await ready()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.reference'] }))
    fireEvent.change(screen.getByLabelText(zh.referenceImages), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' }), new File(['two'], 'two.png', { type: 'image/png' })] } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull(); expect(asset).toHaveBeenCalledTimes(2) })
    expect(store.getSnapshot().slots.image.map(item => item.assetId)).toEqual(['ma_first'])
    expect(screen.getByRole('alert').textContent).toBe(zh.uploadNetwork)
    expect((screen.getByRole('button', { name: zh.submit }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('trims references to the new model limit, releases discarded previews and sends the visible files', async () => {
    const { mount, store, props, task } = setup({ maxReferenceImages: 4 })
    store.actions.patch({ workflow: 'reference', slots: {
      image: Array.from({ length: 4 }, (_, index) => ({ assetId: `ma_${index}`, name: `image-${index}.png`, url: `blob:${index}` })), video: [],
    } })
    const view = mount()
    await ready()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.model }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Smaller video model' }))
    await waitFor(() => { expect(store.getSnapshot().slots.image).toHaveLength(3) })
    expect(props.releasePreview).toHaveBeenCalledWith('blob:3')
    expect(view.container.querySelectorAll('img')).toHaveLength(3)
    expect(screen.getByText(zh.modelMediaAdjusted)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(task).toHaveBeenCalledTimes(1) })
    expect(JSON.parse(String(task.mock.calls[0]?.[0]?.body)).referenceImages).toEqual(['ma_0', 'ma_1', 'ma_2'])
  })

  it('requires both endpoint frames and sends no hidden frame references in text mode', async () => {
    const { mount, store, task } = setup()
    store.actions.patch({ lastFrame: { assetId: 'ma_last', name: 'last.png', url: 'blob:last' } })
    mount()
    await ready()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.frames'] }))
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    expect(screen.getByRole('alert').textContent).toBe(zh.mediaRequired)
    expect(task).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.text'] }))
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(task).toHaveBeenCalledTimes(1) })
    expect(JSON.parse(String(task.mock.calls[0]?.[0]?.body)).frameImages).toEqual([])
    expect(store.getSnapshot().lastFrame?.assetId).toBe('ma_last')
  })

  it('previews a camera script, filters categories and appends it without generating', async () => {
    const { mount, store, task } = setup()
    mount()
    await ready()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.category_cinematic }))
    expect(screen.queryByRole('button', { name: `预览 ${zh.template_product}` })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `预览 ${zh.template_orbit}` }))
    expect(screen.getByRole('dialog').textContent).toMatchSnapshot()
    fireEvent.click(screen.getByRole('button', { name: zh.useScript }))
    expect(store.getSnapshot().prompt).toBe(`A continuous tracking shot\n\n${zh.template_orbit_prompt}`)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(task).not.toHaveBeenCalled()
  })
})
