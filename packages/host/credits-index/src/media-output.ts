/** Capture one writable media destination before generation and keep it for every result. @module */
import { constants } from 'node:fs'
import { copyFile, mkdir, open, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ArtifactImageRole, ArtifactOrigin, ArtifactStorageService, ArtifactVideoRole } from '@deepseek-ai/dsh-artifacts-index'
import { VideoProjectError } from './video-project.ts'

export { artifactOriginOf, parseArtifactOrigin } from './artifact-origin.ts'

/** Operation-local output methods retain the captured service and directory. */
export interface CapturedMediaOutput {
  /** Write one uniquely named media result. */
  write(filename: string, bytes: Uint8Array): Promise<{ path: string }>
  /** Copy a completed local download without removing its recoverable source. */
  publish(sourcePath: string, filename: string): Promise<{ path: string }>
}

/**
 * Check the selected output before any paid submission; standalone deployments retain their legacy media directory.
 * @param storage - Optional trusted Host output service.
 * @param legacyDirectory - Existing private-media output for deployments without that service.
 * @param signal - Cancellation for preparation and result saving.
 * @param origin - Exact generating tool location captured before any asynchronous generation work.
 * @param videoRole - Explicit purpose supplied by the video producer, independent of filenames.
 * @param imageRole - Image purpose verified by the generating Host operation, retained for its original-task recovery.
 * @returns Writers bound to this operation's validated destination.
 */
export async function captureMediaOutput(
  storage: ArtifactStorageService | undefined, legacyDirectory: string, signal: AbortSignal,
  origin?: ArtifactOrigin, videoRole?: ArtifactVideoRole, imageRole?: ArtifactImageRole,
): Promise<CapturedMediaOutput> {
  const capturedOrigin = origin === undefined ? undefined : Object.freeze({ ...origin })
  signal.throwIfAborted()
  let directory: string
  try {
    if (storage !== undefined) directory = (await storage.capture(signal)).directory
    else {
      await mkdir(legacyDirectory, { recursive: true, mode: 0o700 })
      const probe = join(legacyDirectory, `.media-write-${randomUUID()}`)
      const handle = await open(probe, 'wx', 0o600)
      try { await handle.close() } finally { await unlink(probe) }
      directory = legacyDirectory
    }
    signal.throwIfAborted()
  } catch (cause) {
    signal.throwIfAborted()
    throw new VideoProjectError('ARTIFACT_DESTINATION_UNAVAILABLE', '产物保存目录不可写，请在产物页检查保存位置后重试；尚未提交生成。', { cause })
  }
  const destination = { directory }
  return {
    async write(filename, bytes) {
      try {
        signal.throwIfAborted()
        if (storage !== undefined) return await storage.write({ destination, filename, bytes, signal,
          ...capturedOrigin === undefined ? {} : { origin: capturedOrigin }, ...videoRole === undefined ? {} : { videoRole },
          ...imageRole === undefined ? {} : { imageRole } })
        const path = join(directory, filename)
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600, signal })
        return { path }
      } catch (cause) {
        signal.throwIfAborted()
        throw new VideoProjectError('ARTIFACT_WRITE_FAILED', '产物保存失败，请检查保存位置与磁盘空间；生成可能已计费，请勿重复生成。', { cause })
      }
    },
    async publish(sourcePath, filename) {
      try {
        signal.throwIfAborted()
        if (storage !== undefined) return await storage.publish({ destination, sourcePath, filename, signal,
          ...capturedOrigin === undefined ? {} : { origin: capturedOrigin }, ...videoRole === undefined ? {} : { videoRole },
          ...imageRole === undefined ? {} : { imageRole } })
        const path = join(directory, filename)
        if (sourcePath !== path) await copyFile(sourcePath, path, constants.COPYFILE_EXCL)
        signal.throwIfAborted()
        return { path }
      } catch (cause) {
        signal.throwIfAborted()
        throw new VideoProjectError('ARTIFACT_PUBLISH_FAILED', '产物保存失败，本地下载文件仍保留，请检查保存位置后继续保存，无需重新生成。', { cause })
      }
    },
  }
}
