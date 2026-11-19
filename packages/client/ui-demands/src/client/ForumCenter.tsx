/** A forum view renders supplied public posts without owning transport or submission identities. */
import { useId, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, Input, Modal, StateDot, IconCloseOutlineRegular, IconLikeFillRegular,
  IconLikeOutlineRegular, IconQueueOutlineRegular, IconUserOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ForumCenterProps, ForumOperationView } from './forum-view.ts'
import { DemandEmpty, DemandSkeleton, demandTime, type DemandTranslate } from './DemandUI.tsx'
import css from './ForumCenter.module.css'

function operationLocked(operation: ForumOperationView): boolean {
  return operation.state === 'submitting' || operation.state === 'unknown'
    || operation.state === 'failed' && operation.recoverable === true
}

function recoverable(operation: ForumOperationView): boolean {
  return operation.state === 'unknown' || operation.state === 'failed' && operation.recoverable === true
}

function OperationNotice({ operation, t }: { operation: ForumOperationView; t: DemandTranslate }): ReactNode {
  if (operation.state === 'unknown') return <p className={css.notice} role="status">
    {operation.message ?? t('forumOperationUnknown')}</p>
  return operation.state !== 'failed' ? null : <p className={css.failure} role="alert">{operation.message}</p>
}

function RecoveryAction({ operation, onCheck, t }: {
  operation: ForumOperationView
  onCheck: () => void
  t: DemandTranslate
}): ReactNode {
  if (operation.state === 'unknown') return <Button variant="outline" disabled={operation.checking}
    onClick={onCheck}>{t(operation.checking ? 'forumChecking' : 'forumCheckOriginal')}</Button>
  return operation.state !== 'failed' || !operation.recoverable ? null
    : <Button variant="outline" disabled={operation.recovering}
      onClick={onCheck}>{t(operation.recovering ? 'forumChecking' : 'forumRetryOriginal')}</Button>
}

function AuthorTime({ name, createdAt, t }: { name: string | null; createdAt: string; t: DemandTranslate }): ReactNode {
  const author = name?.trim()
  return <div className={css.metadata}>
    <span className={css.avatar} aria-hidden="true">{author ? Array.from(author)[0] : <IconUserOutlineRegular size={16} />}</span>
    <div className={css.authorDetails}><span>{author || t('forumMember')}</span>
      {createdAt === '' ? null : <time dateTime={createdAt}>{demandTime(createdAt, t)}</time>}</div>
  </div>
}

/**
 * Present public discussion, controlled drafts and explicit recovery without minting operation keys.
 * @param props - Authorized normalized content, actual permissions, parent-owned drafts and callbacks.
 * @returns A retained note feed, modal reading view and composer with parent-owned drafts.
 */
export function ForumCenter(props: ForumCenterProps): ReactNode {
  const { view, postDraft, replyDraft, postOperation, replyOperation, t } = props
  const formId = useId()
  const detail = view.detail
  const post = detail.post?.id === detail.postId ? detail.post : null
  const ready = view.availability === 'ready'
  const postEditingLocked = props.postLocked || !ready || !view.canCreate || operationLocked(postOperation)
  const replyEditingLocked = props.replyLocked || !ready || post?.canReply !== true || operationLocked(replyOperation)
  const canSubmitPost = !postEditingLocked && postDraft.title.trim() !== '' && postDraft.body.trim() !== ''
  const canSubmitReply = !replyEditingLocked && replyDraft.trim() !== ''
  const retainedPost = postDraft.title !== '' || postDraft.body !== '' || postOperation.state !== 'idle'
  const showNotice = view.reason !== null || view.availability === 'disabled' || view.availability === 'login-required'
  return <section className={css.center} aria-label={t('forumTabLabel')}>
    <header className={css.toolbar}>
      <h2>{t('forumTabLabel')}</h2>
      <div className={css.toolbarActions}>
        {!retainedPost ? null : <Button variant="outline" aria-haspopup="dialog"
          onClick={props.onOpenPostComposer}>{t('forumContinuePost')}</Button>}
        <Button className={css.publishButton} variant="accent" aria-haspopup="dialog" disabled={!ready || !view.canCreate}
          onClick={() => { props.onStartPost(); props.onOpenPostComposer() }}>{t('forumNewPost')}</Button>
      </div>
    </header>
    {showNotice ? <p className={css.notice} role="status">{view.reason
      ?? t(view.availability === 'login-required' ? 'forumSignIn' : 'forumDisabled')}</p> : null}
    {props.postComposerOpen || !recoverable(postOperation) ? null : <div className={css.queryError}>
      <OperationNotice operation={postOperation} t={t} /><RecoveryAction operation={postOperation} onCheck={props.onCheckPost} t={t} />
    </div>}
    <div className={css.viewport}>
      {view.list.posts.length === 0 || view.list.error === null && view.list.status !== 'error' ? null : <div className={css.queryError} role="alert">
        <span>{view.list.error ?? t('forumLoadFailed')}</span><Button size="sm"
          disabled={view.list.status === 'loading'} onClick={props.onRefresh}>{t('retry')}</Button></div>}
      {view.list.posts.length > 0 ? <ul className={css.postList} aria-label={t('forumPostList')} aria-busy={view.list.status === 'loading'}>
        {view.list.posts.map(item => <li key={item.id}><article className={css.postRow}>
          <button type="button" className={css.postOpen} aria-haspopup="dialog"
            aria-label={t('forumOpenPost', { title: item.title })} onClick={() => { props.onOpenPost(item.id) }}>
            <span className={css.postTitle} role="heading" aria-level={3}>{item.title}</span>
            {item.excerpt.trim() === '' ? null : <span className={css.excerpt}>{item.excerpt}</span>}
          </button>
          <div className={css.rowFooter}><AuthorTime name={item.authorName} createdAt={item.createdAt} t={t} />
            <div className={css.counts}>
              {item.likeCount === null ? null : <span><IconLikeOutlineRegular size={14} />{t('forumLikeCount', { count: item.likeCount })}</span>}
              {item.replyCount === null ? null : <span><IconQueueOutlineRegular size={14} />{t('forumReplyCount', { count: item.replyCount })}</span>}
            </div>
          </div>
        </article></li>)}
      </ul> : view.list.status === 'loading' || view.availability === 'loading' ? <DemandSkeleton compact label={t('loading')} />
        : view.list.status === 'error' || view.availability === 'error' ? <DemandEmpty title={t('forumLoadFailed')}
          detail={view.list.error ?? view.reason ?? t('forumRetryHint')} actionLabel={t('retry')} onAction={props.onRefresh} />
          : view.availability !== 'ready' ? <DemandEmpty title={t(view.availability === 'login-required' ? 'forumSignIn' : 'forumDisabled')}
            detail={view.reason ?? t('forumUnavailableHint')} />
            : <DemandEmpty title={t('forumEmpty')} detail={t('forumEmptyHint')} />}
      {!view.list.hasMore ? null : <div className={css.loadMore}><Button variant="outline" size="sm"
        disabled={view.list.loadingMore || view.list.status === 'loading'} onClick={props.onLoadMore}>
        {t(view.list.loadingMore ? 'forumLoadingMore' : 'forumLoadMore')}</Button></div>}
    </div>
    <Modal open={detail.postId !== null} onClose={props.onBack} title={post?.title ?? t('forumTabLabel')}
      className={clsx(css.detailDialog)} headless>
      <Button className={css.detailClose} aria-label={t('close')} onClick={props.onBack}
        icon={<IconCloseOutlineRegular size={18} />} />
      {post === null || detail.error === null && detail.status !== 'error' ? null : <div className={css.detailError} role="alert">
        <span>{detail.error ?? t('forumLoadFailed')}</span><Button size="sm" onClick={props.onRefresh}>{t('retry')}</Button></div>}
      {post === null ? detail.status === 'loading' ? <div className={css.loading} role="status" aria-label={t('loading')}>
        <StateDot state="ongoing" size={24} /></div> : <DemandEmpty title={t('forumPostUnavailable')}
        detail={detail.error ?? t('forumRetryHint')} actionLabel={t('retry')} onAction={props.onRefresh} />
        : <div className={css.detail} aria-busy={detail.status === 'loading'}>
          <article className={css.readingPane}>
            <header className={css.postHeader}>
              <AuthorTime name={post.authorName} createdAt={post.createdAt} t={t} /><h2>{post.title}</h2></header>
            <p className={css.body}>{post.body}</p>
            <div className={css.postActions}>
              <Button className={css.likeButton} variant="ghost" aria-pressed={post.liked}
                icon={post.liked ? <IconLikeFillRegular size={16} /> : <IconLikeOutlineRegular size={16} />}
                aria-busy={post.likeOperation.state === 'submitting'}
                disabled={!ready || !post.canLike || operationLocked(post.likeOperation)}
                onClick={() => { props.onToggleLike(post.id) }}>{t(post.likeOperation.state === 'submitting'
                  ? 'forumSubmitting' : post.liked ? 'forumLiked' : 'forumLike')}
                {post.likeCount === null ? null : <> <span className={css.likeCount}>{post.likeCount}</span></>}</Button>
              <RecoveryAction operation={post.likeOperation} onCheck={() => { props.onCheckLike(post.id) }} t={t} />
            </div>
            <OperationNotice operation={post.likeOperation} t={t} />
          </article>
          <aside className={css.discussionPane}>
            <section className={css.replies} aria-labelledby={`${formId}-replies`}>
              <h3 id={`${formId}-replies`}>{t('forumReplies')}
                {post.replyCount === null ? null : <span>{post.replyCount}</span>}</h3>
              {post.replies.length === 0 ? <p className={css.note}>{t('forumNoReplies')}</p>
                : <ul className={css.replyList}>{post.replies.map(reply => <li key={reply.id}>
                  <article className={css.reply}><AuthorTime name={reply.authorName} createdAt={reply.createdAt} t={t} />
                    <p className={css.body}>{reply.body}</p>
                  </article></li>)}</ul>}
              {!post.hasMoreReplies ? null : <div className={css.loadMore}><Button variant="outline" size="sm"
                disabled={post.loadingMoreReplies} onClick={props.onLoadMoreReplies}>
                {t(post.loadingMoreReplies ? 'forumLoadingMore' : 'forumLoadMoreReplies')}</Button></div>}
            </section>
            <form className={css.replyForm} aria-label={t('forumReplyForm')} onSubmit={(event) => {
              event.preventDefault()
              if (canSubmitReply) props.onSubmitReply()
            }}>
              <label className={css.field} htmlFor={`${formId}-reply`}><span>{t('forumReplyBody')}</span>
                <textarea id={`${formId}-reply`} value={replyDraft} rows={3} disabled={replyEditingLocked}
                  onChange={(event) => { if (!replyEditingLocked) props.onChangeReply(event.target.value) }} /></label>
              {post.replyReason === null ? null : <p className={css.note}>{post.replyReason}</p>}
              <OperationNotice operation={replyOperation} t={t} />
              <div className={css.formFooter}>
                <p className={css.note}>{t('forumPublicHint')}</p>
                {recoverable(replyOperation) ? <RecoveryAction operation={replyOperation} onCheck={props.onCheckReply} t={t} />
                  : <Button className={css.publishButton} type="submit" variant="accent" disabled={!canSubmitReply}>
                    {t(replyOperation.state === 'submitting' ? 'forumSubmitting' : 'forumSendReply')}</Button>}
              </div>
            </form>
          </aside>
        </div>}
    </Modal>
    <Modal open={props.postComposerOpen} onClose={props.onClosePostComposer} title={t('forumNewPost')} closeLabel={t('close')}
      className={clsx(css.dialog)} contentClassName={clsx(css.dialogContent)} footer={<div className={css.actions}>
        <Button onClick={props.onClosePostComposer}>{t('cancel')}</Button>
        {recoverable(postOperation) ? <RecoveryAction operation={postOperation} onCheck={props.onCheckPost} t={t} />
          : <Button className={css.publishButton} type="submit" form={`${formId}-post`} variant="accent" disabled={!canSubmitPost}>
            {t(postOperation.state === 'submitting' ? 'forumSubmitting' : 'forumPublish')}</Button>}
      </div>}>
      <form id={`${formId}-post`} className={css.form} aria-busy={postOperation.state === 'submitting'} onSubmit={(event) => {
        event.preventDefault()
        if (canSubmitPost) props.onSubmitPost()
      }}>
        {view.accountName?.trim() ? <p className={css.note}>{t('forumPostingAs', { name: view.accountName })}</p> : null}
        <label className={css.field} htmlFor={`${formId}-title`}><span>{t('forumPostTitle')}</span>
          <Input id={`${formId}-title`} value={postDraft.title} disabled={postEditingLocked} required
            onChange={(event) => { if (!postEditingLocked) props.onChangePost({ title: event.target.value }) }} /></label>
        <label className={css.field} htmlFor={`${formId}-body`}><span>{t('forumPostBody')}</span>
          <textarea id={`${formId}-body`} value={postDraft.body} disabled={postEditingLocked} required rows={6}
            onChange={(event) => { if (!postEditingLocked) props.onChangePost({ body: event.target.value }) }} /></label>
        <p className={css.note}>{t('forumPublicHint')}</p>
        <OperationNotice operation={postOperation} t={t} />
      </form>
    </Modal>
  </section>
}
