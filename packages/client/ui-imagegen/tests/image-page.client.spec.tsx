// @vitest-environment jsdom

import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
let chatSessionId: string | undefined = 'session-a'
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
    useCreationSession: select => select({ key: chatSessionId, hooks: {}, keyedHooks: {}, props: {} }),
    t,
    renderFactorySlot: vi.fn(() => null),
    openVideo: vi.fn(),
    readDraft: getSnapshot,
    createReferencePreview: vi.fn((file: File) => `blob:${file.name}`),
    releaseReferencePreview: vi.fn(),
    actions: store.actions,
    useStore: select => select(useSyncExternalStore(subscribe, getSnapshot)),
  } satisfies Pick<Parameters<typeof ImagePage>[0], 'useCreationSession' | 'useCreationContent' | 'useLocale' | 'refreshContent' | 't' | 'renderFactorySlot' | 'openVideo' | 'readDraft' | 'createReferencePreview' | 'releaseReferencePreview' | 'actions' | 'useStore'>
  return { store, fixture, props: props as Parameters<typeof ImagePage>[0] }
}

async function ready() {
  await screen.findByRole('option', { name: 'Edit model' })
}

beforeEach(() => {
  assets = 0
  sessionAccountId = 'account-a'
  chatSessionId = 'session-a'
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
    if (url.startsWith('/credits/api/creative/projects?')) return json({ ok: true,
      payload: { accountId: sessionAccountId, projects: [] } })
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => { vi.useRealTimers(); cleanup(); vi.unstubAllGlobals() })

describe('image creation workspace', () => {
  it.each(['text', 'reference'] as const)('shows every live image ratio independently of its tier and submits both in %s mode', async (mode) => {
    const sizes = ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '2:1', '1:2', '21:9', '9:21']
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => input === '/credits/api/media/catalog'
      ? json({ ok: true, payload: { image: [{ id: 'yunshu-internal-gpt-image-2', displayName: 'Internal image',
        params: { sizes, resolutions: ['1k', '2k', '4k'], maxCount: 1, maxEdits: 6, qualities: [], backgrounds: [], formats: [], moderations: [], seed: false } }] } })
      : await original(input, init))
    const { props, store } = makeProps()
    render(<ImagePage {...props} />)
    await screen.findByRole('option', { name: 'Internal image' })
    const ratio = screen.getByRole('combobox', { name: zh.ratio })
    for (const size of sizes) for (const resolution of ['1k', '2k', '4k']) {
      fireEvent.change(ratio, { target: { value: size } })
      fireEvent.change(screen.getByRole('combobox', { name: zh.resolution }), { target: { value: resolution } })
      expect(store.getSnapshot()).toMatchObject({ size, resolution })
    }
    expect(screen.queryByRole('combobox', { name: zh.quality })).toBeNull()
    expect(screen.queryByRole('combobox', { name: zh.count })).toBeNull()
    if (mode === 'reference') {
      fireEvent.drop(screen.getByRole('region', { name: zh.composer }), {
        dataTransfer: { files: [new File(['image'], 'reference.png', { type: 'image/png' })] },
      })
      await waitFor(() => { expect(store.getSnapshot().references).toHaveLength(1) })
    }
    fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: 'Use the exact ratio and tier' } })
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', false) })
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await screen.findByText(zh.done)
    expect(requestBody(fetchMock.mock.calls.find(([url]) => url === '/credits/api/image/generate'))).toMatchObject({
      model: 'yunshu-internal-gpt-image-2', size: '9:21', resolution: '4k', count: 1, references: mode === 'reference' ? ['ma_1'] : [],
    })
  })

  it.each(['text', 'reference'] as const)('shows image specifications directly and submits the chosen values in %s mode', async (mode) => {
    const { props, store } = makeProps()
    render(<ImagePage {...props} />)
    await ready()
    const size = screen.getByRole('combobox', { name: zh.ratio })
    expect(size).toHaveProperty('disabled', false)
    fireEvent.change(size, { target: { value: '1536x1024' } })
    fireEvent.change(screen.getByRole('combobox', { name: zh.count }), { target: { value: '2' } })
    fireEvent.change(screen.getByRole('combobox', { name: zh.quality }), { target: { value: 'high' } })
    fireEvent.change(screen.getByRole('combobox', { name: zh.background }), { target: { value: 'transparent' } })
    fireEvent.change(screen.getByRole('combobox', { name: zh.format }), { target: { value: 'jpeg' } })
    fireEvent.change(screen.getByRole('slider', { name: zh.compression.replace('{n}', '90') }), { target: { value: '85' } })
    fireEvent.change(screen.getByRole('textbox', { name: zh.seed }), { target: { value: '42' } })
    if (mode === 'reference') {
      fireEvent.drop(screen.getByRole('region', { name: zh.composer }), {
        dataTransfer: { files: [new File(['image'], 'reference.png', { type: 'image/png' })] },
      })
      await waitFor(() => { expect(store.getSnapshot().references).toHaveLength(1) })
      expect(screen.getByText(t('modeEdit', { count: '1' }))).toBeTruthy()
    } else expect(screen.getByText(zh.modeGenerate)).toBeTruthy()
    expect(fetchMock.mock.calls.some(([url]) => url === '/credits/api/image/generate')).toBe(false)
    fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: '选择的图片规格' } })
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', false) })
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await screen.findByText(zh.done)
    expect(requestBody(fetchMock.mock.calls.find(([url]) => url === '/credits/api/image/generate'))).toMatchObject({
      size: '1536x1024', count: 2, quality: 'high', background: 'transparent', format: 'jpeg', compression: 85, seed: 42,
      references: mode === 'reference' ? ['ma_1'] : [],
    })
  })

  it.each(['running', 'unknown'])('keeps AI Creation usable while chat has a %s image task', async (status) => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => requestUrl(input).startsWith('/credits/api/creative/projects?')
      ? json({ ok: true, payload: { accountId: 'account-a', projects: [{ id: 'cp_chat', sessionId: 'session-a',
        kind: 'image', tasks: [{ id: 'op_chat', source: 'chat', status, canQuery: true,
          imageReceipt: { taskId: 'task_chat' } }] }] } }) : await original(input, init))
    const { props, store } = makeProps()
    render(<ImagePage {...props} />)
    await ready()
    fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: '独立的 AI 创作图片' } })
    const submit = screen.getByRole('button', { name: zh.submit })
    await waitFor(() => { expect(submit).toHaveProperty('disabled', false) })
    expect(screen.queryByText(zh.originalAccepted)).toBeNull()
    expect(Object.values(store.getSnapshot().unsettled)).toHaveLength(0)
    fireEvent.click(submit)
    await screen.findByText(zh.done)
    expect(fetchMock.mock.calls.filter(([url]) => url === '/credits/api/image/generate')).toHaveLength(1)
  })

  it.each(['no-session', 'unknown', 'read-failed'] as const)('keeps draft controls available with %s admission while generation stays paused', async (admission) => {
    if (admission === 'no-session') chatSessionId = undefined
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => {
      if (!requestUrl(input).startsWith('/credits/api/creative/projects?')) return await original(input, init)
      if (admission === 'read-failed') return new Response('', { status: 503 })
      return json({ ok: true, payload: { accountId: 'account-a', projects: [{ id: 'cp_original', sessionId: 'session-a',
        kind: 'image', tasks: [{ id: 'op_original', source: 'ai-creation', status: 'unknown', canQuery: false }] }] } })
    })
    const { props, store } = makeProps()
    render(<ImagePage {...props} />)
    await ready()
    if (admission === 'unknown') await screen.findByText(zh.originalUnknown)
    else if (admission === 'read-failed') await screen.findByRole('button', { name: zh.originalCheck })
    const selector = screen.getByRole('combobox', { name: zh.model })
    expect(selector).toHaveProperty('disabled', false)
    expect(screen.getByRole('group', { name: zh.parameters })).toBeTruthy()
    const ratio = screen.getByRole('combobox', { name: zh.ratio })
    expect(ratio).toHaveProperty('disabled', false)
    fireEvent.change(ratio, { target: { value: '1536x1024' } })
    expect(store.getSnapshot().size).toBe('1536x1024')
    const template = screen.getByRole('button', { name: /^深度复刻/ })
    expect(template).toHaveProperty('disabled', false)
    fireEvent.click(template)
    expect(store.getSnapshot().prompt).toBe('后台复刻提示词')
    fireEvent.change(selector, { target: { value: 'text-model' } })
    expect(store.getSnapshot().modelId).toBe('text-model')
    const submit = screen.getByRole('button', { name: zh.submit })
    expect(submit).toHaveProperty('disabled', true)
    fireEvent.click(submit)
    expect(fetchMock.mock.calls.some(([url]) => url === '/credits/api/image/generate')).toBe(false)
    if (admission === 'no-session') expect(fetchMock.mock.calls.filter(([url]) => requestUrl(url).startsWith('/credits/api/creative/projects?'))).toEqual([])
    else if (admission === 'unknown') expect(Object.values(store.getSnapshot().unsettled)[0]).toMatchObject({
      planId: 'cp_original', operationId: 'op_original', state: 'unknown',
    })
  })

  it.each(['text', 'reference'] as const)('shows and submits the catalog resolution independently of pixel size in %s mode', async (mode) => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => input === '/credits/api/media/catalog'
      ? json({ ok: true, payload: { image: [{ ...models[0], id: 'internal-image', displayName: 'Internal image',
        params: { ...models[0]!.params, sizes: [], resolutions: ['1k', '2k', '4k'] } }] } }) : await original(input, init))
    const { props, store } = makeProps()
    render(<ImagePage {...props} />)
    await screen.findByRole('option', { name: 'Internal image' })
    await waitFor(() => { expect(store.getSnapshot().resolution).toBe('1k') })
    expect(screen.queryByRole('combobox', { name: zh.ratio })).toBeNull()
    if (mode === 'reference') {
      fireEvent.drop(screen.getByRole('region', { name: zh.composer }), {
        dataTransfer: { files: [new File(['image'], 'reference.png', { type: 'image/png' })] },
      })
      await waitFor(() => { expect(store.getSnapshot().references).toHaveLength(1) })
    }
    fireEvent.change(screen.getByRole('combobox', { name: zh.resolution }), { target: { value: '4k' } })
    fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: '保留参考画面' } })
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', false) })
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await waitFor(() => { expect(fetchMock.mock.calls.some(([url]) => url === '/credits/api/image/generate')).toBe(true) })
    const submitted = requestBody(fetchMock.mock.calls.find(([url]) => url === '/credits/api/image/generate'))
    expect(submitted).toMatchObject({ model: 'internal-image', resolution: '4k', references: mode === 'reference' ? ['ma_1'] : [] })
    expect(submitted).not.toHaveProperty('size')
  })

  it('polls the original active submission for its accepted ids while its only generation request is still pending', async () => {
    const original = fetchMock.getMockImplementation()!
    const generation = Promise.withResolvers<Response>()
    let submitted = false
    let accepted = false
    fetchMock.mockImplementation(async (input, init) => {
      if (input === '/credits/api/image/generate') { submitted = true; return await generation.promise }
      if (requestUrl(input).startsWith('/credits/api/creative/projects?')) return json({ ok: true, payload: {
        accountId: 'account-a', projects: submitted ? [{ id: 'cp_original', sessionId: 'session-a', kind: 'image', tasks: [{
          id: 'op_original', source: 'ai-creation', status: 'running', canQuery: false,
          imageReceipt: accepted ? { phase: 'accepted', taskId: 'task_original', requestId: 'request_original' } : { phase: 'submitting' },
        }] }] : [],
      } })
      return await original(input, init)
    })
    const { props, store } = makeProps()
    render(<ImagePage {...props} />)
    await ready()
    fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: '在原请求等待时显示受理编号' } })
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', false) })
    vi.useFakeTimers()
    try {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.submit })) })
      expect(store.getSnapshot().generationStartedAt).not.toBeNull()
      expect(screen.getByText(zh.originalUnknown)).toBeTruthy()
      expect(Object.values(store.getSnapshot().unsettled)[0]).toMatchObject({
        state: 'pending', planId: 'cp_original', operationId: 'op_original', canQuery: false,
      })
      accepted = true
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(screen.getByText(t('originalTaskId', { id: 'task_original' }))).toBeTruthy()
      expect(screen.getByText(t('originalRequestId', { id: 'request_original' }))).toBeTruthy()
      expect(screen.getByText(zh.originalAccepted)).toBeTruthy()
      expect(store.getSnapshot().generationStartedAt).not.toBeNull()
      expect(screen.getByRole('button', { name: zh.runningShort })).toHaveProperty('disabled', true)
      expect(fetchMock.mock.calls.filter(([url]) => url === '/credits/api/image/generate')).toHaveLength(1)
      expect(fetchMock.mock.calls.some(([url]) => url === '/credits/api/creative/image/recover')).toBe(false)
    } finally {
      await act(async () => { generation.resolve(json({ ok: false, submission_state: 'pending',
        plan_id: 'cp_original', operation_id: 'op_original', task_id: 'task_original', request_id: 'request_original' })) })
    }
  })

  it('does not keep polling an inactive unknown submission without a receipt', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => requestUrl(input).startsWith('/credits/api/creative/projects?')
      ? json({ ok: true, payload: { accountId: 'account-a', projects: [{ id: 'cp_legacy', sessionId: 'session-a',
        kind: 'image', tasks: [{ id: 'op_legacy', source: 'ai-creation', status: 'unknown', canQuery: false }] }] } }) : await original(input, init))
    const { props, store } = makeProps()
    render(<ImagePage {...props} />)
    await ready()
    await screen.findByText(zh.originalUnknown)
    const reads = fetchMock.mock.calls.filter(([url]) => requestUrl(url).startsWith('/credits/api/creative/projects?')).length
    vi.useFakeTimers()
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(fetchMock.mock.calls.filter(([url]) => requestUrl(url).startsWith('/credits/api/creative/projects?'))).toHaveLength(reads)
    expect(store.getSnapshot().generationStartedAt).toBeNull()
    expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', true)
    expect(fetchMock.mock.calls.some(([url]) => url === '/credits/api/image/generate')).toBe(false)
  })

  it('retains a structured accepted outcome after failure and remount, then queries only its original task', async () => {
    const original = fetchMock.getMockImplementation()!
    let accepted = false
    let querying = false
    const listing = () => ({ ok: true, payload: { accountId: 'account-a', projects: accepted ? [{
      id: 'cp_original', sessionId: 'session-a', kind: 'image', tasks: [{ id: 'op_original',
        status: querying ? 'running' : 'unknown', canQuery: !querying,
        imageReceipt: { taskId: 'task_original', requestId: 'request_original' } }],
    }] : [] } })
    fetchMock.mockImplementation(async (input, init) => {
      if (input === '/credits/api/image/generate') {
        accepted = true
        return Response.json({ ok: false, code: 'TASK_PENDING', submission_state: 'pending',
          plan_id: 'cp_original', operation_id: 'op_original', task_id: 'task_original', request_id: 'request_original' }, { status: 504 })
      }
      if (requestUrl(input).startsWith('/credits/api/creative/projects?')) return json(listing())
      if (input === '/credits/api/creative/image/recover') { querying = true; return Response.json(listing(), { status: 202 }) }
      return await original(input, init)
    })
    const { props, store } = makeProps()
    const view = render(<ImagePage {...props} />)
    await ready()
    fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: '保留原任务' } })
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', false) })
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await screen.findByRole('button', { name: zh.originalQuery })
    expect(screen.getByText(zh.originalAccepted)).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', true)
    expect(store.getSnapshot().generationStartedAt).toBeNull()
    view.unmount()
    render(<ImagePage {...props} />)
    const query = await screen.findByRole('button', { name: zh.originalQuery })
    fireEvent.click(query); fireEvent.click(query)
    await waitFor(() => { expect(screen.queryByRole('button', { name: zh.originalQuery })).toBeNull() })
    expect(requestBody(fetchMock.mock.calls.find(([url]) => url === '/credits/api/creative/image/recover')))
      .toEqual({ session_id: 'session-a', project_id: 'cp_original', operation_id: 'op_original' })
    expect(fetchMock.mock.calls.filter(([url]) => url === '/credits/api/creative/image/recover')).toHaveLength(1)
    expect(fetchMock.mock.calls.filter(([url]) => url === '/credits/api/image/generate')).toHaveLength(1)
    expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', true)
  })

  it('keeps model-ready generation disabled until the original-task admission read finishes', async () => {
    const original = fetchMock.getMockImplementation()!
    const entered = Promise.withResolvers<undefined>()
    const listing = Promise.withResolvers<Response>()
    let firstRead = true
    fetchMock.mockImplementation(async (input, init) => {
      if (requestUrl(input).startsWith('/credits/api/creative/projects?') && firstRead) {
        firstRead = false
        entered.resolve(undefined)
        return await listing.promise
      }
      return await original(input, init)
    })
    const { props } = makeProps()
    render(<ImagePage {...props} />)
    try {
      await ready()
      await entered.promise
      fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: '先核对原任务再生成' } })
      const submit = screen.getByRole('button', { name: zh.submit })
      expect(submit).toHaveProperty('disabled', true)
      fireEvent.click(submit)
      expect(fetchMock.mock.calls.some(([url]) => url === '/credits/api/image/generate')).toBe(false)
      await act(async () => { listing.resolve(json({ ok: true, payload: { accountId: 'account-a', projects: [] } })) })
      await waitFor(() => { expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', false) })
      fireEvent.click(screen.getByRole('button', { name: zh.submit }))
      await screen.findByText(zh.done)
      expect(fetchMock.mock.calls.filter(([url]) => url === '/credits/api/image/generate')).toHaveLength(1)
    } finally {
      await act(async () => { listing.resolve(json({ ok: true, payload: { accountId: 'account-a', projects: [] } })) })
    }
  })

  it('restores an unknown original task without a receipt after a full draft reload', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => requestUrl(input).startsWith('/credits/api/creative/projects?')
      ? json({ ok: true, payload: { accountId: 'account-a', projects: [{ id: 'cp_legacy', sessionId: 'session-a',
        kind: 'image', tasks: [{ id: 'op_legacy', source: 'ai-creation', status: 'unknown', canQuery: false }] }] } }) : await original(input, init))
    const { props } = makeProps()
    render(<ImagePage {...props} />)
    await ready()
    await screen.findByText(zh.originalUnknown)
    fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: '不能盲目重新生成' } })
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    expect(screen.queryByRole('button', { name: zh.originalQuery })).toBeNull()
    expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', true)
    expect(fetchMock.mock.calls.some(([url]) => url === '/credits/api/image/generate')).toBe(false)
  })

  it('keeps generation paused after a failed original-task read and only retries the read explicitly', async () => {
    const original = fetchMock.getMockImplementation()!
    let failed = true
    fetchMock.mockImplementation(async (input, init) => requestUrl(input).startsWith('/credits/api/creative/projects?') && failed
      ? new Response('', { status: 503 }) : await original(input, init))
    const { props } = makeProps()
    render(<ImagePage {...props} />)
    await ready()
    const check = await screen.findByRole('button', { name: zh.originalCheck })
    fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: '核对后再操作' } })
    expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', true)
    failed = false
    fireEvent.click(check)
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', false) })
    expect(fetchMock.mock.calls.some(([url]) => url === '/credits/api/image/generate')).toBe(false)
  })

  it('does not let an earlier empty listing erase a new request whose connection later fails', async () => {
    const original = fetchMock.getMockImplementation()!
    let readAgain = false
    let finishRead!: (response: Response) => void
    const oldRead = new Promise<Response>((resolve) => { finishRead = resolve })
    let failGeneration!: (error: Error) => void
    const generation = new Promise<Response>((_resolve, reject) => { failGeneration = reject })
    fetchMock.mockImplementation(async (input, init) => {
      if (input === '/credits/api/image/generate') return await generation
      if (readAgain && requestUrl(input).startsWith('/credits/api/creative/projects?')) {
        readAgain = false
        return await oldRead
      }
      return await original(input, init)
    })
    const { props, store } = makeProps()
    render(<ImagePage {...props} />)
    await ready()
    fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: '保留新提交' } })
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', false) })
    readAgain = true
    fireEvent(document, new Event('visibilitychange'))
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await act(async () => { finishRead(json({ ok: true, payload: { accountId: 'account-a', projects: [] } })) })
    expect(Object.values(store.getSnapshot().unsettled)).toHaveLength(1)
    await act(async () => { failGeneration(new TypeError('offline')) })
    await screen.findByRole('alert')
    expect(Object.values(store.getSnapshot().unsettled)[0]?.state).toBe('unknown')
    expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', true)
    expect(fetchMock.mock.calls.filter(([url]) => url === '/credits/api/image/generate')).toHaveLength(1)
  })

  it('does not restore an older unknown task after a newer visible-page read confirmed it ended', async () => {
    const original = fetchMock.getMockImplementation()!
    let reads = 0
    let finishOldRead!: (response: Response) => void
    const oldRead = new Promise<Response>((resolve) => { finishOldRead = resolve })
    fetchMock.mockImplementation(async (input, init) => {
      if (requestUrl(input).startsWith('/credits/api/creative/projects?')) {
        if (++reads === 1) return await oldRead
        return json({ ok: true, payload: { accountId: 'account-a', projects: [{ id: 'cp_original', sessionId: 'session-a',
          kind: 'image', tasks: [{ id: 'op_original', status: 'completed', canQuery: false }] }] } })
      }
      return await original(input, init)
    })
    const { props, store } = makeProps()
    render(<ImagePage {...props} />)
    await ready()
    fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: '已结束的原任务' } })
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', false) })
    await act(async () => { finishOldRead(json({ ok: true, payload: { accountId: 'account-a', projects: [{
      id: 'cp_original', sessionId: 'session-a', kind: 'image', tasks: [{ id: 'op_original', source: 'ai-creation', status: 'unknown', canQuery: true,
        imageReceipt: { taskId: 'task_original' } }],
    }] } })) })
    expect(Object.values(store.getSnapshot().unsettled)).toHaveLength(0)
    expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', false)
    expect(fetchMock.mock.calls.some(([url]) => url === '/credits/api/image/generate')).toBe(false)
  })

  it.each([
    ['INVALID_REQUEST', zh.invalidInput], ['AUTH', zh.operationFailed], ['QUOTA', zh.operationFailed],
    ['UNRECOGNIZED_ERROR', zh.operationFailed], ['TRANSPORT', zh.networkFailure], ['TIMEOUT', zh.requestTimeout],
    ['PERMISSION_DENIED', zh.permissionDenied], ['HTTP_503', zh.serviceUnavailable], ['UPSTREAM_ERROR', zh.upstreamUnavailable],
    ['LOCAL_SAVE_FAILED', zh.localFailure], ['SERVER_BUSY', zh.serverBusy], ['CANCELLED', zh.cancelled],
    ['ACCOUNT_QUOTA', zh.insufficient], ['ACCOUNT_SIGN_IN_REQUIRED', zh.noAuth],
  ])('classifies a confirmed %s rejection without exposing diagnostics or losing the draft', async (code, expected) => {
    const original = fetchMock.getMockImplementation()!
    const message = '400 {"reasoning_content":"private-id", "path":"C:/internal/key"}'
    fetchMock.mockImplementation(async (input, init) => input === '/credits/api/image/generate'
      ? json({ ok: false, code, message, submission_state: 'not-submitted' }) : await original(input, init))
    const { props, store } = makeProps()
    const view = render(<ImagePage {...props} />)
    await ready()
    fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: '保留这个画面' } })
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    expect((await screen.findByRole('alert')).textContent).toBe(expected)
    expect(view.container.textContent).not.toContain(message)
    expect(view.container.textContent).not.toContain(code)
    expect(view.container.textContent).not.toContain('private-id')
    expect(store.getSnapshot().prompt).toBe('保留这个画面')
    expect(fetchMock.mock.calls.filter(([url]) => url === '/credits/api/image/generate')).toHaveLength(1)
  })

  it.each(['IMAGE_REFERENCE_INVALID', 'IMAGE_REFERENCE_UPLOAD_FAILED', 'IMAGE_REFERENCE_UPLOAD_INVALID'])(
    'shows the safe Host reference filename and reason for %s without retrying', async (code) => {
      const original = fetchMock.getMockImplementation()!
      const message = '参考图「妈妈参考.png」上传未完成，请稍后重试；尚未提交生成。'
      fetchMock.mockImplementation(async (input, init) => input === '/credits/api/image/generate'
        ? json({ ok: false, code, message }) : await original(input, init))
      const { props, store } = makeProps()
      const reference = { assetId: 'ma_retained', name: '妈妈参考.png', url: 'blob:retained', bytes: 10 }
      store.actions.appendReference(reference)
      render(<ImagePage {...props} />)
      await ready()
      fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: '保留人物外貌' } })
      fireEvent.click(screen.getByRole('button', { name: zh.submit }))
      expect((await screen.findByRole('alert')).textContent).toBe(message)
      expect(store.getSnapshot().prompt).toBe('保留人物外貌')
      expect(store.getSnapshot().references).toEqual([reference])
      await waitFor(() => { expect(store.getSnapshot().generationStartedAt).toBeNull() })
      expect(fetchMock.mock.calls.filter(([url]) => url === '/credits/api/image/generate')).toHaveLength(1)
    },
  )

  it.each([
    [408, zh.requestTimeout], [403, zh.permissionDenied], [429, zh.serverBusy], [503, zh.serviceUnavailable],
  ])('uses observed HTTP %s when a confirmed rejection has no recognized failure code', async (status, expected) => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => input === '/credits/api/image/generate'
      ? Response.json({ ok: false, code: 'PRIVATE_CODE', message: 'private route', submission_state: 'not-submitted' }, { status })
      : await original(input, init))
    const { props, store } = makeProps()
    const view = render(<ImagePage {...props} />)
    await ready()
    fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: '保留画面' } })
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    expect((await screen.findByRole('alert')).textContent).toBe(expected)
    expect(view.container.textContent).not.toContain('private route')
    expect(store.getSnapshot().prompt).toBe('保留画面')
    expect(fetchMock.mock.calls.filter(([url]) => url === '/credits/api/image/generate')).toHaveLength(1)
  })

  it.each(['TIMEOUT', 'TRANSPORT', 'NO_TASK_ID'])('keeps unknown-result guidance for a structured %s failure without resubmitting', async (code) => {
    const original = fetchMock.getMockImplementation()!
    const message = 'private generation diagnostic'
    fetchMock.mockImplementation(async (input, init) => input === '/credits/api/image/generate'
      ? json({ ok: false, code, message }) : await original(input, init))
    const { props, store } = makeProps()
    const reference = { assetId: 'ma_retained', name: '参考图.png', url: 'blob:retained', bytes: 10 }
    store.actions.appendReference(reference)
    const view = render(<ImagePage {...props} />)
    await ready()
    fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: '保留草稿与参考图' } })
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    expect((await screen.findByRole('alert')).textContent).toBe(zh.generationConnectionLost)
    expect(view.container.textContent).not.toContain(message)
    expect(view.container.textContent).not.toContain(code)
    expect(view.queryByText(zh.serverBusy)).toBeNull()
    expect(store.getSnapshot().prompt).toBe('保留草稿与参考图')
    expect(store.getSnapshot().references).toEqual([reference])
    await waitFor(() => { expect(store.getSnapshot().generationStartedAt).toBeNull() })
    expect(fetchMock.mock.calls.filter(([url]) => url === '/credits/api/image/generate')).toHaveLength(1)
  })

  it.each(['http', 'http-malformed', 'unknown', 'cancelled', 'malformed', 'null', 'primitive', 'missing-ok', 'invalid-ok'] as const)(
    'retains the original submission after an unconfirmed %s generation failure', async (kind) => {
      const original = fetchMock.getMockImplementation()!
      fetchMock.mockImplementation(async (input, init) => {
        if (input !== '/credits/api/image/generate') return await original(input, init)
        if (kind === 'http') return Response.json({ ok: false, code: 'INVALID_REQUEST' }, { status: 503 })
        if (kind === 'http-malformed') return new Response('private service output', { status: 503 })
        if (kind === 'malformed') return new Response('private malformed output')
        if (kind === 'null') return Response.json(null)
        if (kind === 'primitive') return Response.json('private primitive output')
        if (kind === 'missing-ok') return Response.json({ message: 'private incomplete output' })
        if (kind === 'invalid-ok') return Response.json({ ok: 'true', message: 'private invalid output' })
        return json({ ok: false, code: kind === 'cancelled' ? 'CANCELLED' : 'UNKNOWN' })
      })
      const { props, store } = makeProps()
      const view = render(<ImagePage {...props} />)
      await ready()
      fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: '保留原任务与草稿' } })
      fireEvent.click(screen.getByRole('button', { name: zh.submit }))
      await screen.findByRole('alert')
      expect(screen.getByRole('alert').textContent).toBe(zh.generationConnectionLost)
      expect(Object.values(store.getSnapshot().unsettled)[0]).toMatchObject({ state: 'unknown', canQuery: false })
      expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', true)
      expect(view.container.textContent).not.toContain('private')
      view.unmount()
      render(<ImagePage {...props} />)
      await ready()
      expect(screen.getByRole('button', { name: zh.submit })).toHaveProperty('disabled', true)
      fireEvent.click(screen.getByRole('button', { name: zh.submit }))
      expect(fetchMock.mock.calls.filter(([url]) => url === '/credits/api/image/generate')).toHaveLength(1)
    },
  )

  it('does not display raw model-catalog failures', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => input === '/credits/api/media/catalog'
      ? json({ ok: false, code: 'PRIVATE_CODE', message: 'internal upstream route' }) : await original(input, init))
    const { props } = makeProps()
    const view = render(<ImagePage {...props} />)
    expect(await screen.findByText(t('modelsFailed', { message: zh.operationFailed }))).toBeTruthy()
    expect(view.container.textContent).not.toContain('PRIVATE_CODE')
    expect(view.container.textContent).not.toContain('internal upstream route')
  })

  it.each([
    ['network', zh.networkFailure], ['timeout', zh.requestTimeout], ['service', zh.serviceUnavailable],
    ['service-text', zh.serviceUnavailable], ['service-invalid-envelope', zh.serviceUnavailable],
    ['unknown', zh.operationFailed], ['invalid-json', zh.operationFailed],
  ])('distinguishes %s catalog failures using the observed request result', async (kind, expected) => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => {
      if (input !== '/credits/api/media/catalog') return await original(input, init)
      if (kind === 'network') throw new TypeError('private transport details')
      if (kind === 'timeout') throw new DOMException('private timeout details', 'TimeoutError')
      if (kind === 'service') return Response.json({ ok: false }, { status: 503 })
      if (kind === 'service-text') return new Response('private malformed output', { status: 503 })
      if (kind === 'service-invalid-envelope') return Response.json(null, { status: 503 })
      if (kind === 'invalid-json') return new Response('private malformed output')
      throw new Error('private unexpected details')
    })
    const { props } = makeProps()
    const view = render(<ImagePage {...props} />)
    expect(await screen.findByText(t('modelsFailed', { message: expected }))).toBeTruthy()
    expect(view.container.textContent).not.toContain('private')
  })

  it('keeps only image/video modes while linking generated images to the selected conversation', async () => {
    chatSessionId = 'session-selected'
    const { props } = makeProps()
    render(<ImagePage {...props} />)
    await ready()
    fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: '角色定妆照' } })
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    await screen.findByText(zh.done)
    expect(requestBody(fetchMock.mock.calls.find(([url]) => url === '/credits/api/image/generate')))
      .toMatchObject({ session_id: 'session-selected', account_id: 'account-a' })
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([zh['tab.image'], zh['tab.video']])
    expect(vi.mocked(props.renderFactorySlot).mock.calls.every(([name]) => name === 'creation.prompt.assist')).toBe(true)
    expect(screen.queryByRole('region', { name: '创作项目' })).toBeNull()
  })

  it('keeps a pending generation owned by its original conversation after switching chats', async () => {
    let finish!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { finish = resolve })
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => input === '/credits/api/image/generate'
      ? await pending : await original(input, init))
    const { props, store } = makeProps()
    const view = render(<ImagePage {...props} />)
    await ready()
    fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: '画一朵云' } })
    fireEvent.click(screen.getByRole('button', { name: zh.submit }))
    expect(store.getSnapshot().generationStartedAt).not.toBeNull()
    chatSessionId = 'session-b'
    view.rerender(<ImagePage {...props} />)
    expect(requestBody(fetchMock.mock.calls.find(([url]) => url === '/credits/api/image/generate')))
      .toMatchObject({ session_id: 'session-a', account_id: 'account-a' })
    await act(async () => { finish(json({ ok: true, payload: { path } })) })
    expect(store.getSnapshot().generationStartedAt).toBeNull()
  })

  it('requires a selected conversation before starting a paid generation', async () => {
    chatSessionId = undefined
    const { props } = makeProps()
    render(<ImagePage {...props} />)
    await ready()
    fireEvent.change(screen.getByRole('textbox', { name: zh.prompt }), { target: { value: '画一朵云' } })
    expect(screen.getByText(zh.sessionRequired)).toBeTruthy()
    const submit = screen.getByRole('button', { name: zh.submit })
    expect(submit).toHaveProperty('disabled', true)
    fireEvent.click(submit)
    expect(fetchMock.mock.calls.some(([url]) => url === '/credits/api/image/generate')).toBe(false)
  })

  it('keeps mounted workspace coordinates in image history, previews, downloads and reference uploads', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => requestUrl(input) === '/artifacts/api/list'
      ? json({ items: ['mount-one', 'mount-two'].map(workspaceId => ({
        path: 'artifacts/角色.png', workspaceId, name: '角色.png', kind: 'image', mtimeMs: 8,
      })) }) : await original(input, init))
    const { props, store } = makeProps()
    render(<ImagePage {...props} />)
    await ready()
    const previews = await screen.findAllByRole('button', { name: t('previewNamed', { name: '角色.png' }) })
    expect(previews).toHaveLength(2)
    fireEvent.click(previews[1]!)
    const source = `/artifacts/api/raw?path=${encodeURIComponent('artifacts/角色.png')}&workspaceId=mount-two`
    expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe(source)
    fireEvent.click(screen.getByRole('button', { name: zh.closePreview }))
    expect(screen.getAllByRole('link', { name: zh.download })[1]?.getAttribute('href')).toBe(source)
    fireEvent.click(screen.getAllByRole('button', { name: zh.useAsReference })[1]!)
    await waitFor(() => { expect(store.getSnapshot().references).toHaveLength(1) })
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input) === source)).toBe(true)
  })

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

  it('uses the converted size for the material budget and reports each oversized original', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => {
      if (requestUrl(input) !== '/credits/api/assets') return await original(input, init)
      assets += 1
      const assetId = `ma_${String(assets)}`
      return json({ ok: true, asset: { assetId, contentType: 'image/jpeg', sizeBytes: 6 * 1024 * 1024,
        converted: true, previewUrl: `/credits/api/assets/preview?asset_id=${assetId}` } })
    })
    const { props, store } = makeProps()
    render(<ImagePage {...props} />)
    await ready()
    const drop = (files: File[]) => { fireEvent.drop(screen.getByRole('region', { name: '图片创作工作台' }), { dataTransfer: { files } }) }
    drop([new File([new Uint8Array(32 * 1024 * 1024 + 1)], 'oversized.png', { type: 'image/png' })])
    await waitFor(() => { expect(store.getSnapshot().uploading).toBe(false) })
    expect(assets).toBe(0)
    expect(screen.getByRole('list', { name: zh.uploadFailures }).textContent).toContain('oversized.png')
    drop([new File([new Uint8Array(8 * 1024 * 1024)], 'first.heic'), new File([new Uint8Array(8 * 1024 * 1024)], 'second.heic'), new File(['x'], 'excess.png', { type: 'image/png' })])
    await waitFor(() => { expect(store.getSnapshot().uploading).toBe(false); expect(assets).toBe(3) })
    expect(store.getSnapshot().references).toHaveLength(2)
    expect(store.getSnapshot().references.map(item => item.bytes)).toEqual([6 * 1024 * 1024, 6 * 1024 * 1024])
    expect(screen.getByRole('list', { name: zh.uploadFailures }).textContent).toContain(`excess.png${zh.referenceTotalLimit}`)
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
    fireEvent.change(screen.getByLabelText('比例与尺寸'), { target: { value: '1536x1024' } })
    fireEvent.click(screen.getByRole('tab', { name: '视频' }))
    expect(props.openVideo).toHaveBeenCalledTimes(1)
    first.unmount()
    render(<ImagePage {...props} />)
    await ready()
    expect(screen.getByRole('textbox', { name: '画面描述' })).toHaveProperty('value', 'A green tea bottle')
    expect(store.getSnapshot().size).toBe('1536x1024')
    expect(screen.getByRole('combobox', { name: zh.ratio })).toHaveProperty('value', '1536x1024')
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
    expect(requestBody(request)).toEqual({ session_id: 'session-a', account_id: 'account-a', prompt: 'Product photo', model: 'text-model', count: 1, size: '768x768', references: [] })
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
    expect(screen.getByRole('button', { name: '生成图片' })).toHaveProperty('disabled', true)
    expect(fetchMock.mock.calls.filter(([url]) => url === '/credits/api/image/generate')).toHaveLength(1)
  })

  it('names rejected files and keeps later uploads after a transport failure', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => {
      if (requestUrl(input) === '/credits/api/assets') {
        const name = decodeURIComponent(new Headers(init?.headers).get('x-file-name') ?? '')
        if (name === 'offline.png') throw new TypeError('offline')
        if (name === 'broken.gif') return json({ ok: false, code: 'IMAGE_DECODE_FAILED', message: 'internal decoder detail' })
      }
      return await original(input, init)
    })
    const { props, store } = makeProps()
    const view = render(<ImagePage {...props} />)
    await ready()
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['png'], 'offline.png', { type: 'image/png' }),
      new File(['gif'], 'broken.gif', { type: 'image/gif' }), new File(['png'], 'good.png', { type: 'image/png' })] } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBe(false) })
    const errors = screen.getByRole('list', { name: zh.uploadFailures }).textContent
    expect(errors).toContain(`offline.png${zh.networkFailure}`)
    expect(errors).toContain(`broken.gif${zh.invalidImage}`)
    expect(errors).not.toContain('internal decoder detail')
    expect(screen.getByText(t('uploadSummary', { added: '1', failed: '2' }))).toBeTruthy()
    expect(screen.getByRole('button', { name: '添加素材' })).toHaveProperty('disabled', false)
    expect(store.getSnapshot().references.map(item => item.name)).toEqual(['good.png'])
  })

  it.each([
    ['service', zh.serviceUnavailable], ['unknown', zh.operationFailed], ['invalid-json', zh.operationFailed],
  ])('keeps a %s upload failure distinct from a network interruption', async (kind, expected) => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => {
      if (requestUrl(input) !== '/credits/api/assets') return await original(input, init)
      if (kind === 'service') return Response.json({ ok: false }, { status: 503 })
      if (kind === 'invalid-json') return new Response('private malformed output')
      throw new Error('private unexpected error')
    })
    const { props, store } = makeProps()
    const view = render(<ImagePage {...props} />)
    await ready()
    fireEvent.drop(screen.getByRole('region', { name: zh.composer }), {
      dataTransfer: { files: [new File(['image'], 'reference.png', { type: 'image/png' })] },
    })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBe(false) })
    expect(screen.getByRole('list', { name: zh.uploadFailures }).textContent).toContain(`reference.png${expected}`)
    expect(view.container.textContent).not.toContain('private')
    expect(store.getSnapshot().references).toEqual([])
    expect(fetchMock.mock.calls.some(([url]) => url === '/credits/api/image/generate')).toBe(false)
  })

  it('keeps three common-format references with normalized previews despite missing or incorrect MIME labels', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => {
      if (requestUrl(input) !== '/credits/api/assets') return await original(input, init)
      assets += 1
      const assetId = `ma_${String(assets)}`
      return json({ ok: true, asset: { assetId, originalName: 'source', sourceFormat: 'heif', contentType: 'image/jpeg',
        sizeBytes: 100, converted: true, firstFrameOnly: assets === 3, previewUrl: `/credits/api/assets/preview?asset_id=${assetId}` } })
    })
    const { props, store } = makeProps()
    const view = render(<ImagePage {...props} />)
    await ready()
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    for (const extension of ['jfif', 'avif', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif']) expect(input.accept).toContain(`.${extension}`)
    fireEvent.change(input, { target: { files: [new File(['heic'], '妈妈.HEIC'),
      new File(['tiff'], '孩子.tiff', { type: 'application/octet-stream' }), new File(['gif'], '步骤.gif', { type: 'image/gif' })] } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBe(false) })
    expect(store.getSnapshot().references.map(item => item.name)).toEqual(['妈妈.HEIC', '孩子.tiff', '步骤.gif'])
    expect(screen.getByText('3/6')).toBeTruthy()
    for (const [index, name] of ['妈妈.HEIC', '孩子.tiff', '步骤.gif'].entries()) {
      expect(screen.getByAltText(name).getAttribute('src')).toBe(`/credits/api/assets/preview?asset_id=ma_${String(index + 1)}`)
    }
    expect(screen.getByText(t('uploadConverted', { n: '3' }))).toBeTruthy()
    expect(screen.getByText(t('uploadFirstFrames', { n: '1' }))).toBeTruthy()
    expect(new Headers(fetchMock.mock.calls.find(([url]) => url === '/credits/api/assets')?.[1]?.headers).get('content-type')).toBe('application/octet-stream')
    expect(props.createReferencePreview).not.toHaveBeenCalled()
  })

  it('lists every skipped filename at the reference limit and clears batch feedback with the selection', async () => {
    const { props, store } = makeProps()
    render(<ImagePage {...props} />)
    await ready()
    const files = Array.from({ length: 8 }, (_, index) => new File(['image'], `${String(index + 1)}.png`, { type: 'image/png' }))
    fireEvent.drop(screen.getByRole('region', { name: zh.composer }), { dataTransfer: { files } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBe(false) })
    const failures = screen.getByRole('list', { name: zh.uploadFailures })
    expect(failures.textContent).toContain('7.png')
    expect(failures.textContent).toContain('8.png')
    expect(screen.getByText(t('uploadSummary', { added: '6', failed: '2' }))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.clearReferences }))
    expect(store.getSnapshot().uploadResult).toBeNull()
    expect(screen.queryByRole('list', { name: zh.uploadFailures })).toBeNull()
  })

  it('uses localized server failure codes and refuses foreign preview URLs without losing existing references', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => {
      if (requestUrl(input) !== '/credits/api/assets') return await original(input, init)
      const name = decodeURIComponent(new Headers(init?.headers).get('x-file-name') ?? '')
      if (name === 'foreign.heic') return json({ ok: true, asset: { assetId: 'ma_foreign', contentType: 'image/jpeg', sizeBytes: 2,
        converted: true, previewUrl: 'https://foreign.example/private.jpg' } })
      return new Response(JSON.stringify({ ok: false, code: 'IMAGE_PIXEL_LIMIT', message: 'private decoder path' }),
        { status: 413, headers: { 'content-type': 'application/json' } })
    })
    const { props, store } = makeProps()
    store.actions.appendReference({ assetId: 'ma_existing', name: 'existing.png', url: 'blob:existing', bytes: 1 })
    render(<ImagePage {...props} />)
    await ready()
    fireEvent.drop(screen.getByRole('region', { name: zh.composer }), { dataTransfer: {
      files: [new File(['large'], '超大.tiff'), new File(['heic'], 'foreign.heic')],
    } })
    await waitFor(() => { expect(store.getSnapshot().uploading).toBe(false) })
    const failures = screen.getByRole('list', { name: zh.uploadFailures }).textContent
    expect(failures).toContain(`超大.tiff${zh.imageDimensionsLimit}`)
    expect(failures).toContain(`foreign.heic${zh.invalidUploadResponse}`)
    expect(failures).not.toContain('private decoder path')
    expect(store.getSnapshot().references.map(item => item.assetId)).toEqual(['ma_existing'])
    sessionAccountId = 'account-b'
    fireEvent.focus(window)
    await waitFor(() => { expect(store.getSnapshot().referenceAccountId).toBe('account-b') })
    expect(store.getSnapshot().uploadResult).toBeNull()
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
