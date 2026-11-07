/** Materialize the frozen shell dependency graph without pnpm workspace-link cycles or a new resolution. */
import { closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { verifyMacCrossShellVersions } from './mac-cross-cache.ts'

const appRoot = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

/** Native runtime libraries use the separately prepared Darwin tree; the reusable shell closure must be portable. */
function portableFile(path: string): boolean {
  if (/\.(?:node|dll|dylib|exe|so)$/iu.test(path)) return false
  const file = openSync(path, 'r')
  try {
    const header = Buffer.alloc(4)
    const length = readSync(file, header, 0, header.length, 0)
    if (length >= 2 && header.subarray(0, 2).equals(Buffer.from('MZ'))) return false
    return length < 4 || ![0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe,
      0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(header.readUInt32BE())
  } finally { closeSync(file) }
}

/** The installed electron-builder collector has already hoisted cycles and version conflicts. */
export interface MacShellModule {
  name: string
  version: string
  dir: string
  dependencies?: MacShellModule[]
}

/** Copy each planned module once, excluding its original node_modules links. */
export function materializeMacShellPlan(
  source: string, output: string, modules: readonly MacShellModule[],
): { packages: number; requiredEdges: number } {
  if (existsSync(output)) throw new Error('macOS shell: preserve an existing materialization before retrying')
  const electronBuilder = createRequire(require.resolve('electron-builder/package.json'))
  const builder = createRequire(electronBuilder.resolve('app-builder-lib/package.json'))
  const { minimatch } = builder('minimatch') as { minimatch: (name: string, pattern: string, options: { dot: boolean }) => boolean }
  mkdirSync(output, { recursive: true })
  copyFileSync(join(source, 'package.json'), join(output, 'package.json'))
  const copy = (module: MacShellModule, parent: string): void => {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(module.name)) throw new Error('macOS shell: invalid collected package name')
    const destination = join(parent, 'node_modules', module.name)
    const metadata = JSON.parse(readFileSync(join(module.dir, 'package.json'), 'utf8')) as { version: string; files?: string[]; main?: string }
    // pnpm reports workspace packages with a link/file reference; the final graph verifier checks their real versions.
    if (!/^(?:link|file|workspace):/u.test(module.version) && metadata.version !== module.version) {
      throw new Error(`macOS shell: collected version changed: ${module.name} ${module.version}; found ${metadata.version}`)
    }
    cpSync(module.dir, destination, { recursive: true, dereference: false, filter: (path) => {
      const name = basename(path)
      if (['node_modules', '.git', '.desktop-build'].includes(name) || name === '.env' || name.startsWith('.env.')) return false
      const status = lstatSync(path)
      if (status.isSymbolicLink()) throw new Error(`macOS shell: unexpected package content link: ${path}`)
      if (status.isDirectory()) return true
      const local = relative(module.dir, path).replaceAll('\\', '/')
      if (!portableFile(path)) throw new Error(`macOS shell: native dependency requires a Darwin preparation: ${path}`)
      if (metadata.files === undefined || /^(?:package\.json|licen[cs]e(?:[.-].*)?|readme(?:[.-].*)?)$/iu.test(local)
        || local === metadata.main?.replace(/^\.\//u, '')) return true
      const patterns = metadata.files.map(pattern => pattern.replace(/^\.\//u, '').replace(/\/+$/u, ''))
      const matches = (pattern: string): boolean => local === pattern || local.startsWith(`${pattern}/`) || minimatch(local, pattern, { dot: true })
      return patterns.some(pattern => !pattern.startsWith('!') && matches(pattern))
        && !patterns.some(pattern => pattern.startsWith('!') && matches(pattern.slice(1)))
    } })
    for (const child of module.dependencies ?? []) copy(child, destination)
  }
  for (const module of modules) copy(module, output)
  return verifyMacCrossShellVersions(output, source)
}

/** Reuse electron-builder's pnpm production collector and the existing compiled source installation. */
export async function prepareMacCrossShell(source: string, output: string): Promise<{ packages: number; requiredEdges: number }> {
  const electronBuilder = createRequire(require.resolve('electron-builder/package.json'))
  const builder = createRequire(electronBuilder.resolve('app-builder-lib/package.json'))
  const { TmpDir } = builder('builder-util') as { TmpDir: new () => { cleanup: () => Promise<void> } }
  const { PM, getCollectorByPackageManager } = builder('./out/node-module-collector/index.js') as {
    PM: { PNPM: string }
    getCollectorByPackageManager: (manager: string, root: string, temporary: unknown) => {
      getNodeModules: (options: { packageName: string }) => Promise<{ nodeModules: MacShellModule[] }>
    }
  }
  const temporary = new TmpDir()
  try {
    const { name } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { name: string }
    const { nodeModules } = await getCollectorByPackageManager(PM.PNPM, source, temporary).getNodeModules({ packageName: name })
    return materializeMacShellPlan(source, output, nodeModules)
  } finally { await temporary.cleanup() }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { output: { type: 'string' } } })
  if (!values.output) throw new Error('macOS shell: --output is required')
  console.log(JSON.stringify(await prepareMacCrossShell(appRoot, resolve(values.output))))
}
