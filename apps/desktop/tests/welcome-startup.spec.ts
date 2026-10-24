vi.mock('../src/web-document.ts', () => ({ authenticateWebHost: async () => 'test-cookie', serveWebDocument: vi.fn(), forwardWebRequest: vi.fn() }))
/** Welcome startup uses the Host before transitioning to the workspace. */

import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindowConstructorOptions } from 'electron'
import type { DesktopLocale } from '../src/locale.ts'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import type { WelcomeOperations } from '../src/welcome-api.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'

const state = vi.hoisted(() => ({
  appListeners: new Map<string, (...args: unknown[]) => void>(),
  dialogLocale: undefined as (() => DesktopLocale) | undefined,
  beforeRead: vi.fn(async () => {}),
  realWelcome: false,
  sessionRead: vi.fn<() => Promise<Response>>(),
  beforeWelcome: vi.fn(async () => {}),
  copy: vi.fn(),
  openExternal: vi.fn(),
  expiryListener: undefined as (() => void) | undefined,
  accountListener: undefined as ((value: AccountView) => void) | undefined,
  accountState: vi.fn<() => Promise<AccountView>>().mockResolvedValue({
    status: 'signed-out', attempt: null, links: { usageUrl: '', topUpUrl: '' },
  }),
  quit: vi.fn(),
  dialogShow: vi.fn(),
  startHost: vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:3080/?token=test', injections: [] }),
  stopHost: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  loadWorkspace: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined),
  showWorkspace: vi.fn(),
  showInactiveWorkspace: vi.fn(),
  focusWorkspace: vi.fn(),
  moveTopWorkspace: vi.fn(),
  openDevTools: vi.fn(),
  closeWelcome: vi.fn(),
  welcomeClosed: [] as (() => void)[],
  welcomeLocale: undefined as DesktopLocale | undefined,
  preference: 'zh',
  hasApiKey: false,
  loggedIn: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  contents: undefined as { mainFrame: { url: string } } | undefined,
  windowOptions: undefined as BrowserWindowConstructorOptions | undefined,
  menu: vi.fn(),
  operations: undefined as WelcomeOperations | undefined,
  nativeTheme: { themeSource: 'system', shouldUseDarkColors: false },
}))

vi.mock('../src/crash-report.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/crash-report.ts')>(),
  writeCrashReport: vi.fn(async () => undefined),
  pruneCrashReports: vi.fn(async () => {}),
}))
vi.mock('electron', () => ({
  clipboard: { writeText: state.copy },
  shell: { openExternal: state.openExternal },
  app: {
    isPackaged: false,
    name: 'Harness',
    setName: vi.fn(),
    setPath: vi.fn(),
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient: vi.fn(),
    whenReady: () => Promise.resolve(),
    getLocale: () => 'en',
    getVersion: () => '1.0.0',
    setAboutPanelOptions: vi.fn(),
    getAppPath: () => '/development-app',
    getPath: (name: string) => name === 'userData' ? '/desktop-user-data' : `/development-${name}`,
    setAppLogsPath: vi.fn(),
    getPreferredSystemLanguages: () => ['en-US'],
    on: (name: string, callback: (...args: unknown[]) => void) => { state.appListeners.set(name, callback) },
    quit: state.quit,
    exit: vi.fn(),
  },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
  BrowserWindow: class {
    constructor(options: BrowserWindowConstructorOptions) { state.windowOptions = options }
    private ready: (() => void) | undefined
    webContents = { mainFrame: { url: 'dsh-app://app/' }, setWindowOpenHandler: vi.fn(),
      on: vi.fn(), once: vi.fn(), send: vi.fn(), openDevTools: state.openDevTools }
    static getAllWindows() { return [] }
    once(name: string, callback: () => void) { if (name === 'ready-to-show') this.ready = callback; return this }
    on() { return this }
    isDestroyed() { return false }
    isMinimized() { return false }
    restore = vi.fn()
    focus = state.focusWorkspace
    moveTop = state.moveTopWorkspace
    hide = vi.fn()
    destroy = vi.fn()
    show = state.showWorkspace
    showInactive = state.showInactiveWorkspace
    async loadURL(url: string) { state.contents = this.webContents; await state.loadWorkspace(url); this.ready?.() }
  },
  net: { fetch: vi.fn() },
  nativeTheme: state.nativeTheme,
  session: { defaultSession: {
    setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), webRequest: { onBeforeSendHeaders: vi.fn() },
  } },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  ipcMain: {
    handle: (name: string, callback: (...args: unknown[]) => unknown) => { state.handlers.set(name, callback) },
    on: (name: string, callback: (...args: unknown[]) => void) => { state.listeners.set(name, callback) },
  },
  dialog: { showErrorBox: vi.fn(), showMessageBox: state.dialogShow },
  Menu: { buildFromTemplate: state.menu, setApplicationMenu: vi.fn() },
  nativeImage: { createFromPath: (path: string) => ({ path }) },
}))
// The Windows tray relabels through Menu as well; keep the menu call counts below platform-neutral.
vi.mock('../src/tray.ts', () => ({ DesktopTray: class { relabel() {} dispose() {} } }))

vi.mock('../src/paths.ts', () => ({ resolveDesktopPaths: () => ({ profile: '/profile' }) }))
vi.mock('../src/settings.ts', () => ({ readDesktopSettings: () => ({ updates: { allowTestAuthPopupWindow: false } }) }))
vi.mock('../src/login-shell-environment.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/login-shell-environment.ts')>(),
  readDesktopLoginShellEnvironment: async (base: NodeJS.ProcessEnv) => ({ environment: base, failures: [] }),
}))
vi.mock('../src/project-manager.ts', () => ({ DesktopProjectManager: class {
  applyRelease = vi.fn(async () => {})
  canRecoverProfile = vi.fn(() => true)
} }))
vi.mock('../src/host-process.ts', () => ({
  DesktopHostProcess: class {
    start = state.startHost
    stop = state.stopHost
    inspectQuit = async () => ({ activeTasks: false, scheduledTasks: false })
    fetch() {
      return Promise.resolve(Response.json({
        loggedIn: state.loggedIn, hasApiKey: state.hasApiKey, writable: true, localePreference: state.preference,
      }))
    }
  },
}))
vi.mock('../src/welcome-backend.ts', async importOriginal => ({
  connectDesktopWelcome: async () => {
    if (state.realWelcome) {
      const original = await importOriginal<typeof import('../src/welcome-backend.ts')>()
      const actual = await original.connectDesktopWelcome('http://127.0.0.1:3080/', async (input, init) => {
        if (new URL(input).pathname === '/credits/api/session') return state.sessionRead()
        if (init?.method !== 'POST') return new Response('owned index')
        if (typeof init.body !== 'string') throw new Error('fixture RPC requires a JSON string')
        const { rpcId, method } = JSON.parse(init.body) as { rpcId: string; method: string }
        return Response.json({ type: 'server-response', rpcId, result: { ok: true,
          value: method === 'settings/describe' ? { namespaces: [{ ns: 'locale', value: { preference: 'zh' } }] } : false } })
      })
      return { ...actual, account: { ...actual.account, watch: (
        listener: (value: AccountView) => void, _failed: () => void, expired: () => void,
      ) => {
        state.accountListener = listener
        state.expiryListener = expired
        return () => {}
      } } }
    }
    return {
      dispose: () => {},
      analyticsEnabled: async () => false,
      readLocalePreference: async () => state.preference,
      read: async () => {
        await state.beforeRead()
        return { loggedIn: state.loggedIn, hasApiKey: state.hasApiKey, writable: true, localePreference: state.preference }
      },
      save: async () => ({ ok: true }),
      account: {
        watch: (listener: (value: AccountView) => void, _failed: () => void, expired: () => void) => {
          state.accountListener = listener
          state.expiryListener = expired
          return () => {}
        },
        state: state.accountState,
      },
    }
  },
}))
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  readFile: vi.fn(async () => '{}'),
}))
vi.mock('../src/update-dialog.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/update-dialog.ts')>(), DesktopUpdateDialog: class {
    constructor(_preload: string, locale: () => DesktopLocale) { state.dialogLocale = locale }
    updateProgress() { return false }
    dispose() {}
  } }))
vi.mock('../src/update-coordinator.ts', () => ({ DesktopUpdateCoordinator: class {
  state = { phase: 'idle' }
  check = vi.fn(async () => this.state)
  dispose = vi.fn()
} }))
vi.mock('../src/welcome-window.ts', () => ({
  openWelcomeWindow: async (locale: DesktopLocale, operations: WelcomeOperations) => {
    state.welcomeLocale = locale
    state.operations = operations
    await state.beforeWelcome()
    return { once: vi.fn((name: string, callback: () => void) => { if (name === 'closed') state.welcomeClosed.push(callback) }), close: state.closeWelcome, isDestroyed: () => false,
      show: vi.fn(), hide: vi.fn(), focus: vi.fn(), webContents: { send: vi.fn() } }
  },
}))

afterEach(() => {
  state.realWelcome = false
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function startWithUnavailableSession(platform: 'darwin' | 'win32' = 'darwin', reason: 'network' | 'storage' = 'network'): Promise<void> {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.stubGlobal('process', { ...process, platform })
  vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3')
  vi.stubEnv('DSH_DESKTOP_DEV_PROJECT_DIR', '/development-profile')
  vi.stubEnv('DSH_DESKTOP_NODE_BINARY', '/runtime/node')
  vi.stubEnv('DSH_DESKTOP_PNPM_ENTRY', '/runtime/pnpm')
  vi.stubEnv('DSH_DESKTOP_DSH_DIR', '/runtime/dsh')
  vi.stubEnv('DSH_DESKTOP_PRIMARY_RUNTIME_DIR', '/runtime/primary-runtime')
  vi.stubEnv('DSH_DESKTOP_HOST_INSPECT_PORT', undefined)
  vi.stubEnv('DSH_DESKTOP_OPEN_DEVTOOLS', '0')
  vi.stubEnv('DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', undefined)
  vi.stubEnv('DSH_DESKTOP_UPDATE_JOURNAL_DIR', undefined)
  state.realWelcome = true
  state.operations = undefined
  state.welcomeClosed.length = 0
  state.sessionRead.mockReset().mockImplementation(async () => Response.json({ ok: false, code: 'ACCOUNT_UNAVAILABLE',
    signedIn: true, liveness: 'unknown', failure: { reason, stage: 'account-read' } }))
  await import('../src/main.ts')
  await vi.waitFor(() => { expect(state.operations).toBeDefined() })
}

it.each([
  { platform: 'darwin', reason: 'network' }, { platform: 'darwin', reason: 'storage' }, { platform: 'win32', reason: 'storage' },
] as const)('contains $reason in $platform native startup and opens the workspace only after one verified retry', async ({ platform, reason }) => {
  await startWithUnavailableSession(platform, reason)
  expect(state.dialogShow).not.toHaveBeenCalled()
  expect(state.stopHost).not.toHaveBeenCalled()
  expect(state.showWorkspace).not.toHaveBeenCalled()
  expect(await state.operations!.recoveryState()).toEqual({ kind: 'unavailable', reason })
  const reply = Promise.withResolvers<Response>()
  state.sessionRead.mockReturnValueOnce(reply.promise)
  const first = state.operations!.retrySession()
  const second = state.operations!.retrySession()
  expect(first).toBe(second)
  await vi.waitFor(() => { expect(state.sessionRead).toHaveBeenCalledTimes(2) })
  expect(state.showWorkspace).not.toHaveBeenCalled()
  reply.resolve(Response.json({ ok: true, signedIn: true, liveness: 'verified' }))
  expect(await first).toEqual({ kind: 'ready' })
  expect(state.showWorkspace).toHaveBeenCalledOnce()
  expect(state.closeWelcome).toHaveBeenCalledOnce()
  expect(state.dialogShow).not.toHaveBeenCalled()
})

it('opens the existing phone account panel only after explicit re-login while retaining the unknown session status', async () => {
  await startWithUnavailableSession()
  expect(state.showWorkspace).not.toHaveBeenCalled()
  await state.operations!.skip()
  expect(state.loadWorkspace).toHaveBeenLastCalledWith('dsh-app://app/?panel=credits')
  expect(await state.operations!.recoveryState()).toEqual({ kind: 'unavailable', reason: 'network' })
  expect(state.sessionRead).toHaveBeenCalledOnce()
  expect(state.stopHost).not.toHaveBeenCalled()
})

it.each(['darwin', 'win32'] as const)('discards a verified retry after its %s welcome owner closed', async (platform) => {
  await startWithUnavailableSession(platform)
  const reply = Promise.withResolvers<Response>()
  state.sessionRead.mockReturnValueOnce(reply.promise)
  const retry = state.operations!.retrySession()
  await vi.waitFor(() => { expect(state.sessionRead).toHaveBeenCalledTimes(2) })
  for (const closed of state.welcomeClosed) closed()
  reply.resolve(Response.json({ ok: true, signedIn: true, liveness: 'verified' }))
  expect(await retry).toEqual({ kind: 'unavailable', reason: 'network' })
  expect(state.showWorkspace).not.toHaveBeenCalled()
  expect(state.beforeWelcome).toHaveBeenCalledOnce()
  expect(state.dialogShow).not.toHaveBeenCalled()
})

it.each(['expiry', 'signed-out'] as const)('discards a pending %s account observation after its welcome owner closed', async (event) => {
  await startWithUnavailableSession()
  const reply = Promise.withResolvers<Response>()
  state.sessionRead.mockReturnValueOnce(reply.promise)
  if (event === 'expiry') state.expiryListener!()
  else {
    const account: AccountView = { status: 'credential-stored', attempt: null, links: { usageUrl: '', topUpUrl: '' } }
    state.accountListener!(account)
    state.accountListener!({ ...account, status: 'signed-out' })
  }
  await vi.waitFor(() => { expect(state.sessionRead).toHaveBeenCalledTimes(2) })
  for (const closed of state.welcomeClosed) closed()
  reply.resolve(Response.json({ ok: false, code: 'ACCOUNT_UNAVAILABLE', signedIn: true, liveness: 'unknown' }))
  await vi.advanceTimersByTimeAsync(0)
  expect(state.beforeWelcome).toHaveBeenCalledOnce()
  expect(state.showWorkspace).not.toHaveBeenCalled()
})

it('discards a pending expiry observation after graceful Host shutdown begins', async () => {
  await startWithUnavailableSession('win32')
  const reply = Promise.withResolvers<Response>()
  state.sessionRead.mockReturnValueOnce(reply.promise)
  state.expiryListener!()
  await vi.waitFor(() => { expect(state.sessionRead).toHaveBeenCalledTimes(2) })
  state.appListeners.get('before-quit')!({ preventDefault: vi.fn() })
  await vi.waitFor(() => { expect(state.stopHost).toHaveBeenCalledOnce() })
  reply.resolve(Response.json({ ok: false, code: 'ACCOUNT_UNAVAILABLE', signedIn: true, liveness: 'unknown' }))
  await vi.advanceTimersByTimeAsync(0)
  expect(state.beforeWelcome).toHaveBeenCalledOnce()
  expect(state.showWorkspace).not.toHaveBeenCalled()
})

it.each([false, true])('starts welcome onboarding without carrying update focus into login or skip (Windows update=%s)', async (updated) => {
  vi.resetModules()
  vi.clearAllMocks()
  state.preference = 'zh'
  state.hasApiKey = false
  state.loggedIn = false
  state.operations = undefined
  state.accountState.mockResolvedValue({ status: 'signed-out', attempt: null, links: { usageUrl: '', topUpUrl: '' } })
  if (updated) vi.stubGlobal('process', { ...process, platform: 'win32', argv: ['desktop', '--updated'] })
  vi.useFakeTimers()
  vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3')
  vi.stubEnv('DSH_DESKTOP_DEV_PROJECT_DIR', '/development-profile')
  vi.stubEnv('DSH_DESKTOP_NODE_BINARY', '/runtime/node')
  vi.stubEnv('DSH_DESKTOP_PNPM_ENTRY', '/runtime/pnpm')
  vi.stubEnv('DSH_DESKTOP_DSH_DIR', '/runtime/dsh')
  vi.stubEnv('DSH_DESKTOP_PRIMARY_RUNTIME_DIR', '/runtime/primary-runtime')
  vi.stubEnv('DSH_DESKTOP_HOST_INSPECT_PORT', undefined)
  vi.stubEnv('DSH_DESKTOP_OPEN_DEVTOOLS', '0')
  vi.stubEnv('DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', undefined)
  vi.stubEnv('DSH_DESKTOP_UPDATE_JOURNAL_DIR', undefined)
  const reading = Promise.withResolvers<undefined>()
  const loading = Promise.withResolvers<undefined>()
  state.beforeRead.mockReturnValueOnce(reading.promise)
  state.beforeWelcome.mockReturnValueOnce(loading.promise)
  const activate = () => {
    state.appListeners.get('second-instance')!()
    state.appListeners.get('open-url')!({ preventDefault: vi.fn() }, 'dsh://open')
  }
  await import('../src/main.ts')
  await vi.waitFor(() => { expect(state.beforeRead).toHaveBeenCalledOnce() })
  try {
    activate()
    expect(state.showWorkspace).not.toHaveBeenCalled()
    reading.resolve(undefined)
    await vi.waitFor(() => { expect(state.beforeWelcome).toHaveBeenCalledOnce() })
    activate()
    expect(state.showWorkspace).not.toHaveBeenCalled()
  } finally {
    reading.resolve(undefined)
    loading.resolve(undefined)
  }
  await vi.waitFor(() => { expect(state.operations).toBeDefined() })
  expect(state.startHost).toHaveBeenCalledOnce()
  expect(state.loadWorkspace).toHaveBeenCalledExactlyOnceWith('dsh-app://app/')
  expect(state.showWorkspace).not.toHaveBeenCalled()
  state.loadWorkspace.mockClear()
  expect(state.welcomeLocale).toMatchObject({ id: 'zh-CN' })
  expect(await state.operations!.takeNotice()).toBeUndefined()
  expect(state.dialogLocale!().id).toBe('zh-CN')
  const attemptId = 'login' as NonNullable<AccountView['attempt']>['id']
  const account: AccountView = { status: 'signed-out', links: { usageUrl: '', topUpUrl: '' },
    attempt: { id: attemptId, phase: 'waiting-browser', authorizeUrl: 'https://example.test/login' } }
  state.accountState.mockResolvedValue(account)
  state.accountListener!(account)
  expect(state.openExternal).not.toHaveBeenCalled()
  expect(state.showWorkspace).not.toHaveBeenCalled()
  await state.operations!.copySignInLink(attemptId)
  expect(state.copy).toHaveBeenCalledExactlyOnceWith('https://example.test/login?theme=light')
  state.nativeTheme.shouldUseDarkColors = true
  await state.operations!.copySignInLink(attemptId)
  expect(state.copy).toHaveBeenLastCalledWith('https://example.test/login?theme=dark')
  state.nativeTheme.shouldUseDarkColors = false
  await expect(state.operations!.copySignInLink('stale' as typeof attemptId)).rejects.toThrow('login link is unavailable')
  state.accountState.mockResolvedValue({ ...account, attempt: { id: attemptId, phase: 'expired' } })
  await expect(state.operations!.copySignInLink(attemptId)).rejects.toThrow('login link is unavailable')
  expect(state.copy).toHaveBeenCalledTimes(2)
  await state.operations!.skip()
  expect(state.loadWorkspace).toHaveBeenCalledExactlyOnceWith('dsh-app://app/?panel=credits')
  expect(state.showWorkspace).toHaveBeenCalledOnce()
  expect(state.moveTopWorkspace).not.toHaveBeenCalled()
  expect(state.focusWorkspace).not.toHaveBeenCalled()
  expect(state.windowOptions).toMatchObject({
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 }, vibrancy: 'sidebar' } : {}),
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  expect(state.closeWelcome).toHaveBeenCalledOnce()
  activate()
  expect(state.showWorkspace).toHaveBeenCalledTimes(3)
  expect(state.quit).not.toHaveBeenCalled()
  expect(state.stopHost).not.toHaveBeenCalled()
  const contents = state.contents as { mainFrame: { url: string }; send: ReturnType<typeof vi.fn> }
  expect(contents.send).toHaveBeenCalledWith(DESKTOP_IPC.enterWorkspace)
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const bootstrap = state.handlers.get(DESKTOP_IPC.localeBootstrap)!
  expect(await bootstrap(event)).toEqual({ languages: ['en-US'], preference: 'zh' })
  state.preference = 'en'
  expect(await bootstrap(event)).toEqual({ languages: ['en-US'], preference: 'en' })
  const changed = state.listeners.get(DESKTOP_IPC.localeChanged)!
  const initialMenus = state.menu.mock.calls.length
  changed({ ...event, senderFrame: {} }, 'en')
  changed(event, 42)
  expect(state.menu).toHaveBeenCalledTimes(initialMenus)
  changed(event, 'en')
  expect(state.dialogLocale!().id).toBe('en')
  expect(state.menu).toHaveBeenCalledTimes(initialMenus + 1)
  expect(await bootstrap(event)).toEqual({ languages: ['en-US'], preference: 'en' })
  const welcomeCount = state.beforeWelcome.mock.calls.length
  state.hasApiKey = true
  state.loggedIn = true
  state.accountListener!({ ...account, status: 'credential-stored', attempt: null })
  state.accountListener!({ ...account, status: 'signed-out', attempt: null })
  state.expiryListener!()
  await vi.advanceTimersByTimeAsync(0)
  expect(state.beforeWelcome).toHaveBeenCalledTimes(welcomeCount)
  expect(await state.operations!.takeNotice()).toBeUndefined()
  state.hasApiKey = false
  state.loggedIn = false
  state.accountListener!({ ...account, status: 'credential-stored', attempt: null })
  state.accountListener!({ ...account, status: 'signed-out', attempt: null })
  state.expiryListener!()
  await vi.waitFor(() => { expect(state.beforeWelcome).toHaveBeenCalledTimes(welcomeCount + 1) })
  expect(await state.operations!.takeNotice()).toBe('session-expired')
  expect(await state.operations!.takeNotice()).toBeUndefined()
  state.accountListener!({ ...account, status: 'signed-out', attempt: null })
  await vi.advanceTimersByTimeAsync(0)
  expect(await state.operations!.takeNotice()).toBeUndefined()
  state.accountListener!({ ...account, status: 'credential-stored', attempt: null })
  state.accountListener!({ ...account, status: 'signed-out', attempt: null })
  await vi.advanceTimersByTimeAsync(0)
  expect(await state.operations!.takeNotice()).toBeUndefined()
  state.showWorkspace.mockClear()
  state.focusWorkspace.mockClear()
  vi.stubEnv('DSH_DESKTOP_OPEN_DEVTOOLS', '1')
  state.accountListener!({ ...account, status: 'credential-stored', attempt: { id: attemptId, phase: 'succeeded' } })
  await vi.advanceTimersByTimeAsync(0)
  expect(state.showInactiveWorkspace).not.toHaveBeenCalled()
  expect(state.showWorkspace).not.toHaveBeenCalled()
  expect(state.focusWorkspace).not.toHaveBeenCalled()
  expect(state.moveTopWorkspace).not.toHaveBeenCalled()
  expect(state.openDevTools).not.toHaveBeenCalled()
  await state.operations!.skip()
  expect(state.showWorkspace).toHaveBeenCalledOnce()
  state.showWorkspace.mockClear()
  state.appListeners.get('open-url')!({ preventDefault: vi.fn() }, 'dsh://open')
  expect(state.showWorkspace).toHaveBeenCalledOnce()
  expect(state.focusWorkspace).toHaveBeenCalledOnce()

})

it.each([false, true])('opens the workspace directly for a persisted product login (provider key=%s)', async (hasApiKey) => {
  vi.resetModules()
  vi.clearAllMocks()
  state.preference = 'zh'
  state.hasApiKey = hasApiKey
  state.loggedIn = true
  state.operations = undefined
  state.accountState.mockResolvedValue({ status: 'signed-out', attempt: null, links: { usageUrl: '', topUpUrl: '' } })
  vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3')
  vi.stubEnv('DSH_DESKTOP_DEV_PROJECT_DIR', '/development-profile')
  vi.stubEnv('DSH_DESKTOP_NODE_BINARY', '/runtime/node')
  vi.stubEnv('DSH_DESKTOP_PNPM_ENTRY', '/runtime/pnpm')
  vi.stubEnv('DSH_DESKTOP_DSH_DIR', '/runtime/dsh')
  vi.stubEnv('DSH_DESKTOP_PRIMARY_RUNTIME_DIR', '/runtime/primary-runtime')
  vi.stubEnv('DSH_DESKTOP_HOST_INSPECT_PORT', undefined)
  vi.stubEnv('DSH_DESKTOP_OPEN_DEVTOOLS', '0')
  vi.stubEnv('DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', undefined)
  vi.stubEnv('DSH_DESKTOP_UPDATE_JOURNAL_DIR', undefined)
  await import('../src/main.ts')
  await vi.waitFor(() => { expect(state.showWorkspace).toHaveBeenCalledOnce() })
  expect(state.operations).toBeUndefined()
  expect(state.beforeWelcome).not.toHaveBeenCalled()
  expect(state.loadWorkspace).toHaveBeenCalledExactlyOnceWith('dsh-app://app/')
})
