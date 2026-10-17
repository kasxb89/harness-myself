/** Unsigned Mac releases use verified DMG handoff because Squirrel requires a signed app. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { extname } from 'node:path'
import { shell } from 'electron'
import { AppUpdater } from 'electron-updater'
import type { AppAdapter } from 'electron-updater/out/AppAdapter.js'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater.js'
import { DesktopUpdateHttpExecutor } from './update-http-executor.ts'
import { DesktopUpdateInstallerIntegrityError } from './update-error.ts'

/**
 * Select the explicit packaged build mode; an environment variable cannot alter installed update behavior.
 * @param manifest - Main-owned application manifest.
 * @param packaged - Whether Electron runs an installed app.
 * @param platform - Native operating system.
 * @returns Whether updates must open a DMG for manual replacement.
 */
export function usesUnsignedMacUpdates(manifest: unknown, packaged: boolean, platform: NodeJS.Platform): boolean {
  return packaged && platform === 'darwin' && typeof manifest === 'object' && manifest !== null
    && 'dshDesktopUnsigned' in manifest && manifest.dshDesktopUnsigned === true
}

/** Reuses electron-updater metadata, version selection, cache and checksum validation without native Squirrel. */
export class UnsignedMacUpdater extends AppUpdater {
  readonly httpExecutor: DesktopUpdateHttpExecutor
  private prepared: { version: string; path: string; sha512: string } | undefined

  /**
   * @param adapter - Electron app adapter, replaceable only for runtime qualification.
   * @param openInstaller - Main-owned native file opener; never receives renderer paths.
   */
  constructor(adapter?: AppAdapter, private readonly openInstaller: (path: string) => Promise<string> = path => shell.openPath(path)) {
    super(undefined, adapter)
    this.httpExecutor = new DesktopUpdateHttpExecutor(Number(process.env.DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS ?? 60_000),
      (authInfo, callback) => { this.emit('login', authInfo, callback) })
    this.autoDownload = false
    this.autoInstallOnAppQuit = false
  }

  protected override async doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
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
      done: (event) => {
        this.prepared = { version: event.version, path: event.downloadedFile, sha512: file.info.sha512 }
        this.dispatchUpdateDownloaded(event)
        return Promise.resolve()
      } })
  }

  /**
   * Revalidate the retained file immediately before native handoff; failure leaves the app and Host running.
   * @param version - Exact main-owned release approved by the user.
   * @returns Completion of opening the verified installer, without replacing or quitting this app.
   */
  async openDownloadedInstaller(version: string): Promise<void> {
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
      const failure = await this.openInstaller(prepared.path)
      if (failure !== '') throw new Error('desktop update: could not open unsigned Mac installer', { cause: failure })
    } finally { await file.close() }
  }

  /** Automatic app replacement is unavailable for unsigned Mac releases. */
  override quitAndInstall(): void { throw new Error('desktop update: unsigned Mac releases require opening the installer') }

  private async invalidInstaller(cause: unknown): Promise<never> {
    this.prepared = undefined
    await this.downloadedUpdateHelper?.clear()
    throw new DesktopUpdateInstallerIntegrityError('desktop update: unsigned Mac installer verification failed; download again', { cause })
  }
}
