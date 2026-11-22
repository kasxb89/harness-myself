/** Product-owned Electron state, selected before the single-instance lock is claimed. */
import { copyFileSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** Compare physical browser roots, including not-yet-created children of an existing junction. */
function browserDirectory(path: string): string {
  let current = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      const canonical = join(realpathSync.native(current), ...missing)
      return process.platform === 'win32' ? canonical.toLowerCase() : canonical
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      missing.unshift(basename(current))
      current = parent
    }
  }
}

/** Electron operations available before app.whenReady(). */
export interface DesktopProductApplication {
  readonly isPackaged: boolean
  readonly commandLine: { hasSwitch(name: string): boolean }
  getPath(name: 'appData' | 'userData'): string
  setPath(name: 'userData' | 'sessionData', path: string): void
  setName(name: string): void
}

/** The previous browser location is used only for a bounded, non-secret preference import. */
export interface DesktopProductIdentity {
  readonly userData: string
  readonly legacyUserData: string
  readonly isolated: boolean
}

/**
 * Select the Yunshu browser namespace before Electron acquires its process lock.
 * Explicit test/development user-data paths remain owned by their launchers.
 * @param app - Electron application before readiness or single-instance acquisition.
 * @param environment - Launch environment; qualification journals identify an explicitly isolated test launch.
 * @returns Browser paths; this does not read, copy or renew any account credentials.
 */
export function configureDesktopProductIdentity(
  app: DesktopProductApplication, environment: NodeJS.ProcessEnv,
): DesktopProductIdentity {
  const currentUserData = app.getPath('userData')
  const legacyDefault = join(app.getPath('appData'), '@deepseek-ai', 'dsh-desktop')
  const shared = browserDirectory(currentUserData) === browserDirectory(legacyDefault)
  const isolatedLauncher = app.isPackaged && (app.commandLine.hasSwitch('user-data-dir')
    || (environment.DSH_DESKTOP_UPDATE_JOURNAL_DIR?.trim() ?? '') !== '')
  const explicit = !app.isPackaged || isolatedLauncher && !shared
  const userData = explicit ? currentUserData : join(app.getPath('appData'), 'yunshu-desktop')
  const legacyUserData = explicit ? currentUserData : legacyDefault
  if (!explicit) mkdirSync(userData, { recursive: true, mode: 0o700 })
  if (!explicit && browserDirectory(userData) === browserDirectory(legacyDefault)) {
    throw new Error('云枢窗口目录指向了上游共享目录，请修正目录链接后重试；原数据未被删除。')
  }
  app.setName('云枢')
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  return { userData, legacyUserData, isolated: !explicit }
}

/**
 * Import only previous Yunshu shell preferences once; leave the shared profile, browser cookies and account files alone.
 * The old Yunshu receipt proves product use; an unmarked Harness profile supplies no preferences.
 * @param identity - Selected browser state and previous Electron location.
 * @param legacyProfile - Previous shared desktop profile, inspected only for the Yunshu product receipt.
 */
export function importDesktopShellPreferences(identity: DesktopProductIdentity, legacyProfile: string): void {
  if (!identity.isolated || resolve(identity.userData) === resolve(identity.legacyUserData)) return
  const receipt = join(identity.userData, '.yunshu-shell-preferences-v1.json')
  if (existsSync(receipt)) return
  const productReceipt = join(legacyProfile, '.yunshu-builtin-plugins-v1.json')
  if (existsSync(productReceipt) && lstatSync(productReceipt).isFile() && !lstatSync(productReceipt).isSymbolicLink()) {
    for (const relative of ['keybindings.json', join('desktop', 'settings.json'), 'background-close-confirmed']) {
      const source = join(identity.legacyUserData, relative)
      const target = join(identity.userData, relative)
      if (!existsSync(source) || existsSync(target)) continue
      const info = lstatSync(source)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576) continue
      // The parent of a JSON preference must not redirect this small import into an unrelated tree.
      if (relative === join('desktop', 'settings.json') && lstatSync(join(identity.legacyUserData, 'desktop')).isSymbolicLink()) continue
      if (relative.endsWith('.json')) {
        try { JSON.parse(readFileSync(source, 'utf8')) }
        catch (error) { if (error instanceof SyntaxError) continue; throw error }
      }
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      try { copyFileSync(source, target, constants.COPYFILE_EXCL) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
  }
  writeFileSync(receipt, '{"schemaVersion":1}\n', { flag: 'wx', mode: 0o600 })
}
