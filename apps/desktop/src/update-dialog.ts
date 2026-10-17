/** Main-owned update progress and confirmations; dismissal never cancels a download or grants installation permission. */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron'
import type { DesktopLocale } from './locale.ts'
import type { DesktopUpdateState } from './ipc.ts'
import { desktopUpdateErrorSummary } from './update-presentation.ts'
import type { DesktopUpdateOverlays } from './update-overlay.ts'

/** Channels available only to the isolated update-dialog document. */
export const UPDATE_DIALOG_IPC = { status: 'dsh-update-dialog:status', changed: 'dsh-update-dialog:changed', respond: 'dsh-update-dialog:respond' } as const

/** Text and choices supplied by the main process, never by product documents. */
export interface UpdateDialogView {
  /** Identifies the displayed choices; a response from an older prompt is rejected. */
  readonly revision: number
  readonly locale: string
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly buttons: readonly string[]
  readonly cancelId: number
  readonly closeLabel: string
  readonly technicalDetails: string
  readonly technicalDetailsLabel: string
  readonly brand?: string
  readonly tone?: 'info' | 'error'
  readonly progress?: { readonly phase: 'downloading' | 'verifying'; readonly percent?: number; readonly version?: string }
}

/** Electron message options with separately expandable, main-owned diagnostics. */
export interface UpdateDialogOptions extends MessageBoxOptions {
  readonly technicalDetails?: string
  readonly progress?: UpdateDialogView['progress']
}

/**
 * Project real download state into a dismissible progress dialog without granting installation.
 * @param state - Current coordinator state, never a renderer-supplied percentage.
 * @param locale - Current shell language.
 * @returns Main-owned progress copy, or no progress view for a settled operation.
 */
export function desktopUpdateProgressOptions(state: DesktopUpdateState, locale: DesktopLocale):
  (UpdateDialogOptions & { readonly progress: NonNullable<UpdateDialogView['progress']> }) | undefined {
  if (state.phase !== 'downloading' && state.phase !== 'verifying') return undefined
  const percent = state.percent === undefined ? undefined : Math.floor(Math.min(100, Math.max(0, state.percent)))
  return { title: locale.messages.updateTitle,
    message: state.phase === 'verifying' ? locale.messages.updateVerifying : locale.messages.updateDownloadTitle,
    detail: state.phase === 'verifying' ? locale.messages.updateVerifyingDetail
      : state.installationMode === 'manual' ? locale.messages.updateDownloadingDetailManual : locale.messages.updateDownloadingDetail,
    buttons: [locale.messages.updateBackground], cancelId: 0,
    progress: { phase: state.phase, ...(percent === undefined ? {} : { percent }),
      ...(state.version === undefined ? {} : { version: state.version }) },
  }
}

/**
 * Expose retry only for the coordinator's current failed download and retained target.
 * @param state - Failure displayed by the shell, possibly synthetic or obsolete.
 * @param current - Current coordinator-owned state.
 * @returns Whether repeating this download has a current version-bound owner.
 */
export function canRetryDesktopUpdateDownload(state: DesktopUpdateState, current: DesktopUpdateState): boolean {
  return state === current && state.phase === 'error' && state.failedOperation === 'download' && state.version !== undefined
}

/**
 * @param state - Failure to explain without granting stale download authorization.
 * @param current - Current coordinator-owned state.
 * @param locale - Current shell language.
 * @returns Localized failure choices with explicit cancellation and folded diagnostics.
 */
export function desktopUpdateFailureOptions(state: DesktopUpdateState, current: DesktopUpdateState,
  locale: DesktopLocale): UpdateDialogOptions {
  const retry = canRetryDesktopUpdateDownload(state, current)
  return { type: 'error', title: locale.messages.updateFailedTitle, message: desktopUpdateErrorSummary(state, locale.messages),
    technicalDetails: state.technicalDetails ?? state.message ?? '',
    buttons: retry ? [locale.messages.updateRetryDownload, locale.messages.updateClose] : [locale.messages.updateClose],
    cancelId: retry ? 1 : 0 }
}

/**
 * Wait outside the active prompt before repeating an explicitly approved, still-current download.
 * @param failure - Exact coordinator failure displayed in the retry prompt.
 * @param pending - Prompt owner that must release its operation before another prompt can start.
 * @param current - Re-read the coordinator and policy after the pending prompt settles.
 * @param retry - Starts the normal user-authorized download path; never an installer action.
 * @returns Completion of the retry, or no action if policy or target ownership changed.
 */
export async function retryDesktopUpdateDownload(failure: DesktopUpdateState, pending: Promise<void> | undefined,
  current: () => { state: DesktopUpdateState; allowed: boolean }, retry: () => Promise<void>): Promise<void> {
  await pending
  const next = current()
  if (next.allowed && canRetryDesktopUpdateDownload(failure, next.state)) await retry()
}

/** The document can select only a displayed response index. */
export interface UpdateDialogApi {
  status(): Promise<UpdateDialogView | null>
  respond(revision: number, index: number): Promise<void>
  subscribe(listener: (view: UpdateDialogView | null) => void): () => void
}

// main.ts's protocol.handle shell route serves this document and its renderer assets; the modal requires that route.
const page = 'dsh-app://shell/update-dialog.html'

/** One fading backdrop with replaceable confirmation content; aborted checks and mandatory policy cancel ordinary prompts. */
export class DesktopUpdateDialog {
  private disposed = false
  private revision = 0
  private window: BrowserWindow | undefined
  private parent: BrowserWindow | undefined
  private closing: ReturnType<typeof setTimeout> | undefined
  private active: { window: BrowserWindow; view: UpdateDialogView; finish: (index: number, retain?: boolean) => void } | undefined

  /** Focus the current explanation or confirmation without replacing it or granting permission. */
  focus(): void { this.active?.window.focus() }

  /** Whether a shell prompt is awaiting a response. */
  get isOpen(): boolean { return this.active !== undefined }

  /**
   * Update an already-visible download without changing choices, focus, or response revision.
   * @param state - Latest coordinator state.
   * @returns Whether this dialog currently owns a progress presentation.
   */
  updateProgress(state: DesktopUpdateState): boolean {
    const active = this.active
    if (active?.view.progress === undefined) return false
    const locale = typeof this.locale === 'function' ? this.locale() : this.locale
    const options = desktopUpdateProgressOptions(state, locale)
    if (options === undefined) return false
    active.view = { ...active.view, locale: locale.id, message: options.message, detail: options.detail ?? '', progress: options.progress,
      buttons: options.buttons ?? active.view.buttons, brand: locale.messages.aboutProduct, closeLabel: locale.messages.updateBackground }
    active.window.webContents.send(UPDATE_DIALOG_IPC.changed, active.view)
    return true
  }

  /**
   * @param preload - Bundled isolated preload.
   * @param locale - Shell-owned copy or a reader of the current UI language.
   * @param overlays - Application-owned overlay creation and input tracking.
   */
  constructor(private readonly preload: string, private readonly locale: DesktopLocale | (() => DesktopLocale),
    private readonly overlays: Pick<DesktopUpdateOverlays, 'create'>) {
    ipcMain.handle(UPDATE_DIALOG_IPC.status, (event) => { this.owned(event); return this.active?.view ?? null })
    ipcMain.handle(UPDATE_DIALOG_IPC.respond, (event, revision: unknown, index: unknown) => {
      this.owned(event)
      const active = this.active
      if (active === undefined || revision !== active.view.revision) throw new Error('desktop update: stale dialog response')
      if (typeof index !== 'number' || !Number.isInteger(index)
        || (index !== active.view.cancelId && (index < 0 || index >= active.view.buttons.length))) {
        throw new Error('desktop update: invalid dialog response')
      }
      active.finish(index)
    })
  }

  /**
   * @param parent - Window blocked by this confirmation.
   * @param options - Main-owned localized content, response choices, and optional cancellation signal.
   * @returns A displayed response, or cancellation on replacement, abort, close, or load failure; backdrop dismissal fades independently.
   */
  show(parent: BrowserWindow, options: UpdateDialogOptions): Promise<MessageBoxReturnValue> {
    const locale = typeof this.locale === 'function' ? this.locale() : this.locale
    const buttons = options.buttons ?? [locale.messages.updateAcknowledge]
    const cancelId = options.cancelId ?? buttons.length - 1
    if (this.disposed || options.signal?.aborted === true || parent.isDestroyed()) {
      return Promise.resolve({ response: cancelId, checkboxChecked: false })
    }
    if (this.parent !== parent) { this.cancel(); this.close() }
    this.active?.finish(this.active.view.cancelId, true)
    clearTimeout(this.closing)
    this.closing = undefined
    const existing = this.window
    const window = existing ?? this.overlays.create(parent, this.preload, options.title ?? locale.messages.updateTitle, false)
    this.window = window
    this.parent = parent
    const view: UpdateDialogView = { revision: ++this.revision, locale: locale.id, title: options.title ?? '', message: options.message,
      detail: options.detail ?? '', buttons, cancelId,
      closeLabel: options.progress === undefined ? locale.messages.updateClose : locale.messages.updateBackground,
      technicalDetails: options.technicalDetails ?? '', technicalDetailsLabel: locale.messages.updateTechnicalDetails,
      brand: locale.messages.aboutProduct, tone: options.type === 'error' ? 'error' : 'info',
      ...(options.progress === undefined ? {} : { progress: options.progress }) }
    return new Promise((resolve) => {
      const abort = (): void => { finish(cancelId) }
      const finish = (response: number, retain = false): void => {
        if (this.active?.finish !== finish) return
        this.active = undefined
        options.signal?.removeEventListener('abort', abort)
        if (!retain && !window.isDestroyed()) {
          window.webContents.send(UPDATE_DIALOG_IPC.changed, null)
          this.closing = setTimeout(() => { this.close() }, 150)
        }
        resolve({ response, checkboxChecked: false })
      }
      this.active = { window, view, finish }
      options.signal?.addEventListener('abort', abort, { once: true })
      if (existing !== undefined) { window.webContents.send(UPDATE_DIALOG_IPC.changed, view); return }
      const failed = (): void => { if (this.window === window) { this.cancel(); this.close() } }
      window.once('closed', failed)
      window.webContents.on('will-navigate', (event, url) => { if (url !== page) event.preventDefault() })
      window.webContents.once('render-process-gone', failed)
      void window.loadURL(page).catch(failed)
    })
  }

  /** Cancel the displayed prompt without authorizing any operation. */
  cancel(): void { this.active?.finish(this.active.view.cancelId) }

  /** Close the document and detach its private IPC handlers. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel()
    this.close()
    ipcMain.removeHandler(UPDATE_DIALOG_IPC.status)
    ipcMain.removeHandler(UPDATE_DIALOG_IPC.respond)
  }

  private close(): void {
    clearTimeout(this.closing)
    this.closing = undefined
    const window = this.window
    this.window = undefined
    this.parent = undefined
    if (window !== undefined && !window.isDestroyed()) window.destroy()
  }

  private owned(event: IpcMainInvokeEvent): void {
    const window = this.window
    if (window === undefined || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) {
      throw new Error('desktop update: rejected unowned dialog renderer')
    }
  }
}
