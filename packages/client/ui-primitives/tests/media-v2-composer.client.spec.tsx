// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MediaV2Composer } from '../src/MediaV2Composer.tsx'
import { mediaV2FormIssues } from '../src/media-v2-form.ts'
import { mediaV2Data, parseMediaV2Catalog } from '../src/media-v2-types.ts'
import type { MediaV2Asset, MediaV2Model, MediaV2Record, MediaV2Request, MediaV2Transport } from '../src/media-v2-types.ts'

const prefix = '/credits/api/media-v2'
const envelope = (data: unknown): unknown => ({ success: true, data })
function readBody(init?: RequestInit): unknown {
  if (typeof init?.body !== 'string') throw new Error('Expected JSON request body')
  const value: unknown = JSON.parse(init.body)
  return value
}
const source: MediaV2Model = {
  id: 'model-a', display_name: 'Image A（图生图都可）', kind: 'image', model_version: 'v1', enabled: true,
  parameters_schema: { type: 'object', additionalProperties: false, properties: {
    prompt: { type: 'string', 'x-ycapi-contract': { label: { zh: '描述' } } },
    mode: { type: 'string', enum: ['std', 'pro'], default: 'std', 'x-ycapi-contract': { label: { zh: '质量模式' } } },
    count: { type: 'integer', minimum: 1, maximum: 4, default: 1, 'x-ycapi-contract': { label: { zh: '数量' } } },
    transparent: { type: 'boolean', default: false, 'x-ycapi-contract': { label: { zh: '透明' } } },
    kinds: { type: 'array', 'x-ycapi-contract': { type: 'multi_enum', enum: ['a', 'b'], label: { zh: '标签' } } },
    images: { type: 'array', 'x-ycapi-contract': { label: { zh: '参考图' }, max_items_by_mode: { std: 2, pro: 1 } } },
  } },
  asset_fields: [{ name: 'images', media_kind: 'image', native_shape: 'multiple', min_items: 0, max_items: 2,
    mime_types: ['image/png'], constraints: { max_items_by_mode: { std: 2, pro: 1 } } }],
  intents: [{ id: 'text', label: '文生图', requires_assets: false }, { id: 'reference', label: '图生图', requires_assets: true }],
  pricing: { display: '按实际规格报价', credits_per_yuan: 1000, quote_required: true },
}
const asset = (id: string, model = source.id): MediaV2Asset => ({ asset_id: `ma2_${id}`, client_asset_id: id, model, state: 'ready', media_kind: 'image', mime_type: 'image/png', bytes: 1024, sha256: 'a'.repeat(64), expires_at: Date.now() / 1000 + 1000 })
function quoted(request: MediaV2Request): MediaV2Record {
  return { version: 1, owner: 'nonsecret-account', request, state: 'quoted', updated_at: Date.now() / 1000,
    quote: { quote_id: 'quote-a', client_operation_id: request.client_operation_id, request_sha256: 'b'.repeat(64), retail_cny: '0.25', credits: 250, credits_per_yuan: 1000, expires_at: Date.now() / 1000 + 120 } }
}
function backend(models: readonly MediaV2Model[] = [source], initial: readonly MediaV2Record[] = []) {
  let records = [...initial]
  const uploaded = new Map<string, MediaV2Asset>()
  const transport = vi.fn<MediaV2Transport>(async (path, init) => {
    if (path === `${prefix}/models`) return envelope({ models, credits_per_yuan: 1000 })
    if (path === `${prefix}/operations`) return envelope({ operations: records })
    if (path.startsWith(`${prefix}/assets?`)) {
      const url = new URL(path, 'http://localhost'), id = url.searchParams.get('client_asset_id') ?? '', model = url.searchParams.get('model') ?? ''
      const fields = models.find(item => item.id === model)?.asset_fields
      const field = fields?.find(item => item.name === url.searchParams.get('field')) ?? fields?.[0]
      const value = { ...asset(id, model), media_kind: field?.media_kind ?? 'image' as const, mime_type: field?.mime_types[0] ?? 'image/png', ...field?.media_kind === 'video' ? { duration_seconds: 5.2 } : {} }; uploaded.set(id, value); return envelope(value)
    }
    if (path.startsWith(`${prefix}/assets/by-client-id/`)) {
      const id = path.slice(`${prefix}/assets/by-client-id/`.length).split('?')[0] ?? ''
      return envelope(uploaded.get(id) ?? asset(id))
    }
    if (path === `${prefix}/quotes`) {
      const request = readBody(init) as MediaV2Request
      const value = quoted(request)
      records = [...records.filter(item => item.request.client_operation_id !== request.client_operation_id), value]
      return envelope(value)
    }
    if (path === `${prefix}/tasks`) {
      const body = readBody(init) as { client_operation_id: string }
      const original = records.find(item => item.request.client_operation_id === body.client_operation_id)
      if (original === undefined) throw new Error('Unexpected operation')
      const accepted: MediaV2Record = { ...original, state: 'accepted', task: { id: 'task-a', model: original.request.model, kind: models.find(item => item.id === original.request.model)?.kind ?? 'image', status: 'pending', is_final: false, artifacts: [] } }
      records = records.map(item => item === original ? accepted : item); return envelope(accepted)
    }
    if (path.startsWith(`${prefix}/operations/`)) return envelope(records.find(item => item.request.client_operation_id === path.slice(`${prefix}/operations/`.length)))
    if (path === `${prefix}/save`) {
      const body = readBody(init) as { client_operation_id: string }
      const value = records.find(item => item.request.client_operation_id === body.client_operation_id)
      return envelope({ ...value, saved: value?.task?.artifacts.map(item => ({ key: item.key, path: `/artifacts/${item.key}` })) })
    }
    throw new Error(`Unexpected path ${path}`)
  })
  return { transport, records: () => records }
}
const calls = (transport: ReturnType<typeof backend>['transport'], path: string): number => transport.mock.calls.filter(call => call[0] === path).length
async function opened(transport: MediaV2Transport, kind: 'image' | 'video' = 'image') {
  const view = render(<MediaV2Composer kind={kind} accountKey="account-a" transport={transport} onExit={() => undefined} />)
  await screen.findByRole('combobox', { name: '模型' })
  return view
}
async function upload(transport: ReturnType<typeof backend>['transport'], names = ['one.png']): Promise<void> {
  const before = transport.mock.calls.filter(call => call[0].startsWith(`${prefix}/assets?`)).length
  fireEvent.change(screen.getByLabelText('添加素材: 参考图'), { target: { files: names.map(name => new File(['png'], name, { type: 'image/png' })) } })
  await waitFor(() => { expect(transport.mock.calls.filter(call => call[0].startsWith(`${prefix}/assets?`))).toHaveLength(before + names.length) })
  await waitFor(() => { expect(screen.getByRole('combobox', { name: '模型' })).toHaveProperty('disabled', false) })
}
beforeEach(() => { sessionStorage.clear(); vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined); vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('MediaV2Composer', () => {
  it('renders declared primitive controls and keeps vendor quality separate from input intent', async () => {
    const api = backend(); await opened(api.transport)
    expect(screen.getByLabelText('数量')).toHaveProperty('type', 'number')
    expect(screen.getByLabelText('透明')).toHaveProperty('type', 'checkbox')
    expect(screen.getByLabelText('a')).toHaveProperty('type', 'checkbox')
    fireEvent.change(screen.getByLabelText('质量模式'), { target: { value: 'pro' } })
    expect(screen.getByRole('combobox', { name: '使用方式' })).toHaveProperty('value', 'text')
    expect(screen.queryByRole('textbox', { name: /json/iu })).toBeNull()
  })
  it('supports a source processor without a manufactured prompt field', async () => {
    const processor: MediaV2Model = { ...source, parameters_schema: { properties: { images: { type: 'array' } } },
      intents: [{ id: 'transform', label: '图片处理', requires_assets: true }], asset_fields: [{ ...source.asset_fields[0]!, min_items: 1 }] }
    const api = backend([processor]); await opened(api.transport)
    expect(screen.queryByLabelText('描述')).toBeNull()
    fireEvent.change(screen.getByRole('combobox', { name: '使用方式' }), { target: { value: 'transform' } })
    expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
  })
  it('quotes a no-prompt video processor using its real source asset and decimal controls', async () => {
    const processor: MediaV2Model = { ...source, id: 'video-processor', kind: 'video', display_name: '视频超分',
      parameters_schema: { properties: { source_video: { type: 'array', 'x-ycapi-contract': { label: { zh: '原视频' } } },
        strength: { type: 'number', minimum: 0.1, maximum: 2, default: 1.8, 'x-ycapi-contract': { label: { zh: '强度' } } } } },
      asset_fields: [{ name: 'source_video', media_kind: 'video', native_shape: 'single', min_items: 1, max_items: 1, mime_types: ['video/mp4'], constraints: {} }],
      intents: [{ id: 'transform', label: '视频处理', requires_assets: true }] }
    const api = backend([processor]); await opened(api.transport, 'video')
    expect(screen.getByLabelText('强度')).toHaveProperty('value', '1.8')
    expect(screen.getByLabelText('强度').getAttribute('step')).toBe('any')
    expect(screen.queryByLabelText('描述')).toBeNull()
    fireEvent.change(screen.getByRole('combobox', { name: '使用方式' }), { target: { value: 'transform' } })
    fireEvent.change(screen.getByLabelText('添加素材: 原视频'), { target: { files: [new File(['mp4'], 'clip.mp4', { type: 'video/mp4' })] } })
    await waitFor(() => { expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', false) })
    fireEvent.click(screen.getByRole('button', { name: '获取准确积分' })); await screen.findByText('本次费用: 250 积分')
    expect(api.records()[0]?.request.parameters).toEqual({ strength: 1.8 })
    expect(api.records()[0]?.request.assets.source_video).toHaveLength(1)
    expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
  })
  it('starts a jpeg draft without GIF-only defaults and preserves explicit conflicting values across format changes and restore', async () => {
    const flare: MediaV2Model = { ...source, id: 'flare-image', display_name: 'Flare', asset_fields: [], parameters_schema: { properties: {
      output_format: { type: 'string', enum: ['jpeg', 'gif'], default: 'jpeg', 'x-ycapi-contract': { label: { zh: '输出格式' } } },
      frame_count: { type: 'integer', minimum: 1, default: 9, 'x-ycapi-contract': { label: { zh: '帧数' }, available_when: { output_format: ['gif'] } } },
      frame_duration_ms: { type: 'integer', minimum: 1, default: 200, 'x-ycapi-contract': { label: { zh: '每帧时长' }, available_when: { output_format: ['gif'] } } },
    } } }
    const api = backend([flare]); const first = await opened(api.transport)
    expect(screen.getByLabelText('帧数')).toHaveProperty('value', '')
    expect(screen.getByLabelText('每帧时长')).toHaveProperty('value', '')
    expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: '获取准确积分' })); await screen.findByText('本次费用: 250 积分')
    expect(api.records()[0]?.request.parameters).toEqual({ output_format: 'jpeg' })
    fireEvent.change(screen.getByLabelText('输出格式'), { target: { value: 'gif' } })
    fireEvent.change(screen.getByLabelText('帧数'), { target: { value: '9' } })
    fireEvent.change(screen.getByLabelText('每帧时长'), { target: { value: '200' } })
    fireEvent.change(screen.getByLabelText('输出格式'), { target: { value: 'jpeg' } })
    expect(screen.getByLabelText('帧数')).toHaveProperty('value', '9')
    expect(screen.getByLabelText('每帧时长')).toHaveProperty('value', '200')
    expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
    first.unmount(); await opened(api.transport)
    expect(screen.getByLabelText('帧数')).toHaveProperty('value', '9')
    expect(screen.getByLabelText('每帧时长')).toHaveProperty('value', '200')
    expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
    expect(calls(api.transport, `${prefix}/quotes`)).toBe(1)
    expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
  })
  it('retains every uploaded asset and blocks an over-limit quality change without quote or generation', async () => {
    const api = backend(); await opened(api.transport); await upload(api.transport, ['one.png', 'two.png'])
    fireEvent.change(screen.getByRole('combobox', { name: '使用方式' }), { target: { value: 'reference' } })
    fireEvent.change(screen.getByLabelText('质量模式'), { target: { value: 'pro' } })
    expect(screen.getByText('one.png')).toBeTruthy(); expect(screen.getByText('two.png')).toBeTruthy()
    expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
    expect(calls(api.transport, `${prefix}/quotes`)).toBe(0); expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
  })
  it('preserves reference intent and old assets on a text-only model switch', async () => {
    const other: MediaV2Model = { ...source, id: 'text-only', display_name: 'Text only', asset_fields: [], intents: [source.intents[0]!] }
    const api = backend([source, other]); await opened(api.transport); await upload(api.transport)
    fireEvent.change(screen.getByRole('combobox', { name: '使用方式' }), { target: { value: 'reference' } })
    fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: other.id } })
    expect(screen.getByText('one.png')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '使用方式' })).toHaveProperty('value', 'reference')
    expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
  })
  it('keeps writing-only media explicit and leaves it out of the frozen generation body', async () => {
    const api = backend(); await opened(api.transport); await upload(api.transport)
    fireEvent.change(screen.getByLabelText('one.png: 使用方式'), { target: { value: 'writing' } })
    fireEvent.click(screen.getByRole('button', { name: '获取准确积分' }))
    await screen.findByText('本次费用: 250 积分')
    expect(api.records()[0]?.request.assets).toEqual({})
    expect(screen.getByText('one.png')).toBeTruthy()
    expect(screen.getByText('¥0.25')).toBeTruthy()
  })
  it('does not re-quote after a lost quote response and recovers the same operation UUID', async () => {
    const api = backend(), base = api.transport.getMockImplementation()!
    api.transport.mockImplementation(async (path, init) => { const response = await base(path, init); if (path === `${prefix}/quotes`) throw new Error('lost'); return response })
    await opened(api.transport); fireEvent.click(screen.getByRole('button', { name: '获取准确积分' }))
    await screen.findByText('本次费用: 250 积分')
    expect(calls(api.transport, `${prefix}/operations/${api.records()[0]!.request.client_operation_id}`)).toBe(1)
    expect(calls(api.transport, `${prefix}/quotes`)).toBe(1)
    expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
  })
  it('allows explicit draft correction only after a confirmed free-quote rejection and retains the rejected original', async () => {
    const api = backend(), base = api.transport.getMockImplementation()!
    let first = true
    api.transport.mockImplementation(async (path, init) => {
      const answer = await base(path, init)
      if (path === `${prefix}/quotes` && first) {
        first = false
        const original = api.records()[0]!
        const { quote: _quote, ...retained } = original
        api.records()[0] = { ...retained, state: 'quote-rejected', quote_failure: { code: 'invalid_parameters', message: '请缩短参考视频后重新报价；尚未提交生成。' } }
        return { success: false, error: { code: 'invalid_parameters', message: '请缩短参考视频后重新报价；尚未提交生成。' } }
      }
      return answer
    })
    await opened(api.transport)
    fireEvent.click(screen.getByRole('button', { name: '获取准确积分' }))
    expect((await screen.findByRole('alert')).textContent).toBe('请缩短参考视频后重新报价；尚未提交生成。')
    expect(screen.getByLabelText('描述')).toHaveProperty('disabled', true)
    const originalId = api.records()[0]!.request.client_operation_id
    fireEvent.click(screen.getByRole('button', { name: '继续编辑新草稿' }))
    expect(screen.getByLabelText('描述')).toHaveProperty('disabled', false)
    expect(screen.getByText(`操作编号: ${originalId}`)).toBeTruthy()
    expect(calls(api.transport, `${prefix}/quotes`)).toBe(1)
    expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: 'Explicitly corrected draft' } })
    fireEvent.click(screen.getByRole('button', { name: '获取准确积分' }))
    await screen.findByText('本次费用: 250 积分')
    expect(api.records()).toHaveLength(2)
    expect(api.records()[0]?.state).toBe('quote-rejected')
    expect(api.records()[0]?.request.client_operation_id).toBe(originalId)
    expect(api.records()[1]?.request.client_operation_id).not.toBe(originalId)
    expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
  })
  it('keeps an unknown free-quote response locked when the original lookup returns 404 instead of inferring rejection', async () => {
    const api = backend(), base = api.transport.getMockImplementation()!
    api.transport.mockImplementation(async (path, init) => {
      if (path.startsWith(`${prefix}/operations/`)) return { success: false, error: { code: 'operation_unknown', message: 'not found' } }
      const answer = await base(path, init)
      if (path === `${prefix}/quotes`) throw new Error('response lost')
      return answer
    })
    await opened(api.transport)
    fireEvent.click(screen.getByRole('button', { name: '获取准确积分' }))
    await screen.findByRole('alert')
    expect(screen.getByLabelText('描述')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
    expect(screen.queryByRole('button', { name: '继续编辑新草稿' })).toBeNull()
    expect(calls(api.transport, `${prefix}/quotes`)).toBe(1)
    expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
  })
  it('renews an expired unchanged quote using the same original operation UUID', async () => {
    const request: MediaV2Request = { client_operation_id: 'original-expired', model: source.id, model_version: source.model_version, intent: 'text', parameters: { mode: 'std', count: 1, transparent: false }, assets: {} }
    const original = quoted(request)
    const expired: MediaV2Record = { ...original, quote: { ...original.quote!, expires_at: Date.now() / 1000 - 10 } }
    sessionStorage.setItem('dsh:media-v2:draft-v1:image:account-a', JSON.stringify({ modelId: source.id, intent: 'text', parameters: request.parameters, assets: [], currentId: request.client_operation_id }))
    const api = backend([source], [expired]); await opened(api.transport)
    expect(await screen.findByText('报价已过期，请重新报价')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '获取准确积分' }))
    await waitFor(() => { expect(screen.queryByText('报价已过期，请重新报价')).toBeNull() })
    expect(api.records()).toHaveLength(1)
    expect(api.records()[0]?.request.client_operation_id).toBe(request.client_operation_id)
    expect(calls(api.transport, `${prefix}/quotes`)).toBe(1)
    expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
  })
  it('locks an existing same-version quote when explicit re-quote and original GET both lose their response', async () => {
    const api = backend(), base = api.transport.getMockImplementation()!
    let quoteCount = 0, uncertain = false
    api.transport.mockImplementation(async (path, init) => {
      if (path === `${prefix}/quotes` && ++quoteCount === 2) {
        uncertain = true
        const original = api.records()[0]!
        api.records()[0] = { ...original, state: 'unknown' }
        throw new Error('re-quote response lost')
      }
      if (uncertain && path.startsWith(`${prefix}/operations/`)) return { success: false, error: { code: 'operation_unknown', message: 'not found' } }
      return await base(path, init)
    })
    await opened(api.transport)
    fireEvent.click(screen.getByRole('button', { name: '获取准确积分' })); await screen.findByText('本次费用: 250 积分')
    const original = api.records()[0]!
    expect(screen.getByRole('button', { name: '确认生成' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: '获取准确积分' })); await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: '确认生成' })).toBeNull()
    expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
    expect(screen.queryByRole('button', { name: '继续编辑新草稿' })).toBeNull()
    expect(api.records()[0]).toMatchObject({ request: original.request, quote: original.quote, state: 'unknown' })
    expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: '更新原任务' }))
    await waitFor(() => { expect(calls(api.transport, `${prefix}/operations/${original.request.client_operation_id}`)).toBe(2) })
    expect(calls(api.transport, `${prefix}/quotes`)).toBe(2)
    expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
    expect(screen.queryByRole('button', { name: '确认生成' })).toBeNull()
  })
  it('requires an explicit same-operation configuration quote and fresh fee confirmation before submitting', async () => {
    const api = backend(), base = api.transport.getMockImplementation()!
    let catalogVersion = 'v1'
    let original: MediaV2Request | undefined
    api.transport.mockImplementation(async (path, init) => {
      if (path === `${prefix}/models`) return envelope({ models: [{ ...source, model_version: catalogVersion }], credits_per_yuan: 1000,
        capabilities: { same_operation_configuration_requote: true } })
      const answer = await base(path, init)
      if (path === `${prefix}/quotes`) {
        const request = readBody(init) as MediaV2Request
        original ??= request
        const current = api.records()[0]!
        const changed = request.model_version === 'v2'
        const record: MediaV2Record = { ...current, request: original, quote: { ...current.quote!, model_version: request.model_version,
          retail_cny: changed ? '0.50' : '0.25', credits: changed ? 500 : 250 } }
        api.records()[0] = record
        return envelope(record)
      }
      return answer
    })
    await opened(api.transport)
    fireEvent.click(screen.getByRole('button', { name: '获取准确积分' })); await screen.findByText('本次费用: 250 积分')
    const oldId = api.records()[0]!.request.client_operation_id
    catalogVersion = 'v2'
    fireEvent.click(screen.getByRole('button', { name: '刷新模型' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: '确认生成' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: '确认生成' }))
    expect(calls(api.transport, `${prefix}/quotes`)).toBe(1)
    expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: '获取准确积分' })); await screen.findByText('本次费用: 500 积分')
    const requests = api.transport.mock.calls.filter(call => call[0] === `${prefix}/quotes`).map(call => readBody(call[1]) as MediaV2Request)
    expect(requests[1]).toEqual({ ...requests[0], model_version: 'v2' })
    expect(requests[1]?.client_operation_id).toBe(oldId)
    expect(api.records()[0]?.request.model_version).toBe('v1')
    expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
    expect(screen.getByRole('button', { name: '确认生成' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: '确认生成' })); await screen.findByText('等待处理')
    expect(calls(api.transport, `${prefix}/tasks`)).toBe(1)
    expect(api.records()).toHaveLength(1)
  })
  it('does not submit or update an old-version quote without the same-operation capability', async () => {
    const request: MediaV2Request = { client_operation_id: 'original-v1', model: source.id, model_version: 'v1', intent: 'text', parameters: {}, assets: {} }
    const api = backend([source], [quoted(request)]), base = api.transport.getMockImplementation()!
    api.transport.mockImplementation(async (path, init) => path === `${prefix}/models`
      ? envelope({ models: [{ ...source, model_version: 'v2' }], credits_per_yuan: 1000, capabilities: { same_operation_configuration_requote: false } })
      : await base(path, init))
    sessionStorage.setItem('dsh:media-v2:draft-v1:image:account-a', JSON.stringify({ modelId: source.id, intent: 'text', parameters: {}, assets: [], currentId: request.client_operation_id }))
    await opened(api.transport)
    expect((await screen.findByRole('alert')).textContent).toContain('不支持同操作更新报价')
    expect(screen.getByRole('button', { name: '确认生成' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: '获取准确积分' })); fireEvent.click(screen.getByRole('button', { name: '确认生成' }))
    expect(calls(api.transport, `${prefix}/quotes`)).toBe(0)
    expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
    expect(api.records()[0]?.request.model_version).toBe('v1')
  })
  it('adopts an already accepted original task during a configuration quote race without a new task POST', async () => {
    const request: MediaV2Request = { client_operation_id: 'original-race', model: source.id, model_version: 'v1', intent: 'text', parameters: {}, assets: {} }
    const original = quoted(request)
    const accepted: MediaV2Record = { ...original, state: 'accepted', task: { id: 'original-task', model: source.id, kind: 'image', status: 'pending', is_final: false, artifacts: [] } }
    const api = backend([source], [original]), base = api.transport.getMockImplementation()!
    api.transport.mockImplementation(async (path, init) => {
      if (path === `${prefix}/models`) return envelope({ models: [{ ...source, model_version: 'v2' }], credits_per_yuan: 1000,
        capabilities: { same_operation_configuration_requote: true } })
      if (path === `${prefix}/quotes`) { api.records()[0] = accepted; return envelope(accepted) }
      return await base(path, init)
    })
    sessionStorage.setItem('dsh:media-v2:draft-v1:image:account-a', JSON.stringify({ modelId: source.id, intent: 'text', parameters: {}, assets: [], currentId: request.client_operation_id }))
    await opened(api.transport)
    expect(screen.getByRole('button', { name: '确认生成' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: '获取准确积分' })); await screen.findByText('等待处理')
    expect(api.records()).toHaveLength(1)
    expect(api.records()[0]?.task?.id).toBe('original-task')
    expect(calls(api.transport, `${prefix}/quotes`)).toBe(1)
    expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
    expect(screen.queryByRole('button', { name: '确认生成' })).toBeNull()
  })
  it('allows only original-operation GET recovery after an accepted submit loses its response', async () => {
    const api = backend(), base = api.transport.getMockImplementation()!
    api.transport.mockImplementation(async (path, init) => { const response = await base(path, init); if (path === `${prefix}/tasks`) throw new Error('lost'); return response })
    await opened(api.transport); fireEvent.click(screen.getByRole('button', { name: '获取准确积分' })); await screen.findByText('本次费用: 250 积分')
    fireEvent.click(screen.getByRole('button', { name: '确认生成' })); await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: '确认生成' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '更新原任务' })); await screen.findByText('等待处理')
    expect(calls(api.transport, `${prefix}/tasks`)).toBe(1)
    expect(api.records()).toHaveLength(1)
  })
  it('recovers an unresolved asset by its original upload key without a second upload POST', async () => {
    const api = backend(), base = api.transport.getMockImplementation()!
    api.transport.mockImplementation(async (path, init) => { const response = await base(path, init); if (path.startsWith(`${prefix}/assets?`)) throw new Error('lost'); return response })
    await opened(api.transport); await upload(api.transport)
    await screen.findByRole('button', { name: '核对原上传' })
    fireEvent.click(screen.getByRole('button', { name: '核对原上传' }))
    await waitFor(() => { expect(screen.queryByRole('button', { name: '核对原上传' })).toBeNull() })
    expect(api.transport.mock.calls.filter(call => call[0].startsWith(`${prefix}/assets?`))).toHaveLength(1)
  })
  it('remounts an accepted original operation without another submit', async () => {
    const api = backend(); const first = await opened(api.transport)
    fireEvent.click(screen.getByRole('button', { name: '获取准确积分' })); await screen.findByText('本次费用: 250 积分')
    fireEvent.click(screen.getByRole('button', { name: '确认生成' })); await screen.findByText('等待处理')
    first.unmount(); await opened(api.transport)
    expect(await screen.findByText('等待处理')).toBeTruthy()
    expect(calls(api.transport, `${prefix}/tasks`)).toBe(1)
    expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
  })
  it('keeps an unknown delisted-model operation discoverable in both workspaces and classifies only its recovered task', async () => {
    const video: MediaV2Model = { ...source, id: 'video-model', kind: 'video', display_name: 'Video A' }
    const request = (id: string, model: string): MediaV2Request => ({ client_operation_id: id, model,
      model_version: 'v1', intent: 'text', parameters: {}, assets: {} })
    const orphan: MediaV2Record = { version: 1, owner: 'nonsecret-account', request: request('old-orphan', 'retired-model'),
      state: 'unknown', updated_at: Date.now() / 1000 }
    const knownImage: MediaV2Record = { ...orphan, request: request('known-image', video.id), state: 'accepted',
      task: { id: 'image-task', model: video.id, kind: 'image', status: 'pending', is_final: false, artifacts: [] } }
    const knownVideo: MediaV2Record = { ...orphan, request: request('known-video', source.id), state: 'accepted',
      task: { id: 'video-task', model: source.id, kind: 'video', status: 'pending', is_final: false, artifacts: [] } }
    const recovered: MediaV2Record = { ...orphan, state: 'accepted', task: { id: 'original-video', model: orphan.request.model,
      kind: 'video', status: 'succeeded', is_final: true,
      artifacts: [{ key: 'original-clip', type: 'video', mime_type: 'video/mp4', order: 0, filename: 'original.mp4' }] } }
    const api = backend([source, video], [orphan, knownImage, knownVideo]), base = api.transport.getMockImplementation()!
    api.transport.mockImplementation(async (path, init) => {
      if (path === `${prefix}/operations/old-orphan`) { api.records()[0] = recovered; return envelope(recovered) }
      return await base(path, init)
    })
    const view = await opened(api.transport)
    expect(screen.getByText('操作编号: old-orphan')).toBeTruthy()
    expect(screen.getByText('操作编号: known-image')).toBeTruthy()
    expect(screen.queryByText('操作编号: known-video')).toBeNull()
    view.rerender(<MediaV2Composer kind="video" accountKey="account-a" transport={api.transport} onExit={() => undefined} />)
    await screen.findByText('操作编号: known-video')
    expect(screen.getByText('操作编号: old-orphan')).toBeTruthy()
    expect(screen.queryByText('操作编号: known-image')).toBeNull()
    view.rerender(<MediaV2Composer kind="image" accountKey="account-a" transport={api.transport} onExit={() => undefined} />)
    await screen.findByText('操作编号: known-image')
    const original = screen.getByText('操作编号: old-orphan').closest('article')!
    expect(within(original).getAllByRole('button')).toHaveLength(1)
    fireEvent.click(within(original).getByRole('button', { name: '更新原任务' }))
    await waitFor(() => { expect(screen.queryByText('操作编号: old-orphan')).toBeNull() })
    view.rerender(<MediaV2Composer kind="video" accountKey="account-a" transport={api.transport} onExit={() => undefined} />)
    await screen.findByText('original.mp4')
    expect(screen.getByText('操作编号: old-orphan')).toBeTruthy()
    expect(screen.getByText('操作编号: known-video')).toBeTruthy()
    expect(screen.queryByText('操作编号: known-image')).toBeNull()
    expect(calls(api.transport, `${prefix}/operations/old-orphan`)).toBe(1)
    expect(api.transport.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(0)
  })
  it('automatically reads a retained operation using the advertised interval and shows all completed outputs without POST', async () => {
    vi.useFakeTimers()
    const request: MediaV2Request = { client_operation_id: 'retained-operation', model: source.id, model_version: source.model_version, intent: 'text', parameters: {}, assets: {} }
    const initial: MediaV2Record = { ...quoted(request), state: 'accepted', task: { id: 'retained-task', model: source.id, kind: 'image', status: 'pending', is_final: false, artifacts: [] } }
    const api = backend([source], [initial]), base = api.transport.getMockImplementation()!
    api.transport.mockImplementation(async (path, init) => {
      if (path === `${prefix}/models`) return envelope({ models: [source], credits_per_yuan: 1000, poll_after_ms: 1000 })
      if (path === `${prefix}/operations/retained-operation`) return envelope({ ...initial, task: { ...initial.task!, status: 'succeeded', is_final: true,
        artifacts: [{ key: 'done', type: 'image', mime_type: 'image/png', order: 0, filename: 'arrived.png' }] } })
      return await base(path, init)
    })
    await act(async () => { render(<MediaV2Composer kind="image" accountKey="account-a" transport={api.transport} onExit={() => undefined} />) })
    expect(screen.getByText('等待处理')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByRole('img', { name: 'arrived.png' })).toBeTruthy()
    expect(calls(api.transport, `${prefix}/operations/retained-operation`)).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(calls(api.transport, `${prefix}/operations/retained-operation`)).toBe(1)
    expect(api.transport.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(0)
  })
  it.each(['unmount', 'account'] as const)('stops automatic original-operation reads after %s', async (exit) => {
    vi.useFakeTimers()
    const request: MediaV2Request = { client_operation_id: 'retained-operation', model: source.id, model_version: source.model_version, intent: 'text', parameters: {}, assets: {} }
    const initial: MediaV2Record = { ...quoted(request), state: 'accepted', task: { id: 'retained-task', model: source.id, kind: 'image', status: 'pending', is_final: false, artifacts: [] } }
    const api = backend([source], [initial]), base = api.transport.getMockImplementation()!
    api.transport.mockImplementation(async (path, init) => path === `${prefix}/models`
      ? envelope({ models: [source], credits_per_yuan: 1000, poll_after_ms: 1000 }) : await base(path, init))
    let view: ReturnType<typeof render> | undefined
    await act(async () => { view = render(<MediaV2Composer kind="image" accountKey="account-a" transport={api.transport} onExit={() => undefined} />) })
    expect(screen.getByText('等待处理')).toBeTruthy()
    await act(async () => {
      if (exit === 'unmount') view?.unmount()
      else view?.rerender(<MediaV2Composer kind="image" accountKey={null} transport={api.transport} onExit={() => undefined} />)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(calls(api.transport, `${prefix}/operations/retained-operation`)).toBe(0)
  })
  it('does not invent a polling interval when the capability is absent', async () => {
    vi.useFakeTimers()
    const request: MediaV2Request = { client_operation_id: 'retained-operation', model: source.id, model_version: source.model_version, intent: 'text', parameters: {}, assets: {} }
    const initial: MediaV2Record = { ...quoted(request), state: 'accepted', task: { id: 'retained-task', model: source.id, kind: 'image', status: 'pending', is_final: false, artifacts: [] } }
    const api = backend([source], [initial])
    await act(async () => { render(<MediaV2Composer kind="image" accountKey="account-a" transport={api.transport} onExit={() => undefined} />) })
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(calls(api.transport, `${prefix}/operations/retained-operation`)).toBe(0)
    expect(screen.getByRole('button', { name: '更新原任务' })).toBeTruthy()
  })
  it('shows every artifact, keeps GIF animated and SVG download-only, and saves all original keys', async () => {
    const request: MediaV2Request = { client_operation_id: 'original', model: source.id, model_version: source.model_version, intent: 'text', parameters: {}, assets: {} }
    const record: MediaV2Record = { ...quoted(request), state: 'accepted', task: { id: 'task-original', model: source.id, kind: 'image', status: 'succeeded', is_final: true, artifacts: [
      { key: 'vector', type: 'file', mime_type: 'image/svg+xml', order: 2, filename: 'vector.svg' },
      { key: 'layer', type: 'image', mime_type: 'image/png', order: 1, filename: 'layer.png' },
      { key: 'animation', type: 'image', mime_type: 'image/gif', order: 0, filename: 'animation.gif' },
    ] } }
    const api = backend([source], [record]); const view = await opened(api.transport)
    const results = screen.getByLabelText('全部产物')
    expect(within(results).getAllByRole('link', { name: '下载原文件' })).toHaveLength(3)
    expect(within(results).getAllByRole('img')).toHaveLength(2)
    expect(within(results).getAllByRole('img')[0]?.getAttribute('src')).toBe(`${prefix}/tasks/task-original/artifacts/animation/content`)
    expect(view.container.querySelector('svg')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '保存全部产物' }))
    await screen.findByText('/artifacts/vector')
    expect(calls(api.transport, `${prefix}/save`)).toBe(1); expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
  })
})

describe('media-v2 conditional field validation', () => {
  it('rejects option conditions and expired or wrong-model assets without dropping them', () => {
    const model: MediaV2Model = { ...source, parameters_schema: { properties: { quality: { type: 'string', enum: ['1080p'], 'x-ycapi-contract': { options: [{ value: '1080p', available_when: { mode: ['std'] } }] } } } } }
    const selected = [{ clientId: 'original-asset', model: 'another', field: 'images', name: 'one.png', state: 'ready' as const, role: 'generation' as const, asset: asset('original-asset', 'another') }]
    expect(mediaV2FormIssues(model, 'reference', { quality: '1080p', mode: 'pro' }, selected, Date.now() / 1000)).toContainEqual({ field: 'quality', reason: 'unavailable' })
    expect(mediaV2FormIssues(model, 'reference', {}, selected, Date.now() / 1000)).toContainEqual({ field: 'images', reason: 'binding' })
    expect(selected).toHaveLength(1)
  })
})

describe('media-v2 native reference intent', () => {
  const model: MediaV2Model = { ...source, id: 'native-reference-mode', kind: 'video', parameters_schema: { properties: {
    prompt: { type: 'string' },
    mode: { type: 'string', enum: ['text-to-video', 'reference', 'multi-reference'], default: 'reference',
      'x-ycapi-contract': { label: { zh: '生成模式' } } },
    images: { type: 'array', 'x-ycapi-contract': { label: { zh: '参考图' } } },
  } } }

  it.each(['reference', 'multi-reference'])('blocks text intent with native %s and no generation materials while retaining writing-only files', async (mode) => {
    const api = backend([model]); await opened(api.transport, 'video')
    fireEvent.change(screen.getByLabelText('生成模式'), { target: { value: mode } })
    expect(screen.getByRole('combobox', { name: '使用方式' })).toHaveProperty('value', 'text')
    expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: '获取准确积分' }))
    await upload(api.transport)
    fireEvent.change(screen.getByLabelText('one.png: 使用方式'), { target: { value: 'writing' } })
    expect(screen.getByText('one.png')).toBeTruthy()
    expect(screen.getByLabelText('one.png: 使用方式')).toHaveProperty('value', 'writing')
    expect(screen.getByLabelText('生成模式')).toHaveProperty('value', mode)
    expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: '获取准确积分' }))
    expect(calls(api.transport, `${prefix}/quotes`)).toBe(0)
    expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
  })

  it('quotes explicit text-to-video without manufacturing references', async () => {
    const api = backend([model]); await opened(api.transport, 'video')
    fireEvent.change(screen.getByLabelText('生成模式'), { target: { value: 'text-to-video' } })
    expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: '获取准确积分' }))
    await screen.findByText('本次费用: 250 积分')
    expect(api.records()[0]?.request).toMatchObject({ intent: 'text', parameters: { mode: 'text-to-video' }, assets: {} })
    expect(calls(api.transport, `${prefix}/quotes`)).toBe(1)
    expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
  })

  it('quotes reference intent with its complete selected material bindings', async () => {
    const api = backend([model]); await opened(api.transport, 'video')
    fireEvent.change(screen.getByRole('combobox', { name: '使用方式' }), { target: { value: 'reference' } })
    await upload(api.transport, ['one.png', 'two.png'])
    expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: '获取准确积分' }))
    await screen.findByText('本次费用: 250 积分')
    expect(screen.getByText('one.png')).toBeTruthy(); expect(screen.getByText('two.png')).toBeTruthy()
    const request = api.records()[0]?.request
    expect(request).toMatchObject({ intent: 'reference', parameters: { mode: 'reference' } })
    const uploaded = api.transport.mock.calls.filter(call => call[0].startsWith(`${prefix}/assets?`))
    expect(request?.assets.images).toEqual(uploaded.map(call => `ma2_${new URL(call[0], 'http://localhost').searchParams.get('client_asset_id') ?? ''}`))
    expect(calls(api.transport, `${prefix}/quotes`)).toBe(1)
    expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
  })
})

it('keeps native number and boolean choices typed and supports standard array item enums', async () => {
  const model: MediaV2Model = { ...source, asset_fields: [], parameters_schema: { properties: {
    fps: { type: 'integer', enum: [24, 30], default: 24 },
    sound: { type: 'boolean', enum: [false, true], default: false },
    layers: { type: 'array', items: { type: 'string', enum: ['foreground', 'background'] } },
  } } }
  const api = backend([model]); await opened(api.transport)
  fireEvent.change(screen.getByLabelText('fps'), { target: { value: '30' } })
  fireEvent.change(screen.getByLabelText('sound'), { target: { value: 'true' } })
  fireEvent.click(screen.getByLabelText('foreground'))
  fireEvent.click(screen.getByRole('button', { name: '获取准确积分' }))
  await screen.findByText('本次费用: 250 积分')
  expect(api.records()[0]?.request.parameters).toEqual({ fps: 30, sound: true, layers: ['foreground'] })
  expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
})

it('retains complete nested native JSON, blocks malformed editing and restores valid values without coercion', async () => {
  const model: MediaV2Model = { ...source, asset_fields: [], parameters_schema: { properties: {
    timeline: { type: 'array', items: { type: 'object', required: ['time', 'visible'], additionalProperties: false, properties: {
      time: { type: 'number', minimum: 0 }, visible: { type: 'boolean' }, note: { type: 'null' },
    } } },
  } } }
  const api = backend([model]); const view = await opened(api.transport)
  fireEvent.change(screen.getByLabelText('timeline'), { target: { value: '[{"time":0,"visible":true,"note":null}]' } })
  fireEvent.change(screen.getByLabelText('timeline'), { target: { value: '[{' } })
  expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
  expect(screen.getByText('请输入有效的 JSON，原参数保留且不会提交')).toBeTruthy()
  expect(calls(api.transport, `${prefix}/quotes`)).toBe(0)
  fireEvent.change(screen.getByLabelText('timeline'), { target: { value: '[{"time":1.5,"visible":false,"note":null}]' } })
  view.unmount(); await opened(api.transport)
  expect(screen.getByLabelText('timeline')).toHaveProperty('value', JSON.stringify([{ time: 1.5, visible: false, note: null }], null, 2))
  fireEvent.click(screen.getByRole('button', { name: '获取准确积分' }))
  await screen.findByText('本次费用: 250 积分')
  expect(api.records()[0]?.request.parameters.timeline).toEqual([{ time: 1.5, visible: false, note: null }])
  expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
})

it('blocks an invalid nested member before any quote and retains its complete draft for correction', async () => {
  const model: MediaV2Model = { ...source, asset_fields: [], parameters_schema: { properties: {
    motion: { type: 'object', additionalProperties: false, required: ['strength'], properties: { strength: { type: 'number', minimum: 0, maximum: 1 } } },
  } } }
  const api = backend([model]); await opened(api.transport)
  fireEvent.change(screen.getByLabelText('motion'), { target: { value: '{"strength":2}' } })
  expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
  expect(screen.getByLabelText('motion')).toHaveProperty('value', '{"strength":2}')
  expect(calls(api.transport, `${prefix}/quotes`)).toBe(0)
  fireEvent.change(screen.getByLabelText('motion'), { target: { value: '{"strength":0.8}' } })
  expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', false)
})

it('preserves explicit asset order across movement and restoration in the quoted request', async () => {
  const api = backend(); const view = await opened(api.transport); await upload(api.transport, ['first.png', 'last.png'])
  fireEvent.change(screen.getByRole('combobox', { name: '使用方式' }), { target: { value: 'reference' } })
  fireEvent.click(screen.getByRole('button', { name: '上移: last.png' }))
  const before = JSON.parse(sessionStorage.getItem('dsh:media-v2:draft-v1:image:account-a')!) as { assets: { name: string; asset: MediaV2Asset }[] }
  expect(before.assets.map(item => item.name)).toEqual(['last.png', 'first.png'])
  view.unmount(); await opened(api.transport)
  fireEvent.click(screen.getByRole('button', { name: '获取准确积分' }))
  await screen.findByText('本次费用: 250 积分')
  expect(api.records()[0]?.request.assets.images).toEqual(before.assets.map(item => item.asset.asset_id))
  expect(api.transport.mock.calls.filter(call => call[0].startsWith(`${prefix}/assets?`))).toHaveLength(2)
  expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
})

it('admits audio alongside images and videos, restores its original task and renders its original audio artifact', async () => {
  const audio: MediaV2Model = { ...source, id: 'native-audio', kind: 'audio', display_name: '原生音频', asset_fields: [], parameters_schema: { properties: { prompt: { type: 'string' } } } }
  const request: MediaV2Request = { client_operation_id: 'original-audio', model: audio.id, model_version: audio.model_version, intent: 'text', parameters: { prompt: '环境声' }, assets: {} }
  const original: MediaV2Record = { ...quoted(request), state: 'accepted', task: { id: 'original-audio-task', model: audio.id, kind: 'audio', status: 'succeeded', is_final: true,
    artifacts: [{ key: 'original-sound', type: 'audio', mime_type: 'audio/mpeg', order: 0, filename: '环境声.mp3' }] } }
  const api = backend([source, audio], [original])
  render(<MediaV2Composer kind="audio" accountKey="account-a" transport={api.transport} onExit={() => undefined} />)
  await screen.findByRole('combobox', { name: '模型' })
  expect(screen.getByRole('combobox', { name: '模型' }).textContent).toContain('原生音频')
  const link = await screen.findByRole('link', { name: '下载原文件' })
  expect(link.getAttribute('href')).toContain('/tasks/original-audio-task/artifacts/original-sound/content?download=1')
  expect(document.querySelector('audio')?.getAttribute('src')).toContain('/tasks/original-audio-task/artifacts/original-sound/content')
  fireEvent.click(screen.getByRole('button', { name: '更新原任务' }))
  await waitFor(() => { expect(calls(api.transport, `${prefix}/operations/original-audio`)).toBe(1) })
  expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
})

it('preserves unknown model conditions and visibly blocks quote instead of dropping the rule', async () => {
  const model: MediaV2Model = { ...source, asset_fields: [], conditions: [{ unsupported_rule: { parameter: 'count' } }] }
  const api = backend([model]); await opened(api.transport)
  expect(screen.getByText('当前客户端尚不支持这项参数规则，已停止报价，请更新后再使用')).toBeTruthy()
  expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
  expect(calls(api.transport, `${prefix}/quotes`)).toBe(0); expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
})

const policyModel: MediaV2Model = { ...source, id: 'conditional-material-video', display_name: '素材组合视频', kind: 'video',
  parameters_schema: { properties: {
    prompt: { type: 'string', 'x-ycapi-contract': { label: { zh: '描述' } } },
    mode: { type: 'string', enum: ['reference', 'first-frame'], 'x-ycapi-contract': { label: { zh: '素材模式' } } },
    images: { type: 'array', 'x-ycapi-contract': { label: { zh: '参考图' } } },
    videos: { type: 'array' }, audios: { type: 'array' },
  } },
  asset_fields: [{ ...source.asset_fields[0]!, max_items: 4, constraints: {} },
    { name: 'videos', media_kind: 'video', native_shape: 'multiple', min_items: 0, max_items: 2, mime_types: ['video/mp4'], constraints: {} },
    { name: 'audios', media_kind: 'audio', native_shape: 'multiple', min_items: 0, max_items: 2, mime_types: ['audio/mpeg'], constraints: {} }],
  intents: [{ id: 'reference', label: '参考生成', requires_assets: true }],
  conditions: { schema_version: 1, rules: [{ id: 'single-image-reference', when: { mode: ['reference'] }, asset_field: 'images',
    disallowed_counts: [1], message: 'Source image count requires an explicit choice' }] },
}
function policyAsset(field: 'images' | 'videos' | 'audios', id: string, role: 'generation' | 'writing' = 'generation') {
  return { clientId: id, model: policyModel.id, field, name: `${id}.media`, role, state: 'ready', asset: {
    ...asset(id, policyModel.id), media_kind: field === 'images' ? 'image' : field === 'videos' ? 'video' : 'audio',
    mime_type: field === 'images' ? 'image/png' : field === 'videos' ? 'video/mp4' : 'audio/mpeg',
  } }
}
function policyDraft(assets: readonly ReturnType<typeof policyAsset>[]) {
  sessionStorage.setItem('dsh:media-v2:draft-v1:video:account-a', JSON.stringify({ modelId: policyModel.id, intent: 'reference',
    parameters: { prompt: 'Keep my original draft and roles', mode: 'reference' }, currentId: null, assets }))
}

it('explains a material condition without discarding files and accepts an explicitly chosen frame mode', async () => {
  policyDraft([policyAsset('images', 'one')])
  const api = backend([policyModel]); await opened(api.transport, 'video')
  expect(screen.getByText('当前素材组合不符合所选模式的要求，请调整素材或模式；原素材已保留')).toBeTruthy()
  expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
  expect(screen.getByText('one.media')).toBeTruthy()
  expect(screen.getByLabelText('描述')).toHaveProperty('value', 'Keep my original draft and roles')
  expect(calls(api.transport, `${prefix}/quotes`)).toBe(0)
  fireEvent.change(screen.getByLabelText('素材模式'), { target: { value: 'first-frame' } })
  expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', false)
  fireEvent.click(screen.getByRole('button', { name: '获取准确积分' })); await screen.findByText('本次费用: 250 积分')
  expect(api.records()[0]?.request.parameters).toEqual({ prompt: 'Keep my original draft and roles', mode: 'first-frame' })
  expect(api.records()[0]?.request.assets).toEqual({ images: ['ma2_one'] })
  expect(calls(api.transport, `${prefix}/quotes`)).toBe(1); expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
})

it('counts only generation-role images and quotes their original order after an explicit role change', async () => {
  policyDraft([policyAsset('images', 'one'), policyAsset('images', 'two', 'writing')])
  const api = backend([policyModel]); await opened(api.transport, 'video')
  expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('combobox', { name: 'two.media: 使用方式' })).toHaveProperty('value', 'writing')
  expect(calls(api.transport, `${prefix}/quotes`)).toBe(0)
  fireEvent.change(screen.getByRole('combobox', { name: 'two.media: 使用方式' }), { target: { value: 'generation' } })
  expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', false)
  fireEvent.click(screen.getByRole('button', { name: '获取准确积分' })); await screen.findByText('本次费用: 250 积分')
  expect(api.records()[0]?.request.assets).toEqual({ images: ['ma2_one', 'ma2_two'] })
  expect(calls(api.transport, `${prefix}/quotes`)).toBe(1); expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
})

it('rejects audio without generation visual media and preserves both materials until the user changes the role', async () => {
  const model: MediaV2Model = { ...policyModel, conditions: { schema_version: 1, rules: [{ id: 'visual-companion',
    when: { mode: ['reference'] }, asset_field: 'audios', requires_any_assets: ['images', 'videos'], message: 'Audio requires visual media' }] } }
  policyDraft([policyAsset('audios', 'sound'), policyAsset('images', 'visual', 'writing')])
  const api = backend([model]); await opened(api.transport, 'video')
  expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
  expect(screen.getByText('sound.media')).toBeTruthy(); expect(screen.getByText('visual.media')).toBeTruthy()
  expect(calls(api.transport, `${prefix}/quotes`)).toBe(0)
  fireEvent.change(screen.getByRole('combobox', { name: 'visual.media: 使用方式' }), { target: { value: 'generation' } })
  fireEvent.click(screen.getByRole('button', { name: '获取准确积分' })); await screen.findByText('本次费用: 250 积分')
  expect(api.records()[0]?.request.assets).toEqual({ audios: ['ma2_sound'], images: ['ma2_visual'] })
  expect(calls(api.transport, `${prefix}/quotes`)).toBe(1); expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
})

it('permits audio with the remaining video role when images are disabled in the configured model', async () => {
  const model: MediaV2Model = { ...policyModel, asset_fields: policyModel.asset_fields.filter(field => field.name !== 'images'),
    conditions: { schema_version: 1, rules: [{ id: 'visual-companion', when: { mode: ['reference'] },
      asset_field: 'audios', requires_any_assets: ['images', 'videos'], message: 'Audio requires visual media' }] } }
  policyDraft([policyAsset('audios', 'sound'), policyAsset('videos', 'visual')])
  const api = backend([model]); await opened(api.transport, 'video')
  expect(screen.queryByLabelText('添加素材: 参考图')).toBeNull()
  expect(screen.getByText('sound.media')).toBeTruthy(); expect(screen.getByText('visual.media')).toBeTruthy()
  expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', false)
  fireEvent.click(screen.getByRole('button', { name: '获取准确积分' })); await screen.findByText('本次费用: 250 积分')
  expect(api.records()[0]?.request.assets).toEqual({ audios: ['ma2_sound'], videos: ['ma2_visual'] })
  expect(calls(api.transport, `${prefix}/quotes`)).toBe(1); expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
})

it('shows a hidden primary zero-count rule and preserves the draft instead of silently disabling quote', async () => {
  const model: MediaV2Model = { ...policyModel, conditions: { schema_version: 1, rules: [{ id: 'hidden-source-needed',
    when: { mode: ['reference'] }, asset_field: 'hidden_primary', disallowed_counts: [0], message: 'Unavailable primary source' }] } }
  policyDraft([policyAsset('images', 'original')])
  const api = backend([model]); await opened(api.transport, 'video')
  expect(screen.getByText('当前素材组合不符合所选模式的要求，请调整素材或模式；原素材已保留')).toBeTruthy()
  expect(screen.getByText('original.media')).toBeTruthy()
  expect(screen.getByLabelText('描述')).toHaveProperty('value', 'Keep my original draft and roles')
  expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
  expect(screen.queryByLabelText('添加素材: hidden primary')).toBeNull()
  expect(calls(api.transport, `${prefix}/quotes`)).toBe(0); expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
})

it('keeps original accepted UUID recovery available when the new catalog has unsupported material conditions', async () => {
  const request: MediaV2Request = { client_operation_id: '10000000-0000-4000-8000-000000000099', model: policyModel.id,
    model_version: 'old-version', intent: 'reference', parameters: { mode: 'reference', count: 2 }, assets: { videos: ['old-one', 'old-two'] } }
  const record: MediaV2Record = { ...quoted(request), state: 'accepted', task: { id: 'original-task', model: policyModel.id,
    kind: 'video', status: 'pending', is_final: false, artifacts: [] } }
  const api = backend([{ ...policyModel, conditions: { schema_version: 999, rules: [] } }], [record]); await opened(api.transport, 'video')
  fireEvent.click(screen.getByRole('button', { name: '更新原任务' }))
  await waitFor(() => { expect(calls(api.transport, `${prefix}/operations/${request.client_operation_id}`)).toBe(1) })
  expect(api.records()).toEqual([record])
  expect(api.records()[0]?.request).toEqual(request)
  expect(screen.getByText(`操作编号: ${request.client_operation_id}`)).toBeTruthy()
  expect(calls(api.transport, `${prefix}/quotes`)).toBe(0); expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
})

it('checks the declared upload byte cap before creating an upload identity or making a POST', async () => {
  const limited: MediaV2Model = { ...source, asset_fields: [{ ...source.asset_fields[0]!, constraints: { max_bytes: 2 } }] }
  const api = backend([limited]); await opened(api.transport)
  fireEvent.change(screen.getByLabelText('添加素材: 参考图'), { target: { files: [new File(['png'], 'too-large.png', { type: 'image/png' })] } })
  await screen.findByRole('alert')
  expect(api.transport.mock.calls.filter(call => call[0].startsWith(`${prefix}/assets?`))).toHaveLength(0)
  expect(screen.queryByText('too-large.png')).toBeNull()
  expect(calls(api.transport, `${prefix}/quotes`)).toBe(0)
})

it('uses the shared video and audio duration budget before quote without discarding either reference', async () => {
  const model: MediaV2Model = { ...source, id: 'native-reference-video', kind: 'video', parameters_schema: { properties: {
    videos: { type: 'array' }, audios: { type: 'array' },
  } }, intents: [{ id: 'reference', label: '多模态参考', requires_assets: true }], asset_fields: [
    { name: 'videos', media_kind: 'video', native_shape: 'multiple', min_items: 0, max_items: 10, mime_types: ['video/mp4'], constraints: { combined_duration_budget: true, max_total_duration_sec: 30 } },
    { name: 'audios', media_kind: 'audio', native_shape: 'multiple', min_items: 0, max_items: 10, mime_types: ['audio/mpeg'], constraints: { combined_duration_budget: true, max_total_duration_sec: 30 } },
  ] }
  const video = { ...asset('video', model.id), media_kind: 'video', mime_type: 'video/mp4', duration_seconds: 20, width: 1280, height: 720, fps: 30 }
  const audio = { ...asset('audio', model.id), media_kind: 'audio', mime_type: 'audio/mpeg', duration_seconds: 20 }
  sessionStorage.setItem('dsh:media-v2:draft-v1:video:account-a', JSON.stringify({ modelId: model.id, intent: 'reference', parameters: {}, currentId: null,
    assets: [{ clientId: 'video', model: model.id, field: 'videos', name: 'video.mp4', role: 'generation', state: 'ready', asset: video },
      { clientId: 'audio', model: model.id, field: 'audios', name: 'audio.mp3', role: 'generation', state: 'ready', asset: audio }] }))
  const api = backend([model]); await opened(api.transport, 'video')
  expect(screen.getByText('video.mp4')).toBeTruthy(); expect(screen.getByText('audio.mp3')).toBeTruthy()
  expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
  expect(calls(api.transport, `${prefix}/quotes`)).toBe(0)
  fireEvent.change(screen.getByLabelText('audio.mp3: 使用方式'), { target: { value: 'writing' } })
  fireEvent.click(screen.getByRole('button', { name: '获取准确积分' }))
  await screen.findByText('本次费用: 250 积分')
  expect(api.records()[0]?.request.assets).toEqual({ videos: ['ma2_video'] })
  expect(screen.getByText('audio.mp3')).toBeTruthy()
})

it.each([
  ['frame rate', { fps: 60 }, { min_fps: 24, max_fps: 59.94 }],
  ['mode minimum', { duration_seconds: 3.9 }, { min_duration_sec: 1.8, min_duration_sec_by_mode: { edit: 4 } }],
  ['mode maximum', { duration_seconds: 4 }, { max_clip_duration_sec_by_mode: { edit: 3 } }],
  ['pixel count', { width: 640, height: 480 }, { min_pixels: 409600 }],
  ['aspect ratio', { width: 1920, height: 300 }, { aspect_max: 2.5 }],
  ['reference plus output', { duration_seconds: 21 }, { max_ref_plus_output_sec: 30 }],
] as const)('blocks a server-observed %s violation before quote while keeping the original file', async (_case, metadata, constraints) => {
  const model: MediaV2Model = { ...source, id: 'native-metadata', kind: 'video', parameters_schema: { properties: { videos: { type: 'array' }, mode: { type: 'string', default: 'edit' }, duration: { type: 'string', default: '10' } } },
    intents: [{ id: 'transform', label: '视频处理', requires_assets: true }], asset_fields: [{ name: 'videos', media_kind: 'video', native_shape: 'single', min_items: 1, max_items: 1, mime_types: ['video/mp4'], constraints }] }
  const original = { ...asset('metadata', model.id), media_kind: 'video', mime_type: 'video/mp4', width: 1280, height: 720, fps: 30, duration_seconds: 5, ...metadata }
  sessionStorage.setItem('dsh:media-v2:draft-v1:video:account-a', JSON.stringify({ modelId: model.id, intent: 'transform', parameters: {}, currentId: null,
    assets: [{ clientId: 'metadata', model: model.id, field: 'videos', name: 'original.mp4', role: 'generation', state: 'ready', asset: original }] }))
  const api = backend([model]); await opened(api.transport, 'video')
  expect(screen.getByText('original.mp4')).toBeTruthy()
  expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
  expect(calls(api.transport, `${prefix}/quotes`)).toBe(0); expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
})

it('checks combined count and visual dependencies for audio references across named material fields', () => {
  const model: MediaV2Model = { ...source, id: 'native-combined', kind: 'video', parameters_schema: { properties: {
    images: { type: 'array' }, audios: { type: 'array' }, keep_original_audio: { type: 'boolean', 'x-ycapi-contract': { requires_media: ['videos'] } },
  } }, asset_fields: [
    { ...source.asset_fields[0]!, constraints: { max_combined_items: 2 } },
    { name: 'audios', media_kind: 'audio', native_shape: 'multiple', min_items: 0, max_items: 4, mime_types: ['audio/mpeg'], constraints: { requires_visual_reference: true } },
  ], intents: [{ id: 'reference', label: '多模态参考', requires_assets: true }] }
  const audio = { clientId: 'sound', model: model.id, field: 'audios', name: 'sound.mp3', role: 'generation' as const, state: 'ready' as const,
    asset: { ...asset('sound', model.id), media_kind: 'audio' as const, mime_type: 'audio/mpeg', duration_seconds: 5 } }
  expect(mediaV2FormIssues(model, 'reference', { keep_original_audio: true }, [audio], Date.now() / 1000)).toContainEqual({ field: 'audios', reason: 'required' })
  expect(mediaV2FormIssues(model, 'reference', { keep_original_audio: true }, [audio], Date.now() / 1000)).toContainEqual({ field: 'keep_original_audio', reason: 'required' })
  const images = ['one', 'two'].map(id => ({ clientId: id, model: model.id, field: 'images', name: `${id}.png`, role: 'generation' as const, state: 'ready' as const, asset: asset(id, model.id) }))
  const issues = mediaV2FormIssues(model, 'reference', { keep_original_audio: false }, [audio, ...images], Date.now() / 1000)
  expect(issues).toContainEqual({ field: 'images', reason: 'limit' })
  expect(issues).not.toContainEqual({ field: 'keep_original_audio', reason: 'required' })
})


it('uses the retained actual Go image catalog for reference editing without a text fallback', async () => {
  const captured: unknown = JSON.parse(readFileSync('packages/host/credits-index/tests/fixtures/media-v2-native-go-catalog.json', 'utf8'))
  const models = parseMediaV2Catalog(mediaV2Data(captured)).models
  const api = backend(models); await opened(api.transport)
  fireEvent.change(screen.getByLabelText('生成模式'), { target: { value: 'image-edit' } })
  fireEvent.change(screen.getByRole('combobox', { name: '使用方式' }), { target: { value: 'reference' } })
  fireEvent.change(screen.getByLabelText('添加素材: 参考图片'), { target: { files: [new File(['png'], 'source.png', { type: 'image/png' })] } })
  await waitFor(() => { expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', false) })
  fireEvent.click(screen.getByRole('button', { name: '获取准确积分' }))
  await screen.findByText('本次费用: 250 积分')
  expect(api.records()[0]?.request.model).toBe('ycapi-gpt-image-2.6-flare')
  expect(api.records()[0]?.request.intent).toBe('reference')
  expect(api.records()[0]?.request.parameters.mode).toBe('image-edit')
  expect(api.records()[0]?.request.assets.images).toHaveLength(1)
  expect(api.transport.mock.calls.find(call => call[0].startsWith(`${prefix}/assets?`))?.[0]).toContain('&field=images')
  expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
})


it('applies shared declared budgets even when an unused marked media field is unavailable in the selected mode', async () => {
  const model: MediaV2Model = { ...source, id: 'shared-budget-model', kind: 'video', parameters_schema: { properties: {
    mode: { type: 'string', default: 'reference' }, videos: { type: 'array' }, audios: { type: 'array' },
  } }, intents: [{ id: 'reference', label: '多模态参考', requires_assets: true }], asset_fields: [
    { name: 'videos', media_kind: 'video', native_shape: 'multiple', min_items: 0, max_items: 10, mime_types: ['video/mp4'], constraints: { combined_duration_budget: true, max_total_duration_sec: 30 } },
    { name: 'audios', media_kind: 'audio', native_shape: 'multiple', min_items: 0, max_items: 10, mime_types: ['audio/mpeg'], constraints: {
      combined_duration_budget: true, max_total_duration_sec: 10, max_combined_items: 0, available_when: { mode: ['audio-only'] },
    } },
  ] }
  const original = { ...asset('shared-budget-video', model.id), media_kind: 'video', mime_type: 'video/mp4', duration_seconds: 20 }
  sessionStorage.setItem('dsh:media-v2:draft-v1:video:account-a', JSON.stringify({ modelId: model.id, intent: 'reference', parameters: {}, currentId: null,
    assets: [{ clientId: 'shared-budget-video', model: model.id, field: 'videos', name: 'original.mp4', role: 'generation', state: 'ready', asset: original }] }))
  const api = backend([model]); await opened(api.transport, 'video')
  expect(screen.getByText('original.mp4')).toBeTruthy()
  expect(screen.getByRole('button', { name: '获取准确积分' })).toHaveProperty('disabled', true)
  expect(mediaV2FormIssues(model, 'reference', { mode: 'reference' }, [{ clientId: 'shared-budget-video', model: model.id, field: 'videos', name: 'original.mp4',
    role: 'generation', state: 'ready', asset: { ...original, media_kind: 'video' } }], Date.now() / 1000)).toContainEqual({ field: 'videos', reason: 'limit' })
  expect(calls(api.transport, `${prefix}/quotes`)).toBe(0); expect(calls(api.transport, `${prefix}/tasks`)).toBe(0)
})
