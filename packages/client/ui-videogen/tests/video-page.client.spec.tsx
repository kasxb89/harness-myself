// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderFactorySlot } from '@deepseek-ai/dsh-client-ui-slots'
import type { PromptAssistOwner } from '@deepseek-ai/dsh-client-ui-prompt-assist/client'
import { bindSnapshotSelector } from '../../ui-renderer/src/client/bind.ts'
import { createVideoDraftStore } from '../src/client/draft-store.ts'
import { VideoPage } from '../src/client/VideoPage.tsx'
import { zh } from '../src/client/locales.ts'
import { contentFixture } from '../../ui-imagegen/tests/content-fixture.client.ts'

const params = {
  defaultDuration: undefined as number | undefined,
  durationByResolution: undefined as Readonly<Record<string, readonly number[]>> | undefined,
  durations: [5, 10], resolutions: ['720p', '1080p'], ratios: ['16:9', '9:16'], frameSlots: 2,
  maxReferenceImages: 3, maxReferenceVideos: 1, maxReferenceAudios: 1,
  audio: true, audioToggle: true, modes: ['normal', 'pro'], seed: true,
}
const json = (value: object): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const t: Parameters<typeof VideoPage>[0]['t'] = (key, values) => zh[key].replace(/\{(\w+)\}/g, (match, name: string) => values?.[name] ?? match)
let fetcher = vi.fn<typeof fetch>()
let sessionAccountId: string | null = 'account-a'
let chatSessionId: string | undefined = 'session-a'

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
  const value: unknown = JSON.parse(init.body)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object')
  return value as Record<string, unknown>
}

function setup(overrides: Partial<typeof params> = {}) {
  const task = vi.fn(async (_init?: RequestInit): Promise<Response> => json({ ok: true, payload: { path: '/credits/media/new.mp4' } }))
  const asset = vi.fn(async (): Promise<Response> => json({ ok: true, asset: { assetId: 'ma_image' } }))
  const projects = vi.fn(async (): Promise<Response> => json({ ok: true, payload: { accountId: sessionAccountId, projects: [] } }))
  const recover = vi.fn(async (): Promise<Response> => new Response(JSON.stringify({
    ok: true, payload: { accountId: sessionAccountId, projects: [] },
  }), { status: 202 }))
  fetcher = vi.fn(async (input, init) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (path === '/credits/api/session') return json({ ok: true, payload: { signedIn: sessionAccountId !== null, creditsPerYuan: 1000, account: sessionAccountId === null ? null : { id: sessionAccountId } } })
    if (path === '/credits/api/summary') return json({ ok: true, payload: { balance_points: 2000 } })
    if (path === '/credits/api/media/catalog') return json({ ok: true, payload: { video: [
      { id: 'video-real', displayName: 'Real video model', source: 'local-config', verified: true, params: { ...params, ...overrides } },
      { id: 'video-smaller', displayName: 'Smaller video model', source: 'local-config', verified: true, params: { ...params, ...overrides, maxReferenceImages: 3 } },
    ] } })
    if (path.startsWith('/credits/api/creative/projects?')) return projects()
    if (path === '/credits/api/creative/video/recover') return recover()
    if (path === '/artifacts/api/list') return json({ items: [] })
    if (path === '/credits/api/assets') return asset()
    if (path.startsWith('/credits/api/video/tasks')) return task(init)
    throw new Error(`Unexpected route: ${path}`)
  })
  vi.stubGlobal('fetch', fetcher)
  const store = createVideoDraftStore().create()
  store.actions.setReferenceAccount('account-a')
  const fixture = contentFixture()
  const props = {
    useCreationContent: fixture.useCreationContent, useLocale: fixture.useLocale, refreshContent: vi.fn(),
    useCreationSession: select => select({ key: chatSessionId, hooks: {}, keyedHooks: {}, props: {} }),
    t, openImage: vi.fn(), createPreview: vi.fn((file: File) => `blob:${file.name}`), releasePreview: vi.fn(),
    renderFactorySlot: vi.fn<RenderFactorySlot>(() => null),
    useStore: bindSnapshotSelector(store), actions: store.actions,
    readDraft: () => store.getSnapshot(),
  } as Parameters<typeof VideoPage>[0]
  return { store, props, fixture, task, asset, projects, recover, mount: () => render(<VideoPage {...props} />) }
}
const ready = async (): Promise<void> => {
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.model }).textContent).toContain('Real video model') })
  await act(async () => {})
}
function chooseFrame(which: 'first' | 'last', name: string): void {
  if (screen.queryByRole('combobox', { name: which === 'first' ? zh.firstFrame : zh.lastFrame }) === null) {
    fireEvent.click(screen.getByRole('button', { name: zh[which === 'last' ? 'workflow.frames' : 'workflow.image'] }))
  }
  const field = screen.getByRole('combobox', { name: which === 'first' ? zh.firstFrame : zh.lastFrame })
  const option = within(field).getByRole('option', { name })
  fireEvent.change(field, { target: { value: option.getAttribute('value') } })
}

const writePrompt = (): void => { fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: 'A continuous tracking shot' } }) }

beforeEach(() => { vi.useRealTimers(); sessionAccountId = 'account-a'; chatSessionId = 'session-a' })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('video composer', () => {
  it.each(['pending', 'unknown'])('keeps %s submissions uncertain after a local cancellation without retrying', async (submission_state) => {
    const { mount, store, task } = setup()
    task.mockImplementation(async () => json({ ok: false, code: 'ABORTED', submission_state }))
    mount()
    await ready()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(store.getSnapshot().failure).toBe(zh.outcomeUnknown) })
    expect(task).toHaveBeenCalledOnce()
    expect(screen.getByRole('alert').textContent).not.toBe(zh.cancelled)
  })

  it.each([
    { durations: Array.from({ length: 16 }, (_, index) => index + 15), defaultDuration: 30 },
    { durations: [10, 15], defaultDuration: 15 },
  ])('starts with the declared $defaultDuration-second default and submits the selected actual size', async ({ durations, defaultDuration }) => {
    const { mount, store, task } = setup({
      durations, defaultDuration, resolutions: ['1280x720', '720x1280', '1792x1024', '1024x1792'], ratios: [],
      frameSlots: 0, audioToggle: false, modes: [], seed: false,
    })
    mount()
    await ready()
    await waitFor(() => { expect(store.getSnapshot().duration).toBe(defaultDuration) })
    fireEvent.click(screen.getByLabelText(t('settingsSizeTrigger', { resolution: '1280x720', duration: String(defaultDuration) })))
    const panel = screen.getByRole('group', { name: zh.settings })
    fireEvent.click(within(panel).getByRole('button', { name: '1024x1792' }))
    expect(within(panel).queryByRole('button', { name: '720p' })).toBeNull()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(task).toHaveBeenCalledOnce() })
    expect(requestBody(task.mock.calls[0]?.[0])).toMatchObject({ durationSeconds: defaultDuration, resolution: '1024x1792' })
  })

  it('keeps an explicitly retained allowed duration ahead of the model default', async () => {
    const { mount, store } = setup({ durations: [15, 20, 30], defaultDuration: 30 })
    store.actions.patch({ duration: 20 })
    mount()
    await ready()
    expect(store.getSnapshot().duration).toBe(20)
  })

  it('uses the current resolution menu when its declared model default is unavailable', async () => {
    const { mount, store } = setup({
      durations: [15, 30], defaultDuration: 30, resolutions: ['1280x720'], durationByResolution: { '1280x720': [15] },
    })
    mount()
    await ready()
    await waitFor(() => { expect(store.getSnapshot().duration).toBe(15) })
  })

  it('uses catalog default duration and exact pixel dimensions for a reference-only video model', async () => {
    const h = setup({ durations: [15, 16, 30], defaultDuration: 30,
      resolutions: ['720x1280', '1280x720'], ratios: [], frameSlots: 0, maxReferenceImages: 9 })
    h.mount()
    await ready()
    expect(screen.queryByRole('button', { name: zh['workflow.image'] })).toBeNull()
    expect(screen.queryByRole('button', { name: zh['workflow.frames'] })).toBeNull()
    expect(h.store.getSnapshot()).toMatchObject({ duration: 30, resolution: '720x1280', ratio: '' })
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.reference'] }))
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: [new File(['image'], 'reference.png', { type: 'image/png' })] } })
    await waitFor(() => { expect(h.store.getSnapshot().uploading).toBeNull(); expect(h.asset).toHaveBeenCalledOnce() })
    expect(screen.queryByRole('combobox', { name: zh.firstFrame })).toBeNull()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(h.task).toHaveBeenCalledOnce() })
    expect(requestBody(h.task.mock.calls[0]?.[0])).toMatchObject({ model: 'video-real', durationSeconds: 30, resolution: '720x1280',
      frameImages: [], referenceImages: ['ma_image'] })
    expect(requestBody(h.task.mock.calls[0]?.[0])).not.toHaveProperty('ratio')
  })

  it('rechecks a late admission read after a fast successful generation instead of leaving controls locked', async () => {
    const h = setup()
    h.mount()
    await ready()
    const late = Promise.withResolvers<Response>()
    h.projects.mockImplementationOnce(() => late.promise)
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    try {
      await waitFor(() => { expect(h.store.getSnapshot().result?.path).toBe('/credits/media/new.mp4') })
      late.resolve(json({ ok: true, payload: { accountId: 'account-a', projects: [] } }))
      await waitFor(() => { expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', false) })
      expect(h.task).toHaveBeenCalledOnce()
    } finally { late.resolve(json({ ok: true, payload: { accountId: 'account-a', projects: [] } })) }
  })

  it('uses one upload input for every workflow and selects frame roles from the retained material pool', async () => {
    const { mount } = setup()
    const view = mount()
    await ready()
    expect(view.container.querySelectorAll('input[type="file"]')).toHaveLength(1)
    expect(screen.getByLabelText(zh.addMedia)).toBeTruthy()
    expect(screen.queryByLabelText(zh.referenceImages)).toBeNull()
    expect(screen.queryByLabelText(zh.referenceVideos)).toBeNull()
    expect(screen.queryByLabelText(zh.referenceAudios)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.frames'] }))
    expect(view.container.querySelectorAll('input[type="file"]')).toHaveLength(1)
    expect(screen.getByLabelText(zh.firstFrame)).toBeTruthy()
    expect(screen.getByLabelText(zh.lastFrame)).toBeTruthy()
  })

  it('restores retained images into a visible first-frame choice when opening image mode', async () => {
    const { mount, store, task } = setup()
    store.actions.patch({ workflow: 'image', slots: { audio: [], video: [], image: Array.from({ length: 4 }, (_, index) => ({
      assetId: `ma_retained${String(index)}`, name: `long-material-name-${String(index)}.png`, url: `blob:${String(index)}`, bytes: 1,
    })) } })
    const view = mount()
    await ready()
    await waitFor(() => { expect(store.getSnapshot().firstFrame?.assetId).toBe('ma_retained0') })
    const list = screen.getByRole('list', { name: t('materialList', { kind: zh.referenceImages }) })
    expect(within(list).getAllByRole('listitem')).toHaveLength(4)
    expect(view.container.querySelector('[data-frame="first"]')?.getAttribute('data-selected')).toBe('true')
    expect(screen.getByRole('combobox', { name: zh.firstFrame })).toHaveProperty('value', 'ma_retained0')
    fireEvent.change(screen.getByRole('combobox', { name: zh.firstFrame }), { target: { value: '' } })
    expect(store.getSnapshot().firstFrame).toBeNull()
    chooseFrame('first', 'long-material-name-2.png')
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(task).toHaveBeenCalledOnce() })
    expect(requestBody(task.mock.calls[0]?.[0])).toMatchObject({ frameImages: ['ma_retained2'], referenceImages: [] })
  })

  it.each(['clear', 'delete'] as const)('preserves an explicitly %s first frame across panel remounts', async (method) => {
    const { mount, store } = setup()
    store.actions.patch({ workflow: 'image', slots: { audio: [], video: [], image: [
      { assetId: 'ma_first', name: 'first.png', url: 'blob:first', bytes: 1 },
      { assetId: 'ma_second', name: 'second.png', url: 'blob:second', bytes: 1 },
    ] } })
    const view = mount()
    await ready()
    await waitFor(() => { expect(store.getSnapshot().firstFrame?.assetId).toBe('ma_first') })
    if (method === 'clear') fireEvent.change(screen.getByRole('combobox', { name: zh.firstFrame }), { target: { value: '' } })
    else fireEvent.click(screen.getByRole('button', { name: t('removeNamed', { name: 'first.png' }) }))
    expect(store.getSnapshot().firstFrame).toBeNull()
    view.unmount()
    mount()
    await ready()
    expect(store.getSnapshot().firstFrame).toBeNull()
    expect(store.getSnapshot().slots.image).toHaveLength(method === 'clear' ? 2 : 1)
    writePrompt()
    expect(screen.getByText(zh.firstFrameRequired)).toBeTruthy()
  })

  it('shows only active frame badges, sends reference-mode images, and still clears cached frame ownership on delete', async () => {
    const { mount, store, task } = setup({ maxReferenceImages: 4 })
    const references = Array.from({ length: 4 }, (_, index) => ({ assetId: `ma_ref${String(index)}`,
      name: `ref-${String(index)}.png`, url: `blob:${String(index)}`, bytes: 1 }))
    store.actions.patch({ workflow: 'frames', slots: { image: references, audio: [], video: [] }, firstFrame: references[0]!, lastFrame: references[1]! })
    mount()
    await ready()
    expect(screen.getByRole('combobox', { name: zh.firstFrame })).toHaveProperty('value', 'ma_ref0')
    expect(screen.getByRole('combobox', { name: zh.lastFrame })).toHaveProperty('value', 'ma_ref1')
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.reference'] }))
    const list = screen.getByRole('list', { name: t('materialList', { kind: zh.referenceImages }) })
    expect(screen.queryByRole('combobox', { name: zh.firstFrame })).toBeNull()
    expect(screen.queryByRole('combobox', { name: zh.lastFrame })).toBeNull()
    expect(within(list).queryByText(zh.firstFrame)).toBeNull()
    expect(within(list).queryByText(zh.lastFrame)).toBeNull()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(task).toHaveBeenCalledOnce() })
    expect(requestBody(task.mock.calls[0]?.[0])).toMatchObject({ frameImages: [], referenceImages: references.map(item => item.assetId) })
    fireEvent.click(screen.getByRole('button', { name: t('removeNamed', { name: 'ref-0.png' }) }))
    expect(store.getSnapshot().firstFrame).toBeNull()
    expect(store.getSnapshot().lastFrame?.assetId).toBe('ma_ref1')
  })

  it('does not clear a frame from a stale account render', async () => {
    const { store, props } = setup()
    const reference = { assetId: 'ma_private', name: 'private.png', url: 'blob:private', bytes: 1 }
    store.actions.patch({ workflow: 'image', firstFrame: reference, slots: { image: [reference], audio: [], video: [] } })
    const read = props.readDraft
    render(<VideoPage {...props} readDraft={() => ({ ...read(), referenceAccountId: 'account-b' })} />)
    await ready()
    vi.mocked(props.releasePreview).mockClear()
    fireEvent.change(screen.getByRole('combobox', { name: zh.firstFrame }), { target: { value: '' } })
    expect(store.getSnapshot().firstFrame).toEqual(reference)
    expect(props.releasePreview).not.toHaveBeenCalled()
  })

  it('does not auto-select images from a render whose live reference owner has changed', async () => {
    const { store, props } = setup()
    store.actions.patch({ workflow: 'image', slots: { audio: [], video: [], image: [
      { assetId: 'ma_old', name: 'old.png', url: 'blob:old', bytes: 1 },
    ] } })
    const read = props.readDraft
    const guardedRead = vi.fn(() => {
      const current = read()
      if (current.referenceAccountId === 'account-a' && current.workflow === 'image') {
        // Model the live ownership reset occurring before a stale render's effect.
        return { ...current, referenceAccountId: 'account-b', referenceEpoch: current.referenceEpoch + 1,
          slots: { audio: [], video: [], image: [] } }
      }
      return current
    })
    render(<VideoPage {...props} readDraft={guardedRead} />)
    await ready()
    expect(guardedRead).toHaveBeenCalled()
    chooseFrame('first', 'old.png')
    expect(store.getSnapshot().firstFrame).toBeNull()
    expect(store.getSnapshot().frameWorkflowSelection).toBeNull()
  })

  it('explains missing input and AI writing beside generation while stating the active image count', async () => {
    const { mount, store } = setup()
    mount()
    await ready()
    expect(screen.getByText(zh.promptRequired)).toBeTruthy()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.image'] }))
    expect(screen.getByText(zh.firstFrameRequired)).toBeTruthy()
    expect(screen.getByText(t('generationFrames', { n: '0' }))).toBeTruthy()
    act(() => { store.actions.patch({ promptAssisting: true }) })
    expect(screen.getByText(zh.submitWriting)).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', true)
    act(() => { store.actions.patch({ promptAssisting: false, firstFrame: { assetId: 'ma_selected', name: 'selected.png', url: 'blob:selected', bytes: 1 } }) })
    expect(screen.queryByText(zh.firstFrameRequired)).toBeNull()
    expect(screen.getByText(t('generationFrames', { n: '1' }))).toBeTruthy()
  })

  it('names an image-count failure separately from byte limits and retains all existing materials', async () => {
    const { mount, store, asset } = setup()
    store.actions.patch({ slots: { audio: [], video: [], image: Array.from({ length: 9 }, (_, index) => ({
      assetId: `ma_count${String(index)}`, name: `image-${String(index)}.png`, url: `blob:${String(index)}`, bytes: 1,
    })) } })
    mount()
    await ready()
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: [new File(['image'], 'tenth.png', { type: 'image/png' })] } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull() })
    expect(asset).not.toHaveBeenCalled()
    expect(store.getSnapshot().slots.image).toHaveLength(9)
    expect(store.getSnapshot().uploadFailures).toEqual([{ name: 'tenth.png', reason: t('materialCountLimit', { n: '9' }) }])
  })

  it('retains several writing references for a single-frame model and sends the explicitly selected frame', async () => {
    const { mount, asset, store, props, task } = setup({ frameSlots: 1, maxReferenceImages: 0 })
    let id = 0
    asset.mockImplementation(async () => json({ ok: true, asset: { assetId: `ma_material${String(++id)}` } }))
    mount()
    await ready()
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: ['mother.png', 'child.png', 'book.png']
      .map(name => new File(['image'], name, { type: 'image/png' })) } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull(); expect(asset).toHaveBeenCalledTimes(3) })
    expect(store.getSnapshot().slots.image.map(item => item.assetId)).toEqual(['ma_material1', 'ma_material2', 'ma_material3'])
    expect(store.getSnapshot()).toMatchObject({ workflow: 'image', firstFrame: { assetId: 'ma_material1' } })
    const assistant = vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner
    expect(assistant.references).toEqual(['ma_material1', 'ma_material2', 'ma_material3'])
    expect(assistant.disabled).toBe(false)
    chooseFrame('first', 'child.png')
    expect(store.getSnapshot().firstFrame?.assetId).toBe('ma_material2')
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(task).toHaveBeenCalledOnce() })
    expect(requestBody(task.mock.calls[0]?.[0])).toMatchObject({ frameImages: ['ma_material2'], referenceImages: [] })
  })

  it('uses main-entry images in the reference workflow instead of silently generating from text alone', async () => {
    const { mount, asset, store, task } = setup({ frameSlots: 2, maxReferenceImages: 3 })
    let id = 0
    asset.mockImplementation(async () => json({ ok: true, asset: { assetId: `ma_material${String(++id)}` } }))
    mount()
    await ready()
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: ['one.png', 'two.png']
      .map(name => new File(['image'], name, { type: 'image/png' })) } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull(); expect(asset).toHaveBeenCalledTimes(2) })
    expect(store.getSnapshot().workflow).toBe('reference')
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(task).toHaveBeenCalledOnce() })
    expect(requestBody(task.mock.calls[0]?.[0])).toMatchObject({ frameImages: [], referenceImages: ['ma_material1', 'ma_material2'] })
  })

  it('routes a mixed main-entry batch to the model-supported image, video and audio slots without passing non-images to AI writing', async () => {
    const { mount, asset, store, props } = setup()
    let id = 0
    asset.mockImplementation(async () => json({ ok: true, asset: { assetId: `ma_material${String(++id)}` } }))
    mount()
    await ready()
    const input = screen.getByLabelText<HTMLInputElement>(zh.addMedia)
    expect(input.accept).toContain('.mp4,.mov')
    expect(input.accept).toContain('.mp3,.wav')
    fireEvent.change(input, { target: { files: [new File(['image'], 'photo.png', { type: 'image/png' }),
      new File(['video'], 'scene.mp4'), new File(['audio'], 'voice.wav', { type: 'audio/x-wav' })] } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull(); expect(asset).toHaveBeenCalledTimes(3) })
    expect(store.getSnapshot()).toMatchObject({ workflow: 'reference', slots: {
      image: [{ assetId: 'ma_material1' }], video: [{ assetId: 'ma_material2' }], audio: [{ assetId: 'ma_material3' }],
    } })
    expect((vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner).references).toEqual(['ma_material1'])
    expect(screen.getByText(zh.assistImagesOnly)).toBeTruthy()
    const draft = store.getSnapshot()
    expect({ workflow: draft.workflow, images: draft.slots.image.map(item => item.name),
      videos: draft.slots.video.map(item => item.name), audio: draft.slots.audio.map(item => item.name),
      notice: screen.getByText(zh.assistImagesOnly).textContent }).toMatchInlineSnapshot(`
      {
        "audio": [
          "voice.wav",
        ],
        "images": [
          "photo.png",
        ],
        "notice": "AI 帮写使用文字和图片，不读取视频或音频内容；这些素材仍保留用于生成",
        "videos": [
          "scene.mp4",
        ],
        "workflow": "reference",
      }
    `)
  })

  it('keeps a selected image preview while another slot still owns it and removes all of its frame bindings with the material', async () => {
    const { mount, asset, store, props } = setup()
    let id = 0
    asset.mockImplementation(async () => json({ ok: true, asset: { assetId: `ma_material${String(++id)}` } }))
    mount()
    await ready()
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: ['one.png', 'two.png']
      .map(name => new File(['image'], name, { type: 'image/png' })) } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull(); expect(asset).toHaveBeenCalledTimes(2) })
    chooseFrame('first', 'one.png')
    chooseFrame('last', 'two.png')
    expect(store.getSnapshot()).toMatchObject({ workflow: 'frames', firstFrame: { assetId: 'ma_material1' }, lastFrame: { assetId: 'ma_material2' } })
    chooseFrame('first', 'two.png')
    expect(props.releasePreview).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: t('removeNamed', { name: 'two.png' }) }))
    expect(store.getSnapshot()).toMatchObject({ firstFrame: null, lastFrame: null, slots: { image: [{ assetId: 'ma_material1' }] } })
    expect(props.releasePreview).toHaveBeenCalledOnce()
    expect(props.releasePreview).toHaveBeenCalledWith('blob:two.png')
  })

  it('rejects unsupported model media by filename and continues uploading supported images', async () => {
    const { mount, asset, store } = setup({ maxReferenceVideos: 0, maxReferenceAudios: 0 })
    mount()
    await ready()
    const input = screen.getByLabelText<HTMLInputElement>(zh.addMedia)
    expect(input.accept).not.toContain('.mp4')
    fireEvent.change(input, { target: { files: [new File(['video'], 'scene.mp4'),
      new File(['image'], 'photo.png', { type: 'image/png' })] } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull(); expect(asset).toHaveBeenCalledOnce() })
    expect(store.getSnapshot().slots.image).toHaveLength(1)
    expect(store.getSnapshot().slots.video).toEqual([])
    expect(screen.getByRole('alert').textContent).toBe(t('uploadItemFailed', { name: 'scene.mp4', reason: zh.unsupportedModelMaterial }))
  })

  it.each([
    { slot: 'video' as const, name: 'scene.MP4', type: '', expected: 'video/mp4' },
    { slot: 'video' as const, name: 'scene.mov', type: 'application/octet-stream', expected: 'video/quicktime' },
    { slot: 'audio' as const, name: 'voice.wav', type: 'audio/x-wav', expected: 'audio/wav' },
    { slot: 'audio' as const, name: 'voice.mp3', type: '', expected: 'audio/mpeg' },
  ])('uploads $name with $type MIME through the existing host validation', async ({ slot, name, type, expected }) => {
    const { mount, asset, store } = setup()
    mount()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.reference'] }))
    const file = new File(['media'], name, { type })
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: [file] } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull(); expect(asset).toHaveBeenCalledOnce() })
    const request = fetcher.mock.calls.find(([path]) => path === '/credits/api/assets')
    expect(new Headers(request?.[1]?.headers).get('content-type')).toBe(expected)
    expect(request?.[1]?.body).toBe(file)
    expect(store.getSnapshot().slots[slot][0]?.name).toBe(name)
  })

  it.each(['INVALID_REQUEST', 'AUTH', 'QUOTA', 'UNRECOGNIZED_ERROR'])('replaces %s diagnostics with safe copy without resubmitting generation', async (code) => {
    const { mount, task, store } = setup()
    const message = '400 {"reasoning_content":"private-id", "path":"C:/internal/key"}'
    task.mockResolvedValueOnce(json({ ok: false, code, message }))
    const view = mount()
    await ready()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    expect((await screen.findByRole('alert')).textContent).toBe(zh.serverBusy)
    expect(view.container.textContent).not.toContain(message)
    expect(view.container.textContent).not.toContain(code)
    expect(view.container.textContent).not.toContain('private-id')
    expect(store.getSnapshot().prompt).toBe('A continuous tracking shot')
    expect(task).toHaveBeenCalledOnce()
  })

  it('names a failed video upload without exposing its server diagnostics', async () => {
    const { mount, asset } = setup()
    asset.mockResolvedValueOnce(json({ ok: false, code: 'PRIVATE_CODE', message: 'internal upstream route' }))
    const view = mount()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.reference'] }))
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: [new File(['video'], '客户素材.mp4', { type: 'video/mp4' })] } })
    expect((await screen.findByRole('alert')).textContent).toBe(t('uploadItemFailed', { name: '客户素材.mp4', reason: zh.serverBusy }))
    expect(view.container.textContent).not.toContain('PRIVATE_CODE')
    expect(view.container.textContent).not.toContain('internal upstream route')
  })

  it('retains six converted reference images and uses normalized previews and byte counts for video and AI writing', async () => {
    const { mount, asset, store, props, task } = setup({ maxReferenceImages: 6, frameSlots: 0 })
    let sequence = 0
    asset.mockImplementation(async () => {
      const assetId = `ma_converted${String(++sequence)}`
      return json({ ok: true, asset: { assetId, contentType: 'image/jpeg', sizeBytes: 1024 * 1024,
        previewUrl: `/credits/api/assets/preview?asset_id=${assetId}`, converted: true, firstFrameOnly: sequence === 5 } })
    })
    const files = ['heic', 'avif', 'bmp', 'tiff', 'gif', 'webp'].map((format, index) => {
      const file = new File(['original'], `参考${String(index + 1)}.${format}`, { type: index % 2 === 0 ? '' : `image/${format}` })
      Object.defineProperty(file, 'size', { value: 7 * 1024 * 1024 })
      return file
    })
    mount()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.reference'] }))
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull(); expect(asset).toHaveBeenCalledTimes(6) })
    const references = store.getSnapshot().slots.image
    expect(references).toHaveLength(6)
    expect(references.map(reference => reference.name)).toEqual(files.map(file => file.name))
    expect(references.map(reference => reference.bytes)).toEqual(Array.from({ length: 6 }, () => 1024 * 1024))
    for (const reference of references) {
      expect(reference.url).toBe(`/credits/api/assets/preview?asset_id=${reference.assetId}`)
      expect(screen.getByAltText(reference.name).getAttribute('src')).toBe(reference.url)
    }
    expect(props.createPreview).not.toHaveBeenCalled()
    expect(screen.getByText(zh.firstFrameOnly)).toBeTruthy()
    expect(screen.getAllByText(zh.imageConverted)).toHaveLength(5)
    const assistant = vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner
    expect(assistant.references).toEqual(references.map(reference => reference.assetId))
    expect(assistant.disabled).toBe(false)
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(task).toHaveBeenCalledOnce() })
    expect(requestBody(task.mock.calls[0]?.[0]).referenceImages).toEqual(references.map(reference => reference.assetId))
  })

  it('continues after corrupt and disconnected image uploads and retains every failed filename', async () => {
    const { mount, store, asset } = setup({ maxReferenceImages: 3, frameSlots: 0 })
    const accepted = (assetId: string) => json({ ok: true, asset: { assetId, contentType: 'image/jpeg', sizeBytes: 100,
      previewUrl: `/credits/api/assets/preview?asset_id=${assetId}`, converted: true, firstFrameOnly: false } })
    asset.mockResolvedValueOnce(accepted('ma_first')).mockResolvedValueOnce(json({ ok: false, code: 'IMAGE_DECODE_FAILED' }))
      .mockRejectedValueOnce(new Error('fixture upload disconnected')).mockResolvedValueOnce(accepted('ma_last'))
    mount()
    await ready()
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: ['first.heic', 'broken.heic', 'offline.bmp', 'last.tiff']
      .map(name => new File(['original'], name, { type: '' })) } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull(); expect(asset).toHaveBeenCalledTimes(4) })
    expect(store.getSnapshot().slots.image.map(reference => reference.assetId)).toEqual(['ma_first', 'ma_last'])
    expect(store.getSnapshot().uploadFailures).toEqual([
      { name: 'broken.heic', reason: zh.invalidImage }, { name: 'offline.bmp', reason: zh.uploadNetwork },
    ])
    expect(screen.getByRole('alert').textContent).toContain(t('uploadItemFailed', { name: 'broken.heic', reason: zh.invalidImage }))
    expect(screen.getByRole('alert').textContent).toContain(t('uploadItemFailed', { name: 'offline.bmp', reason: zh.uploadNetwork }))
  })

  it('uses normalized first and last frame images without rejecting original images above six MiB', async () => {
    const { mount, store, asset, task, props } = setup()
    let sequence = 0
    asset.mockImplementation(async () => {
      const assetId = `ma_frame${String(++sequence)}`
      return json({ ok: true, asset: { assetId, contentType: 'image/png', sizeBytes: 2 * 1024 * 1024,
        previewUrl: `/credits/api/assets/preview?asset_id=${assetId}`, converted: true, firstFrameOnly: sequence === 2 } })
    })
    const file = new File(['original'], '手机照片.heic', { type: '' })
    Object.defineProperty(file, 'size', { value: 14 * 1024 * 1024 })
    mount()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.frames'] }))
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: [file] } })
    await waitFor(() => { expect(store.getSnapshot().firstFrame?.assetId).toBe('ma_frame1') })
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: [file] } })
    await waitFor(() => { expect(store.getSnapshot().slots.image).toHaveLength(2) })
    fireEvent.change(screen.getByRole('combobox', { name: zh.lastFrame }), { target: { value: 'ma_frame2' } })
    await waitFor(() => { expect(store.getSnapshot().lastFrame?.assetId).toBe('ma_frame2'); expect(store.getSnapshot().uploading).toBeNull() })
    expect(store.getSnapshot().firstFrame).toMatchObject({ bytes: 2 * 1024 * 1024, url: '/credits/api/assets/preview?asset_id=ma_frame1' })
    expect(store.getSnapshot().lastFrame).toMatchObject({ bytes: 2 * 1024 * 1024, firstFrameOnly: true })
    expect(screen.getByText(zh.imageConverted)).toBeTruthy()
    expect(screen.getByText(zh.firstFrameOnly)).toBeTruthy()
    expect(props.createPreview).not.toHaveBeenCalled()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(task).toHaveBeenCalledOnce() })
    expect(requestBody(task.mock.calls[0]?.[0]).frameImages).toEqual(['ma_frame1', 'ma_frame2'])
  })

  it('counts normalized image bytes across frame and reference slots and continues with a later smaller image', async () => {
    const { mount, asset, store } = setup({ maxReferenceImages: 6 })
    store.actions.patch({ firstFrame: { assetId: 'ma_saved', name: 'saved.png', url: 'blob:saved', bytes: 5 * 1024 * 1024 } })
    let sequence = 0
    asset.mockImplementation(async () => {
      const index = sequence++
      const assetId = `ma_total${String(index)}`
      return json({ ok: true, asset: { assetId, contentType: 'image/jpeg', sizeBytes: [6, 2, 1][index]! * 1024 * 1024,
        previewUrl: `/credits/api/assets/preview?asset_id=${assetId}` } })
    })
    mount()
    await ready()
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: ['large.heic', 'excess.heic', 'small.heic']
      .map(name => new File(['original'], name, { type: '' })) } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull(); expect(asset).toHaveBeenCalledTimes(3) })
    expect(store.getSnapshot().slots.image.map(reference => reference.assetId)).toEqual(['ma_total0', 'ma_total2'])
    expect(store.getSnapshot().firstFrame?.assetId).toBe('ma_saved')
    expect(store.getSnapshot().uploadFailures).toEqual([{ name: 'excess.heic', reason: t('materialTotalExceeded', { retained: '11.00', added: '2.00' }) }])
  })

  it.each(['https://other.invalid/image.jpg', 'data:image/jpeg;base64,AAAA', '/credits/api/assets/preview?asset_id=ma_other'])(
    'refuses a converted image with an unexpected preview URL: %s', async (previewUrl) => {
      const { mount, asset, store, props } = setup()
      asset.mockResolvedValueOnce(json({ ok: true, asset: { assetId: 'ma_valid', contentType: 'image/jpeg', sizeBytes: 128, previewUrl } }))
      mount()
      await ready()
      fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: [new File(['original'], 'photo.heic', { type: '' })] } })
      await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull(); expect(asset).toHaveBeenCalledOnce() })
      expect(store.getSnapshot().slots.image).toEqual([])
      expect(store.getSnapshot().uploadFailures).toEqual([{ name: 'photo.heic', reason: zh.invalidUploadResponse }])
      expect(props.createPreview).not.toHaveBeenCalled()
    },
  )

  it.each(['人物参考.png', 'take%1.png'])('encodes reference upload names for the shared asset contract: %s', async (name) => {
    const { mount, asset, store } = setup()
    mount()
    await ready()
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: [new File(['image'], name, { type: 'image/png' })] } })
    await waitFor(() => { expect(asset).toHaveBeenCalledOnce(); expect(store.getSnapshot().uploading).toBeNull() })
    const request = fetcher.mock.calls.find(([path]) => path === '/credits/api/assets')
    const headers = new Headers(request?.[1]?.headers)
    expect(headers.get('x-file-name')).toBe(encodeURIComponent(name))
    expect(decodeURIComponent(headers.get('x-file-name') ?? '')).toBe(name)
    expect(store.getSnapshot().slots.image[0]?.name).toBe(name)
  })

  it('keeps only image/video modes while linking generated clips to the selected conversation', async () => {
    chatSessionId = 'session-selected'
    const { mount, task, props, store } = setup()
    mount()
    await ready()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(task).toHaveBeenCalledOnce(); expect(store.getSnapshot().phase).toBe('idle') })
    expect(requestBody(task.mock.calls[0]?.[0])).toMatchObject({ session_id: 'session-selected', account_id: 'account-a' })
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([zh['tab.image'], zh['tab.video']])
    expect(vi.mocked(props.renderFactorySlot).mock.calls.every(([name]) => name === 'creation.prompt.assist')).toBe(true)
    expect(screen.queryByRole('region', { name: '创作项目' })).toBeNull()
  })

  it('keeps a pending generation owned by its original conversation after switching chats', async () => {
    const { mount, props, store, task } = setup()
    let finish!: (response: Response) => void
    task.mockImplementation(async () => await new Promise<Response>((resolve) => { finish = resolve }))
    const view = mount()
    await ready()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    expect(store.getSnapshot().phase).toBe('running')
    chatSessionId = 'session-b'
    view.rerender(<VideoPage {...props} />)
    expect(requestBody(task.mock.calls[0]?.[0])).toMatchObject({ session_id: 'session-a', account_id: 'account-a' })
    await act(async () => { finish(json({ ok: true, payload: { path: '/credits/media/new.mp4' } })) })
    expect(store.getSnapshot().phase).toBe('idle')
  })

  it('requires a selected conversation before starting a paid generation', async () => {
    chatSessionId = undefined
    const { mount, task } = setup()
    mount()
    await ready()
    writePrompt()
    expect(screen.getByText(zh.sessionRequired)).toBeTruthy()
    const submit = screen.getByRole('button', { name: zh.submit })
    expect(submit).toHaveProperty('disabled', true)
    fireEvent.click(submit)
    expect(task).not.toHaveBeenCalled()
  })

  it('keeps mounted workspace coordinates when selecting, previewing and downloading video history', async () => {
    const { mount, store } = setup()
    const original = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async (input, init) => input === '/artifacts/api/list'
      ? json({ items: ['mount-one', 'mount-two'].map(workspaceId => ({
        path: 'artifacts/片段.mp4', workspaceId, name: '片段.mp4', kind: 'video', mtimeMs: 8,
      })) }) : await original(input, init))
    const view = mount()
    await ready()
    const previews = await screen.findAllByRole('button', { name: t('previewNamed', { name: '片段.mp4' }) })
    expect(previews).toHaveLength(2)
    fireEvent.click(previews[1]!)
    expect(store.getSnapshot().result).toEqual({ path: 'artifacts/片段.mp4', workspaceId: 'mount-two' })
    const source = `/artifacts/api/raw?path=${encodeURIComponent('artifacts/片段.mp4')}&workspaceId=mount-two`
    expect(screen.getByRole('link', { name: zh.download }).getAttribute('href')).toBe(source)
    expect(view.container.querySelector('section[aria-label="结果"] video')?.getAttribute('src')).toBe(source)
  })

  it('uses resolution-specific duration menus and visibly corrects a previously selected duration', async () => {
    const { mount, store, task } = setup({
      durations: [5, 15, 30], resolutions: ['480p', '768p', '1080p', '2K'],
      durationByResolution: { '480p': [5, 15, 30], '768p': [5, 15, 30], '1080p': [5, 15], '2K': [5, 10] },
    })
    store.actions.patch({ duration: 30, resolution: '768p', ratio: '16:9' })
    mount()
    await ready()
    fireEvent.click(screen.getByLabelText(t('settingsTrigger', { ratio: '16:9', resolution: '768p', duration: '30' })))
    const panel = screen.getByRole('group', { name: zh.settings })
    expect(within(panel).getByRole('button', { name: '30 秒' })).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: '1080p' }))
    expect(within(panel).queryByRole('button', { name: '30 秒' })).toBeNull()
    expect(store.getSnapshot().duration).toBe(5)
    expect(screen.getByText(t('settingsAdjusted', { resolution: '1080p', duration: '5', ratio: '16:9' }))).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: '15 秒' }))
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(task).toHaveBeenCalledOnce() })
    expect(requestBody(task.mock.calls[0]?.[0])).toMatchObject({ resolution: '1080p', durationSeconds: 15 })
    expect(panel.textContent).toMatchSnapshot()
  })

  it.each(['480p', '768p', '1080p', '2K'])(
    'does not invent a 30-second option when %s is currently declared only through 15 seconds', async (resolution) => {
      setup({ durations: [5, 10, 15], resolutions: [resolution], durationByResolution: { [resolution]: [5, 10, 15] } }).mount()
      await ready()
      fireEvent.click(screen.getByLabelText(t('settingsTrigger', { ratio: '16:9', resolution, duration: '5' })))
      const panel = screen.getByRole('group', { name: zh.settings })
      expect(within(panel).getByRole('button', { name: '15 秒' })).toBeTruthy()
      expect(within(panel).queryByRole('button', { name: '30 秒' })).toBeNull()
    },
  )

  it.each(['2K', 'constructor'])(
    'refuses a missing resolution map entry %s without falling back to global durations or prototype properties', async (resolution) => {
      const { mount, task } = setup({ durations: [5, 30], resolutions: [resolution], durationByResolution: { '480p': [5, 30] } })
      mount()
      await ready()
      writePrompt()
      expect(screen.getByRole('alert').textContent).toBe(zh.settingsUnavailableForModel)
      expect(screen.getByLabelText(zh.settingsUnavailable).textContent).not.toContain('0s')
      const submit = screen.getByRole('button', { name: zh.submit })
      expect(submit).toHaveProperty('disabled', true)
      fireEvent.click(submit)
      expect(task).not.toHaveBeenCalled()
    },
  )

  it('allows adaptive ratio only for visual references sent in the active workflow', async () => {
    const { mount, store, task } = setup({ ratios: ['16:9', 'adaptive'] })
    store.actions.patch({ ratio: 'adaptive', slots: { audio: [], video: [], image: [
      { assetId: 'ma_visual', name: 'visual.png', url: 'blob:visual', bytes: 1 },
    ] } })
    mount()
    await ready()
    expect(store.getSnapshot().ratio).toBe('16:9')
    fireEvent.click(screen.getByLabelText(t('settingsTrigger', { ratio: '16:9', resolution: '720p', duration: '5' })))
    const adaptive = screen.getByRole('button', { name: t('ratioOption', { ratio: zh.ratioAdaptive }) })
    expect(adaptive).toHaveProperty('disabled', true)
    expect(screen.getByText(zh.adaptiveNeedsVisual)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.reference'] }))
    expect(adaptive).toHaveProperty('disabled', false)
    fireEvent.click(adaptive)
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(task).toHaveBeenCalledOnce() })
    expect(requestBody(task.mock.calls[0]?.[0])).toMatchObject({ ratio: 'adaptive', referenceImages: ['ma_visual'] })
    await waitFor(() => { expect(store.getSnapshot().phase).toBe('idle') })
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.text'] }))
    expect(store.getSnapshot().ratio).toBe('16:9')
    expect(screen.getByText(t('settingsAdjusted', { resolution: '720p', duration: '5', ratio: '16:9' }))).toBeTruthy()
  })

  it('keeps ten model-declared reference images while disabling AI writing above its separate nine-image limit', async () => {
    const { mount, props, store, task, asset } = setup({ maxReferenceImages: 10, frameSlots: 0 })
    let id = 0
    asset.mockImplementation(async () => json({ ok: true, asset: { assetId: `ma_${++id}` } }))
    mount()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.reference'] }))
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: Array.from({ length: 10 }, (_, index) =>
      new File(['image'], `${index}.png`, { type: 'image/png' })) } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull(); expect(asset).toHaveBeenCalledTimes(10) })
    expect(store.getSnapshot().slots.image).toHaveLength(10)
    expect(screen.getByLabelText(zh.addMedia)).toHaveProperty('disabled', false)
    const assistant = vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner
    expect(assistant.disabled).toBe(true)
    expect(assistant.references).toHaveLength(10)
    expect(screen.getByText(zh.assistReferenceLimit)).toBeTruthy()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(task).toHaveBeenCalledOnce() })
    expect(requestBody(task.mock.calls[0]?.[0]).referenceImages).toEqual(Array.from({ length: 10 }, (_, index) => `ma_${index + 1}`))
  })

  it('keeps all nine H3 image references available to AI writing', async () => {
    const { mount, props, store, asset } = setup({ maxReferenceImages: 9 })
    let id = 0
    asset.mockImplementation(async () => json({ ok: true, asset: { assetId: `ma_material${String(++id)}` } }))
    mount()
    await ready()
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: Array.from({ length: 9 }, (_, index) =>
      new File(['image'], `reference-${String(index + 1)}.png`, { type: 'image/png' })) } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull(); expect(asset).toHaveBeenCalledTimes(9) })
    const assistant = vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner
    expect(assistant.references).toEqual(Array.from({ length: 9 }, (_, index) => `ma_material${String(index + 1)}`))
    expect(assistant.disabled).toBe(false)
    expect(screen.queryByText(zh.assistReferenceLimit)).toBeNull()
  })

  it('uploads, previews, removes and submits only active model-supported audio references', async () => {
    const { mount, props, store, task, asset } = setup({ maxReferenceAudios: 2 })
    store.actions.patch({ workflow: 'reference', slots: { audio: [], video: [], image: [
      { assetId: 'ma_visual', name: 'visual.png', url: 'blob:visual', bytes: 1 },
    ] } })
    let id = 0
    asset.mockImplementation(async () => json({ ok: true, asset: { assetId: `ma_audio_${++id}` } }))
    mount()
    await ready()
    const input = screen.getByLabelText(zh.addMedia)
    expect(input.getAttribute('accept')).toContain('audio/mpeg,audio/wav,.mp3,.wav')
    fireEvent.change(input, { target: { files: [new File(['ID3'], 'one.mp3', { type: 'audio/mpeg' }),
      new File(['RIFFWAVE'], 'two.wav', { type: 'audio/wav' })] } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull(); expect(asset).toHaveBeenCalledTimes(2) })
    expect(screen.getByLabelText(t('audioPreview', { name: 'one.mp3' })).tagName).toBe('AUDIO')
    expect(screen.getByLabelText(t('audioPreview', { name: 'two.wav' })).getAttribute('src')).toBe('blob:two.wav')
    expect(input).toHaveProperty('disabled', false)
    const uploadHeaders = fetcher.mock.calls.filter(([path]) => path === '/credits/api/assets')
      .map(([, init]) => init?.headers)
    expect(uploadHeaders).toMatchObject([{ 'content-type': 'audio/mpeg' }, { 'content-type': 'audio/wav' }])
    fireEvent.click(screen.getByRole('button', { name: t('removeNamed', { name: 'one.mp3' }) }))
    expect(props.releasePreview).toHaveBeenCalledWith('blob:one.mp3')
    expect(input).toHaveProperty('disabled', false)
    expect(screen.queryByLabelText(t('audioPreview', { name: 'one.mp3' }))).toBeNull()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(task).toHaveBeenCalledOnce() })
    expect(requestBody(task.mock.calls[0]?.[0])).toMatchObject({ referenceImages: ['ma_visual'], referenceAudios: ['ma_audio_2'] })
    await waitFor(() => { expect(store.getSnapshot().phase).toBe('idle') })
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.text'] }))
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(task).toHaveBeenCalledTimes(2) })
    expect(requestBody(task.mock.calls[1]?.[0]).referenceAudios).toEqual([])
    expect(store.getSnapshot().slots.audio.map(item => item.assetId)).toEqual(['ma_audio_2'])
  })

  it('accepts declared audio references alone while keeping adaptive ratio unavailable without visual media', async () => {
    const { mount, store, task } = setup({ ratios: ['16:9', 'adaptive'] })
    store.actions.patch({ workflow: 'reference', slots: { image: [], video: [], audio: [
      { assetId: 'ma_audio', name: 'voice.mp3', url: 'blob:voice', bytes: 1 },
    ] } })
    mount()
    await ready()
    writePrompt()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByLabelText(t('settingsTrigger', { ratio: '16:9', resolution: '720p', duration: '5' })))
    expect(screen.getByRole('button', { name: t('ratioOption', { ratio: zh.ratioAdaptive }) })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(task).toHaveBeenCalledOnce() })
    expect(requestBody(task.mock.calls[0]?.[0])).toMatchObject({ referenceAudios: ['ma_audio'], referenceVideos: [], ratio: '16:9' })
  })

  it('keeps unsupported audio removable after switching models while hiding its upload input', async () => {
    const { mount, store, task } = setup()
    const baseFetch = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async (input, init) => input === '/credits/api/media/catalog'
      ? json({ ok: true, payload: { video: [
        { id: 'video-real', displayName: 'Real video model', source: 'live', verified: true, params },
        { id: 'no-audio', displayName: 'No audio model', source: 'live', verified: true, params: { ...params, maxReferenceAudios: 0 } },
      ] } }) : await baseFetch(input, init))
    store.actions.patch({ workflow: 'reference', slots: { image: [], video: [], audio: [
      { assetId: 'ma_audio', name: 'voice.mp3', url: 'blob:voice', bytes: 1 },
    ] } })
    mount()
    await ready()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.model }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'No audio model' }))
    expect(screen.queryByLabelText(zh.referenceAudios)).toBeNull()
    expect(screen.getByLabelText(t('audioPreview', { name: 'voice.mp3' }))).toBeTruthy()
    expect(screen.getByText(zh.unsupportedReferencesRetained)).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: t('removeNamed', { name: 'voice.mp3' }) }))
    expect(store.getSnapshot().slots.audio).toEqual([])
    expect(screen.queryByText(zh.unsupportedReferencesRetained)).toBeNull()
    expect(task).not.toHaveBeenCalled()
  })

  it('keeps audio previews account-owned and rejects a request whose active references exceed the byte budget', async () => {
    const { mount, props, store, task } = setup({ maxReferenceAudios: 3, maxReferenceVideos: 1 })
    store.actions.patch({ workflow: 'reference', slots: { image: [],
      audio: [{ assetId: 'ma_audio', name: 'voice.wav', url: 'blob:voice', bytes: 15 * 1024 * 1024 }],
      video: [{ assetId: 'ma_video', name: 'clip.mp4', url: 'blob:clip', bytes: 34 * 1024 * 1024 }],
    } })
    mount()
    await ready()
    writePrompt()
    expect(screen.getByRole('alert').textContent).toBe(zh.referenceBytesExceeded)
    expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', true)
    expect(task).not.toHaveBeenCalled()
    sessionAccountId = 'account-b'
    fireEvent.focus(window)
    await waitFor(() => { expect(store.getSnapshot().referenceAccountId).toBe('account-b') })
    expect(store.getSnapshot().slots.audio).toEqual([])
    expect(props.releasePreview).toHaveBeenCalledWith('blob:voice')
    expect(screen.queryByLabelText(t('audioPreview', { name: 'voice.wav' }))).toBeNull()
  })

  it.each(['empty', 'oversize', 'unsupported', 'network'] as const)(
    'shows an audio %s upload failure and restores the controls without discarding earlier audio', async (failure) => {
      const { mount, store, asset } = setup({ maxReferenceAudios: 2 })
      store.actions.patch({ workflow: 'reference', slots: { image: [], video: [], audio: [
        { assetId: 'ma_retained', name: 'retained.mp3', url: 'blob:retained', bytes: 1 },
      ] } })
      if (failure === 'network') asset.mockRejectedValueOnce(new Error('fixture audio connection lost'))
      mount()
      await ready()
      const file = failure === 'empty' ? new File([], 'empty.wav', { type: 'audio/wav' })
        : failure === 'oversize' ? new File([new Uint8Array(15 * 1024 * 1024 + 1)], 'large.mp3', { type: 'audio/mpeg' })
          : failure === 'unsupported' ? new File(['audio'], 'track.m4a', { type: 'audio/mp4' })
            : new File(['audio'], 'new.mp3', { type: 'audio/mpeg' })
      fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: [file] } })
      await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull(); expect(screen.getByRole('alert')).toBeTruthy() })
      expect(store.getSnapshot().slots.audio.map(item => item.assetId)).toEqual(['ma_retained'])
      expect(screen.getByLabelText(zh.addMedia)).toHaveProperty('disabled', false)
      expect(asset).toHaveBeenCalledTimes(failure === 'network' ? 1 : 0)
    },
  )

  it.each(['direct', 'enveloped'] as const)('retains saved clips after malformed artifact records in a %s refresh', async (format) => {
    const { mount } = setup()
    const baseFetch = fetcher.getMockImplementation()!
    let items: unknown[] = [
      { path: '/Users/user/chosen-videos/older.mp4', name: 'older.mp4', kind: 'video', mtimeMs: 1 },
      { path: 'D:\\云枢产物\\newer.mp4', name: 'newer.mp4', kind: 'video', mtimeMs: 2 },
      { path: 'D:\\云枢产物\\image.png', name: 'image.png', kind: 'image', mtimeMs: 3 },
    ]
    fetcher.mockImplementation(async (input, init) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return path === '/artifacts/api/list'
        ? json(format === 'direct' ? { items } : { payload: { items } })
        : await baseFetch(input, init)
    })
    mount()
    await ready()
    const history = screen.getByRole('region', { name: zh.history })
    await waitFor(() => {
      expect(within(history).getAllByRole('listitem').map(item => item.textContent)).toEqual(['newer.mp4', 'older.mp4'])
    })
    items = [null]
    fireEvent.click(within(history).getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(within(history).getByRole('alert').textContent).toBe(zh.historyFailed) })
    expect(within(history).getAllByRole('listitem').map(item => item.textContent)).toEqual(['newer.mp4', 'older.mp4'])
  })

  it('opens the parameter panel and updates the compact summary from supported choices', async () => {
    const { store, mount, task } = setup({ durations: Array.from({ length: 12 }, (_, index) => index + 1) })
    store.actions.patch({ duration: 5 })
    mount()
    await ready()
    const trigger = screen.getByLabelText(t('settingsTrigger', { ratio: '16:9', resolution: '720p', duration: '5' }))
    expect(trigger.tagName).toBe('SUMMARY')
    expect(trigger.closest('details')).toHaveProperty('open', false)
    fireEvent.click(trigger)
    expect(trigger.closest('details')).toHaveProperty('open', true)
    const panel = screen.getByRole('group', { name: zh.settings })
    expect(within(panel).getAllByRole('group').map(group => group.querySelector('legend')?.textContent))
      .toEqual([zh.ratio, zh.resolution, zh.duration, zh.mode])
    fireEvent.click(within(panel).getByRole('button', { name: t('ratioOption', { ratio: '9:16' }) }))
    fireEvent.click(within(panel).getByRole('button', { name: '1080p' }))
    fireEvent.click(within(panel).getByRole('button', { name: '12 秒' }))
    expect(store.getSnapshot()).toMatchObject({ ratio: '9:16', resolution: '1080p', duration: 12 })
    expect(screen.getByLabelText(t('settingsTrigger', { ratio: '9:16', resolution: '1080p', duration: '12' })))
      .toHaveProperty('textContent', expect.stringContaining('1080p'))
    expect(within(panel).getByRole('button', { name: t('ratioOption', { ratio: '9:16' }) }).getAttribute('aria-pressed')).toBe('true')
    expect(panel.textContent).toMatchSnapshot()
    fireEvent.click(trigger)
    expect(trigger.closest('details')).toHaveProperty('open', false)
    expect(task).not.toHaveBeenCalled()
  })

  it('keeps unavailable model settings closed without showing a zero duration', async () => {
    const { mount } = setup()
    const defaultFetcher = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async (input, init) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url) === '/credits/api/media/catalog'
      ? json({ ok: true, payload: { video: [] } }) : await defaultFetcher(input, init))
    mount()
    await screen.findByText(zh.noModel)
    const trigger = screen.getByLabelText(zh.settingsUnavailable)
    expect(trigger.getAttribute('aria-disabled')).toBe('true')
    expect(trigger.textContent).not.toContain('0秒')
    fireEvent.click(trigger)
    expect(trigger.closest('details')).toHaveProperty('open', false)
  })

  it('shows only legal parameters after a model switch and uses them in the request', async () => {
    const { mount, store, task } = setup()
    const defaultFetcher = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async (input, init) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url) === '/credits/api/media/catalog'
      ? json({ ok: true, payload: { video: [
        { id: 'video-real', displayName: 'Real video model', source: 'local-config', verified: true, params },
        { id: 'video-limited', displayName: 'Limited video model', source: 'local-config', verified: true,
          params: { ...params, durations: [4], resolutions: ['768P'], ratios: ['1:1'], audio: false, audioToggle: false, modes: [], seed: false } },
      ] } }) : await defaultFetcher(input, init))
    mount()
    await ready()
    act(() => { store.actions.patch({ duration: 10, resolution: '1080p', ratio: '9:16' }) })
    fireEvent.click(screen.getByRole('button', { name: zh.model }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Limited video model' }))
    const trigger = screen.getByLabelText(t('settingsTrigger', { ratio: '1:1', resolution: '768P', duration: '4' }))
    fireEvent.click(trigger)
    const panel = screen.getByRole('group', { name: zh.settings })
    expect(within(panel).queryByRole('button', { name: '1080p' })).toBeNull()
    expect(within(panel).queryByRole('switch')).toBeNull()
    expect(within(panel).getByText(zh.audioFixedOff)).toBeTruthy()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(task).toHaveBeenCalledOnce() })
    const request = task.mock.calls[0]?.[0]?.body
    if (typeof request !== 'string') throw new Error('Expected video JSON body')
    expect(JSON.parse(request)).toMatchObject({ durationSeconds: 4, resolution: '768P', ratio: '1:1' })
    expect(JSON.parse(request)).not.toHaveProperty('audio')
  })

  it.each([true, false])('explains a model-fixed audio state without offering a switch: %s', async (audio) => {
    setup({ audio, audioToggle: false }).mount()
    await ready()
    fireEvent.click(screen.getByLabelText(t('settingsTrigger', { ratio: '16:9', resolution: '720p', duration: '5' })))
    const panel = screen.getByRole('group', { name: zh.settings })
    expect(within(panel).queryByRole('switch')).toBeNull()
    expect(within(panel).getByText(audio ? zh.audioFixedOn : zh.audioFixedOff)).toBeTruthy()
  })

  it.each(['account-b', null])('clears every media arrangement after the live account becomes %s', async (nextAccount) => {
    const { props, store, mount } = setup()
    store.actions.patch({ workflow: 'frames', firstFrame: { assetId: 'ma_first', name: 'first.png', url: 'blob:first', bytes: 1 },
      lastFrame: { assetId: 'ma_last', name: 'last.png', url: 'blob:last', bytes: 1 },
      slots: { audio: [], image: [{ assetId: 'ma_image', name: 'image.png', url: 'blob:image', bytes: 1 }], video: [{ assetId: 'ma_video', name: 'video.mp4', url: 'blob:video', bytes: 1 }] } })
    mount()
    expect((vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner).references).toEqual([])
    await ready()
    sessionAccountId = nextAccount
    fireEvent.focus(window)
    await waitFor(() => { expect(store.getSnapshot().referenceAccountId).toBe(nextAccount) })
    expect(store.getSnapshot()).toMatchObject({ firstFrame: null, lastFrame: null, slots: { audio: [], image: [], video: [] } })
    for (const url of ['blob:first', 'blob:last', 'blob:image', 'blob:video']) expect(props.releasePreview).toHaveBeenCalledWith(url)
    expect((vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner).references).toEqual([])
  })

  it.each(['account-a', 'account-b'])('retains frame ownership across remounts only for the same account: %s', async (nextAccount) => {
    const { props, store, mount } = setup()
    store.actions.patch({ workflow: 'image', firstFrame: { assetId: 'ma_first', name: 'first.png', url: 'blob:first', bytes: 1 } })
    const first = mount()
    await ready()
    first.unmount()
    sessionAccountId = nextAccount
    mount()
    expect((vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner).references).toEqual([])
    await ready()
    expect(store.getSnapshot().firstFrame?.assetId ?? null).toBe(nextAccount === 'account-a' ? 'ma_first' : null)
    expect(props.releasePreview).toHaveBeenCalledTimes(nextAccount === 'account-a' ? 0 : 1)
  })

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    'ignores a previous account upload without overwriting the current upload (failure: %s, switch back: %s)', async (fails, switchBack) => {
      let resolveOld!: (response: Response) => void
      let rejectOld!: (error: Error) => void
      let resolveNew!: (response: Response) => void
      const oldUpload = new Promise<Response>((resolve, reject) => { resolveOld = resolve; rejectOld = reject })
      const newUpload = new Promise<Response>((resolve) => { resolveNew = resolve })
      const { props, store, mount, asset } = setup()
      asset.mockImplementationOnce(async () => await oldUpload).mockImplementationOnce(async () => await newUpload)
      mount()
      await ready()
      fireEvent.click(screen.getByRole('button', { name: zh['workflow.reference'] }))
      const pick = (name: string) => { fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: [new File(['image'], name, { type: 'image/png' })] } }) }
      pick('old.png')
      sessionAccountId = 'account-b'
      fireEvent.focus(window)
      await waitFor(() => { expect(store.getSnapshot().referenceAccountId).toBe('account-b') })
      if (switchBack) {
        sessionAccountId = 'account-a'
        fireEvent.focus(window)
        await waitFor(() => { expect(store.getSnapshot().referenceAccountId).toBe('account-a') })
      }
      pick('new.png')
      act(() => { store.actions.patch({ failure: 'new account feedback' }) })
      await act(async () => { if (fails) rejectOld(new Error('old upload failed')); else resolveOld(json({ ok: true, asset: { assetId: 'ma_old' } })) })
      expect(store.getSnapshot()).toMatchObject({ uploading: 'materials', failure: 'new account feedback', slots: { audio: [], image: [], video: [] } })
      expect(props.createPreview).not.toHaveBeenCalled()
      await act(async () => { resolveNew(json({ ok: true, asset: { assetId: 'ma_new' } })) })
      expect(store.getSnapshot().slots.image.map(item => item.assetId)).toEqual(['ma_new'])
      expect(store.getSnapshot().uploading).toBeNull()
    })

  it('checks the live reference owner before sending a paid video request', async () => {
    const { store, mount, task } = setup()
    store.actions.patch({ prompt: 'Private product', workflow: 'image', firstFrame: { assetId: 'ma_first', name: 'first.png', url: 'blob:first', bytes: 1 } })
    mount()
    await ready()
    sessionAccountId = 'account-b'
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', zh.referenceAccountChanged)
    expect(store.getSnapshot()).toMatchObject({ referenceAccountId: 'account-b', firstFrame: null, phase: 'idle' })
    expect(task).not.toHaveBeenCalled()
  })

  it('does not replace a new account frame with a late frame upload', async () => {
    let resolveOld!: (response: Response) => void
    let resolveNew!: (response: Response) => void
    const oldUpload = new Promise<Response>((resolve) => { resolveOld = resolve })
    const newUpload = new Promise<Response>((resolve) => { resolveNew = resolve })
    const { store, mount, asset } = setup()
    asset.mockImplementationOnce(async () => await oldUpload).mockImplementationOnce(async () => await newUpload)
    mount()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.image'] }))
    const pickFrame = (name: string) => { fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: [new File(['image'], name, { type: 'image/png' })] } }) }
    pickFrame('old.png')
    sessionAccountId = 'account-b'
    fireEvent.focus(window)
    await waitFor(() => { expect(store.getSnapshot().referenceAccountId).toBe('account-b') })
    pickFrame('new.png')
    await act(async () => { resolveOld(json({ ok: true, asset: { assetId: 'ma_old' } })) })
    expect(store.getSnapshot()).toMatchObject({ firstFrame: null, uploading: 'materials' })
    await act(async () => { resolveNew(json({ ok: true, asset: { assetId: 'ma_new' } })) })
    expect(store.getSnapshot().firstFrame?.assetId).toBe('ma_new')
    expect(store.getSnapshot().uploading).toBeNull()
  })

  it('passes all deduplicated image materials to AI help and writes text without starting a video', async () => {
    const { props, store, mount, task } = setup()
    store.actions.patch({ prompt: '原始镜头描述', firstFrame: { assetId: 'ma_first', name: 'first.png', url: 'blob:first', bytes: 1 },
      lastFrame: { assetId: 'ma_last', name: 'last.png', url: 'blob:last', bytes: 1 },
      slots: { audio: [], image: [{ assetId: 'ma_reference', name: 'reference.png', url: 'blob:reference', bytes: 1 }],
        video: [{ assetId: 'ma_video', name: 'clip.mp4', url: 'blob:clip', bytes: 1 }] } })
    mount()
    await ready()
    const assistant = (): PromptAssistOwner =>
      vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner
    expect(assistant().references).toEqual(['ma_first', 'ma_last', 'ma_reference'])
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.image'] }))
    expect(assistant().references).toEqual(['ma_first', 'ma_last', 'ma_reference'])
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.frames'] }))
    expect(assistant().references).toEqual(['ma_first', 'ma_last', 'ma_reference'])
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.reference'] }))
    expect(assistant()).toMatchObject({ kind: 'video', prompt: '原始镜头描述', references: ['ma_first', 'ma_last', 'ma_reference'], accountIdentity: 'account-a', generation: { workflow: 'reference' } })
    act(() => { assistant().onPromptChange('用户确认后的镜头提示词', '原始镜头描述') })
    expect(store.getSnapshot().prompt).toBe('用户确认后的镜头提示词')
    expect(task).not.toHaveBeenCalled()
  })

  it('does not replace a video prompt while a media request is running', async () => {
    const { props, store, mount } = setup()
    store.actions.patch({ prompt: '正在使用的镜头描述' })
    mount()
    await ready()
    act(() => { store.actions.patch({ phase: 'running', startedAt: Date.now() }) })
    const assistant = vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner
    expect(assistant.disabled).toBe(true)
    act(() => { assistant.onPromptChange('不能覆盖', '正在使用的镜头描述') })
    expect(store.getSnapshot().prompt).toBe('正在使用的镜头描述')
  })

  it.each(['prompt', 'material', 'settings', 'account'])('rejects late AI writing after a %s change', async (change) => {
    const { props, store, mount } = setup()
    store.actions.patch({ prompt: 'Original scene' })
    mount()
    await ready()
    const assistant = vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner
    act(() => {
      if (change === 'prompt') store.actions.patch({ prompt: 'My scene edit' })
      if (change === 'material') store.actions.patch({ firstFrame: { assetId: 'ma_new', name: 'new.png', url: 'blob:new', bytes: 1 } })
      if (change === 'settings') store.actions.patch({ seed: '42' })
      if (change === 'account') store.actions.setReferenceAccount('account-b')
    })
    let accepted = true
    act(() => { accepted = assistant.onPromptChange('Late result', 'Original scene') })
    expect(accepted).toBe(false)
    expect(store.getSnapshot().prompt).toBe(change === 'prompt' ? 'My scene edit' : 'Original scene')
  })

  it('blocks uploads, generation and settings during AI writing while preserving prompt edits', async () => {
    const { props, store, mount, asset } = setup()
    store.actions.patch({ prompt: 'Original scene' })
    mount()
    await ready()
    const assistant = vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner
    act(() => { assistant.onBusyChange(true) })
    expect((vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner).disabled).toBe(false)
    expect(screen.getByLabelText(zh.addMedia)).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: zh.model })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', true)
    const settings = screen.getByLabelText(t('settingsTrigger', { ratio: '16:9', resolution: '720p', duration: '5' }))
    expect(settings.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(settings)
    expect(settings.closest('details')).toHaveProperty('open', false)
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: [new File(['image'], 'blocked.png', { type: 'image/png' })] } })
    expect(asset).not.toHaveBeenCalled()
    writePrompt()
    expect(store.getSnapshot().prompt).toBe('A continuous tracking shot')
    act(() => { assistant.onBusyChange(false) })
    expect(screen.getByLabelText(zh.addMedia)).toHaveProperty('disabled', false)
  })

  it('uploads materials even for text-only models and deduplicates retained frame images for AI writing', async () => {
    const { props, store, mount, asset } = setup({ frameSlots: 0, maxReferenceImages: 0, maxReferenceVideos: 0, maxReferenceAudios: 0 })
    store.actions.patch({ firstFrame: { assetId: 'ma_same', name: 'frame.png', url: 'blob:frame', bytes: 1 },
      lastFrame: { assetId: 'ma_same', name: 'frame.png', url: 'blob:frame', bytes: 1 },
      slots: { audio: [], image: [{ assetId: 'ma_same', name: 'frame.png', url: 'blob:frame', bytes: 1 }], video: [{ assetId: 'ma_video', name: 'clip.mp4', url: 'blob:clip', bytes: 1 }] } })
    mount()
    await ready()
    expect(screen.getByLabelText(zh.addMedia)).toHaveProperty('disabled', false)
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: [new File(['image'], 'new.png', { type: 'image/png' })] } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull(); expect(asset).toHaveBeenCalledOnce() })
    expect((vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner).references).toEqual(['ma_same', 'ma_image'])
    expect(store.getSnapshot().slots.video).toHaveLength(1)
  })

  it('shares the writing image count and twelve-MiB budget between frames and material images', async () => {
    const { store, mount, asset } = setup()
    store.actions.patch({ firstFrame: { assetId: 'ma_first', name: 'frame.png', url: 'blob:frame', bytes: 6 * 1024 * 1024 },
      slots: { audio: [], image: [{ assetId: 'ma_second', name: 'second.png', url: 'blob:second', bytes: 6 * 1024 * 1024 }], video: [] } })
    mount()
    await ready()
    const input = screen.getByLabelText(zh.addMedia)
    fireEvent.change(input, { target: { files: [new File(['x'], 'excess.png', { type: 'image/png' })] } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull() })
    expect(asset).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(t('uploadItemFailed', { name: 'excess.png', reason: t('materialTotalFull', { size: '12.00' }) }))
    act(() => { store.actions.patch({ firstFrame: null, slots: { audio: [], image: Array.from({ length: 9 }, (_, index) => ({ assetId: `ma_${index}`, name: 'material.png', url: `blob:${index}`, bytes: 1 })), video: [] } }) })
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.image'] }))
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: [new File(['image'], 'tenth.png', { type: 'image/png' })] } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull() })
    expect(asset).not.toHaveBeenCalled()
    expect(store.getSnapshot().firstFrame?.assetId).toBe('ma_0')
  })

  it('renders administrator content and real cover/demo assets, with empty and retry states', async () => {
    const { props, fixture, mount } = setup()
    const template = fixture.content.video.templates[0]!
    const content = { ...fixture.content, video: { ...fixture.content.video,
      title: { zh: '后台镜头库', en: 'Remote scripts' }, promptPlaceholder: { zh: '后台镜头输入' },
      categories: [...fixture.content.video.categories, { id: 'empty', label: { zh: '空分类' }, sortOrder: 9, enabled: true }],
      templates: [{ ...template, id: 'remote', categoryId: null, title: { zh: '后台实拍', en: 'Remote scene' },
        coverAssetId: 'cover-real', demoVideoAssetId: 'demo-real' },
      { ...template, id: 'draft', status: 'draft' as const, title: { zh: '未发布' } }],
    } }
    fixture.publication.set({ status: 'ready', content })
    const view = mount()
    await ready()
    expect(screen.getByRole('heading', { name: '后台镜头库' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: zh.prompt })).toHaveProperty('placeholder', '后台镜头输入')
    expect(screen.queryByText('未发布')).toBeNull()
    expect(screen.queryByText('商品出场短片')).toBeNull()
    expect(view.container.querySelector('img[src*="creation/assets"]')).toHaveProperty('src', expect.stringContaining('/credits/api/creation/assets/cover-real'))
    fireEvent.click(screen.getByRole('button', { name: '预览 后台实拍' }))
    expect(screen.getByRole('dialog').querySelector('video')).toHaveProperty('src', expect.stringContaining('/credits/api/creation/assets/demo-real'))
    expect(screen.getByRole('dialog').textContent).not.toContain('01')
    fireEvent.click(screen.getByRole('button', { name: zh.closePreview }))
    act(() => { fixture.locale.set({ ...fixture.locale.getSnapshot(), active: 'en' }) })
    expect(screen.getByRole('heading', { name: 'Remote scripts' })).toBeTruthy()
    expect(screen.getByText('Remote scene')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: zh.prompt })).toHaveProperty('placeholder', '后台镜头输入')
    fireEvent.click(screen.getByRole('button', { name: '空分类' }))
    expect(screen.getByText(zh.noTemplates, { exact: false })).toBeTruthy()
    expect(screen.queryByText(zh.contentEmpty)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.resetFilters }))
    expect(screen.getByText('Remote scene')).toBeTruthy()
    act(() => { fixture.publication.set({ status: 'error', content: null }) })
    expect(screen.queryByText('Remote scene')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain(zh.contentFailed)
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(props.refreshContent).toHaveBeenCalledOnce()
    act(() => { fixture.publication.set({ status: 'ready', content: { ...content, video: { ...content.video, templates: [], presets: [] } } }) })
    expect(screen.getByText(zh.contentEmpty)).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.resetFilters })).toBeNull()
  })

  it('shows only media arrangements declared by the selected model', async () => {
    const view = setup({ frameSlots: 0, maxReferenceImages: 0, maxReferenceVideos: 0, maxReferenceAudios: 0 }).mount()
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
    fireEvent.click(screen.getByLabelText(t('settingsTrigger', { ratio: '16:9', resolution: '720p', duration: '5' })))
    fireEvent.click(screen.getByRole('button', { name: 'pro' }))
    fireEvent.change(screen.getByPlaceholderText(zh.seedHint), { target: { value: '73' } })
    fireEvent.click(screen.getByRole('switch', { name: zh.audio }))
    const submit = screen.getByRole('button', { name: zh.submit })
    fireEvent.click(submit)
    fireEvent.click(submit)
    await waitFor(() => { expect(task).toHaveBeenCalledTimes(1) })
    expect(requestBody(task.mock.calls[0]?.[0])).toMatchObject({ mode: 'pro', seed: 73, audio: false, frameImages: [], referenceAudios: [] })
    first.unmount()
    mount()
    await ready()
    expect(screen.getByRole('textbox', { name: zh.prompt })).toHaveProperty('value', 'A continuous tracking shot')
    expect(screen.getByRole('button', { name: zh.runningShort })).toHaveProperty('disabled', true)
    await act(async () => { complete?.(json({ ok: true, payload: { path: '/credits/media/new.mp4' } })) })
    await waitFor(() => { expect(store.getSnapshot().phase).toBe('idle') })
    expect(store.getSnapshot().result?.path).toBe('/credits/media/new.mp4')
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('locks an uncertain original submission while retaining the previous clip and draft', async () => {
    const { mount, store, task } = setup()
    store.actions.patch({ result: { path: '/credits/media/previous.mp4' } })
    task.mockRejectedValueOnce(new Error('connection closed'))
    mount()
    await ready()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain(zh.originalUnknown) })
    expect(store.getSnapshot()).toMatchObject({ phase: 'idle', prompt: 'A continuous tracking shot', result: { path: '/credits/media/previous.mp4' } })
    expect(task).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', true)
  })

  it('shows accepted work as generating and queries the retained video instead of posting generation again', async () => {
    const h = setup()
    const retained = { id: 'cp_original', sessionId: 'session-a', kind: 'video', tasks: [{ id: 'op_original', status: 'running',
      videoReceipt: { taskId: 'video-original', phase: 'accepted' }, canQuery: true }] }
    h.mount()
    await ready()
    writePrompt()
    h.task.mockImplementationOnce(async () => {
      h.projects.mockImplementation(async () => json({ ok: true, payload: { accountId: 'account-a', projects: [retained] } }))
      return json({ ok: false, submission_state: 'pending', task_id: 'video-original', plan_id: 'cp_original', operation_id: 'op_original' })
    })
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.originalQuery })).toBeTruthy() })
    expect(screen.getByRole('status').textContent).toContain(zh.originalAccepted)
    expect(screen.queryByText(zh.failed)).toBeNull()
    expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', true)
    h.recover.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, payload: { accountId: 'account-a', projects: [retained] } }), { status: 202 }))
    fireEvent.click(screen.getByRole('button', { name: zh.originalQuery }))
    await waitFor(() => { expect(h.recover).toHaveBeenCalledOnce() })
    expect(h.task).toHaveBeenCalledOnce()
    const query = fetcher.mock.calls.find(call => call[0] === '/credits/api/creative/video/recover')
    expect(requestBody(query?.[1])).toEqual({ session_id: 'session-a', project_id: 'cp_original', operation_id: 'op_original' })
  })

  it('keeps successful earlier uploads when the next file fails and releases the busy state', async () => {
    const { mount, store, asset } = setup()
    asset.mockResolvedValueOnce(json({ ok: true, asset: { assetId: 'ma_first' } })).mockRejectedValueOnce(new Error('offline'))
    mount()
    await ready()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.reference'] }))
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' }), new File(['two'], 'two.png', { type: 'image/png' })] } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull(); expect(asset).toHaveBeenCalledTimes(2) })
    expect(store.getSnapshot().slots.image.map(item => item.assetId)).toEqual(['ma_first'])
    expect(screen.getByRole('alert').textContent).toBe(t('uploadItemFailed', { name: 'two.png', reason: zh.uploadNetwork }))
    expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', false)
  })

  it('retains excess material after a model switch and requires review before generation', async () => {
    const { mount, store, props, task } = setup({ maxReferenceImages: 4 })
    store.actions.patch({ workflow: 'reference', slots: { audio: [],
      image: Array.from({ length: 4 }, (_, index) => ({ assetId: `ma_${index}`, name: `image-${index}.png`, url: `blob:${index}`, bytes: 1 })), video: [],
    } })
    const view = mount()
    await ready()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: zh.model }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Smaller video model' }))
    await waitFor(() => { expect(store.getSnapshot().slots.image).toHaveLength(4) })
    expect(props.releasePreview).not.toHaveBeenCalled()
    expect(view.container.querySelectorAll('img')).toHaveLength(4)
    expect(screen.getByRole('alert').textContent).toBe(zh.referenceOverLimit)
    const generate = screen.getByRole('button', { name: zh.submit })
    expect(generate).toHaveProperty('disabled', true)
    fireEvent.click(generate)
    expect(task).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: t('removeNamed', { name: 'image-3.png' }) }))
    fireEvent.click(generate)
    await waitFor(() => { expect(task).toHaveBeenCalledTimes(1) })
    expect(requestBody(task.mock.calls[0]?.[0]).referenceImages).toEqual(['ma_0', 'ma_1', 'ma_2'])
  })

  it('requires both endpoint frames and sends no hidden frame references in text mode', async () => {
    const { mount, store, task } = setup()
    store.actions.patch({ lastFrame: { assetId: 'ma_last', name: 'last.png', url: 'blob:last', bytes: 1 } })
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
    expect(requestBody(task.mock.calls[0]?.[0]).frameImages).toEqual([])
    expect(store.getSnapshot().lastFrame?.assetId).toBe('ma_last')
  })

  it('previews a camera script, filters categories and appends it without generating', async () => {
    const { mount, store, task } = setup()
    mount()
    await ready()
    writePrompt()
    fireEvent.click(screen.getByRole('button', { name: '电影运镜' }))
    expect(screen.queryByRole('button', { name: '预览 商品出场短片' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '预览 电影感环绕' }))
    expect(screen.getByRole('dialog').textContent).toMatchSnapshot()
    fireEvent.click(screen.getByRole('button', { name: zh.useScript }))
    expect(store.getSnapshot().prompt).toBe('A continuous tracking shot\n\n后台环绕脚本')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(task).not.toHaveBeenCalled()
  })
})
