/** Prepare a private Host loader without replacing any system library. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { downloadPrimaryRuntimeAsset } from '../../../scripts/primary-runtime/prepare.ts'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'
import lock from './kylin-compat-lock.json' with { type: 'json' }

/**
 * Build the fixed-prefix Kylin Host from hash-pinned Debian libraries and the selected Electron.
 * The dedicated build container must map the fixed install prefix to its staged runtime.
 * @returns Resolves after private-loader and source/license inventory verification.
 */
export async function prepareKylinCompatibilityRuntime(): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Kylin compatibility runtime requires Linux x64')
  const paths = desktopTargetBuildPaths('linux-x64')
  const root = join(paths.runtime, 'kylin-compat')
  const staging = mkdtempSync(join(tmpdir(), 'kylin-compat-'))
  try {
    rmSync(root, { recursive: true, force: true })
    for (const asset of lock.assets) {
      const archive = await downloadPrimaryRuntimeAsset(asset.url, asset.sha256, paths.downloads)
      execFileSync('dpkg-deb', ['--extract', archive, staging])
    }
    mkdirSync(join(root, 'bin'), { recursive: true })
    mkdirSync(join(root, 'lib'), { recursive: true })
    mkdirSync(join(root, 'licenses'), { recursive: true })
    for (const parent of ['lib/x86_64-linux-gnu', 'usr/lib/x86_64-linux-gnu']) {
      const directory = join(staging, parent)
      if (!existsSync(directory)) continue
      for (const name of readdirSync(directory)) {
        if (/\.so(?:\.|$)/u.test(name)) copyFileSync(join(directory, name), join(root, 'lib', name))
      }
    }
    copyFileSync(join(paths.electron, 'electron'), join(root, 'bin', 'node'))
    copyFileSync(join(paths.electron, 'libffmpeg.so'), join(root, 'lib', 'libffmpeg.so'))
    for (const name of readdirSync(paths.electron)) {
      if (name === 'icudtl.dat' || /snapshot.*\.bin$/u.test(name)) copyFileSync(join(paths.electron, name), join(root, 'bin', name))
    }
    for (const name of ['libc6', 'gcc-12-base']) {
      copyFileSync(join(staging, 'usr/share/doc', name, 'copyright'), join(root, 'licenses', `${name}.txt`))
    }
    for (const name of ['LGPL-2.1', 'LGPL-3', 'GPL-3']) {
      copyFileSync(join('/usr/share/common-licenses', name), join(root, 'licenses', `${name}.txt`))
    }
    const interpreter = join(lock.installRoot, 'resources/runtime/kylin-compat/lib/ld-linux-x86-64.so.2')
    const executable = join(root, 'bin', 'node')
    chmodSync(executable, 0o755)
    execFileSync('patchelf', ['--set-interpreter', interpreter, '--force-rpath', '--set-rpath', '$ORIGIN/../lib', executable])
    // Load the compatible C++ runtime before a native addon's own RUNPATH can select a system copy.
    execFileSync('patchelf', ['--add-needed', 'libstdc++.so.6', executable])
    if (!existsSync(interpreter)) throw new Error(`Kylin build container must map ${lock.installRoot}/resources/runtime to ${paths.runtime}`)
    const glibc = execFileSync(executable, ['-p', 'process.report.getReport().header.glibcVersionRuntime'], {
      encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000,
    }).trim()
    if (glibc !== lock.glibc) throw new Error(`Kylin private Host loaded glibc ${glibc}, expected ${lock.glibc}`)
    const files: Record<string, string> = {}
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const file = join(entry.parentPath, entry.name)
      files[file.slice(resolve(root).length + 1)] = createHash('sha256').update(readFileSync(file)).digest('hex')
    }
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ ...lock, files }, null, 2) + '\n')
    writeFileSync(join(root, 'README.txt'), 'Private Kylin Host libraries; system libraries are not modified.\n'
      + 'Installed prefix: ' + lock.installRoot + '\n'
      + 'Debian source packages and exact versions are listed in manifest.json.\n'
      + 'Replacement libraries may be placed in this directory under their own license terms.\n'
      + 'glibc uses LGPL-2.1-or-later; GCC runtime libraries use GPL-3 with the GCC Runtime Library Exception.\n')
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
