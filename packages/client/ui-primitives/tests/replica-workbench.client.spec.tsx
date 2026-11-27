// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReplicaWorkbench } from '../src/ReplicaWorkbench.tsx'
import { replicaEn, replicaZh } from '../src/replica-locales.ts'
import type { ReplicaDraftRequest, ReplicaDraftOutcome } from '../src/replica-prompt.ts'
import { prepareReplicaDraft } from '../src/replica-handoff.ts'

const image = (name = 'same.png') => new File(['image'], name, { type: 'image/png' })
const source = () => screen.getByLabelText(replicaZh.addSource)
const revoked = vi.fn<(url: string) => void>()
const pick = () => { fireEvent.change(source(), { target: { files: [image()] } }) }
beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(file => `blob:${file instanceof File ? file.name : 'file'}`)
  revoked.mockClear()
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoked)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('reference replica workbench', () => {
  it('prepares ordered role-separated files and an analysis-only prompt, without sending or generating', async () => {
    const onPrepareDraft = vi.fn<(request: ReplicaDraftRequest) => Promise<ReplicaDraftOutcome>>(async () => 'ready')
    render(<ReplicaWorkbench kind="image" language="zh" accountKey="a" onExit={vi.fn()} onPrepareDraft={onPrepareDraft} />)
    pick()
    fireEvent.change(screen.getByLabelText(replicaZh.addSubject), { target: { files: [image(), image('person.png')] } })
    fireEvent.change(screen.getByLabelText(replicaZh.keep), { target: { value: '保持构图' } })
    fireEvent.change(screen.getByLabelText(replicaZh.change), { target: { value: '换成我的商品' } })
    fireEvent.change(screen.getByLabelText(replicaZh.count), { target: { value: '12' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: replicaZh.prepare })) })
    expect(onPrepareDraft).toHaveBeenCalledOnce()
    const request = onPrepareDraft.mock.calls[0]?.[0]
    expect(request?.files.map(file => file.name)).toEqual(['same.png', 'same.png', 'person.png'])
    expect(request?.prompt).toContain('1. [image/png] 对标素材，仅用于分析参考 | "same.png"')
    expect(request?.prompt).toContain('2. [image/png] 主体商品/人物图片，供主体一致性分析 | "same.png"')
    expect(request?.prompt).toContain('生成数量: 12')
    expect(request?.prompt).toContain('不调用图片/视频生成')
    expect(request?.prompt).toContain('yunshu-reference-replica')
    expect(request?.prompt).toContain('update_creation_plan')
    expect(screen.getByRole('button', { name: replicaZh.prepare })).toHaveProperty('disabled', true)
    expect(screen.getByText(replicaZh.ready)).toBeTruthy()
  })

  it('retains media and fields after a failed handoff, and prevents duplicate pending requests', async () => {
    let finish: ((value: 'unavailable') => void) | undefined
    const onPrepareDraft = vi.fn(() => new Promise<'unavailable'>((resolve) => { finish = resolve }))
    render(<ReplicaWorkbench kind="image" language="zh" accountKey="a" onExit={vi.fn()} onPrepareDraft={onPrepareDraft} />)
    pick()
    fireEvent.change(screen.getByLabelText(replicaZh.change), { target: { value: 'a product scene' } })
    fireEvent.click(screen.getByRole('button', { name: replicaZh.prepare }))
    fireEvent.click(screen.getByRole('button', { name: replicaZh.preparing }))
    expect(onPrepareDraft).toHaveBeenCalledOnce()
    await act(async () => { finish?.('unavailable') })
    expect(screen.getByAltText('same.png')).toBeTruthy()
    expect(screen.getByLabelText(replicaZh.change)).toHaveProperty('value', 'a product scene')
    expect(screen.getByText(replicaZh.unavailable)).toBeTruthy()
    expect(screen.getByRole('button', { name: replicaZh.prepare })).toHaveProperty('disabled', false)
  })

  it('aborts an account-changing handoff while preserving material, and requires account review', async () => {
    let signal: AbortSignal | undefined
    const onPrepareDraft = vi.fn(async (request: ReplicaDraftRequest) => { signal = request.signal; return await new Promise<'ready'>(() => {}) })
    const props = { kind: 'image' as const, language: 'zh' as const, accountKey: 'a', onExit: vi.fn(), onPrepareDraft }
    const view = render(<ReplicaWorkbench {...props} />)
    pick()
    fireEvent.click(screen.getByRole('button', { name: replicaZh.prepare }))
    view.rerender(<ReplicaWorkbench {...props} accountKey="b" />)
    expect(signal?.aborted).toBe(true)
    expect(screen.getByAltText('same.png')).toBeTruthy()
    expect(screen.getByRole('button', { name: replicaZh.prepare })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: replicaZh.confirmAccount }))
    expect(screen.getByRole('button', { name: replicaZh.prepare })).toHaveProperty('disabled', false)
  })

  it('validates positive counts without inventing a global cap and supports keyboard preview and removal', () => {
    render(<ReplicaWorkbench kind="image" language="en" accountKey="a" onExit={vi.fn()} onPrepareDraft={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(replicaEn.addSource), { target: { files: [image()] } })
    fireEvent.change(screen.getByLabelText(replicaEn.count), { target: { value: '0' } })
    expect(screen.getByRole('button', { name: replicaEn.prepare })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText(replicaEn.count), { target: { value: '100' } })
    expect(screen.getByRole('button', { name: replicaEn.prepare })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: `${replicaEn.preview}: same.png` }))
    expect(screen.getByRole('dialog', { name: replicaEn.preview })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `${replicaEn.remove}: same.png` }))
    expect(screen.queryByAltText('same.png')).toBeNull()
    expect(revoked).toHaveBeenCalledWith('blob:same.png')
  })

  it('identifies video samples as incomplete analysis and rejects wrong material kinds', async () => {
    const onPrepareDraft = vi.fn<(request: ReplicaDraftRequest) => Promise<ReplicaDraftOutcome>>(async () => 'preserved')
    render(<ReplicaWorkbench kind="video" language="zh" accountKey="a" onExit={vi.fn()} onPrepareDraft={onPrepareDraft} />)
    pick()
    expect(screen.getByText(replicaZh.invalidFile)).toBeTruthy()
    fireEvent.change(source(), { target: { files: [new File(['video'], 'ref.mp4', { type: 'video/mp4' })] } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: replicaZh.prepare })) })
    expect(onPrepareDraft.mock.calls[0]?.[0]?.prompt).toContain('样帧不代表已分析完整运动、全部画面或音频')
    expect(screen.getByText(replicaZh.preserved)).toBeTruthy()
  })
})

describe('normal chat draft account handoff', () => {
  const request = () => ({ accountKey: 'a', prompt: 'analyze', files: [image()], signal: new AbortController().signal })
  const session = (id = 'a', owner = `login-${id}`) => Response.json({ ok: true, payload: { signedIn: true, account: { id }, accountOwner: owner } })
  const navigation = () => ({
    accept: vi.fn(() => true), reveal: vi.fn(), isCurrent: vi.fn(() => true),
    withTarget: vi.fn(async (confirm: () => Promise<void>) => { await confirm() }),
  })
  it('rechecks the current account both before connecting and before synchronous acceptance and reveal', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => session())
    vi.stubGlobal('fetch', fetcher)
    const target = navigation()
    expect(await prepareReplicaDraft(request(), target)).toBe('ready')
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/credits/api/session', '/credits/api/session'])
    expect(target.accept).toHaveBeenCalledWith('analyze', expect.any(Array))
    expect(target.reveal).toHaveBeenCalledOnce()
    expect(target.isCurrent).toHaveBeenCalledTimes(2)
    fetcher.mockResolvedValueOnce(session('b'))
    expect(await prepareReplicaDraft(request(), target)).toBe('unavailable')
    expect(target.withTarget).toHaveBeenCalledOnce()
    expect(target.accept).toHaveBeenCalledOnce()
  })
  it('refuses an account change while the unrevealed target is connecting, preserving the source files', async () => {
    let account = 'a'
    const fetcher = vi.fn<typeof fetch>(async () => session(account))
    vi.stubGlobal('fetch', fetcher)
    const opening = Promise.withResolvers<undefined>()
    const target = { ...navigation(),
      withTarget: vi.fn(async (confirm: () => Promise<void>) => { await opening.promise; await confirm() }) }
    const input = request(), preparing = prepareReplicaDraft(input, target)
    await vi.waitFor(() => { expect(target.withTarget).toHaveBeenCalledOnce() })
    account = 'b'
    opening.resolve(undefined)
    expect(await preparing).toBe('unavailable')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(target.accept).not.toHaveBeenCalled()
    expect(target.reveal).not.toHaveBeenCalled()
    expect(input.files.map(file => file.name)).toEqual(['same.png'])
  })
  it('refuses a changed login scope or window epoch even after the same account returns', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => session())
    vi.stubGlobal('fetch', fetcher)
    const ownerChanged = navigation()
    fetcher.mockResolvedValueOnce(session()).mockResolvedValueOnce(session('a', 'new-login-a'))
    expect(await prepareReplicaDraft(request(), ownerChanged)).toBe('unavailable')
    expect(ownerChanged.accept).not.toHaveBeenCalled()
    expect(ownerChanged.reveal).not.toHaveBeenCalled()
    const epochChanged = { ...navigation(), isCurrent: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false) }
    expect(await prepareReplicaDraft(request(), epochChanged)).toBe('unavailable')
    expect(epochChanged.accept).not.toHaveBeenCalled()
    expect(epochChanged.reveal).not.toHaveBeenCalled()
  })
  it('returns preserved for refused drafts and never reaches a consumer after cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => session()))
    const target = { ...navigation(), accept: vi.fn(() => false) }
    expect(await prepareReplicaDraft(request(), target)).toBe('preserved')
    expect(target.reveal).not.toHaveBeenCalled()
    const controller = new AbortController(); controller.abort()
    await expect(prepareReplicaDraft({ ...request(), signal: controller.signal }, target)).rejects.toThrow()
    expect(target.withTarget).toHaveBeenCalledOnce()
  })
})
