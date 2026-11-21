/** The human-engineer service joins the existing product without creating AI sessions. */
import { useEffect, useId, useState, type ReactNode } from 'react'
import { Button, SegmentedTabs, IconChevronLeftOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DemandPageProps } from './types.ts'
import { DemandEmpty } from './DemandUI.tsx'
import { EngineerDirectory } from './EngineerDirectory.tsx'
import { ServiceDirectory } from './ServiceDirectory.tsx'
import { DemandInbox } from './DemandInbox.tsx'
import { DemandChat } from './DemandChat.tsx'
import { PersonalDemandCards } from './PersonalDemandCards.tsx'
import { CommunityWorkspace } from './CommunityWorkspace.tsx'
import { ForumWorkspace } from './ForumWorkspace.tsx'
import { CaseShowcase } from './CaseShowcase.tsx'
import css from './DemandPage.module.css'

/**
 * Browse published services or real engineers and continue private requests.
 * @param props - Framework-bound snapshot, root commands and localized copy.
 * @returns The directory or private request workspace.
 */
export function DemandPage(props: DemandPageProps): ReactNode {
  const { useDemands, t, refresh, openLogin, startRequest, openRequest } = props
  const state = useDemands(value => value)
  const community = props.useCommunity(value => value)
  const forum = props.useForum(value => value)
  const showcases = props.useShowcases(value => value)
  const [view, setView] = useState<'personal' | 'forum' | 'showcase' | 'official' | 'requests'>('personal')
  const [mobileChat, setMobileChat] = useState(false)
  const [communityChat, setCommunityChat] = useState(false)
  const navigationId = useId()
  const scope = state.conversation?.scopeKey
  const retainedCommunity = community.pending.length > 0 || community.publications.length > 0
    || community.conversation !== null || Object.values(community.orders).some(page => page.items.length > 0)
  const communityAvailable = community.availability !== 'login-required' && (community.config !== null
    && community.availability !== 'unavailable' || community.accountId !== null && retainedCommunity)
  useEffect(() => {
    props.setWorkspaceView(view === 'forum' ? 'forum' : view === 'requests' ? 'legacy'
      : view === 'personal' && communityAvailable ? 'community' : 'other')
    return () => { props.setWorkspaceView('other') }
  }, [props.setWorkspaceView, view, communityAvailable])
  useEffect(() => {
    if (scope === undefined) return
    setView('requests')
    setMobileChat(true)
  }, [scope])
  const find = () => { setView('official'); setMobileChat(false) }
  const start = (id: string) => { startRequest(id); setView('requests'); setMobileChat(true) }
  const startService = (id: string) => { props.startServiceRequest(id); setView('requests'); setMobileChat(true) }
  const open = (id: string) => { openRequest(id); setView('requests'); setMobileChat(true) }
  const openDraft = (key: string) => { props.openDraft(key); setView('requests'); setMobileChat(true) }
  const availability = state.availability
  const services = state.directoryMode === 'services'
  const findLabel = t(services ? 'findServices' : 'findEngineers')
  const tab = view === 'requests' ? 'personal' : view
  const compact = view === 'requests' || view === 'personal' && communityChat
  const hasRetainedData = state.engineers.length > 0 || state.serviceProfiles.length > 0
    || state.requests.length > 0 || state.drafts.length > 0 || state.conversation !== null
    || retainedCommunity
  const unavailable = availability === 'unconfigured' || availability === 'disabled' || availability === 'login-required'
  const showUnavailable = availability === 'login-required' || (unavailable && !hasRetainedData && !communityAvailable)
  return <section className={css.page} data-view={compact ? 'requests' : view} aria-label={t('pageTitle')}>
    <div className={css.pageContent}>
      {view === 'requests' ? <div className={css.workspaceNavigation}>
        <Button size="sm" icon={<IconChevronLeftOutlineRegular size={16} />}
          onClick={() => { setView('personal'); setMobileChat(false) }}>{t('backToPersonalRequests')}</Button>
      </div> : null}
      <SegmentedTabs className={compact ? css.conversationNavigation : css.navigation}
        label={t('navigation')} value={tab} onChange={(next) => {
          setView(next)
          setMobileChat(false)
        }} items={[
          { value: 'personal', label: t('demandSquare'), id: `${navigationId}-personal`, panelId: `${navigationId}-personal-panel` },
          { value: 'forum', label: t('forumTabLabel'), id: `${navigationId}-forum`, panelId: `${navigationId}-forum-panel` },
          { value: 'showcase', label: t('showcaseTab'), id: `${navigationId}-showcase`, panelId: `${navigationId}-showcase-panel` },
          { value: 'official', label: t('officialCustomization'), id: `${navigationId}-official`, panelId: `${navigationId}-official-panel` },
        ]} />
      {view === 'forum' || view === 'showcase' || availability !== 'error' || !hasRetainedData ? null : <div className={css.pageNotice} role="alert">
        <span>{state.error ?? t('errorHint')}</span><Button size="sm" onClick={refresh}>{t('retry')}</Button>
      </div>}
      <div className={css.panel} role="tabpanel" id={`${navigationId}-${tab}-panel`} aria-labelledby={`${navigationId}-${tab}`}>
        {availability === 'login-required' ? <DemandEmpty people title={t('loginTitle')} detail={t('loginHint')}
          actionLabel={t('openLogin')} onAction={openLogin} />
          : view === 'forum' ? <ForumWorkspace key={forum.accountId} state={forum} commands={props.forum} t={t} />
            : view === 'showcase' ? <CaseShowcase items={props.showcaseItems ?? []} state={showcases} commands={props.showcases} t={t} />
              : showUnavailable ? <DemandEmpty people title={t(availability === 'disabled' ? 'disabledTitle' : 'unconfiguredTitle')}
                detail={t(availability === 'disabled' ? 'disabledHint' : 'unconfiguredHint')} />
                : availability === 'error' && !hasRetainedData && !communityAvailable ? <DemandEmpty title={t('errorTitle')} detail={state.error ?? t('errorHint')}
                  actionLabel={t('retry')} onAction={refresh} />
                  : view === 'personal' ? communityAvailable
                    ? <CommunityWorkspace key={community.accountId} state={community} legacy={state} commands={props.community}
                      onLegacyOrder={open} onLegacyDraft={openDraft} onOfficial={find}
                      refreshLegacy={refresh} loadMoreLegacy={props.loadMoreRequests} onChatChange={setCommunityChat} t={t} />
                    : <PersonalDemandCards state={state} open={open} openDraft={openDraft} create={find}
                      conversations={() => { setView('requests'); setMobileChat(false) }} refresh={refresh} loadMore={props.loadMoreRequests} t={t} />
                    : view === 'official' ? services
                      ? <ServiceDirectory state={state} start={startService} filter={props.setServiceFilter}
                        loadMore={props.loadMoreServices} refresh={refresh} t={t} />
                      : <EngineerDirectory state={state} start={start} t={t} />
                      : <div className={css.workspace} data-chat-open={mobileChat && state.conversation !== null}>
                        <DemandInbox state={state} open={open} openDraft={openDraft} create={find} refresh={refresh}
                          loadMore={props.loadMoreRequests} t={t} />
                        <div className={css.conversationPane}>
                          {state.conversation === null ? <DemandEmpty title={t('selectRequest')} detail={t('selectRequestHint')}
                            actionLabel={findLabel} onAction={find} />
                            : <DemandChat key={state.conversation.scopeKey} conversation={state.conversation} draft={state.draft}
                              pendingPublish={state.drafts.some(row => row.scopeKey === state.conversation?.scopeKey && row.pending)}
                              rules={state.uploadRules} actions={{
                                refresh, updateDraft: props.updateDraft, send: props.send, addAttachments: props.addAttachments,
                                removeAttachment: props.removeAttachment, retryAttachment: props.retryAttachment,
                                retryMessage: props.retryMessage, loadEarlierMessages: props.loadEarlierMessages,
                                downloadAttachment: props.downloadAttachment, acceptDelivery: props.acceptDelivery,
                              }} back={() => { setMobileChat(false) }} create={find} t={t} />}
                        </div>
                      </div>}
      </div>
    </div>
  </section>
}
