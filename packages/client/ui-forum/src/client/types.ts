import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Public author identity excludes login names and contact information. */
export interface Author {
  readonly id: number
  readonly display_name: string
}
/** Published community post, independent of private demands and AI sessions. */
export interface Post {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly author: Author
  readonly created_at: number
  readonly like_count: number
  readonly comment_count: number
  readonly liked: boolean
}
/** A flat chronological reply. */
export interface Comment {
  readonly id: string
  readonly post_id: string
  readonly body: string
  readonly author: Author
  readonly created_at: number
}
/** Retained publication key and immutable draft; retries use the same key. */
export interface Draft {
  readonly key: string
  readonly title: string
  readonly body: string
  readonly pending: boolean
  readonly uncertain: boolean
}
/** Account-scoped UI projection. */
export interface ForumState {
  readonly signedIn: boolean
  readonly enabled: boolean
  readonly loading: boolean
  readonly busy: boolean
  readonly posts: readonly Post[]
  readonly post: Post | null
  readonly comments: readonly Comment[]
  readonly feedCursor: string
  readonly commentsCursor: string
  readonly error: string | null
  readonly composing: boolean
  readonly draft: Draft
  readonly reply: Draft
}
/** Root controller callbacks and one framework-bound reactive source. */
export interface ForumFace {
  readonly hooks: { readonly forum: ObservableSnapshot<ForumState> }
  readonly activate: () => () => void
  readonly refresh: () => void
  readonly open: (id: string | null) => void
  readonly compose: (open: boolean) => void
  readonly edit: (reply: boolean, field: 'title' | 'body', value: string) => void
  readonly publish: (reply: boolean) => void
  readonly like: (id: string) => void
  readonly more: (comments: boolean) => void
}
/** Derived slot and locale seats. */
export type ForumProps = PropsRuntime<'demands.forum'> & PropsLocale<'forum'> & InjectFace<ForumFace>
