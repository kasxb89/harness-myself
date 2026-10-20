// @vitest-environment jsdom
/** Real credit controls use receipt values and isolate reads across account and turn lifetimes. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionModelCredits, TurnModelCredits } from '../src/client/ModelCredits.tsx'
import { zh, en } from '../src/client/locales.ts'
import type { CreditsSnapshot } from '../src/client/session-store.ts'
import { chatSnapshotFixture } from '../../ui-chat/tests/chat-snapshot-fixture.client.ts'

const requestPath = (value: RequestInfo | URL): string => typeof value === 'string' ? value : value instanceof URL ? value.href : value.url
type DockProps = Parameters<typeof SessionModelCredits>[0]
const account = (id = 'a', epoch = 1): CreditsSnapshot => ({ accountEpoch: epoch,
  session: { signedIn: true, creditsPerYuan: 1000, account: { id, phone: 'test' } },
  balance: null, loaded: true, failure: null,
})
const receipt = (points = 0.125, extra: Record<string, unknown> = {}) => Response.json({ ok: true, payload: {
  scope: 'chat-model', status: 'settled', points, accountId: 'a', settledRequests: 1, totalRequests: 1, ...extra,
} })
function fixture(locale: 'zh' | 'en' = 'zh') {
  const identity = createSnapshotStore(account())
  const session = createSnapshotStore({ running: false } as Parameters<Parameters<DockProps['useSession']>[0]>[0])
  const chat = createSnapshotStore(chatSnapshotFixture())
  const openBalance = vi.fn()
  const props = { sessionId: 'chat-a', useCreditsSession: bindSnapshotSelector(identity),
    useSession: bindSnapshotSelector(session), useChat: bindSnapshotSelector(chat), openBalance,
    t: makeTranslate(locale === 'zh' ? zh : en),
  } as DockProps
  return { identity, session, chat, props, openBalance }
}
const flush = async () => { await act(async () => {}) }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('model credit controls', () => {
  it.each(['zh', 'en'] as const)('shows exact receipt credits with scoped details and balance navigation (%s)', async (locale) => {
    vi.stubGlobal('fetch', async () => receipt())
    const f = fixture(locale), copy = locale === 'zh' ? zh : en
    const view = render(<SessionModelCredits {...f.props} />)
    await flush()
    const pill = view.getByRole('button', { name: `${copy['chatUsage.session']}：${copy['chatUsage.points'].replace('{points}', '0.125')}` })
    expect(pill.getAttribute('data-composer-stat')).toBe('usage')
    expect(view.container.textContent).not.toMatch(/token|tok\/s|配额/i)
    fireEvent.click(pill)
    expect(view.getByRole('dialog').textContent).toContain(copy['chatUsage.scope'])
    expect(copy['chatUsage.scope']).toContain(locale === 'zh' ? '上下文整理及自动标题' : 'context compaction, automatic titles')
    expect(copy['chatUsage.session']).toBe(locale === 'zh' ? '当前会话回复积分' : 'Current chat reply credits')
    expect(copy['chatUsage.turn']).toBe(locale === 'zh' ? '本轮回复积分' : 'This turn’s reply credits')
    expect(view.getByRole('dialog').textContent).toContain(copy['chatUsage.requests'].replace('{settled}', '1').replace('{total}', '1'))
    fireEvent.click(view.getByRole('button', { name: copy['chatUsage.allUsage'] }))
    expect(f.openBalance).toHaveBeenCalledOnce()
    expect(view.queryByRole('dialog')).toBeNull()
  })
  it('uses the owning turn number, not a node sequence, and never rounds a positive charge into zero', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => receipt(0.0000001))
    vi.stubGlobal('fetch', fetcher)
    const f = fixture()
    const turn = chatSnapshotFixture({ turnEnds: new Map([[3, 20]]) }).timeline.turns.get(3)!
    const view = render(<TurnModelCredits {...f.props} turn={turn} seq={99} openFile={() => {}} />)
    await flush()
    expect(requestPath(fetcher.mock.calls[0]![0])).toContain('turn=3')
    expect(view.getByRole('button', { name: `${zh['chatUsage.turn']}：${zh['chatUsage.smallPoints']}` })).toBeTruthy()
  })
  it.each(['pending', 'unavailable'] as const)('shows %s without manufacturing zero and permits explicit refresh', async (status) => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>(async () => receipt(0, { status, points: undefined, settledRequests: 0 }))
    vi.stubGlobal('fetch', fetcher)
    const f = fixture(), view = render(<SessionModelCredits {...f.props} />)
    await flush()
    expect(view.container.textContent).toContain(zh[`chatUsage.${status}`])
    expect(view.container.textContent).not.toContain('0 积分')
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(fetcher).toHaveBeenCalledTimes(status === 'pending' ? 4 : 1)
    fireEvent.click(view.getByRole('button', { name: `${zh['chatUsage.session']}：${zh[`chatUsage.${status}`]}` }))
    fetcher.mockImplementation(async () => receipt(0))
    fireEvent.click(view.getByRole('button', { name: zh['chatUsage.refresh'] }))
    await flush()
    expect(view.container.textContent).toContain('0 积分')
  })
  it('contains a raw failure and bounds a hung read without replacing it with zero', async () => {
    vi.useFakeTimers()
    const never = Promise.withResolvers<Response>()
    const fetcher = vi.fn<typeof fetch>(() => never.promise)
    vi.stubGlobal('fetch', fetcher)
    const f = fixture(), view = render(<SessionModelCredits {...f.props} />)
    const signal = fetcher.mock.calls[0]?.[1]?.signal
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(signal?.aborted).toBe(true)
    expect(view.container.textContent).toContain(zh['chatUsage.unavailable'])
    await act(async () => { never.resolve(Response.json({ error: 'private upstream secret' })) })
    expect(view.container.textContent).not.toMatch(/private|0 积分/)
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('hides settled values during a run and refreshes on completion without per-delta reads', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => receipt(12.5))
    vi.stubGlobal('fetch', fetcher)
    const f = fixture(), view = render(<SessionModelCredits {...f.props} />)
    await flush()
    expect(view.container.textContent).toContain('12.5 积分')
    act(() => { f.session.set({ ...f.session.getSnapshot(), running: true }) })
    await flush()
    expect(view.container.textContent).not.toContain('12.5 积分')
    expect(view.container.textContent).toContain(zh['chatUsage.pending'])
    const before = fetcher.mock.calls.length
    for (let delta = 0; delta < 5; delta++) act(() => { f.chat.set(chatSnapshotFixture()) })
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(before)
    act(() => { f.session.set({ ...f.session.getSnapshot(), running: false }) })
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(before + 1)
    expect(view.container.textContent).toContain('12.5 积分')
  })
  it('refreshes when a completed turn arrives without toggling the running flag', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => receipt())
    vi.stubGlobal('fetch', fetcher)
    const f = fixture()
    render(<SessionModelCredits {...f.props} />)
    await flush()
    act(() => { f.chat.set(chatSnapshotFixture({ turnEnds: new Map([[1, 20]]) })) })
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    act(() => { f.chat.set(chatSnapshotFixture({ turnEnds: new Map([[1, 20]]) })) })
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    act(() => { f.chat.set(chatSnapshotFixture({ turnEnds: new Map([[1, 20], [2, 40]]) })) })
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it('cancels the previous conversation before accepting its late receipt', async () => {
    const late = Promise.withResolvers<Response>()
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(late.promise).mockImplementation(async () => receipt(5))
    vi.stubGlobal('fetch', fetcher)
    const f = fixture(), view = render(<SessionModelCredits {...f.props} />)
    const signal = fetcher.mock.calls[0]?.[1]?.signal
    view.rerender(<SessionModelCredits {...f.props} sessionId={'chat-b' as DockProps['sessionId']} />)
    await flush()
    expect(signal?.aborted).toBe(true)
    await act(async () => { late.resolve(receipt(9999)) })
    expect(view.container.textContent).toContain('5 积分')
    expect(view.container.textContent).not.toContain('9,999')
    expect(requestPath(fetcher.mock.calls[1]![0])).toContain('session_id=chat-b')
  })
  it.each(['switch', 'logout', 'same-account-epoch', 'unmount'] as const)('aborts and ignores a late receipt after %s', async (transition) => {
    const late = Promise.withResolvers<Response>()
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(late.promise).mockImplementation(async () => receipt(25, { accountId: 'b' }))
    vi.stubGlobal('fetch', fetcher)
    const f = fixture(), view = render(<SessionModelCredits {...f.props} />)
    const signal = fetcher.mock.calls[0]?.[1]?.signal
    if (transition === 'unmount') view.unmount()
    else act(() => { f.identity.set(transition === 'switch' ? account('b', 2) : transition === 'logout'
      ? { ...account(), accountEpoch: 2, session: { signedIn: false, creditsPerYuan: 1000 } }
      : account('a', 3)) })
    await flush()
    expect(signal?.aborted).toBe(true)
    await act(async () => { late.resolve(receipt(9876)) })
    expect(view.container.textContent).not.toContain('9,876')
    if (transition === 'logout' || transition === 'unmount') expect(view.container.textContent).toBe('')
    if (transition === 'switch') expect(view.container.textContent).toContain('25 积分')
    if (transition === 'same-account-epoch') expect(view.container.textContent).toContain(zh['chatUsage.unavailable'])
  })
  it('hides an open detail dialog on identity change and does not refetch on a same-account balance refresh', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => receipt())
    vi.stubGlobal('fetch', fetcher)
    const f = fixture(), view = render(<SessionModelCredits {...f.props} />)
    await flush()
    fireEvent.click(view.getByRole('button', { name: /当前会话回复积分/ }))
    expect(view.getByRole('dialog')).toBeTruthy()
    act(() => { f.identity.set({ ...account(), balance: { balance_points: 23, as_of: '' } }) })
    await flush()
    expect(fetcher).toHaveBeenCalledOnce()
    act(() => { f.identity.set(account('b', 2)) })
    await flush()
    expect(view.queryByRole('dialog')).toBeNull()
  })
})
