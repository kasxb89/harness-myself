/** Authorized media sources through real chat attachments and execution filesystem providers. */
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { readMediaV2File, type MediaV2FileSource } from '../src/media-v2-file.ts'

const MiB = 1024 * 1024
const signal = () => new AbortController().signal
const mp4Header = Buffer.alloc(64)
mp4Header.writeUInt32BE(24, 0)
mp4Header.write('ftypisom', 4, 'ascii')
const wavHeader = Buffer.alloc(64)
wavHeader.write('RIFF', 0, 'ascii')
wavHeader.write('WAVE', 8, 'ascii')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64')
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'media-v2-file-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const ctx = new Context()
  onTestFinished(async () => {
    vi.restoreAllMocks()
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  await ctx.plugin(LocalFileSystem, { cwd: workspace }).await()
  const fs = ctx.fs as LocalFileSystem
  const attachments = new LocalAttachmentStore(ctx, { dshHome: join(directory, 'attachment-home') })
  const id = SessionId('media-file-current-chat')
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd: workspace,
  })
  const attachFile = async (name: string, data: Uint8Array) => {
    const ref = await attachments.saveFile({ name, data })
    session.append('user/message', createUserMessage({ content: [{ type: 'file', attachment: ref }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    return ref
  }
  return { directory, workspace, fs, attachments, session, attachFile }
}

function sourceStream(source: MediaV2FileSource, abort = signal()): AsyncIterable<Uint8Array> {
  if (!('stream' in source)) throw new Error('expected an authorized media stream')
  return typeof source.stream === 'function' ? source.stream(abort) : source.stream
}

async function allBytes(source: MediaV2FileSource): Promise<Buffer> {
  if ('bytes' in source) return Buffer.from(source.bytes)
  const chunks: Uint8Array[] = []
  for await (const chunk of sourceStream(source)) chunks.push(chunk)
  return Buffer.concat(chunks)
}

it.each([
  ['video.mp4', mp4Header, 'video/mp4'], ['speech.wav', wavHeader, 'audio/wav'],
] as const)('reads every authorized %s byte by its current-chat ID and projected execution path', async (name, header, mime) => {
  const f = await fixture()
  const data = Buffer.concat([header, Buffer.alloc(150_000, 37)])
  const ref = await f.attachFile(name, data)
  const projected = `/execution/read-only-attachments/${basename(f.attachments.fileHostPath(ref))}`
  vi.spyOn(f.fs, 'processPathFromHostPath').mockReturnValue(projected)
  const ranges = vi.spyOn(f.fs, 'readByteRange')
  for (const value of [String(ref.attachmentId), projected]) {
    const source = await readMediaV2File(value, f.session, f.attachments, f.fs, 2 * MiB, signal())
    expect(source).toMatchObject({ filename: name, mime, size: data.length })
    const actual = await allBytes(source)
    expect(actual).toEqual(data)
    expect(hash(actual)).toBe(String(ref.attachmentId).slice('sha256:'.length))
  }
  expect(ranges).not.toHaveBeenCalled()
})

it('does not treat another chat or the global attachment inventory as read authorization', async () => {
  const f = await fixture()
  const ref = await f.attachments.saveFile({ name: 'foreign.mp4', data: Buffer.concat([mp4Header, Buffer.alloc(100)]) })
  const foreign = Session.create(SessionId('another-chat'))
  foreign.append('user/message', createUserMessage({ content: [{ type: 'file', attachment: ref }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const stream = vi.spyOn(f.attachments, 'readFileStream')
  const image = vi.spyOn(f.attachments, 'readImage')
  const ranges = vi.spyOn(f.fs, 'readByteRange')
  for (const value of [String(ref.attachmentId), f.attachments.fileHostPath(ref)]) {
    await expect(readMediaV2File(value, f.session, f.attachments, f.fs, MiB, signal()))
      .rejects.toMatchObject({ code: 'invalid_request' })
  }
  expect(foreign.deriveMessages()[0]?.content[0]).toMatchObject({ type: 'file', attachment: ref })
  expect(stream).not.toHaveBeenCalled()
  expect(image).not.toHaveBeenCalled()
  expect(ranges).not.toHaveBeenCalled()
})

it('keeps the existing current-chat image authorization and normalized-byte reader', async () => {
  const f = await fixture()
  const ref = await f.attachments.saveImage({ data: png, mediaType: 'image/png', name: 'reference.png' })
  const expected = await f.attachments.readImage(ref)
  f.session.append('user/message', createUserMessage({ content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const image = vi.spyOn(f.attachments, 'readImage')
  const stream = vi.spyOn(f.attachments, 'readFileStream')
  for (const value of [String(ref.attachmentId), f.attachments.imageHostPath(ref)]) {
    const source = await readMediaV2File(value, f.session, f.attachments, f.fs, MiB, signal())
    expect(source.mime).toBe(ref.mediaType)
    expect(await allBytes(source)).toEqual(Buffer.from(expected.data))
  }
  expect(image).toHaveBeenCalledTimes(2)
  expect(stream).not.toHaveBeenCalled()
})

it('closes the attachment header probe and the complete independent verification iterator', async () => {
  const f = await fixture()
  const data = Buffer.concat([mp4Header, Buffer.alloc(200_000, 7)])
  const ref = await f.attachFile('reference.mp4', data)
  const read = f.attachments.readFileStream.bind(f.attachments)
  let opened = 0, closed = 0
  vi.spyOn(f.attachments, 'readFileStream').mockImplementation((original, abort) => (async function* () {
    opened++
    try { yield* read(original, abort) } finally { closed++ }
  })())
  const source = await readMediaV2File(String(ref.attachmentId), f.session, f.attachments, f.fs, MiB, signal())
  expect({ opened, closed }).toEqual({ opened: 1, closed: 1 })
  expect(hash(await allBytes(source))).toBe(hash(data))
  expect({ opened, closed }).toEqual({ opened: 2, closed: 2 })
})

it.each(['abort', 'return'] as const)('closes an attachment source after %s without reading its remaining bytes', async (stop) => {
  const f = await fixture()
  const ref = await f.attachFile('reference.mp4', Buffer.concat([mp4Header, Buffer.alloc(300_000)]))
  const read = f.attachments.readFileStream.bind(f.attachments)
  let closed = 0
  vi.spyOn(f.attachments, 'readFileStream').mockImplementation((original, abort) => (async function* () {
    try { yield* read(original, abort) } finally { closed++ }
  })())
  const controller = new AbortController()
  const source = await readMediaV2File(String(ref.attachmentId), f.session, f.attachments, f.fs, MiB, controller.signal)
  if (!('stream' in source)) throw new Error('expected an attachment stream')
  const iterator = sourceStream(source)[Symbol.asyncIterator]()
  expect((await iterator.next()).done).toBe(false)
  if (stop === 'abort') {
    const reason = new Error('user cancelled the original read')
    controller.abort(reason)
    await expect(iterator.next()).rejects.toBe(reason)
  } else {
    await iterator.return?.()
  }
  expect(closed).toBe(2)
})

it('verifies the full attachment SHA after its separate header probe', async () => {
  const f = await fixture()
  const data = Buffer.concat([mp4Header, Buffer.alloc(100_000, 7)])
  const ref = await f.attachFile('reference.mp4', data)
  const stored = f.attachments.fileHostPath(ref)
  await chmod(stored, 0o600)
  data[data.length - 1] = 8
  await writeFile(stored, data)
  const source = await readMediaV2File(String(ref.attachmentId), f.session, f.attachments, f.fs, MiB, signal())
  await expect(allBytes(source)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
})

it('rejects an already-aborted transfer factory before yielding and closes its independent attachment iterator', async () => {
  const f = await fixture()
  const data = Buffer.concat([mp4Header, Buffer.alloc(100_000, 7)])
  const ref = await f.attachFile('reference.mp4', data)
  await writeFile(join(f.workspace, 'reference.mp4'), data)
  const read = f.attachments.readFileStream.bind(f.attachments)
  let closed = 0
  vi.spyOn(f.attachments, 'readFileStream').mockImplementation((original, abort) => (async function* () {
    try { yield* read(original, abort) } finally { closed++ }
  })())
  for (const value of [String(ref.attachmentId), 'reference.mp4']) {
    const source = await readMediaV2File(value, f.session, f.attachments, f.fs, MiB, signal())
    expect('stream' in source && typeof source.stream === 'function').toBe(true)
    const ranges = vi.spyOn(f.fs, 'readByteRange')
    ranges.mockClear()
    const abort = new AbortController(), reason = new Error('transfer expired before reading')
    abort.abort(reason)
    let yielded = 0
    await expect((async () => { for await (const chunk of sourceStream(source, abort.signal)) yielded += chunk.length })())
      .rejects.toBe(reason)
    expect(yielded).toBe(0)
    expect(ranges).not.toHaveBeenCalled()
    expect(await allBytes(source)).toEqual(data)
  }
  // The original header probe, aborted transfer, and successful transfer all settle.
  expect(closed).toBe(3)
})

it('rejects oversized chat files and pre-aborted reads before opening an attachment iterator', async () => {
  const f = await fixture()
  const ref = await f.attachFile('reference.mp4', mp4Header)
  const stream = vi.spyOn(f.attachments, 'readFileStream')
  await expect(readMediaV2File(String(ref.attachmentId), f.session, f.attachments, f.fs, ref.bytes - 1, signal()))
    .rejects.toMatchObject({ code: 'invalid_request', status: 413 })
  const reason = new Error('already cancelled')
  const aborted = new AbortController(); aborted.abort(reason)
  await expect(readMediaV2File(String(ref.attachmentId), f.session, f.attachments, f.fs, MiB, aborted.signal)).rejects.toBe(reason)
  expect(stream).not.toHaveBeenCalled()
})

it('reads an authorized workspace file above 50 MiB through bounded execution-world ranges only', async () => {
  const f = await fixture()
  const size = 50 * MiB + 117
  const file = await open(join(f.workspace, 'large.mp4'), 'w')
  try { await file.truncate(size); await file.write(mp4Header, 0, mp4Header.length, 0) } finally { await file.close() }
  const ranges = vi.spyOn(f.fs, 'readByteRange')
  const whole = vi.spyOn(f.fs, 'readBytes').mockRejectedValue(new Error('whole-file reads are forbidden'))
  const source = await readMediaV2File('large.mp4', f.session, f.attachments, f.fs, 64 * MiB, signal())
  if (!('stream' in source)) throw new Error('expected bounded workspace ranges')
  const actual = createHash('sha256'), expected = createHash('sha256').update(mp4Header)
  const zero = Buffer.alloc(MiB)
  for (let remaining = size - mp4Header.length; remaining > 0; remaining -= MiB) expected.update(zero.subarray(0, Math.min(remaining, MiB)))
  let bytes = 0
  for await (const chunk of sourceStream(source)) { actual.update(chunk); bytes += chunk.length }
  expect(bytes).toBe(size)
  expect(actual.digest('hex')).toBe(expected.digest('hex'))
  expect(whole).not.toHaveBeenCalled()
  expect(ranges.mock.calls.map(([, range]) => range.length).every(length => length <= MiB)).toBe(true)
  expect(ranges).toHaveBeenCalledTimes(Math.ceil(size / MiB) + 1)
  expect(ranges.mock.calls[0]?.[1]).toEqual({ offset: 0, length: 64 })
})

it('refuses outside-workspace files, direct symlinks and symlinked parent escapes before reading bytes', async () => {
  const f = await fixture()
  const outside = join(f.directory, 'outside.mp4')
  await writeFile(outside, mp4Header)
  await symlink(outside, join(f.workspace, 'alias.mp4'))
  await symlink(f.directory, join(f.workspace, 'parent-alias'), 'dir')
  const ranges = vi.spyOn(f.fs, 'readByteRange')
  for (const value of [outside, '../outside.mp4', 'alias.mp4', 'parent-alias/outside.mp4']) {
    await expect(readMediaV2File(value, f.session, f.attachments, f.fs, MiB, signal()))
      .rejects.toMatchObject({ code: 'invalid_request' })
  }
  expect(ranges).not.toHaveBeenCalled()
})

it('rejects a workspace size over its effective limit before a header or body read', async () => {
  const f = await fixture()
  await writeFile(join(f.workspace, 'reference.mp4'), Buffer.concat([mp4Header, Buffer.alloc(100)]))
  const ranges = vi.spyOn(f.fs, 'readByteRange')
  await expect(readMediaV2File('reference.mp4', f.session, f.attachments, f.fs, 100, signal()))
    .rejects.toMatchObject({ code: 'invalid_request', status: 413 })
  expect(ranges).not.toHaveBeenCalled()
})

it('detects a version change after a range read before yielding those bytes', async () => {
  const f = await fixture()
  const path = join(f.workspace, 'reference.mp4')
  await writeFile(path, Buffer.concat([mp4Header, Buffer.alloc(2 * MiB)]))
  const read = f.fs.readByteRange.bind(f.fs)
  vi.spyOn(f.fs, 'readByteRange').mockImplementation(async (...args) => {
    const result = await read(...args)
    if (args[1].length > 64) await utimes(path, 1000, 1000)
    return result
  })
  const source = await readMediaV2File('reference.mp4', f.session, f.attachments, f.fs, 4 * MiB, signal())
  if (!('stream' in source)) throw new Error('expected a workspace stream')
  let yielded = 0
  await expect((async () => { for await (const chunk of sourceStream(source)) yielded += chunk.length })())
    .rejects.toMatchObject({ code: 'asset_binding_mismatch', status: 409 })
  expect(yielded).toBe(0)
})

it('stops workspace range reads when the calling operation is aborted', async () => {
  const f = await fixture()
  await writeFile(join(f.workspace, 'reference.mp4'), Buffer.concat([mp4Header, Buffer.alloc(2 * MiB)]))
  const ranges = vi.spyOn(f.fs, 'readByteRange')
  const abort = new AbortController()
  const source = await readMediaV2File('reference.mp4', f.session, f.attachments, f.fs, 4 * MiB, abort.signal)
  if (!('stream' in source)) throw new Error('expected a workspace stream')
  const iterator = sourceStream(source)[Symbol.asyncIterator]()
  expect((await iterator.next()).done).toBe(false)
  const calls = ranges.mock.calls.length
  const reason = new Error('cancelled original workspace source')
  abort.abort(reason)
  await expect(iterator.next()).rejects.toBe(reason)
  expect(ranges).toHaveBeenCalledTimes(calls)
})
