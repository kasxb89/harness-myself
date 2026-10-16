// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderFactorySlot } from '@deepseek-ai/dsh-client-ui-slots'
import type { PromptAssistOwner } from '@deepseek-ai/dsh-client-ui-prompt-assist/client'
import { bindSnapshotSelector } from '../../ui-renderer/src/client/bind.ts'
import { createVideoDraftStore } from '../src/client/draft-store.ts'
import { VideoPage } from '../src/client/VideoPage.tsx'
import { zh } from '../src/client/locales.ts'
import { contentFixture } from '../../ui-imagegen/tests/content-fixture.ts'

const params = {
  durations: [5, 10], resolutions: ['720p', '1080p'], ratios: ['16:9', '9:16'], frameSlots: 2,
  maxReferenceImages: 3, maxReferenceVideos: 1, maxReferenceAudios: 1,
  audio: true, audioToggle: true, modes: ['normal', 'pro'], seed: true,
}
const json = (value: object): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const t: Parameters<typeof VideoPage>[0]['t'] = (key, values) => zh[key].replace(/\{(\w+)\}/g, (match, name: string) => values?.[name] ?? match)
let fetcher = vi.fn<typeof fetch>()
let sessionAccountId: string | null = 'account-a'

function setup(overrides: Partial<typeof params> = {}) {
  const task = vi.fn(async (_init?: RequestInit): Promise<Response> => json({ ok: true, payload: { path: '/credits/media/new.mp4' } }))
  const asset = vi.fn(async (): Promise<Response> => json({ ok: true, asset: { assetId: 'ma_image' } }))
  fetcher = vi.fn(async (input, init) => {
    const path = String(input)
    if (path === '/credits/api/session') return json({ ok: true, payload: { signedIn: sessionAccountId !== null, creditsPerYuan: 1000, account: sessionAccountId === null ? null : { id: sessionAccountId } } })
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
  store.actions.setReferenceAccount('account-a')
  const fixture = contentFixture()
  const props = {
    useCreationContent: fixture.useCreationContent, useLocale: fixture.useLocale, refreshContent: vi.fn(),
    t, openImage: vi.fn(), createPreview: vi.fn((file: File) => `blob:${file.name}`), releasePreview: vi.fn(),
    renderFactorySlot: vi.fn<RenderFactorySlot>(() => null),
    useStore: bindSnapshotSelector(store), actions: store.actions,
    readDraft: () => store.getSnapshot(),
  } as Parameters<typeof VideoPage>[0]
  return { store, props, fixture, task, asset, mount: () => render(<VideoPage {...props} />) }
}
const ready = async (): Promise<void> => { await waitFor(() => { expect(screen.getByRole('button', { name: zh.model }).textContent).toContain('Real video model') }) }
const writePrompt = (): void => { fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: 'A continuous tracking shot' } }) }

beforeEach(() => { vi.useRealTimers(); sessionAccountId = 'account-a' })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('video composer', () => {
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
      slots: { image: [{ assetId: 'ma_image', name: 'image.png', url: 'blob:image', bytes: 1 }], video: [{ assetId: 'ma_video', name: 'video.mp4', url: 'blob:video', bytes: 1 }] } })
    mount()
    expect((vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner).references).toEqual([])
    await ready()
    sessionAccountId = nextAccount
    fireEvent.focus(window)
    await waitFor(() => { expect(store.getSnapshot().referenceAccountId).toBe(nextAccount) })
    expect(store.getSnapshot()).toMatchObject({ firstFrame: null, lastFrame: null, slots: { image: [], video: [] } })
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
      const pick = (name: string) => { fireEvent.change(screen.getByLabelText(zh.referenceImages), { target: { files: [new File(['image'], name, { type: 'image/png' })] } }) }
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
      expect(store.getSnapshot()).toMatchObject({ uploading: 'image', failure: 'new account feedback', slots: { image: [], video: [] } })
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
    const pickFrame = (name: string) => { fireEvent.change(screen.getByLabelText(zh.firstFrame), { target: { files: [new File(['image'], name, { type: 'image/png' })] } }) }
    pickFrame('old.png')
    sessionAccountId = 'account-b'
    fireEvent.focus(window)
    await waitFor(() => { expect(store.getSnapshot().referenceAccountId).toBe('account-b') })
    pickFrame('new.png')
    await act(async () => { resolveOld(json({ ok: true, asset: { assetId: 'ma_old' } })) })
    expect(store.getSnapshot()).toMatchObject({ firstFrame: null, uploading: 'first' })
    await act(async () => { resolveNew(json({ ok: true, asset: { assetId: 'ma_new' } })) })
    expect(store.getSnapshot().firstFrame?.assetId).toBe('ma_new')
    expect(store.getSnapshot().uploading).toBeNull()
  })

  it('passes all deduplicated image materials to AI help and writes text without starting a video', async () => {
    const { props, store, mount, task } = setup()
    store.actions.patch({ prompt: '原始镜头描述', firstFrame: { assetId: 'ma_first', name: 'first.png', url: 'blob:first', bytes: 1 },
      lastFrame: { assetId: 'ma_last', name: 'last.png', url: 'blob:last', bytes: 1 },
      slots: { image: [{ assetId: 'ma_reference', name: 'reference.png', url: 'blob:reference', bytes: 1 }],
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
    const { props, store, mount, asset } = setup({ frameSlots: 0, maxReferenceImages: 0, maxReferenceVideos: 0 })
    store.actions.patch({ firstFrame: { assetId: 'ma_same', name: 'frame.png', url: 'blob:frame', bytes: 1 },
      lastFrame: { assetId: 'ma_same', name: 'frame.png', url: 'blob:frame', bytes: 1 },
      slots: { image: [{ assetId: 'ma_same', name: 'frame.png', url: 'blob:frame', bytes: 1 }], video: [{ assetId: 'ma_video', name: 'clip.mp4', url: 'blob:clip', bytes: 1 }] } })
    mount()
    await ready()
    expect(screen.getByLabelText(zh.addMedia)).toHaveProperty('disabled', false)
    fireEvent.change(screen.getByLabelText(zh.addMedia), { target: { files: [new File(['image'], 'new.png', { type: 'image/png' })] } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull(); expect(asset).toHaveBeenCalledOnce() })
    expect((vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner).references).toEqual(['ma_same', 'ma_image'])
    expect(store.getSnapshot().slots.video).toHaveLength(1)
  })

  it('shares the six-image and twelve-MiB budget between frames and material images', async () => {
    const { store, mount, asset } = setup()
    store.actions.patch({ firstFrame: { assetId: 'ma_first', name: 'frame.png', url: 'blob:frame', bytes: 6 * 1024 * 1024 },
      slots: { image: [{ assetId: 'ma_second', name: 'second.png', url: 'blob:second', bytes: 6 * 1024 * 1024 }], video: [] } })
    mount()
    await ready()
    const input = screen.getByLabelText(zh.addMedia)
    fireEvent.change(input, { target: { files: [new File(['x'], 'excess.png', { type: 'image/png' })] } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull() })
    expect(asset).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(zh.materialLimit)
    act(() => { store.actions.patch({ firstFrame: null, slots: { image: Array.from({ length: 6 }, (_, index) => ({ assetId: `ma_${index}`, name: 'material.png', url: `blob:${index}`, bytes: 1 })), video: [] } }) })
    fireEvent.click(screen.getByRole('button', { name: zh['workflow.image'] }))
    fireEvent.change(screen.getByLabelText(zh.firstFrame), { target: { files: [new File(['image'], 'seventh.png', { type: 'image/png' })] } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBeNull() })
    expect(asset).not.toHaveBeenCalled()
    expect(store.getSnapshot().firstFrame).toBeNull()
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
    fireEvent.click(screen.getByLabelText(t('settingsTrigger', { ratio: '16:9', resolution: '720p', duration: '5' })))
    fireEvent.click(screen.getByRole('button', { name: 'pro' }))
    fireEvent.change(screen.getByPlaceholderText(zh.seedHint), { target: { value: '73' } })
    fireEvent.click(screen.getByRole('switch', { name: zh.audio }))
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

  it('retains all reference material and sends only the selected model limit', async () => {
    const { mount, store, props, task } = setup({ maxReferenceImages: 4 })
    store.actions.patch({ workflow: 'reference', slots: {
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
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(task).toHaveBeenCalledTimes(1) })
    expect(JSON.parse(String(task.mock.calls[0]?.[0]?.body)).referenceImages).toEqual(['ma_0', 'ma_1', 'ma_2'])
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
    expect(JSON.parse(String(task.mock.calls[0]?.[0]?.body)).frameImages).toEqual([])
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
