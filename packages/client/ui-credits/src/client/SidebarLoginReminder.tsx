/** A sidebar click may request sign-in without launching or resuming its feature. */
import { useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { creditsRetrySeconds } from './read-failure.ts'
import type { SidebarLoginInjected } from './sidebar-login-store.ts'

type ReminderProps = PropsRuntime<'shell.overlay'> & PropsLocale<'credits'> & InjectFace<SidebarLoginInjected>

/** @param props - Root view, localized copy, and existing account navigation. @returns One manually opened, dismissible reminder. */
export function SidebarLoginReminder({ useSidebarLogin, dismissSidebarLogin, retrySidebarLogin, goToSidebarLogin, t }: ReminderProps) {
  const state = useSidebarLogin(value => value)
  const [cooldown, setCooldown] = useState(0)
  useEffect(() => () => { dismissSidebarLogin() }, [dismissSidebarLogin])
  useEffect(() => {
    if (!state.open) return undefined
    const update = (): void => { setCooldown(creditsRetrySeconds(state.failure)) }
    update()
    if (creditsRetrySeconds(state.failure) === 0) return undefined
    const timer = setInterval(update, 1000)
    return () => { clearInterval(timer) }
  }, [state.failure, state.open])
  if (!state.open) return null
  const signedOut = state.mode === 'signed-out'
  const title = signedOut ? 'sidebarLogin.title' : state.mode === 'checking' ? 'sidebarLogin.checking' : 'sidebarLogin.unconfirmed'
  const description = signedOut ? 'sidebarLogin.description'
    : state.mode === 'checking' ? 'sidebarLogin.checkingHint' : 'sidebarLogin.unconfirmedHint'
  return <Modal open title={t(title)} description={t(description)} closeLabel={t('sidebarLogin.close')}
    onClose={dismissSidebarLogin} footer={<>
      <Button variant="outline" onClick={dismissSidebarLogin}>{t(signedOut ? 'sidebarLogin.later' : 'close')}</Button>
      <Button variant={signedOut ? 'primary' : 'ghost'} onClick={goToSidebarLogin}>
        {t(signedOut ? 'sidebarLogin.signIn' : 'sidebarLogin.account')}
      </Button>
      {!signedOut && <Button variant="primary" disabled={state.refreshing || cooldown > 0} onClick={retrySidebarLogin}>
        {t(state.refreshing ? 'sidebarLogin.checking' : 'sidebarLogin.retry')}
      </Button>}
    </>}>
    {cooldown > 0 && <p role="status">{t('read.retryAfter', { seconds: String(cooldown) })}</p>}
  </Modal>
}
