import { createHash } from 'node:crypto'
import { createServer, request, type RequestOptions } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppAdapter } from 'electron-updater/out/AppAdapter.js'
import { UnsignedMacUpdater, usesUnsignedMacUpdates } from '../src/unsigned-mac-updater.ts'
import { DesktopUpdateHttpExecutor } from '../src/update-http-executor.ts'
import { DesktopUpdateCoordinator } from '../src/update-coordinator.ts'
import type { prepareUnsignedMacInstall, UnsignedMacInstallRequest } from '../src/unsigned-mac-install.ts'

/** Only Electron networking is replaced: actual updater provider, metadata, cache, digest and events run. */
class NodeQualificationExecutor extends DesktopUpdateHttpExecutor {
  override createRequest(options: RequestOptions, callback: Parameters<DesktopUpdateHttpExecutor['createRequest']>[1]):
  ReturnType<DesktopUpdateHttpExecutor['createRequest']> {
    const outgoing = request(options)
    outgoing.on('response', callback)
    return Object.assign(outgoing, { chunkedEncoding: false,
      getUploadProgress: () => ({ active: false, started: false, current: 0, total: 0 }),
      followRedirect: () => { throw new Error('qualification fixture does not redirect') } }) as ReturnType<DesktopUpdateHttpExecutor['createRequest']>
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(options: { corruptDownload?: boolean; missingDmg?: boolean; duplicateDmg?: boolean; missingDigest?: boolean } = {},
  createUpdater: (adapter: AppAdapter, prepare: typeof prepareUnsignedMacInstall) => UnsignedMacUpdater =
    (adapter, prepare) => new UnsignedMacUpdater(adapter, prepare)) {
  const root = await mkdtemp(join(tmpdir(), 'yunshu-unsigned-update-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const bytes = Buffer.from('unsigned macOS DMG qualification fixture')
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  let installerRequests = 0
  const server = createServer((incoming, response) => {
    if (incoming.url?.includes('.yml') === true) {
      const filename = options.missingDmg ? 'Yunshu-mac-arm64.zip' : 'Yunshu-mac-arm64.dmg'
      const file = { url: filename, sha512: options.missingDigest ? undefined : sha512, size: bytes.length }
      response.end(JSON.stringify({ version: '1.1.0-rc.2', releaseDate: '2026-10-18T00:00:00.000Z',
        files: options.duplicateDmg ? [file, { ...file, url: 'Yunshu-mac-x64.dmg' }] : [file], path: filename, sha512 }))
    } else {
      installerRequests++
      response.setHeader('Content-Length', bytes.length)
      response.end(options.corruptDownload ? Buffer.alloc(bytes.length) : bytes)
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => {
    if (error === undefined) resolve()
    else reject(error)
  })))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('qualification server did not bind')
  const url = `http://127.0.0.1:${address.port}/mac-arm64/`
  await mkdir(join(root, 'user-data'))
  const configPath = join(root, 'dev-app-update.yml')
  await writeFile(configPath, JSON.stringify({ provider: 'generic', url, updaterCacheDirName: 'yunshu-update-test' }))
  const quit = vi.fn()
  const adapter: AppAdapter = { version: '1.0.0', name: 'Yunshu', isPackaged: false,
    appUpdateConfigPath: configPath, userDataPath: join(root, 'user-data'), baseCachePath: root,
    whenReady: async () => {}, relaunch: vi.fn(), quit, onQuit: vi.fn() }
  const launch = vi.fn(async () => {})
  const dispose = vi.fn(async () => {})
  const prepareInstaller = vi.fn(async (_request: UnsignedMacInstallRequest) => ({ launch, dispose }))
  const updater = createUpdater(adapter, prepareInstaller)
  updater.logger = null
  updater.forceDevUpdateConfig = true
  updater.updateConfigPath = configPath
  Object.assign(updater, { httpExecutor: new NodeQualificationExecutor(1000) })
  updater.channel = 'nightly'
  updater.allowDowngrade = false
  updater.setFeedURL({ provider: 'generic', url })
  const beforeRestart = vi.fn(async () => true)
  const installUpdate = vi.fn(async (version: string) => { await updater.installPreparedUpdate(version) })
  const coordinator = new DesktopUpdateCoordinator(state => state, beforeRestart, updater, () => true, () => adapter.version,
    undefined, async () => ({ url, channel: 'nightly' }), installUpdate)
  cleanups.push(async () => { coordinator.dispose(); await updater.disposePreparedUpdate() })
  return { updater, coordinator, quit, adapter, bytes, beforeRestart, installUpdate, prepareInstaller, launch, dispose,
    installerRequests: () => installerRequests }
}

it('selects automatic Mac updates only for an explicit installed unsigned manifest', () => {
  expect(usesUnsignedMacUpdates({ dshDesktopUnsigned: true }, true, 'darwin')).toBe(true)
  for (const manifest of [{}, null, { dshDesktopUnsigned: false }, { dshDesktopUnsigned: 'true' }]) {
    expect(usesUnsignedMacUpdates(manifest, true, 'darwin')).toBe(false)
  }
  expect(usesUnsignedMacUpdates({ dshDesktopUnsigned: true }, false, 'darwin')).toBe(false)
  expect(usesUnsignedMacUpdates({ dshDesktopUnsigned: true }, true, 'win32')).toBe(false)
})

it('stages the real generic download before readiness and launches only after authorized task shutdown', async () => {
  const f = await fixture()
  expect(await f.coordinator.check()).toEqual({ phase: 'available', version: '1.1.0-rc.2' })
  expect(f.prepareInstaller).not.toHaveBeenCalled()
  expect(await f.coordinator.download('1.1.0-rc.2')).toEqual({ phase: 'ready', version: '1.1.0-rc.2' })
  const request = f.prepareInstaller.mock.calls[0]![0]
  expect(await readFile(request.dmgPath)).toEqual(f.bytes)
  expect(request.version).toBe('1.1.0-rc.2')
  expect(request.currentVersion).toBe('1.0.0')
  expect(f.launch).not.toHaveBeenCalled()
  expect(f.beforeRestart).not.toHaveBeenCalled()
  expect(await f.coordinator.install('1.1.0-rc.2')).toEqual({ phase: 'installing', version: '1.1.0-rc.2' })
  expect(f.launch).toHaveBeenCalledOnce()
  expect(f.quit).toHaveBeenCalledOnce()
  expect(f.beforeRestart.mock.invocationCallOrder[0]).toBeLessThan(f.launch.mock.invocationCallOrder[0]!)
  expect(f.launch.mock.invocationCallOrder[0]).toBeLessThan(f.quit.mock.invocationCallOrder[0]!)
  expect(() => { f.updater.quitAndInstall() }).toThrow('controlled restart handoff')
})

it('rejects download corruption through the pinned electron-updater SHA512 verifier', async () => {
  const f = await fixture({ corruptDownload: true })
  await f.coordinator.check()
  expect(await f.coordinator.download('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'download' })
  expect(f.prepareInstaller).not.toHaveBeenCalled()
  expect(f.beforeRestart).not.toHaveBeenCalled()
})

it('rejects an HTTP installer URL in an installed build before requesting its bytes', async () => {
  const f = await fixture()
  await f.coordinator.check()
  Object.assign(f.adapter, { isPackaged: true })
  expect(await f.coordinator.download('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'download' })
  expect(f.installerRequests()).toBe(0)
  expect(f.prepareInstaller).not.toHaveBeenCalled()
})

it('reuses verified download bytes while preparing each independent updater instance', async () => {
  const f = await fixture()
  await f.coordinator.check()
  await f.coordinator.download('1.1.0-rc.2')
  const next = new UnsignedMacUpdater(f.adapter, f.prepareInstaller)
  cleanups.push(() => next.disposePreparedUpdate())
  next.logger = null
  next.forceDevUpdateConfig = true
  next.updateConfigPath = f.adapter.appUpdateConfigPath
  Object.assign(next, { httpExecutor: new NodeQualificationExecutor(1000) })
  const configuration = JSON.parse(await readFile(f.adapter.appUpdateConfigPath, 'utf8')) as { url: string }
  next.setFeedURL({ provider: 'generic', url: configuration.url })
  await next.checkForUpdates()
  await next.downloadUpdate()
  expect(f.installerRequests()).toBe(1)
  expect(f.prepareInstaller).toHaveBeenCalledTimes(2)
  expect(f.launch).not.toHaveBeenCalled()
})

it.each([{ missingDmg: true }, { duplicateDmg: true }, { missingDigest: true }])('rejects an incomplete or ambiguous DMG feed: %j', async (options) => {
  const f = await fixture(options)
  await f.coordinator.check()
  expect(await f.coordinator.download('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'download' })
  expect(f.prepareInstaller).not.toHaveBeenCalled()
})

it('refuses a wrong version before any helper handoff', async () => {
  const f = await fixture()
  await f.coordinator.check()
  await f.coordinator.download('1.1.0-rc.2')
  await expect(f.updater.installPreparedUpdate('9.9.9')).rejects.toThrow('not ready')
  expect(f.launch).not.toHaveBeenCalled()
  expect(f.quit).not.toHaveBeenCalled()
})

it('keeps the current app alive when helper launch fails after the restart guard', async () => {
  const f = await fixture()
  await f.coordinator.check()
  await f.coordinator.download('1.1.0-rc.2')
  f.launch.mockRejectedValueOnce(new Error('helper could not start'))
  expect(await f.coordinator.install('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'install' })
  expect(f.beforeRestart).toHaveBeenCalledOnce()
  expect(f.coordinator.hasPreparedUpdate).toBe(false)
  expect(f.dispose).toHaveBeenCalledOnce()
  expect(f.quit).not.toHaveBeenCalled()
})

it('joins verification on quit and never starts staging after that quit', async () => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  class VerificationGateUpdater extends UnsignedMacUpdater {
    protected override async verifyDownloadedInstaller(version: string): Promise<void> {
      entered.resolve(undefined)
      await release.promise
      await super.verifyDownloadedInstaller(version)
    }
  }
  const f = await fixture({}, (adapter, prepare) => new VerificationGateUpdater(adapter, prepare))
  await f.coordinator.check()
  const downloading = f.coordinator.download('1.1.0-rc.2')
  await entered.promise
  let stopped = false
  const disposing = f.updater.disposePreparedUpdate().then(() => { stopped = true })
  try {
    await Promise.resolve()
    expect(stopped).toBe(false)
  } finally { release.resolve(undefined) }
  expect(await downloading).toMatchObject({ phase: 'error', failedOperation: 'download' })
  await disposing
  expect(f.prepareInstaller).not.toHaveBeenCalled()
  expect(f.launch).not.toHaveBeenCalled()
})

it('joins and disposes in-flight staging before ordinary quit completes', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.prepareInstaller.mockImplementationOnce(async () => {
    entered.resolve(undefined)
    await release.promise
    return { launch: f.launch, dispose: f.dispose }
  })
  await f.coordinator.check()
  const downloading = f.coordinator.download('1.1.0-rc.2')
  await entered.promise
  let stopped = false
  const disposing = f.updater.disposePreparedUpdate().then(() => { stopped = true })
  try {
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(f.prepareInstaller.mock.calls[0]?.[0].signal?.aborted).toBe(true)
  } finally { release.resolve(undefined) }
  expect(await downloading).toMatchObject({ phase: 'error', failedOperation: 'download' })
  await disposing
  expect(f.dispose).toHaveBeenCalled()
  expect(f.launch).not.toHaveBeenCalled()
  expect(f.quit).not.toHaveBeenCalled()
})
