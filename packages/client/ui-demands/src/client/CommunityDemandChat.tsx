/** Authorized person-to-person chat; operation identity and media access stay with its parent. */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Button, Tooltip, IconChevronLeftOutlineRegular, IconPaperclipOutlineRegular,
  IconPaperPlaneOutlineRegular, observeComposition } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CommunityChatAuthorKind, CommunityChatView } from './community-view.ts'
import type { DemandAttachment, DemandUploadRules } from './types.ts'
import type { DemandLocaleKey } from './locales.ts'
import { DemandAttachments, DemandUploads } from './DemandAttachments.tsx'
import { DemandSkeleton, demandBytes, demandTime, type DemandTranslate } from './DemandUI.tsx'
import pageCss from './DemandPage.module.css'
import css from './CommunityDemand.module.css'

const authorKeys: Record<CommunityChatAuthorKind, DemandLocaleKey> = {
  publisher: 'communityPublisher', acceptor: 'communityAcceptor', admin: 'communityAdministrator', system: 'systemMessage',
}

/**
 * Render immutable message authors and controlled drafts without creating operations or inferring send permission.
 * @param props - Authorized conversation, current draft, permission locks and original-operation callbacks.
 * @returns One message scroller and a permitted composer or a read-only explanation.
 */
export function CommunityDemandChat(props: {
  conversation: CommunityChatView
  draftText: string
  attachments: readonly DemandAttachment[]
  locked: boolean
  sending: boolean
  draftError: string | null
  rules: DemandUploadRules
  onBack: () => void
  onChange: (text: string) => void
  onSend: () => void
  onAddAttachments: (files: readonly File[]) => void
  onRemoveAttachment: (id: string) => void
  onRetryAttachment: (id: string) => void
  onDownloadAttachment: (id: string) => void
  onRetryMessage: (key: string) => void
  onCheckMessage: (key: string) => void
  onLoadMoreMessages: () => void
  onRefresh: () => void
  t: DemandTranslate
}): ReactNode {
  const { conversation, draftText, attachments, locked, sending, draftError, rules, t } = props
  const scroller = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const textInput = useRef<HTMLTextAreaElement>(null)
  const composition = useRef<ReturnType<typeof observeComposition> | null>(null)
  const pinned = useRef(true)
  const lastScope = useRef(conversation.key)
  const editingLocked = !conversation.canSend || locked || sending
  const canSend = !editingLocked && (draftText.trim() !== '' || attachments.length > 0)
    && attachments.every(item => item.status === 'ready')
  const lastMessage = conversation.messages.at(-1)
  useEffect(() => {
    const guard = observeComposition(document)
    composition.current = guard
    return () => { composition.current = null; guard.dispose() }
  }, [])
  useLayoutEffect(() => {
    const input = textInput.current
    if (input === null) return
    const resize = () => {
      input.style.height = '0px'
      const height = Math.max(36, Math.min(input.scrollHeight, 160))
      input.style.height = `${height}px`
      input.style.overflowY = input.scrollHeight > height ? 'auto' : 'hidden'
    }
    resize()
    let width = input.getBoundingClientRect().width
    const observer = new ResizeObserver(() => {
      const nextWidth = input.getBoundingClientRect().width
      if (nextWidth === width) return
      width = nextWidth
      resize()
    })
    observer.observe(input)
    return () => { observer.disconnect() }
  }, [draftText, conversation.canSend, locked, sending])
  useEffect(() => {
    const pane = scroller.current
    if (pane === null) return
    if (lastScope.current !== conversation.key) {
      lastScope.current = conversation.key
      pinned.current = true
    }
    if (pinned.current) pane.scrollTop = pane.scrollHeight
  }, [conversation.key, conversation.messages.length, lastMessage?.key, lastMessage?.state])
  const counterpart = conversation.counterparty
  const counterpartLabel = counterpart === null ? t('communityBoardPublic')
    : t('communityMessageAuthorNamed', {
      name: counterpart.name?.trim() || t('communityParticipant'), role: t(authorKeys[counterpart.role]),
    })
  const uploadLimits = rules.maxImageBytes !== undefined && rules.maxVideoBytes !== undefined
    ? t('uploadMediaLimits', { count: rules.maxFiles,
      imageSize: demandBytes(rules.maxImageBytes, t), videoSize: demandBytes(rules.maxVideoBytes, t) })
    : t('uploadLimits', { count: rules.maxFiles, size: demandBytes(rules.maxFileBytes, t) })
  return <section className={pageCss.chat} aria-label={t('communityChatNamed', { title: conversation.title })}>
    <header className={pageCss.chatHeader}>
      <Button size="sm" icon={<IconChevronLeftOutlineRegular size={16} />} onClick={props.onBack}>{t('communityBackToBoard')}</Button>
      <div className={pageCss.chatHeading}><h2>{conversation.title}</h2>
        <div className={pageCss.chatHeadingMeta}>{counterpartLabel}</div>
      </div>
    </header>
    <p className={css.chatPrivacy}>{t('communityChatPrivacy')}</p>
    <div ref={scroller} className={pageCss.messages} role="log" aria-label={t('communityChatNamed', { title: conversation.title })}
      aria-live="polite" aria-relevant="additions text" onLoadCapture={() => {
        const pane = scroller.current
        if (pane !== null && pinned.current) pane.scrollTop = pane.scrollHeight
      }} onScroll={(event) => {
        const pane = event.currentTarget
        pinned.current = pane.scrollHeight - pane.clientHeight - pane.scrollTop < 64
      }}>
      {!conversation.hasMoreMessages ? null : <div className={pageCss.historyAction}>
        <Button size="sm" disabled={conversation.loadingMoreMessages} onClick={props.onLoadMoreMessages}>
          {t(conversation.loadingMoreMessages ? 'communityLoadingMoreMessages' : 'communityLoadMoreMessages')}</Button>
      </div>}
      {conversation.status !== 'loading' || conversation.messages.length > 0 ? null : <DemandSkeleton compact label={t('loading')} />}
      {conversation.status !== 'error' && conversation.error === null ? null : <div className={pageCss.inlineNotice} role="alert">
        <span>{conversation.error ?? t('messagesFailed')}</span><Button size="sm" onClick={props.onRefresh}>{t('retry')}</Button>
      </div>}
      {conversation.status !== 'ready' || conversation.messages.length > 0 ? null : <div className={pageCss.chatStart}>
        <h3>{t('noMessages')}</h3><p>{t('noMessagesHint')}</p>
      </div>}
      {conversation.messages.map(message => message.authorKind === 'system'
        ? <div key={message.key} className={pageCss.systemMessage} data-author-kind="system">
          <span>{message.authorName?.trim() || t('systemMessage')}</span><span>{message.text}</span>
          <time dateTime={message.createdAt}>{demandTime(message.createdAt, t)}</time>
          <DemandAttachments attachments={message.attachments} download={props.onDownloadAttachment} t={t} />
        </div>
        : <article key={message.key} className={pageCss.message} data-author={message.isSelf ? 'user' : 'peer'}
          data-author-kind={message.authorKind} data-self={message.isSelf}>
          <span className={pageCss.messageAuthor}>{message.authorName?.trim()
            ? t('communityMessageAuthorNamed', { name: message.authorName, role: t(authorKeys[message.authorKind]) })
            : t(authorKeys[message.authorKind])}</span>
          <div className={pageCss.messageBubble}>
            {message.text === '' ? null : <p>{message.text}</p>}
            <DemandAttachments attachments={message.attachments} download={props.onDownloadAttachment} t={t} />
          </div>
          <div className={pageCss.messageMeta}><time dateTime={message.createdAt}>{demandTime(message.createdAt, t)}</time>
            {!message.isSelf ? null : <span data-failed={message.state === 'failed'}>
              {t(message.state === 'unknown' ? 'communityMessageUnknown' : message.state === 'sending' ? 'sending'
                : message.state === 'failed' ? 'sendFailed' : 'sent')}</span>}
            {!message.isSelf || message.state !== 'failed' || message.recovery !== 'retry' ? null
              : <Button size="sm" disabled={editingLocked || message.recovering}
                onClick={() => { props.onRetryMessage(message.key) }}>{t('retryMessage')}</Button>}
            {!message.isSelf || message.state !== 'unknown' || message.recovery !== 'check' ? null
              : <Button size="sm" disabled={message.recovering}
                onClick={() => { props.onCheckMessage(message.key) }}>{t('communityCheckMessage')}</Button>}
          </div>
          {!message.error ? null : <p className={pageCss.messageError}>{message.error}</p>}
        </article>)}
    </div>
    {draftError === null ? null : <div className={pageCss.composerError} role="alert">{draftError}</div>}
    {!conversation.canSend ? <div className={pageCss.readOnly}>{conversation.readOnlyReason ?? t('requestReadOnly')}</div>
      : <form className={pageCss.composer} onSubmit={(event) => { event.preventDefault(); if (canSend) props.onSend() }}>
        <div className={pageCss.composerCard}>
          <div className={css.chatComposerFields}>
            <DemandUploads attachments={attachments} remove={props.onRemoveAttachment} retry={props.onRetryAttachment}
              disabled={editingLocked} t={t} />
            <textarea ref={textInput} rows={1} value={draftText} disabled={editingLocked} aria-label={t('messagePlaceholder')}
              placeholder={t('messagePlaceholder')} onChange={(event) => { if (!editingLocked) props.onChange(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
                  if (composition.current?.guards(event.nativeEvent) ?? event.nativeEvent.isComposing) return
                  event.preventDefault()
                  if (canSend && !event.repeat) props.onSend()
                }
              }} />
          </div>
          <footer className={pageCss.composerToolbar}>
            <input ref={fileInput} className={pageCss.fileInput} type="file" accept={rules.accept} multiple={rules.maxFiles > 1}
              disabled={editingLocked || rules.maxFiles < 1} aria-label={t('selectAttachmentFiles')} onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? [])
                if (!editingLocked && rules.maxFiles > 0 && files.length > 0) props.onAddAttachments(files)
                event.currentTarget.value = ''
              }} />
            <Tooltip label={t('addAttachments')} portal>
              <Button size="sm" disabled={editingLocked || rules.maxFiles < 1} aria-label={t('addAttachments')}
                onClick={() => { fileInput.current?.click() }} icon={<IconPaperclipOutlineRegular size={18} />} />
            </Tooltip>
            <Button className={pageCss.sendButton} type="submit" variant="primary" disabled={!canSend}
              icon={<IconPaperPlaneOutlineRegular size={16} />}>{t(sending ? 'sending' : 'send')}</Button>
          </footer>
        </div>
        <p className={pageCss.uploadLimits}>{uploadLimits}</p>
      </form>}
  </section>
}
