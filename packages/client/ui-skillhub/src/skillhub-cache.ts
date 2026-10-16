/** Download and verify the unmodified, pinned official SkillHub CLI into product-private storage. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { t, x } from 'tar'

const VERSION = '2026.8.5'
const ARCHIVE_URL = `https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/skillhub-cli-${VERSION}.tar.gz`
const ARCHIVE_SHA256 = '3bbe2ba15ada2eb7a94a2b760fead83be5f4164ab28a6c8b0944dbc539f7e236'
const FILES: Readonly<Record<string, string>> = {
  'skills_store_cli.py': '6c5c89142b32b92d212d7b86821ba1f3cc0d6dc68df6d901e0ef38ece4add797',
  'skills_upgrade.py': '893374aae5d4941c3ededbd0be96366552ab959ed40a18f648aa30fb65116e05',
  'version.json': 'fff513acaf76390d2a9c23c0bdba00054c7db1d3d0473080e14c0f6ebe0c6514',
  'metadata.json': 'daccf1c7ae782a3d48183cd32a8bbcb1c0673724f647cbcafb1e4732e7b281fa',
}

async function validDirectory(directory: string): Promise<boolean> {
  try {
    if (!(await lstat(directory)).isDirectory()) return false
    for (const [name, hash] of Object.entries(FILES)) {
      const file = join(directory, name)
      if (!(await lstat(file)).isFile() || createHash('sha256').update(await readFile(file)).digest('hex') !== hash) return false
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Prepare the pinned CLI; a rejected download never replaces an existing cache.
 * @param root - Product-private SkillHub cache directory.
 * @param signal - Cancels download and prevents committing incomplete preparation.
 * @param maxBytes - Maximum downloaded archive size.
 * @returns The directory containing the four verified official files.
 */
export async function ensureSkillHubCli(root: string, signal: AbortSignal, maxBytes: number): Promise<string> {
  const destination = join(root, VERSION)
  if (await validDirectory(destination)) return destination
  await mkdir(root, { recursive: true, mode: 0o700 })
  if ((await lstat(root)).isSymbolicLink()) throw new Error('skillhub: cache must not be a filesystem link')
  const stage = await mkdtemp(join(root, '.prepare-'))
  try {
    const response = await fetch(ARCHIVE_URL, { signal, redirect: 'error' })
    if (!response.ok || response.body === null) throw new Error('skillhub: CLI download failed')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > maxBytes) throw new Error('skillhub: CLI archive is too large')
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    const bytes = Buffer.concat(chunks)
    if (createHash('sha256').update(bytes).digest('hex') !== ARCHIVE_SHA256) throw new Error('skillhub: CLI checksum mismatch')
    const archive = join(stage, 'official.tar.gz')
    await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 })
    const selected = new Set<string>()
    await t({ file: archive, onReadEntry(entry) {
      if (!Object.hasOwn(FILES, entry.path.replace(/^cli\//u, ''))) return
      if (entry.path !== `cli/${entry.path.slice(4)}` || entry.type !== 'File' || selected.has(entry.path)) {
        throw new Error('skillhub: unsafe or repeated CLI entry')
      }
      selected.add(entry.path)
    } })
    if (selected.size !== Object.keys(FILES).length) throw new Error('skillhub: incomplete CLI archive')
    const extracted = join(stage, 'cli')
    await mkdir(extracted)
    await x({ file: archive, cwd: extracted, strip: 1, filter: path => selected.has(path), strict: true })
    if (!await validDirectory(extracted)) throw new Error('skillhub: CLI contents failed verification')
    signal.throwIfAborted()
    // An invalid existing version remains available for inspection; it is never executed.
    try {
      await rename(extracted, destination)
    } catch (error) {
      if (await validDirectory(destination)) return destination
      throw error
    }
    return destination
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
