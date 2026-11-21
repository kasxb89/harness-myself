/** Capability-qualified forum upload choices, including compatibility with image-only backends. */
import type { ForumConfig, ForumUploadRules } from './forum-types.ts'

/** Only advertised media kinds can initiate or continue a byte transfer. */
export interface ForumMediaPolicy {
  readonly rules: ForumUploadRules
  readonly imageBytes: number | null
  readonly videoBytes: number | null
  readonly mimeTypes: readonly string[]
}
/** Resolve current server upload capabilities without promoting legacy image rules to video.
 * @param config - The current account's verified forum configuration.
 * @returns Usable per-kind byte limits and types, or no new upload permission.
 */
export function forumMediaPolicy(config: ForumConfig | null): ForumMediaPolicy | null {
  if (config?.enabled !== true) return null
  const v2 = config.capabilities.forum_media_v2 === true ? config.upload_rules_v2 : undefined
  const rules = v2 ?? config.upload_rules
  if (rules === undefined) return null
  const imageBytes = config.capabilities.image_uploads === true ? rules.max_image_bytes : null
  const videoBytes = config.capabilities.video_uploads === true && v2 !== undefined ? v2.max_video_bytes : null
  const mimeTypes = rules.allowed_mime_types.filter(mime => mime.startsWith('image/') ? imageBytes !== null : mime === 'video/mp4' && videoBytes !== null)
  return mimeTypes.length === 0 ? null : { rules, imageBytes, videoBytes, mimeTypes }
}
