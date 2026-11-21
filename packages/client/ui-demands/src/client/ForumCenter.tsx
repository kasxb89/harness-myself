/** A forum view renders supplied public posts without owning transport or submission identities. */
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, Input, Modal, StateDot, IconCloseOutlineRegular, IconLikeFillRegular,
  IconLikeOutlineRegular, IconQueueOutlineRegular, IconUserOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ForumCenterProps, ForumOperationView } from './forum-view.ts'
import { DemandEmpty, DemandSkeleton, demandTime, type DemandTranslate } from './DemandUI.tsx'
import { ForumEmojiPicker } from './ForumEmojiPicker.tsx'
import { ForumAccountControls } from './ForumAccountControls.tsx'
import { ForumImageComposer, ForumImages } from './ForumImages.tsx'
import { forumAccountControlLabels } from './forum-adapter.ts'
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

function ForumAvatar({ name, src }: { name: string | null; src: string | null | undefined }): ReactNode {
  const [failed, setFailed] = useState(false)
  const author = name?.trim()
  return <span className={css.avatar} aria-hidden="true">
    {!src || failed ? author ? Array.from(author)[0] : <IconUserOutlineRegular size={16} />
      : <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => { setFailed(true) }} />}
  </span>
}

function AuthorTime({ name, src, createdAt, t }: {
  name: string | null
  src: string | null | undefined
  createdAt: string
  t: DemandTranslate
}): ReactNode {
  const author = name?.trim()
  return <div className={css.metadata}>
    <ForumAvatar key={src} name={name} src={src} />
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
  const postBodyRef = useRef<HTMLTextAreaElement>(null)
  const replyBodyRef = useRef<HTMLTextAreaElement>(null)
  const replyNodes = useRef(new Map<string, HTMLElement>())
  const emojiCaret = useRef<{ field: 'post' | 'reply'; value: string; position: number } | null>(null)
  useLayoutEffect(() => {
    const caret = emojiCaret.current
    if (caret === null || caret.value !== (caret.field === 'post' ? postDraft.body : replyDraft)) return
    emojiCaret.current = null
    const input = caret.field === 'post' ? postBodyRef.current : replyBodyRef.current
    input?.focus()
    input?.setSelectionRange(caret.position, caret.position)
  }, [postDraft.body, replyDraft])
  const detail = view.detail
  const post = detail.post?.id === detail.postId ? detail.post : null
  const highlightedReplyExists = post?.replies.some(reply => reply.id === props.highlightedReplyId) === true
  useLayoutEffect(() => {
    if (!highlightedReplyExists || props.highlightedReplyId === null || props.highlightedReplyId === undefined) return
    const element = replyNodes.current.get(props.highlightedReplyId)
    element?.scrollIntoView({ block: 'center' })
    element?.focus({ preventScroll: true })
  }, [props.highlightedReplyId, highlightedReplyExists, post?.id])
  const ready = view.availability === 'ready'
  const postEditingLocked = props.postLocked || !ready || !view.canCreate || operationLocked(postOperation)
  const replyEditingLocked = props.replyLocked || !ready || post?.canReply !== true || operationLocked(replyOperation)
  const insertEmoji = (field: 'post' | 'reply', emoji: string): void => {
    if (field === 'post' ? postEditingLocked : replyEditingLocked) return
    const input = field === 'post' ? postBodyRef.current : replyBodyRef.current
    const value = field === 'post' ? postDraft.body : replyDraft
    const start = input?.selectionStart ?? value.length, end = input?.selectionEnd ?? value.length
    const next = value.slice(0, start) + emoji + value.slice(end)
    emojiCaret.current = { field, value: next, position: start + emoji.length }
    if (field === 'post') props.onChangePost({ body: next })
    else props.onChangeReply(next)
  }
  const postImagesReady = props.postMedia?.items.every(item => item.status === 'ready') !== false
  const replyImagesReady = props.replyMedia?.items.every(item => item.status === 'ready') !== false
  const postHasImages = (props.postMedia?.items.length ?? 0) > 0
  const replyHasImages = (props.replyMedia?.items.length ?? 0) > 0
  const postHasContent = postDraft.body.trim() !== '' || props.postMedia?.allowImageOnly === true && postHasImages
  const replyHasContent = replyDraft.trim() !== '' || props.replyMedia?.allowImageOnly === true && replyHasImages
  const canSubmitPost = !postEditingLocked && postImagesReady && postDraft.title.trim() !== '' && postHasContent
  const canSubmitReply = !replyEditingLocked && replyImagesReady && replyHasContent
  const retainedPost = postDraft.title !== '' || postDraft.body !== '' || postHasImages || postOperation.state !== 'idle'
  const commentsScope = view.list.kind === 'comments' || props.accountControls?.scope === 'comments'
  const historyComments = view.list.comments ?? []
  const listCount = commentsScope ? historyComments.length : view.list.posts.length
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
    {props.accountControls === undefined ? null : <ForumAccountControls {...props.accountControls}
      disabled={props.accountControls.disabled === true || !ready} labels={forumAccountControlLabels(t)} />}
    {showNotice ? <p className={css.notice} role="status">{view.reason
      ?? t(view.availability === 'login-required' ? 'forumSignIn' : 'forumDisabled')}</p> : null}
    {props.postComposerOpen || !recoverable(postOperation) ? null : <div className={css.queryError}>
      <OperationNotice operation={postOperation} t={t} /><RecoveryAction operation={postOperation} onCheck={props.onCheckPost} t={t} />
    </div>}
    <div className={css.viewport}>
      {listCount === 0 || view.list.error === null && view.list.status !== 'error' ? null : <div className={css.queryError} role="alert">
        <span>{view.list.error ?? t('forumLoadFailed')}</span><Button size="sm"
          disabled={view.list.status === 'loading'} onClick={props.onRefresh}>{t('retry')}</Button></div>}
      {commentsScope && historyComments.length > 0 ? <ul className={css.postList} aria-label={t('forumMyComments')}
        aria-busy={view.list.status === 'loading'}>{historyComments.map(comment => <li key={comment.id}>
          <article className={css.historyComment}>
            <AuthorTime name={comment.authorName} src={comment.authorAvatarUrl} createdAt={comment.createdAt} t={t} />
            <button type="button" className={css.postOpen} aria-haspopup="dialog"
              aria-label={t('forumOpenPost', { title: comment.postTitle })} onClick={() => {
                if (props.onOpenHistoryComment !== undefined) props.onOpenHistoryComment(comment.postId, comment.id)
                else props.onOpenPost(comment.postId)
              }}><span className={css.commentPostTitle}>{t('forumCommentOn', { title: comment.postTitle })}</span>
              <span className={css.excerpt}>{comment.body}</span></button>
            {comment.images === undefined ? null : <ForumImages images={comment.images} t={t} />}
          </article></li>)}</ul>
        : !commentsScope && view.list.posts.length > 0 ? <ul className={css.postList} aria-label={t('forumPostList')} aria-busy={view.list.status === 'loading'}>
          {view.list.posts.map(item => <li key={item.id}><article className={css.postRow}>
            <AuthorTime name={item.authorName} src={item.authorAvatarUrl} createdAt={item.createdAt} t={t} />
            <div className={css.postContent}><button type="button" className={css.postOpen} aria-haspopup="dialog"
              aria-label={t('forumOpenPost', { title: item.title })} onClick={() => { props.onOpenPost(item.id) }}>
              <span className={css.postTitle} role="heading" aria-level={3}>{item.title}</span>
              {item.excerpt.trim() === '' ? null : <span className={css.excerpt}>{item.excerpt}</span>}
            </button>{item.images === undefined ? null : <ForumImages images={item.images} t={t} />}</div>
            <div className={css.counts}>
              {item.likeCount === null ? null : <span><IconLikeOutlineRegular size={16} />{t('forumLikeCount', { count: item.likeCount })}</span>}
              {item.replyCount === null ? null : <span><IconQueueOutlineRegular size={16} />{t('forumReplyCount', { count: item.replyCount })}</span>}
            </div>
          </article></li>)}
        </ul> : view.list.status === 'loading' || view.availability === 'loading' ? <DemandSkeleton compact label={t('loading')} />
          : view.list.status === 'error' || view.availability === 'error' ? <DemandEmpty title={t('forumLoadFailed')}
            detail={view.list.error ?? view.reason ?? t('forumRetryHint')} actionLabel={t('retry')} onAction={props.onRefresh} />
            : view.availability !== 'ready' ? <DemandEmpty title={t(view.availability === 'login-required' ? 'forumSignIn' : 'forumDisabled')}
              detail={view.reason ?? t('forumUnavailableHint')} />
              : <DemandEmpty title={t(commentsScope ? 'forumMyCommentsEmpty' : props.accountControls?.scope === 'mine' ? 'forumMyPostsEmpty' : 'forumEmpty')}
                detail={t(commentsScope ? 'forumMyCommentsEmptyHint' : 'forumEmptyHint')} />}
      {!view.list.hasMore ? null : <div className={css.loadMore}><Button variant="outline" size="sm"
        disabled={view.list.loadingMore || view.list.status === 'loading'} onClick={props.onLoadMore}>
        {t(view.list.loadingMore ? 'forumLoadingMore' : 'forumLoadMore')}</Button></div>}
    </div>
    <Modal open={detail.postId !== null} onClose={props.onBack} title={post?.title ?? t('forumTabLabel')}
      className={clsx(css.detailDrawer)} backdropBlur={false} headless>
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
              <AuthorTime name={post.authorName} src={post.authorAvatarUrl} createdAt={post.createdAt} t={t} />
              <h2>{post.title}</h2></header>
            <p className={css.body}>{post.body}</p>
            {post.images === undefined ? null : <ForumImages images={post.images} t={t} />}
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
          <aside className={css.discussionPane} aria-label={t('forumReplies')}>
            <header className={css.discussionHeader}>
              <h3 id={`${formId}-replies`}>{t('forumReplies')}
                {post.replyCount === null ? null : <span>{post.replyCount}</span>}</h3>
            </header>
            <section className={css.replies} aria-labelledby={`${formId}-replies`}>
              {post.replies.length === 0 ? <p className={css.note}>{t('forumNoReplies')}</p>
                : <ul className={css.replyList}>{post.replies.map(reply => <li key={reply.id}>
                  <article className={css.reply} tabIndex={props.highlightedReplyId === reply.id ? -1 : undefined}
                    data-highlighted={props.highlightedReplyId === reply.id} ref={(element) => {
                      if (element === null) replyNodes.current.delete(reply.id)
                      else replyNodes.current.set(reply.id, element)
                    }}>
                    <ForumAvatar key={reply.authorAvatarUrl} name={reply.authorName} src={reply.authorAvatarUrl} />
                    <div className={css.replyContent}>
                      <div className={css.replyAuthor}><span>{reply.authorName?.trim() || t('forumMember')}</span>
                        {reply.createdAt === '' ? null : <time dateTime={reply.createdAt}>{demandTime(reply.createdAt, t)}</time>}</div>
                      <p className={css.body}>{reply.body}</p>
                      {!reply.replyTo ? null : <p className={css.replyRecipient}>
                        {t('forumReplyTo', { name: reply.replyTo.authorName?.trim() || t('forumMember') })}
                        {reply.replyTo.excerpt.trim() === '' ? null : <span>{reply.replyTo.excerpt}</span>}</p>}
                      {reply.images === undefined ? null : <ForumImages images={reply.images} t={t} />}
                      {props.onSelectReply === undefined ? null : <Button className={css.replyAction} size="sm" variant="ghost"
                        disabled={replyEditingLocked} aria-label={t('forumReplyTo', { name: reply.authorName?.trim() || t('forumMember') })}
                        onClick={() => {
                          if (!replyEditingLocked) { props.onSelectReply?.(reply.id); replyBodyRef.current?.focus() }
                        }}>{t('forumReplyAction')}</Button>}
                    </div>
                  </article></li>)}</ul>}
              {!post.hasMoreReplies ? null : <div className={css.loadMore}><Button variant="outline" size="sm"
                disabled={post.loadingMoreReplies} onClick={props.onLoadMoreReplies}>
                {t(post.loadingMoreReplies ? 'forumLoadingMore' : 'forumLoadMoreReplies')}</Button></div>}
            </section>
            <form className={css.replyForm} aria-label={t('forumReplyForm')} onSubmit={(event) => {
              event.preventDefault()
              if (canSubmitReply) props.onSubmitReply()
            }}>
              {!props.replyTarget ? null : <div className={css.replyTarget}>
                <div><span>{t('forumReplyTo', { name: props.replyTarget.authorName?.trim() || t('forumMember') })}</span>
                  {props.replyTarget.excerpt.trim() === '' ? null : <p>{props.replyTarget.excerpt}</p>}</div>
                {props.onCancelReply === undefined ? null : <Button size="sm" variant="ghost" disabled={replyEditingLocked}
                  icon={<IconCloseOutlineRegular size={14} />} aria-label={t('forumCancelReply')}
                  onClick={() => { if (!replyEditingLocked) props.onCancelReply?.() }} />}
              </div>}
              <label className={css.field} htmlFor={`${formId}-reply`}><span>{t('forumReplyBody')}</span>
                <textarea ref={replyBodyRef} id={`${formId}-reply`} value={replyDraft} rows={2} disabled={replyEditingLocked}
                  onChange={(event) => { if (!replyEditingLocked) props.onChangeReply(event.target.value) }} /></label>
              <ForumEmojiPicker label={t('forumEmoji')} groupLabel={t('forumChooseEmoji')} disabled={replyEditingLocked}
                onSelect={(emoji) => { insertEmoji('reply', emoji) }} />
              {props.replyMedia === undefined ? null : <ForumImageComposer media={props.replyMedia} disabled={replyEditingLocked} t={t} />}
              {replyImagesReady ? null : <p className={css.note} role="status">{t('forumMediaPending')}</p>}
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
          <textarea ref={postBodyRef} id={`${formId}-body`} value={postDraft.body} disabled={postEditingLocked}
            required={props.postMedia?.allowImageOnly !== true || !postHasImages} rows={6}
            onChange={(event) => { if (!postEditingLocked) props.onChangePost({ body: event.target.value }) }} /></label>
        <ForumEmojiPicker label={t('forumEmoji')} groupLabel={t('forumChooseEmoji')} disabled={postEditingLocked}
          onSelect={(emoji) => { insertEmoji('post', emoji) }} />
        {props.postMedia === undefined ? null : <ForumImageComposer media={props.postMedia} disabled={postEditingLocked} t={t} />}
        {postImagesReady ? null : <p className={css.note} role="status">{t('forumMediaPending')}</p>}
        <p className={css.note}>{t('forumPublicHint')}</p>
        <OperationNotice operation={postOperation} t={t} />
      </form>
    </Modal>
  </section>
}
