// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { AudioCreation } from '../src/client/AudioCreation.tsx'
import { zh } from '../src/client/locales.ts'
import { generateAudio, quoteAudio, readAudioModels, readAudioSubmissions, recoverAudio,
  type AudioModel } from '../src/client/audio-api.ts'
import type { AudioQuote } from '@deepseek-ai/dsh-credits-index/src/audio-generation.ts'

vi.mock('../src/client/audio-api.ts', () => ({ readAudioModels: vi.fn(), readAudioSubmissions: vi.fn(),
  quoteAudio: vi.fn(), generateAudio: vi.fn(), recoverAudio: vi.fn() }))
const dictionary: Readonly<Record<string, string>> = zh
const t: TranslateNS<'creative'> = (key, values) => Object.entries(values ?? {}).reduce((copy, [name, value]) =>
  copy.replaceAll(`{${name}}`, String(value)), dictionary[key] ?? key)
const model: AudioModel = { id: 'speech-demo', displayName: 'Speech demo', params: { voices: ['calm'], formats: ['wav'],
  maxCharacters: 20, instructions: false, execution: { protocol: 'openai-speech-v1', quoteRoute: '/v1/audio/quote', taskRoute: '/v1/tasks' } } }
const submissionId = '09bcae45-e147-4b03-8afc-6b32cdcaf384'
function estimate(): AudioQuote {
  const now = Math.floor(Date.now() / 1000)
  return { object: 'audio.quote', schema_version: 1, quote_id: 'quote-1', account_binding: 'opaque-owner', model: model.id,
    request_fingerprint: 'a'.repeat(64), total_quota: 12, estimated_total: '0.012', currency: 'CNY', pricing_revision: 'rev-1',
    created_at: now, expires_at: now + 60, estimate_only: true, charged: false, submitted: false, reserved: false }
}
function open(): void { const details = document.querySelector('details'); if (details !== null) details.open = true }

beforeEach(() => {
  vi.mocked(readAudioModels).mockResolvedValue({ ok: true, value: { accountId: 'owner-1', models: [model] } })
  vi.mocked(readAudioSubmissions).mockResolvedValue({ ok: true, value: [] })
  let quotes = 0
  vi.mocked(quoteAudio).mockImplementation(async () => ({ ok: true, value: { ...estimate(), quote_id: `quote-${++quotes}` } }))
  vi.mocked(generateAudio).mockImplementation(async (_owner, _session, request, _quote, id) =>
    ({ ok: true, value: { submissionId: id, model: request.model, status: 'pending', taskId: 'task-original' } }))
  vi.mocked(recoverAudio).mockResolvedValue({ ok: true, value: { submissionId, model: model.id, status: 'pending' } })
})
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks() })

describe('public speech creation', () => {
  it.each([true, false])('saves retained completed audio again without generation when its model is available=%s', async (available) => {
    if (!available) vi.mocked(readAudioModels).mockResolvedValueOnce({ ok: true, value: { accountId: 'owner-1', models: [] } })
    const completed = { submissionId, model: model.id, status: 'completed' as const, filename: '朗读.wav',
      mediaUrl: `/credits/api/audio/content?session_id=chat-1&submission_id=${submissionId}` }
    vi.mocked(readAudioSubmissions).mockResolvedValueOnce({ ok: true, value: [{ ...completed, code: 'AUDIO_SAVE_PENDING' }] })
    vi.mocked(recoverAudio).mockResolvedValueOnce({ ok: true, value: completed })
    render(<AudioCreation sessionId="chat-1" t={t} expanded />)
    const save = await screen.findByRole('button', { name: zh['audio.saveAgain'] })
    expect(screen.getByText(`${model.id} · ${zh['audio.status.savePending']}`)).toBeTruthy()
    expect(screen.getByText(zh['audio.savePending'])).toBeTruthy()
    expect({ status: zh['audio.status.savePending'], recovery: save.textContent, hint: zh['audio.savePending'] }).toMatchInlineSnapshot(`
      {
        "hint": "产物目录尚未保存成功，请检查目录权限和空间后重试；已有音频可播放或下载，重新保存不会再次生成或扣费",
        "recovery": "重新保存到产物目录",
        "status": "音频已生成，待保存到产物目录",
      }
    `)
    expect(screen.getByLabelText(zh['audio.play']).hasAttribute('controls')).toBe(true)
    expect(screen.getByRole('link', { name: zh.download }).getAttribute('download')).toBe('朗读.wav')
    fireEvent.click(save)
    await waitFor(() => { expect(screen.queryByRole('button', { name: zh['audio.saveAgain'] })).toBeNull() })
    expect(screen.getByText(`${model.id} · ${zh['audio.status.completed']}`)).toBeTruthy()
    expect(screen.queryByText(zh['audio.savePending'])).toBeNull()
    expect(recoverAudio).toHaveBeenCalledExactlyOnceWith('owner-1', 'chat-1', submissionId, expect.any(AbortSignal))
    expect(generateAudio).not.toHaveBeenCalled()
    expect(quoteAudio).not.toHaveBeenCalled()
  })

  it.each([['AUDIO_UNAVAILABLE', 'audio.failed'], ['AUDIO_LOCAL_STORAGE', 'audio.storage']] as const)(
    'keeps retained audio and its save action after retry fails with %s', async (code, key) => {
      vi.mocked(readAudioSubmissions).mockResolvedValueOnce({ ok: true, value: [{ submissionId, model: model.id,
        status: 'completed', code: 'AUDIO_SAVE_PENDING', filename: '保留音频.wav',
        mediaUrl: `/credits/api/audio/content?session_id=chat-1&submission_id=${submissionId}` }] })
      vi.mocked(recoverAudio).mockResolvedValueOnce({ ok: false, code })
      render(<AudioCreation sessionId="chat-1" t={t} expanded />)
      fireEvent.click(await screen.findByRole('button', { name: zh['audio.saveAgain'] }))
      expect(await screen.findByRole('alert')).toHaveProperty('textContent', zh[key])
      expect(screen.getByRole('button', { name: zh['audio.saveAgain'] })).toHaveProperty('disabled', false)
      expect(screen.getByLabelText(zh['audio.play'])).toBeTruthy()
      expect(screen.getByText(zh['audio.savePending'])).toBeTruthy()
      expect(generateAudio).not.toHaveBeenCalled()
      expect(recoverAudio).toHaveBeenCalledTimes(1)
    })

  it('does not show or submit audio when discovery has none or lacks execution readiness', async () => {
    vi.mocked(readAudioModels).mockResolvedValueOnce({ ok: true, value: { accountId: 'owner-1', models: [] } })
    const first = render(<AudioCreation sessionId="chat-1" t={t} />)
    await waitFor(() => { expect(readAudioModels).toHaveBeenCalledTimes(1) })
    expect(screen.queryByText(zh['audio.title'])).toBeNull()
    first.unmount()
    vi.mocked(readAudioModels).mockResolvedValueOnce({ ok: true, value: { accountId: 'owner-1', models: [
      { ...model, params: { voices: ['calm'], formats: ['wav'], maxCharacters: 20, instructions: false } },
    ] } })
    render(<AudioCreation sessionId="chat-1" t={t} />)
    expect(await screen.findByText(zh['audio.notReady'])).toBeTruthy()
    expect(screen.queryByText(zh['audio.quote'])).toBeNull()
    expect(generateAudio).not.toHaveBeenCalled()
  })
  it('requires a current free estimate and invalidates it when text changes', async () => {
    render(<AudioCreation sessionId="chat-1" t={t} />)
    await screen.findByText(zh['audio.title']); open()
    const input = screen.getByLabelText('朗读文本（最多 20 字）')
    fireEvent.change(input, { target: { value: '你好' } })
    const generate = screen.getByRole('button', { name: zh['audio.generate'] })
    expect(generate.hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh['audio.quote'] }))
    const confirm = await screen.findByRole('button', { name: '确认生成 · 0.012 CNY' })
    expect(quoteAudio).toHaveBeenCalledWith('owner-1', 'chat-1', { model: model.id, input: '你好', voice: 'calm', response_format: 'wav' }, expect.any(AbortSignal))
    fireEvent.change(input, { target: { value: '另一条' } })
    await waitFor(() => { expect(screen.getByRole('button', { name: zh['audio.generate'] }).hasAttribute('disabled')).toBe(true) })
    expect(confirm.isConnected).toBe(true)
    expect(generateAudio).not.toHaveBeenCalled()
  })
  it('submits one file per confirmation and pending tasks do not block another independent request', async () => {
    render(<AudioCreation sessionId="chat-1" t={t} />)
    await screen.findByText(zh['audio.title']); open()
    fireEvent.change(screen.getByLabelText('朗读文本（最多 20 字）'), { target: { value: '第一条' } })
    fireEvent.click(screen.getByRole('button', { name: zh['audio.quote'] }))
    fireEvent.click(await screen.findByRole('button', { name: '确认生成 · 0.012 CNY' }))
    await screen.findByText(`${model.id} · ${zh['audio.status.pending']}`)
    expect(generateAudio).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByLabelText('朗读文本（最多 20 字）'), { target: { value: '第二条' } })
    fireEvent.click(screen.getByRole('button', { name: zh['audio.quote'] }))
    fireEvent.click(await screen.findByRole('button', { name: '确认生成 · 0.012 CNY' }))
    await waitFor(() => { expect(generateAudio).toHaveBeenCalledTimes(2) })
    expect(vi.mocked(generateAudio).mock.calls[0]![4]).not.toBe(vi.mocked(generateAudio).mock.calls[1]![4])
  })
  it('queries retained original tasks without dispatching generation and never displays raw provider messages', async () => {
    vi.mocked(readAudioSubmissions).mockResolvedValueOnce({ ok: true, value: [{ submissionId, model: model.id, status: 'unknown' }] })
    vi.mocked(recoverAudio).mockResolvedValueOnce({ ok: false, code: 'provider-secret-key' })
    render(<AudioCreation sessionId="chat-1" t={t} />)
    await screen.findByText(zh['audio.title']); open()
    fireEvent.click(await screen.findByRole('button', { name: zh['audio.query'] }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', zh['audio.failed'])
    expect(recoverAudio).toHaveBeenCalledWith('owner-1', 'chat-1', submissionId, expect.any(AbortSignal))
    expect(generateAudio).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('provider-secret-key')
  })
  it('allows another independent request while the first submission has not returned', async () => {
    let finish: (() => void) | undefined
    vi.mocked(generateAudio).mockImplementationOnce((_owner, _session, request, _quote, id) =>
      new Promise((resolve) => { finish = () => { resolve({ ok: true, value: { submissionId: id, model: request.model, status: 'pending' } }) } }))
    render(<AudioCreation sessionId="chat-1" t={t} expanded />)
    const input = await screen.findByLabelText('朗读文本（最多 20 字）')
    fireEvent.change(input, { target: { value: '第一条还没响应' } })
    fireEvent.click(screen.getByRole('button', { name: zh['audio.quote'] }))
    fireEvent.click(await screen.findByRole('button', { name: '确认生成 · 0.012 CNY' }))
    await waitFor(() => { expect(generateAudio).toHaveBeenCalledTimes(1) })
    fireEvent.change(input, { target: { value: '第二条独立生成' } })
    fireEvent.click(screen.getByRole('button', { name: zh['audio.quote'] }))
    fireEvent.click(await screen.findByRole('button', { name: '确认生成 · 0.012 CNY' }))
    await waitFor(() => { expect(generateAudio).toHaveBeenCalledTimes(2) })
    expect(vi.mocked(generateAudio).mock.calls[0]![4]).not.toBe(vi.mocked(generateAudio).mock.calls[1]![4])
    finish?.()
  })
  it('checks expiry again at the confirmation gesture even without a render', async () => {
    render(<AudioCreation sessionId="chat-1" t={t} expanded />)
    const input = await screen.findByLabelText('朗读文本（最多 20 字）')
    fireEvent.change(input, { target: { value: '过期报价' } })
    fireEvent.click(screen.getByRole('button', { name: zh['audio.quote'] }))
    const confirm = await screen.findByRole('button', { name: '确认生成 · 0.012 CNY' })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000)
    fireEvent.click(confirm)
    clock.mockRestore()
    expect(generateAudio).not.toHaveBeenCalled()
  })
  it('does not extend an estimate after the wall clock moves backwards', async () => {
    render(<AudioCreation sessionId="chat-1" t={t} expanded />)
    const input = await screen.findByLabelText('朗读文本（最多 20 字）')
    fireEvent.change(input, { target: { value: '时间回拨' } })
    fireEvent.click(screen.getByRole('button', { name: zh['audio.quote'] }))
    const confirm = await screen.findByRole('button', { name: '确认生成 · 0.012 CNY' })
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 120_000)
    const wall = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 120_000)
    fireEvent.click(confirm)
    monotonic.mockRestore(); wall.mockRestore()
    expect(generateAudio).not.toHaveBeenCalled()
  })
  it('shows failed discovery and permits an explicit retry on the main audio page', async () => {
    vi.mocked(readAudioModels).mockResolvedValueOnce({ ok: false, code: 'AUDIO_NETWORK' })
    render(<AudioCreation sessionId="chat-1" t={t} expanded />)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', zh['audio.network'])
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(await screen.findByLabelText('朗读文本（最多 20 字）')).toBeTruthy()
  })
})
