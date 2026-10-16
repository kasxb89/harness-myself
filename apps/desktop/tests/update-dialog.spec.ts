import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { BrowserWindow } from 'electron'
import type { AppUpdater } from 'electron-updater'
import { DesktopUpdateDialog, desktopUpdateFailureOptions, desktopUpdateProgressOptions, retryDesktopUpdateDownload, UPDATE_DIALOG_IPC } from '../src/update-dialog.ts'
import { DesktopUpdateOverlays } from '../src/update-overlay.ts'
import { DesktopUpdateCoordinator } from '../src/update-coordinator.ts'
import type { DesktopUpdateState } from '../src/ipc.ts'
import { resolveDesktopLocale, type DesktopLocale } from '../src/locale.ts'

const fixture = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const windows: FakeWindow[] = []
  class FakeWindow extends EventEmitter {
    destroyed = false
    readonly webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      mainFrame: { url: 'dsh-app://shell/update-dialog.html' },
      setWindowOpenHandler: vi.fn(),
      insertCSS: vi.fn(async () => 'blur'),
      removeInsertedCSS: vi.fn(async () => {}),
    })
    readonly focus = vi.fn()
    readonly show = vi.fn()
    readonly setBounds = vi.fn()
    readonly loadURL = vi.fn(async () => {})
    constructor(readonly options: unknown) { super(); windows.push(this) }
    getContentBounds() { return { x: 10, y: 20, width: 900, height: 650 } }
    isDestroyed() { return this.destroyed }
    isVisible() { return true }
    destroy() { this.destroyed = true; this.emit('closed') }
    setMenu() {}
  }
  return { handlers, windows, FakeWindow }
})
vi.mock('electron', () => ({ app: { isPackaged: false }, BrowserWindow: fixture.FakeWindow, ipcMain: {
  handle: (name: string, fn: (...args: unknown[]) => unknown) => fixture.handlers.set(name, fn),
  removeHandler: (name: string) => fixture.handlers.delete(name),
} }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }))

let dialogs: DesktopUpdateDialog | undefined
const coordinators: DesktopUpdateCoordinator[] = []
afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.dispose()
  vi.useRealTimers()
  dialogs?.dispose()
  dialogs = undefined
  for (const window of fixture.windows) if (!window.isDestroyed()) window.destroy()
  fixture.windows.length = 0
  fixture.handlers.clear()
})

function setup(locale: DesktopLocale | (() => DesktopLocale) = resolveDesktopLocale('zh-CN')) {
  const parent = new BrowserWindow({})
  dialogs = new DesktopUpdateDialog('preload-update-dialog.cjs', locale, new DesktopUpdateOverlays())
  const show = (signal?: AbortSignal) => dialogs!.show(parent, {
    message: '下载完成', buttons: ['安装并重启'], cancelId: 1, ...(signal === undefined ? {} : { signal }),
  })
  const invoke = (channel: string, ...args: unknown[]) => {
    const window = fixture.windows.at(-1)!
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const view = fixture.handlers.get(UPDATE_DIALOG_IPC.status)!(event) as { revision: number }
    return fixture.handlers.get(channel)!(event, ...(channel === UPDATE_DIALOG_IPC.respond ? [view.revision, ...args] : args))
  }
  return { parent, show, invoke }
}

it('accepts only a displayed choice from its own main frame and retains cancellation outside the button list', async () => {
  const f = setup()
  expect(dialogs!.isOpen).toBe(false)
  const pending = f.show()
  expect(dialogs!.isOpen).toBe(true)
  const window = fixture.windows.at(-1)!
  expect(f.invoke(UPDATE_DIALOG_IPC.status)).toMatchObject({ closeLabel: '关闭', buttons: ['安装并重启'], cancelId: 1 })
  const respond = fixture.handlers.get(UPDATE_DIALOG_IPC.respond)!
  expect(() => respond({ sender: {}, senderFrame: window.webContents.mainFrame }, 0)).toThrow(/unowned/)
  expect(() => respond({ sender: window.webContents, senderFrame: { ...window.webContents.mainFrame } }, 0)).toThrow(/unowned/)
  for (const index of [-1, 2, '0', 0.5, NaN]) expect(() => f.invoke(UPDATE_DIALOG_IPC.respond, index)).toThrow(/invalid/)
  f.invoke(UPDATE_DIALOG_IPC.respond, 1)
  expect(await pending).toEqual({ response: 1, checkboxChecked: false })
  expect(dialogs!.isOpen).toBe(false)
  const next = f.show()
  f.invoke(UPDATE_DIALOG_IPC.respond, 0)
  expect((await next).response).toBe(0)
})

it('follows the parent geometry and removes listeners when closed or replaced', async () => {
  const f = setup()
  const first = f.show()
  const window = fixture.windows.at(-1)!
  expect(window.options).toMatchObject({ frame: false, transparent: true, modal: process.platform !== 'darwin', width: 900, height: 650 })
  window.emit('ready-to-show')
  expect(window.show).toHaveBeenCalledOnce()
  f.parent.emit('resize')
  expect(window.setBounds).toHaveBeenCalledWith(f.parent.getContentBounds())
  const next = f.show()
  expect((await first).response).toBe(1)
  expect(f.parent.listenerCount('resize')).toBe(1)
  fixture.windows.at(-1)!.destroy()
  expect((await next).response).toBe(1)
  expect(f.parent.listenerCount('resize')).toBe(0)
  expect(f.parent.listenerCount('move')).toBe(0)
  expect(fixture.windows[0]?.webContents.insertCSS).not.toHaveBeenCalled()
  expect(fixture.windows[0]?.webContents.removeInsertedCSS).not.toHaveBeenCalled()
})

it('cancels on abort, renderer failure, disposal, or an already-closed parent', async () => {
  const f = setup()
  const controller = new AbortController()
  const pending = f.show(controller.signal)
  controller.abort()
  expect((await pending).response).toBe(1)
  expect((await f.show(controller.signal)).response).toBe(1)
  const crashing = f.show()
  fixture.windows.at(-1)!.webContents.emit('render-process-gone')
  expect((await crashing).response).toBe(1)
  const stopping = f.show()
  dialogs!.dispose()
  expect((await stopping).response).toBe(1)
  expect(fixture.handlers.size).toBe(0)
  const count = fixture.windows.length
  expect((await f.show()).response).toBe(1)
  expect(fixture.windows).toHaveLength(count)
  f.parent.destroy()
  expect((await f.show()).response).toBe(1)
})

it('denies navigation away from the owned document', async () => {
  const f = setup()
  const pending = f.show()
  const window = fixture.windows.at(-1)!
  const event = { preventDefault: vi.fn() }
  window.webContents.emit('will-navigate', event, 'https://example.com')
  expect(event.preventDefault).toHaveBeenCalledOnce()
  window.webContents.emit('will-navigate', event, 'dsh-app://shell/update-dialog.html')
  expect(event.preventDefault).toHaveBeenCalledOnce()
  dialogs!.cancel()
  await pending
})

it('supplies localized disclosure copy without putting diagnostics in the ordinary detail', async () => {
  const f = setup()
  const pending = dialogs!.show(f.parent, {
    message: '未能安全停止任务', technicalDetails: 'exit 0; shutdown acknowledged false',
  })
  expect(f.invoke(UPDATE_DIALOG_IPC.status)).toMatchObject({ detail: '',
    technicalDetails: 'exit 0; shutdown acknowledged false', technicalDetailsLabel: '查看技术详情' })
  dialogs!.cancel()
  await pending
})

it('replaces content without releasing the backdrop and rejects a response from the previous prompt', async () => {
  const f = setup()
  const abort = new AbortController()
  const first = f.show(abort.signal)
  const window = fixture.windows.at(-1)!
  const old = f.invoke(UPDATE_DIALOG_IPC.status) as { revision: number }
  const next = f.show()
  expect((await first).response).toBe(1)
  expect(fixture.windows).toHaveLength(2)
  expect(window.loadURL).toHaveBeenCalledOnce()
  expect(window.webContents.send.mock.calls).toEqual([[UPDATE_DIALOG_IPC.changed, f.invoke(UPDATE_DIALOG_IPC.status)]])
  expect(fixture.windows[0]?.webContents.removeInsertedCSS).not.toHaveBeenCalled()
  abort.abort()
  expect(() => fixture.handlers.get(UPDATE_DIALOG_IPC.respond)!({
    sender: window.webContents, senderFrame: window.webContents.mainFrame,
  }, old.revision, 0)).toThrow(/stale/)
  f.invoke(UPDATE_DIALOG_IPC.respond, 0)
  expect((await next).response).toBe(0)
})

it('fades out before releasing the backdrop and cancels pending removal when another prompt opens', async () => {
  vi.useFakeTimers()
  const f = setup()
  const first = f.show()
  const window = fixture.windows.at(-1)!
  dialogs!.cancel()
  await first
  expect(window.isDestroyed()).toBe(false)
  expect(window.webContents.send).toHaveBeenLastCalledWith(UPDATE_DIALOG_IPC.changed, null)
  const next = f.show()
  await vi.advanceTimersByTimeAsync(150)
  expect(window.isDestroyed()).toBe(false)
  dialogs!.cancel()
  await next
  await vi.advanceTimersByTimeAsync(150)
  expect(window.isDestroyed()).toBe(true)
  expect(f.parent.listenerCount('focus')).toBe(0)
  expect(f.parent.webContents.listenerCount('before-input-event')).toBe(0)
})

it.runIf(process.platform === 'darwin')('blocks parent keyboard input and redirects focus without a native sheet', async () => {
  const f = setup()
  const pending = f.show()
  const window = fixture.windows.at(-1)!
  const event = { preventDefault: vi.fn() }
  f.parent.webContents.emit('before-input-event', event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  f.parent.emit('focus')
  expect(window.focus).toHaveBeenCalledTimes(2)
  dialogs!.dispose()
  await pending
  expect(f.parent.webContents.listenerCount('before-input-event')).toBe(0)
})

it('reads the current locale for each presentation', async () => {
  let locale = resolveDesktopLocale('en')
  const f = setup(() => locale)
  for (const language of ['zh-CN', 'en']) {
    locale = resolveDesktopLocale(language)
    const pending = f.show()
    const window = fixture.windows.at(-1)!
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    expect(fixture.handlers.get(UPDATE_DIALOG_IPC.status)!(event)).toMatchObject({
      locale: locale.id, closeLabel: locale.messages.updateClose,
      technicalDetailsLabel: locale.messages.updateTechnicalDetails,
    })
    dialogs!.cancel()
    await pending
  }
})

it('updates true download progress without replacing choices or invalidating the displayed close response', async () => {
  const f = setup()
  const locale = resolveDesktopLocale('zh-CN')
  const options = desktopUpdateProgressOptions({ phase: 'downloading', version: '1.2.0', percent: 12 }, locale)!
  const pending = dialogs!.show(f.parent, options)
  const initial = f.invoke(UPDATE_DIALOG_IPC.status) as { revision: number }
  const focused = fixture.windows.at(-1)!.focus.mock.calls.length
  expect(dialogs!.updateProgress({ phase: 'downloading', version: '1.2.0', percent: 48.7 })).toBe(true)
  expect(f.invoke(UPDATE_DIALOG_IPC.status)).toMatchObject({ revision: initial.revision,
    buttons: ['后台下载'], progress: { phase: 'downloading', percent: 48, version: '1.2.0' } })
  expect(dialogs!.updateProgress({ phase: 'verifying', version: '1.2.0' })).toBe(true)
  expect(f.invoke(UPDATE_DIALOG_IPC.status)).toMatchObject({ revision: initial.revision,
    message: '正在校验更新文件…', progress: { phase: 'verifying' } })
  expect(fixture.windows.at(-1)!.focus).toHaveBeenCalledTimes(focused)
  f.invoke(UPDATE_DIALOG_IPC.respond, 0)
  expect((await pending).response).toBe(0)
  expect(dialogs!.updateProgress({ phase: 'downloading', percent: 70 })).toBe(false)
  const ready = f.show()
  expect(dialogs!.updateProgress({ phase: 'downloading', percent: 70 })).toBe(false)
  dialogs!.cancel()
  await ready
})

it.each(['en', 'zh-CN'])('records localized download and verification guidance: %s', async (language) => {
  const locale = resolveDesktopLocale(language)
  const states = [
    { phase: 'downloading' as const, version: '1.2.0-nightly.1', percent: 58.4 },
    { phase: 'downloading' as const, version: '1.2.0-nightly.1' },
    { phase: 'verifying' as const, version: '1.2.0-nightly.1', percent: 100 },
  ]
  const views = states.map(state => desktopUpdateProgressOptions(state, locale))
  expect(desktopUpdateProgressOptions({ phase: 'ready' }, locale)).toBeUndefined()
  await expect(JSON.stringify(views, null, 2) + '\n').toMatchFileSnapshot(`./expected/update-download-${language}.json`)
})

function downloadFixture(publish: (state: DesktopUpdateState) => DesktopUpdateState) {
  const events = new EventEmitter()
  const transfer = Promise.withResolvers<string[]>()
  const downloadUpdate = vi.fn(() => transfer.promise)
  const quitAndInstall = vi.fn()
  const updater = Object.assign({} as AppUpdater, {
    on: events.on.bind(events), off: events.off.bind(events),
    checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: { version: '1.2.0' } })),
    downloadUpdate, quitAndInstall, setFeedURL: vi.fn(),
  })
  const coordinator = new DesktopUpdateCoordinator(publish, async () => false, updater, () => true, () => '1.1.0', undefined,
    async () => ({ url: 'https://updates.example.invalid/win-x64/', channel: 'nightly' }))
  coordinators.push(coordinator)
  return { coordinator, events, transfer, downloadUpdate, quitAndInstall }
}

it('keeps an inert download running after background dismissal, then reopens progress and settles at readiness', async () => {
  const f = setup()
  const locale = resolveDesktopLocale('zh-CN')
  const visible = new AbortController()
  const download = downloadFixture((state) => {
    if (state.phase === 'downloading' || state.phase === 'verifying') dialogs!.updateProgress(state)
    else if (state.phase === 'ready') visible.abort()
    return state
  })
  await download.coordinator.check()
  const first = dialogs!.show(f.parent,
    desktopUpdateProgressOptions({ phase: 'downloading', version: '1.2.0', percent: 0 }, locale)!)
  const pending = download.coordinator.download('1.2.0')
  await expect.poll(() => download.coordinator.state.phase).toBe('downloading')
  download.events.emit('download-progress', { percent: 38 })
  expect(f.invoke(UPDATE_DIALOG_IPC.status)).toMatchObject({ progress: { percent: 38 } })
  f.invoke(UPDATE_DIALOG_IPC.respond, 0)
  await first
  download.events.emit('download-progress', { percent: 61 })
  expect(dialogs!.isOpen).toBe(false)
  expect(download.coordinator.state).toMatchObject({ phase: 'downloading', percent: 61 })
  const second = dialogs!.show(f.parent,
    { ...desktopUpdateProgressOptions(download.coordinator.state, locale)!, signal: visible.signal })
  expect(f.invoke(UPDATE_DIALOG_IPC.status)).toMatchObject({ progress: { percent: 61 } })
  download.events.emit('download-progress', { percent: 100 })
  expect(f.invoke(UPDATE_DIALOG_IPC.status)).toMatchObject({ progress: { phase: 'verifying' } })
  download.events.emit('update-downloaded', { version: '1.2.0' })
  download.transfer.resolve(['inert-package'])
  expect(await pending).toEqual({ phase: 'ready', version: '1.2.0' })
  await second
  expect(download.downloadUpdate).toHaveBeenCalledOnce()
  expect(download.quitAndInstall).not.toHaveBeenCalled()
})

it('waits for prompt release before retrying only a current version-bound download', async () => {
  const f = setup()
  const locale = resolveDesktopLocale('zh-CN')
  const download = downloadFixture(state => state)
  download.downloadUpdate.mockRejectedValueOnce(new Error('ERR_CONNECTION_RESET'))
  await download.coordinator.check()
  const failure = await download.coordinator.download('1.2.0')
  expect(desktopUpdateFailureOptions(failure, download.coordinator.state, locale).buttons).toEqual(['重试下载', '关闭'])
  expect(desktopUpdateFailureOptions({ ...failure }, download.coordinator.state, locale).buttons).toEqual(['关闭'])
  const withoutTarget: DesktopUpdateState = { phase: 'error', failedOperation: 'download' }
  expect(desktopUpdateFailureOptions(withoutTarget, withoutTarget, locale).buttons).toEqual(['关闭'])
  const options = desktopUpdateFailureOptions(failure, download.coordinator.state, locale)
  const prompt = dialogs!.show(f.parent, options)
  f.invoke(UPDATE_DIALOG_IPC.respond, 0)
  expect((await prompt).response).toBe(0)
  const released = Promise.withResolvers<undefined>()
  const retry = vi.fn(async () => { await download.coordinator.download('1.2.0') })
  const queued = retryDesktopUpdateDownload(failure, released.promise,
    () => ({ state: download.coordinator.state, allowed: true }), retry)
  await Promise.resolve()
  expect(download.downloadUpdate).toHaveBeenCalledOnce()
  released.resolve(undefined)
  await expect.poll(() => download.downloadUpdate.mock.calls.length).toBe(2)
  download.events.emit('update-downloaded', { version: '1.2.0' })
  download.transfer.resolve(['inert-package'])
  await queued
  expect(download.coordinator.state).toEqual({ phase: 'ready', version: '1.2.0' })
  expect(retry).toHaveBeenCalledOnce()
  expect(download.quitAndInstall).not.toHaveBeenCalled()
})

it.each(['policy', 'target'])('discards an approved retry if %s changes before the prompt owner settles', async (change) => {
  const failure: DesktopUpdateState = { phase: 'error', failedOperation: 'download', version: '1.2.0' }
  const released = Promise.withResolvers<undefined>()
  let current = { state: failure, allowed: true }
  const retry = vi.fn(async () => {})
  const queued = retryDesktopUpdateDownload(failure, released.promise, () => current, retry)
  current = change === 'policy' ? { state: failure, allowed: false } : { state: { ...failure }, allowed: true }
  released.resolve(undefined)
  await queued
  expect(retry).not.toHaveBeenCalled()
})
