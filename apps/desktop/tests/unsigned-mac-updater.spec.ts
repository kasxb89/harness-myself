import { createHash } from 'node:crypto'
import { createServer, request, type RequestOptions } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppAdapter } from 'electron-updater/out/AppAdapter.js'
import { UnsignedMacUpdater, usesUnsignedMacUpdates } from '../src/unsigned-mac-updater.ts'
import { DesktopUpdateHttpExecutor } from '../src/update-http-executor.ts'
import { DesktopUpdateCoordinator } from '../src/update-coordinator.ts'

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

async function fixture(options: { corruptDownload?: boolean; missingDmg?: boolean; duplicateDmg?: boolean; missingDigest?: boolean } = {}) {
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
  const openInstaller = vi.fn(async (_path: string) => '')
  const updater = new UnsignedMacUpdater(adapter, openInstaller)
  updater.logger = null
  updater.forceDevUpdateConfig = true
  updater.updateConfigPath = configPath
  Object.assign(updater, { httpExecutor: new NodeQualificationExecutor(1000) })
  updater.channel = 'nightly'
  updater.allowDowngrade = false
  updater.setFeedURL({ provider: 'generic', url })
  const beforeRestart = vi.fn(async () => true)
  const manualInstaller = vi.fn(async (version: string) => { await updater.openDownloadedInstaller(version); return true })
  const coordinator = new DesktopUpdateCoordinator(state => state, beforeRestart, updater, () => true, () => adapter.version,
    undefined, async () => ({ url, channel: 'nightly' }), manualInstaller)
  cleanups.push(async () => { coordinator.dispose() })
  return { updater, coordinator, quit, adapter, bytes, beforeRestart, manualInstaller, openInstaller,
    installerRequests: () => installerRequests }
}

it('selects manual Mac updates only for an explicit installed unsigned manifest', () => {
  expect(usesUnsignedMacUpdates({ dshDesktopUnsigned: true }, true, 'darwin')).toBe(true)
  for (const manifest of [{}, null, { dshDesktopUnsigned: false }, { dshDesktopUnsigned: 'true' }]) {
    expect(usesUnsignedMacUpdates(manifest, true, 'darwin')).toBe(false)
  }
  expect(usesUnsignedMacUpdates({ dshDesktopUnsigned: true }, false, 'darwin')).toBe(false)
  expect(usesUnsignedMacUpdates({ dshDesktopUnsigned: true }, true, 'win32')).toBe(false)
})

it('checks a real generic feed, verifies and opens the downloaded DMG without stopping or quitting the app', async () => {
  const f = await fixture()
  expect(await f.coordinator.check()).toEqual({ phase: 'available', version: '1.1.0-rc.2', installationMode: 'manual' })
  expect(f.openInstaller).not.toHaveBeenCalled()
  expect(await f.coordinator.download('1.1.0-rc.2')).toEqual({ phase: 'ready', version: '1.1.0-rc.2', installationMode: 'manual' })
  expect(f.openInstaller).not.toHaveBeenCalled()
  expect(await f.coordinator.install('1.1.0-rc.2')).toEqual({ phase: 'ready', version: '1.1.0-rc.2', installationMode: 'manual' })
  const path = f.openInstaller.mock.calls[0]![0]
  expect(path.endsWith('.dmg')).toBe(true)
  expect(await readFile(path)).toEqual(f.bytes)
  expect(f.beforeRestart).not.toHaveBeenCalled()
  expect(f.quit).not.toHaveBeenCalled()
  await f.coordinator.install('1.1.0-rc.2')
  expect(f.openInstaller).toHaveBeenCalledTimes(2)
  expect(() => { f.updater.quitAndInstall() }).toThrow('require opening the installer')
})

it('rejects download corruption through the pinned electron-updater SHA512 verifier', async () => {
  const f = await fixture({ corruptDownload: true })
  await f.coordinator.check()
  expect(await f.coordinator.download('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'download' })
  expect(f.openInstaller).not.toHaveBeenCalled()
  expect(f.beforeRestart).not.toHaveBeenCalled()
})

it('rejects an HTTP installer URL in an installed build before requesting its bytes', async () => {
  const f = await fixture()
  await f.coordinator.check()
  Object.assign(f.adapter, { isPackaged: true })
  expect(await f.coordinator.download('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'download' })
  expect(f.installerRequests()).toBe(0)
  expect(f.openInstaller).not.toHaveBeenCalled()
})

it('reuses the verified download cache across updater instances without downloading bytes twice', async () => {
  const f = await fixture()
  await f.coordinator.check()
  await f.coordinator.download('1.1.0-rc.2')
  expect(f.installerRequests()).toBe(1)
  const next = new UnsignedMacUpdater(f.adapter, f.openInstaller)
  next.logger = null
  next.forceDevUpdateConfig = true
  next.updateConfigPath = f.adapter.appUpdateConfigPath
  Object.assign(next, { httpExecutor: new NodeQualificationExecutor(1000) })
  const configuration = JSON.parse(await readFile(f.adapter.appUpdateConfigPath, 'utf8')) as { url: string }
  next.setFeedURL({ provider: 'generic', url: configuration.url })
  await next.checkForUpdates()
  await next.downloadUpdate()
  await next.openDownloadedInstaller('1.1.0-rc.2')
  expect(f.installerRequests()).toBe(1)
  expect(f.openInstaller).toHaveBeenCalledOnce()
})

it.each([{ missingDmg: true }, { duplicateDmg: true }, { missingDigest: true }])('rejects an incomplete or ambiguous DMG feed: %j', async (options) => {
  const f = await fixture(options)
  await f.coordinator.check()
  expect(await f.coordinator.download('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'download' })
  expect(f.openInstaller).not.toHaveBeenCalled()
})

it('rechecks retained bytes before opening and allows an explicit safe re-download after tampering', async () => {
  const f = await fixture()
  await f.coordinator.check()
  await f.coordinator.download('1.1.0-rc.2')
  await f.coordinator.install('1.1.0-rc.2')
  const path = f.openInstaller.mock.calls[0]![0]
  f.openInstaller.mockClear()
  await writeFile(path, 'tampered installer')
  expect(await f.coordinator.install('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'download' })
  expect(f.openInstaller).not.toHaveBeenCalled()
  expect(await f.coordinator.download('1.1.0-rc.2')).toMatchObject({ phase: 'ready' })
  await f.coordinator.install('1.1.0-rc.2')
  expect(await readFile(path)).toEqual(f.bytes)
  expect(f.openInstaller).toHaveBeenCalledOnce()
  expect(f.beforeRestart).not.toHaveBeenCalled()
})

it('rejects replaced symlinks and a different confirmed version before any native handoff', async () => {
  const f = await fixture()
  await f.coordinator.check()
  const files = await f.updater.downloadUpdate()
  await expect(f.updater.openDownloadedInstaller('9.9.9')).rejects.toThrow('not ready')
  const path = files[0]!
  await writeFile(`${path}.real`, f.bytes)
  await unlink(path)
  await symlink(`${path}.real`, path)
  await expect(f.updater.openDownloadedInstaller('1.1.0-rc.2')).rejects.toThrow('verification failed')
  expect(f.openInstaller).not.toHaveBeenCalled()
})

it('keeps a failed native opener retryable without stopping the Host', async () => {
  const f = await fixture()
  await f.coordinator.check()
  await f.coordinator.download('1.1.0-rc.2')
  f.openInstaller.mockResolvedValueOnce('Could not open disk image')
  expect(await f.coordinator.install('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'install' })
  expect(await f.coordinator.install('1.1.0-rc.2')).toMatchObject({ phase: 'ready' })
  expect(f.beforeRestart).not.toHaveBeenCalled()
  expect(f.quit).not.toHaveBeenCalled()
})
