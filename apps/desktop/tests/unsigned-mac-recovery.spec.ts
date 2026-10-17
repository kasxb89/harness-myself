import { expect, it } from 'vitest'
import { en, zh } from '../src/locale.ts'
import { desktopUnsignedInstallRecoveryOptions } from '../src/update-presentation.ts'

it('reports actual recovery outcomes without claiming a nonexistent backup', async () => {
  const outcomes = ['rolled-back', 'launch-unconfirmed', 'backup-failed', 'unreadable'] as const
  const recorded = [en, zh].map(messages => outcomes.map(status => ({ status,
    options: desktopUnsignedInstallRecoveryOptions(status, messages) })))
  await expect(`${JSON.stringify(recorded, null, 2)}\n`).toMatchFileSnapshot('./expected/mac-update-recovery.json')
})

it('keeps confirmed success and cancellation silent and offers records only for a readable receipt', () => {
  expect(desktopUnsignedInstallRecoveryOptions('succeeded', en)).toBeUndefined()
  expect(desktopUnsignedInstallRecoveryOptions('cancelled', en)).toBeUndefined()
  expect(desktopUnsignedInstallRecoveryOptions('unreadable', en)?.buttons).toEqual([en.updateAcknowledge])
  for (const status of ['target-in-use', 'staged-app-invalid', 'backup-failed', 'rollback-failed', 'rollback-launch-failed'] as const) {
    expect(desktopUnsignedInstallRecoveryOptions(status, en)).toMatchObject({ message: en.updateIncompleteTitle,
      detail: en.updateIncompleteDetail, buttons: [en.updateAcknowledge, en.updateShowRecoveryFiles] })
  }
})
