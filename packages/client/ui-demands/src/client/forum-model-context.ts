/** Internal lifecycle seat shared by the forum's account tools and image state machines. */
import type { ForumOwner, ForumRequest, ForumResult } from './forum-api.ts'
import type { ForumConfig } from './forum-types.ts'

/** Extensions dispatch only under the controller's captured account, deadlines and joined disposal. */
export interface ForumModelContext {
  readonly owner: () => ForumOwner | null
  readonly valid: (owner: ForumOwner) => boolean
  readonly config: () => ForumConfig | null
  readonly perform: (owner: ForumOwner, request: Omit<ForumRequest, 'signal'>, signal?: AbortSignal) => Promise<ForumResult>
  readonly publish: () => void
  readonly track: (work: () => Promise<void>) => void
}
