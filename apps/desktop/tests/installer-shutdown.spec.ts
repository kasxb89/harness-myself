import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { DesktopInstallerShutdown, DESKTOP_INSTALLER_SHUTDOWN_MAGIC, DESKTOP_INSTALLER_SHUTDOWN_MESSAGE } from '../src/installer-shutdown.ts'

function parameter(value: number): Buffer {
  const buffer = Buffer.alloc(8)
  buffer.writeUInt32LE(value)
  return buffer
}

describe('local installer shutdown entry', () => {
  it('matches the native installer protocol and leaves other platforms untouched', () => {
    const native = readFileSync(new URL('../installer/upgrade-shutdown.h', import.meta.url), 'utf8')
    expect(native).toContain('Message = WM_APP + 0x594')
    expect(native).toContain(`Magic = 0x${DESKTOP_INSTALLER_SHUTDOWN_MAGIC.toString(16)}`)
    expect(native).toContain('Version = 1')
    const hookWindowMessage = vi.fn()
    new DesktopInstallerShutdown(vi.fn()).bind({ hookWindowMessage }, 'darwin')
    expect(hookWindowMessage).not.toHaveBeenCalled()
  })

  it('ignores malformed and unrelated messages, joins repeated requests, and permits an explicit retry after cancellation', () => {
    const quit = vi.fn()
    const shutdown = new DesktopInstallerShutdown(quit)
    const hookWindowMessage = vi.fn()
    shutdown.bind({ hookWindowMessage }, 'win32')
    expect(hookWindowMessage).toHaveBeenCalledWith(DESKTOP_INSTALLER_SHUTDOWN_MESSAGE, expect.any(Function))
    const receive = hookWindowMessage.mock.calls[0]![1] as (w: Buffer, l: Buffer) => void
    receive(Buffer.alloc(0), parameter(1))
    receive(parameter(DESKTOP_INSTALLER_SHUTDOWN_MAGIC), Buffer.alloc(0))
    receive(parameter(1), parameter(1))
    receive(parameter(DESKTOP_INSTALLER_SHUTDOWN_MAGIC), parameter(2))
    expect(quit).not.toHaveBeenCalled()
    receive(parameter(DESKTOP_INSTALLER_SHUTDOWN_MAGIC), parameter(1))
    receive(parameter(DESKTOP_INSTALLER_SHUTDOWN_MAGIC), parameter(1))
    expect(quit).toHaveBeenCalledOnce()
    expect(shutdown.pending).toBe(true)
    shutdown.cancel()
    expect(shutdown.pending).toBe(false)
    receive(parameter(DESKTOP_INSTALLER_SHUTDOWN_MAGIC), parameter(1))
    expect(quit).toHaveBeenCalledTimes(2)
  })

  it('checks the full installation tree after sending a quit message and never selects a force-kill fallback', () => {
    const script = readFileSync(new URL('../scripts/installer.nsh', import.meta.url), 'utf8')
    const check = script.slice(script.indexOf('!macro customCheckAppRunning'))
    expect(check).toContain('InstallerRequestShutdown')
    expect(check).toContain('InstallerFindInstallationProcess')
    expect(check).toContain('DSH_SHUTDOWN_WAIT_ITERATIONS 240')
    expect(check).toContain('Call dshCleanupDirectories')
    expect(check).not.toMatch(/taskkill|Stop-Process|TerminateProcess|KILL_PROCESS/)
    const init = script.slice(script.indexOf('!macro customInit'), script.indexOf('!macro customInstallMode'))
    expect(init).not.toContain('Call InstallerCheckAppRunning')
  })
})
