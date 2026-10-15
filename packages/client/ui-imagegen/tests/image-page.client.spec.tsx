// @vitest-environment jsdom

import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImagePage } from '../src/client/ImagePage.tsx'
import { createImageDraftStore } from '../src/client/draft-store.ts'
import { zh } from '../src/client/locales.ts'

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
  const getSnapshot = () => store.getSnapshot()
  const subscribe = (listener: () => void) => store.subscribe(listener)
  const props = {
    t,
    openVideo: vi.fn(),
    readDraft: getSnapshot,
    createReferencePreview: vi.fn((file: File) => `blob:${file.name}`),
    releaseReferencePreview: vi.fn(),
    actions: store.actions,
    useStore: select => select(useSyncExternalStore(subscribe, getSnapshot)),
  } satisfies Pick<Parameters<typeof ImagePage>[0], 't' | 'openVideo' | 'readDraft' | 'createReferencePreview' | 'releaseReferencePreview' | 'actions' | 'useStore'>
  return { store, props: props as Parameters<typeof ImagePage>[0] }
}

async function ready() {
  await screen.findByRole('option', { name: 'Edit model' })
}

beforeEach(() => {
  assets = 0
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input) => {
    const url = requestUrl(input)
    if (url === '/credits/api/session') return json({ ok: true, payload: { signedIn: true, creditsPerYuan: 1000 } })
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
    expect(screen.getByRole('textbox', { name: '画面描述' })).toHaveProperty('value', zh.tpl_recreate_prompt)
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

  it('limits reference uploads, then drops references and unsupported seed when models change', async () => {
    const { props, store } = makeProps()
    const view = render(<ImagePage {...props} />)
    await ready()
    const files = ['one.png', 'two.png', 'three.png'].map(name => new File(['bytes'], name, { type: 'image/png' }))
    fireEvent.drop(screen.getByRole('region', { name: '图片创作工作台' }), { dataTransfer: { files } })
    await waitFor(() => { expect(store.getSnapshot().references).toHaveLength(2) })
    expect(assets).toBe(2)
    expect(screen.getByText('当前模型最多支持 2 张参考图')).toBeTruthy()
    act(() => { store.actions.patch({ seed: '123', count: 2, prompt: 'Product photo' }) })
    fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: 'text-model' } })
    await waitFor(() => { expect(store.getSnapshot().references).toHaveLength(0) })
    expect(props.releaseReferencePreview).toHaveBeenCalledWith('blob:one.png')
    expect(props.releaseReferencePreview).toHaveBeenCalledWith('blob:two.png')
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
    expect(screen.getByRole('button', { name: '添加参考图' })).toHaveProperty('disabled', false)
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
    expect(screen.getByRole('button', { name: '添加参考图' })).toHaveProperty('disabled', false)
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
    expect(screen.getByRole('button', { name: '添加参考图' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '生成图片' })).toHaveProperty('disabled', true)
    fireEvent.drop(screen.getByRole('region', { name: '图片创作工作台' }), { dataTransfer: { files: [new File(['two'], 'two.png', { type: 'image/png' })] } })
    expect(fetchMock.mock.calls.filter(([url]) => url === '/credits/api/assets')).toHaveLength(1)
    act(() => { store.actions.appendReference({ assetId: 'ma_existing', name: 'existing.png', url: 'blob:existing' }, 'edit-model', 2) })
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
