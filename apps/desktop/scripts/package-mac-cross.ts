/** Build private, manually installed macOS ZIPs on Windows without publication credentials. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { preparePrimaryRuntime } from '../../../scripts/primary-runtime/prepare.ts'
import { CLIENT_BUILD_RECORD_PATH, officialClientBuildEnvironment, readClientBuildRecord } from '../../../scripts/client-build-environment.ts'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { validateDesktopBuildVersion } from './desktop-build-version.mjs'
import { createElectronBuilderConfig } from './electron-builder-config.mjs'
import { localMacOSPackageEnvironment } from './desktop-package-environment.mjs'
import { createPackagingRun } from './packaging-run.mjs'
import { readDesktopBuildCommit, desktopBuildCommitEnvironment } from './desktop-build-commit.mjs'
import { resolveUnsignedDesktopUpdateConfig } from './desktop-update-config-origin.mjs'
import { writeMacOSAppUpdateConfig } from './macos-app-update-config.mjs'
import { prepareDesktopCli } from './prepare-cli.ts'
import { macCrossExecutable, sealMacCrossRuntime, writeMacCrossResources, writeMacCrossZip } from './mac-cross-layout.ts'
import { macCrossRuntimeKey, recordMacCrossRuntime, reuseMacCrossRuntime, seedMacCrossDependencyCache, verifyMacCrossShellVersions } from './mac-cross-cache.ts'

const appRoot = resolve(import.meta.dirname, '..')
const repository = resolve(appRoot, '../..')
const require = createRequire(import.meta.url)
type Arch = 'arm64' | 'x64'
interface Tools { zig: string; rcodesign: string; sdk: string }
interface Options { root: string; arch: Arch; version: string | undefined; prepareOnly: boolean }
const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const manifest = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

/** Require a D-drive root; the cross path never borrows the host user's default caches. */
export function crossBuildOptions(argv: readonly string[], platform = process.platform, arch = process.arch): Options {
  const { values } = parseArgs({ args: [...argv].filter(value => value !== '--'), options: {
    root: { type: 'string' }, arch: { type: 'string' }, 'build-version': { type: 'string' },
    'prepare-only': { type: 'boolean', default: false },
  } })
  if (platform !== 'win32' || arch !== 'x64') throw new Error('macOS cross package: Windows x64 is required')
  if (values.arch !== 'arm64' && values.arch !== 'x64') throw new Error('macOS cross package: --arch must be arm64 or x64')
  const root = values.root?.replace(/[\\/]+$/u, '')
  if (root === undefined || !/^D:[\\/][^\\/]/iu.test(root) || root.includes('..')) {
    throw new Error('macOS cross package: --root must be a non-root absolute D-drive directory')
  }
  if (!values['prepare-only'] && !values['build-version']) {
    throw new Error('macOS cross package: a complete user-confirmed --build-version is required')
  }
  return { root, arch: values.arch, version: values['build-version'], prepareOnly: values['prepare-only'] }
}

/** Remove all upload, Apple account, runtime override, and platform signing credentials. */
export function privateMacCrossEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const credentialPrefixes = [
    /^(?:(?:WIN_)?CSC_|APPLE_|CONVEYOR_(?:SIGNING|ROOT_KEY|BILLING)|DOWNLOAD_(?:TEST|PROD)_COS_|ALIYUN_|OSS_|COS_)/iu,
    /^DSH_DESKTOP_(?:WINDOWS_|MACOS_(?:SIGNING|TEAM|NOTAR)|UPLOAD_)/iu,
  ]
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !(
    credentialPrefixes.some(prefix => prefix.test(name))
    || ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'DSH_DESKTOP_BUILD_VERSION'].includes(name)
  )))
}

/** Use the same unsigned identity and update settings as the native local Mac packaging entry. */
export function macCrossLocalEnvironment(environment: NodeJS.ProcessEnv, sourceRoot?: string): NodeJS.ProcessEnv {
  return privateMacCrossEnvironment(localMacOSPackageEnvironment(environment, sourceRoot))
}

/** Serialize root properties after loading the Electron configuration library. */
export function macCrossConveyorText(configuration: Readonly<Record<string, unknown>>): string {
  const properties = Object.entries(configuration).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value, null, 2)}`)
  return `include required("/stdlib/electron/electron.conf")\n${properties.join('\n')}\n`
}

/** Keep the full product version in its manifest/plist while using Conveyor's portable package syntax internally. */
export function macCrossConveyorVersion(version: string): string {
  return version.replaceAll('-', '~')
}

/** macOS keeps a numeric build field; the full confirmed version remains in the manifest and short version field. */
export function macCrossBundleVersion(version: string): string {
  const numeric = /^\d+\.\d+\.\d+/u.exec(version)?.[0]
  if (numeric === undefined) throw new Error('macOS cross package: invalid numeric bundle version')
  return numeric
}

/** Prime executables and complete enclosed bundles for OS/signature checks, then append data without replacing signed bytes. */
export function copyMacCrossPayload(source: string, destination: string, phase: 'native' | 'data'): number {
  let copied = 0
  cpSync(source, destination, { recursive: true, filter: (from, to) => {
    const status = lstatSync(from)
    if (status.isDirectory()) return true
    if (!status.isFile()) throw new Error('macOS cross package: payload must contain materialized regular files')
    const fd = openSync(from, 'r')
    let native: boolean
    try {
      const magic = Buffer.alloc(4)
      native = macCrossExecutable(magic.subarray(0, readSync(fd, magic, 0, magic.length, 0)))
    } finally { closeSync(fd) }
    const parts = relative(source, from).split(/[\\/]/u)
    const nativeGroup = native || parts.some(part => /\.(?:app|framework|xpc)$/iu.test(part))
    if (phase === 'native' && !nativeGroup) return false
    if (phase === 'data') {
      if (existsSync(to)) {
        if (!native && !parts.includes('_CodeSignature') && digest(from) !== digest(to)) {
          throw new Error(`macOS cross package: conflicting payload data ${from}`)
        }
        return false
      }
      if (nativeGroup) throw new Error(`macOS cross package: native or enclosed bundle input was omitted from Conveyor checks: ${from}`)
    }
    copied++
    return true
  } })
  return copied
}

/** Keep standalone Host CLI support paths compatible with the ordinary application-directory layout. */
export function linkMacCrossRuntimeSupport(resources: string): void {
  if (!existsSync(join(resources, 'runtime/primary-runtime/runtime.json'))) {
    throw new Error('macOS cross package: primary runtime is absent before creating the CLI support alias')
  }
  const alias = join(resources, 'app/runtime')
  try {
    if (!lstatSync(alias).isSymbolicLink() || readlinkSync(alias).replaceAll('\\', '/') !== '../runtime') {
      throw new Error('macOS cross package: refusing an unexpected CLI support path')
    }
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  symlinkSync('../runtime', alias, 'dir')
}

/** Bind immutable package caches to current source bytes and the actual official build record. */
function sourceKey(git: string): string {
  const names = execFileSync(git, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repository, encoding: 'utf8' })
    .split('\0').filter(name => name !== '' && !name.startsWith('apps/desktop/scripts/')
      && !name.startsWith('apps/desktop/tests/') && !/^apps\/desktop\/README(?:\.zh)?\.md$/u.test(name)
      && name !== 'apps/desktop/README.i18n.yaml').sort()
  const hash = createHash('sha256').update(readFileSync(join(repository, CLIENT_BUILD_RECORD_PATH)))
  for (const name of names) hash.update(name).update('\0').update(readFileSync(join(repository, name))).update('\0')
  return hash.digest('hex')
}

/** Verify every reusable package instead of trusting the presence of a directory. */
function verifiedCohort(root: string, key: string): boolean {
  try {
    const record = manifest(join(root, 'cohort.json'))
    return record.key === key && Array.isArray(record.files) && record.files.length > 0
      && record.files.every((file: { path: string; sha256: string }) =>
        /^(?:dsh|vendor|landlock)\/[a-zA-Z0-9._-]+\.tgz$/u.test(file.path) && digest(join(root, ...file.path.split('/'))) === file.sha256)
  } catch { return false }
}

/** Resolve Electron's embedded Node from its official release metadata without executing target code. */
async function electronNodeVersion(root: string, version: string): Promise<string> {
  const directory = join(root, 'cache/electron-release-metadata')
  const file = join(directory, `${version}.json`)
  let release: Record<string, unknown>
  if (existsSync(file)) release = manifest(file)
  else {
    const response = await fetch('https://releases.electronjs.org/releases.json', { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`macOS cross package: official Electron metadata returned ${String(response.status)}`)
    const values: unknown = await response.json()
    if (!Array.isArray(values)) throw new Error('macOS cross package: invalid official Electron metadata')
    release = values.find((value: unknown) => typeof value === 'object' && value !== null
      && (value as Record<string, unknown>).version === version) as Record<string, unknown>
    if (release === undefined) throw new Error(`macOS cross package: official Electron ${version} release metadata is absent`)
    if (typeof release.node !== 'string' || !/^\d+\.\d+\.\d+$/u.test(release.node)) throw new Error('macOS cross package: invalid embedded Node version')
    mkdirSync(directory, { recursive: true })
    writeFileSync(file, `${JSON.stringify(release, null, 2)}\n`, { flag: 'wx' })
  }
  if (release.version !== version || typeof release.node !== 'string' || !/^\d+\.\d+\.\d+$/u.test(release.node)) {
    throw new Error('macOS cross package: cached official Electron metadata is invalid')
  }
  return release.node
}

async function main(): Promise<void> {
  const options = crossBuildOptions(process.argv.slice(2))
  const { root, arch } = options
  if (!resolve(repository).toLowerCase().startsWith(`${resolve(root).toLowerCase()}\\`)) {
    throw new Error('macOS cross package: source checkout must also reside inside the D-drive build root')
  }
  const baseVersion = manifest(join(appRoot, 'package.json')).version as string
  const version = options.version === undefined ? baseVersion : validateDesktopBuildVersion(options.version, baseVersion)
  const tools = manifest(join(root, 'control', 'cross-tools.json')) as unknown as Tools
  for (const path of Object.values(tools).filter(value => typeof value === 'string' && /^[A-Z]:[\\/]/iu.test(value))) {
    if (!resolve(path).toLowerCase().startsWith(`${resolve(root).toLowerCase()}\\`)) throw new Error('macOS cross package: tool escaped D-drive build root')
  }
  const node = join(root, 'tools/node/node.exe')
  const pnpm = join(root, 'tools/pnpm/bin/pnpm.cjs')
  const git = join(root, 'tools/git/cmd/git.exe')
  const target = arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  const paths = desktopTargetBuildPaths(target)
  const environment: NodeJS.ProcessEnv = {
    ...macCrossLocalEnvironment(process.env, appRoot), ...desktopBuildCommitEnvironment(readDesktopBuildCommit(repository)),
    DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_TARGET_PLATFORM: 'darwin', DSH_DESKTOP_TARGET_ARCH: arch,
    DSH_DESKTOP_BUILD_VERSION: version,
    DSH_DESKTOP_DEPENDENCY_CACHE_DIR: join(root, 'cache/dependencies/v1'),
    HOME: join(root, 'profile'), USERPROFILE: join(root, 'profile'),
    APPDATA: join(root, 'profile/AppData/Roaming'), LOCALAPPDATA: join(root, 'profile/AppData/Local'),
    TEMP: join(root, 'temp'), TMP: join(root, 'temp'),
    npm_config_store_dir: join(root, 'cache/pnpm/store'), npm_config_cache: join(root, 'cache/npm'),
    XDG_CONFIG_HOME: join(root, 'profile/.config'),
    XDG_CACHE_HOME: join(root, 'cache'), PNPM_HOME: join(root, 'tools/pnpm'),
    ELECTRON_CACHE: join(root, 'cache/electron'), ELECTRON_BUILDER_CACHE: join(root, 'cache/electron-builder'),
    ZIG_LOCAL_CACHE_DIR: join(root, 'cache/zig-local'), ZIG_GLOBAL_CACHE_DIR: join(root, 'cache/zig-global'),
    CONVEYOR_JVM_OPTIONS: '-Xmx1536m',
    PATH: [dirname(node), join(root, 'tools/bin'), join(root, 'tools/git/cmd'), process.env.PATH].join(';'),
  }
  for (const name of Object.keys(process.env)) if (!(name in environment)) delete process.env[name]
  Object.assign(process.env, environment)
  const run = createPackagingRun(join(appRoot, '.desktop-build/cross-runs'), { target, unsigned: true, directory: false, prepareOnly: options.prepareOnly })
  environment.DSH_DESKTOP_PACKAGING_RUN_DIR = run.directory
  process.env.DSH_DESKTOP_PACKAGING_RUN_DIR = run.directory
  let lock: number | undefined
  let success = false
  const lockPath = join(root, 'control/mac-cross-build.lock')
  const execute = async (stage: string, command: string, args: string[], cwd = repository, timeoutMs = 900_000): Promise<void> => {
    await run.run(stage, command, args, { cwd, env: environment, timeoutMs })
  }
  const packageManager = async (stage: string, args: string[], cwd = repository): Promise<void> =>
    execute(stage, node, [pnpm, ...args], cwd)
  try {
    lock = openSync(lockPath, 'wx')
    writeFileSync(lock, `${JSON.stringify({ pid: process.pid, target, createdAt: new Date().toISOString() })}\n`)
    readClientBuildRecord(repository, officialClientBuildEnvironment(repository))
    const configuration = createElectronBuilderConfig(environment, 'win32', 'x64')
    const key = sourceKey(git)
    const common = join(root, 'cache/mac-cross-packages', key)
    if (!verifiedCohort(common, key)) {
      mkdirSync(dirname(common), { recursive: true })
      const temporary = mkdtempSync(join(dirname(common), `${key.slice(0, 12)}-`))
      try {
        await packageManager('pack:dsh', ['run', 'release:pack', '--family', 'dsh', '--out', join(temporary, 'dsh'), '--concurrency', '2'])
        await packageManager('pack:host', ['--dir', 'apps/desktop-host', 'pack', '--pack-destination', join(temporary, 'dsh')])
        await packageManager('pack:vendor', ['run', 'release:pack', '--family', 'vendor', '--out', join(temporary, 'vendor'), '--concurrency', '2'])
        await packageManager('compile:native-entry', ['--dir', 'native/system', 'run', 'build:ts'])
        mkdirSync(join(temporary, 'landlock'), { recursive: true })
        await packageManager('pack:native-entry', ['--dir', 'native/system/packages/entry', 'pack', '--pack-destination', join(temporary, 'landlock')])
        if (sourceKey(git) !== key) throw new Error('macOS cross package: source changed while assembling package cache')
        const files = ['dsh', 'vendor', 'landlock'].flatMap(family => readdirSync(join(temporary, family))
          .filter(name => name.endsWith('.tgz')).map(name => ({ path: `${family}/${name}`, sha256: digest(join(temporary, family, name)) })))
        writeFileSync(join(temporary, 'cohort.json'), `${JSON.stringify({ key, files }, null, 2)}\n`)
        if (existsSync(common)) throw new Error('macOS cross package: invalid existing cache; preserve it for diagnosis')
        renameSync(temporary, common)
      } finally { rmSync(temporary, { recursive: true, force: true }) }
    }
    for (const [family, destination] of [['dsh', paths.packedDsh], ['vendor', paths.packedVendor], ['landlock', paths.packedLandlock]]) {
      rmSync(destination!, { recursive: true, force: true })
      cpSync(join(common, family!), destination!, { recursive: true })
    }

    const native = join(paths.root, 'cross-native')
    mkdirSync(native, { recursive: true })
    const nodeVersion = manifest(join(repository, 'scripts/primary-runtime/lock.json')).nodeVersion as string
    const headers = join(root, `tools/node-headers-${nodeVersion}/include/node`)
    const targetTriple = arch === 'arm64' ? 'aarch64-macos.13.0' : 'x86_64-macos.13.0'
    const sourceFiles = [
      ['link-entry', 'apps/desktop/cli/link-entry.c'],
      ['unsigned-mac-swap', 'apps/desktop/resources/unsigned-mac-swap.c'],
      ['system.node', 'native/system/packages/entry/src/flock.c'],
    ] as const
    for (const [name, source] of sourceFiles) {
      const args = ['cc', '-target', targetTriple, '-isysroot', tools.sdk, '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror']
      if (name === 'system.node') args.push('-shared', '-fPIC', '-fvisibility=hidden', '-DNAPI_VERSION=8', '-I', headers, '-Wl,-undefined,dynamic_lookup')
      args.push(join(repository, source), '-o', join(native, name))
      await execute(`compile:${name}`, tools.zig, args)
      await execute(`sign:${name}`, tools.rcodesign, ['sign', join(native, name)])
    }

    rmSync(paths.runtime, { recursive: true, force: true })
    mkdirSync(paths.runtime, { recursive: true })
    await preparePrimaryRuntime({ target, output: paths.runtime, cache: paths.downloads, version: baseVersion })
    const primary = manifest(join(paths.runtime, 'primary-runtime/runtime.json'))
    const electronVersion = (require('electron/package.json') as { version: string }).version
    const embeddedNodeVersion = await electronNodeVersion(root, electronVersion)
    // Electron's embedded Node is release-wide; require equality with the independently locked interpreter.
    if (embeddedNodeVersion !== nodeVersion) throw new Error('macOS cross package: Electron and primary Node version mismatch')
    cpSync(join(import.meta.dirname, 'node-bin'), join(paths.runtime, 'bin'), { recursive: true })
    prepareDesktopCli(join(paths.runtime, 'cli'), 'darwin')
    copyFileSync(join(native, 'link-entry'), join(paths.runtime, 'cli/link-entry'))
    copyFileSync(join(appRoot, 'lib/command-manager-entry.js'), join(paths.runtime, 'cli/command-manager.js'))
    copyFileSync(join(import.meta.dirname, 'command-path.ps1'), join(paths.runtime, 'cli/command-path.ps1'))
    writeFileSync(join(paths.runtime, 'versions.json'), `${JSON.stringify({ schemaVersion: 1, node: embeddedNodeVersion, pnpm: primary.pnpm }, null, 2)}\n`)
    const runtimeKey = macCrossRuntimeKey({ repository, git, cohortKey: key, target,
      versions: join(paths.runtime, 'versions.json'), native: join(native, 'system.node'), environment })
    const reused = await reuseMacCrossRuntime(paths.root, runtimeKey, baseVersion, arch)
    if (!reused) {
      console.log(`macOS cross package: dependency cache ${JSON.stringify(seedMacCrossDependencyCache({
        root, target, environment, nodeVersion: embeddedNodeVersion, pnpmVersion: primary.pnpm as string,
      }))}`)
      await packageManager('prepare:package-set', ['run', 'prepare:packages'], appRoot)
      await packageManager('prepare:dsh', ['run', 'prepare:dsh', '--cross-macos', '--defer-runtime-smoke'], appRoot)
      const system = join(paths.dsh, 'node_modules/@deepseek-ai', `node-addon-system-darwin-${arch}`, 'bin/system.node')
      if (!existsSync(dirname(system))) throw new Error('macOS cross package: required target native package is absent')
      copyFileSync(join(native, 'system.node'), system)
      sealMacCrossRuntime(paths.dsh, arch)
      await recordMacCrossRuntime(paths.root, runtimeKey, baseVersion, arch)
    }
    const prepared = { schemaVersion: 1, target, sourceKey: key, runtimeReused: reused,
      nativeExecution: 'NOT_RUN_REQUIRES_MAC', publicUploads: 0, paidCalls: 0 }
    writeFileSync(join(paths.root, 'cross-preparation.json'), `${JSON.stringify(prepared, null, 2)}\n`)
    if (options.prepareOnly) { success = true; console.log(JSON.stringify(prepared)); return }

    const shell = join(paths.root, 'cross-shell')
    rmSync(shell, { recursive: true, force: true })
    await packageManager('prepare:shell-dependencies', ['exec', 'tsx', 'scripts/mac-cross-shell.ts', '--output', shell], appRoot)
    const resources = join(paths.root, 'cross-resources')
    rmSync(resources, { recursive: true, force: true })
    mkdirSync(join(resources, 'app'), { recursive: true })
    cpSync(join(shell, 'node_modules'), join(resources, 'app/node_modules'), { recursive: true, dereference: true,
      filter: path => !['.pnpm', '.bin'].includes(basename(path)) && !basename(path).endsWith('.tsbuildinfo') })
    copyFileSync(join(shell, 'package.json'), join(resources, 'app/package.json'))
    verifyMacCrossShellVersions(join(resources, 'app'), appRoot)
    cpSync(join(appRoot, 'lib'), join(resources, 'app/lib'), { recursive: true })
    cpSync(join(appRoot, 'renderer'), join(resources, 'app/renderer'), { recursive: true })
    // Conveyor checks and signs all native inputs, while avoiding repeated Java scans of tens of thousands of data files.
    const nativeInputs = copyMacCrossPayload(paths.dsh, join(resources, 'app/dsh'), 'native')
      + copyMacCrossPayload(paths.runtime, join(resources, 'runtime'), 'native')
    const shellManifest: Record<string, unknown> = { ...manifest(join(shell, 'package.json')), ...configuration.extraMetadata, version }
    delete shellManifest.scripts
    delete shellManifest.devDependencies
    writeFileSync(join(resources, 'app/package.json'), `${JSON.stringify(shellManifest, null, 2)}\n`)
    copyFileSync(join(appRoot, 'resources/icon-windows.png'), join(resources, 'icon.png'))
    copyFileSync(join(native, 'unsigned-mac-swap'), join(resources, 'unsigned-mac-swap'))
    await writeMacOSAppUpdateConfig(resources, resolveUnsignedDesktopUpdateConfig(environment, 'darwin', arch), 'yunshu-updater')
    const conveyor = join(paths.root, 'cross-conveyor')
    mkdirSync(conveyor, { recursive: true })
    copyFileSync(join(resources, 'app/package.json'), join(conveyor, 'package.json'))
    mkdirSync(join(conveyor, 'lib'), { recursive: true })
    copyFileSync(join(resources, 'app/lib/main.js'), join(conveyor, 'lib/main.js'))
    copyFileSync(join(appRoot, 'resources/icon-macos.png'), join(conveyor, 'icon.png'))
    const entitlementsName = `entitlements-${digest(join(import.meta.dirname, 'macos-entitlements.plist'))}.plist`
    copyFileSync(join(import.meta.dirname, 'macos-entitlements.plist'), join(conveyor, entitlementsName))
    rmSync(join(resources, 'app/package.json'))
    rmSync(join(resources, 'app/lib/main.js'))
    const resourceTar = join(paths.root, 'cross-resources.tar')
    await writeMacCrossResources(resources, resourceTar)
    const fileUrl = (path: string): string => pathToFileURL(path).href
    const electronFilename = `electron-v${electronVersion}-darwin-${arch}.zip`
    const checksums = manifest(join(dirname(require.resolve('electron/package.json')), 'checksums.json'))
    const electronArchive = join(root, 'downloads/electron', `v${electronVersion}`, electronFilename)
    if (digest(electronArchive) !== checksums[electronFilename]) throw new Error('macOS cross package: official Electron checksum mismatch')
    if (digest(join(root, 'downloads/Sparkle-2.9.6-hydraulic.tar.xz')) !== '21f2304ae6261014e3cf708d182b38993ce4a606895650538f1822d7f81faf51') {
      throw new Error('macOS cross package: pinned Sparkle checksum mismatch')
    }
    const conf = {
      conveyor: { 'compatibility-level': 22 },
      app: {
        fsname: 'yunshu', 'display-name': '云枢', 'rdns-name': configuration.appId, version: macCrossConveyorVersion(version),
        site: { 'base-url': 'localhost:52951' }, machines: [arch === 'arm64' ? 'mac.aarch64' : 'mac.amd64'], updates: 'none',
        electron: { version: electronVersion, asar: false, prune: false, 'download-base-url': fileUrl(join(root, 'downloads/electron/')) },
        inputs: ['package.json', { from: 'lib/main.js', to: 'lib/main.js' }], icons: ['icon.png'],
        mac: {
          sign: { scripts: { app: `"${tools.rcodesign.replaceAll('\\', '/')}" sign --entitlements-xml-file ${entitlementsName} $BUNDLE` } },
          'info-plist': { LSMinimumSystemVersion: '15.0', CFBundleShortVersionString: version,
            CFBundleVersion: macCrossBundleVersion(version),
            NSMicrophoneUsageDescription: '云枢 uses your microphone to transcribe speech into message drafts.',
            CFBundleLocalizations: ['en', 'zh_CN'], CFBundleURLTypes: [{ CFBundleURLName: '云枢', CFBundleURLSchemes: ['dsh'] }] },
          'bundle-extras': [{ from: fileUrl(resourceTar), to: 'Resources' }],
          sparkle: [{ from: fileUrl(join(root, 'downloads/Sparkle-2.9.6-hydraulic.tar.xz')), remap: [
            'Sparkle.framework/**', '-Sparkle.framework/**/._*', '-Sparkle.framework/Headers', '-Sparkle.framework/PrivateHeaders', '-Sparkle.framework/Modules',
            '-Sparkle.framework/Versions/B/Headers/**', '-Sparkle.framework/Versions/B/PrivateHeaders/**', '-Sparkle.framework/Versions/B/Modules/**',
            '-Sparkle.framework/Versions/B/_CodeSignature/**', '-Sparkle.framework/Versions/B/Updater.app/_CodeSignature/**',
            '-Sparkle.framework/Versions/B/XPCServices/org.sparkle-project.Downloader.xpc/Contents/_CodeSignature/**',
            '-Sparkle.framework/Versions/B/XPCServices/org.sparkle-project.InstallerLauncher.xpc/Contents/_CodeSignature/**', '-**',
          ] }],
        },
      },
    }
    writeFileSync(join(conveyor, 'conveyor.conf'), macCrossConveyorText(conf))
    const output = join(paths.root, 'cross-app')
    rmSync(output, { recursive: true, force: true })
    await execute('assemble:mac-app', join(root, 'tools/conveyor-22.3/bin/conveyor.exe'), [
      '--console=plain', '--agree-to-license=1', '--parallelism=1', `--cache-dir=${join(root, 'cache/conveyor')}`, '--cache-limit=30',
      `--conf-dir=${join(root, 'profile/conveyor')}`, `--data-dir=${join(root, 'profile/conveyor-data')}`, `--logs-dir=${join(root, 'logs/conveyor')}`,
      'make', 'mac-app', `--output-dir=${output}`,
    ], conveyor, 1_800_000)
    const findApps = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap(entry =>
      !entry.isDirectory() ? [] : entry.name.endsWith('.app') ? [join(root, entry.name)] : findApps(join(root, entry.name)))
    const apps = findApps(output)
    if (apps.length !== 1) throw new Error('macOS cross package: expected exactly one outer application')
    const application = apps[0]!
    const finalResources = join(application, 'Contents/Resources')
    const dataInputs = copyMacCrossPayload(paths.dsh, join(finalResources, 'app/dsh'), 'data')
      + copyMacCrossPayload(paths.runtime, join(finalResources, 'runtime'), 'data')
    console.log(`macOS cross package: retained ${String(nativeInputs)} checked native/script/bundle inputs and appended ${String(dataInputs)} data files`)
    linkMacCrossRuntimeSupport(finalResources)
    sealMacCrossRuntime(join(finalResources, 'app/dsh'), arch)
    // --shallow in rcodesign 0.29 preserves the already sealed nested Mach-O bytes.
    await execute('sign:outer-app', tools.rcodesign, ['sign', '--shallow', '--entitlements-xml-file', 'apps/desktop/scripts/macos-entitlements.plist', application])
    const artifacts = join(root, 'artifacts/mac-cross-local', version)
    mkdirSync(artifacts, { recursive: true })
    const zip = join(artifacts, `yunshu-${version}-mac-${arch}-local.zip`)
    const archive = await writeMacCrossZip(application, zip)
    const record = { ...prepared, version, artifact: zip, ...archive, format: 'ZIP_MANUAL_INSTALL', notarized: false,
      status: 'BUILT_NATIVE_ACCEPTANCE_REQUIRED', macOSMinimum: '15.0', nativeInputs, dataInputs,
      updaterArtifactFormat: 'DMG', builtAt: new Date().toISOString() }
    writeFileSync(`${zip}.json`, `${JSON.stringify(record, null, 2)}\n`)
    console.log(JSON.stringify(record))
    success = true
  } finally {
    if (lock !== undefined) { closeSync(lock); rmSync(lockPath) }
    run.finish(success)
  }
}

if (import.meta.main) await main()
