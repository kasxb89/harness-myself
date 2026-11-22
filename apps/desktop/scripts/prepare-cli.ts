/** Package terminal launch scripts that reuse the installed Electron runtime. */

import { chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Copy the platform launcher into the application's public command directory.
 * @param destination - Physical runtime/cli directory prepared for the application.
 * @param platform - Target Desktop operating system.
 */
export function prepareDesktopCli(destination: string, platform: 'darwin' | 'win32' | 'linux'): void {
  const name = platform === 'win32' ? 'yunshu.cmd' : 'yunshu'
  const source = platform === 'win32' ? 'dsh.cmd' : platform === 'linux' ? 'dsh-linux' : 'dsh'
  const command = join(destination, 'bin', name)
  mkdirSync(join(destination, 'bin'), { recursive: true })
  copyFileSync(join(import.meta.dirname, '..', 'cli', source), command)
  // This is the private prepared output, not the user's PATH or another installation.
  for (const previous of ['dsh', 'dsh.cmd']) rmSync(join(destination, 'bin', previous), { force: true })
  if (platform !== 'win32') chmodSync(command, 0o755)
}
