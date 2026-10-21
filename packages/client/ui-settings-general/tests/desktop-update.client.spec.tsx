// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { DesktopUpdateIndicator } from '../src/client/DesktopUpdateIndicator.tsx'
import { DesktopUpdateCheck } from '../src/client/DesktopUpdateCheck.tsx'
import type { DesktopUpdateBridge, DesktopUpdatePresentation } from '../src/types.ts'
import { DesktopUpdateSource } from '../src/client/desktop-update-source.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

type SettingsTranslate = PropsLocale<'settings'>['t']

function translate(dictionary: typeof zh | typeof en): SettingsTranslate {
  const messages: Readonly<Record<string, string>> = dictionary
  return (key, params) => Object.entries(params ?? {})
    .reduce((message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
      messages[key] ?? key)
}

function fixture() {
  let listener: ((state: DesktopUpdatePresentation) => void) | undefined
  const status = Promise.withResolvers<DesktopUpdatePresentation>()
  const unsubscribe = vi.fn()
  const open = vi.fn(async () => {})
  const check = vi.fn(async () => {})
  const bridge: DesktopUpdateBridge = {
    status: () => status.promise,
    open,
    check,
    subscribe: (next) => { listener = next; return unsubscribe },
  }
  const source = new DesktopUpdateSource(bridge)
  const subscribe = (notify: () => void) => source.store.subscribe(notify)
  const snapshot = () => source.store.getSnapshot()
  function Indicator({ wide = true, hidden = false, dictionary = zh }: {
    wide?: boolean
    hidden?: boolean
    dictionary?: typeof zh | typeof en
  }) {
    const state = useSyncExternalStore(subscribe, snapshot)
    return <DesktopUpdateIndicator wide={wide} hidden={hidden} t={translate(dictionary)} view={state} onOpen={() => { source.open() }} />
  }
  function Check({ wide = true, sidebar = false, dictionary = zh }: {
    wide?: boolean
    sidebar?: boolean
    dictionary?: typeof zh | typeof en
  }) {
    const state = useSyncExternalStore(subscribe, snapshot)
    return <DesktopUpdateCheck desktopUpdateAvailable useDesktopUpdate={select => select(state)}
      activateDesktopUpdate={() => { source.activate() }} t={translate(dictionary)} sidebar={sidebar} wide={wide} />
  }
  const view = render(<Indicator />)
  const unmount = view.unmount
  view.unmount = () => { source.dispose(); unmount() }
  return { open, check, status, unsubscribe, view, Indicator, Check, source, emit: async (state: DesktopUpdatePresentation) => {
    await act(async () => { listener?.(state) })
  } }
}

const available = { phase: 'available', version: '1.0.1' } as const

it('renders nothing outside the Desktop carrier', () => {
  const source = new DesktopUpdateSource(undefined)
  const view = render(<DesktopUpdateIndicator wide hidden={false} t={translate(zh)}
    view={source.store.getSnapshot()} onOpen={() => { source.open() }} />)
  source.open()
  source.check()
  source.activate()
  source.dispose()
  expect(view.container.innerHTML).toBe('')
})

it('changes permanent checks into update actions and retains the discovered release in either sidebar width', async () => {
  const f = fixture()
  try {
    await f.emit({ phase: 'idle' })
    f.view.rerender(<f.Check sidebar />)
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }))
    await act(async () => {})
    expect(f.check).toHaveBeenCalledOnce()
    await f.emit(available)
    const output: Array<{ wide: boolean; label: string | null; detail: string | null }> = []
    for (const wide of [true, false]) {
      f.view.rerender(<f.Check sidebar wide={wide} />)
      const action = screen.getByRole('button', { name: '更新版本' })
      fireEvent.focus(action)
      output.push({ wide, label: action.textContent, detail: (await screen.findByRole('tooltip')).textContent })
      fireEvent.click(action)
      await act(async () => {})
    }
    expect(output).toMatchSnapshot()
    expect(f.open).toHaveBeenCalledTimes(2)
    expect(f.check).toHaveBeenCalledOnce()
    await f.emit({ phase: 'ready', version: available.version })
    f.view.rerender(<f.Check dictionary={en} />)
    fireEvent.click(screen.getByRole('button', { name: 'Update version' }))
    await act(async () => {})
    expect(f.open).toHaveBeenCalledTimes(3)
    expect(f.check).toHaveBeenCalledOnce()
  } finally { f.view.unmount(); f.status.resolve(available) }
})

it.each([
  'download', 'download-network', 'install', 'install-network', 'stop-failed', 'tasks-changed', 'tasks-unavailable',
] as const)('resumes %s for a discovered release instead of checking again', async (failure) => {
  const f = fixture()
  try {
    await f.emit({ phase: 'error', version: available.version, failure })
    f.view.rerender(<f.Check />)
    fireEvent.click(screen.getByRole('button', { name: '更新版本' }))
    await act(async () => {})
    expect(f.open).toHaveBeenCalledOnce()
    expect(f.check).not.toHaveBeenCalled()
  } finally { f.view.unmount(); f.status.resolve(available) }
})

it.each([
  { phase: 'error', version: '1.0.1', failure: 'check' },
  { phase: 'error', version: '1.0.1', failure: 'source-invalid' },
  { phase: 'error', failure: 'download' },
] satisfies DesktopUpdatePresentation[])('checks again when an error has no resumable release: %j', async (state) => {
  const f = fixture()
  try {
    await f.emit(state)
    f.view.rerender(<f.Check />)
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }))
    await act(async () => {})
    expect(f.check).toHaveBeenCalledOnce()
    expect(f.open).not.toHaveBeenCalled()
  } finally { f.view.unmount(); f.status.resolve(available) }
})

it('keeps update confirmation pending without calling it a check and reopens only active progress', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<undefined>()
  try {
    await f.emit(available)
    f.view.rerender(<f.Check />)
    f.open.mockImplementationOnce(() => pending.promise)
    const action = screen.getByRole('button', { name: '更新版本' })
    fireEvent.click(action)
    await act(async () => {})
    expect(action.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(action)
    expect(f.open).toHaveBeenCalledOnce()
    await f.emit({ phase: 'downloading', version: available.version, percent: 42 })
    fireEvent.click(screen.getByRole('button', { name: '下载中 42%' }))
    await act(async () => {})
    expect(f.open).toHaveBeenCalledTimes(2)
    await f.emit({ phase: 'verifying', version: available.version })
    fireEvent.click(screen.getByRole('button', { name: '正在校验更新文件…' }))
    await act(async () => {})
    expect(f.open).toHaveBeenCalledTimes(3)
    await f.emit({ phase: 'installing', version: available.version })
    fireEvent.click(screen.getByRole('button', { name: '正在准备重启…' }))
    expect(f.open).toHaveBeenCalledTimes(3)
    expect(f.check).not.toHaveBeenCalled()
  } finally { f.view.unmount(); pending.resolve(undefined); f.status.resolve(available) }
})

it('runs a manual check separately from accepting an available update and coalesces duplicate checks', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<undefined>()
  try {
    await f.emit(available)
    f.check.mockImplementationOnce(() => pending.promise)
    await act(async () => { f.source.check(); f.source.check(); f.source.open() })
    expect(f.check).toHaveBeenCalledOnce()
    expect(f.open).not.toHaveBeenCalled()
    await f.emit({ phase: 'checking' })
    f.source.check()
    expect(f.check).toHaveBeenCalledOnce()
    await f.emit({ phase: 'downloading', version: '1.0.1', percent: 42 })
    await act(async () => { f.source.check() })
    expect(f.check).toHaveBeenCalledTimes(2)
    await act(async () => { pending.resolve(undefined) })
    f.view.unmount()
    f.source.check()
    expect(f.check).toHaveBeenCalledTimes(2)
  } finally { f.view.unmount(); pending.resolve(undefined); f.status.resolve(available) }
})

it('keeps legacy v1 status actions while a missing manual-check capability is inert', async () => {
  const open = vi.fn(async () => {})
  const source = new DesktopUpdateSource({
    status: async () => available,
    open,
    subscribe: () => () => {},
  })
  await Promise.resolve()
  expect(() => { source.check() }).not.toThrow()
  expect(() => { source.activate() }).not.toThrow()
  expect(source.store.getSnapshot().opening).toBe(false)
  expect(source.store.getSnapshot().failed).toBe(false)
  source.open()
  await Promise.resolve()
  expect(open).toHaveBeenCalledOnce()
  source.dispose()
})

it('contains synchronous bridge failures and releases the pending check for retry', async () => {
  const f = fixture()
  try {
    await f.emit(available)
    f.check.mockImplementationOnce(() => { throw new Error('old preload failure') })
    await act(async () => { expect(() => { f.source.check() }).not.toThrow() })
    expect(f.source.store.getSnapshot()).toMatchObject({ failed: true, opening: false })
    await act(async () => { f.source.check() })
    expect(f.check).toHaveBeenCalledTimes(2)
    expect(f.source.store.getSnapshot().opening).toBe(false)
  } finally { f.view.unmount(); f.status.resolve(available) }
})

it('keeps the newest event, hides for connection priority, and invokes only the shell action', async () => {
  const f = fixture()
  try {
    await f.emit(available)
    await act(async () => { f.status.resolve({ phase: 'idle' }) })
    fireEvent.click(screen.getByRole('button', { name: '新版本' }))
    await act(async () => {})
    expect(f.open).toHaveBeenCalledOnce()
    f.view.rerender(<f.Indicator hidden />)
    expect(screen.queryByRole('button')).toBeNull()
    await f.emit({ phase: 'downloading', version: available.version, percent: 58 })
    f.view.rerender(<f.Indicator />)
    fireEvent.click(screen.getByRole('button', { name: '58%' }))
    await act(async () => {})
    expect(f.open).toHaveBeenCalledTimes(2)
    await f.emit({ phase: 'error', version: available.version, failure: 'download' })
    const retry = screen.getByRole('button', { name: '重试更新' })
    fireEvent.focus(retry)
    expect((await screen.findByRole('tooltip')).textContent).toBe('下载更新失败，请重试。')
    f.view.rerender(<f.Indicator wide={false} />)
    expect(screen.queryByRole('button')).toBeNull()
  } finally { f.view.unmount(); f.status.resolve(available) }
  expect(f.unsubscribe).toHaveBeenCalledOnce()
})

it('keeps bridge failures actionable and ignores status completion after unmount', async () => {
  const f = fixture()
  await act(async () => { f.status.reject(new Error('IPC unavailable')) })
  f.open.mockRejectedValueOnce(new Error('IPC unavailable'))
  fireEvent.click(screen.getByRole('button', { name: '重试更新' }))
  await act(async () => {})
  f.view.unmount()
  const late = fixture()
  late.view.unmount()
  await act(async () => { late.status.resolve(available) })
  expect(late.unsubscribe).toHaveBeenCalledOnce()
})

it('accepts initial status, coalesces actions, and ignores late events and action rejection after disposal', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<undefined>()
  try {
    await act(async () => { f.status.resolve(available) })
    expect(screen.getByRole('button', { name: '新版本' })).toBeTruthy()
    await f.emit({ phase: 'checking', version: available.version })
    f.source.open()
    expect(f.open).not.toHaveBeenCalled()
    await f.emit(available)
    f.open.mockImplementationOnce(() => pending.promise)
    await act(async () => { f.source.open(); f.source.open() })
    expect(f.open).toHaveBeenCalledOnce()
    const state = f.source.store.getSnapshot()
    f.view.unmount()
    f.source.open()
    await f.emit({ phase: 'error', version: available.version, failure: 'install' })
    await act(async () => { pending.reject(new Error('late IPC failure')) })
    expect(f.source.store.getSnapshot()).toBe(state)
  } finally { pending.resolve(undefined); f.status.resolve(available) }
})

it('reopens download and verification progress while the original shell action is pending', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<undefined>()
  try {
    await act(async () => { f.status.resolve(available) })
    f.open.mockImplementationOnce(() => pending.promise)
    fireEvent.click(screen.getByRole('button', { name: '新版本' }))
    expect(f.source.store.getSnapshot().opening).toBe(true)
    await f.emit({ phase: 'downloading', version: available.version, percent: 42 })
    const download = screen.getByRole('button', { name: '42%' })
    expect(download.getAttribute('aria-disabled')).toBe('false')
    fireEvent.click(download)
    await act(async () => {})
    expect(f.open).toHaveBeenCalledTimes(2)
    expect(f.source.store.getSnapshot().opening).toBe(true)
    await f.emit({ phase: 'verifying', version: available.version })
    const verification = screen.getByRole('button', { name: '正在校验更新文件…' })
    expect(verification.getAttribute('aria-disabled')).toBe('false')
    fireEvent.click(verification)
    await act(async () => {})
    expect(f.open).toHaveBeenCalledTimes(3)
    await f.emit({ phase: 'installing', version: available.version })
    fireEvent.click(screen.getByRole('button', { name: '正在准备重启…' }))
    expect(f.open).toHaveBeenCalledTimes(3)
    await act(async () => { pending.resolve(undefined) })
    expect(f.source.store.getSnapshot().opening).toBe(false)
  } finally { f.view.unmount(); pending.resolve(undefined); f.status.resolve(available) }
})

it('keeps a failed progress-window reopen retryable without replacing the download state', async () => {
  const f = fixture()
  try {
    await f.emit({ phase: 'downloading', version: available.version, percent: 42 })
    f.open.mockRejectedValueOnce(new Error('IPC unavailable'))
    fireEvent.click(screen.getByRole('button', { name: '42%' }))
    await act(async () => {})
    expect(f.source.store.getSnapshot().presentation?.phase).toBe('downloading')
    const retry = screen.getByRole('button', { name: '重试更新' })
    expect(retry.getAttribute('aria-disabled')).toBe('false')
    fireEvent.click(retry)
    await act(async () => {})
    expect(f.open).toHaveBeenCalledTimes(2)
  } finally { f.view.unmount(); f.status.resolve(available) }
})

it('keeps an event newer than an initial-status failure', async () => {
  const f = fixture()
  try {
    await f.emit(available)
    await act(async () => { f.status.reject(new Error('stale initial request')) })
    expect(f.source.store.getSnapshot().failed).toBe(false)
  } finally { f.view.unmount(); f.status.resolve(available) }
})

it('renders the same semantic update in the active Web locale', async () => {
  const f = fixture()
  try {
    await f.emit(available)
    expect(screen.getByRole('button', { name: '新版本' })).toBeTruthy()
    f.view.rerender(<f.Indicator dictionary={en} />)
    expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy()
  } finally { f.view.unmount(); f.status.resolve(available) }
})

it('offers installation and restart in both locales through the existing shell action', async () => {
  const f = fixture()
  const output: Array<{ label: string | null; detail: string | null }> = []
  try {
    await f.emit({ phase: 'ready', version: '1.1.0' })
    for (const dictionary of [zh, en]) {
      f.view.rerender(<f.Indicator dictionary={dictionary} />)
      const button = screen.getByRole('button', { name: dictionary['desktop.update.ready'] })
      fireEvent.focus(button)
      output.push({ label: button.textContent, detail: (await screen.findByRole('tooltip')).textContent })
    }
    expect(output).toMatchSnapshot()
    fireEvent.click(screen.getByRole('button', { name: 'Install and Restart' }))
    await act(async () => {})
    expect(f.open).toHaveBeenCalledOnce()
    await f.emit({ phase: 'installing', version: '1.1.0' })
    expect(screen.getByRole('button', { name: 'Preparing to restart…' }).getAttribute('aria-disabled')).toBe('true')
  } finally { f.view.unmount(); f.status.resolve({ phase: 'idle' }) }
})

it.each([
  'source-unbound', 'source-unavailable', 'source-invalid', 'source-disabled',
  'source-target-missing', 'source-unsupported-target', 'source-development',
] as const)('keeps %s actionable with localized guidance', async (failure) => {
  const f = fixture()
  try {
    await f.emit({ phase: 'error', failure })
    const retry = screen.getByRole('button', { name: '重试更新' })
    fireEvent.focus(retry)
    const chinese = (await screen.findByRole('tooltip')).textContent
    expect(retry.getAttribute('aria-disabled')).toBe('false')
    f.view.rerender(<f.Indicator dictionary={en} />)
    const englishRetry = screen.getByRole('button', { name: 'Retry update' })
    fireEvent.focus(englishRetry)
    const english = (await screen.findByRole('tooltip')).textContent
    expect({ chinese, english }).toMatchSnapshot()
    fireEvent.click(englishRetry)
    await act(async () => {})
    expect(f.open).toHaveBeenCalledOnce()
  } finally { f.view.unmount(); f.status.resolve({ phase: 'idle' }) }
})

it('shows fallback progress and error details when the shell omits optional fields', async () => {
  const f = fixture()
  try {
    await f.emit({ phase: 'downloading' })
    const progress = screen.getByRole('button', { name: '0%' })
    fireEvent.focus(progress)
    expect((await screen.findByRole('tooltip')).textContent).toBe('0%')
    await f.emit({ phase: 'downloading', version: '1.0.1' })
    fireEvent.focus(screen.getByRole('button', { name: '0%' }))
    expect((await screen.findByRole('tooltip')).textContent).toContain('1.0.1')
    await f.emit({ phase: 'error' })
    fireEvent.focus(screen.getByRole('button', { name: '重试更新' }))
    expect((await screen.findByRole('tooltip')).textContent).toBe('安装更新失败，请稍后重试。')
  } finally { f.view.unmount(); f.status.resolve({ phase: 'idle' }) }
})

it.each(['checking', 'verifying', 'installing'] as const)('shows only the version during %s in both locales', async (phase) => {
  const f = fixture()
  try {
    await f.emit({ phase, version: '0.1.7-alpha.2' })
    fireEvent.focus(screen.getByRole('button'))
    expect((await screen.findByRole('tooltip')).textContent).toBe('0.1.7-alpha.2')
    f.view.rerender(<f.Indicator dictionary={en} />)
    fireEvent.focus(screen.getByRole('button'))
    expect((await screen.findByRole('tooltip')).textContent).toBe('0.1.7-alpha.2')
  } finally { f.view.unmount(); f.status.resolve({ phase: 'idle' }) }
})

it.each([
  ['checking', '正在检查更新…'],
  ['verifying', '正在校验更新文件…'],
  ['installing', '正在准备重启…'],
] as const)('retains the state label when %s has no version', async (phase, label) => {
  const f = fixture()
  try {
    await f.emit({ phase })
    fireEvent.focus(screen.getByRole('button', { name: label }))
    expect((await screen.findByRole('tooltip')).textContent).toBe(label)
  } finally { f.view.unmount(); f.status.resolve({ phase: 'idle' }) }
})
