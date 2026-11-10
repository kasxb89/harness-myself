/** Build a customer-specific Kylin x64 package without touching ordinary release feeds. */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { readClientBuildRecord, officialClientBuildEnvironment } from '../../../scripts/client-build-environment.ts'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { validateDesktopBuildVersion } from './desktop-build-version.mjs'
import { readDesktopBuildCommit, resolveDesktopBuildCommit } from './desktop-build-commit.mjs'
import { verifyDesktopRuntime, readDesktopRuntime } from '../src/runtime-tree.ts'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'

const appRoot = resolve(import.meta.dirname, '..')
const repository = resolve(appRoot, '../..')
const paths = desktopTargetBuildPaths('linux-x64')

async function run(args: readonly string[], env: NodeJS.ProcessEnv, cwd = repository): Promise<void> {
  const pnpm = process.env.npm_execpath
  if (pnpm === undefined) throw new Error('Kylin package: invoke through pnpm run')
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(process.execPath, [pnpm, ...args], { cwd, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolveRun()
      : reject(new Error(`Kylin package: ${args.join(' ')} failed (${String(code ?? signal)})`)))
  })
}

async function main(): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Kylin package requires a Linux x64 build environment')
  const { values } = parseArgs({ options: {
    'build-version': { type: 'string' },
    'prepared-libraries': { type: 'boolean', default: false },
  } })
  if (values['build-version'] === undefined) throw new Error('Kylin package: confirmed --build-version is required')
  const base = (JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { version: string }).version
  const version = validateDesktopBuildVersion(values['build-version'], base)
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD|OSS|COS|APPLE|CSC_/iu.test(key)))
  Object.assign(env, { DSH_DESKTOP_TARGET_PLATFORM: 'linux', DSH_DESKTOP_TARGET_ARCH: 'x64',
    DSH_DESKTOP_LINUX_PRIVATE: '1', DSH_DESKTOP_APP_ID: 'com.deepseek.harness',
    DSH_DESKTOP_BUILD_VERSION: version, DSH_TELEMETRY_DISABLED: '1' })
  const source = resolveDesktopBuildCommit(process.env) ?? readDesktopBuildCommit(repository)
  Object.assign(env, {
    DSH_DESKTOP_BUILD_COMMIT: source.commit, DSH_DESKTOP_BUILD_DIRTY: source.dirty ? '1' : '0',
  })
  if (values['prepared-libraries']) readClientBuildRecord(repository, officialClientBuildEnvironment(repository, env))
  else await run(['run', 'build:official'], env)
  await run(['run', 'release:pack', '--family', 'dsh', '--out', paths.packedDsh, '--concurrency', '2'], env)
  await run(['--dir', 'apps/desktop-host', 'pack', '--pack-destination', paths.packedDsh], env)
  await run(['run', 'release:pack', '--family', 'vendor', '--out', paths.packedVendor, '--concurrency', '2'], env)
  mkdirSync(paths.packedLandlock, { recursive: true })
  await run(['--dir', 'native/system', 'run', 'build:ts'], env)
  await run(['--dir', 'native/system/packages/entry', 'pack', '--pack-destination', paths.packedLandlock], env)
  await run(['run', 'prepare:runtime'], env, appRoot)
  await run(['run', 'prepare:packages'], env, appRoot)
  await run(['run', 'prepare:dsh'], env, appRoot)
  await run(['exec', 'electron-builder', '--config', 'scripts/kylin-builder.config.mjs', '--linux', '--x64',
    '--publish', 'never'], env, appRoot)
  const resources = join(paths.artifacts, 'linux-unpacked', 'resources')
  const executable = join(paths.artifacts, 'linux-unpacked', 'yunshu')
  const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version,
    { platform: 'linux', arch: 'x64' })
  await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), executable, join(resources, 'runtime'), descriptor)
  writeFileSync(join(paths.artifacts, 'kylin-private-release.json'), JSON.stringify({
    schemaVersion: 1, target: 'linux-x64', distribution: 'kylin-v10sp1-2503-x64', version,
    ...source, automaticUpdates: false, sharedFeedsModified: false,
  }, null, 2) + '\n')
}

if (import.meta.main) await main()
