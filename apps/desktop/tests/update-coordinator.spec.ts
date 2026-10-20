import { afterEach, describe, expect, it, vi } from 'vitest'
import { NsisUpdater, type ProgressInfo, type UpdateDownloadedEvent } from 'electron-updater'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { parseDesktopRelease } from '../src/release.ts'
import type { DesktopUpdateState } from '../src/ipc.ts'
import { DesktopUpdatePreparationError } from '../src/update-error.ts'
import { zh } from '../src/locale.ts'
import { DesktopUpdateSourceError } from '../src/update-source.ts'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events')
  return { NsisUpdater: class extends EventEmitter {},
    default: { autoUpdater: { autoDownload: true, autoInstallOnAppQuit: true } } }
})

const { DesktopUpdateCoordinator } = await import('../src/update-coordinator.ts')

describe('desktop release metadata', () => {
  it('accepts one exact release identity for Electron and dsh', () => {
    expect(parseDesktopRelease({
      schemaVersion: 1,
      version: '1.2.3',
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: '24.17.0',
      pnpmVersion: '11.7.0',
    })).toEqual({
      schemaVersion: 1,
      version: '1.2.3',
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: '24.17.0',
      pnpmVersion: '11.7.0',
    })
  })

  it('rejects invalid versions and unsupported host protocols', () => {
    const base = {
      schemaVersion: 1,
      version: '1.2.3',
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: '24.17.0',
      pnpmVersion: '11.7.0',
    }
    expect(() => parseDesktopRelease({ ...base, version: 'latest' })).toThrow(/invalid desktop release metadata/u)
    expect(() => parseDesktopRelease({ ...base, hostProtocolVersion: 999 })).toThrow(/invalid desktop release metadata/u)
  })
})

const coordinators: InstanceType<typeof DesktopUpdateCoordinator>[] = []
afterEach(() => { for (const item of coordinators.splice(0)) item.dispose() })

function progress(percent: number, delta = percent): ProgressInfo {
  return { percent, total: 100, transferred: percent, delta, bytesPerSecond: 100 }
}

function downloadedEvent(): UpdateDownloadedEvent {
  const sha512 = Buffer.alloc(64).toString('base64')
  return { version: '1.1.0-rc.2', downloadedFile: 'verified-package',
    files: [{ url: 'verified-package', sha512 }], releaseDate: '2026-10-16T00:00:00.000Z',
    // oxlint-disable-next-line typescript/no-deprecated -- electron-updater requires both legacy fields on UpdateDownloadedEvent.
    path: 'verified-package', sha512 }
}

function fixture(installUpdate?: (version: string) => Promise<void>, requiredVersion?: () => string | undefined) {
  const events = new NsisUpdater()
  const checkForUpdates = vi.fn(async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: '1.1.0-rc.2' },
  }))
  const downloadUpdate = vi.fn(async () => {
    events.emit('download-progress', progress(58))
    events.emit('download-progress', progress(100, 42))
    events.emit('update-downloaded', downloadedEvent())
    return ['verified-package']
  })
  const quitAndInstall = vi.fn()
  const beforeRestart = vi.fn(async () => true)
  const downloadResult = vi.fn()
  const states: DesktopUpdateState[] = []
  const setFeedURL = vi.fn()
  const resolveSource = vi.fn(async () => ({ url: 'https://updates.example.com/mac-arm64/', channel: 'nightly' as const }))
  const updater = Object.assign(events, { checkForUpdates, downloadUpdate, quitAndInstall, setFeedURL })
  const coordinator = new DesktopUpdateCoordinator(
    (state) => { states.push(state); return state },
    beforeRestart, updater, () => true, () => '1.1.0-alpha.1', downloadResult, resolveSource, installUpdate, requiredVersion,
  )
  coordinators.push(coordinator)
  return { coordinator, updater, resolveSource, setFeedURL, events, states, checkForUpdates, downloadUpdate, quitAndInstall,
    beforeRestart, downloadResult }
}

describe('desktop update coordinator', () => {
  it('refuses a feed rollback below a previously confirmed required release', async () => {
    const f = fixture(undefined, () => '1.1.0-rc.3')
    await expect(f.coordinator.check(true)).resolves.toMatchObject({ phase: 'error', failedOperation: 'check',
      message: 'desktop update: feed version is older than the required update' })
    await expect(f.coordinator.download('1.1.0-rc.2')).rejects.toThrow('no checked update')
    expect(f.downloadUpdate).not.toHaveBeenCalled()
    expect(f.quitAndInstall).not.toHaveBeenCalled()
  })
  it('awaits shared task shutdown before handing off an independent platform installer', async () => {
    const installUpdate = vi.fn(async (_version: string) => {})
    const f = fixture(installUpdate)
    const shutdown = Promise.withResolvers<boolean>()
    f.beforeRestart.mockImplementationOnce(() => shutdown.promise)
    await f.coordinator.check()
    await f.coordinator.download('1.1.0-rc.2')
    const installing = f.coordinator.install('1.1.0-rc.2')
    await vi.waitFor(() => { expect(f.beforeRestart).toHaveBeenCalledOnce() })
    expect(installUpdate).not.toHaveBeenCalled()
    shutdown.resolve(true)
    expect(await installing).toEqual({ phase: 'installing', version: '1.1.0-rc.2' })
    expect(installUpdate).toHaveBeenCalledExactlyOnceWith('1.1.0-rc.2')
    expect(f.quitAndInstall).not.toHaveBeenCalled()
  })
  it('keeps the staged platform installer ready when restart is cancelled', async () => {
    const installUpdate = vi.fn(async (_version: string) => {})
    const f = fixture(installUpdate)
    f.beforeRestart.mockResolvedValueOnce(false)
    await f.coordinator.check()
    await f.coordinator.download('1.1.0-rc.2')
    expect(await f.coordinator.install('1.1.0-rc.2')).toEqual({ phase: 'ready', version: '1.1.0-rc.2' })
    expect(installUpdate).not.toHaveBeenCalled()
    expect(f.quitAndInstall).not.toHaveBeenCalled()
  })
  it('reports helper handoff failure as installation failure after task shutdown', async () => {
    const installUpdate = vi.fn(async (_version: string) => { throw new Error('helper readiness unavailable') })
    const f = fixture(installUpdate)
    await f.coordinator.check()
    await f.coordinator.download('1.1.0-rc.2')
    expect(await f.coordinator.install('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'install' })
    expect(f.beforeRestart).toHaveBeenCalledOnce()
    expect(f.quitAndInstall).not.toHaveBeenCalled()
  })
  it('keeps safe preparation diagnostics separate and clears them on an explicit retry', async () => {
    const f = fixture()
    await f.coordinator.check()
    await f.coordinator.download('1.1.0-rc.2')
    f.beforeRestart.mockRejectedValueOnce(new DesktopUpdatePreparationError('stop-failed', zh.updateStopFailed, 'exit 0; shutdown acknowledged false'))
    expect(await f.coordinator.install('1.1.0-rc.2')).toEqual({ phase: 'error', version: '1.1.0-rc.2',
      failedOperation: 'install', preparationFailure: 'stop-failed', message: zh.updateStopFailed,
      technicalDetails: 'exit 0; shutdown acknowledged false' })
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    f.beforeRestart.mockResolvedValueOnce(false)
    expect(await f.coordinator.install('1.1.0-rc.2')).toEqual({ phase: 'ready', version: '1.1.0-rc.2' })
    expect(f.quitAndInstall).not.toHaveBeenCalled()
  })

  it('retains an asynchronous installer failure after quitAndInstall returns', async () => {
    const f = fixture()
    await f.coordinator.check()
    await f.coordinator.download('1.1.0-rc.2')
    await f.coordinator.install('1.1.0-rc.2')
    f.events.emit('error', new Error('installer could not start'))
    expect(f.coordinator.state).toMatchObject({ phase: 'error', failedOperation: 'install', message: 'installer could not start' })
  })

  it('waits for platform preparation after its downloaded event and rejects stale download approval', async () => {
    const f = fixture()
    const prepared = Promise.withResolvers<string[]>()
    f.downloadUpdate.mockImplementationOnce(async () => {
      f.events.emit('update-downloaded', downloadedEvent())
      return prepared.promise
    })
    await f.coordinator.check()
    await expect(f.coordinator.download('1.1.0-rc.1')).rejects.toThrow(/stale/u)
    const downloading = f.coordinator.download('1.1.0-rc.2')
    await Promise.resolve()
    await Promise.resolve()
    try {
      expect(f.coordinator.state.phase).not.toBe('ready')
      await expect(f.coordinator.install('1.1.0-rc.2')).rejects.toThrow(/not ready/u)
    } finally { prepared.resolve(['verified']); await downloading }
    expect(f.coordinator.state.phase).toBe('ready')
  })

  it('consumes late updater errors until an in-flight check settles after disposal', async () => {
    const f = fixture()
    const checked = Promise.withResolvers<{ isUpdateAvailable: boolean; updateInfo: { version: string } }>()
    f.checkForUpdates.mockImplementation(() => checked.promise)
    const pending = f.coordinator.check()
    await vi.waitFor(() => { expect(f.checkForUpdates).toHaveBeenCalledOnce() })
    f.coordinator.dispose()
    expect(() => f.events.emit('error', new Error('late network failure'))).not.toThrow()
    checked.reject(new Error('offline'))
    await pending
    await Promise.resolve()
    expect(f.events.listenerCount('error')).toBe(0)
  })

  it('checks, downloads on demand, then requires separate installation approval', async () => {
    const f = fixture()
    await f.coordinator.check()
    expect(f.downloadUpdate).not.toHaveBeenCalled()
    await expect(f.coordinator.install('1.1.0-rc.2')).rejects.toThrow(/not ready/u)
    await f.coordinator.download('1.1.0-rc.2')
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    expect(f.beforeRestart).not.toHaveBeenCalled()
    expect(f.coordinator.state).toEqual({ phase: 'ready', version: '1.1.0-rc.2' })
    await f.coordinator.install('1.1.0-rc.2')
    expect(f.beforeRestart).toHaveBeenCalledOnce()
    expect(f.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(f.states.map(state => state.phase)).toEqual([
      'available', 'downloading', 'downloading', 'verifying', 'ready', 'installing',
    ])
    expect(f.updater).toMatchObject({
      autoDownload: false, autoInstallOnAppQuit: false, channel: 'nightly',
      allowPrerelease: true, allowDowngrade: false,
    })
  })

  it('joins checks and downloads without retargeting a prepared release', async () => {
    const f = fixture()
    const checked = Promise.withResolvers<{ isUpdateAvailable: boolean; updateInfo: { version: string } }>()
    f.checkForUpdates.mockImplementation(() => checked.promise)
    const checking = f.coordinator.check()
    const manual = f.coordinator.check(true)
    const firstDownload = f.coordinator.download('1.1.0-rc.2')
    const secondDownload = f.coordinator.download('1.1.0-rc.2')
    checked.resolve({ isUpdateAvailable: true, updateInfo: { version: '1.1.0-rc.2' } })
    await Promise.all([checking, manual, firstDownload, secondDownload])
    expect(f.checkForUpdates).toHaveBeenCalledOnce()
    expect(f.downloadUpdate).toHaveBeenCalledOnce()
    await f.coordinator.check(true)
    expect(f.checkForUpdates).toHaveBeenCalledOnce()
    await expect(f.coordinator.install('1.2.0')).rejects.toThrow(/not ready/u)
  })

  it('keeps automatic failures silent and exposes a manual caller joining the same check', async () => {
    const f = fixture()
    f.checkForUpdates.mockRejectedValue(new Error('offline'))
    expect(await f.coordinator.check()).toMatchObject({ phase: 'error', failedOperation: 'check' })
    expect(f.states).toEqual([])
    await Promise.all([f.coordinator.check(), f.coordinator.check(true)])
    expect(f.states).toEqual([expect.objectContaining({ phase: 'error', failedOperation: 'check' })])
    expect(f.downloadUpdate).not.toHaveBeenCalled()
  })

  it.each(['1.0.0', '1.1.0-alpha.1', 'invalid'])('does not download or install inapplicable version %s', async (version) => {
    const f = fixture()
    f.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version } })
    await f.coordinator.check()
    await expect(f.coordinator.download('1.1.0-rc.2')).rejects.toThrow(/no checked update/u)
    expect(f.downloadUpdate).not.toHaveBeenCalled()
  })

  it('retains retry state after download failure and never equates 100 percent with readiness', async () => {
    const f = fixture()
    f.downloadUpdate.mockImplementationOnce(async () => {
      f.events.emit('download-progress', progress(100))
      throw new Error('signature rejected')
    })
    await f.coordinator.check()
    expect(await f.coordinator.download('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'download' })
    await expect(f.coordinator.install('1.1.0-rc.2')).rejects.toThrow(/not ready/u)
    await f.coordinator.download('1.1.0-rc.2')
    expect(f.coordinator.state.phase).toBe('ready')
    expect(f.quitAndInstall).not.toHaveBeenCalled()
  })

  it('refuses handoff after failed task preparation while retaining the prepared package', async () => {
    const f = fixture()
    f.beforeRestart.mockRejectedValueOnce(new Error('tasks could not stop'))
    await f.coordinator.check()
    await f.coordinator.download('1.1.0-rc.2')
    expect(await f.coordinator.install('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'install' })
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    await f.coordinator.install('1.1.0-rc.2')
    expect(f.downloadUpdate).toHaveBeenCalledOnce()
    expect(f.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('does not publish late check completion after disposal', async () => {
    const f = fixture()
    const checked = Promise.withResolvers<{ isUpdateAvailable: boolean; updateInfo: { version: string } }>()
    f.checkForUpdates.mockImplementation(() => checked.promise)
    const pending = f.coordinator.check()
    f.coordinator.dispose()
    checked.resolve({ isUpdateAvailable: true, updateInfo: { version: '1.1.0-rc.2' } })
    await pending
    expect(f.states).toEqual([])
    expect(f.events.listenerCount('download-progress')).toBe(0)
  })
})


it('reports one download result when callers share an operation and none for cached readiness', async () => {
  const f = fixture()
  await f.coordinator.check()
  await Promise.all([f.coordinator.download('1.1.0-rc.2'), f.coordinator.download('1.1.0-rc.2')])
  await f.coordinator.download('1.1.0-rc.2')
  expect(f.downloadResult).toHaveBeenCalledExactlyOnceWith(true)
})


it.each([new DesktopUpdatePreparationError('stop-failed', 'private diagnostic'), new Error('private URL')])('reports safe download failure classification: %s', async (error) => {
  const f = fixture()
  await f.coordinator.check()
  f.downloadUpdate.mockRejectedValueOnce(error)
  await f.coordinator.download('1.1.0-rc.2')
  expect(f.downloadResult).toHaveBeenCalledExactlyOnceWith(false, error instanceof DesktopUpdatePreparationError ? 'stop-failed' : 'download_failed')
  expect(JSON.stringify(f.downloadResult.mock.calls)).not.toContain('private')
})


it('resolves the current backend source before every check and retains the downloaded source', async () => {
  const f = fixture()
  await f.coordinator.check()
  expect(f.setFeedURL).toHaveBeenLastCalledWith({ provider: 'generic', url: 'https://updates.example.com/mac-arm64/', channel: 'nightly' })
  f.resolveSource.mockResolvedValueOnce({ url: 'https://new.example.com/mac-arm64/', channel: 'nightly' })
  await f.coordinator.check()
  expect(f.setFeedURL).toHaveBeenLastCalledWith({ provider: 'generic', url: 'https://new.example.com/mac-arm64/', channel: 'nightly' })
  await f.coordinator.download('1.1.0-rc.2')
  await f.coordinator.check(true)
  expect(f.resolveSource).toHaveBeenCalledTimes(2)
  expect(f.updater.allowDowngrade).toBe(false)
})

it('invalidates an old available target when the backend disables updates', async () => {
  const f = fixture()
  await f.coordinator.check()
  f.resolveSource.mockRejectedValueOnce(new DesktopUpdateSourceError('source-disabled'))
  expect(await f.coordinator.check()).toMatchObject({ phase: 'error', sourceFailure: 'source-disabled' })
  expect(f.coordinator.state).toMatchObject({ phase: 'error', sourceFailure: 'source-disabled' })
  await expect(f.coordinator.download('1.1.0-rc.2')).rejects.toThrow(/no checked update/u)
  expect(f.setFeedURL).toHaveBeenCalledTimes(1)
  expect(f.downloadUpdate).not.toHaveBeenCalled()
})

it('disposal during source resolution cannot mutate the provider or check metadata', async () => {
  const f = fixture()
  const source = Promise.withResolvers<{ url: string; channel: 'nightly' }>()
  f.resolveSource.mockImplementationOnce(() => source.promise)
  const checking = f.coordinator.check()
  await Promise.resolve()
  f.coordinator.dispose()
  source.resolve({ url: 'https://updates.example.com/', channel: 'nightly' })
  await checking
  expect(f.setFeedURL).not.toHaveBeenCalled()
  expect(f.checkForUpdates).not.toHaveBeenCalled()
})


it('retires a visible available target when a later metadata check fails', async () => {
  const f = fixture()
  await f.coordinator.check()
  f.checkForUpdates.mockRejectedValueOnce(new Error('offline'))
  expect(await f.coordinator.check()).toMatchObject({ phase: 'error', failedOperation: 'check' })
  expect(f.coordinator.state.phase).toBe('error')
  await expect(f.coordinator.download('1.1.0-rc.2')).rejects.toThrow(/no checked update/u)
})
