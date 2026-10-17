// @vitest-environment jsdom

import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderFactorySlot } from '@deepseek-ai/dsh-client-ui-slots'
import type { PromptAssistOwner } from '@deepseek-ai/dsh-client-ui-prompt-assist/client'
import { ImagePage } from '../src/client/ImagePage.tsx'
import { createImageDraftStore } from '../src/client/draft-store.ts'
import { zh } from '../src/client/locales.ts'
import { contentFixture } from './content-fixture.client.ts'

const models = [
  { id: 'edit-model', displayName: 'Edit model', params: { sizes: ['1024x1024', '1536x1024'], maxCount: 2, maxEdits: 2, qualities: ['high'], backgrounds: ['transparent'], formats: ['png', 'jpeg'], moderations: [], seed: true } },
  { id: 'text-model', displayName: 'Text model', params: { sizes: ['768x768'], maxCount: 1, maxEdits: 0, qualities: [], backgrounds: [], formats: [], moderations: [], seed: false } },
]
const path = '/tmp/credits/media/saved-image.png'
const t: Parameters<typeof ImagePage>[0]['t'] = (key, values) => {
  let value: string = zh[key as keyof typeof zh]
  for (const [name, replacement] of Object.entries(values ?? {})) value = value.replaceAll(`{${name}}`, replacement)
  return value
}

let assets = 0
let sessionAccountId: string | null = 'account-a'
const fetchMock = vi.fn<typeof fetch>()

function json(body: object): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function requestBody(call: Parameters<typeof fetch> | undefined): Record<string, unknown> {
  const body = call?.[1]?.body
  if (typeof body !== 'string') throw new Error('Expected a JSON request body')
  return JSON.parse(body) as Record<string, unknown>
}

function makeProps() {
  const store = createImageDraftStore().create()
  store.actions.setReferenceAccount('account-a')
  const getSnapshot = () => store.getSnapshot()
  const subscribe = (listener: () => void) => store.subscribe(listener)
  const fixture = contentFixture()
  const props = {
    useCreationContent: fixture.useCreationContent, useLocale: fixture.useLocale, refreshContent: vi.fn(),
    t,
    renderFactorySlot: vi.fn<RenderFactorySlot>(() => null),
    openVideo: vi.fn(),
    readDraft: getSnapshot,
    createReferencePreview: vi.fn((file: File) => `blob:${file.name}`),
    releaseReferencePreview: vi.fn(),
    actions: store.actions,
    useStore: select => select(useSyncExternalStore(subscribe, getSnapshot)),
  } satisfies Pick<Parameters<typeof ImagePage>[0], 'useCreationContent' | 'useLocale' | 'refreshContent' | 't' | 'renderFactorySlot' | 'openVideo' | 'readDraft' | 'createReferencePreview' | 'releaseReferencePreview' | 'actions' | 'useStore'>
  return { store, fixture, props: props as Parameters<typeof ImagePage>[0] }
}

async function ready() {
  await screen.findByRole('option', { name: 'Edit model' })
}

beforeEach(() => {
  assets = 0
  sessionAccountId = 'account-a'
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input) => {
    const url = requestUrl(input)
    if (url === '/credits/api/session') return json({ ok: true, payload: { signedIn: sessionAccountId !== null, creditsPerYuan: 1000, account: sessionAccountId === null ? null : { id: sessionAccountId } } })
    if (url === '/credits/api/summary') return json({ ok: true, payload: { balance_points: 1200 } })
    if (url === '/credits/api/media/catalog') return json({ ok: true, payload: { image: models } })
    if (url === '/artifacts/api/list') return json({ items: [{ path, name: 'saved-image.png', kind: 'image', mtimeMs: 5 }] })
    if (url.startsWith('/artifacts/api/raw?')) return new Response('image', { headers: { 'content-type': 'image/png' } })
    if (url === '/credits/api/assets') { assets += 1; return json({ ok: true, asset: { assetId: `ma_${String(assets)}` } }) }
    if (url === '/credits/api/image/generate') return json({ ok: true, payload: { path } })
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('image creation workspace', () => {
  it.each(['/Users/user/chosen-images/image.png', 'D:\\云枢产物\\image.png'])(
    'shows saved image history from the configured directory: %s', async (savedPath) => {
      const original = fetchMock.getMockImplementation()!
      fetchMock.mockImplementation(async (input, init) => requestUrl(input) === '/artifacts/api/list'
        ? json({ items: [{ path: savedPath, name: 'custom-image.png', kind: 'image', mtimeMs: 8 }, { path: '/custom/movie.mp4', name: 'movie.mp4', kind: 'video', mtimeMs: 9 }] })
        : await original(input, init))
      const { props } = makeProps()
      render(<ImagePage {...props} />)
      await ready()
      fireEvent.click(await screen.findByRole('button', { name: '预览：custom-image.png' }))
      const dialog = screen.getByRole('dialog', { name: '结果' })
      expect(dialog.querySelector('img')?.getAttribute('src')).toBe(`/artifacts/api/raw?path=${encodeURIComponent(savedPath)}`)
      expect(screen.queryByText('movie.mp4')).toBeNull()
    },
  )

  it.each(['account-b', null])('clears account-owned references after the live account becomes %s', async (nextAccount) => {
    const { props, store } = makeProps()
    store.actions.patch({ references: [{ assetId: 'ma_private', name: 'private.png', url: 'blob:private', bytes: 1 }] })
    render(<ImagePage {...props} />)
    expect((vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner).references).toEqual([])
    await ready()
    sessionAccountId = nextAccount
    fireEvent.focus(window)
    await waitFor(() => { expect(store.getSnapshot().referenceAccountId).toBe(nextAccount) })
    expect(store.getSnapshot().references).toEqual([])
    expect(props.releaseReferencePreview).toHaveBeenCalledWith('blob:private')
    expect((vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner).references).toEqual([])
  })

  it.each(['account-a', 'account-b'])('keeps references across remounts only for their original account: %s', async (nextAccount) => {
    const { props, store } = makeProps()
    store.actions.patch({ references: [{ assetId: 'ma_private', name: 'private.png', url: 'blob:private', bytes: 1 }] })
    const first = render(<ImagePage {...props} />)
    await ready()
    first.unmount()
    sessionAccountId = nextAccount
    render(<ImagePage {...props} />)
    expect((vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner).references).toEqual([])
    await ready()
    expect(store.getSnapshot().references.map(item => item.assetId)).toEqual(nextAccount === 'account-a' ? ['ma_private'] : [])
    expect(props.releaseReferencePreview).toHaveBeenCalledTimes(nextAccount === 'account-a' ? 0 : 1)
  })

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    'ignores an old account upload without releasing the new upload lock (failure: %s, switch back: %s)', async (fails, switchBack) => {
      let resolveOld!: (response: Response) => void
      let rejectOld!: (error: Error) => void
      let resolveNew!: (response: Response) => void
      const oldUpload = new Promise<Response>((resolve, reject) => { resolveOld = resolve; rejectOld = reject })
      const newUpload = new Promise<Response>((resolve) => { resolveNew = resolve })
      const original = fetchMock.getMockImplementation()!
      let uploadCalls = 0
      fetchMock.mockImplementation(async (input, init) => requestUrl(input) === '/credits/api/assets'
        ? await (++uploadCalls === 1 ? oldUpload : newUpload) : await original(input, init))
      const { props, store } = makeProps()
      render(<ImagePage {...props} />)
      await ready()
      const drop = (name: string) => { fireEvent.drop(screen.getByRole('region', { name: '图片创作工作台' }), { dataTransfer: { files: [new File(['image'], name, { type: 'image/png' })] } }) }
      drop('old.png')
      sessionAccountId = 'account-b'
      fireEvent.focus(window)
      await waitFor(() => { expect(store.getSnapshot().referenceAccountId).toBe('account-b') })
      if (switchBack) {
        sessionAccountId = 'account-a'
        fireEvent.focus(window)
        await waitFor(() => { expect(store.getSnapshot().referenceAccountId).toBe('account-a') })
      }
      drop('new.png')
      act(() => { store.actions.patch({ failure: 'new account feedback' }) })
      await act(async () => { if (fails) rejectOld(new Error('old upload failed')); else resolveOld(json({ ok: true, asset: { assetId: 'ma_old' } })) })
      expect(store.getSnapshot()).toMatchObject({ uploading: true, failure: 'new account feedback', references: [] })
      expect(props.createReferencePreview).not.toHaveBeenCalled()
      await act(async () => { resolveNew(json({ ok: true, asset: { assetId: 'ma_new' } })) })
      expect(store.getSnapshot().references.map(item => item.assetId)).toEqual(['ma_new'])
      expect(store.getSnapshot().uploading).toBe(false)
    })

  it('rechecks the reference owner before sending a paid image request', async () => {
    const { props, store } = makeProps()
    store.actions.patch({ prompt: 'Private product', references: [{ assetId: 'ma_private', name: 'private.png', url: 'blob:private', bytes: 1 }] })
    render(<ImagePage {...props} />)
    await ready()
    sessionAccountId = 'account-b'
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', zh.referenceAccountChanged)
    expect(store.getSnapshot()).toMatchObject({ referenceAccountId: 'account-b', references: [], generationStartedAt: null })
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input) === '/credits/api/image/generate')).toBe(false)
  })

  it('gives AI help all materials and writes its result without generating an image', async () => {
    const { props, store } = makeProps()
    store.actions.patch({ prompt: '原始产品描述', references: [{ assetId: 'ma_product', name: 'product.png', url: 'blob:product', bytes: 1 }] })
    render(<ImagePage {...props} />)
    await ready()
    const calls = vi.mocked(props.renderFactorySlot).mock.calls
    const call = calls.at(-1)
    expect(call?.[0]).toBe('creation.prompt.assist')
    const assistant = call?.[1] as PromptAssistOwner
    expect(assistant).toMatchObject({ kind: 'image', prompt: '原始产品描述', references: ['ma_product'], signedIn: true, accountIdentity: 'account-a', disabled: false })
    act(() => { assistant.onPromptChange('用户确认后的产品提示词', '原始产品描述') })
    expect(store.getSnapshot().prompt).toBe('用户确认后的产品提示词')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '画面描述' }))
    expect(fetchMock.mock.calls.some(([url]) => url === '/credits/api/image/generate')).toBe(false)
  })

  it('keeps the prompt when AI help tries to apply during generation or after session expiry', async () => {
    const { props, store } = makeProps()
    store.actions.patch({ prompt: '保留原稿' })
    render(<ImagePage {...props} />)
    await ready()
    act(() => { store.actions.patch({ generationStartedAt: Date.now() }) })
    let assistant = vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner
    expect(assistant.disabled).toBe(true)
    act(() => { assistant.onPromptChange('不能覆盖', '保留原稿') })
    expect(store.getSnapshot().prompt).toBe('保留原稿')
    act(() => { store.actions.patch({ generationStartedAt: null, sessionInvalid: true }) })
    assistant = vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner
    expect(assistant.signedIn).toBe(false)
    act(() => { assistant.onPromptChange('不能覆盖', '保留原稿') })
    expect(store.getSnapshot().prompt).toBe('保留原稿')
  })

  it.each(['prompt', 'material', 'settings', 'account'])('rejects late AI writing after a %s change', async (change) => {
    const { props, store } = makeProps()
    store.actions.patch({ prompt: 'Original brief' })
    render(<ImagePage {...props} />)
    await ready()
    const assistant = vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner
    act(() => {
      if (change === 'prompt') store.actions.patch({ prompt: 'Manually edited brief' })
      if (change === 'material') store.actions.patch({ references: [{ assetId: 'ma_new', name: 'new.png', url: 'blob:new', bytes: 1 }] })
      if (change === 'settings') store.actions.patch({ format: 'jpeg' })
      if (change === 'account') store.actions.setReferenceAccount('account-b')
    })
    let accepted = true
    act(() => { accepted = assistant.onPromptChange('Late result', 'Original brief') })
    expect(accepted).toBe(false)
    expect(store.getSnapshot().prompt).toBe(change === 'prompt' ? 'Manually edited brief' : 'Original brief')
  })

  it('locks material and generation controls during AI writing while the main prompt stays editable', async () => {
    const { props, store } = makeProps()
    store.actions.patch({ prompt: 'Original brief' })
    render(<ImagePage {...props} />)
    await ready()
    const assistant = vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner
    act(() => { assistant.onBusyChange(true) })
    expect(store.getSnapshot().promptAssisting).toBe(true)
    expect((vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner).disabled).toBe(false)
    expect(screen.getByRole('button', { name: '添加素材' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('combobox', { name: '模型' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '生成图片' })).toHaveProperty('disabled', true)
    fireEvent.drop(screen.getByRole('region', { name: '图片创作工作台' }), { dataTransfer: { files: [new File(['image'], 'locked.png', { type: 'image/png' })] } })
    expect(assets).toBe(0)
    fireEvent.change(screen.getByRole('textbox', { name: '画面描述' }), { target: { value: 'My correction' } })
    expect(store.getSnapshot().prompt).toBe('My correction')
    act(() => { assistant.onBusyChange(false) })
    expect(screen.getByRole('button', { name: '添加素材' })).toHaveProperty('disabled', false)
  })

  it('accepts six materials on a text-only model and limits image generation to the selected model inputs', async () => {
    const { props, store } = makeProps()
    render(<ImagePage {...props} />)
    await ready()
    fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: 'text-model' } })
    expect(screen.getByRole('button', { name: '添加素材' })).toHaveProperty('disabled', false)
    fireEvent.drop(screen.getByRole('region', { name: '图片创作工作台' }), { dataTransfer: {
      files: Array.from({ length: 7 }, (_, index) => new File(['image'], `${index}.png`, { type: 'image/png' })),
    } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBe(false); expect(assets).toBe(6) })
    expect(store.getSnapshot().references).toHaveLength(6)
    expect((vi.mocked(props.renderFactorySlot).mock.calls.at(-1)?.[1] as PromptAssistOwner).references).toEqual(['ma_1', 'ma_2', 'ma_3', 'ma_4', 'ma_5', 'ma_6'])
    fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: 'edit-model' } })
    act(() => { store.actions.patch({ prompt: 'Product' }) })
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }))
    await screen.findByText(zh.done)
    expect(requestBody(fetchMock.mock.calls.find(([url]) => url === '/credits/api/image/generate')).references).toEqual(['ma_1', 'ma_2'])
    expect(store.getSnapshot().references).toHaveLength(6)
  })

  it('enforces 6 MiB per image and 12 MiB across materials before transport', async () => {
    const { props, store } = makeProps()
    render(<ImagePage {...props} />)
    await ready()
    const drop = (files: File[]) => { fireEvent.drop(screen.getByRole('region', { name: '图片创作工作台' }), { dataTransfer: { files } }) }
    drop([new File([new Uint8Array(6 * 1024 * 1024 + 1)], 'oversized.png', { type: 'image/png' })])
    await waitFor(() => { expect(store.getSnapshot().uploading).toBe(false) })
    expect(assets).toBe(0)
    drop([new File([new Uint8Array(6 * 1024 * 1024)], 'first.png', { type: 'image/png' }), new File([new Uint8Array(6 * 1024 * 1024)], 'second.png', { type: 'image/png' }), new File(['x'], 'excess.png', { type: 'image/png' })])
    await waitFor(() => { expect(store.getSnapshot().uploading).toBe(false); expect(assets).toBe(2) })
    expect(store.getSnapshot().references).toHaveLength(2)
    expect(screen.getByRole('alert').textContent).toBe(zh.referenceTotalLimit)
  })

  it('renders live published content, real covers and locale fallback without bundled templates', async () => {
    const { props, fixture } = makeProps()
    const template = fixture.content.image.templates[0]!
    const content = { ...fixture.content, image: { ...fixture.content.image,
      title: { zh: '后台图库', en: 'Studio library' }, promptPlaceholder: { zh: '后台输入提示', en: 'Server brief' },
      categories: [{ id: 'remote-category', label: { zh: '后台分类' }, sortOrder: 2, enabled: true }, { id: 'hidden-category', label: { zh: '隐藏分类' }, sortOrder: 0, enabled: false }],
      templates: [{ ...template, id: 'later', categoryId: 'remote-category', sortOrder: 9, title: { zh: '后项' }, coverAssetId: 'cover/real' },
        { ...template, id: 'first', categoryId: null, sortOrder: 1, title: { zh: '首项', en: 'First remote' } },
        { ...template, id: 'draft', categoryId: null, status: 'draft' as const, title: { zh: '未发布' } },
        { ...template, id: 'disabled', categoryId: 'hidden-category', title: { zh: '隐藏模板' } }],
    } }
    fixture.publication.set({ status: 'ready', content })
    const view = render(<ImagePage {...props} />)
    await ready()
    expect(screen.getByRole('heading', { name: '后台图库' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '画面描述' })).toHaveProperty('placeholder', '后台输入提示')
    expect(screen.queryByText('深度复刻')).toBeNull()
    expect(screen.queryByText('未发布')).toBeNull()
    expect(screen.queryByText('隐藏模板')).toBeNull()
    expect(screen.queryByText('隐藏分类')).toBeNull()
    const cards = [...view.container.querySelectorAll(`section[aria-label="${zh.templatesTitle}"] ul button`)]
    expect(cards.map(card => card.textContent)).toEqual(['首项后台参考模板', '后项后台参考模板'])
    expect(view.container.querySelector('img[src*="creation/assets"]')).toHaveProperty('src', expect.stringContaining('/credits/api/creation/assets/cover%2Freal'))
    act(() => { fixture.locale.set({ ...fixture.locale.getSnapshot(), active: 'en' }) })
    expect(screen.getByRole('heading', { name: 'Studio library' })).toBeTruthy()
    expect(screen.getByText('First remote')).toBeTruthy()
    expect(screen.getByText('后项')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '画面描述' })).toHaveProperty('placeholder', 'Server brief')
    act(() => { fixture.publication.set({ status: 'error', content: null }) })
    expect(screen.getByRole('alert').textContent).toContain(zh.contentFailed)
    expect(screen.queryByText('First remote')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(props.refreshContent).toHaveBeenCalledOnce()
    act(() => { fixture.publication.set({ status: 'ready', content: { ...content, image: { ...content.image, templates: [], presets: [] } } }) })
    expect(screen.getByText(zh.contentEmpty)).toBeTruthy()
  })

  it('distinguishes an unpublished empty catalog from a filter with no matching templates', async () => {
    const { props, fixture } = makeProps()
    fixture.publication.set({ status: 'ready', content: { ...fixture.content, image: { ...fixture.content.image, templates: [], presets: [] } } })
    render(<ImagePage {...props} />)
    await ready()
    expect(screen.getByText('暂无已发布模板')).toBeTruthy()
    expect(screen.queryByText(zh.noTemplates)).toBeNull()
    expect(screen.queryByRole('button', { name: zh.resetFilters })).toBeNull()
    act(() => { fixture.publication.set({ status: 'ready', content: fixture.content }) })
    fireEvent.change(screen.getByRole('searchbox', { name: zh.searchTemplates }), { target: { value: 'no match' } })
    expect(screen.getByText(zh.noTemplates, { exact: false })).toBeTruthy()
    expect(screen.queryByText(zh.contentEmpty)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.resetFilters }))
    expect(screen.getByText('深度复刻')).toBeTruthy()
  })

  it('filters real prompt templates and fills an editable brief without submitting', async () => {
    const { props } = makeProps()
    render(<ImagePage {...props} />)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: '视觉设计' }))
    expect(screen.queryByText('深度复刻')).toBeNull()
    expect(screen.getByRole('button', { name: /海报.*促销版式/ })).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索创作模板' }), { target: { value: '不存在' } })
    expect(screen.getByText('没有找到相关模板')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
    fireEvent.click(screen.getByText('深度复刻'))
    expect(screen.getByRole('textbox', { name: '画面描述' })).toHaveProperty('value', '后台复刻提示词')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '画面描述' }))
    expect(fetchMock.mock.calls.some(([url]) => url === '/credits/api/image/generate')).toBe(false)
  })

  it('retains the image draft and parameter choices across a switch to video and back', async () => {
    const { store, props } = makeProps()
    const first = render(<ImagePage {...props} />)
    await ready()
    fireEvent.change(screen.getByRole('textbox', { name: '画面描述' }), { target: { value: 'A green tea bottle' } })
    fireEvent.click(screen.getByRole('button', { name: '1024x1024' }))
    fireEvent.change(screen.getByLabelText('比例与尺寸'), { target: { value: '1536x1024' } })
    fireEvent.click(screen.getByRole('tab', { name: '视频' }))
    expect(props.openVideo).toHaveBeenCalledTimes(1)
    first.unmount()
    render(<ImagePage {...props} />)
    await ready()
    expect(screen.getByRole('textbox', { name: '画面描述' })).toHaveProperty('value', 'A green tea bottle')
    expect(store.getSnapshot().size).toBe('1536x1024')
    expect(screen.getByRole('button', { name: '1536x1024' })).toBeTruthy()
    expect(createImageDraftStore().create().getSnapshot().prompt).toBe('')
  })

  it('retains materials across model changes and sends no images to a text-only model', async () => {
    const { props, store } = makeProps()
    const view = render(<ImagePage {...props} />)
    await ready()
    const files = ['one.png', 'two.png', 'three.png'].map(name => new File(['bytes'], name, { type: 'image/png' }))
    fireEvent.drop(screen.getByRole('region', { name: '图片创作工作台' }), { dataTransfer: { files } })
    await waitFor(() => { expect(store.getSnapshot().references).toHaveLength(3) })
    expect(assets).toBe(3)
    expect(screen.getByText(zh.generationReferences.replace('{n}', '2'), { exact: false })).toBeTruthy()
    act(() => { store.actions.patch({ seed: '123', count: 2, prompt: 'Product photo' }) })
    fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: 'text-model' } })
    await waitFor(() => { expect(store.getSnapshot().size).toBe('768x768') })
    expect(store.getSnapshot().references).toHaveLength(3)
    expect(props.releaseReferencePreview).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toMatchObject({ seed: '', count: 1, size: '768x768' })
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }))
    await screen.findByText(zh.done)
    const request = fetchMock.mock.calls.find(([url]) => url === '/credits/api/image/generate')
    expect(requestBody(request)).toEqual({ prompt: 'Product photo', model: 'text-model', count: 1, size: '768x768', references: [] })
    expect(view.container.textContent).not.toContain('plugin:')
  })

  it('clears uploaded references and releases their previews', async () => {
    const { store, props } = makeProps()
    const view = render(<ImagePage {...props} />)
    await ready()
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['image'], '产品.png', { type: 'image/png' })] } })
    await screen.findByAltText('产品.png')
    const request = fetchMock.mock.calls.find(([url]) => url === '/credits/api/assets')
    expect(request?.[1]?.headers).toMatchObject({ 'x-file-name': encodeURIComponent('产品.png') })
    fireEvent.click(screen.getByRole('button', { name: '清空参考图' }))
    expect(store.getSnapshot().references).toHaveLength(0)
    expect(props.releaseReferencePreview).toHaveBeenCalledWith('blob:产品.png')
    expect(screen.getByRole('button', { name: '添加素材' })).toHaveProperty('disabled', false)
  })

  it('keeps the prompt and releases the running state after a connection failure without retrying', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => {
      if (requestUrl(input) === '/credits/api/image/generate') throw new TypeError('offline')
      return await original(input, init)
    })
    const { props, store } = makeProps()
    render(<ImagePage {...props} />)
    await ready()
    fireEvent.change(screen.getByRole('textbox', { name: '画面描述' }), { target: { value: 'Retain this draft' } })
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toBe(zh.generationConnectionLost)
    expect(store.getSnapshot().generationStartedAt).toBeNull()
    expect(screen.getByRole('textbox', { name: '画面描述' })).toHaveProperty('value', 'Retain this draft')
    expect(screen.getByRole('button', { name: '生成图片' })).toHaveProperty('disabled', false)
    expect(fetchMock.mock.calls.filter(([url]) => url === '/credits/api/image/generate')).toHaveLength(1)
  })

  it('recovers from upload failures and rejects unsupported image files before transport', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => {
      if (requestUrl(input) === '/credits/api/assets') throw new TypeError('offline')
      return await original(input, init)
    })
    const { props, store } = makeProps()
    const view = render(<ImagePage {...props} />)
    await ready()
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['gif'], 'bad.gif', { type: 'image/gif' })] } })
    await screen.findByText('参考图上传失败：不支持的图片格式')
    expect(fetchMock.mock.calls.some(([url]) => url === '/credits/api/assets')).toBe(false)
    fireEvent.change(input, { target: { files: [new File(['png'], 'good.png', { type: 'image/png' })] } })
    await screen.findByText('参考图上传失败：连接中断，请稍后重试')
    expect(screen.getByRole('button', { name: '添加素材' })).toHaveProperty('disabled', false)
    expect(store.getSnapshot().references).toHaveLength(0)
  })

  it('opens a work at original size, offers a download, and uploads it as a reference', async () => {
    const { props, store } = makeProps()
    render(<ImagePage {...props} />)
    await ready()
    fireEvent.click(await screen.findByRole('button', { name: '预览：saved-image.png' }))
    const dialog = screen.getByRole('dialog', { name: '结果' })
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(`/artifacts/api/raw?path=${encodeURIComponent(path)}`)
    fireEvent.click(screen.getByRole('button', { name: '关闭预览' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('link', { name: '下载' }).getAttribute('download')).toBe('saved-image.png')
    fireEvent.click(screen.getByRole('button', { name: '作为参考图' }))
    await waitFor(() => { expect(store.getSnapshot().references).toHaveLength(1) })
    expect(store.getSnapshot().references[0]?.name).toBe('saved-image.png')
  })

  it('holds the upload lock across remounts and atomically retains existing references', async () => {
    let resolveUpload!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { resolveUpload = resolve })
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => requestUrl(input) === '/credits/api/assets' ? await pending : await original(input, init))
    const { props, store } = makeProps()
    const first = render(<ImagePage {...props} />)
    await ready()
    fireEvent.change(screen.getByRole('textbox', { name: '画面描述' }), { target: { value: 'Keep the references' } })
    fireEvent.drop(screen.getByRole('region', { name: '图片创作工作台' }), { dataTransfer: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } })
    expect(store.getSnapshot().uploading).toBe(true)
    first.unmount()
    render(<ImagePage {...props} />)
    await ready()
    expect(screen.getByRole('button', { name: '添加素材' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '生成图片' })).toHaveProperty('disabled', true)
    fireEvent.drop(screen.getByRole('region', { name: '图片创作工作台' }), { dataTransfer: { files: [new File(['two'], 'two.png', { type: 'image/png' })] } })
    expect(fetchMock.mock.calls.filter(([url]) => url === '/credits/api/assets')).toHaveLength(1)
    act(() => { store.actions.appendReference({ assetId: 'ma_existing', name: 'existing.png', url: 'blob:existing', bytes: 1 }) })
    await act(async () => { resolveUpload(json({ ok: true, asset: { assetId: 'ma_late' } })) })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBe(false) })
    expect(store.getSnapshot().references.map(item => item.assetId)).toEqual(['ma_existing', 'ma_late'])
    expect(screen.getByRole('button', { name: '生成图片' })).toHaveProperty('disabled', false)
  })

  it('locks original-work retrieval and asset upload together before allowing generation', async () => {
    let resolveRaw!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { resolveRaw = resolve })
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => requestUrl(input).startsWith('/artifacts/api/raw?') ? await pending : await original(input, init))
    const { props, store } = makeProps()
    const first = render(<ImagePage {...props} />)
    await ready()
    fireEvent.change(screen.getByRole('textbox', { name: '画面描述' }), { target: { value: 'Edit this saved image' } })
    fireEvent.click(screen.getByRole('button', { name: '作为参考图' }))
    expect(store.getSnapshot().uploading).toBe(true)
    first.unmount()
    render(<ImagePage {...props} />)
    await ready()
    expect(screen.getByRole('button', { name: '生成图片' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }))
    expect(fetchMock.mock.calls.some(([url]) => url === '/credits/api/image/generate')).toBe(false)
    await act(async () => { resolveRaw(new Response('image', { headers: { 'content-type': 'image/png' } })) })
    await waitFor(() => { expect(store.getSnapshot().references).toHaveLength(1) })
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }))
    await screen.findByText(zh.done)
    const request = fetchMock.mock.calls.find(([url]) => url === '/credits/api/image/generate')
    expect(requestBody(request).references).toEqual(['ma_1'])
  })

  it('shows a late disconnected-generation warning in the newly mounted image panel', async () => {
    let rejectGeneration!: (reason: Error) => void
    const pending = new Promise<Response>((_resolve, reject) => { rejectGeneration = reject })
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => requestUrl(input) === '/credits/api/image/generate' ? await pending : await original(input, init))
    const { props, store } = makeProps()
    const first = render(<ImagePage {...props} />)
    await ready()
    fireEvent.change(screen.getByRole('textbox', { name: '画面描述' }), { target: { value: 'Keep this late result' } })
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }))
    expect(store.getSnapshot().generationStartedAt).not.toBeNull()
    first.unmount()
    render(<ImagePage {...props} />)
    await ready()
    expect(screen.getByRole('button', { name: '生成中…' })).toHaveProperty('disabled', true)
    await act(async () => { rejectGeneration(new TypeError('offline')) })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', zh.generationConnectionLost)
    expect(store.getSnapshot().generationStartedAt).toBeNull()
    expect(screen.getByRole('textbox', { name: '画面描述' })).toHaveProperty('value', 'Keep this late result')
    expect(fetchMock.mock.calls.filter(([url]) => url === '/credits/api/image/generate')).toHaveLength(1)
  })

  it('blocks generation after a late session-expired response reaches a remounted panel', async () => {
    let resolveGeneration!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { resolveGeneration = resolve })
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => requestUrl(input) === '/credits/api/image/generate' ? await pending : await original(input, init))
    const { props, store } = makeProps()
    const first = render(<ImagePage {...props} />)
    await ready()
    fireEvent.change(screen.getByRole('textbox', { name: '画面描述' }), { target: { value: 'A retained brief' } })
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }))
    first.unmount()
    render(<ImagePage {...props} />)
    await ready()
    await act(async () => { resolveGeneration(json({ ok: false, sessionInvalid: true })) })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', zh.noAuth)
    expect(store.getSnapshot().sessionInvalid).toBe(true)
    expect(screen.getByRole('button', { name: '生成图片' })).toHaveProperty('disabled', true)
  })

})
