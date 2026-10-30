import { describe, expect, it, vi } from 'vitest'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { chooseChatVideoModel, chatVideoResolution, parseVideoModelQuote, readVideoModelQuote, videoModelQuoteSegment,
  type VideoModelCandidate, type VideoModelChoiceOptions, type VideoModelQuote } from '../src/video-model-choice.ts'
import earlyApiQuote from './fixtures/video-quote-early.json' with { type: 'json' }
import h3ApiQuote from './fixtures/video-quote-h3.json' with { type: 'json' }
import sd25ApiQuote from './fixtures/video-quote-sd25.json' with { type: 'json' }

const baseline = { model: 'MiniMax-H3', resolution: '768P', durations: [15, 15] }
const target = { model: 'other-video', resolution: '1280x720', durations: [15, 15] }
const now = 1_800_000_000_000

function fixture(extra: Partial<VideoModelChoiceOptions> = {}) {
  const assertCurrent = vi.fn(async () => {})
  const quote = vi.fn(async (candidate: VideoModelCandidate, workCount: number): Promise<VideoModelQuote> => ({
    ...candidate, accountId: 'account-a', workCount,
    estimatedAmount: String((candidate.model === 'MiniMax-H3' ? 3 : 6) * workCount), currency: 'CNY' as const,
    accountBinding: 'server-account-binding', specificationKey: JSON.stringify(candidate),
    pricingVersion: 'current-pricing', expiresAt: now + 60_000,
  }))
  const ask = vi.fn(async (questions: AskUserQuestionItem[]) => ({ answers: [{
    id: 'video-model-price-choice', selected: [questions[0]?.options?.[1]?.label ?? ''],
  }] }))
  const options = { target, baseline, accountId: 'account-a', workCount: 3,
    signal: new AbortController().signal, assertCurrent, quote, ask, now: () => now, ...extra }
  return { options, quote, ask, assertCurrent }
}

describe('chat video defaults', () => {
  it('quotes complete generic specifications without including prompts or reference bytes', () => {
    expect(videoModelQuoteSegment({ model: 'ycapi-seedance-2-0-official', prompt: 'private text',
      seconds: 5, duration: 5, resolution: '720p', size: '720p', ratio: '16:9', aspect_ratio: '16:9', quality: 'fast',
      metadata: { first_frame_image: 'data:image/png;base64,private', ratio: '16:9' },
      images: ['data:image/png;base64,private'],
    }, 0)).toEqual({ id: 'clip-1', parameters: { seconds: 5, resolution: '720p', size: '720p',
      ratio: '16:9', aspect_ratio: '16:9', quality: 'fast', metadata: { ratio: '16:9' } },
    reference_counts: { images: 1, videos: 0, audios: 0 } })
  })
  it('does not guess the price of generic reference video or audio usage', () => {
    expect(() => videoModelQuoteSegment({ model: 'generic', seconds: 5, metadata: { reference_video: ['private'] } }, 0))
      .toThrow(expect.objectContaining({ code: 'CREATIVE_VIDEO_QUOTE_UNAVAILABLE' }))
  })
  it('uses H3 768P unless the original human requested a different resolution', () => {
    expect(chatVideoResolution(undefined, 'MiniMax-H3')).toBe('768P')
    expect(chatVideoResolution('2K', 'MiniMax-H3')).toBe('768P')
    expect(chatVideoResolution('2K', 'MiniMax-H3', '2K')).toBe('2K')
    expect(chatVideoResolution(undefined, 'MiniMax-H3', '768k')).toBe('768P')
    expect(chatVideoResolution('768k', 'other-video')).toBe('768P')
    expect(chatVideoResolution('1280x720', 'other-video')).toBe('1280x720')
  })

  it('does not require a new question for the H3 candidate', async () => {
    const state = fixture({ target: baseline })
    expect(await chooseChatVideoModel(state.options)).toEqual(baseline)
    expect(state.ask).not.toHaveBeenCalled()
    expect(state.quote).not.toHaveBeenCalled()
    expect(state.assertCurrent).toHaveBeenCalledOnce()
  })
})

describe('price-informed video model selection', () => {
  it('asks the real user before allowing a non-H3 model and rechecks both estimates', async () => {
    const state = fixture()
    expect(await chooseChatVideoModel(state.options)).toEqual(target)
    expect(state.ask).toHaveBeenCalledOnce()
    const questions = state.ask.mock.calls[0]?.[0]
    expect(questions?.[0]?.detail).toContain('30 秒、2 个生成片段')
    expect(questions?.[0]?.detail).toContain('3 件作品估算总价')
    expect(questions?.[0]?.options?.map(option => option.label)).toEqual([
      '保留 H3 768P（约 ¥9.00）', '使用 other-video（约 ¥18.00）', '取消本次生成',
    ])
    expect(state.quote).toHaveBeenCalledTimes(4)
    expect(state.assertCurrent).toHaveBeenCalledTimes(2)
  })

  it('honors the human choosing H3 rather than the model-supplied alternative', async () => {
    const state = fixture({ ask: async questions => ({ answers: [{
      id: 'video-model-price-choice', selected: [questions[0]?.options?.[0]?.label ?? ''],
    }] }) })
    expect(await chooseChatVideoModel(state.options)).toEqual(baseline)
  })

  it.each([
    { quote: undefined, code: 'CREATIVE_VIDEO_QUOTE_UNAVAILABLE' },
    { ask: undefined, code: 'CREATIVE_VIDEO_MODEL_CHOICE_UNAVAILABLE' },
  ])('fails closed when a required trusted callback is missing: $code', async ({ code, ...extra }) => {
    const state = fixture(extra)
    await expect(chooseChatVideoModel(state.options)).rejects.toMatchObject({ code })
    expect(state.ask).not.toHaveBeenCalled()
  })

  it.each([
    { accountId: 'other-account' }, { workCount: 1 }, { estimatedAmount: 'NaN' }, { estimatedAmount: '-1' },
    { pricingVersion: '' }, { expiresAt: now }, { model: 'wrong-model' }, { durations: [15] }, { resolution: '2K' },
  ])('does not present an unbound or invalid quote: %o', async (delta) => {
    const state = fixture()
    state.quote.mockImplementation(async (candidate, workCount) => ({ ...candidate,
      accountBinding: 'server-account-binding', specificationKey: JSON.stringify(candidate),
      accountId: 'account-a', workCount, estimatedAmount: '3', currency: 'CNY' as const,
      pricingVersion: 'current', expiresAt: now + 60_000, ...delta }))
    await expect(chooseChatVideoModel(state.options)).rejects.toMatchObject({ code: 'CREATIVE_VIDEO_QUOTE_UNAVAILABLE' })
    expect(state.ask).not.toHaveBeenCalled()
  })

  it.each([
    { answers: [] }, { answers: [{ id: 'wrong-question', selected: ['使用 other-video（约 ¥18.00）'] }] },
    { answers: [{ id: 'video-model-price-choice', selected: ['使用 other-video（约 ¥18.00）'], custom: 'approve' }] },
    { answers: [{ id: 'video-model-price-choice', selected: ['使用 other-video（约 ¥18.00）', '保留 H3 768P（约 ¥9.00）'] }] },
  ])('requires an exact single human answer: %o', async (answer) => {
    const state = fixture({ ask: async () => answer })
    await expect(chooseChatVideoModel(state.options)).rejects.toMatchObject({ code: 'CREATIVE_VIDEO_MODEL_CHOICE_UNAVAILABLE' })
    expect(state.quote).toHaveBeenCalledTimes(2)
  })

  it('honors a real cancellation without accepting the model-supplied alternative', async () => {
    const state = fixture({ ask: async () => ({ answers: [{ id: 'video-model-price-choice', selected: ['取消本次生成'] }] }) })
    await expect(chooseChatVideoModel(state.options)).rejects.toMatchObject({ code: 'USER_CANCELLED' })
    expect(state.quote).toHaveBeenCalledTimes(2)
  })

  it.each(['取消本次生成', '取消', '不用了', '暂不生成', 'cancel', 'stop', '  CaNcEl\n', 'ＳＴＯＰ'])
  ('honors the current price card free-text cancellation %j', async (custom) => {
    const onApproved = vi.fn()
    const state = fixture({ onApproved, ask: async () => ({ answers: [{
      id: 'video-model-price-choice', selected: [], custom,
    }] }) })
    await expect(chooseChatVideoModel(state.options)).rejects.toMatchObject({ code: 'USER_CANCELLED' })
    expect(state.quote).toHaveBeenCalledTimes(2)
    expect(onApproved).not.toHaveBeenCalled()
  })

  it('honors explicit free-text cancellation even when the same answer retains a model radio selection', async () => {
    const onApproved = vi.fn()
    const state = fixture({ onApproved, ask: async questions => ({ answers: [{
      id: 'video-model-price-choice', selected: [questions[0]?.options?.[1]?.label ?? ''], custom: '取消',
    }] }) })
    await expect(chooseChatVideoModel(state.options)).rejects.toMatchObject({ code: 'USER_CANCELLED' })
    expect(onApproved).not.toHaveBeenCalled()
    expect(state.quote).toHaveBeenCalledTimes(2)
  })

  it.each([
    { answers: [{ id: 'another-question', selected: [], custom: '取消' }] },
    { answers: [{ id: 'another-question', selected: ['取消本次生成'] }] },
    { answers: [{ id: 'video-model-price-choice', selected: [], custom: '取消' }, { id: 'another-question', selected: [] }] },
  ])('does not treat an out-of-context or non-unique answer as cancellation: %o', async (answer) => {
    const state = fixture({ ask: async () => answer })
    await expect(chooseChatVideoModel(state.options)).rejects.toMatchObject({ code: 'CREATIVE_VIDEO_MODEL_CHOICE_UNAVAILABLE' })
    expect(state.quote).toHaveBeenCalledTimes(2)
  })

  it.each(['继续', '不要取消', 'cancel later', '使用 other-video（约 ¥18.00）'])
  ('does not infer approval or cancellation from other free-text answers %j', async (custom) => {
    const onApproved = vi.fn()
    const state = fixture({ onApproved, ask: async () => ({ answers: [{
      id: 'video-model-price-choice', selected: [], custom,
    }] }) })
    await expect(chooseChatVideoModel(state.options)).rejects.toMatchObject({ code: 'CREATIVE_VIDEO_MODEL_CHOICE_UNAVAILABLE' })
    expect(onApproved).not.toHaveBeenCalled()
    expect(state.quote).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['ASK_CANCELLED', 'USER_CANCELLED'], ['NO_PROVIDER', 'CREATIVE_VIDEO_MODEL_CHOICE_UNAVAILABLE'],
  ])('distinguishes the real card dismissal %s from a missing answerer', async (code, expected) => {
    const state = fixture({ ask: async () => { throw new UserQuestionError('safe question state', code) } })
    await expect(chooseChatVideoModel(state.options)).rejects.toMatchObject({ code: expected })
    expect(state.quote).toHaveBeenCalledTimes(2)
  })

  it('asks again if the real price changes while the user chooses', async () => {
    const state = fixture()
    let reads = 0
    state.quote.mockImplementation(async (candidate, workCount) => ({ ...candidate, accountId: 'account-a', workCount,
      accountBinding: 'server-account-binding', specificationKey: JSON.stringify(candidate),
      estimatedAmount: ++reads <= 2 ? '3' : '4', currency: 'CNY' as const,
      pricingVersion: reads <= 2 ? 'old' : 'new', expiresAt: now + 60_000 }))
    expect(await chooseChatVideoModel(state.options)).toEqual(target)
    expect(state.ask).toHaveBeenCalledTimes(2)
    expect(state.ask.mock.calls[1]?.[0]?.[0]?.options?.[1]?.label).toBe('使用 other-video（约 ¥4.00）')
  })

  it('refuses unstable estimates instead of accepting a stale approval', async () => {
    const state = fixture()
    let reads = 0
    state.quote.mockImplementation(async (candidate, workCount) => ({ ...candidate, accountId: 'account-a', workCount,
      accountBinding: 'server-account-binding', specificationKey: JSON.stringify(candidate),
      estimatedAmount: String(++reads), currency: 'CNY' as const, pricingVersion: String(reads), expiresAt: now + 60_000 }))
    await expect(chooseChatVideoModel(state.options)).rejects.toMatchObject({ code: 'CREATIVE_VIDEO_QUOTE_CHANGED' })
    expect(state.ask).toHaveBeenCalledTimes(2)
  })

  it('asks again when the displayed estimate expired even if the current price is unchanged', async () => {
    let clock = now
    let questionsAsked = 0
    const state = fixture({ now: () => clock, ask: async (questions) => {
      if (++questionsAsked === 1) clock += 60_001
      return { answers: [{ id: 'video-model-price-choice', selected: [questions[0]?.options?.[1]?.label ?? ''] }] }
    } })
    state.quote.mockImplementation(async (candidate, workCount) => ({ ...candidate, accountId: 'account-a', workCount,
      accountBinding: 'server-account-binding', specificationKey: JSON.stringify(candidate),
      estimatedAmount: '3', currency: 'CNY' as const, pricingVersion: 'same-version', expiresAt: clock + 60_000 }))
    expect(await chooseChatVideoModel(state.options)).toEqual(target)
    expect(questionsAsked).toBe(2)
  })

  it('requotes a second clip across the original TTL and continues only with an unchanged fresh estimate', async () => {
    let clock = now
    let changed = false
    let approval: { assertCurrent(signal: AbortSignal): Promise<void> } | undefined
    const state = fixture({ now: () => clock, onApproved: (value) => { approval = value } })
    state.quote.mockImplementation(async (candidate, workCount) => ({ ...candidate, accountId: 'account-a', workCount,
      accountBinding: 'server-account-binding', specificationKey: JSON.stringify(candidate),
      estimatedAmount: changed ? '4' : '3', currency: 'CNY' as const, pricingVersion: 'same-version', expiresAt: clock + 60_000 }))
    await chooseChatVideoModel(state.options)
    expect(approval).toBeDefined()
    await approval?.assertCurrent(new AbortController().signal)
    clock += 60_001
    await approval?.assertCurrent(new AbortController().signal)
    changed = true
    await expect(approval?.assertCurrent(new AbortController().signal)).rejects.toMatchObject({ code: 'CREATIVE_VIDEO_QUOTE_CHANGED' })
  })

  it('displays actual USD and nonzero tiny decimal amounts without currency conversion or rounding to zero', async () => {
    const state = fixture()
    state.quote.mockImplementation(async (candidate, workCount) => ({ ...candidate, accountId: 'account-a', workCount,
      accountBinding: 'server-account-binding', specificationKey: JSON.stringify(candidate),
      estimatedAmount: '0.0000000001', currency: 'USD' as const, pricingVersion: 'usd-version', expiresAt: now + 60_000 }))
    await chooseChatVideoModel(state.options)
    expect(state.ask.mock.calls[0]?.[0]?.[0]?.options?.[1]?.label).toContain('US$0.0000000001')
  })

  it('offers only the strictly quoted target and cancellation when H3 is unavailable for the combination', async () => {
    const state = fixture({ baseline: undefined, ask: async (questions) => {
      expect(questions[0]?.options).toHaveLength(2)
      expect(questions[0]?.detail).toContain('H3 不支持当前组合或暂无法核实报价')
      return { answers: [{ id: 'video-model-price-choice', selected: [questions[0]?.options?.[0]?.label ?? ''] }] }
    } })
    expect(await chooseChatVideoModel(state.options)).toEqual(target)
    expect(state.quote).toHaveBeenCalledTimes(2)
  })

  it('refuses account changes and cancellation before a paid request could start', async () => {
    const state = fixture()
    state.assertCurrent.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('account changed'))
    await expect(chooseChatVideoModel(state.options)).rejects.toThrow('account changed')
    expect(state.quote).toHaveBeenCalledTimes(2)
    const abort = new AbortController()
    abort.abort()
    const cancelled = fixture({ signal: abort.signal })
    await expect(chooseChatVideoModel(cancelled.options)).rejects.toThrow()
    expect(cancelled.ask).not.toHaveBeenCalled()
  })
})

describe('actual gateway quote contract', () => {
  it('binds the unmodified multi-spec actual handler response without claiming production prices', () => {
    const request = earlyApiQuote.request
    const candidate = { model: request.model, durations: [5, 8] }
    const quote = parseVideoModelQuote(earlyApiQuote.response, request, candidate, 'local-account',
      (earlyApiQuote.response.created_at + 1) * 1000)
    expect(quote).toMatchObject({ estimatedAmount: '17.64', currency: 'CNY', workCount: 3,
      accountId: 'local-account', accountBinding: earlyApiQuote.response.account_binding })
    expect(earlyApiQuote.outbound_requests).toBe(0)
    expect(earlyApiQuote.database_unchanged).toBe(true)
  })

  it.each([h3ApiQuote, sd25ApiQuote])('reads the exact native 15s handler fixture for $request.model', async (api) => {
    const candidate = { model: api.request.model, durations: [15] }
    const transport = vi.fn(async () => new Response(JSON.stringify(api.response)))
    const quote = await readVideoModelQuote({ request: api.request, candidate, accountId: 'local-account',
      signal: new AbortController().signal, transport, now: () => (api.response.created_at + 1) * 1000 })
    expect(quote?.estimatedAmount).toBe(api.response.estimated_total)
    expect(transport).toHaveBeenCalledExactlyOnceWith(api.request, expect.any(AbortSignal))
  })

  it.each([
    { schema_version: 2 }, { charged: true }, { submitted: true }, { reserved: true },
    { currency: 'UNKNOWN' }, { estimated_total: 'NaN' }, { total_quota: -1 }, { model: 'other-model' },
    { works_count: 2 }, { expires_at: h3ApiQuote.response.created_at },
    { expires_at: h3ApiQuote.response.created_at + 90 },
  ])('rejects a malformed or non-estimate actual response: %o', (patch) => {
    expect(() => parseVideoModelQuote({ ...h3ApiQuote.response, ...patch }, h3ApiQuote.request,
      { model: h3ApiQuote.request.model, durations: [15] }, 'local-account', (h3ApiQuote.response.created_at + 1) * 1000))
      .toThrow(expect.objectContaining({ code: 'CREATIVE_VIDEO_QUOTE_UNAVAILABLE' }))
  })

  it('binds quota and per-clip amounts even if a faulty response reuses the same revision and displayed total', () => {
    const api = h3ApiQuote
    const original = parseVideoModelQuote(api.response, api.request, { model: api.request.model, durations: [15] },
      'local-account', (api.response.created_at + 1) * 1000)
    const mutation = { ...api.response, one_work_quota: api.response.one_work_quota + 1, total_quota: api.response.total_quota + 1,
      segments: api.response.segments.map(segment => ({ ...segment, quota: segment.quota + 1 })) }
    const changed = parseVideoModelQuote(mutation, api.request, { model: api.request.model, durations: [15] },
      'local-account', (api.response.created_at + 1) * 1000)
    expect(changed.pricingVersion).toBe(original.pricingVersion)
    expect(changed.estimatedAmount).toBe(original.estimatedAmount)
    expect(changed.specificationKey).not.toBe(original.specificationKey)
  })

  it('does not quote private multipart bytes, filenames, prompts, or metadata secrets', () => {
    const blackrx = videoModelQuoteSegment({ model: 'other-video', seconds: 15, size: '1280x720', gen_type: 'reference_to_video', n: 1,
      prompt: 'private prompt', _blackrxReferences: [{ kind: 'image', base64: 'SECRET', filename: '/private/source.jpg' }] }, 0)
    expect(blackrx).toEqual({ id: 'clip-1', parameters: { seconds: 15, size: '1280x720', gen_type: 'reference_to_video', n: 1 },
      reference_counts: { images: 1, videos: 0, audios: 0 } })
    const h3 = videoModelQuoteSegment({ model: 'MiniMax-H3', seconds: 15, metadata: { resolution: '768P', ratio: '16:9',
      authorization: 'SECRET', secretPath: '/private/source.jpg', first_frame_image: 'data:image/png;base64,SECRET',
      content: [{ type: 'text', text: 'private prompt' }, { type: 'image_url', image_url: { url: 'https://ref.invalid/?token=SECRET' } }] } }, 0)
    expect(h3).toEqual({ id: 'clip-1', parameters: { seconds: 15, metadata: { resolution: '768P', ratio: '16:9' } },
      reference_counts: { images: 2, videos: 0, audios: 0 } })
    expect(JSON.stringify([blackrx, h3])).not.toMatch(/SECRET|private|token|ref.invalid/u)
  })

  it.each(['video_url', 'audio_url'])('does not silently quote unknown H3 input durations as zero: %s', (type) => {
    expect(() => videoModelQuoteSegment({ model: 'MiniMax-H3', seconds: 15,
      metadata: { resolution: '768P', content: [{ type }] } }, 0))
      .toThrow(expect.objectContaining({ code: 'CREATIVE_VIDEO_QUOTE_UNAVAILABLE' }))
  })
})
