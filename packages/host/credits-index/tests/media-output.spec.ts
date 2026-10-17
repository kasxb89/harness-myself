import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactStorageService } from '@deepseek-ai/dsh-artifacts-index'
import { captureMediaOutput } from '../src/media-output.ts'

let directory: string | undefined
afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe('operation-local media output', () => {
  it('keeps every result and local download in the captured destination while the user selects another one', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-media-output-'))
    const first = join(directory, 'first')
    const second = join(directory, 'second')
    await Promise.all([mkdir(first), mkdir(second)])
    let selected = first
    const capture = vi.fn(async () => ({ directory: selected }))
    const storage: ArtifactStorageService = {
      capture, validate: async () => {},
      write: async ({ destination, filename, bytes }) => {
        const path = join(destination.directory, filename)
        await writeFile(path, bytes, { flag: 'wx' })
        selected = second
        return { path }
      },
      publish: async ({ destination, sourcePath, filename }) => {
        const path = join(destination.directory, filename)
        await copyFile(sourcePath, path)
        return { path }
      },
    }
    const signal = new AbortController().signal
    const output = await captureMediaOutput(storage, join(directory, 'legacy'), signal)
    expect((await output.write('one.png', Buffer.from('one'))).path).toBe(join(first, 'one.png'))
    expect((await output.write('two.png', Buffer.from('two'))).path).toBe(join(first, 'two.png'))
    const source = join(directory, 'download.mp4')
    await writeFile(source, 'video')
    expect((await output.publish(source, 'saved.mp4')).path).toBe(join(first, 'saved.mp4'))
    expect(await readFile(source, 'utf8')).toBe('video')
    const next = await captureMediaOutput(storage, join(directory, 'legacy'), signal)
    expect((await next.write('next.png', Buffer.from('next'))).path).toBe(join(second, 'next.png'))
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('checks the legacy directory and exclusively creates files for service-free deployments', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-media-output-'))
    const output = await captureMediaOutput(undefined, join(directory, 'media'), new AbortController().signal)
    const path = (await output.write('one.png', Buffer.from('first'))).path
    await expect(output.write('one.png', Buffer.from('second'))).rejects.toMatchObject({ code: 'ARTIFACT_WRITE_FAILED' })
    expect(await readFile(path, 'utf8')).toBe('first')
    const blocked = join(directory, 'not-a-directory')
    await writeFile(blocked, 'keep')
    await expect(captureMediaOutput(undefined, blocked, new AbortController().signal)).rejects.toMatchObject({ code: 'ARTIFACT_DESTINATION_UNAVAILABLE' })
  })

  it('reports publication failure while retaining the already downloaded source', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-media-output-'))
    const source = join(directory, 'download.mp4')
    await writeFile(source, 'video')
    const storage: ArtifactStorageService = {
      capture: async () => ({ directory: directory! }), validate: async () => {},
      write: async () => { throw new Error('disk unavailable') }, publish: async () => { throw new Error('disk unavailable') },
    }
    const output = await captureMediaOutput(storage, directory, new AbortController().signal)
    await expect(output.publish(source, 'saved.mp4')).rejects.toMatchObject({ code: 'ARTIFACT_PUBLISH_FAILED' })
    expect(await readFile(source, 'utf8')).toBe('video')
  })
})
