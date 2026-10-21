/** Atomic private state publication shared by account and phone recovery storage. */
import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Flush a private temporary file before replacing the current state document.
 * @param file - Destination file, whose previous contents survive a failed publish.
 * @param text - Complete serialized state.
 * @param publish - Atomic filesystem replacement operation.
 */
export async function writePrivateState(file: string, text: string, publish: typeof rename = rename): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomBytes(12).toString('hex')}.tmp`
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx', flush: true })
    await publish(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}
