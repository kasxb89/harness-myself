// @vitest-environment jsdom
/** Banner transport, account lifetime, explicit dismissal and carousel behavior. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { CreditsSnapshot } from '@deepseek-ai/dsh-client-ui-credits/src/client/session-store.ts'
import { parseAnnouncementBanner, readAnnouncementBanner, type AnnouncementBannerData, type AnnouncementBannerRead } from '../src/client/announcement-banner-reader.ts'
import { createAnnouncementBannerController, createAnnouncementDismissalStore, isBannerDismissed, type AnnouncementBannerView } from '../src/client/announcement-banner-store.ts'
import { TopAnnouncementBanner } from '../src/client/TopAnnouncementBanner.tsx'
import { en } from '../src/client/locales.ts'
const stops: (() => void)[] = []
afterEach(() => { for (const stop of stops.splice(0)) stop(); cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear() })
const a = 'a'.repeat(64), b = 'b'.repeat(64)
function data(revision = a): AnnouncementBannerData {
  return { enabled: true, scope: a, revision, announcements: [1, 2].map(id => ({ id, title: `Notice ${id}`,
    content: `Plain body ${id} <script>unsafe()</script>`, publishDate: '2026-11-01T01:00:00Z', updatedAt: null, type: 'default', extra: '' })) }
}
const unused = (() => { throw new Error('unused') }) as never
const kit: GlobalStandardProps = { useSessions: unused, useSessionStatus: unused, usePanelInfo: unused,
  useSessionRetainInfo: unused, useResource: unused, useWorkspaces: unused }
function snapshot(id = '1', epoch = 1): CreditsSnapshot {
  return { accountEpoch: epoch, loaded: true, failure: null, balance: null,
    session: { signedIn: true, creditsPerYuan: 1000, account: { id, phone: 'fixture' }, accountOwner: a } }
}
function mount() {
  const store = createAnnouncementDismissalStore().create()
  const view = createSnapshotStore<AnnouncementBannerView>({ account: '1', data: data() })
  return { store, view, render: render(<TopAnnouncementBanner {...kit} t={makeTranslate(en)}
    useStore={bindSnapshotSelector(store)} actions={store.actions} useAnnouncementBanner={bindSnapshotSelector(view)} />) }

}
it('projects safe fields and rejects malformed public metadata', async () => {
  expect(parseAnnouncementBanner({ ...data(), secret: 'untrusted' })).toEqual(data())
  for (const value of [{ ...data(), scope: 'bad' }, { ...data(), revision: '' }, { ...data(), enabled: 'yes' },
    { ...data(), announcements: [{ ...data().announcements[0], id: -1 }] },
    { ...data(), announcements: [...data().announcements, data().announcements[0]] },
  ]) expect(parseAnnouncementBanner(value)).toBeUndefined()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true, payload: data() })))
  expect(await readAnnouncementBanner(new AbortController().signal)).toEqual({ ok: true, payload: data() })
  expect(fetch).toHaveBeenCalledWith('/credits/api/announcement-banner', expect.objectContaining({ cache: 'no-store' }))
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ message: 'private upstream diagnostics' }, { status: 503 }))
  expect(await readAnnouncementBanner(new AbortController().signal)).toEqual({ ok: false })
})

it('keeps a title-only notice alongside a normal notice after upstream plain-text cleanup', async () => {
  const titleOnly = { ...data().announcements[0]!, title: 'Title-only notice', content: '' }
  const payload = { ...data(), announcements: [titleOnly, data().announcements[1]!] }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true, payload })))
  expect(await readAnnouncementBanner(new AbortController().signal)).toEqual({ ok: true, payload })
  const f = mount()
  act(() => { f.view.set({ account: '1', data: payload }) })
  expect(screen.getByText('Title-only notice')).toBeTruthy()
  fireEvent.click(screen.getByText('Title-only notice'))
  expect(screen.getByRole('dialog', { name: 'Title-only notice' })).toBeTruthy()
})

it('dismisses only one stable viewer and feed version, persists no notice bodies, and bounds stored history', () => {
  const s = createAnnouncementDismissalStore().create()
  s.actions.dismiss(`${a}:1`, a)
  expect(isBannerDismissed(s.getSnapshot(), `${a}:1`, a)).toBe(true)
  expect(isBannerDismissed(s.getSnapshot(), `${a}:2`, a)).toBe(false)
  expect(isBannerDismissed(s.getSnapshot(), `${b}:1`, a)).toBe(false)
  expect(isBannerDismissed(s.getSnapshot(), `${a}:1`, b)).toBe(false)
  const persisted = localStorage.getItem('dsh.announcements.dismissed.v1') ?? ''
  expect(persisted).not.toContain('Plain body')
  const restored = createAnnouncementDismissalStore().create()
  expect(isBannerDismissed(restored.getSnapshot(), `${a}:1`, a)).toBe(true)
  for (let i = 0; i < 150; i++) s.actions.dismiss(`${a}:${i}`, b)
  expect(Object.keys(s.getSnapshot().byViewer)).toHaveLength(128)
  expect(isBannerDismissed({ schemaVersion: 99, byViewer: { [`${a}:1`]: a } }, `${a}:1`, a)).toBe(false)
})
it('reads independently, retains content after transient failure, hides on a successful off, and cancels stale-account replies', async () => {
  vi.useFakeTimers()
  const source = createSnapshotStore(snapshot())
  const late = Promise.withResolvers<{ ok: true; payload: AnnouncementBannerData }>()
  const read = vi.fn<(signal: AbortSignal) => Promise<AnnouncementBannerRead>>()
    .mockResolvedValueOnce({ ok: true, payload: data() }).mockResolvedValueOnce({ ok: false })
    .mockResolvedValueOnce({ ok: true, payload: { ...data(), enabled: false, announcements: [] } }).mockReturnValueOnce(late.promise)
    .mockResolvedValueOnce({ ok: true, payload: data(b) })
  const controller = createAnnouncementBannerController(source, read)
  const stop = controller.start(); stops.push(stop)
  await vi.waitFor(() => { expect(controller.hooks.announcementBanner.getSnapshot().data?.enabled).toBe(true) })
  source.set({ ...snapshot(), balance: null })
  expect(read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(controller.hooks.announcementBanner.getSnapshot().data?.enabled).toBe(true)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(controller.hooks.announcementBanner.getSnapshot().data?.enabled).toBe(false)
  await vi.advanceTimersByTimeAsync(60_000)
  source.set(snapshot('2', 2))
  await vi.waitFor(() => { expect(controller.hooks.announcementBanner.getSnapshot().account).toBe('2') })
  late.resolve({ ok: true, payload: data() }); await Promise.resolve()
  expect(controller.hooks.announcementBanner.getSnapshot().data?.revision).toBe(b)
  expect(read.mock.calls[3]?.[0].aborted).toBe(true)
  stop(); const calls = read.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(read).toHaveBeenCalledTimes(calls)
})
it('rotates and pauses for hover/focus, shows plain text details, closes a revision and reopens only a new one', () => {
  vi.useFakeTimers()
  const f = mount()
  expect(screen.getByRole('region', { name: 'Top announcements' })).toBeTruthy()
  act(() => { vi.advanceTimersByTime(6000) })
  expect(screen.getByText('Notice 2')).toBeTruthy()
  const banner = screen.getByRole('region')
  fireEvent.mouseEnter(banner)
  act(() => { vi.advanceTimersByTime(6000) })
  expect(screen.getByText('Notice 2')).toBeTruthy()
  fireEvent.mouseLeave(banner)
  fireEvent.focus(screen.getByRole('button', { name: 'Previous announcement' }))
  act(() => { vi.advanceTimersByTime(6000) })
  expect(screen.getByText('Notice 2')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Next announcement' }))
  fireEvent.click(screen.getByText('Notice 1'))
  const dialog = screen.getByRole('dialog', { name: 'Notice 1' })
  expect(dialog.querySelector('script')).toBeNull()
  expect(dialog.textContent).toContain('<script>unsafe()</script>')
  fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss top announcements' }))
  expect(screen.queryByRole('region')).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  act(() => { f.view.set({ account: '1', data: data() }) })
  expect(screen.queryByRole('region')).toBeNull()
  act(() => { f.view.set({ account: '1', data: data(b) }) })
  expect(screen.getByRole('region')).toBeTruthy()
})
it('does not auto-rotate for reduced motion and keeps disabled/empty feeds out of the layout', () => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  const f = mount()
  act(() => { vi.advanceTimersByTime(12_000) })
  expect(screen.getByText('Notice 1')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Next announcement' }))
  expect(screen.getByText('Notice 2')).toBeTruthy()
  act(() => { f.view.set({ account: '1', data: { ...data(), enabled: false } }) })
  expect(screen.queryByRole('region')).toBeNull()
})
