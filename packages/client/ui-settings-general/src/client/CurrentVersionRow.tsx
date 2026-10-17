/** Installed release version in General Settings for Web and Desktop. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DesktopUpdateCheck, type DesktopUpdateCheckProps } from './DesktopUpdateCheck.tsx'
import css from './CurrentVersionRow.module.css'

/**
 * Render the embedded version and the permanent Desktop manual-check action.
 * @param props - runtime share and localized copy.
 * @returns The release label and optional check; Web without metadata omits the row.
 */
export function CurrentVersionRow(props: PropsRuntime<'settings.general.item'> & PropsLocale<'settings'> & DesktopUpdateCheckProps) {
  const { t, desktopUpdateAvailable } = props
  const version = process.env.DSH_CLIENT_VERSION
  if (version === undefined && !desktopUpdateAvailable) return null
  return <div className={css.row}>
    {version !== undefined && <span>{t('general.currentVersion', { version })}</span>}
    <DesktopUpdateCheck {...props} />
  </div>
}
