// @vitest-environment jsdom
/** Emoji selection stays ordinary composer text and never owns forum submission. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForumEmojiPicker } from '../src/client/ForumEmojiPicker.tsx'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void { /* Real placement is checked in the browser. */ }
    unobserve(): void { /* No geometry subscription in jsdom. */ }
    disconnect(): void { /* No retained observer. */ }
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('forum emoji chooser', () => {
  it('opens a named group of characters and selects exactly once without submitting a surrounding form', async () => {
    const selected = vi.fn(), submitted = vi.fn()
    render(<form onSubmit={submitted}><ForumEmojiPicker label="表情" groupLabel="选择表情" onSelect={selected} /></form>)
    const trigger = screen.getByRole('button', { name: '表情' })
    trigger.focus()
    fireEvent.click(trigger)
    const group = screen.getByRole('group', { name: '选择表情' })
    expect(within(group).getAllByRole('menuitem')).toHaveLength(32)
    fireEvent.click(within(group).getByRole('menuitem', { name: '👍' }))
    expect(selected).toHaveBeenCalledExactlyOnceWith('👍')
    expect(submitted).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
  })

  it('uses shared keyboard navigation and closes on Escape with focus returned to its trigger', () => {
    const selected = vi.fn()
    render(<ForumEmojiPicker label="表情" groupLabel="选择表情" onSelect={selected} />)
    const trigger = screen.getByRole('button', { name: '表情' })
    trigger.focus(); fireEvent.click(trigger)
    const items = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(selected).not.toHaveBeenCalled()
  })

  it('dismisses outside and respects a lock applied while the menu is open', () => {
    const selected = vi.fn()
    const view = render(<ForumEmojiPicker label="表情" groupLabel="选择表情" onSelect={selected} />)
    const trigger = screen.getByRole('button', { name: '表情' })
    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(trigger)
    view.rerender(<ForumEmojiPicker label="表情" groupLabel="选择表情" disabled onSelect={selected} />)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveProperty('disabled', true)
    fireEvent.click(trigger)
    expect(selected).not.toHaveBeenCalled()
    view.rerender(<ForumEmojiPicker label="表情" groupLabel="选择表情" onSelect={selected} />)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('allows the composer owner to restore its own caret focus after selection', async () => {
    const selected = vi.fn()
    render(<><textarea aria-label="回复" /><ForumEmojiPicker label="表情" groupLabel="选择表情"
      onSelect={(emoji) => { selected(emoji); screen.getByRole('textbox', { name: '回复' }).focus() }} /></>)
    fireEvent.click(screen.getByRole('button', { name: '表情' }))
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(selected).toHaveBeenCalledExactlyOnceWith('😀')
    expect(screen.queryByRole('menu')).toBeNull()
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '回复' })) })
  })
})
