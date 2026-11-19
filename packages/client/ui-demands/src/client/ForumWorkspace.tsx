/** The forum owns public discussion state independently of private requirements and chat. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { ForumCenter } from './ForumCenter.tsx'
import { forumCenterView, forumIssueText, forumOperationView } from './forum-adapter.ts'
import type { ForumFace, ForumState } from './forum-types.ts'
import type { DemandTranslate } from './DemandUI.tsx'
import css from './DemandPage.module.css'

/**
 * Bind forum controls to their exact draft, post and pending operation identities.
 * @param props - Account snapshot, original-operation commands and dictionary.
 * @returns Public forum plus recoverable drafts when they actually exist.
 */
export function ForumWorkspace({ state, commands, t }: {
  state: ForumState
  commands: Omit<ForumFace, 'hooks'>
  t: DemandTranslate
}): ReactNode {
  const [composerOpen, setComposerOpen] = useState(false)
  const openedScope = useRef<string | null>(null)
  const draft = state.postDrafts.find(row => row.scopeKey === state.activePostDraftScope)
  const publication = draft === undefined ? undefined
    : state.pending.find(row => row.kind === 'post' && row.scopeKey === draft.scopeKey)
  const publicationView = publication === undefined && draft?.error !== undefined && draft.error !== null
    ? { state: 'failed' as const, recoverable: false, message: forumIssueText(draft.error, t) ?? t('forumIssueFailed') }
    : forumOperationView(publication, t)
  const reply = state.pending.find(row => row.kind === 'comment' && row.postId === state.selectedPostId)
  const otherDrafts = state.postDrafts.filter(row => row.postId === null && row.scopeKey !== draft?.scopeKey
    && (row.title !== '' || row.body !== '' || row.locked))
  useEffect(() => {
    if (!composerOpen) return
    if (state.activePostDraftScope !== null && draft?.postId === null) {
      openedScope.current = state.activePostDraftScope
      return
    }
    const completed = state.postDrafts.find(row => row.scopeKey === openedScope.current)
    if (completed?.postId !== undefined && completed.postId !== null) {
      openedScope.current = null
      setComposerOpen(false)
    }
  }, [composerOpen, draft?.postId, state.activePostDraftScope, state.postDrafts])
  return <div className={css.forumWorkspace}>
    {otherDrafts.length === 0 ? null : <div className={css.forumDrafts} role="group" aria-label={t('forumSavedDrafts')}>
      {otherDrafts.map(row => <Button key={row.scopeKey} size="sm" variant="ghost"
        onClick={() => { commands.openPostDraft(row.scopeKey); openedScope.current = row.scopeKey; setComposerOpen(true) }}>
        {t('forumResumeNamed', { title: row.title || t('forumUnnamedDraft') })}</Button>)}
    </div>}
    <ForumCenter view={forumCenterView(state, t)} postDraft={{ title: draft?.title ?? '', body: draft?.body ?? '' }}
      replyDraft={state.commentDraft} postLocked={draft?.locked === true} replyLocked={reply !== undefined}
      postOperation={publicationView} replyOperation={forumOperationView(reply, t)}
      postComposerOpen={composerOpen}
      onOpenPostComposer={() => { openedScope.current = null; setComposerOpen(true) }}
      onClosePostComposer={() => { openedScope.current = null; setComposerOpen(false) }}
      onStartPost={commands.startPost} onOpenPost={commands.openPost} onBack={commands.closePost}
      onRefresh={commands.refresh} onLoadMore={commands.loadMorePosts}
      onLoadMoreReplies={() => { if (state.selectedPostId !== null) commands.loadMoreComments(state.selectedPostId) }}
      onChangePost={(patch) => { if (draft !== undefined) commands.updatePostDraft(draft.scopeKey, patch) }}
      onSubmitPost={() => { if (draft !== undefined) commands.publishPost(draft.scopeKey) }}
      onCheckPost={() => { if (publication !== undefined) commands.retryOperation(publication.operationId) }}
      onChangeReply={(body) => { if (state.selectedPostId !== null) commands.updateCommentDraft(state.selectedPostId, body) }}
      onSubmitReply={() => { if (state.selectedPostId !== null) commands.sendComment(state.selectedPostId) }}
      onCheckReply={() => { if (reply !== undefined) commands.retryOperation(reply.operationId) }}
      onToggleLike={(id) => { if (state.selectedPost?.id === id) commands.setLiked(id, !state.selectedPost.liked) }}
      onCheckLike={(id) => {
        const operation = state.pending.find(row => row.kind === 'like' && row.postId === id)
        if (operation !== undefined) commands.retryOperation(operation.operationId)
      }} t={t} />
  </div>
}
