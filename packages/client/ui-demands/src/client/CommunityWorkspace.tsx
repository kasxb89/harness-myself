/** Account-owned community navigation; all mutations stay in the injected model. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CommunityFace, CommunityState } from './community-types.ts'
import type { CommunityBoardView } from './community-view.ts'
import type { DemandPageState } from './types.ts'
import { DemandEmpty, type DemandTranslate } from './DemandUI.tsx'
import { CommunityDemandBoard } from './CommunityDemandBoard.tsx'
import { CommunityDemandDetails } from './CommunityDemandDetails.tsx'
import { CommunityDemandPublish } from './CommunityDemandPublish.tsx'
import { CommunityDemandChat } from './CommunityDemandChat.tsx'
import { communityBoardPresentation, communityBoardTarget, communityDetailsPresentation, communityPublishPresentation,
  communityChatPresentation, communityIssueText } from './community-adapter.ts'
import css from './CommunityDemand.module.css'

/**
 * Join authorized collections, explicit public publication and participant-only chat.
 * @param props - Independent account-owned models and original entity callbacks.
 * @returns The personal community workspace without migrating any private record.
 */
export function CommunityWorkspace(props: {
  state: CommunityState
  legacy: DemandPageState
  commands: Omit<CommunityFace, 'hooks'>
  onLegacyOrder: (id: string) => void
  onLegacyDraft: (scopeKey: string) => void
  onOfficial: () => void
  refreshLegacy: () => void
  loadMoreLegacy: () => void
  onChatChange: (open: boolean) => void
  t: DemandTranslate
}): ReactNode {
  const { state, legacy, commands, t } = props
  const [view, setView] = useState<CommunityBoardView>('public')
  const [search, setSearch] = useState('')
  const [listingId, setListingId] = useState<string | null>(null)
  const [chatId, setChatId] = useState<string | null>(null)
  const [publicationOpen, setPublicationOpen] = useState(false)
  const [publicationKey, setPublicationKey] = useState<string | null>(null)
  const previousOrder = useRef(state.selectedOrderId)
  const reselect = useRef<HTMLInputElement>(null)
  const [reselectId, setReselectId] = useState<string | null>(null)
  const board = communityBoardPresentation(state, legacy, view, search, t, commands.contentUrl)
  const moderatedSquare = state.config?.capabilities.community_approval_v1 === true
    && state.config.publication_policy === 'approval_required'
  const draft = state.publications.find(item => item.scopeKey === (publicationKey ?? state.activePublicationScope))
  const publication = draft === undefined ? null : communityPublishPresentation(draft, state, legacy, t, commands.contentUrl)
  const listing = state.selectedListing?.id === listingId ? state.selectedListing : null
  const detail = listing === null ? null : communityDetailsPresentation(listing, state, t, commands.contentUrl)
  const chat = state.conversation?.order.id === chatId ? communityChatPresentation(state, t, commands.contentUrl) : null
  const lastSeq = chatId === null ? 0 : state.conversation?.messages.at(-1)?.seq ?? 0
  useEffect(() => {
    props.onChatChange(chatId !== null)
    return () => { props.onChatChange(false) }
  }, [chatId, props.onChatChange])
  useEffect(() => {
    if (state.selectedOrderId !== null && previousOrder.current !== state.selectedOrderId) {
      setChatId(state.selectedOrderId); setListingId(null); setPublicationOpen(false)
    }
    previousOrder.current = state.selectedOrderId
  }, [state.selectedOrderId])
  useEffect(() => {
    if (chatId !== null && lastSeq > 0) commands.markRead(chatId, lastSeq)
  }, [chatId, lastSeq, commands.markRead])
  const changeView = (next: CommunityBoardView) => {
    setView(next); setSearch('')
    if (next === 'public') commands.setListingFilter('')
    else commands.loadOrders(next === 'mine' ? 'published' : 'accepted')
  }
  const refresh = () => { commands.refresh(); if (view === 'mine') props.refreshLegacy() }
  const retryUpload = (id: string) => {
    const upload = state.uploads.find(item => item.operationId === id)
    if (upload?.status === 'reselect') { setReselectId(id); reselect.current?.click() }
    else commands.retryUpload(id)
  }
  const open = (key: string) => {
    const target = communityBoardTarget(key)
    if (target === null) return
    if (target.kind === 'legacy-order') props.onLegacyOrder(target.id)
    else if (target.kind === 'legacy-draft') props.onLegacyDraft(target.id)
    else if (target.kind === 'community-order') { setChatId(target.id); commands.openOrder(target.id) }
    else if (target.kind === 'community-listing') { setListingId(target.id); commands.openListing(target.id) }
    else if (target.kind === 'community-acceptance') {
      if (state.pending.some(item => item.kind === 'accept' && item.operationId === target.id && !item.inflight)) {
        commands.retryOperation(target.id)
      }
    }
    else { setPublicationKey(target.id); setPublicationOpen(true); commands.openPublication(target.id) }
  }
  const loadingDetail = listingId !== null && (detail === null || state.selectedListingStatus !== 'ready')
  return <div className={css.workspace} data-community-chat={chatId !== null}>
    <input ref={reselect} type="file" hidden aria-label={t('selectAttachmentFiles')}
      onChange={(event) => {
        const file = event.currentTarget.files?.[0]
        if (file !== undefined && reselectId !== null) commands.retryUpload(reselectId, file)
        setReselectId(null); event.currentTarget.value = ''
      }} />
    {chatId === null ? <CommunityDemandBoard {...board} view={view} search={search} t={t}
      canCreate={state.availability === 'ready' && state.config?.enabled === true && moderatedSquare}
      onViewChange={changeView} onSearch={(value) => { setSearch(value); if (view === 'public') commands.setListingFilter(value) }}
      onCreate={() => { setPublicationKey(null); setPublicationOpen(true); commands.startPublication() }}
      onOpen={open} onRetry={refresh} onLoadMore={() => {
        if (view === 'public') commands.loadMoreListings()
        else { commands.loadOrders(view === 'mine' ? 'published' : 'accepted', true); if (view === 'mine') props.loadMoreLegacy() }
      }} /> : chat === null ? <div className={css.orderLoading}>
      <Button size="sm" onClick={() => { setChatId(null) }}>{t('communityBackToBoard')}</Button>
      {state.selectedOrderStatus === 'error' ? <DemandEmpty title={t('errorTitle')}
        detail={communityIssueText(state.selectedOrderError, t) ?? t('messagesFailed')}
        actionLabel={t('retry')} onAction={() => { commands.openOrder(chatId) }} />
        : <span role="status" aria-label={t('loading')}><StateDot state="ongoing" size={24} /></span>}
    </div>
      : <CommunityDemandChat {...chat} t={t} onBack={() => { setChatId(null) }}
        onChange={(text) => { commands.updateMessageDraft(chatId, text) }} onSend={() => { commands.sendMessage(chatId) }}
        onAddAttachments={(files) => { commands.addAttachments({ kind: 'order', orderId: chatId }, 'conversation', files) }}
        onRemoveAttachment={commands.removeUpload} onRetryAttachment={retryUpload}
        onDownloadAttachment={commands.downloadAttachment} onRetryMessage={(key) => {
          const operationId = chat.messageOperations[key]
          if (operationId !== undefined) commands.retryOperation(operationId)
        }} onCheckMessage={(key) => {
          const operationId = chat.messageOperations[key]
          if (operationId !== undefined) commands.retryOperation(operationId)
        }} onLoadMoreMessages={() => { commands.loadMoreMessages(chatId) }}
        onRefresh={() => { commands.openOrder(chatId) }} />}
    {!loadingDetail ? null : <Modal open onClose={() => { setListingId(null) }} title={t('communityPublicDetails')}
      closeLabel={t('close')}>
      <DemandEmpty title={t(state.selectedListingStatus === 'error' ? 'errorTitle' : 'loading')}
        detail={communityIssueText(state.selectedListingError, t) ?? t('loading')}
        actionLabel={state.selectedListingStatus === 'error' ? t('retry') : undefined}
        onAction={state.selectedListingStatus === 'error' ? () => { commands.openListing(listingId) } : undefined} />
    </Modal>}
    {listingId === null || detail === null || loadingDetail ? null : <CommunityDemandDetails {...detail} open t={t}
      onClose={() => { setListingId(null) }} onClaim={() => { commands.acceptListing(listingId) }}
      onCheck={() => { if (detail.operationId !== null) commands.retryOperation(detail.operationId) }}
      onOpenConversation={() => { setChatId(listingId); commands.openOrder(listingId); setListingId(null) }}
      onDownloadAttachment={commands.downloadAttachment} />}
    {!publicationOpen || publication === null || draft === undefined ? null : <CommunityDemandPublish {...publication} open t={t}
      attachmentAccept={publication.rules.accept} onClose={() => { setPublicationOpen(false) }}
      onChange={(patch) => { commands.updatePublication(draft.scopeKey, {
        ...patch.title === undefined ? {} : { title: patch.title }, ...patch.brief === undefined ? {} : { publicSummary: patch.brief },
        ...patch.publicBudget === undefined ? {} : { publicBudget: patch.publicBudget },
        ...patch.expectedDeliveryDate === undefined ? {} : { expectedDeliveryDate: patch.expectedDeliveryDate },
        ...patch.serviceId === undefined ? {} : { serviceProfileId: patch.serviceId },
        ...patch.allowPublic === undefined ? {} : { publishToCommunity: patch.allowPublic },
      }) }} onAddAttachments={(files) => { commands.addAttachments({ kind: 'publication', scopeKey: draft.scopeKey }, 'listing', files) }}
      onRemoveAttachment={commands.removeUpload} onRetryAttachment={retryUpload}
      onSubmit={() => { commands.publish(draft.scopeKey) }}
      onCheck={() => { if (publication.operationId !== null) commands.retryOperation(publication.operationId) }}
      onOfficialCustomization={() => { setPublicationOpen(false); props.onOfficial() }} />}
  </div>
}
