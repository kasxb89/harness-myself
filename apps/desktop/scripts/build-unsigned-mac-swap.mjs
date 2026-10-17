/** Build the self-contained atomic installer primitive before outer app signing. */
import { execFile } from 'node:child_process'
import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/**
 * Compile and ad-hoc sign the native macOS swap helper into an assembled app.
 * @param {string} resourcesDirectory - Assembled Contents/Resources directory.
 * @param {string} architecture - Exact electron-builder target architecture.
 * @returns {Promise<string>} Verified helper binary path.
 */
export async function buildUnsignedMacSwap(resourcesDirectory, architecture) {
  if (process.platform !== 'darwin') throw new Error('desktop package: unsigned Mac updates require a macOS build host with Xcode command line tools')
  const nativeArch = architecture === 'arm64' ? 'arm64' : architecture === 'x64' ? 'x86_64' : undefined
  if (nativeArch === undefined) throw new Error('desktop package: unsupported unsigned Mac swap architecture')
  await mkdir(resourcesDirectory, { recursive: true })
  const binary = join(resourcesDirectory, 'unsigned-mac-swap')
  await execute('/usr/bin/xcrun', ['clang', '-arch', nativeArch, '-mmacosx-version-min=12.0', '-Os', '-Wall', '-Wextra', '-Werror',
    fileURLToPath(new URL('../resources/unsigned-mac-swap.c', import.meta.url)), '-o', binary], { timeout: 120_000 })
  await chmod(binary, 0o755)
  await execute('/usr/bin/codesign', ['--force', '--sign', '-', binary], { timeout: 30_000 })
  await execute('/usr/bin/codesign', ['--verify', '--strict', binary], { timeout: 30_000 })
  return binary
}
