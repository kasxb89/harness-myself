/** Permanent Desktop update checks in General Settings and above Mobile in the sidebar. */
import clsx from 'clsx'
import { IconDownloadOutlineRegular, IconLoadingOutlineRegular, IconRefreshOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopUpdateView } from '../types.ts'
import { updateCopy } from './DesktopUpdateIndicator.tsx'
import { hasDesktopUpdate } from './desktop-update-source.ts'
import css from './DesktopUpdateCheck.module.css'

/** One carrier status and update callback shared by permanent update controls. */
export interface DesktopUpdateCheckInjected {
  readonly desktopUpdateAvailable: boolean
  readonly activateDesktopUpdate: () => void
  readonly hooks: { readonly desktopUpdate: ObservableSnapshot<DesktopUpdateView> }
}

/** Bound inputs of the permanent General Settings check. */
export type DesktopUpdateCheckProps = InjectFace<DesktopUpdateCheckInjected> & PropsLocale<'settings'>

/**
 * Render a check or discovered-release action with current status in its tooltip.
 * @param props - Carrier state, localized copy, and optional sidebar geometry.
 * @returns A persistent check button, omitted outside Desktop.
 */
export function DesktopUpdateCheck({ desktopUpdateAvailable, activateDesktopUpdate, useDesktopUpdate, t, sidebar, wide = true }:
  DesktopUpdateCheckProps & { readonly sidebar?: boolean; readonly wide?: boolean }) {
  const view = useDesktopUpdate(value => value)
  if (!desktopUpdateAvailable) return null
  const phase = view.presentation?.phase
  const canReopenProgress = phase === 'downloading' || phase === 'verifying'
  const hasUpdate = hasDesktopUpdate(view.presentation)
  const checking = phase === 'checking' || (view.opening && (phase === undefined || phase === 'idle' || (phase === 'error' && !hasUpdate)))
  const disabled = (view.opening && !canReopenProgress) || checking || phase === 'installing'
  const detail = checking ? t('desktop.update.checking')
    : view.failed ? t('desktop.update.checkFailed')
      : view.presentation === undefined ? t('desktop.update.loading')
        : phase === 'idle' ? t('desktop.update.check') : updateCopy(view.presentation, t).detail
  const label = checking ? t('desktop.update.checking')
    : phase === 'downloading' ? t('desktop.update.downloading', { percent: view.presentation?.percent ?? 0 })
      : phase === 'verifying' ? t('desktop.update.verifying')
        : phase === 'installing' ? t('desktop.update.installing')
          : hasUpdate ? t('desktop.update.updateVersion') : t('desktop.update.check')
  const className = clsx(css.button, sidebar && css.sidebar, sidebar && !wide && css.rail)
  return <Tooltip label={detail} side={sidebar ? 'right' : 'top'}>
    <button type="button" className={className} aria-label={label} aria-disabled={disabled}
      onClick={() => { if (!disabled) activateDesktopUpdate() }}>
      {checking || view.opening || canReopenProgress || phase === 'installing' ? <IconLoadingOutlineRegular className={css.spinner} size={sidebar && !wide ? 20 : 16} />
        : hasUpdate ? <IconDownloadOutlineRegular size={sidebar && !wide ? 20 : 16} />
          : <IconRefreshOutlineRegular size={sidebar && !wide ? 20 : 16} />}
      <span className={sidebar && !wide ? css.railLabel : css.label}>{label}</span>
    </button>
  </Tooltip>
}

/**
 * Render the permanent sidebar action above Mobile on every Desktop platform.
 * @param props - Sidebar geometry and framework-bound update controls.
 * @returns The localized manual update check.
 */
export function DesktopUpdateCheckFooter(props: PropsRuntime<'sidebar.footer.action'> & DesktopUpdateCheckProps) {
  return <DesktopUpdateCheck {...props} sidebar />
}
