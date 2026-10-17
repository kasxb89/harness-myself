import { expect, it } from 'vitest'
import { desktopUpdateErrorSummary, presentDesktopUpdate } from '../src/update-presentation.ts'
import { desktopUpdateReadyConfirmation, en, zh } from '../src/locale.ts'
import type { DesktopUpdateState, DshDesktopProductApi } from '../src/ipc.ts'
import type { DesktopUpdateBridge } from '@deepseek-ai/dsh-client-ui-settings-general/types'

it('keeps the Electron preload assignable to the product consumer', () => {
  const assign = (bridge: DshDesktopProductApi['updates']): DesktopUpdateBridge => bridge
  expect(assign).toBeTypeOf('function')
})

it('records version-bound automatic installation guidance for Mac and Windows in both locales', async () => {
  const presentation = presentDesktopUpdate({ phase: 'ready', version: '1.1.0' })
  const locales = [en, zh].map(messages => ({ action: messages.installAndRestart,
    mac: desktopUpdateReadyConfirmation(messages, '1.1.0', 'darwin'),
    windows: desktopUpdateReadyConfirmation(messages, '1.1.0', 'win32'), progress: messages.updateDownloadingDetail }))
  await expect(JSON.stringify({ presentation, locales }, null, 2) + '\n').toMatchFileSnapshot('./expected/automatic-update-confirmation.json')
})

it('records visible ordinary-update states without authorizing downloads or installation', async () => {
  const phases: DesktopUpdateState['phase'][] = ['idle', 'available', 'downloading', 'verifying', 'ready', 'installing', 'error']
  const states = phases.map(phase => presentDesktopUpdate({ phase, version: '0.1.5-rc.2', percent: 58 }))
  await expect(JSON.stringify(states, null, 2) + '\n').toMatchFileSnapshot('./expected/update-status-zh.json')
})

it('keeps raw diagnostics out of error tooltips in both locales', () => {
  for (const messages of [en, zh]) {
    for (const failedOperation of ['check', 'download', 'install'] as const) {
      const state: DesktopUpdateState = { phase: 'error', failedOperation,
        message: 'net::ERR_CONNECTION_CLOSED\nHeaders: private\n' + 'at internal/path\n'.repeat(1000) }
      const presentation = presentDesktopUpdate(state)
      expect(presentation.failure).toBe(`${failedOperation}-network`)
      expect(JSON.stringify(presentation)).not.toContain('Headers')
      expect(JSON.stringify(presentation)).not.toContain('internal/path')
    }
    expect(desktopUpdateErrorSummary({ phase: 'error', failedOperation: 'check', message: '404 NoSuchKey' }, messages))
      .toBe(messages.updateCheckFailed)
    expect(desktopUpdateErrorSummary({ phase: 'error', failedOperation: 'download' }, messages))
      .toBe(messages.updateDownloadFailed)
    expect(desktopUpdateErrorSummary({ phase: 'error', failedOperation: 'install', preparationFailure: 'stop-failed',
      message: 'translated or changed copy', technicalDetails: 'private diagnostic' }, messages)).toBe(messages.updateStopFailed)
    for (const [preparationFailure, expected] of [
      ['tasks-changed', messages.updateTasksChanged], ['tasks-unavailable', messages.updateTasksUnavailable],
    ] as const) {
      expect(desktopUpdateErrorSummary({ phase: 'error', failedOperation: 'install', preparationFailure,
        message: 'different locale' }, messages)).toBe(expected)
    }
    expect(desktopUpdateErrorSummary({ phase: 'error', failedOperation: 'install', message: messages.updateStopFailed }, messages))
      .toBe(messages.updateInstallFailed)
    expect(desktopUpdateErrorSummary({ phase: 'error', failedOperation: 'install', message: 'internal failure',
      technicalDetails: 'private diagnostic' }, messages)).toBe(messages.updateInstallFailed)
  }
})


it('localizes backend discovery failures without treating them as an up-to-date result', async () => {
  const kinds = ['source-unbound', 'source-unavailable', 'source-invalid', 'source-disabled', 'source-target-missing', 'source-unsupported-target', 'source-development'] as const
  const output = kinds.map((sourceFailure) => {
    const state: DesktopUpdateState = { phase: 'error', failedOperation: 'check', sourceFailure, message: 'private remote data' }
    return { presentation: presentDesktopUpdate(state), en: desktopUpdateErrorSummary(state, en), zh: desktopUpdateErrorSummary(state, zh) }
  })
  await expect(JSON.stringify(output, null, 2) + '\n').toMatchFileSnapshot('./expected/update-source-failures.json')
})
