/** Authorized, bounded media reads through the current chat and execution filesystem. @module */
import { basename, isAbsolute } from 'node:path'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { Session } from '@deepseek-ai/dsh-session'
import { MediaV2Error, type MediaV2UploadSource } from './media-v2-client.ts'
import { readChatImageReference } from './chat-image-references.ts'

/** One authorized file source; complete bytes are verified before the uploader sends them. */
export type MediaV2FileSource = { filename: string; mime: string } & MediaV2UploadSource

/** Detect the media container; the server still probes the complete immutable upload. */
function mediaType(header: Uint8Array, filename: string): string {
  const bytes = Buffer.from(header)
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF') {
    if (bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
    if (bytes.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav'
  }
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return /\.m4a$/iu.test(filename) ? 'audio/mp4'
    : /\.mov$/iu.test(filename) ? 'video/quicktime' : 'video/mp4'
  if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return /\.(?:weba|opus)$/iu.test(filename) ? 'audio/webm' : 'video/webm'
  if (bytes.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac'
  if (bytes.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg'
  if (bytes.toString('ascii', 0, 3) === 'ID3' || bytes[0] === 255 && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return 'audio/mpeg'
  throw new MediaV2Error('invalid_request', '素材不是可识别的图片、视频或音频，请重新选择原文件。', 400)
}

/** Read a small container header and close the probe iterator before returning a separate source. */
async function headerOf(source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> {
  const parts: Uint8Array[] = []; let size = 0
  for await (const chunk of source) {
    signal.throwIfAborted()
    const part = chunk.subarray(0, 64 - size)
    parts.push(part); size += part.byteLength
    if (size === 64) break
  }
  return Buffer.concat(parts, size)
}

/**
 * Read only a current user attachment or a regular file inside the calling workspace.
 * @param value - Exact attachment identity/projected path, or a workspace filename.
 * @param session - Original calling chat, never a global attachment inventory.
 * @param attachments - Provider that verifies immutable chat attachment bytes.
 * @param fileSystem - Calling execution-world filesystem; host paths never bypass it.
 * @param maximum - Effective model, server and deployment upload ceiling.
 * @param signal - Cancels authorization, range reads and source iteration.
 * @returns Original ordered bytes as a bounded source and detected media metadata.
 */
export async function readMediaV2File(value: string, session: Session | undefined, attachments: AttachmentStore | undefined,
  fileSystem: FileSystem | undefined, maximum: number, signal: AbortSignal): Promise<MediaV2FileSource> {
  signal.throwIfAborted()
  const image = await readChatImageReference(value, session, attachments, fileSystem, Math.min(maximum, 50 * 1024 * 1024), signal)
  if (image !== undefined) return { filename: image.ref.name ?? 'reference.png', mime: image.ref.mediaType, bytes: image.data }
  if (session !== undefined && attachments !== undefined) {
    for (const message of session.deriveMessages()) {
      if (message.role !== 'user') continue
      for (const block of message.content) {
        if (block.type !== 'file') continue
        const ref = block.attachment
        const hostPath = attachments.fileHostPath(ref)
        if (value !== String(ref.attachmentId)
          && (hostPath === undefined || fileSystem === undefined || value !== fileSystem.processPathFromHostPath(hostPath))) continue
        if (ref.bytes <= 0 || ref.bytes > maximum) throw new MediaV2Error('invalid_request', '聊天素材超过当前上传上限，请选择较小文件。', 413)
        const header = await headerOf(attachments.readFileStream(ref, signal), signal)
        return { filename: ref.name, mime: mediaType(header, ref.name), size: ref.bytes,
          stream: transferSignal => attachments.readFileStream(ref, AbortSignal.any([signal, transferSignal])) }
      }
    }
  }
  const workspace = session?.header.cwd
  if (fileSystem === undefined || workspace === undefined || !isAbsolute(workspace)) {
    throw new MediaV2Error('invalid_request', '请使用当前聊天上传的素材，或先选择工作区文件夹。', 400)
  }
  const [root, target, entry] = await Promise.all([
    fileSystem.resolve(workspace, { signal }), fileSystem.resolve(value, { cwd: workspace, signal }),
    fileSystem.lstat(value, { cwd: workspace }, signal),
  ])
  if (entry?.type !== 'file' || !fileSystem.contains(root, target)) {
    throw new MediaV2Error('invalid_request', '素材不在当前工作区，或不是普通文件；请使用当前聊天上传的原文件。', 400)
  }
  const initial = await fileSystem.stat(target, signal)
  if (initial?.type !== 'file' || initial.size === undefined || initial.size <= 0 || initial.size > maximum) {
    throw new MediaV2Error('invalid_request', '素材大小无法核对或超过当前上传上限，尚未上传。', 413)
  }
  const size = initial.size
  const unchanged = async (readSignal: AbortSignal): Promise<void> => {
    readSignal.throwIfAborted()
    const current = await fileSystem.stat(target, readSignal)
    if (current?.version !== initial.version || current.type !== 'file' || current.size !== size) {
      throw new MediaV2Error('asset_binding_mismatch', '素材在读取期间发生变化，尚未上传；请重新选择原文件。', 409)
    }
  }
  const header = await fileSystem.readByteRange(target, { offset: 0, length: Math.min(size, 64) }, signal)
  await unchanged(signal)
  const filename = basename(fileSystem.processPath(target)), mime = mediaType(header, filename)
  const stream = async function* (transferSignal: AbortSignal): AsyncIterable<Uint8Array> {
    const readSignal = AbortSignal.any([signal, transferSignal])
    let offset = 0
    while (offset < size) {
      await unchanged(readSignal)
      const chunk = await fileSystem.readByteRange(target, { offset, length: Math.min(size - offset, 1024 * 1024) }, readSignal)
      await unchanged(readSignal)
      if (chunk.byteLength === 0 || chunk.byteLength > Math.min(size - offset, 1024 * 1024)) {
        throw new MediaV2Error('asset_binding_mismatch', '素材未能完整读取，尚未上传；请检查原文件。', 409)
      }
      offset += chunk.byteLength
      yield chunk
    }
    await unchanged(readSignal)
  }
  return { filename, mime, size, stream }
}
