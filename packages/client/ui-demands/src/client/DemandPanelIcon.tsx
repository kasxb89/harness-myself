/** Sidebar mark for private requests to human engineers. */
import type { ReactNode } from 'react'
import { IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForumFace } from './forum-types.ts'
import css from './DemandPanelIcon.module.css'

/**
 * Render a request-list glyph distinct from the chat entry.
 * @param props - Framework geometry and the same account-owned forum snapshot used by the page.
 * @returns The request icon with a visual indication of verified unread notifications.
 */
export function DemandPanelIcon({ size, useForum, t }: Pick<PropsRuntime<'sidebar.panellist'>, 'size' | 'active'> & PropsLocale<'demands'>
  & InjectFace<Pick<ForumFace, 'hooks'>>): ReactNode {
  const unread = useForum(state => state.accountId !== null && state.availability !== 'login-required'
    && state.config?.capabilities.notifications === true ? state.activity?.notifications.unreadCount ?? null : null)
  return <span className={css.icon}><IconChecklistOutlineRegular size={size} />
    {typeof unread !== 'number' || !Number.isSafeInteger(unread) || unread < 1 ? null
      : <span className={css.badge} role="img" aria-label={t('forumUnreadNotifications', { count: unread })} />}
  </span>
}
