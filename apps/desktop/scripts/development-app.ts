/** macOS development bundle that loads the current workspace through Electron. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Product backend base used when the development launcher has no explicit override. */
export const DEFAULT_DESKTOP_UPDATE_CONFIG_ORIGIN = 'https://8.133.202.230/harness'

/** Workspace and runtime settings captured for Launch Services cold starts. */
export interface DevelopmentAppOptions {
  readonly electron: string
  readonly appRoot: string
  readonly directory: string
  readonly home: string
  readonly userData: string
  readonly primaryRuntimeDirectory: string
  readonly mainPort: number
  readonly rendererPort: number
  readonly hostPort: number
  readonly openDevtools: string
  readonly updateConfigOrigin?: string
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

function missingLegacyRegistration(error: unknown, bundle: string): boolean {
  if (!(error instanceof Error) || !('status' in error) || error.status !== 1) return false
  const output = (value: unknown): string => Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'string' ? value : ''
  const diagnostics = [output('stdout' in error ? error.stdout : undefined), output('stderr' in error ? error.stderr : undefined)]
    .map(value => value.trim()).filter(value => value !== '')
  const prefix = `failed to scan ${bundle}:`
  return diagnostics.length > 0 && diagnostics.every(value => value.startsWith(prefix)
    && /^-10814\s+from spotlight$/u.test(value.slice(prefix.length).trim()))
}

/**
 * Prepare and register a disposable .app without changing the installed Electron package.
 * @param options - Current workspace, Electron binary, and private development locations.
 * @returns executable used by the supported desktop development launcher.
 */
export function prepareDevelopmentApp(options: DevelopmentAppOptions): string {
  const source = dirname(dirname(dirname(options.electron)))
  const bundle = join(options.directory, '云枢.app')
  const executable = join(bundle, 'Contents', 'MacOS', 'HarnessDev')
  const stamp = join(bundle, 'Contents', 'Resources', 'dsh-development.json')
  const launcher = developmentLauncher(options, bundle)
  const icon = join(options.appRoot, 'resources', 'icon-macos.icns')
  const brand = { name: '云枢', icon: createHash('sha256').update(readFileSync(icon)).digest('hex') }
  const identity = JSON.stringify({ ...options, launcher, brand,
    plist: readFileSync(join(source, 'Contents', 'Info.plist'), 'utf8') })
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== identity) {
    rmSync(bundle, { recursive: true, force: true })
    execFileSync('/usr/bin/ditto', [source, bundle])
    const plist = join(bundle, 'Contents', 'Info.plist')
    const values = {
      CFBundleIdentifier: `com.deepseek.harness.dev.${createHash('sha256').update(options.appRoot).digest('hex').slice(0, 12)}`,
      CFBundleName: brand.name,
      CFBundleDisplayName: brand.name,
      CFBundleExecutable: 'HarnessDev',
      CFBundleIconFile: 'Yunshu.icns',
      CFBundleURLTypes: [{ CFBundleURLName: brand.name, CFBundleURLSchemes: ['dsh'], CFBundleTypeRole: 'Viewer' }],
    }
    copyFileSync(icon, join(bundle, 'Contents', 'Resources', 'Yunshu.icns'))
    for (const [key, value] of Object.entries(values)) {
      execFileSync('/usr/bin/plutil', ['-replace', key, '-json', JSON.stringify(value), plist])
    }
    writeFileSync(executable, launcher, { mode: 0o755 })
    writeFileSync(stamp, identity, { mode: 0o600 })
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'pipe' })
  }
  execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', bundle])
  for (const previousName of ['Harness Dev.app', '智澍科技.app']) {
    const previous = join(options.directory, previousName)
    if (existsSync(join(previous, 'Contents', 'Resources', 'dsh-development.json'))) {
      try {
        execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', previous])
      } catch (error) {
        // Launch Services -10814 means the obsolete bundle has no valid registration to remove.
        if (!missingLegacyRegistration(error, previous)) throw error
      }
    }
  }
  return executable
}

/**
 * Create the development executable used by both the CLI and Launch Services.
 * @param options - Persisted development locations and debugging settings.
 * @param bundle - Generated application bundle.
 * @returns shell program with literal arguments and environment values.
 */
export function developmentLauncher(options: DevelopmentAppOptions, bundle: string): string {
  const environment = {
    DSH_HOME: options.home,
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: options.primaryRuntimeDirectory,
    DSH_DESKTOP_DEV_APP: '1',
    DSH_DESKTOP_UPDATE_CONFIG_ORIGIN: options.updateConfigOrigin ?? DEFAULT_DESKTOP_UPDATE_CONFIG_ORIGIN,
    DSH_DESKTOP_HOST_INSPECT_PORT: String(options.hostPort),
    DSH_DESKTOP_OPEN_DEVTOOLS: options.openDevtools,
    ELECTRON_ENABLE_LOGGING: '1',
  }
  const args = [
    join(bundle, 'Contents', 'MacOS', 'Electron'),
    `--inspect=127.0.0.1:${String(options.mainPort)}`,
    `--remote-debugging-port=${String(options.rendererPort)}`,
    `--user-data-dir=${options.userData}`,
    options.appRoot,
  ]
  return [
    '#!/bin/sh',
    ...Object.entries(environment).map(([key, value]) => `export ${key}=${quote(value)}`),
    `cd ${quote(options.appRoot)}`,
    `exec ${args.map(quote).join(' ')} "$@"`,
    '',
  ].join('\n')
}
