/** Native product welcome; phone verification happens in the product account panel. */
import { useEffect, useRef, useState } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives/src/Toast.tsx'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx'
import type { WelcomeApi } from '../welcome-api.ts'
import type { WelcomeRecoveryState, WelcomeSessionIssue } from '../welcome-session.ts'

/**
 * Render the product entry using shell-owned navigation and localized copy.
 * @param props.api - isolated preload API; no account credentials reach the renderer.
 * @returns welcome content and the action that opens product phone sign-in.
 */
export function Welcome({ api }: { api: WelcomeApi }) {
  const { messages: m } = api
  const [expiryNotice, setExpiryNotice] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [session, setSession] = useState<WelcomeRecoveryState>({ kind: 'ready' })
  const busyRef = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    document.documentElement.lang = api.id
    document.title = m.welcomeTitle
    const takeNotice = (): void => {
      void api.takeNotice().then((notice) => {
        if (mounted.current && notice === 'session-expired') setExpiryNotice(true)
      }).catch((_closedChannel: unknown) => {
        // A closed Welcome IPC channel must not interrupt the sign-in page.
      })
    }
    takeNotice()
    const refreshSession = (): void => {
      void api.recoveryState().then((value) => {
        if (mounted.current) setSession(value)
      }).catch((_closedChannel: unknown) => {
        if (mounted.current) setSession({ kind: 'unavailable', reason: 'host_unavailable' })
      })
    }
    refreshSession()
    const stop = api.onAccountState(() => { takeNotice(); refreshSession() })
    return () => { mounted.current = false; stop() }
  }, [api, m.welcomeTitle])

  async function retrySession() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const value = await api.retrySession()
      if (mounted.current) setSession(value)
    } catch {
      if (mounted.current) setError(m.welcomeSessionProtocol)
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const issueMessages: Record<WelcomeSessionIssue, string> = {
    network: m.welcomeSessionNetwork, timeout: m.welcomeSessionTimeout, rate_limited: m.welcomeSessionRateLimited,
    upstream_unavailable: m.welcomeSessionUpstream, upstream_rejected: m.welcomeSessionRejected,
    protocol: m.welcomeSessionProtocol, identity_mismatch: m.welcomeSessionIdentity, storage: m.welcomeSessionStorage,
    renewal_unavailable: m.welcomeSessionRenewal, account_unavailable: m.welcomeSessionAccount, host_unavailable: m.welcomeSessionHost,
  }

  async function openPhoneSignIn() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    void api.analytics?.('auth_page_click', { button_name: 'sign_in' }).catch((_unavailableAnalytics: unknown) => {
      // Analytics is non-critical and must not interrupt phone sign-in.
    })
    try {
      await api.skip()
    } catch {
      if (mounted.current) setError(m.welcomeContinueFailed)
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return <>
    {expiryNotice && <Toast text={m.welcomeSessionExpired} onDone={() => { setExpiryNotice(false) }} />}
    <div className="titlebar" aria-hidden="true" />
    <main className="welcome" aria-labelledby="welcome-heading">
      <div className="brand" aria-label={m.welcomeBrand}>{m.welcomeBrand}</div>
      <div className="tagline">
        <h1 id="welcome-heading"><span>{m.welcomeTaglineBefore}</span><em>{m.welcomeTaglineBrand}</em><span>{m.welcomeTaglineAfter}</span></h1>
        <p id="welcome-description">{m.welcomeDescription}</p>
      </div>
      <div className={`actions${session.kind === 'unavailable' ? ' session-recovery' : ''}`} aria-busy={busy}>
        {session.kind === 'unavailable' && <>
          <p className="session-feedback" role="status">{m.welcomeSessionCheckUnavailable}<br />{issueMessages[session.reason]}</p>
          <button className="primary" type="button" disabled={busy} onClick={() => { void retrySession() }}>
            {busy && <StateDot state="ongoing" size={16} className="welcome-loading" />}
            {busy ? m.welcomeSessionRetrying : m.welcomeSessionRetry}
          </button>
        </>}
        <button id="sign-in" className={session.kind === 'unavailable' ? 'secondary' : 'primary'} type="button" disabled={busy} aria-describedby="login-feedback"
          onClick={() => { void openPhoneSignIn() }}>
          {busy && session.kind === 'ready' && <StateDot state="ongoing" size={16} className="welcome-loading" />}
          {session.kind === 'unavailable' ? m.welcomeSessionSignIn : m.welcomeSignIn}
        </button>
        <p id="login-feedback" className="login-feedback" role={error === '' ? undefined : 'alert'}>{error || m.welcomeLoginHint}</p>
      </div>
    </main>
  </>
}
