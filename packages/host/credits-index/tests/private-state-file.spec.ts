/** Publishing failure leaves the previously authenticated document intact. */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { writePrivateState } from '../src/private-state-file.ts'

it('flushes a private candidate before publication and preserves the old file on injected rename failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yunshu-private-state-'))
  const file = join(root, 'session.json')
  try {
    await writeFile(file, 'previous-session', { mode: 0o600 })
    await expect(writePrivateState(file, 'candidate-session', async (temporary, destination) => {
      expect(destination).toBe(file)
      expect(await readFile(temporary, 'utf8')).toBe('candidate-session')
      if (process.platform !== 'win32') expect((await stat(temporary)).mode & 0o777).toBe(0o600)
      throw new Error('injected publication failure')
    })).rejects.toThrow('injected publication failure')
    expect(await readFile(file, 'utf8')).toBe('previous-session')
    expect(await readdir(root)).toEqual(['session.json'])
    await writePrivateState(file, 'complete-session')
    expect(await readFile(file, 'utf8')).toBe('complete-session')
  } finally { await rm(root, { recursive: true, force: true }) }
})
