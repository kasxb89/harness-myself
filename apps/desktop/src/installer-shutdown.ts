/** Local Windows installer-to-application shutdown, with no network listener or process termination. */

/** WM_APP message shared with installer/upgrade-shutdown.h; parameters contain integers, never pointers. */
export const DESKTOP_INSTALLER_SHUTDOWN_MESSAGE = 0x8000 + 0x594
/** Namespace and protocol version for the local message, shared with the native installer. */
export const DESKTOP_INSTALLER_SHUTDOWN_MAGIC = 0x59554e53

/** Windows operations used by the shell; the hidden primary window remains a message target. */
export interface DesktopInstallerShutdownWindow {
  hookWindowMessage(message: number, listener: (wParam: Buffer, lParam: Buffer) => void): void
}

/**
 * Route one installer request through the existing quit confirmation and Host cleanup.
 * An installer must still observe actual process exit; receiving a message is not a teardown acknowledgement.
 */
export class DesktopInstallerShutdown {
  private requested = false

  /** @param quit - Existing application quit entry, including active-task confirmation. */
  constructor(private readonly quit: () => void) {}

  /** Pending shutdown suppresses relaunch entries until the user cancels or the application exits. */
  get pending(): boolean { return this.requested }

  /** Register the Windows-only entry before loading the primary document. */
  bind(window: DesktopInstallerShutdownWindow, platform: NodeJS.Platform = process.platform): void {
    if (platform !== 'win32') return
    window.hookWindowMessage(DESKTOP_INSTALLER_SHUTDOWN_MESSAGE, (wParam, lParam) => {
      if (wParam.length < 4 || lParam.length < 4 || wParam.readUInt32LE() !== DESKTOP_INSTALLER_SHUTDOWN_MAGIC
        || lParam.readUInt32LE() !== 1 || this.requested) return
      this.requested = true
      this.quit()
    })
  }

  /** A cancelled confirmation leaves the app running and permits an explicit installer retry. */
  cancel(): void { this.requested = false }
}
