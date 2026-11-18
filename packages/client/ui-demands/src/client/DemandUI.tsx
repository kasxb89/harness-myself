/** Shared presentation inside the demand page; no transport or business state. */
import type { ReactNode } from 'react'
import {
  Button, IconNewChatOutlineRegular, IconUserOutlineRegular, IconUsersOutlineRegular, IconChecklistOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DemandEngineer, DemandPageProps, DemandServiceProfile, DemandStatus } from './types.ts'
import type { DemandLocaleKey } from './locales.ts'
import css from './DemandPage.module.css'

/** The locale seat supplied by the page's own registration. */
export type DemandTranslate = DemandPageProps['t']

const statusKeys: Record<DemandStatus, DemandLocaleKey> = {
  pending: 'statusPending', communicating: 'statusCommunicating', in_progress: 'statusInProgress',
  awaiting_acceptance: 'statusAwaitingAcceptance', completed: 'statusCompleted', cancelled: 'statusCancelled', closed: 'statusClosed',
}

/**
 * Show the server-owned stage with a textual label as well as color.
 * @param props - Current stage and localized labels.
 * @returns A read-only stage label.
 */
export function DemandStatusTag(props: { status: DemandStatus; unassigned?: boolean; t: DemandTranslate }): ReactNode {
  const { status, unassigned = false, t } = props
  return <span className={css.status} data-status={status}>{t(status === 'pending' && unassigned ? 'waitingAssignment' : statusKeys[status])}</span>
}

/**
 * Use the administrator's profile name with a neutral missing-name fallback.
 * @param engineer - Supplied engineer, or null while unassigned.
 * @param t - Localized neutral labels.
 * @returns The name or unassigned label to display.
 */
export function engineerName(engineer: DemandEngineer | null, t: DemandTranslate): string {
  return engineer === null ? t('unassignedEngineer') : engineer.displayName.trim() || t('engineerName')
}

/**
 * Present a real supplied avatar or a neutral person glyph.
 * @param props - Engineer and optional compact size.
 * @returns An avatar without an invented portrait.
 */
export function EngineerAvatar(props: { engineer: DemandEngineer | null; small?: boolean }): ReactNode {
  const { engineer, small = false } = props
  return <span className={css.avatar} data-small={small} aria-hidden="true">
    <IconUserOutlineRegular size={small ? 18 : 24} />
    {!engineer?.avatarUrl ? null : <img key={engineer.avatarUrl} src={engineer.avatarUrl} alt="" draggable={false} loading="lazy" decoding="async"
      onError={(event) => { event.currentTarget.hidden = true }} />}
  </span>
}

/**
 * Present supplied service artwork with a neutral request-list fallback.
 * @param props - Optional authorized artwork URL and compact size.
 * @returns A service mark that does not imply a person's portrait.
 */
export function ServiceProfileAvatar(props: { profile?: DemandServiceProfile; small?: boolean }): ReactNode {
  const { profile, small = false } = props
  return <span className={css.avatar} data-small={small} aria-hidden="true">
    <IconChecklistOutlineRegular size={small ? 18 : 24} />
    {!profile?.avatarUrl ? null : <img key={profile.avatarUrl} src={profile.avatarUrl} alt="" draggable={false}
      loading="lazy" decoding="async" onError={(event) => { event.currentTarget.hidden = true }} />}
  </span>
}

/**
 * Read presence from the server snapshot instead of the customer's clock.
 * @param props - Engineer presence and localized labels.
 * @returns A textual presence label and decorative dot.
 */
export function EngineerPresence(props: { engineer: DemandEngineer; t: DemandTranslate }): ReactNode {
  const { engineer, t } = props
  const key = engineer.presence === 'available' ? 'presenceAvailable' : engineer.presence === 'busy' ? 'presenceBusy' : 'presenceOffline'
  return <span className={css.presence} data-presence={engineer.presence}><span aria-hidden="true" />{t(key)}</span>
}

/**
 * Show a short empty state with an action only when the owner can perform it.
 * @param props - Localized content and optional real action.
 * @returns The empty-state content.
 */
export function DemandEmpty(props: {
  title: string
  detail: string
  people?: boolean
  actionLabel?: string | undefined
  onAction?: (() => void) | undefined
}): ReactNode {
  const { title, detail, people = false, actionLabel, onAction } = props
  const Icon = people ? IconUsersOutlineRegular : IconNewChatOutlineRegular
  return <div className={css.empty} role="status">
    <span className={css.emptyIcon} aria-hidden="true"><Icon size={28} /></span>
    <h2>{title}</h2><p>{detail}</p>
    {actionLabel === undefined || onAction === undefined ? null : <Button variant="outline" onClick={onAction}>{actionLabel}</Button>}
  </div>
}

/**
 * Reserve list layout while the server roster is loading.
 * @param props - Loading label and optional compact layout.
 * @returns Decorative placeholders inside one named status.
 */
export function DemandSkeleton(props: { label: string; compact?: boolean }): ReactNode {
  const { label, compact = false } = props
  return <div className={css.skeletonList} data-compact={compact} role="status" aria-label={label}>
    {Array.from({ length: compact ? 4 : 3 }, (_, index) => <div key={index} className={css.skeleton} aria-hidden="true">
      <span /><div><span /><span /></div>
    </div>)}
  </div>
}

/**
 * Format server timestamps for display only without inventing a missing time.
 * @param value - Timestamp supplied by the server or local draft journal.
 * @param t - Locale and fallback-time labels.
 * @returns A localized display time or the unknown-time label.
 */
export function demandTime(value: string, t: DemandTranslate): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return t('timeUnknown')
  return new Intl.DateTimeFormat(t('dateLocale'), {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

/**
 * Format byte units for deployment rules and attachment metadata.
 * @param value - File size in bytes.
 * @param t - Locale used for number and unit formatting.
 * @returns A localized size label.
 */
export function demandBytes(value: number, t: DemandTranslate): string {
  const bytes = Number.isFinite(value) ? Math.max(0, value) : 0
  const exponent = bytes >= 1024 ** 3 ? 3 : bytes >= 1024 ** 2 ? 2 : bytes >= 1024 ? 1 : 0
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const
  const unit = units[exponent]
  return new Intl.NumberFormat(t('dateLocale'), {
    style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1,
  }).format(bytes / 1024 ** exponent)
}
