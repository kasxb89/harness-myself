/** Semantic content for the Web-localized optional Desktop status indicator. */
import type { DesktopUpdateFailureKind, DesktopUpdatePresentation, DesktopUpdateState } from './ipc.ts'
import type { DesktopMessages } from './locale.ts'

const NETWORK_FAILURE = /\b(?:ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ETIMEDOUT)\b/u

/**
 * Classify one updater failure for both native and Web-localized summaries.
 * @param state Update failure and its operation.
 * @returns Stable presentation kind without raw diagnostics.
 */
function desktopUpdateFailureKind(state: DesktopUpdateState): DesktopUpdateFailureKind {
  if (state.sourceFailure !== undefined) return state.sourceFailure
  if (state.failedOperation === 'install' && state.preparationFailure !== undefined) return state.preparationFailure
  const operation = state.failedOperation ?? 'install'
  return NETWORK_FAILURE.test(state.message ?? '') ? `${operation}-network` : operation
}

/**
 * Select user-facing error copy independently of raw updater diagnostics.
 * @param state Update failure and its operation.
 * @param messages Selected shell locale.
 * @returns Localized summary suitable for both a dialog and a tooltip.
 */
export function desktopUpdateErrorSummary(state: DesktopUpdateState, messages: DesktopMessages): string {
  const kind = desktopUpdateFailureKind(state)
  const summaries: Readonly<Record<DesktopUpdateFailureKind, string>> = {
    'source-unbound': messages.updateSourceUnbound,
    'source-unavailable': messages.updateSourceUnavailable,
    'source-invalid': messages.updateSourceInvalid,
    'source-disabled': messages.updateSourceDisabled,
    'source-target-missing': messages.updateSourceTargetMissing,
    'source-unsupported-target': messages.updateSourceUnsupportedTarget,
    'source-development': messages.updateSourceDevelopment,
    check: messages.updateCheckFailed,
    'check-network': messages.updateCheckNetworkFailed,
    download: messages.updateDownloadFailed,
    'download-network': messages.updateDownloadNetworkFailed,
    install: messages.updateInstallFailed,
    'install-network': messages.updateInstallNetworkFailed,
    'stop-failed': messages.updateStopFailed,
    'tasks-changed': messages.updateTasksChanged,
    'tasks-unavailable': messages.updateTasksUnavailable,
  }
  return summaries[kind]
}

/**
 * @param state - Main-process updater state.
 * @returns Semantic status without localized copy, diagnostics, or installation controls.
 */
export function presentDesktopUpdate(state: DesktopUpdateState): DesktopUpdatePresentation {
  return {
    phase: state.phase,
    ...(state.version === undefined ? {} : { version: state.version }),
    ...(state.percent === undefined ? {} : { percent: Math.floor(state.percent) }),
    ...(state.phase === 'error' ? { failure: desktopUpdateFailureKind(state) } : {}),
  }
}
