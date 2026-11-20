// @vitest-environment jsdom
/** A sidebar reminder uses the verified forum count without fetching or retaining another account's badge. */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type {} from '../src/client/index.ts'
import { DemandPanelIcon } from '../src/client/DemandPanelIcon.tsx'
import type { ForumPage, ForumState } from '../src/client/forum-types.ts'
import type { DemandTranslate } from '../src/client/DemandUI.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const translations: ReadonlyMap<string, string> = new Map(Object.entries(zh))
const t: DemandTranslate = (key, params) => (translations.get(key) ?? key).replace(/\{(\w+)\}/gu,
  (placeholder: string, name: string) => params !== undefined && name in params ? String(params[name]) : placeholder)
const empty: ForumPage<never> = { items: [], status: 'ready', hasMore: false, loadingMore: false, error: null }
function state(unreadCount: number | null): ForumState {
  return { availability: 'ready', accountId: '2', config: { revision: 1, enabled: true,
    capabilities: { immediate_publish: true, comments: true, likes: true, notifications: true } }, error: null,
  posts: empty, selectedPostId: null, selectedPost: null, selectedPostStatus: 'ready', selectedPostError: null,
  comments: empty, commentDraft: '', activePostDraftScope: null, postDrafts: [], pending: [], activity: {
    scope: 'all', myPosts: empty, myComments: empty, profile: { value: null, status: 'ready', saving: false, error: null },
    notifications: { ...empty, unreadCount, readingIds: [] }, highlightedCommentId: null } }
}

describe('forum sidebar unread reminder', () => {
  it('reacts to actual unread counts and hides unknown or read counts', () => {
    const store = createSnapshotStore(state(null))
    render(<DemandPanelIcon size={18} active={false} useForum={bindSnapshotSelector(store)}
      t={t} />)
    expect(screen.queryByRole('img')).toBeNull()
    act(() => { store.set(state(3)) })
    expect(screen.getByRole('img', { name: '论坛有 3 条未读提醒' })).toBeTruthy()
    act(() => { store.set(state(0)) })
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('clears the badge when signed out or unsupported while retaining a verified same-account count through a read error', () => {
    const store = createSnapshotStore(state(2))
    render(<DemandPanelIcon size={18} active useForum={bindSnapshotSelector(store)}
      t={t} />)
    act(() => { store.set({ ...state(2), availability: 'error' }) })
    expect(screen.getByRole('img', { name: '论坛有 2 条未读提醒' })).toBeTruthy()
    act(() => { store.set({ ...state(2), availability: 'login-required', accountId: null }) })
    expect(screen.queryByRole('img')).toBeNull()
    const unsupported = state(2)
    act(() => { store.set({ ...unsupported, config: null }) })
    expect(screen.queryByRole('img')).toBeNull()
  })
})
