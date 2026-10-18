/** Exact current-chat attachment authorization for image editing. @module */

import type { AttachmentStore, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { Session } from '@deepseek-ai/dsh-session'
import { CreativeError } from './creative-store.ts'

/**
 * Read an uploaded image only when the calling chat currently contains its user image block.
 * @param value - Exact attachment id or the filesystem's projected read-only path.
 * @param session - Calling chat; other chats and the global attachment inventory grant no access.
 * @param attachments - Provider owning and verifying the immutable image bytes.
 * @param fileSystem - Execution filesystem that projects host object paths, when available.
 * @param maxBytes - Maximum normalized image size admitted before reading.
 * @param signal - Calling operation cancellation.
 * @returns Verified bytes for a matching user attachment, otherwise undefined.
 * @throws CreativeError for an oversized, missing, or corrupted authorized attachment.
 */
export async function readChatImageReference(
  value: string,
  session: Session | undefined,
  attachments: AttachmentStore | undefined,
  fileSystem: FileSystem | undefined,
  maxBytes: number,
  signal: AbortSignal,
): Promise<StoredImageAttachment | undefined> {
  signal.throwIfAborted()
  if (session === undefined || attachments === undefined) return undefined
  for (const message of session.deriveMessages()) {
    if (message.role !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'image') continue
      const ref = block.attachment
      let matches = value === String(ref.attachmentId)
      if (!matches && fileSystem !== undefined) {
        const hostPath = attachments.imageHostPath(ref)
        matches = hostPath !== undefined && value === fileSystem.processPathFromHostPath(hostPath)
      }
      if (!matches) continue
      if (ref.bytes <= 0 || ref.bytes > maxBytes) {
        throw new CreativeError('CREATIVE_REFERENCE_INVALID', 400, '聊天图片超过参考图大小限制，请缩小后重新上传。')
      }
      try {
        return await attachments.readImage(ref, signal)
      } catch (error) {
        signal.throwIfAborted()
        if (!attachments.isAttachmentError(error)) throw error
        throw new CreativeError('CREATIVE_REFERENCE_INVALID', 400, '聊天图片已无法读取或校验失败，请重新上传原图。')
      }
    }
  }
  return undefined
}
