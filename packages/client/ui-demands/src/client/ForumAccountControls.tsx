/** Optional forum account tools render only parent-qualified history, notifications and nickname editing. */
import { useEffect, useId, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, Input, Menu, Modal, Pill, IconCheckOutlineRegular, IconEditOutlineRegular,
  IconLikeOutlineRegular, IconQueueOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ForumAccountControls.module.css'

/** A normalized supported collection, independent of server route names. */
export type ForumAccountScope = 'all' | 'mine' | 'comments'

/** A verified notification contains public presentation fields, never a phone or credential. */
export interface ForumAccountNotification {
  readonly id: string
  readonly kind: 'reply' | 'like'
  readonly actorName: string
  readonly postTitle: string
  readonly excerpt: string
  readonly createdAt: string
  readonly unread: boolean
}

/** Every piece of UI copy and formatting is supplied by the feature's locale owner. */
export interface ForumAccountControlLabels {
  readonly history: string
  readonly scopes: Readonly<Record<ForumAccountScope, string>>
  readonly notifications: string
  readonly notificationsUnread: (count: number) => string
  readonly notificationAction: (kind: ForumAccountNotification['kind'], actorName: string) => string
  readonly notificationTime: (createdAt: string) => string
  readonly notificationOpen: (item: ForumAccountNotification) => string
  readonly markRead: (item: ForumAccountNotification) => string
  readonly noNotifications: string
  readonly loading: string
  readonly retry: string
  readonly loadMore: string
  readonly nickname: string
  readonly nicknameTitle: string
  readonly nicknameField: string
  readonly nicknameHint: string
  readonly saveNickname: string
  readonly savingNickname: string
  readonly cancel: string
  readonly close: string
}

/** Parent-owned notification state and explicit commands. Omission keeps the entry absent. */
export interface ForumAccountNotifications {
  readonly unreadCount: number | null
  readonly status: 'loading' | 'ready' | 'error'
  readonly items: readonly ForumAccountNotification[]
  readonly error: string | null
  readonly busy: boolean
  readonly hasMore: boolean
  readonly loadingMore: boolean
  readonly onOpen: (id: string) => void
  readonly onMarkRead?: (id: string) => void
  readonly onRetry: () => void
  readonly onLoadMore: () => void
}

/** Controlled nickname input; validation, persistence and confirmed display name remain with its owner. */
export interface ForumAccountNickname {
  readonly displayName: string
  readonly open: boolean
  readonly value: string
  readonly saving: boolean
  readonly locked: boolean
  readonly canSave: boolean
  readonly error: string | null
  readonly onOpen: () => void
  readonly onClose: () => void
  readonly onChange: (value: string) => void
  readonly onSave: () => void
  readonly onRetry?: () => void
  readonly retryLabel?: string
}

/** A capability-qualified, network-free forum toolbar. */
export interface ForumAccountControlsProps {
  readonly scope: ForumAccountScope
  readonly scopes: readonly ForumAccountScope[]
  readonly disabled?: boolean
  readonly onScopeChange: (scope: ForumAccountScope) => void
  readonly notifications?: ForumAccountNotifications
  readonly nickname?: ForumAccountNickname
  readonly labels: ForumAccountControlLabels
}

/**
 * Present supported account actions without inventing counts or saving anything automatically.
 * @param props - Parent-qualified capabilities, controlled state, complete labels and explicit callbacks.
 * @returns History filters and only the account tools actually supplied by the owner.
 */
export function ForumAccountControls({ scope, scopes, disabled = false, onScopeChange,
  notifications, nickname, labels }: ForumAccountControlsProps): ReactNode {
  const [notificationOpen, setNotificationOpen] = useState(false)
  const formId = useId()
  useEffect(() => {
    if (disabled || notifications === undefined) setNotificationOpen(false)
  }, [disabled, notifications])
  const count = notifications?.unreadCount
  const showUnread = typeof count === 'number' && Number.isSafeInteger(count) && count > 0
  const nicknameLocked = disabled || nickname?.saving === true || nickname?.locked === true
  const canSaveNickname = nickname !== undefined && !nicknameLocked && nickname.canSave && nickname.value.trim() !== ''
  return <div className={css.controls}>
    <div className={css.history} role="group" aria-label={labels.history}>
      {scopes.map(value => <Pill key={value} active={scope === value} aria-pressed={scope === value} disabled={disabled}
        onClick={() => { if (!disabled && value !== scope) onScopeChange(value) }}>{labels.scopes[value]}</Pill>)}
    </div>
    <div className={css.accountActions}>
      {notifications === undefined ? null : <Menu open={notificationOpen && !disabled} portal align="end" autoFocus
        listClassName={css.notificationMenu} onClose={() => { setNotificationOpen(false) }}
        anchor={<Button disabled={disabled} aria-haspopup="menu" aria-expanded={notificationOpen && !disabled}
          aria-label={showUnread ? labels.notificationsUnread(count) : labels.notifications}
          icon={<IconQueueOutlineRegular size={16} />} onClick={() => { setNotificationOpen(value => !value) }}>
          {labels.notifications}{showUnread ? <span className={css.badge} aria-hidden="true">{count}</span> : null}
        </Button>}>
        <div className={css.menuHeader}>{labels.notifications}</div>
        {notifications.error === null ? null : <p className={css.failure} role="alert">{notifications.error}</p>}
        {notifications.items.length > 0 ? notifications.items.map(item => <div key={item.id} className={css.notificationRow}
          data-unread={item.unread}>
          <button className={css.notificationItem} type="button" role="menuitem" aria-label={labels.notificationOpen(item)}
            onClick={() => { notifications.onOpen(item.id); setNotificationOpen(false) }}>
            <span className={css.notificationIcon} aria-hidden="true">
              {item.kind === 'reply' ? <IconQueueOutlineRegular size={16} /> : <IconLikeOutlineRegular size={16} />}
            </span>
            <span className={css.notificationCopy}>
              <span className={css.notificationAction}>{labels.notificationAction(item.kind, item.actorName)}</span>
              <span className={css.notificationTitle}>{item.postTitle}</span>
              {item.excerpt.trim() === '' ? null : <span className={css.notificationExcerpt}>{item.excerpt}</span>}
              {item.createdAt === '' ? null : <time dateTime={item.createdAt}>{labels.notificationTime(item.createdAt)}</time>}
            </span>
          </button>
          {!item.unread || notifications.onMarkRead === undefined ? null : <button className={css.markRead}
            type="button" role="menuitem" disabled={notifications.busy} aria-label={labels.markRead(item)}
            onClick={() => { if (!notifications.busy) notifications.onMarkRead?.(item.id) }}>
            <IconCheckOutlineRegular size={16} />
          </button>}
        </div>) : <p className={css.empty} role="status">
          {notifications.status === 'loading' ? labels.loading : notifications.status === 'ready' ? labels.noNotifications : null}
        </p>}
        {notifications.status !== 'error' ? null : <button className={css.menuAction} type="button" role="menuitem"
          disabled={notifications.busy} onClick={() => { if (!notifications.busy) notifications.onRetry() }}>{labels.retry}</button>}
        {!notifications.hasMore ? null : <button className={css.menuAction} type="button" role="menuitem"
          disabled={notifications.loadingMore} onClick={() => { if (!notifications.loadingMore) notifications.onLoadMore() }}>
          {notifications.loadingMore ? labels.loading : labels.loadMore}</button>}
      </Menu>}
      {nickname === undefined ? null : <>
        <Button disabled={disabled || nickname.saving} icon={<IconEditOutlineRegular size={16} />}
          onClick={() => { if (!disabled && !nickname.saving) nickname.onOpen() }}>
          {nickname.displayName.trim() || labels.nickname}
        </Button>
        <Modal open={nickname.open} onClose={nickname.onClose} title={labels.nicknameTitle} closeLabel={labels.close}
          className={clsx(css.nicknameDialog)} footer={<div className={css.dialogActions}>
            <Button onClick={nickname.onClose}>{labels.cancel}</Button>
            <Button type="submit" form={formId} variant="accent" disabled={!canSaveNickname}>
              {nickname.saving ? labels.savingNickname : labels.saveNickname}</Button>
          </div>}>
          <form id={formId} onSubmit={(event) => { event.preventDefault(); if (canSaveNickname) nickname.onSave() }}>
            <fieldset className={css.nicknameFields} disabled={nicknameLocked}>
              <label className={css.nicknameField} htmlFor={`${formId}-nickname`}>
                <span>{labels.nicknameField}</span>
                <Input id={`${formId}-nickname`} value={nickname.value} required data-modal-autofocus
                  onChange={(event) => { if (!nicknameLocked) nickname.onChange(event.target.value) }} />
              </label>
              {labels.nicknameHint === '' ? null : <p className={css.hint}>{labels.nicknameHint}</p>}
              {nickname.error === null ? null : <p className={css.failure} role="alert">{nickname.error}</p>}
            </fieldset>
            {nickname.error === null || nickname.onRetry === undefined ? null : <Button variant="outline"
              disabled={disabled || nickname.saving} onClick={nickname.onRetry}>{nickname.retryLabel ?? labels.retry}</Button>}
          </form>
        </Modal>
      </>}
    </div>
  </div>
}
