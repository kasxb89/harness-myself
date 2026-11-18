/** The human-engineer service joins the existing product without creating AI sessions. */
import { useEffect, useId, useState, type ReactNode } from 'react'
import { Button, SegmentedTabs, IconNewChatOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DemandPageProps } from './types.ts'
import { DemandEmpty } from './DemandUI.tsx'
import { EngineerDirectory } from './EngineerDirectory.tsx'
import { DemandInbox } from './DemandInbox.tsx'
import { DemandChat } from './DemandChat.tsx'
import css from './DemandPage.module.css'

/**
 * Browse real engineers and continue private requests through root-owned commands.
 * @param props - Framework-bound snapshot, root commands and localized copy.
 * @returns The directory or private request workspace.
 */
export function DemandPage(props: DemandPageProps): ReactNode {
  const { useDemands, t, refresh, openLogin, startRequest, openRequest } = props
  const state = useDemands(value => value)
  const [view, setView] = useState<'engineers' | 'requests'>('engineers')
  const [mobileChat, setMobileChat] = useState(false)
  const navigationId = useId()
  const scope = state.conversation?.scopeKey
  useEffect(() => {
    if (scope === undefined) return
    setView('requests')
    setMobileChat(true)
  }, [scope])
  const find = () => { setView('engineers'); setMobileChat(false) }
  const start = (id: string) => { startRequest(id); setView('requests'); setMobileChat(true) }
  const open = (id: string) => { openRequest(id); setView('requests'); setMobileChat(true) }
  const openDraft = (key: string) => { props.openDraft(key); setView('requests'); setMobileChat(true) }
  const availability = state.availability
  const hasRetainedData = state.engineers.length > 0 || state.requests.length > 0 || state.drafts.length > 0 || state.conversation !== null
  const unavailable = availability === 'unconfigured' || availability === 'disabled' || availability === 'login-required'
  const showUnavailable = availability === 'login-required' || (unavailable && !hasRetainedData)
  return <section className={css.page} aria-label={t('pageTitle')}>
    <div className={css.pageContent}>
      <header className={css.pageHeader}>
        <span className={css.pageIcon} aria-hidden="true"><IconNewChatOutlineRegular size={27} /></span>
        <div><h1>{t('pageTitle')}</h1><p>{t('pageIntro')}</p></div>
      </header>
      <SegmentedTabs className={css.navigation} label={t('navigation')} value={view} onChange={(next) => {
        setView(next)
        if (next === 'requests') setMobileChat(false)
      }} items={[
        { value: 'engineers', label: t('findEngineers'), id: `${navigationId}-engineers`, panelId: `${navigationId}-engineers-panel` },
        { value: 'requests', label: t('myRequests'), id: `${navigationId}-requests`, panelId: `${navigationId}-requests-panel` },
      ]} />
      {availability !== 'error' || !hasRetainedData ? null : <div className={css.pageNotice} role="alert">
        <span>{state.error ?? t('errorHint')}</span><Button size="sm" onClick={refresh}>{t('retry')}</Button>
      </div>}
      <div className={css.panel} role="tabpanel" id={`${navigationId}-${view}-panel`} aria-labelledby={`${navigationId}-${view}`}>
        {showUnavailable ? <DemandEmpty people title={t(availability === 'login-required' ? 'loginTitle'
          : availability === 'disabled' ? 'disabledTitle' : 'unconfiguredTitle')}
        detail={t(availability === 'login-required' ? 'loginHint' : availability === 'disabled' ? 'disabledHint' : 'unconfiguredHint')}
        actionLabel={availability === 'login-required' ? t('openLogin') : undefined}
        onAction={availability === 'login-required' ? openLogin : undefined} />
          : availability === 'error' && !hasRetainedData ? <DemandEmpty title={t('errorTitle')} detail={state.error ?? t('errorHint')}
            actionLabel={t('retry')} onAction={refresh} />
            : view === 'engineers' ? <EngineerDirectory state={state} start={start} t={t} />
              : <div className={css.workspace} data-chat-open={mobileChat && state.conversation !== null}>
                <DemandInbox state={state} open={open} openDraft={openDraft} create={find} refresh={refresh}
                  loadMore={props.loadMoreRequests} t={t} />
                <div className={css.conversationPane}>
                  {state.conversation === null ? <DemandEmpty title={t('selectRequest')} detail={t('selectRequestHint')}
                    actionLabel={t('findEngineers')} onAction={find} />
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
