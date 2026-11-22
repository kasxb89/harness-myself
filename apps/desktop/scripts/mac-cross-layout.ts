/** Portable permissions and runtime sealing for Windows-assembled macOS bundles. */
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, createWriteStream, lstatSync, openSync, readSync, readdirSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import { create as createTar } from 'tar'
import { inventoryDesktopRuntime, readDesktopRuntime } from '../src/runtime-tree.ts'

interface ZipWriter {
  addFile(source: string, name: string, options: { mode: number; mtime: Date }): void
  addBuffer(body: Buffer, name: string, options: { mode: number; mtime: Date }): void
  addEmptyDirectory(name: string, options: { mode: number; mtime: Date }): void
  end(): void
  outputStream: Readable
}
const { ZipFile } = createRequire(import.meta.url)('yazl') as { ZipFile: new () => ZipWriter }
const epoch = new Date('2020-01-01T00:00:00.000Z')

/**
 * Preserve executable Mach-O files and shebang launchers without using NTFS mode bits.
 * @param body File bytes.
 * @returns Whether the macOS archive must give this file execute permission.
 */
export function macCrossExecutable(body: Buffer): boolean {
  if (body.subarray(0, 2).equals(Buffer.from('#!'))) return true
  if (body.length < 4) return false
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(body.readUInt32BE(0))
}

/** Read only the magic bytes, including for large Office libraries. */
function executableFile(path: string): boolean {
  const fd = openSync(path, 'r')
  try {
    const bytes = Buffer.alloc(4)
    return macCrossExecutable(bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)))
  } finally { closeSync(fd) }
}

/**
 * Create a POSIX resource archive while retaining the explicit executable policy.
 * @param root Materialized Resources directory on the Windows builder.
 * @param destination Tar consumed by Conveyor as a bundle-extras input.
 */
export async function writeMacCrossResources(root: string, destination: string): Promise<void> {
  await createTar({ cwd: root, file: destination, portable: true,
    filter: (name, status) => {
      if (!('isFile' in status)) throw new Error('desktop cross resources: only filesystem inputs are accepted')
      if (status.isSymbolicLink()) throw new Error('desktop cross resources: materialize links before archiving')
      if (status.isFile()) status.mode = (status.mode & ~0o777) | (executableFile(join(root, name)) ? 0o755 : 0o644)
      else if (status.isDirectory()) status.mode = (status.mode & ~0o777) | 0o755
      return true
    },
  }, ['.'])
}

/**
 * Seal the final nested-signature bytes before the outer application is signed.
 * @param root Materialized dsh resource tree after Conveyor signed native dependencies.
 * @param arch Required target CPU.
 */
export function sealMacCrossRuntime(root: string, arch: 'arm64' | 'x64'): void {
  const descriptor = readDesktopRuntime(root)
  if (descriptor.platform !== 'darwin' || descriptor.arch !== arch) throw new Error('desktop cross runtime: target mismatch before sealing')
  const files = inventoryDesktopRuntime(root).map(file => ({
    ...file, executable: executableFile(join(root, ...file.path.split('/'))),
  }))
  writeFileSync(join(root, 'desktop-runtime.json'), `${JSON.stringify({ ...descriptor, files }, undefined, 2)}\n`)
}

/**
 * Archive the final app with portable modes and framework links, without following links.
 * @param application Fully signed application bundle.
 * @param destination Private installation ZIP.
 * @returns Byte size and SHA256 of the complete ZIP.
 */
export async function writeMacCrossZip(application: string, destination: string): Promise<{ bytes: number; sha256: string }> {
  const zip = new ZipFile()
  const parent = join(application, '..')
  const visit = (path: string): void => {
    const status = lstatSync(path)
    const name = relative(parent, path).split(sep).join('/')
    if (status.isSymbolicLink()) {
      const target = readlinkSync(path).split(sep).join('/')
      const resolved = relative(application, resolve(path, '..', target))
      if (isAbsolute(target) || target.includes(':') || resolved === '..' || resolved.startsWith(`..${sep}`) || isAbsolute(resolved)) {
        throw new Error(`desktop cross archive: escaping link ${name}`)
      }
      zip.addBuffer(Buffer.from(target), name, { mode: 0o120777, mtime: epoch })
    } else if (status.isDirectory()) {
      zip.addEmptyDirectory(name, { mode: 0o40755, mtime: epoch })
      for (const child of readdirSync(path).sort()) visit(join(path, child))
    } else if (status.isFile()) {
      zip.addFile(path, name, { mode: executableFile(path) ? 0o100755 : 0o100644, mtime: epoch })
    } else throw new Error(`desktop cross archive: unsupported filesystem entry ${name}`)
  }
  visit(application)
  const done = pipeline(zip.outputStream, createWriteStream(destination, { flags: 'wx' }))
  zip.end()
  await done
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(destination)) digest.update(chunk)
  return { bytes: statSync(destination).size, sha256: digest.digest('hex') }
}
