/** Synthetic model-only forum records; no accounts or posts are created outside the test. */
import type { ForumComment, ForumConfig, ForumPost } from '../src/client/forum-types.ts'
import type { ForumStorage } from '../src/client/forum-pending.ts'

/** Make a user-facing post.
 * @param patch - Explicit field changes.
 * @returns Synthetic post.
 */
export function forumExamplePost(patch: Partial<ForumPost> = {}): ForumPost {
  return { id: '00000000-0000-4000-8000-000000001001', title: 'Synthetic forum topic', body: 'Synthetic public text',
    author: { id: 2, display_name: 'Test author' }, created_at: 100, like_count: 0, comment_count: 0, liked: false, ...patch }
}
/** Make a user-facing comment.
 * @param patch - Explicit field changes.
 * @returns Synthetic comment.
 */
export function forumExampleComment(patch: Partial<ForumComment> = {}): ForumComment {
  return { id: '00000000-0000-4000-8000-000000002001', post_id: forumExamplePost().id,
    body: 'Synthetic response', author: { id: 2, display_name: 'Actual test author' }, created_at: 101, ...patch }
}
/** Make dynamic backend config.
 * @param enabled - New-content availability.
 * @returns Config DTO.
 */
export function forumExampleConfig(enabled = true): ForumConfig {
  return { revision: 1, enabled, capabilities: { immediate_publish: true, comments: true, likes: true } }
}
/** Provide isolated persistence.
 * @returns Browser-compatible memory storage.
 */
export function forumMemory(): ForumStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) },
    removeItem: (key) => { data.delete(key) } }
}
