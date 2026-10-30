/**
 * The Balance page: phone sign-in, the credit balance and account usage analysis.
 *
 * Top-ups live on their own page (`RechargePage`). This page shows the account's
 * remaining credits and reported consumption, with one top-up action. Calls go through
 * `@deepseek-ai/dsh-credits-index`; the session and the balance come from the
 * shared store, so the two pages cannot disagree about either.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconChecklistOutlineRegular, IconChevronRightOutlineRegular, IconPlusOutlineRegular,
  IconRefreshOutlineRegular, IconShieldOutlineRegular, IconUserOutlineRegular, Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { grouped, newPhoneKey, post } from './api.ts'
import { phoneFailureKey } from './phone-sign-in.ts'
import { CreditsPanelIcon } from './CreditsPanelIcon.tsx'
import { UsageOverview } from './UsageOverview.tsx'
import { cx } from './class-names.ts'
import { refreshBalance, refreshCredits, signOutCredits, useCreditsSnapshot } from './session-store.ts'
import { creditsReadFailure, creditsRetrySeconds } from './read-failure.ts'
import css from './CreditsPage.module.css'

/** What the plugin injects into the balance page. */
export interface CreditsPageInjected {
  /** Translate one key of this plugin's namespace. */
  readonly t: (key: string, values?: Record<string, string>) => string
  /** Open the top-up page in the main column. */
  readonly openRecharge: () => void
  /** Return to the current Conversation after this form completes phone sign-in. */
  readonly completeSignIn: () => void
  /** Total deadline for logout and local-state confirmation. */
  readonly signOutTimeoutMs: number
}

interface ChallengeResponse {
  readonly challenge_id: string
  readonly expires_at: string | null
  readonly delivery_status?: 'accepted' | 'unknown' | 'sending' | 'not_sent'
  readonly resend_after_seconds: number
}

interface SessionResponse {
  readonly verification?: { readonly methods: readonly string[] }
  readonly registration_bonus?: { readonly status: string; readonly points: number }
}

export function CreditsPage(props: PropsRuntime<'main'> & CreditsPageInjected): ReactNode {
  const { t, openRecharge, completeSignIn, signOutTimeoutMs } = props
  const { session, balance, loaded, accountEpoch, failure: readFailure, readFailure: readDetail, refreshing } = useCreditsSnapshot()
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const currentReadFailure = useMemo(() => readDetail ?? (readFailure === null ? null
    : creditsReadFailure({ code: readFailure }, 'ACCOUNT_UNAVAILABLE')), [readDetail, readFailure])
  const [readRetrySeconds, setReadRetrySeconds] = useState(0)

  // Login flow
  const [phone, setPhone] = useState('+86')
  const [code, setCode] = useState('')
  const [challenge, setChallenge] = useState<ChallengeResponse | null>(null)
  const [resendIn, setResendIn] = useState(0)
  const [resendUntil, setResendUntil] = useState(0)
  const [verifyIn, setVerifyIn] = useState(0)
  const [verifyUntil, setVerifyUntil] = useState(0)
  const loginActive = useRef(false)
  const recovered = useRef(false)
  const restoredVerifyKey = useRef(false)
  const [deliveryStatus, setDeliveryStatus] = useState<ChallengeResponse['delivery_status']>(undefined)
  const [verificationRequired, setVerificationRequired] = useState(false)
  const [securityMethods, setSecurityMethods] = useState<readonly string[]>([])
  const [securityCode, setSecurityCode] = useState('')
  const [securityUnconfirmed, setSecurityUnconfirmed] = useState(false)
  const [loginAction, setLoginAction] = useState<'send' | 'verify' | 'security' | null>(null)
  const challengeKey = useRef<string | null>(null)
  const verifyKey = useRef<string | null>(null)

  const creditsPerYuan = session?.creditsPerYuan ?? 1000
  const signedIn = session?.signedIn === true
  const canSignOut = signedIn || loaded && session === null && currentReadFailure !== null
  const accountPhone = session?.account?.phone.replace(/^(\+86)(1\d{2})(\d{4})(\d{4})$/, '$1 $2 $3 $4') ?? '—'
  const recoveryAvailable = session?.phoneRecoveryAvailable !== false
  const validPhone = /^\+861[3-9]\d{9}$/.test(phone)

  useEffect(() => {
    const tick = (): void => { setReadRetrySeconds(creditsRetrySeconds(currentReadFailure)) }
    tick()
    if (creditsRetrySeconds(currentReadFailure) === 0) return undefined
    const timer = setInterval(() => {
      tick()
      if (creditsRetrySeconds(currentReadFailure) === 0) clearInterval(timer)
    }, 1000)
    return () => { clearInterval(timer) }
  }, [currentReadFailure])

  useEffect(() => {
    if (!loaded || signedIn || recovered.current) return
    if (!recoveryAvailable) { setFailure(t('loginRecoveryUnavailable')); return }
    recovered.current = true
    const recovery = session?.phoneRecovery
    if (recovery == null) return
    setPhone(recovery.phone)
    challengeKey.current = recovery.challengeKey
    verifyKey.current = recovery.exchangeKey
    restoredVerifyKey.current = recovery.exchangeKey !== null
    setDeliveryStatus(recovery.deliveryStatus)
    setResendUntil(recovery.resendAt)
    setVerifyUntil(recovery.verifyRetryAt)
    if (recovery.challengeId !== null) setChallenge({ challenge_id: recovery.challengeId, expires_at: recovery.expiresAt,
      resend_after_seconds: Math.max(0, Math.ceil((recovery.resendAt - Date.now()) / 1000)), delivery_status: recovery.deliveryStatus })
    if (recovery.deliveryStatus === 'accepted') setNotice(t('codeSent'))
    else setFailure(t(recovery.deliveryStatus === 'not_sent' ? 'loginNotSent' : 'loginDeliveryUnknown'))
    if (recovery.exchangeKey !== null && recovery.expiresAt !== null && Date.parse(recovery.expiresAt) <= Date.now()) {
      setNotice(null); setFailure(t('loginExpiredExchangeRecovery'))
    }
    if (recovery.securityUnconfirmed) {
      setVerificationRequired(true); setSecurityUnconfirmed(true); setFailure(t('loginSecurityUnconfirmed'))
    }
  }, [loaded, recoveryAvailable, session, signedIn, t])

  useEffect(() => {
    const tick = (): void => {
      setResendIn(Math.max(0, Math.ceil((resendUntil - Date.now()) / 1000)))
      setVerifyIn(Math.max(0, Math.ceil((verifyUntil - Date.now()) / 1000)))
    }
    tick()
    if (Math.max(resendUntil, verifyUntil) <= Date.now()) return undefined
    const timer = setInterval(() => {
      tick()
      if (Math.max(resendUntil, verifyUntil) <= Date.now()) clearInterval(timer)
    }, 250)
    return () => { clearInterval(timer) }
  }, [resendUntil, verifyUntil])

  /** Ask for a code; the key is minted once and reused when the operator retries. */
  const sendCode = useCallback(async () => {
    if (!recoveryAvailable || loginActive.current || Date.now() < resendUntil) return
    setFailure(null)
    setNotice(null)
    if (!/^\+861[3-9]\d{9}$/.test(phone)) {
      setFailure(t('errPhone'))
      return
    }
    challengeKey.current ??= newPhoneKey('sms-challenge')
    loginActive.current = true
    setBusy(true)
    setLoginAction('send')
    try {
      const answer = await post<ChallengeResponse>('/credits/api/session/challenge', {
        phone,
        idempotencyKey: challengeKey.current,
      })
      if (answer.payload !== undefined && answer.payload.delivery_status !== 'not_sent') {
        if (challenge?.challenge_id !== answer.payload.challenge_id) {
          setCode(''); verifyKey.current = null; restoredVerifyKey.current = false
        }
        setChallenge(answer.payload)
        setVerificationRequired(false); setSecurityCode(''); setSecurityUnconfirmed(false)
        setDeliveryStatus(answer.payload.delivery_status ?? 'accepted')
      }
      if (answer.ok && answer.payload !== undefined) {
        const seconds = answer.payload.resend_after_seconds
        setResendUntil(Date.now() + (Number.isFinite(seconds) && seconds >= 0 ? seconds : 60) * 1000)
        challengeKey.current = null
        verifyKey.current = null
        setNotice(t('codeSent'))
      } else {
        if (answer.retryAfterSeconds != null && Number.isFinite(answer.retryAfterSeconds)) {
          setResendUntil(Date.now() + Math.max(0, answer.retryAfterSeconds) * 1000)
        } else if (answer.code === '429' || answer.code === 'PHONE_RATE_LIMITED') {
          setResendUntil(Date.now() + 60_000)
        }
        if (answer.payload?.delivery_status === 'not_sent') {
          challengeKey.current = null
          setDeliveryStatus('not_sent')
        } else if (answer.code === 'PHONE_CHALLENGE_UNAVAILABLE' || answer.code === 'PHONE_DELIVERY_UNKNOWN'
          || answer.code === 'PHONE_CHALLENGE_PENDING') {
          setDeliveryStatus(answer.code === 'PHONE_CHALLENGE_PENDING' ? 'sending' : 'unknown')
        }
        setFailure(t(phoneFailureKey(answer.code, 'send', answer.payload?.delivery_status)))
      }
    } catch {
      setDeliveryStatus('unknown')
      setFailure(t('loginSendFailed'))
    } finally {
      loginActive.current = false
      setBusy(false)
      setLoginAction(null)
    }
  }, [challenge?.challenge_id, phone, recoveryAvailable, resendUntil, t])

  /** Verify the code; a mismatched code keeps the challenge and the key. */
  const verifyCode = useCallback(async () => {
    if (!recoveryAvailable || loginActive.current || Date.now() < verifyUntil) return
    if (challenge === null) {
      setFailure(t('errNeedCode'))
      return
    }
    if (!/^\d{6}$/.test(code)) {
      setFailure(t('errCodeFormat'))
      return
    }
    verifyKey.current ??= newPhoneKey('sms-session')
    restoredVerifyKey.current = false
    loginActive.current = true
    setBusy(true)
    setLoginAction('verify')
    setFailure(null)
    try {
      const answer = await post<SessionResponse>('/credits/api/session/verify', {
        challengeId: challenge.challenge_id,
        code,
        idempotencyKey: verifyKey.current,
      })
      if (answer.ok && answer.payload !== undefined) {
        const bonus = answer.payload.registration_bonus
        setNotice(bonus?.status === 'credited'
          ? t('signedInBonus', { points: grouped(bonus.points) })
          : t('signedIn'))
        setCode('')
        setChallenge(null)
        setResendUntil(0)
        setVerifyUntil(0)
        challengeKey.current = null
        verifyKey.current = null
        await refreshCredits(undefined, true)
        completeSignIn()
      } else {
        setFailure(t(phoneFailureKey(answer.code, 'verify')))
        setVerificationRequired(answer.code === 'PHONE_LOGIN_VERIFICATION_REQUIRED')
        setSecurityMethods(answer.payload?.verification?.methods ?? [])
        setSecurityCode(''); setSecurityUnconfirmed(answer.code === 'PHONE_SECURITY_UNCONFIRMED')
        if (answer.code === 'PHONE_SECURITY_UNCONFIRMED') setVerificationRequired(true)
        if (answer.retryAfterSeconds != null && Number.isFinite(answer.retryAfterSeconds)) {
          setVerifyUntil(Date.now() + Math.max(0, answer.retryAfterSeconds) * 1000)
        } else if (answer.code === '429' || answer.code === 'PHONE_RATE_LIMITED') {
          setVerifyUntil(Date.now() + 60_000)
        }
        if (answer.code === 'SMS_CHALLENGE_EXPIRED' || answer.code === 'SMS_CHALLENGE_CONSUMED' || answer.code === 'PHONE_CHALLENGE_CONSUMED' || answer.code === '410') {
          setChallenge(null)
          challengeKey.current = null
        }
      }
    } catch {
      setFailure(t('loginVerifyFailed'))
    } finally {
      loginActive.current = false
      setBusy(false)
      setLoginAction(null)
    }
  }, [challenge, code, completeSignIn, recoveryAvailable, t, verifyUntil])

  /** Submit the declared security check once; an unknown outcome requires fresh phone authentication. */
  const verifySecurity = useCallback(async () => {
    if (loginActive.current || securityUnconfirmed || !securityMethods.includes('2fa') || securityCode.trim() === ''
      || verifyKey.current === null || Date.now() < verifyUntil) return
    loginActive.current = true
    setBusy(true); setLoginAction('security'); setFailure(null)
    try {
      const answer = await post<SessionResponse>('/credits/api/session/verify-security', {
        exchangeKey: verifyKey.current, code: securityCode.trim(),
      })
      if (answer.ok) {
        setCode(''); setSecurityCode(''); setChallenge(null); setVerificationRequired(false)
        challengeKey.current = null; verifyKey.current = null
        setResendUntil(0); setVerifyUntil(0)
        setNotice(t('signedIn'))
        await refreshCredits(undefined, true)
        completeSignIn()
      } else {
        setFailure(t(phoneFailureKey(answer.code, 'verify')))
        if (answer.code === 'PHONE_SECURITY_UNCONFIRMED' || answer.code === 'PHONE_SECURITY_EXPIRED') setSecurityUnconfirmed(true)
        if (answer.retryAfterSeconds != null && Number.isFinite(answer.retryAfterSeconds)) {
          setVerifyUntil(Date.now() + Math.max(0, answer.retryAfterSeconds) * 1000)
        }
      }
    } catch {
      setSecurityUnconfirmed(true); setFailure(t('loginSecurityUnconfirmed'))
    } finally {
      loginActive.current = false; setBusy(false); setLoginAction(null)
    }
  }, [completeSignIn, securityCode, securityMethods, securityUnconfirmed, t, verifyUntil])

  /** Sign out: revoke on the platform, clear locally, return to the form. */
  const signOut = useCallback(async () => {
    setBusy(true)
    setFailure(null)
    setNotice(null)
    try {
      const outcome = await signOutCredits(signOutTimeoutMs)
      setNotice(t(outcome === 'local-only' ? 'signedOutLocal' : 'signedOut'))
    } catch (_unconfirmedLogout: unknown) {
      setFailure(t('signOutFailed'))
    } finally {
      setBusy(false)
    }
  }, [signOutTimeoutMs, t])

  return (
    <div className={cx(css.page, css.balancePage)}>
      <header className={css.header}>
        <h1 className={css.title}>{t('title')}</h1>
        {canSignOut && (
          <Button
            className={css.headerAction}
            size="sm"
            variant="ghost"
            onClick={() => { void signOut() }}
            disabled={busy}
          >
            {t('signOut')}
          </Button>
        )}
      </header>
      <p className={css.hint}>{t('activityNotice')}</p>

      {canSignOut && failure !== null && <p className={css.banner} data-tone="error" role="alert">{failure}</p>}
      {currentReadFailure !== null && <div className={css.banner} data-tone="error" role="alert">
        <span>{t(`read.error.${currentReadFailure.kind}`)}</span>
        {readRetrySeconds > 0 && <span> {t('read.retryAfter', { seconds: String(readRetrySeconds) })}</span>}
        {signedIn && currentReadFailure.kind === 'auth' && <Button size="sm" variant="ghost" disabled={busy}
          onClick={() => { void signOut() }}>{t('goSignIn')}</Button>}
        {loaded && session === null && <Button size="sm" variant="ghost" disabled={busy || refreshing || readRetrySeconds > 0}
          onClick={() => { void refreshCredits() }}>{t('refresh')}</Button>}
      </div>}
      {signedIn && notice !== null && <p className={css.banner} data-tone="success" role="status">{notice}</p>}
      {!loaded && <p className={css.hint}>{t('loading')}</p>}

      {loaded && session?.signedIn === false && (
        <section className={css.signInCard} aria-label={t('loginTitle')}>
          <div className={css.signInLayout}>
            <div className={css.signInIntro}>
              <span className={css.signInIcon}><CreditsPanelIcon size={24} /></span>
              <h2 className={css.signInTitle}>{t('loginIntroTitle')}</h2>
              <p className={css.signInDescription}>{t('loginIntroHint')}</p>
              <div className={css.signInFeatures}>
                <div className={css.signInFeature}>
                  <span className={css.signInFeatureIcon}><CreditsPanelIcon size={18} /></span>
                  <div><p>{t('loginBalanceTitle')}</p><span>{t('loginBalanceHint')}</span></div>
                </div>
                <div className={css.signInFeature}>
                  <span className={css.signInFeatureIcon}><IconChecklistOutlineRegular size={18} /></span>
                  <div><p>{t('loginUsageTitle')}</p><span>{t('loginUsageHint')}</span></div>
                </div>
              </div>
            </div>
            <form className={css.signInForm} onSubmit={(event) => {
              event.preventDefault()
              if (!busy) void (verificationRequired ? verifySecurity() : verifyCode())
            }}>
              <div className={css.signInFormHeading}>
                <h3>{t('loginTitle')}</h3>
                <p>{t('loginSubtitle')}</p>
              </div>
              <label className={css.signInField}>
                <span className={css.signInFieldLabel}>{t('phone')}</span>
                <span className={css.phoneControl}>
                  <span className={css.phonePrefix} aria-hidden="true">+86</span>
                  <Input className={cx(css.phoneInput)} aria-label={t('phone')}
                    value={phone.slice(3)} type="tel" inputMode="tel" autoComplete="tel-national"
                    maxLength={18} disabled={busy} placeholder={t('loginPhonePlaceholder')}
                    onChange={(event) => {
                      const input = event.target.value.trim()
                      setChallenge(null); setCode(''); setFailure(null); setNotice(null)
                      challengeKey.current = null; verifyKey.current = null; restoredVerifyKey.current = false
                      setDeliveryStatus(undefined); setVerificationRequired(false)
                      if (input.startsWith('+') && !input.startsWith('+86')) {
                        setPhone('+86'); setFailure(t('errPhone')); return
                      }
                      const digits = (input.startsWith('+86') ? input.slice(3) : input).replace(/\D/g, '')
                      const national = digits.length === 13 && digits.startsWith('86') ? digits.slice(2) : digits
                      setPhone(`+86${national.slice(0, 11)}`)
                    }} />
                </span>
              </label>
              <div className={css.signInField}>
                <span className={css.signInFieldLabel}>{t('code')}</span>
                <div className={css.signInCodeRow}>
                  <Input className={cx(css.signInInput)} aria-label={t('code')}
                    value={code} inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                    disabled={busy} placeholder={t('codePlaceholder')}
                    onChange={(event) => {
                      setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                      if (!restoredVerifyKey.current) verifyKey.current = null
                      if (verificationRequired) { setVerificationRequired(false); setSecurityCode(''); setSecurityUnconfirmed(false) }
                    }} />
                  <Button className={css.signInSend} variant="outline"
                    onClick={() => { void sendCode() }} disabled={!recoveryAvailable || busy || resendIn > 0 || !validPhone}>
                    {loginAction === 'send' ? t('loginSending') : resendIn > 0
                      ? t('resendIn', { seconds: String(resendIn) })
                      : deliveryStatus === 'unknown' || deliveryStatus === 'sending' ? t('loginCheckDelivery') : t('sendCode')}
                  </Button>
                </div>
              </div>
              {verificationRequired && securityMethods.includes('2fa') && <label className={css.signInField}>
                <span className={css.signInFieldLabel}>{t('loginSecurityCode')}</span>
                <Input aria-label={t('loginSecurityCode')} value={securityCode} autoComplete="one-time-code"
                  maxLength={128} disabled={busy || securityUnconfirmed} placeholder={t('loginSecurityPlaceholder')}
                  onChange={(event) => { setSecurityCode(event.target.value) }} />
              </label>}
              <div className={css.signInFeedback} aria-live="polite">
                {failure !== null ? <p role="alert" className={css.signInFailure}>{failure}</p>
                  : <p role={notice === null ? undefined : 'status'}>{notice ?? t('loginCodeHint')}</p>}
              </div>
              <Button
                className={css.signInSubmit} type="submit" variant="primary"
                icon={loginAction === 'verify' || loginAction === 'security' ? <IconRefreshOutlineRegular className={css.signInSpinner} /> : undefined}
                disabled={!recoveryAvailable || busy || verifyIn > 0 || (verificationRequired
                  ? securityUnconfirmed || !securityMethods.includes('2fa') || securityCode.trim() === '' : code.length !== 6)}
              >
                {loginAction === 'security' ? t('loginSecurityVerifying') : loginAction === 'verify' ? t('loginVerifying') : verifyIn > 0
                  ? t('loginRetryIn', { seconds: String(verifyIn) }) : verificationRequired ? t('loginSecuritySubmit') : t('signIn')}
              </Button>
              {!recoveryAvailable && <Button variant="outline" onClick={() => { void refreshCredits() }}>{t('refresh')}</Button>}
              {verificationRequired && !securityMethods.includes('2fa') && <p role="status">{t('loginSecurityUnsupported')}</p>}
              {securityUnconfirmed && <Button variant="outline" onClick={() => {
                setVerificationRequired(false); setSecurityCode(''); setSecurityUnconfirmed(false)
                setCode(''); setChallenge(null); verifyKey.current = null; challengeKey.current = null
              }}>{t('loginSecurityRestart')}</Button>}
              <p className={css.signInNote}><IconShieldOutlineRegular /><span>{t('loginHint')}</span></p>
            </form>
          </div>
        </section>
      )}

      {signedIn && (
        <>
          <section className={css.walletCard} aria-label={t('balance')}>
            <div className={css.walletHeader}>
              <div className={css.walletHeading}>
                <span className={css.walletIcon}><CreditsPanelIcon size={20} /></span>
                <span className={css.balanceLabel}>{t('balance')}</span>
              </div>
              <Button
                className={css.walletRefresh}
                size="sm"
                variant="ghost"
                icon={<IconRefreshOutlineRegular />}
                onClick={() => { void (currentReadFailure?.kind === 'accountChanged' || currentReadFailure?.kind === 'sessionRefresh' ? refreshCredits() : refreshBalance()) }}
                disabled={busy || refreshing || readRetrySeconds > 0}
              >
                {t('refresh')}
              </Button>
            </div>
            <div className={css.walletBody}>
              <div className={css.balanceValue}>
                <p className={css.balanceNumber}>
                  <span className={css.amount}>{balance === null ? '—' : grouped(balance.balance_points)}</span>
                  <span className={css.amountUnit}>{t('points')}</span>
                </p>
                {currentReadFailure !== null && balance !== null && <p className={css.hint}>{t('balanceStale')}</p>}
              </div>
              <div className={css.walletActions}>
                <div className={css.walletAccount}>
                  <span className={css.walletAccountIcon} aria-hidden="true"><IconUserOutlineRegular /></span>
                  <div className={css.walletAccountText}>
                    <span className={css.metaLabel}>{t('account')}</span>
                    <span className={css.walletAccountValue}>{accountPhone}</span>
                  </div>
                </div>
                <Button
                  className={css.walletRecharge}
                  variant="primary"
                  icon={<IconPlusOutlineRegular />}
                  onClick={openRecharge}
                >
                  {t('goRecharge')}
                  <span className={css.walletRechargeArrow} aria-hidden="true"><IconChevronRightOutlineRegular /></span>
                </Button>
              </div>
            </div>
          </section>
          <UsageOverview key={`${session.account?.id ?? session.account?.phone ?? 'current'}:${String(accountEpoch)}`}
            t={t} creditsPerYuan={creditsPerYuan} {...session.account === undefined ? {} : { accountId: session.account.id }}
            {...session.accountOwner === undefined ? {} : { accountOwner: session.accountOwner }} />
        </>
      )}
    </div>
  )
}
