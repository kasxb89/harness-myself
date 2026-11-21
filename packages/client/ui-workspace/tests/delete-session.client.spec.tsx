// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {
  MenuOpenState, SessionDeleteDialogProps, SessionDeleteTarget, SessionMenuItemProps, DeleteSessionInjected,
} from '../src/client/contract/slots.ts'
import { DeleteSessionMenuItem, SessionDeleteDialog } from '../src/client/session-actions/DeleteSession.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: SessionDeleteDialogProps['t'] = makeTranslate(zh, commonZh)
const id = SessionId('confirmed-session')
const standard: GlobalStandardProps = {
  useSessions: selector => selector({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
  useSessionStatus: selector => selector(new Map()),
  useSessionRetainInfo: () => undefined,
  usePanelInfo: selector => selector({ activePanelId: null }),
  useResource: () => ({ status: 'none', value: undefined, failure: undefined, reload: () => {} }),
  useWorkspaces: selector => selector({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  }),
}

function dialog(deleteSession: SessionDeleteDialogProps['deleteSession'], options: { cwd: string | undefined } = { cwd: '/work/customer' }) {
  const source = createSnapshotStore<SessionDeleteTarget | null>(null)
  const settleSessionDelete = vi.fn(() => { source.set(null) })
  render(
    <SessionDeleteDialog
      {...standard} t={t} useDeleteRequest={bindSnapshotSelector(source)}
      settleSessionDelete={settleSessionDelete} deleteSession={deleteSession}
    />,
  )
  const open = () => { act(() => { source.set({ sessionId: id, displayTitle: '保留独立产物', cwd: options.cwd }) }) }
  return { open, settleSessionDelete }
}

describe('permanent Session deletion confirmation', () => {
  it('opens confirmation from the separate destructive menu entry without deleting or opening the Session', () => {
    const setMenuOpen = vi.fn()
    const menu: MenuOpenState = [true, setMenuOpen]
    const requestSessionDelete = vi.fn()
    const props: SessionMenuItemProps<DeleteSessionInjected> = {
      ...standard, t, sessionId: id, displayTitle: '记录',
      useMenuOpenState: () => menu, useShortcuts: selector => selector([]), requestSessionDelete,
    }
    render(<DeleteSessionMenuItem {...props} />)
    const entry = screen.getByRole('menuitem', { name: '删除会话' })
    expect(entry.className).toMatch(/danger/)
    fireEvent.click(entry)
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(requestSessionDelete).toHaveBeenCalledExactlyOnceWith(id, '记录')
    expect(setMenuOpen.mock.invocationCallOrder[0]).toBeLessThan(requestSessionDelete.mock.invocationCallOrder[0]!)
  })

  it('starts closed, focuses Cancel, and returns focus on Escape without calling deletion', () => {
    const deleteSession = vi.fn(async () => {})
    const { open, settleSessionDelete } = dialog(deleteSession)
    expect(screen.queryByRole('dialog')).toBeNull()
    render(<button type="button">会话菜单</button>)
    const trigger = screen.getByRole('button', { name: '会话菜单' })
    trigger.focus()
    open()
    expect(screen.getByRole('dialog', { name: '永久删除此会话？' })).toBeTruthy()
    expect(screen.getByText('将永久删除“保留独立产物”的会话记录，删除后无法恢复。')).toBeTruthy()
    expect(screen.getByText(/独立生成的图片、视频、文档及工作区文件会保留/)).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(settleSessionDelete).toHaveBeenCalledOnce()
    expect(deleteSession).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('cancels without deleting and submits the captured identity only once while locked', async () => {
    const pending = Promise.withResolvers<undefined>()
    const deleteSession = vi.fn(() => pending.promise)
    const { open, settleSessionDelete } = dialog(deleteSession)
    open()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(deleteSession).not.toHaveBeenCalled()
    open()
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '永久删除' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(deleteSession).toHaveBeenCalledExactlyOnceWith(id, '/work/customer')
    expect(confirm.disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(settleSessionDelete).toHaveBeenCalledOnce()
    expect(screen.getByRole('status').textContent).toBe('正在删除会话记录…')
    await act(async () => { pending.resolve(undefined) })
    expect(settleSessionDelete).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('retains the confirmation and shows a running-work refusal without retrying automatically', async () => {
    const deleteSession = vi.fn(async () => { throw new Error(t('delete.session.active')) })
    const { open, settleSessionDelete } = dialog(deleteSession)
    open()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '永久删除' })) })
    expect(deleteSession).toHaveBeenCalledOnce()
    expect(settleSessionDelete).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe(t('delete.session.active'))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '永久删除' }).disabled).toBe(false)
  })

  it('does not authorize deletion when the captured Workspace is missing', () => {
    const deleteSession = vi.fn(async () => {})
    const { open } = dialog(deleteSession, { cwd: undefined })
    open()
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '永久删除' })
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(deleteSession).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(t('delete.session.missingWorkspace'))
  })
})
