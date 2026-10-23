import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactStorageService } from '@deepseek-ai/dsh-artifacts-index'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { artifactOriginOf, captureMediaOutput, parseArtifactOrigin } from '../src/media-output.ts'

let directory: string | undefined
afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe('operation-local media output', () => {
  it('captures immutable source coordinates before the output check and carries them through every write and publication', async () => {
    const origin = { sessionId: SessionId('generating-chat'), turn: 3, eventSeq: SessionSeq(12), toolCallId: ToolCallId('generate') }
    let release!: (value: { directory: string }) => void
    const write = vi.fn<ArtifactStorageService['write']>(async () => ({ path: '/saved/image.png' }))
    const publish = vi.fn<ArtifactStorageService['publish']>(async () => ({ path: '/saved/video.mp4' }))
    const storage: ArtifactStorageService = { capture: () => new Promise((resolve) => { release = resolve }),
      validate: async () => {}, write, publish }
    const preparing = captureMediaOutput(storage, '/legacy', new AbortController().signal, origin, 'final')
    origin.turn = 99
    release({ directory: '/saved' })
    const output = await preparing
    await output.write('image.png', Uint8Array.of(1))
    await output.publish('/download/video.mp4', 'video.mp4')
    for (const call of [write.mock.calls[0]![0], publish.mock.calls[0]![0]]) {
      expect(call.origin).toEqual({ ...origin, turn: 3 })
      expect(Object.isFrozen(call.origin)).toBe(true)
      expect(call.videoRole).toBe('final')
    }
  })

  it('captures only the exact tool Agent open Turn and validates optional durable locations', () => {
    const session = { id: SessionId('tool-chat') }
    let boundary: { lastTurn: number; openTurnStartSeq: ReturnType<typeof SessionSeq> | null } | undefined =
      { lastTurn: 2, openTurnStartSeq: SessionSeq(8) }
    const stateOf = vi.fn(() => boundary)
    const exec = { agent: { session, ctx: { get: () => ({ stateOf }) } }, rootCallId: ToolCallId('root') } as never
    const origin = artifactOriginOf(exec)
    expect(origin).toEqual({ sessionId: session.id, turn: 2, eventSeq: 8, toolCallId: 'root' })
    expect(stateOf).toHaveBeenCalledWith(session, 'turnBoundary')
    boundary = { lastTurn: 2, openTurnStartSeq: null }
    expect(artifactOriginOf(exec)).toBeUndefined()
    boundary = undefined
    expect(artifactOriginOf(exec)).toBeUndefined()
    expect(artifactOriginOf({} as never)).toBeUndefined()
    expect(parseArtifactOrigin(undefined)).toBeUndefined()
    expect(parseArtifactOrigin(origin, session.id)).toEqual(origin)
    for (const value of [null, { ...origin, turn: -1 }, { ...origin, eventSeq: 1.5 }, { ...origin, toolCallId: '' }]) {
      expect(parseArtifactOrigin(value)).toBeNull()
    }
    expect(parseArtifactOrigin(origin, 'another-chat')).toBeNull()
  })
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
