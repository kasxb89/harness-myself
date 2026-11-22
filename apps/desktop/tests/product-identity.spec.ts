import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { configureDesktopProductIdentity, importDesktopShellPreferences, type DesktopProductApplication } from '../src/product-identity.ts'
import { resolveDesktopPaths } from '../src/paths.ts'

afterEach(() => { vi.restoreAllMocks() })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'yunshu-product-identity-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const appData = join(root, 'browser')
  const upstream = join(appData, '@deepseek-ai', 'dsh-desktop')
  const home = join(root, 'data')
  const legacyProfile = join(home, 'profiles', 'desktop')
  mkdirSync(upstream, { recursive: true })
  mkdirSync(legacyProfile, { recursive: true })
  const paths = new Map<string, string>([['appData', appData], ['userData', upstream]])
  const app: DesktopProductApplication = {
    isPackaged: true,
    commandLine: { hasSwitch: () => false },
    getPath: name => paths.get(name)!,
    setPath: (name, path) => { paths.set(name, path) },
    setName: vi.fn(),
  }
  return { root, appData, home, legacyProfile, upstream, paths, app }
}

it('separates the default browser/instance and profile configuration without relocating account or chat data', () => {
  const f = fixture()
  const session = join(f.home, 'plugin-data', 'credits', 'session.json')
  const chat = join(f.home, 'sessions', 'existing.jsonl')
  mkdirSync(join(f.home, 'plugin-data', 'credits'), { recursive: true })
  mkdirSync(join(f.home, 'sessions'), { recursive: true })
  writeFileSync(session, 'synthetic existing SID and refresh bytes\n')
  writeFileSync(chat, 'synthetic existing chat and task bytes\n')
  writeFileSync(join(f.legacyProfile, 'cordis.patch.yml'), '- id: foreign-ui\n  disabled: false\n')
  const identity = configureDesktopProductIdentity(f.app, {})
  expect(identity.userData).toBe(join(f.appData, 'yunshu-desktop'))
  expect(f.paths.get('sessionData')).toBe(identity.userData)
  expect(identity.userData).not.toBe(f.upstream)
  expect(resolveDesktopPaths(f.home)).toEqual({
    profile: join(f.home, 'products', 'yunshu', 'profiles', 'desktop'),
    lock: join(f.home, 'products', 'yunshu', 'profiles', 'desktop', 'lock'),
  })
  importDesktopShellPreferences(identity, f.legacyProfile)
  expect(readFileSync(session, 'utf8')).toBe('synthetic existing SID and refresh bytes\n')
  expect(readFileSync(chat, 'utf8')).toBe('synthetic existing chat and task bytes\n')
  expect(readFileSync(join(f.legacyProfile, 'cordis.patch.yml'), 'utf8')).toContain('foreign-ui')
  expect(readdirSync(identity.userData)).toEqual(['.yunshu-shell-preferences-v1.json'])
})

it.each(['development', 'explicit browser', 'qualification'])('respects the isolated %s launcher', (kind) => {
  const f = fixture()
  const app = { ...f.app, isPackaged: kind !== 'development', commandLine: { hasSwitch: () => kind === 'explicit browser' } }
  if (kind !== 'development') f.paths.set('userData', join(f.root, 'explicit-browser'))
  const expected = f.paths.get('userData')!
  const environment = kind === 'qualification' ? { DSH_DESKTOP_UPDATE_JOURNAL_DIR: join(f.root, 'journals') } : {}
  const identity = configureDesktopProductIdentity(app, environment)
  expect(identity).toEqual({ userData: expected, legacyUserData: expected, isolated: false })
  importDesktopShellPreferences(identity, f.legacyProfile)
  expect(readdirSync(f.upstream)).toEqual([])
})

it('does not reuse the shared upstream browser path from an old packaged shortcut', () => {
  const f = fixture()
  const app = { ...f.app, commandLine: { hasSwitch: () => true } }
  expect(configureDesktopProductIdentity(app, {}).userData).toBe(join(f.appData, 'yunshu-desktop'))
})

it.each(['', 'leftover-journal'])('does not let a leftover journal value %j bypass product isolation', (journal) => {
  const f = fixture()
  expect(configureDesktopProductIdentity(f.app, { DSH_DESKTOP_UPDATE_JOURNAL_DIR: journal }).userData)
    .toBe(join(f.appData, 'yunshu-desktop'))
})

it('recognizes the Windows case-insensitive spelling of the shared browser directory', () => {
  const f = fixture()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  f.paths.set('userData', f.upstream.toUpperCase())
  const app = { ...f.app, commandLine: { hasSwitch: () => true } }
  expect(configureDesktopProductIdentity(app, {}).userData).toBe(join(f.appData, 'yunshu-desktop'))
})

it.skipIf(process.platform === 'win32')('recognizes a shared browser alias (requires POSIX link permissions)', () => {
  const f = fixture()
  const alias = join(f.root, 'browser-alias')
  symlinkSync(f.upstream, alias)
  f.paths.set('userData', alias)
  const app = { ...f.app, commandLine: { hasSwitch: () => true } }
  expect(configureDesktopProductIdentity(app, {}).userData).toBe(join(f.appData, 'yunshu-desktop'))
})

it('imports only marked Yunshu shell preferences once and does not overwrite the destination', () => {
  const f = fixture()
  const identity = configureDesktopProductIdentity(f.app, {})
  writeFileSync(join(f.legacyProfile, '.yunshu-builtin-plugins-v1.json'), '{"version":1}\n')
  mkdirSync(join(f.upstream, 'desktop'))
  writeFileSync(join(f.upstream, 'keybindings.json'), '{"custom":"existing"}\n')
  writeFileSync(join(f.upstream, 'desktop', 'settings.json'), '{"updates":{}}\n')
  writeFileSync(join(f.upstream, 'background-close-confirmed'), 'confirmed\n')
  writeFileSync(join(f.upstream, 'Cookies'), 'must never copy cookies\n')
  writeFileSync(join(identity.userData, 'keybindings.json'), '{"custom":"new"}\n')
  importDesktopShellPreferences(identity, f.legacyProfile)
  expect(readFileSync(join(identity.userData, 'keybindings.json'), 'utf8')).toBe('{"custom":"new"}\n')
  expect(readFileSync(join(identity.userData, 'desktop', 'settings.json'), 'utf8')).toBe('{"updates":{}}\n')
  expect(readFileSync(join(identity.userData, 'background-close-confirmed'), 'utf8')).toBe('confirmed\n')
  expect(readdirSync(identity.userData)).not.toContain('Cookies')
  rmSync(join(identity.userData, 'desktop'), { recursive: true })
  importDesktopShellPreferences(identity, f.legacyProfile)
  expect(readdirSync(identity.userData)).not.toContain('desktop')
  expect(readFileSync(join(f.upstream, 'desktop', 'settings.json'), 'utf8')).toBe('{"updates":{}}\n')
})

it('leaves malformed preference JSON in the old tree', () => {
  const f = fixture()
  const identity = configureDesktopProductIdentity(f.app, {})
  writeFileSync(join(f.legacyProfile, '.yunshu-builtin-plugins-v1.json'), '{}')
  writeFileSync(join(f.upstream, 'keybindings.json'), '{broken')
  importDesktopShellPreferences(identity, f.legacyProfile)
  expect(readdirSync(identity.userData)).toEqual(['.yunshu-shell-preferences-v1.json'])
  expect(readFileSync(join(f.upstream, 'keybindings.json'), 'utf8')).toBe('{broken')
})

it.skipIf(process.platform === 'win32')('does not follow a linked preference file (requires POSIX link permissions)', () => {
  const f = fixture()
  const identity = configureDesktopProductIdentity(f.app, {})
  writeFileSync(join(f.legacyProfile, '.yunshu-builtin-plugins-v1.json'), '{}')
  const outside = join(f.root, 'outside')
  writeFileSync(outside, 'outside\n')
  symlinkSync(outside, join(f.upstream, 'background-close-confirmed'))
  importDesktopShellPreferences(identity, f.legacyProfile)
  expect(readdirSync(identity.userData)).toEqual(['.yunshu-shell-preferences-v1.json'])
  expect(readFileSync(outside, 'utf8')).toBe('outside\n')
})
