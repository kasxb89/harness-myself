// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PromptAssist } from '../src/client/PromptAssist.tsx'
import type { PromptAssistOwner } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

type Props = Parameters<typeof PromptAssist>[0]
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>
type TestProps = Props & {
  onPromptChange: ReturnType<typeof vi.fn<PromptAssistOwner['onPromptChange']>>
  onBusyChange: ReturnType<typeof vi.fn<PromptAssistOwner['onBusyChange']>>
}

function translate(dictionary: Readonly<Record<string, string>>): Props['t'] {
  return (key, values) => {
    let text: string = dictionary[key] ?? key
    for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }
}

function properties(overrides: Partial<PromptAssistOwner> = {}): TestProps {
  const onPromptChange = vi.fn<PromptAssistOwner['onPromptChange']>(overrides.onPromptChange ?? (() => true))
  const onBusyChange = vi.fn<PromptAssistOwner['onBusyChange']>(overrides.onBusyChange)
  return {
    kind: 'image', prompt: '一只橘猫', references: ['ma_reference1'],
    generation: { model: 'image-model', size: '1024x1024' },
    disabled: false, signedIn: true, accountIdentity: 'account-a',
    useProjection: vi.fn().mockReturnValue({ lastUsed: null, next: null }),
    t: translate(zh), ...overrides, onPromptChange, onBusyChange,
  } as TestProps
}

function success(prompt = '柔和窗光下的一只橘猫'): Response {
  return Response.json({ ok: true, payload: { prompt, model: 'chat-model' } })
}

function account(id = 'account-a'): Response {
  return Response.json({ ok: true, payload: { signedIn: true, account: { id } } })
}

function installFetch(post: FetchMock = vi.fn<typeof fetch>().mockImplementation(async () => success()),
  read: FetchMock = vi.fn<typeof fetch>().mockImplementation(async () => account())) {
  const requests = vi.fn<typeof fetch>((input, init) => {
    if (input === '/credits/api/session') return read(input, init)
    if (input === '/credits/api/prompt/assist') return post(input, init)
    throw new Error('Unexpected network request')
  })
  vi.stubGlobal('fetch', requests)
  return { requests, post, read }
}

function deferred() {
  let resolve = (_response: Response): void => { throw new Error('Not initialized') }
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}

function body(fetchMock: FetchMock, index = 0): Record<string, unknown> {
  const value = fetchMock.mock.calls[index]?.[1]?.body
  if (typeof value !== 'string') throw new Error('Expected JSON request body')
  return JSON.parse(value) as Record<string, unknown>
}

function Composer({ props }: { props: Props }) {
  const [prompt, setPrompt] = useState(props.prompt)
  const latest = useRef(prompt)
  latest.current = prompt
  return <>
    <label>主提示词<textarea value={prompt} onChange={(event) => { setPrompt(event.target.value) }} /></label>
    <PromptAssist {...props} prompt={prompt} onPromptChange={(next, expected) => {
      if (latest.current !== expected || !props.onPromptChange(next, expected)) return false
      setPrompt(next)
      return true
    }} />
  </>
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('creation prompt assistance', () => {
  it.each([['zh', zh], ['en', en]] as const)('shows permanent writing and revision controls in %s', (language, dictionary) => {
    const { requests } = installFetch()
    const view = render(<PromptAssist {...properties()} t={translate(dictionary)} />)
    const feedbackText = language === 'zh' ? '背景再简洁一点' : 'Simplify the background further'
    fireEvent.change(view.getByRole('textbox', { name: dictionary.feedback }), { target: { value: feedbackText } })
    expect({
      copy: [...view.container.querySelectorAll('p')].map(node => node.textContent),
      fields: view.getAllByRole('textbox').map((field) => {
        if (!(field instanceof HTMLTextAreaElement)) throw new Error('Expected a textarea')
        return { label: field.closest('label')?.querySelector('span')?.textContent, value: field.value, disabled: field.disabled }
      }),
      actions: view.getAllByRole('button').map((button) => {
        if (!(button instanceof HTMLButtonElement)) throw new Error('Expected a button')
        return { label: button.textContent, disabled: button.disabled }
      }),
    }).toMatchSnapshot()
    expect(requests).not.toHaveBeenCalled()
    expect(view.container.querySelector('input[type="file"]')).toBeNull()
    expect(view.getAllByRole('textbox')).toHaveLength(1)
    expect(view.queryByRole('button', { name: /应用到提示词|Apply to prompt|收起|Collapse/ })).toBeNull()
  })

  it('writes straight into the main prompt after verifying the account before and after the request', async () => {
    const { requests, post } = installFetch()
    const props = properties({ references: ['ma_reference1', 'ma_reference1', 'ma_reference2'] })
    const view = render(<Composer props={props} />)
    expect(requests).not.toHaveBeenCalled()
    expect(props.onBusyChange).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'AI 帮写' }))
    await vi.waitFor(() => { expect(view.getByRole('textbox', { name: '主提示词' })).toHaveProperty('value', '柔和窗光下的一只橘猫') })
    expect(body(post)).toEqual({
      accountId: 'account-a', sessionId: null, expectedSelection: null, kind: 'image', prompt: '一只橘猫', instruction: '',
      references: ['ma_reference1', 'ma_reference2'], generation: { model: 'image-model', size: '1024x1024' },
    })
    expect(requests.mock.calls.map(([url]) => url)).toEqual(['/credits/api/session', '/credits/api/prompt/assist', '/credits/api/session'])
    const signals = requests.mock.calls.map(([, init]) => init?.signal)
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(signals[1]).toBe(signals[0])
    expect(signals[2]).toBe(signals[0])
    expect(props.onPromptChange).toHaveBeenCalledExactlyOnceWith('柔和窗光下的一只橘猫', '一只橘猫')
    expect(props.onBusyChange.mock.calls).toEqual([[true], [false]])
    expect(view.getAllByRole('textbox')).toHaveLength(2)
  })

  it('sends the current session selection only as an expectation and discards a late result after switching models', async () => {
    const waiting = deferred()
    const post = vi.fn<typeof fetch>().mockReturnValue(waiting.promise)
    installFetch(post)
    const current = { provider: 'product', model: 'deepseek-flash', reasoningEffort: 'medium' }
    const useProjection = vi.fn().mockReturnValue({ lastUsed: current, next: current })
    const props = { ...properties(), sessionId: 'session-one' as Props['sessionId'], useProjection }
    const view = render(<PromptAssist {...props} />)
    fireEvent.click(view.getByRole('button', { name: 'AI 帮写' }))
    await vi.waitFor(() => { expect(post).toHaveBeenCalledTimes(1) })
    expect(body(post)).toMatchObject({ sessionId: 'session-one', expectedSelection: current })
    useProjection.mockReturnValue({ lastUsed: current, next: { ...current, model: 'other' } })
    view.rerender(<PromptAssist {...props} />)
    expect(post.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    await act(async () => { waiting.resolve(success('过时的模型结果')) })
    expect(props.onPromptChange).not.toHaveBeenCalled()
    expect(props.onBusyChange.mock.calls).toEqual([[true], [false]])
  })

  it('waits for the current conversation model projection before allowing a billed action', () => {
    const { post } = installFetch()
    const props = { ...properties(), sessionId: 'session-one' as Props['sessionId'], useProjection: vi.fn().mockReturnValue(undefined) }
    const view = render(<PromptAssist {...props} />)
    expect(view.getByRole('button', { name: 'AI 帮写' })).toHaveProperty('disabled', true)
    expect(view.getByText(zh.modelLoading)).toBeTruthy()
    expect(post).not.toHaveBeenCalled()
  })

  it('uses the hand-edited main prompt and current feedback through multiple revisions', async () => {
    const post = vi.fn<typeof fetch>().mockResolvedValueOnce(success('第一稿')).mockResolvedValueOnce(success('第二稿')).mockResolvedValueOnce(success('第三稿'))
    installFetch(post)
    const props = properties({ kind: 'video', generation: { model: 'video-model', duration: '5' } })
    const view = render(<Composer props={props} />)
    const main = view.getByRole('textbox', { name: '主提示词' })
    if (!(main instanceof HTMLTextAreaElement)) throw new Error('Expected the main prompt textarea')
    fireEvent.click(view.getByRole('button', { name: 'AI 帮写' }))
    await vi.waitFor(() => { expect(main.value).toBe('第一稿') })
    fireEvent.change(main, { target: { value: '手动调整过的第一稿' } })
    const feedback = view.getByRole('textbox', { name: '修改建议' })
    if (!(feedback instanceof HTMLTextAreaElement)) throw new Error('Expected the revision feedback textarea')
    fireEvent.change(feedback, { target: { value: '增加缓慢推进镜头' } })
    fireEvent.click(view.getByRole('button', { name: '按建议修改' }))
    await vi.waitFor(() => { expect(main.value).toBe('第二稿') })
    expect(body(post, 1)).toEqual({
      accountId: 'account-a', sessionId: null, expectedSelection: null, kind: 'video', prompt: '手动调整过的第一稿', instruction: '增加缓慢推进镜头',
      references: ['ma_reference1'], generation: { model: 'video-model', duration: '5' },
    })
    expect(feedback.value).toBe('')
    fireEvent.change(feedback, { target: { value: '最后停在猫的正面' } })
    fireEvent.click(view.getByRole('button', { name: '按建议修改' }))
    await vi.waitFor(() => { expect(main.value).toBe('第三稿') })
    expect(body(post, 2)).toMatchObject({ prompt: '第二稿', instruction: '最后停在猫的正面' })
    expect(feedback.value).toBe('')
    expect(props.onBusyChange.mock.calls).toEqual([[true], [false], [true], [false], [true], [false]])
  })

  it('can revise the current prompt without first generating a candidate', async () => {
    const { post } = installFetch()
    const props = properties()
    const view = render(<Composer props={props} />)
    fireEvent.change(view.getByRole('textbox', { name: '修改建议' }), { target: { value: '更自然的光线' } })
    fireEvent.click(view.getByRole('button', { name: '按建议修改' }))
    await vi.waitFor(() => { expect(props.onPromptChange).toHaveBeenCalledTimes(1) })
    expect(body(post)).toMatchObject({ prompt: '一只橘猫', instruction: '更自然的光线' })
  })

  it('leaves the main prompt editable while locking feedback and duplicate writing', async () => {
    const waiting = deferred()
    const post = vi.fn<typeof fetch>().mockReturnValue(waiting.promise)
    installFetch(post)
    const props = properties()
    const view = render(<Composer props={props} />)
    fireEvent.change(view.getByRole('textbox', { name: '修改建议' }), { target: { value: '保留原有主体' } })
    fireEvent.click(view.getByRole('button', { name: '按建议修改' }))
    await vi.waitFor(() => { expect(post).toHaveBeenCalledTimes(1) })
    expect(view.getByRole('textbox', { name: '修改建议' })).toHaveProperty('disabled', true)
    expect(view.getByRole('textbox', { name: '主提示词' })).toHaveProperty('disabled', false)
    expect(view.getByRole('button', { name: 'AI 帮写' })).toHaveProperty('disabled', true)
    fireEvent.click(view.getByRole('button', { name: '按建议修改' }))
    expect(post).toHaveBeenCalledTimes(1)
    fireEvent.change(view.getByRole('textbox', { name: '主提示词' }), { target: { value: '请求期间写下的新原稿' } })
    expect(post.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    await act(async () => { waiting.resolve(success('不应覆盖的新结果')) })
    expect(view.getByRole('textbox', { name: '主提示词' })).toHaveProperty('value', '请求期间写下的新原稿')
    expect(view.getByRole('textbox', { name: '修改建议' })).toHaveProperty('value', '保留原有主体')
    expect(props.onPromptChange).not.toHaveBeenCalled()
    expect(props.onBusyChange.mock.calls).toEqual([[true], [false]])
  })

  it('reports a rejected compare-and-set without overwriting the prompt or clearing feedback', async () => {
    installFetch()
    const props = properties({ onPromptChange: vi.fn(() => false) })
    const view = render(<Composer props={props} />)
    fireEvent.change(view.getByRole('textbox', { name: '修改建议' }), { target: { value: '仍需保留的修改建议' } })
    fireEvent.click(view.getByRole('button', { name: '按建议修改' }))
    expect((await view.findByRole('alert')).textContent).toBe('原稿已变化，未覆盖你的内容，请重新点击 AI 帮写')
    expect(view.getByRole('textbox', { name: '主提示词' })).toHaveProperty('value', '一只橘猫')
    expect(view.getByRole('textbox', { name: '修改建议' })).toHaveProperty('value', '仍需保留的修改建议')
    expect(props.onPromptChange).toHaveBeenCalledExactlyOnceWith('柔和窗光下的一只橘猫', '一只橘猫')
    expect(props.onBusyChange.mock.calls).toEqual([[true], [false]])
  })

  it.each(['before', 'after'] as const)('refuses to write across an account change discovered %s the model request', async (phase) => {
    const read = vi.fn<typeof fetch>().mockResolvedValueOnce(account(phase === 'before' ? 'account-b' : 'account-a')).mockResolvedValueOnce(account('account-b'))
    const { post } = installFetch(undefined, read)
    const props = properties()
    const view = render(<PromptAssist {...props} />)
    fireEvent.change(view.getByRole('textbox', { name: '修改建议' }), { target: { value: '保留修改建议' } })
    fireEvent.click(view.getByRole('button', { name: '按建议修改' }))
    expect((await view.findByRole('alert')).textContent).toBe(zh.accountChanged)
    expect(post).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1)
    expect(props.onPromptChange).not.toHaveBeenCalled()
    expect(view.getByRole('textbox', { name: '修改建议' })).toHaveProperty('value', '保留修改建议')
    expect(props.onBusyChange.mock.calls).toEqual([[true], [false]])
  })

  it('accepts the top-level session response for both account checks', async () => {
    const read = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ok: true, signedIn: true, account: { id: 'account-a' } }))
    installFetch(undefined, read)
    const props = properties()
    const view = render(<PromptAssist {...props} />)
    fireEvent.click(view.getByRole('button', { name: 'AI 帮写' }))
    await vi.waitFor(() => { expect(props.onPromptChange).toHaveBeenCalledTimes(1) })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it.each(['references', 'generation', 'kind', 'accountIdentity', 'signedIn', 'disabled'] as const)('aborts and ignores the result when %s changes', async (field) => {
    const waiting = deferred()
    const post = vi.fn<typeof fetch>().mockReturnValue(waiting.promise)
    installFetch(post)
    const props = properties()
    const view = render(<PromptAssist {...props} />)
    fireEvent.change(view.getByRole('textbox', { name: '修改建议' }), { target: { value: '保留反馈' } })
    fireEvent.click(view.getByRole('button', { name: '按建议修改' }))
    await vi.waitFor(() => { expect(post).toHaveBeenCalledTimes(1) })
    const change: Partial<PromptAssistOwner> = field === 'references' ? { references: ['ma_another'] }
      : field === 'generation' ? { generation: { model: 'another-model' } }
        : field === 'kind' ? { kind: 'video' }
          : field === 'accountIdentity' ? { accountIdentity: 'account-b' }
            : field === 'signedIn' ? { signedIn: false } : { disabled: true }
    view.rerender(<PromptAssist {...props} {...change} />)
    expect(post.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    await act(async () => { waiting.resolve(success('迟到结果')) })
    expect(props.onPromptChange).not.toHaveBeenCalled()
    expect(view.getByRole('textbox', { name: '修改建议' })).toHaveProperty('value', '保留反馈')
    expect(props.onBusyChange.mock.calls).toEqual([[true], [false]])
  })

  it('waits for the final account check before changing the main prompt', async () => {
    const check = deferred()
    const read = vi.fn<typeof fetch>().mockResolvedValueOnce(account()).mockReturnValueOnce(check.promise)
    const { post } = installFetch(undefined, read)
    const props = properties()
    const view = render(<PromptAssist {...props} />)
    fireEvent.click(view.getByRole('button', { name: 'AI 帮写' }))
    await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(2) })
    expect(props.onPromptChange).not.toHaveBeenCalled()
    expect(props.onBusyChange.mock.calls).toEqual([[true]])
    expect(read.mock.calls[1]?.[1]?.signal).toBe(post.mock.calls[0]?.[1]?.signal)
    await act(async () => { check.resolve(account()) })
    expect(props.onPromptChange).toHaveBeenCalledExactlyOnceWith('柔和窗光下的一只橘猫', '一只橘猫')
    expect(props.onBusyChange.mock.calls).toEqual([[true], [false]])
  })

  it.each(['preflight', 'model', 'final-account'] as const)('cancels during %s and keeps the original prompt and feedback', async (phase) => {
    const waiting = deferred()
    const post = vi.fn<typeof fetch>().mockImplementation(async () => success())
    const read = vi.fn<typeof fetch>().mockImplementation(async () => account())
    if (phase === 'preflight') read.mockReturnValueOnce(waiting.promise)
    else if (phase === 'model') post.mockReturnValueOnce(waiting.promise)
    else read.mockResolvedValueOnce(account()).mockReturnValueOnce(waiting.promise)
    installFetch(post, read)
    const props = properties()
    const view = render(<Composer props={props} />)
    fireEvent.change(view.getByRole('textbox', { name: '修改建议' }), { target: { value: '取消也保留反馈' } })
    fireEvent.click(view.getByRole('button', { name: '按建议修改' }))
    await vi.waitFor(() => {
      if (phase === 'model') expect(post).toHaveBeenCalledTimes(1)
      else expect(read).toHaveBeenCalledTimes(phase === 'preflight' ? 1 : 2)
    })
    const signal = phase === 'model' ? post.mock.calls[0]?.[1]?.signal : read.mock.calls.at(-1)?.[1]?.signal
    fireEvent.click(view.getByRole('button', { name: '停止' }))
    expect(signal?.aborted).toBe(true)
    const status = await view.findByRole('status')
    expect(status.textContent).toBe(phase === 'preflight' ? zh.stoppedLocal : zh.stopped)
    if (phase === 'preflight') expect(status.textContent).not.toContain('计费')
    await act(async () => { waiting.resolve(phase === 'model' ? success('迟到结果') : account()) })
    expect(view.getByRole('textbox', { name: '主提示词' })).toHaveProperty('value', '一只橘猫')
    expect(view.getByRole('textbox', { name: '修改建议' })).toHaveProperty('value', '取消也保留反馈')
    expect(props.onPromptChange).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledTimes(phase === 'preflight' ? 0 : 1)
    expect(props.onBusyChange.mock.calls).toEqual([[true], [false]])
  })

  it('does not let a cancelled completion release the busy state owned by the next request', async () => {
    const first = deferred()
    const second = deferred()
    const post = vi.fn<typeof fetch>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    installFetch(post)
    const props = properties()
    const view = render(<PromptAssist {...props} />)
    fireEvent.click(view.getByRole('button', { name: 'AI 帮写' }))
    await vi.waitFor(() => { expect(post).toHaveBeenCalledTimes(1) })
    fireEvent.click(view.getByRole('button', { name: '停止' }))
    fireEvent.click(view.getByRole('button', { name: 'AI 帮写' }))
    await vi.waitFor(() => { expect(post).toHaveBeenCalledTimes(2) })
    await act(async () => { first.resolve(success('旧结果')) })
    expect(props.onBusyChange.mock.calls).toEqual([[true], [false], [true]])
    expect(props.onPromptChange).not.toHaveBeenCalled()
    expect(view.getByRole('button', { name: 'AI 帮写' })).toHaveProperty('disabled', true)
    await act(async () => { second.resolve(success('新结果')) })
    expect(props.onPromptChange).toHaveBeenCalledExactlyOnceWith('新结果', '一只橘猫')
    expect(props.onBusyChange.mock.calls).toEqual([[true], [false], [true], [false]])
  })

  it('does not announce busy changes for idle mounting, rerendering or unmounting', () => {
    installFetch()
    const props = properties()
    const view = render(<PromptAssist {...props} />)
    view.rerender(<PromptAssist {...props} prompt="另一份原稿" />)
    view.unmount()
    expect(props.onBusyChange).not.toHaveBeenCalled()
  })

  it('aborts on unmount and keeps simultaneous image and video operations independent', async () => {
    const waiting = deferred()
    const post = vi.fn<typeof fetch>().mockReturnValueOnce(waiting.promise).mockResolvedValueOnce(success('视频结果'))
    installFetch(post)
    const image = properties()
    const video = properties({ kind: 'video', prompt: '视频原稿' })
    function Pair({ showImage = true }: { showImage?: boolean }) {
      return <><div aria-label="图片帮写">{showImage && <PromptAssist {...image} />}</div>
        <div aria-label="视频帮写"><PromptAssist {...video} /></div></>
    }
    const view = render(<Pair />)
    const imageView = within(view.getByLabelText('图片帮写'))
    const videoView = within(view.getByLabelText('视频帮写'))
    fireEvent.click(imageView.getByRole('button', { name: 'AI 帮写' }))
    await vi.waitFor(() => { expect(post).toHaveBeenCalledTimes(1) })
    fireEvent.click(videoView.getByRole('button', { name: 'AI 帮写' }))
    await vi.waitFor(() => { expect(video.onPromptChange).toHaveBeenCalledExactlyOnceWith('视频结果', '视频原稿') })
    view.rerender(<Pair showImage={false} />)
    expect(post.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    await act(async () => { waiting.resolve(success('图片迟到结果')) })
    expect(image.onPromptChange).not.toHaveBeenCalled()
    expect(image.onBusyChange.mock.calls).toEqual([[true], [false]])
    expect(video.onBusyChange.mock.calls).toEqual([[true], [false]])
    expect(videoView.getByRole('button', { name: 'AI 帮写' })).toHaveProperty('disabled', false)
  })

  it.each([{ signedIn: false }, { disabled: true }, { accountIdentity: null }])('disables writing and revision when unavailable: %j', (availability) => {
    const { requests } = installFetch()
    const props = properties(availability)
    const view = render(<PromptAssist {...props} />)
    fireEvent.change(view.getByRole('textbox', { name: '修改建议' }), { target: { value: '不能发送' } })
    const write = view.getByRole('button', { name: 'AI 帮写' })
    const revise = view.getByRole('button', { name: '按建议修改' })
    expect(write).toHaveProperty('disabled', true)
    expect(revise).toHaveProperty('disabled', true)
    fireEvent.click(write)
    fireEvent.click(revise)
    expect(requests).not.toHaveBeenCalled()
    expect(props.onBusyChange).not.toHaveBeenCalled()
    expect(view.getByText(availability.signedIn === false ? zh.signIn : availability.disabled ? zh.busy : zh.accountChanged)).toBeTruthy()
  })

  it('requires an existing prompt or references and lets references alone start writing', async () => {
    const { post } = installFetch()
    const props = properties({ prompt: '', references: [] })
    const view = render(<PromptAssist {...props} />)
    fireEvent.change(view.getByRole('textbox', { name: '修改建议' }), { target: { value: '不能代替主提示词' } })
    expect(view.getByRole('button', { name: 'AI 帮写' })).toHaveProperty('disabled', true)
    expect(view.getByRole('button', { name: '按建议修改' })).toHaveProperty('disabled', true)
    expect(view.getByText(zh.empty)).toBeTruthy()
    view.rerender(<PromptAssist {...props} references={['ma_reference1']} />)
    fireEvent.click(view.getByRole('button', { name: 'AI 帮写' }))
    await vi.waitFor(() => { expect(props.onPromptChange).toHaveBeenCalledTimes(1) })
    expect(body(post)).toMatchObject({ prompt: '', instruction: '', references: ['ma_reference1'] })
  })

  it('submits all nine image references and visibly rejects a tenth without truncation', async () => {
    const { post } = installFetch()
    const references = Array.from({ length: 9 }, (_, index) => `ma_reference${String(index)}`)
    const props = properties({ references })
    const view = render(<PromptAssist {...props} />)
    fireEvent.click(view.getByRole('button', { name: 'AI 帮写' }))
    await vi.waitFor(() => { expect(props.onPromptChange).toHaveBeenCalledTimes(1) })
    expect(body(post)).toMatchObject({ references })
    view.rerender(<PromptAssist {...props} references={[...references, 'ma_tenth']} />)
    expect(view.getByRole('button', { name: 'AI 帮写' })).toHaveProperty('disabled', true)
    expect(view.getByText(zh.referenceLimit)).toBeTruthy()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('disables revision until feedback is nonempty', () => {
    const { requests } = installFetch()
    const view = render(<PromptAssist {...properties()} />)
    expect(view.getByRole('button', { name: '按建议修改' })).toHaveProperty('disabled', true)
    fireEvent.change(view.getByRole('textbox', { name: '修改建议' }), { target: { value: '   ' } })
    expect(view.getByRole('button', { name: '按建议修改' })).toHaveProperty('disabled', true)
    expect(requests).not.toHaveBeenCalled()
  })

  it('preserves the main prompt and feedback after failure and permits an explicit retry', async () => {
    const post = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: false, code: 'PROMPT_ASSIST_UNAVAILABLE', message: 'private-upstream-secret' }))
      .mockResolvedValueOnce(success('重试成功'))
    installFetch(post)
    const props = properties()
    const view = render(<Composer props={props} />)
    fireEvent.change(view.getByRole('textbox', { name: '修改建议' }), { target: { value: '自然光' } })
    fireEvent.click(view.getByRole('button', { name: '按建议修改' }))
    expect((await view.findByRole('alert')).textContent).toBe(zh.error)
    expect(view.getByRole('textbox', { name: '主提示词' })).toHaveProperty('value', '一只橘猫')
    expect(view.getByRole('textbox', { name: '修改建议' })).toHaveProperty('value', '自然光')
    expect(view.queryByText('private-upstream-secret')).toBeNull()
    expect(post).toHaveBeenCalledTimes(1)
    fireEvent.click(view.getByRole('button', { name: '按建议修改' }))
    await vi.waitFor(() => { expect(view.getByRole('textbox', { name: '主提示词' })).toHaveProperty('value', '重试成功') })
    expect(view.getByRole('textbox', { name: '修改建议' })).toHaveProperty('value', '')
    expect(props.onBusyChange.mock.calls).toEqual([[true], [false], [true], [false]])
  })

  it('reports a lost model connection as an unknown billed result without automatic retry', async () => {
    const post = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network-secret'))
    installFetch(post)
    const props = properties()
    const view = render(<PromptAssist {...props} />)
    fireEvent.click(view.getByRole('button', { name: 'AI 帮写' }))
    expect((await view.findByRole('alert')).textContent).toBe(zh.resultUnknown)
    expect(post).toHaveBeenCalledTimes(1)
    expect(view.queryByText('network-secret')).toBeNull()
    expect(props.onPromptChange).not.toHaveBeenCalled()
    expect(props.onBusyChange.mock.calls).toEqual([[true], [false]])
  })

  it.each(['before', 'after'] as const)('preserves the draft when the %s account check cannot complete', async (phase) => {
    const read = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('account-service-secret'))
    if (phase === 'after') read.mockResolvedValueOnce(account())
    const { post } = installFetch(undefined, read)
    const props = properties()
    const view = render(<PromptAssist {...props} />)
    fireEvent.click(view.getByRole('button', { name: 'AI 帮写' }))
    expect((await view.findByRole('alert')).textContent).toBe(zh.accountCheckFailed)
    expect(post).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1)
    expect(props.onPromptChange).not.toHaveBeenCalled()
    expect(view.queryByText('account-service-secret')).toBeNull()
    expect(props.onBusyChange.mock.calls).toEqual([[true], [false]])
  })

  it.each([
    ['SESSION_REQUIRED', 'expired'], ['PROMPT_ASSIST_NOT_CONFIGURED', 'unavailable'],
    ['PROMPT_ASSIST_CHAT_REQUIRED', 'chatRequired'], ['PROMPT_ASSIST_SELECTION_CHANGED', 'selectionChanged'], ['PROMPT_ASSIST_VISION_REQUIRED', 'visionRequired'],
    ['PROMPT_ASSIST_REFERENCE_INVALID', 'referenceInvalid'], ['PROMPT_ASSIST_REFERENCE_LIMIT', 'referenceLimit'],
    ['PROMPT_ASSIST_STORAGE_FAILED', 'storage'], ['PROMPT_ASSIST_RESULT_STORAGE_FAILED', 'resultStorage'],
    ['PROMPT_ASSIST_RESULT_UNKNOWN', 'resultUnknown'], ['PROMPT_ASSIST_INVALID_RESPONSE', 'invalidResponse'],
    ['ACCOUNT_CHANGED', 'accountChanged'], ['INSUFFICIENT_BALANCE', 'balance'],
    ['INVALID_REQUEST', 'invalid'], ['PROMPT_ASSIST_TIMEOUT', 'error'],
  ] as const)('localizes %s without exposing the upstream message or replacing the main prompt', async (code, key) => {
    const post = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: false, code, message: 'upstream-secret' }))
    installFetch(post)
    const props = properties()
    const view = render(<Composer props={props} />)
    fireEvent.click(view.getByRole('button', { name: 'AI 帮写' }))
    expect((await view.findByRole('alert')).textContent).toBe(zh[key])
    expect(view.getByRole('textbox', { name: '主提示词' })).toHaveProperty('value', '一只橘猫')
    expect(view.queryByText('upstream-secret')).toBeNull()
    expect(props.onPromptChange).not.toHaveBeenCalled()
    expect(view.getByRole('button', { name: 'AI 帮写' })).toHaveProperty('disabled', false)
    expect(props.onBusyChange.mock.calls).toEqual([[true], [false]])
  })
})
