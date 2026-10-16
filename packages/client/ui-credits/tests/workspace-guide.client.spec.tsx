// @vitest-environment jsdom
/** Workspace examples use the real composer insertion API without sending a turn. */
import { useSyncExternalStore } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SessionInputShell } from '../../ui-conversation/src/client/input/facade.ts'
import { WorkspaceGuide, WorkspaceGuideToast } from '../src/client/WorkspaceGuide.tsx'
import { en, zh, type CreditsKey } from '../src/client/locales.ts'
import type { CreditsSnapshot } from '../src/client/session-store.ts'
import { createWorkspaceGuide } from '../src/client/workspace-guide-store.ts'

let account: CreditsSnapshot = {
  session: { signedIn: true, creditsPerYuan: 1000, account: { id: 'account-a', phone: '+8613800138000' } },
  loaded: true, balance: null, failure: null,
}
vi.mock('../src/client/session-store.ts', () => ({ useCreditsSnapshot: () => account }))

type GuideProps = Parameters<typeof WorkspaceGuide>[0]
type Controller = ReturnType<typeof createWorkspaceGuide>

function fixture(locale: 'zh' | 'en' = 'zh', controller: Controller = createWorkspaceGuide()) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const submit = vi.fn()
  const input = new SessionInputShell({ actx: ctx, defaultSink: submit, commandAttachments: {
    serialize: async () => [], release: () => {}, unsupportedNotice: () => '',
  } })
  onTestFinished(() => { input.dispose() })
  const { hooks, ...commands } = controller
  const subscribeGuide = (listener: () => void) => hooks.workspaceGuide.subscribe(listener)
  const getGuide = () => hooks.workspaceGuide.getSnapshot()
  const subscribeInput = (listener: () => void) => input.state.subscribe(listener)
  const getInput = () => input.state.getSnapshot()
  const useWorkspaceGuide: GuideProps['useWorkspaceGuide'] = selector =>
    selector(useSyncExternalStore(subscribeGuide, getGuide))
  const dictionary = locale === 'zh' ? zh : en
  const t: GuideProps['t'] = (key: CreditsKey) => dictionary[key]
  function Composer({ running = false }: { running?: boolean }) {
    const state = useSyncExternalStore(subscribeInput, getInput)
    return <WorkspaceGuide
      {...commands} t={t} useWorkspaceGuide={useWorkspaceGuide}
      sessionId={'guide-session' as GuideProps['sessionId']}
      session={{ running } as GuideProps['session']}
      input={state} inputActions={input.actions}
    />
  }
  function Notice() { return <WorkspaceGuideToast {...commands} t={t} useWorkspaceGuide={useWorkspaceGuide} /> }
  return { input, submit, Composer, Notice, controller }
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  account = { ...account, session: { signedIn: true, creditsPerYuan: 1000, account: { id: 'account-a', phone: '+8613800138000' } } }
})

describe('workspace examples', () => {
  it.each(['zh', 'en'] as const)('opens localized examples only on request (%s)', (locale) => {
    const f = fixture(locale)
    const view = render(<f.Composer />)
    expect(view.queryByRole('dialog')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: (locale === 'zh' ? zh : en)['guide.entry'] }))
    const dialog = view.getByRole('dialog')
    expect(dialog.textContent).toMatchSnapshot()
    expect(dialog.textContent).not.toContain('API Key')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('preserves existing text, references and attachments when inserting a generation example, without submission', () => {
    const f = fixture()
    f.input.setDraft('@ref 原来的要求')
    f.input.insertReference({ source: 'file', ref: 'reference.png', label: 'reference.png', clipboardText: '@reference.png' }, {
      start: 0, end: 4, draftRev: f.input.state.getSnapshot().draftRev,
    })
    f.input.actions.addAttachments(['attachment-image' as Parameters<typeof f.input.actions.addAttachments>[0][number]])
    const original = f.input.state.getSnapshot()
    const view = render(<><f.Composer /><f.Notice /></>)
    fireEvent.click(view.getByRole('button', { name: zh['guide.entry'] }))
    fireEvent.click(view.getByRole('button', { name: zh['guide.example.create'] }))
    expect(f.input.state.getSnapshot().draft).toContain('原来的要求')
    expect(f.input.state.getSnapshot().draft).toContain(zh['guide.prompt.create'])
    expect(f.input.state.getSnapshot().occurrences.map(ref => ref.ref)).toEqual(original.occurrences.map(ref => ref.ref))
    expect(f.input.state.getSnapshot().attachmentIds).toEqual(original.attachmentIds)
    expect(view.queryByRole('dialog')).toBeNull()
    expect(view.getByRole('alert').textContent).toBe(zh['guide.inserted'])
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('refuses a stale capture and keeps the newer draft visible for retry', () => {
    const f = fixture()
    const view = render(<><f.Composer /><f.Notice /></>)
    fireEvent.click(view.getByRole('button', { name: zh['guide.entry'] }))
    act(() => { f.input.setDraft('用户继续写的内容') })
    fireEvent.click(view.getByRole('button', { name: zh['guide.example.edit'] }))
    expect(f.input.state.getSnapshot().draft).toBe('用户继续写的内容')
    expect(view.getByRole('alert').textContent).toBe(zh['guide.changed'])
    expect(view.getByRole('dialog')).toBeTruthy()
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('inserts after a selection without replacing its selected text', () => {
    const f = fixture()
    f.input.setDraft('原有选择文本')
    vi.spyOn(f.input.actions, 'captureInsertion').mockReturnValue({
      start: 0, end: 6, draftRev: f.input.state.getSnapshot().draftRev,
    })
    const view = render(<f.Composer />)
    fireEvent.click(view.getByRole('button', { name: zh['guide.entry'] }))
    fireEvent.click(view.getByRole('button', { name: zh['guide.example.edit'] }))
    expect(f.input.state.getSnapshot().draft).toBe(`原有选择文本\n${zh['guide.prompt.edit']}\n`)
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('allows reading examples while busy but refuses to edit a running task', () => {
    const f = fixture()
    const view = render(<><f.Composer running /><f.Notice /></>)
    expect(view.queryByRole('dialog')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: zh['guide.entry'] }))
    fireEvent.click(view.getByRole('button', { name: zh['guide.example.create'] }))
    expect(f.input.state.getSnapshot().draft).toBe('')
    expect(view.getByRole('alert').textContent).toBe(zh['guide.busy'])
    expect(f.submit).not.toHaveBeenCalled()
  })

  it.each(['escape', 'close', 'mask'] as const)('keeps %s dismissal closed and allows a later manual reopen', (method) => {
    const f = fixture()
    const view = render(<f.Composer />)
    fireEvent.click(view.getByRole('button', { name: zh['guide.entry'] }))
    if (method === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
    else if (method === 'close') fireEvent.click(view.getByRole('button', { name: zh['guide.close'] }))
    else {
      const mask = view.getByRole('dialog').previousElementSibling
      if (mask === null) throw new Error('Expected modal mask')
      fireEvent.click(mask)
    }
    expect(view.queryByRole('dialog')).toBeNull()
    view.rerender(<f.Composer />)
    expect(view.queryByRole('dialog')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: zh['guide.entry'] }))
    expect(view.getByRole('dialog')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: zh['guide.done'] }))
    view.rerender(<f.Composer />)
    expect(view.queryByRole('dialog')).toBeNull()
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('shows only the manual entry after sign-in without opening a welcome dialog', () => {
    account = { ...account, session: { signedIn: false, creditsPerYuan: 1000 } }
    const f = fixture()
    const view = render(<f.Composer />)
    expect(view.queryByRole('button')).toBeNull()
    expect(localStorage.length).toBe(0)
    account = { ...account, session: { signedIn: true, creditsPerYuan: 1000, account: { id: 'new-account', phone: '+8613800138000' } } }
    view.rerender(<f.Composer />)
    expect(view.queryByRole('dialog')).toBeNull()
    expect(view.getByRole('button', { name: zh['guide.entry'] })).toBeTruthy()
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('closes the active examples on account switch and captures a new draft only after reopening', () => {
    const f = fixture()
    f.input.setDraft('原有要求')
    const view = render(<f.Composer />)
    fireEvent.click(view.getByRole('button', { name: zh['guide.entry'] }))
    expect(view.getByRole('dialog')).toBeTruthy()
    account = { ...account, session: { signedIn: true, creditsPerYuan: 1000, account: { id: 'account-b', phone: '+8613900139000' } } }
    view.rerender(<f.Composer />)
    expect(view.queryByRole('dialog')).toBeNull()
    expect(f.controller.hooks.workspaceGuide.getSnapshot().active).toBeNull()
    expect(f.input.state.getSnapshot().draft).toBe('原有要求')
    fireEvent.click(view.getByRole('button', { name: zh['guide.entry'] }))
    fireEvent.click(view.getByRole('button', { name: zh['guide.example.edit'] }))
    expect(f.input.state.getSnapshot().draft).toContain(zh['guide.prompt.edit'])
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('closes active examples on sign-out and does not reopen them when signing back in', () => {
    const f = fixture()
    const view = render(<f.Composer />)
    fireEvent.click(view.getByRole('button', { name: zh['guide.entry'] }))
    account = { ...account, session: { signedIn: false, creditsPerYuan: 1000 } }
    view.rerender(<f.Composer />)
    expect(view.queryByRole('dialog')).toBeNull()
    expect(view.queryByRole('button')).toBeNull()
    expect(f.controller.hooks.workspaceGuide.getSnapshot().active).toBeNull()
    account = { ...account, session: { signedIn: true, creditsPerYuan: 1000, account: { id: 'account-a', phone: '+8613800138000' } } }
    view.rerender(<f.Composer />)
    expect(view.queryByRole('dialog')).toBeNull()
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('keeps only one guide open across multiple mounted chats', () => {
    const controller = createWorkspaceGuide()
    const first = fixture('zh', controller)
    const second = fixture('zh', controller)
    const view = render(<><first.Composer /><second.Composer /><first.Notice /></>)
    expect(view.queryByRole('dialog')).toBeNull()
    fireEvent.click(view.getAllByRole('button', { name: zh['guide.entry'] })[0]!)
    expect(view.getAllByRole('dialog')).toHaveLength(1)
    fireEvent.click(view.getAllByRole('button', { name: zh['guide.entry'] })[1]!)
    expect(view.getAllByRole('dialog')).toHaveLength(1)
    expect(view.getByRole('alert').textContent).toBe(zh['guide.alreadyOpen'])
  })
})
