/** Verified unsigned Mac updates prepare an independent installer before task shutdown. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { AppUpdater } from 'electron-updater'
import type { AppAdapter } from 'electron-updater/out/AppAdapter.js'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater.js'
import { DesktopUpdateHttpExecutor } from './update-http-executor.ts'
import { DesktopUpdateInstallerHandoffError, DesktopUpdateInstallerIntegrityError } from './update-error.ts'
import { prepareUnsignedMacInstall, type PreparedUnsignedMacInstall } from './unsigned-mac-install.ts'

/**
 * Select the explicit packaged build mode; an environment variable cannot alter installed update behavior.
 * @param manifest - Main-owned application manifest.
 * @param packaged - Whether Electron runs an installed app.
 * @param platform - Native operating system.
 * @returns Whether updates use the independent unsigned Mac installer.
 */
export function usesUnsignedMacUpdates(manifest: unknown, packaged: boolean, platform: NodeJS.Platform): boolean {
  return packaged && platform === 'darwin' && typeof manifest === 'object' && manifest !== null
    && 'dshDesktopUnsigned' in manifest && manifest.dshDesktopUnsigned === true
}

/** Reuses metadata, version selection, cache and checksum validation without native Squirrel. */
export class UnsignedMacUpdater extends AppUpdater {
  readonly httpExecutor: DesktopUpdateHttpExecutor
  private prepared: { version: string; path: string; sha512: string } | undefined
  private installer: PreparedUnsignedMacInstall | undefined
  private preparation: Promise<PreparedUnsignedMacInstall> | undefined
  private readonly preparationAbort = new AbortController()
  private disposed = false

  /**
   * @param adapter - Electron app adapter, replaceable only for runtime qualification.
   * @param prepareInstaller - Main-owned staging implementation; never receives renderer paths.
   */
  constructor(adapter?: AppAdapter, private readonly prepareInstaller: typeof prepareUnsignedMacInstall = prepareUnsignedMacInstall) {
    super(undefined, adapter)
    this.httpExecutor = new DesktopUpdateHttpExecutor(Number(process.env.DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS ?? 60_000),
      (authInfo, callback) => { this.emit('login', authInfo, callback) })
    this.autoDownload = false
    this.autoInstallOnAppQuit = false
  }

  protected override async doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    if (this.isDisposed()) throw new Error('desktop update: updater is disposed')
    await this.installer?.dispose()
    this.installer = undefined
    this.prepared = undefined
    const { info, provider } = options.updateInfoAndProvider
    const files = provider.resolveFiles(info).filter(file => extname(file.url.pathname).toLowerCase() === '.dmg')
    if (files.length !== 1) throw new Error('desktop update: unsigned Mac feed must contain one DMG for this device')
    const file = files[0]
    if (file === undefined) throw new Error('desktop update: unsigned Mac installer is missing')
    if (file.url.protocol !== 'https:' && this.app.isPackaged) throw new Error('desktop update: unsigned Mac installer requires HTTPS')
    if (!/^[A-Za-z0-9+/]{86}==$/u.test(file.info.sha512)) throw new Error('desktop update: unsigned Mac installer requires a SHA512 digest')
    return this.executeDownload({ fileExtension: 'dmg', fileInfo: file, downloadUpdateOptions: options,
      task: async (destination, downloadOptions) => { await this.httpExecutor.download(file.url, destination, downloadOptions) },
      done: async (event) => {
        if (this.isDisposed()) throw new Error('desktop update: updater is disposed')
        this.prepared = { version: event.version, path: event.downloadedFile, sha512: file.info.sha512 }
        this.preparation = (async () => {
          await this.verifyDownloadedInstaller(event.version)
          if (this.isDisposed()) throw new Error('desktop update: updater is disposed')
          return this.prepareInstaller({ dmgPath: event.downloadedFile, sha512: file.info.sha512, version: event.version,
            currentVersion: this.app.version, executablePath: process.execPath, architecture: process.arch,
            stateDirectory: join(this.app.userDataPath, 'unsigned-mac-updates'), signal: this.preparationAbort.signal })
        })()
        this.installer = await this.preparation
        if (this.isDisposed()) { await this.installer.dispose(); throw new Error('desktop update: updater is disposed') }
        this.dispatchUpdateDownloaded(event)
      } })
  }

  /**
   * Launch the staged installer after the coordinator completes task shutdown, then quit this app.
   * @param version - Exact main-owned release approved by the user.
   * @returns Confirmed helper readiness; launch failures leave app recovery to the coordinator.
   */
  async installPreparedUpdate(version: string): Promise<void> {
    if (this.isDisposed() || this.prepared?.version !== version || this.installer === undefined) {
      throw new Error('desktop update: unsigned Mac installer is not ready')
    }
    try { await this.installer.launch() }
    catch (cause) {
      const installer = this.installer
      this.installer = undefined
      this.prepared = undefined
      try { await installer.dispose() }
      catch (cleanupFailure) {
        throw new DesktopUpdateInstallerHandoffError('desktop update: helper handoff failed and needs recovery', {
          cause: new AggregateError([cause, cleanupFailure]),
        })
      }
      throw new DesktopUpdateInstallerHandoffError('desktop update: helper handoff failed; prepare the update again', { cause })
    }
    this.app.quit()
  }

  /** Stop staging before ordinary quit; a handed-off installer retains ownership of its files. */
  async disposePreparedUpdate(): Promise<void> {
    this.disposed = true
    this.preparationAbort.abort()
    // Download completion owns the preparation failure; shutdown still joins its cleanup.
    const installer = await this.preparation?.catch(() => undefined)
    await installer?.dispose()
  }

  /**
   * Validate cached bytes before staging.
   * @param version - Exact release the retained download belongs to.
   * @returns Successful integrity validation; invalid files clear the download cache.
   */
  protected async verifyDownloadedInstaller(version: string): Promise<void> {
    const prepared = this.prepared
    if (prepared === undefined || prepared.version !== version) throw new Error('desktop update: unsigned Mac installer is not ready')
    const file = await open(prepared.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      .catch((cause: unknown) => this.invalidInstaller(cause))
    try {
      try {
        const before = await file.stat()
        if (!before.isFile()) throw new Error('desktop update: unsigned Mac installer is not a regular file')
        const hash = createHash('sha512')
        for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk as Buffer)
        if (hash.digest('base64') !== prepared.sha512) throw new Error('desktop update: unsigned Mac installer checksum changed')
        const after = await lstat(prepared.path)
        if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino
          || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('desktop update: unsigned Mac installer changed before opening')
      } catch (cause) { await this.invalidInstaller(cause) }
    } finally { await file.close() }
  }

  /** Installation is asynchronous so the coordinator must await helper readiness before quitting. */
  override quitAndInstall(): void { throw new Error('desktop update: unsigned Mac installation requires the controlled restart handoff') }

  private isDisposed(): boolean { return this.disposed }

  private async invalidInstaller(cause: unknown): Promise<never> {
    this.prepared = undefined
    await this.downloadedUpdateHelper?.clear()
    throw new DesktopUpdateInstallerIntegrityError('desktop update: unsigned Mac installer verification failed; download again', { cause })
  }
}
