// @vitest-environment jsdom
/** Forum account tools expose only parent-qualified state and explicit account commands. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ForumAccountControls, type ForumAccountControlLabels, type ForumAccountControlsProps,
  type ForumAccountNickname, type ForumAccountNotifications,
} from '../src/client/ForumAccountControls.tsx'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void { /* Placement is checked in the browser. */ }
    unobserve(): void { /* No geometry subscription in jsdom. */ }
    disconnect(): void { /* No retained observer. */ }
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const labels: ForumAccountControlLabels = {
  history: '帖子范围', scopes: { all: '全部', mine: '我的发布', comments: '我的评论' },
  notifications: '消息', notificationsUnread: count => `消息，${count} 条未读`,
  notificationAction: (kind, actor) => `${actor}${kind === 'reply' ? '回复了你' : '赞了你的内容'}`,
  notificationTime: value => value, notificationOpen: item => `打开${item.postTitle}的消息`,
  markRead: item => `将${item.postTitle}标为已读`, noNotifications: '暂无消息', loading: '正在加载',
  retry: '重试', loadMore: '加载更多', nickname: '论坛昵称', nicknameTitle: '设置论坛昵称',
  nicknameField: '昵称', nicknameHint: '仅在论坛使用', saveNickname: '保存', savingNickname: '保存中',
  cancel: '取消', close: '关闭',
}

function notifications(overrides: Partial<ForumAccountNotifications> = {}): ForumAccountNotifications {
  return {
    unreadCount: 7, status: 'ready', error: null, busy: false, hasMore: false, loadingMore: false,
    items: [
      { id: 'reply-original', kind: 'reply', actorName: '云间', postTitle: '表格自动化', excerpt: '可以先整理字段', createdAt: '2026-11-20T10:00:00Z', unread: true },
      { id: 'like-original', kind: 'like', actorName: '清风', postTitle: '视频工作流', excerpt: '', createdAt: '', unread: false },
    ],
    onOpen: vi.fn(), onMarkRead: vi.fn(), onRetry: vi.fn(), onLoadMore: vi.fn(), ...overrides,
  }
}

function nickname(overrides: Partial<ForumAccountNickname> = {}): ForumAccountNickname {
  return {
    displayName: '云间', open: false, value: '云间', saving: false, locked: false, canSave: true, error: null,
    onOpen: vi.fn(), onClose: vi.fn(), onChange: vi.fn(), onSave: vi.fn(), ...overrides,
  }
}

function props(overrides: Partial<ForumAccountControlsProps> = {}): ForumAccountControlsProps {
  return { scope: 'all', scopes: ['all', 'mine', 'comments'], onScopeChange: vi.fn(), labels, ...overrides }
}

describe('optional forum account controls', () => {
  it('renders only supported scopes and omits capabilities that have not been supplied', () => {
    const p = props({ scopes: ['all', 'mine'] })
    const view = render(<ForumAccountControls {...p} />)
    const group = screen.getByRole('group', { name: '帖子范围' })
    expect(within(group).getAllByRole('button')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: '我的评论' })).toBeNull()
    expect(screen.queryByRole('button', { name: '消息' })).toBeNull()
    expect(screen.queryByRole('button', { name: '论坛昵称' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    expect(p.onScopeChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '我的发布' }))
    expect(p.onScopeChange).toHaveBeenCalledExactlyOnceWith('mine')
    expect(screen.getByRole('button', { name: '全部' }).getAttribute('aria-pressed')).toBe('true')
    view.rerender(<ForumAccountControls {...p} scope="mine" disabled />)
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    expect(p.onScopeChange).toHaveBeenCalledOnce()
  })

  it('shows the supplied unread count and opens the original notification without implicitly marking it read', async () => {
    const data = notifications(), p = props({ notifications: data })
    render(<ForumAccountControls {...p} />)
    const trigger = screen.getByRole('button', { name: '消息，7 条未读' })
    trigger.focus(); fireEvent.click(trigger)
    expect(screen.getByText('云间回复了你')).toBeTruthy()
    expect(screen.getByText('清风赞了你的内容')).toBeTruthy()
    expect(screen.getByText('可以先整理字段')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '打开表格自动化的消息' }))
    expect(data.onOpen).toHaveBeenCalledExactlyOnceWith('reply-original')
    expect(data.onMarkRead).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: '消息，7 条未读' })).toBeTruthy()
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
  })

  it('marks only an explicitly chosen unread record and waits for parent counts, while busy blocks that command', () => {
    const data = notifications(), p = props({ notifications: data })
    const view = render(<ForumAccountControls {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '消息，7 条未读' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '将表格自动化标为已读' }))
    expect(data.onMarkRead).toHaveBeenCalledExactlyOnceWith('reply-original')
    expect(data.onOpen).not.toHaveBeenCalled()
    expect(screen.queryByRole('menuitem', { name: '将视频工作流标为已读' })).toBeNull()
    expect(screen.getByRole('button', { name: '消息，7 条未读' })).toBeTruthy()
    view.rerender(<ForumAccountControls {...p} notifications={{ ...data, busy: true, unreadCount: 6 }} />)
    const mark = screen.getByRole('menuitem', { name: '将表格自动化标为已读' })
    expect(mark).toHaveProperty('disabled', true)
    fireEvent.click(mark)
    expect(data.onMarkRead).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '消息，6 条未读' })).toBeTruthy()
  })

  it('preserves the unknown count and shows server loading, empty, error and paging states without invented records', () => {
    const data = notifications({ unreadCount: null, status: 'loading', items: [] }), p = props({ notifications: data })
    const view = render(<ForumAccountControls {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '消息' }))
    expect(screen.getByRole('status').textContent).toBe('正在加载')
    expect(screen.queryByRole('menuitem')).toBeNull()
    view.rerender(<ForumAccountControls {...p} notifications={{ ...data, status: 'ready', unreadCount: 0 }} />)
    expect(screen.getByRole('status').textContent).toBe('暂无消息')
    expect(screen.getByRole('button', { name: '消息' })).toBeTruthy()
    view.rerender(<ForumAccountControls {...p} notifications={{ ...data, status: 'error', error: '读取失败' }} />)
    expect(screen.getByRole('alert').textContent).toBe('读取失败')
    fireEvent.click(screen.getByRole('menuitem', { name: '重试' }))
    expect(data.onRetry).toHaveBeenCalledOnce()
    view.rerender(<ForumAccountControls {...p} notifications={{ ...data, status: 'ready', hasMore: true }} />)
    fireEvent.click(screen.getByRole('menuitem', { name: '加载更多' }))
    expect(data.onLoadMore).toHaveBeenCalledOnce()
    view.rerender(<ForumAccountControls {...p} notifications={{ ...data, hasMore: true, loadingMore: true }} />)
    expect(screen.getByRole('menuitem', { name: '正在加载' })).toHaveProperty('disabled', true)
  })

  it('uses shared Escape, outside dismissal and focus return, and closes when its capability is withdrawn', () => {
    const p = props({ notifications: notifications() }), view = render(<ForumAccountControls {...p} />)
    const trigger = screen.getByRole('button', { name: '消息，7 条未读' })
    trigger.focus(); fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    fireEvent.click(trigger); fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(trigger)
    view.rerender(<ForumAccountControls {...p} disabled />)
    expect(screen.queryByRole('menu')).toBeNull()
    view.rerender(<ForumAccountControls {...props()} />)
    expect(screen.queryByRole('button', { name: /^消息/ })).toBeNull()
  })

  it('uses a controlled nickname dialog with explicit open, change and save commands', () => {
    const data = nickname(), p = props({ nickname: data })
    const view = render(<ForumAccountControls {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '云间' }))
    expect(data.onOpen).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    view.rerender(<ForumAccountControls {...p} nickname={{ ...data, open: true }} />)
    const input = screen.getByRole('textbox', { name: '昵称' })
    fireEvent.change(input, { target: { value: '新昵称' } })
    expect(data.onChange).toHaveBeenCalledExactlyOnceWith('新昵称')
    expect(input).toHaveProperty('value', '云间')
    expect(screen.queryByRole('textbox', { name: /手机|电话/ })).toBeNull()
    view.rerender(<ForumAccountControls {...p} nickname={{ ...data, open: true, value: '新昵称' }} />)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(data.onSave).toHaveBeenCalledOnce()
    expect(screen.getByRole('dialog', { name: '设置论坛昵称' })).toBeTruthy()
  })

  it('prevents nickname submission when invalid, blank, saving or locked, including synthetic form commands', () => {
    const data = nickname({ open: true, canSave: false }), p = props({ nickname: data })
    const view = render(<ForumAccountControls {...p} />)
    const input = screen.getByRole('textbox', { name: '昵称' }), form = input.closest('form')!
    fireEvent.submit(form)
    expect(data.onSave).not.toHaveBeenCalled()
    view.rerender(<ForumAccountControls {...p} nickname={{ ...data, canSave: true, value: '   ' }} />)
    fireEvent.submit(form)
    expect(data.onSave).not.toHaveBeenCalled()
    for (const state of [{ saving: true }, { locked: true }]) {
      view.rerender(<ForumAccountControls {...p} nickname={{ ...data, canSave: true, ...state }} />)
      expect(input.matches(':disabled')).toBe(true)
      fireEvent.submit(form)
      fireEvent.change(input, { target: { value: '不能修改' } })
    }
    expect(data.onSave).not.toHaveBeenCalled()
    expect(data.onChange).not.toHaveBeenCalled()
  })

  it('closes the controlled nickname dialog without saving or modifying its draft', async () => {
    const data = nickname(), p = props({ nickname: data })
    const view = render(<ForumAccountControls {...p} />)
    const trigger = screen.getByRole('button', { name: '云间' })
    trigger.focus()
    view.rerender(<ForumAccountControls {...p} nickname={{ ...data, open: true, error: '昵称已存在' }} />)
    expect(screen.getByRole('alert').textContent).toBe('昵称已存在')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(data.onClose).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(data.onClose).toHaveBeenCalledTimes(2)
    expect(data.onSave).not.toHaveBeenCalled()
    expect(data.onChange).not.toHaveBeenCalled()
    view.rerender(<ForumAccountControls {...p} />)
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
  })
})
