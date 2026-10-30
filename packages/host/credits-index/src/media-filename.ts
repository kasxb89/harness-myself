/** Readable, exclusive-save filenames for generated media on supported desktop filesystems. @module */
import { randomUUID } from 'node:crypto'

/** Cross-platform filename byte limit, including role, UUID and extension. */
export const MAX_MEDIA_FILENAME_BYTES = 180

/** Existing workflow context used only to label an output, never to identify or submit a task. */
export interface MediaFilenameOptions {
  readonly title?: string
  readonly prompt?: string
  readonly role: 'audio' | 'image' | 'reference-image' | 'shot-image' | 'video' | 'shot' | 'final' | 'edited-video'
  readonly extension: string
  /** Human-facing sequence number, starting at one. */
  readonly index?: number
}

const labels: Record<MediaFilenameOptions['role'], string> = {
  audio: '配音', image: '成图', 'reference-image': '参考图', 'shot-image': '分镜图',
  video: '视频', shot: '分镜', final: '成片', 'edited-video': '剪辑视频',
}

/** Keep whole Unicode code points within an exact UTF-8 byte budget. */
function bounded(value: string, bytes: number): string {
  let result = ''
  let size = 0
  for (const point of value) {
    const next = Buffer.byteLength(point)
    if (size + next > bytes) break
    result += point
    size += next
  }
  return result.replace(/[.\s-]+$/u, '')
}

/** Remove path syntax, Windows device names and invisible direction controls from one label. */
function label(value: string): string {
  const cleaned = value.toWellFormed().normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '-')
    .replace(/\s+/gu, ' ').replace(/-+/gu, '-').replace(/^[.\s-]+|[.\s-]+$/gu, '')
  return /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:[. ]|$)/iu.test(cleaned) ? `素材-${cleaned}` : cleaned
}

/**
 * Name one new media output from its existing plan title or a short first-clause brief.
 * @param options - Trusted output purpose, optional existing title/brief, extension and one-based sequence.
 * @returns A path-free filename with a complete UUID; writers must still open it exclusively.
 */
export function mediaFilename(options: MediaFilenameOptions): string {
  const extension = options.extension.replace(/^\./u, '').toLowerCase()
  if (!/^[a-z0-9]{1,10}$/u.test(extension)) throw new Error('Media extension must contain one to ten ASCII letters or digits')
  const role = labels[options.role]
  const sequence = options.index === undefined ? '' : `-${String(options.index).padStart(2, '0')}`
  const suffix = `-${role}${sequence}-${randomUUID()}.${extension}`
  const prompt = options.prompt?.trim().split(/[\r\n。！？!?；;，,]/u, 1)[0] ?? ''
  const summary = bounded(label(prompt), 60)
  const title = label(options.title ?? '') || summary || role
  return `${bounded(title, MAX_MEDIA_FILENAME_BYTES - Buffer.byteLength(suffix)) || role}${suffix}`
}
