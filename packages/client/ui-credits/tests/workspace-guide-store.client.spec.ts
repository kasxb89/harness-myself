// @vitest-environment jsdom
/** Root ownership for manually opened workspace examples. */
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspaceGuide } from '../src/client/workspace-guide-store.ts'

afterEach(() => { localStorage.clear() })

describe('workspace examples ownership', () => {
  it('shares one active dialog, releases its owner, and allows reopening after dismissal', () => {
    const guide = createWorkspaceGuide()
    expect(guide.claim('first', 'account-a')).toBe(true)
    expect(guide.claim('second', 'account-a')).toBe(false)
    guide.dismiss('second')
    expect(guide.hooks.workspaceGuide.getSnapshot().active?.ownerId).toBe('first')
    guide.release('second')
    expect(guide.hooks.workspaceGuide.getSnapshot().active?.ownerId).toBe('first')
    guide.release('first')
    expect(guide.claim('second', 'account-a')).toBe(true)
    guide.dismiss('second')
    expect(guide.claim('first', 'account-a')).toBe(true)
    guide.dismiss('first')
    expect(guide.claim('first', 'account-b')).toBe(true)
  })

  it('leaves dialogs and notices temporary without reading or updating old welcome acknowledgements', () => {
    const previous = JSON.stringify({ version: 1, accounts: ['account-a'] })
    localStorage.setItem('dsh.workspace.guide.v1', previous)
    const guide = createWorkspaceGuide()
    expect(guide.hooks.workspaceGuide.getSnapshot()).toEqual({ active: null, notice: null })
    expect(guide.claim('chat-one', 'account-a')).toBe(true)
    guide.dismiss('chat-one')
    guide.claim('chat-two', 'account-b')
    guide.notify('inserted')
    expect(localStorage.getItem('dsh.workspace.guide.v1')).toBe(previous)
    expect(createWorkspaceGuide().hooks.workspaceGuide.getSnapshot()).toEqual({ active: null, notice: null })
  })

  it('keeps notices independent of the active composer', () => {
    const guide = createWorkspaceGuide()
    guide.claim('chat', 'account-a')
    guide.notify('busy')
    const first = guide.hooks.workspaceGuide.getSnapshot().notice
    guide.notify('busy')
    expect(guide.hooks.workspaceGuide.getSnapshot().notice?.seq).toBe((first?.seq ?? 0) + 1)
    guide.release('chat')
    expect(guide.hooks.workspaceGuide.getSnapshot().notice?.kind).toBe('busy')
    guide.dismissNotice()
    expect(guide.hooks.workspaceGuide.getSnapshot().notice).toBeNull()
  })
})
