// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { Announcements, type AnnouncementsProps } from '../src/client/Announcements.tsx'
import { readAnnouncements, type AnnouncementRead } from '../src/client/announcement-reader.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const unused = (() => { throw new Error('unused standard hook') }) as never
const kit = { useSessions: unused, useSessionStatus: unused, usePanelInfo: unused, useSessionRetainInfo: unused,
  useResource: unused as GlobalStandardProps['useResource'], useWorkspaces: unused }
const item = { content: '<b>Maintenance</b><script>window.fixture=1</script>', extra: '<img src=x onerror=fixture()>',
  publishDate: '2026-10-23T09:00:00+08:00' }
const success: AnnouncementRead = { ok: true, enabled: true, items: [item] }
const empty: AnnouncementRead = { ok: true, enabled: false, items: [] }

function mount(read: AnnouncementsProps['readAnnouncements'], wide = true) {
  const locale = createSnapshotStore<LocaleSnapshot>({ active: 'en', locales: [], revision: 0 })
  const props: AnnouncementsProps = { ...kit, wide, t: makeTranslate(en), readAnnouncements: read,
    useAnnouncementLocale: bindSnapshotSelector(locale) }
  return { view: render(<Announcements {...props} />), props, locale }
}

it('reads only on demand, renders source HTML as text, formats dates in the active language and closes with Escape', async () => {
  const read = vi.fn(async () => success)
  const f = mount(read, false)
  expect(read).not.toHaveBeenCalled()
  const button = screen.getByRole('button', { name: 'Announcements' })
  fireEvent.focus(button)
  expect(await screen.findByRole('tooltip')).toBeTruthy()
  fireEvent.click(button)
  const dialog = await screen.findByRole('dialog', { name: 'Announcements' })
  expect(await screen.findByText(item.content)).toBeTruthy()
  expect(screen.getByText(item.extra)).toBeTruthy()
  expect(dialog.querySelector('b,script,img,a')).toBeNull()
  expect(dialog.querySelector('time')?.dateTime).toBe(item.publishDate)
  expect(dialog.querySelector('time')?.textContent).toBe(new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.publishDate)))
  act(() => { f.locale.set({ active: 'zh', locales: [], revision: 1 }) })
  f.view.rerender(<Announcements {...f.props} t={makeTranslate(zh)} />)
  expect(dialog.querySelector('time')?.textContent).toBe(new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.publishDate)))
  expect(read).toHaveBeenCalledOnce()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('retains a successful list when refreshing fails, and retries without duplicating a pending read', async () => {
  const pending = Promise.withResolvers<AnnouncementRead>()
  const read = vi.fn<AnnouncementsProps['readAnnouncements']>().mockResolvedValueOnce(success)
    .mockReturnValueOnce(pending.promise).mockResolvedValueOnce(empty)
  mount(read)
  fireEvent.click(screen.getByRole('button', { name: 'Announcements' }))
  await screen.findByText(item.content)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText(item.content)).toBeTruthy()
  await act(async () => { pending.resolve({ ok: false, reason: 'network' }) })
  expect(screen.getByRole('alert').textContent).toBe(en['announcements.network'])
  expect(screen.getByText(item.content)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('No announcements')
  expect(screen.queryByText(item.content)).toBeNull()
  expect(read).toHaveBeenCalledTimes(3)
})

it('aborts closed reads and ignores their late answers after reopening', async () => {
  const old = Promise.withResolvers<AnnouncementRead>()
  const read = vi.fn<AnnouncementsProps['readAnnouncements']>().mockReturnValueOnce(old.promise).mockResolvedValueOnce(empty)
  mount(read)
  fireEvent.click(screen.getByRole('button', { name: 'Announcements' }))
  expect(screen.getByRole('status').getAttribute('aria-label')).toBe(en['announcements.loading'])
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(read.mock.calls[0]?.[0].aborted).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Announcements' }))
  await screen.findByText('No announcements')
  await act(async () => { old.resolve(success) })
  expect(screen.queryByText(item.content)).toBeNull()
})

it.each(['unsupported', 'network', 'unavailable', 'invalid', 'authorization', 'account-changed'] as const)(
  'shows localized %s guidance instead of an empty list', async (reason) => {
    mount(async () => ({ ok: false, reason }))
    fireEvent.click(screen.getByRole('button', { name: 'Announcements' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText('No announcements')).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  },
)

it('does not retain a previous list across an observed account change', async () => {
  const read = vi.fn<AnnouncementsProps['readAnnouncements']>().mockResolvedValueOnce(success)
    .mockResolvedValueOnce({ ok: false, reason: 'account-changed' })
  mount(read)
  fireEvent.click(screen.getByRole('button', { name: 'Announcements' }))
  await screen.findByText(item.content)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByRole('alert')
  expect(screen.queryByText(item.content)).toBeNull()
})

it('uses the local Host route and safe classifications without returning raw response messages', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true, payload: { enabled: true, items: [item] } }))
  vi.stubGlobal('fetch', fetcher)
  const signal = new AbortController().signal
  expect(await readAnnouncements(signal)).toEqual(success)
  expect(fetcher).toHaveBeenCalledWith('/credits/api/announcements', expect.objectContaining({ signal, cache: 'no-store' }))
  for (const [status, reason] of [[404, 'unsupported'], [401, 'authorization'], [503, 'unavailable']] as const) {
    fetcher.mockResolvedValueOnce(new Response('private diagnostic', { status }))
    expect(await readAnnouncements(signal)).toEqual({ ok: false, reason })
  }
  fetcher.mockRejectedValueOnce(new TypeError('private connection detail'))
  expect(await readAnnouncements(signal)).toEqual({ ok: false, reason: 'network' })
  fetcher.mockResolvedValueOnce(Response.json({ ok: false, code: 'ACCOUNT_CHANGED', message: 'private' }))
  expect(await readAnnouncements(signal)).toEqual({ ok: false, reason: 'account-changed' })
  fetcher.mockResolvedValueOnce(new Response('bad-json'))
  expect(await readAnnouncements(signal)).toEqual({ ok: false, reason: 'invalid' })
  fetcher.mockResolvedValueOnce(new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError('connection interrupted')) },
  })))
  expect(await readAnnouncements(signal)).toEqual({ ok: false, reason: 'network' })
})
