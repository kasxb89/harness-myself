/** Private human conversation, scoped draft, uploads and delivery acceptance. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button, Input, IconChevronLeftOutlineRegular, IconNewChatOutlineRegular,
  IconPaperclipOutlineRegular, IconPaperPlaneOutlineRegular, IconCheckCircleOutlineRegular,
  IconInfoOutlineRegular, IconListPenOutlineRegular, Tooltip, observeComposition,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DemandConversation, DemandDraft, DemandPageFace, DemandUploadRules } from './types.ts'
import {
  DemandSkeleton, DemandStatusTag, EngineerAvatar, EngineerPresence, demandBytes, demandTime,
  engineerName, ServiceProfileAvatar, type DemandTranslate,
} from './DemandUI.tsx'
import { DemandAttachments, DemandUploads } from './DemandAttachments.tsx'
import css from './DemandPage.module.css'

type ChatActions = Pick<DemandPageFace, 'refresh' | 'updateDraft' | 'send' | 'addAttachments' | 'removeAttachment'
  | 'retryAttachment' | 'retryMessage' | 'loadEarlierMessages' | 'downloadAttachment' | 'acceptDelivery'>

const formatNames: ReadonlyMap<string, string> = new Map([
  ['image/jpeg', 'JPG'], ['.jpg', 'JPG'], ['.jpeg', 'JPG'],
  ['image/png', 'PNG'], ['.png', 'PNG'],
  ['image/webp', 'WebP'], ['.webp', 'WebP'],
  ['image/gif', 'GIF'], ['.gif', 'GIF'],
  ['image/avif', 'AVIF'], ['.avif', 'AVIF'],
  ['image/svg+xml', 'SVG'], ['.svg', 'SVG'],
  ['image/heic', 'HEIC'], ['.heic', 'HEIC'],
  ['video/mp4', 'MP4'], ['.mp4', 'MP4'],
  ['video/webm', 'WebM'], ['.webm', 'WebM'],
  ['video/quicktime', 'MOV'], ['.mov', 'MOV'],
  ['application/pdf', 'PDF'], ['.pdf', 'PDF'],
  ['text/plain', 'TXT'], ['.txt', 'TXT'],
])

function acceptedFormats(accept: string, t: DemandTranslate): string {
  const names = accept.split(',').map(value => value.trim()).filter(value => value !== '').map((value) => {
    switch (value.toLowerCase()) {
      case 'image/*': return t('uploadImageFormats')
      case 'video/*': return t('uploadVideoFormats')
      case 'audio/*': return t('uploadAudioFormats')
      case '*/*': return t('uploadAllFormats')
      default: return formatNames.get(value.toLowerCase()) ?? value
    }
  })
  return names.length > 0 ? Array.from(new Set(names)).join(' / ') : t('uploadFormatsUnspecified')
}

/**
 * Render receipt-owned messages, scoped uploads and explicit delivery acceptance.
 * @param props - Conversation projection, original-operation recovery flag and commands.
 * @returns The selected human chat with a scoped composer or read-only notice.
 */
export function DemandChat(props: {
  conversation: DemandConversation
  draft: DemandDraft | null
  pendingPublish: boolean
  rules: DemandUploadRules
  actions: ChatActions
  back: () => void
  create: () => void
  t: DemandTranslate
}): ReactNode {
  const { conversation, draft, pendingPublish, rules, actions, back, create, t } = props
  const scroller = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const textInput = useRef<HTMLTextAreaElement>(null)
  const composition = useRef<ReturnType<typeof observeComposition> | null>(null)
  const pinned = useRef(true)
  const lastScope = useRef(conversation.scopeKey)
  const [confirmDelivery, setConfirmDelivery] = useState<string | null>(null)
  const [showRules, setShowRules] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const currentDraft = draft?.scopeKey === conversation.scopeKey ? draft : null
  const unassigned = conversation.assigned === false
  const name = unassigned ? t('platformReception') : engineerName(conversation.engineer, t)
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
  }, [currentDraft?.text, conversation.canSend, pendingPublish])
  useEffect(() => {
    const pane = scroller.current
    if (pane === null) return
    if (lastScope.current !== conversation.scopeKey) {
      lastScope.current = conversation.scopeKey
      pinned.current = true
    }
    if (pinned.current) pane.scrollTop = pane.scrollHeight
  }, [conversation.scopeKey, conversation.messages.length, lastMessage?.id, lastMessage?.state, conversation.delivery?.id])
  const scrollToLatest = () => {
    const pane = scroller.current
    if (pane !== null && pinned.current) pane.scrollTop = pane.scrollHeight
  }
  const editingLocked = currentDraft === null || currentDraft.sending || pendingPublish
  const canSend = currentDraft !== null && !currentDraft.sending
    && (pendingPublish || (conversation.canSend && (currentDraft.text.trim() !== '' || currentDraft.attachments.length > 0)
      && currentDraft.attachments.every(attachment => attachment.status === 'ready')))
  const delivery = conversation.delivery
  const uploadHint = rules.maxImageBytes !== undefined && rules.maxVideoBytes !== undefined
    ? t('uploadMediaLimits', { count: rules.maxFiles, imageSize: demandBytes(rules.maxImageBytes, t), videoSize: demandBytes(rules.maxVideoBytes, t) })
    : t('uploadLimits', { count: rules.maxFiles, size: demandBytes(rules.maxFileBytes, t) })
  return <section className={css.chat} aria-label={t('chatWith', { name })}>
    <header className={css.chatHeader}>
      <Button className={css.backButton} size="sm" aria-label={t('backToRequests')} onClick={back}
        icon={<IconChevronLeftOutlineRegular size={18} />} />
      {unassigned ? <ServiceProfileAvatar small /> : <EngineerAvatar engineer={conversation.engineer} small />}
      <div className={css.chatHeading}>
        <h2>{name}</h2>
        <div className={css.chatHeadingMeta}>
          {conversation.number ? <span>{t('requestNumber', { number: conversation.number })}</span>
            : <span>{t(pendingPublish ? 'pendingPublish' : 'notPublished')}</span>}
          {unassigned || conversation.engineer === null ? null : <EngineerPresence engineer={conversation.engineer} t={t} />}
          {conversation.status === null ? null : <DemandStatusTag status={conversation.status} unassigned={unassigned} t={t} />}
          {!conversation.serviceProfileName?.trim() ? null : <span>{t('serviceSource', { name: conversation.serviceProfileName })}</span>}
        </div>
      </div>
      <Button className={css.chatNew} size="sm" onClick={create} icon={<IconNewChatOutlineRegular size={15} />}>{t('newRequest')}</Button>
    </header>
    <div ref={scroller} className={css.messages} role="log" aria-label={t('chatWith', { name })}
      aria-live="polite" aria-relevant="additions text" onLoadCapture={scrollToLatest}
      onScroll={(event) => {
        const pane = event.currentTarget
        pinned.current = pane.scrollHeight - pane.clientHeight - pane.scrollTop < 64
      }}>
      {!conversation.hasEarlier ? null : <div className={css.historyAction}>
        <Button size="sm" disabled={conversation.loadingEarlier} onClick={() => { pinned.current = false; actions.loadEarlierMessages() }}>
          {t(conversation.loadingEarlier ? 'loadingEarlier' : 'loadEarlier')}
        </Button>
      </div>}
      {conversation.messagesStatus === 'loading' && conversation.messages.length === 0 ? <DemandSkeleton compact label={t('loading')} /> : null}
      {conversation.messagesStatus !== 'error' ? null : <div className={css.inlineNotice} role="alert">
        <span>{t('messagesFailed')}</span><Button size="sm" onClick={actions.refresh}>{t('retry')}</Button>
      </div>}
      {conversation.messagesStatus !== 'ready' || conversation.messages.length > 0 ? null : <div className={css.chatStart}>
        <span className={css.chatStartIcon} aria-hidden="true"><IconNewChatOutlineRegular size={26} /></span>
        <h3>{t('noMessages')}</h3><p>{t('noMessagesHint')}</p>
      </div>}
      {conversation.messages.map(message => message.author === 'system'
        ? <div key={message.id} className={css.systemMessage}><span>{message.text}</span>
          <time dateTime={message.createdAt}>{demandTime(message.createdAt, t)}</time></div>
        : <article key={message.id} className={css.message} data-author={message.author}>
          {message.author !== 'engineer' ? null : <span className={css.messageAuthor}>{message.authorName?.trim() || t('engineerName')}</span>}
          <div className={css.messageBubble}>
            {message.text === '' ? null : <p>{message.text}</p>}
            <DemandAttachments attachments={message.attachments} download={actions.downloadAttachment} t={t} />
          </div>
          <div className={css.messageMeta}><time dateTime={message.createdAt}>{demandTime(message.createdAt, t)}</time>
            {message.author !== 'user' ? null : <span data-failed={message.state === 'failed'}>
              {t(message.state === 'sending' ? 'sending' : message.state === 'failed' ? 'sendFailed' : message.read ? 'read' : 'sent')}
            </span>}
            {message.state !== 'failed' || !message.retryable ? null : <Button size="sm" onClick={() => { actions.retryMessage(message.id) }}>
              {t('retryMessage')}
            </Button>}
          </div>
          {message.state !== 'failed' || !message.error ? null : <p className={css.messageError}>{message.error}</p>}
        </article>)}
      {delivery === null ? null : <section className={css.delivery} aria-label={t('deliveryTitle')}>
        <div className={css.deliveryHeading}>
          <span aria-hidden="true"><IconCheckCircleOutlineRegular size={20} /></span>
          <h3>{t(delivery.status === 'accepted' ? 'deliveryAccepted' : 'deliveryPending')}</h3>
          <time dateTime={delivery.submittedAt}>{demandTime(delivery.submittedAt, t)}</time>
        </div>
        {delivery.title.trim() === '' ? null : <h4>{delivery.title}</h4>}
        {delivery.description.trim() === '' ? null : <p>{delivery.description}</p>}
        <DemandAttachments attachments={delivery.attachments} download={actions.downloadAttachment} t={t} />
        {delivery.status === 'accepted' ? null : confirmDelivery === delivery.id ? <div className={css.acceptance}>
          <p>{t('acceptConfirmHint')}</p><div>
            <Button variant="primary" size="sm" disabled={conversation.acceptingDelivery}
              onClick={() => { actions.acceptDelivery(delivery.id) }}>{t(conversation.acceptingDelivery ? 'accepting' : 'acceptConfirm')}</Button>
            <Button size="sm" disabled={conversation.acceptingDelivery} onClick={() => { setConfirmDelivery(null) }}>{t('cancel')}</Button>
          </div>
        </div> : <Button size="sm" variant="outline" onClick={() => { setConfirmDelivery(delivery.id) }}>{t('acceptDelivery')}</Button>}
      </section>}
    </div>
    {conversation.error === null && currentDraft?.error == null ? null : <div className={css.composerError} role="alert">
      {currentDraft?.error ?? conversation.error}
    </div>}
    {!conversation.canSend && !pendingPublish ? <div className={css.readOnly}>{conversation.readOnlyReason ?? t('requestReadOnly')}</div>
      : <form className={css.composer} onSubmit={(event) => { event.preventDefault(); if (canSend) actions.send() }}>
        {unassigned || conversation.engineer?.presence !== 'offline' ? null : <p className={css.offlineHint}>{t('offlineHint')}</p>}
        <div className={css.composerCard}>
          <div className={css.composerFields}>
            <DemandUploads attachments={currentDraft?.attachments ?? []} remove={actions.removeAttachment}
              retry={actions.retryAttachment} disabled={editingLocked} t={t} />
            <textarea ref={textInput} rows={1} value={currentDraft?.text ?? ''} disabled={editingLocked}
              aria-label={t(conversation.requestId === null ? 'describeRequest' : 'messagePlaceholder')}
              placeholder={t(conversation.requestId === null ? 'describeRequest' : 'messagePlaceholder')}
              onChange={(event) => { actions.updateDraft({ text: event.target.value }) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
                  if (composition.current?.guards(event.nativeEvent) ?? event.nativeEvent.isComposing) return
                  event.preventDefault()
                  if (canSend && !event.repeat) actions.send()
                }
              }} />
            {conversation.requestId !== null || !showDetails ? null
              : <div className={css.optionalFields} id={`details-${conversation.scopeKey}`}>
                <label>{t('titleLabel')}<Input value={currentDraft?.title ?? ''} placeholder={t('titlePlaceholder')}
                  disabled={editingLocked}
                  onChange={(event) => { actions.updateDraft({ title: event.target.value }) }} /></label>
                <label>{t('budgetLabel')}<Input value={currentDraft?.budget ?? ''} placeholder={t('budgetPlaceholder')}
                  disabled={editingLocked}
                  onChange={(event) => { actions.updateDraft({ budget: event.target.value }) }} /></label>
                <label>{t('expectedDateLabel')}<Input type="date" value={currentDraft?.expectedDate ?? ''}
                  disabled={editingLocked}
                  onChange={(event) => { actions.updateDraft({ expectedDate: event.target.value }) }} /></label>
              </div>}
          </div>
          <footer className={css.composerToolbar}>
            <input ref={fileInput} className={css.fileInput} type="file" accept={rules.accept} multiple={rules.maxFiles > 1}
              disabled={editingLocked}
              aria-label={t('selectAttachmentFiles')} onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? [])
                if (files.length > 0) actions.addAttachments(files)
                event.currentTarget.value = ''
              }} />
            <Tooltip label={t('addAttachments')} side="top" portal>
              <Button size="sm" disabled={editingLocked || rules.maxFiles < 1} aria-label={t('addAttachments')}
                onClick={() => { fileInput.current?.click() }} icon={<IconPaperclipOutlineRegular size={18} />} />
            </Tooltip>
            <Tooltip label={t('attachmentRules')} side="top" portal>
              <Button size="sm" aria-label={t('attachmentRules')} aria-expanded={showRules} aria-controls={`rules-${conversation.scopeKey}`}
                onClick={() => { setShowRules(value => !value) }} icon={<IconInfoOutlineRegular size={17} />} />
            </Tooltip>
            {conversation.requestId !== null ? null : <Button size="sm" aria-expanded={showDetails}
              aria-controls={`details-${conversation.scopeKey}`} disabled={editingLocked}
              onClick={() => { setShowDetails(value => !value) }} icon={<IconListPenOutlineRegular size={16} />}>{t('optionalDetails')}</Button>}
            <Button className={css.sendButton} type="submit" variant="primary" disabled={!canSend}
              icon={<IconPaperPlaneOutlineRegular size={16} />}>
              {t(currentDraft?.sending ? 'sending' : pendingPublish ? 'confirmPublication' : 'send')}
            </Button>
          </footer>
        </div>
        {!showRules ? null : <p id={`rules-${conversation.scopeKey}`} className={css.uploadLimits}>
          {t('uploadRulesWithFormats', { limits: uploadHint, formats: acceptedFormats(rules.accept, t) })}
        </p>}
      </form>}
  </section>
}
