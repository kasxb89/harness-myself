/** A local emoji chooser delegates the selected character to its controlled composer. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ForumEmojiPicker.module.css'

const EMOJIS = [
  '😀', '😊', '😄', '😂', '🥰', '😍', '🤔', '😎',
  '😭', '😅', '🙃', '😮', '👍', '👏', '🙌', '🙏',
  '🤝', '💪', '❤️', '💛', '🎉', '✨', '🔥', '💡',
  '✅', '🌟', '🌈', '🌸', '☀️', '🍀', '🚀', '🎯',
] as const

/**
 * Insert ordinary Unicode content without uploading files or minting a forum operation.
 * @param props - Localized trigger/group labels, the current composer lock and selection callback.
 * @returns An anchored, dismissible menu with the shared keyboard and focus behavior.
 */
export function ForumEmojiPicker({ label, groupLabel, disabled = false, onSelect }: {
  readonly label: string
  readonly groupLabel: string
  readonly disabled?: boolean
  readonly onSelect: (emoji: string) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  return <Menu open={open && !disabled} portal autoFocus side="top" listClassName={css.menu}
    onClose={() => { setOpen(false) }}
    anchor={<Button disabled={disabled} aria-haspopup="menu" aria-expanded={open && !disabled}
      onClick={() => { setOpen(value => !value) }}>{label}</Button>}>
    <div className={css.grid} role="group" aria-label={groupLabel}>
      {EMOJIS.map(emoji => <button key={emoji} className={css.emoji} type="button" role="menuitem"
        onClick={() => { onSelect(emoji); setOpen(false) }}>{emoji}</button>)}
    </div>
  </Menu>
}
