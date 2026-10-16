/**
 * The Balance page: phone sign-in, the credit balance and account usage analysis.
 *
 * Top-ups live on their own page (`RechargePage`). This page shows the account's
 * remaining credits and reported consumption, with one top-up action. Calls go through
 * `@deepseek-ai/dsh-credits-index`; the session and the balance come from the
 * shared store, so the two pages cannot disagree about either.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconChecklistOutlineRegular, IconChevronRightOutlineRegular, IconPlusOutlineRegular,
  IconRefreshOutlineRegular, IconShieldOutlineRegular, IconUserOutlineRegular, Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { grouped, newKey, post } from './api.ts'
import { CreditsPanelIcon } from './CreditsPanelIcon.tsx'
import { UsageOverview } from './UsageOverview.tsx'
import { cx } from './class-names.ts'
import { refreshBalance, refreshCredits, signOutCredits, useCreditsSnapshot } from './session-store.ts'
import css from './CreditsPage.module.css'

/** What the plugin injects into the balance page. */
export interface CreditsPageInjected {
  /** Translate one key of this plugin's namespace. */
  readonly t: (key: string, values?: Record<string, string>) => string
  /** Open the top-up page in the main column. */
  readonly openRecharge: () => void
}

interface ChallengeResponse {
  readonly challenge_id: string
  readonly expires_at: string
  readonly resend_after_seconds: number
}

interface SessionResponse {
  readonly registration_bonus?: { readonly status: string; readonly points: number }
}

/** Seconds past which a resend is allowed again. */
function nextResend(seconds: number): number {
  return seconds > 0 ? seconds : 60
}

export function CreditsPage(props: PropsRuntime<'main'> & CreditsPageInjected): ReactNode {
  const { t, openRecharge } = props
  const { session, balance, loaded } = useCreditsSnapshot()
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Login flow
  const [phone, setPhone] = useState('+86')
  const [code, setCode] = useState('')
  const [challenge, setChallenge] = useState<ChallengeResponse | null>(null)
  const [resendIn, setResendIn] = useState(0)
  const [loginAction, setLoginAction] = useState<'send' | 'verify' | null>(null)
  const challengeKey = useRef<string | null>(null)
  const verifyKey = useRef<string | null>(null)

  const creditsPerYuan = session?.creditsPerYuan ?? 1000
  const signedIn = session?.signedIn === true
  const accountPhone = session?.account?.phone.replace(/^(\+86)(1\d{2})(\d{4})(\d{4})$/, '$1 $2 $3 $4') ?? '—'
  const validPhone = /^\+861[3-9]\d{9}$/.test(phone)

  useEffect(() => {
    if (resendIn <= 0) return undefined
    const timer = setTimeout(() => { setResendIn(seconds => Math.max(0, seconds - 1)) }, 1000)
    return () => { clearTimeout(timer) }
  }, [resendIn])

  /** Ask for a code; the key is minted once and reused when the operator retries. */
  const sendCode = useCallback(async () => {
    setFailure(null)
    setNotice(null)
    if (!/^\+861[3-9]\d{9}$/.test(phone)) {
      setFailure(t('errPhone'))
      return
    }
    challengeKey.current ??= newKey('sms-challenge')
    setBusy(true)
    setLoginAction('send')
    try {
      const answer = await post<ChallengeResponse>('/credits/api/session/challenge', {
        phone,
        idempotencyKey: challengeKey.current,
      })
      if (answer.ok && answer.payload !== undefined) {
        setChallenge(answer.payload)
        setResendIn(nextResend(answer.payload.resend_after_seconds))
        setNotice(t('codeSent'))
      } else {
        if (answer.code === '429' || answer.retryAfterSeconds != null) setResendIn(answer.retryAfterSeconds ?? 60)
        setFailure(answer.message ?? answer.code ?? t('errGeneric'))
        challengeKey.current = null
      }
    } catch {
      setFailure(t('loginSendFailed'))
      challengeKey.current = null
    } finally {
      setBusy(false)
      setLoginAction(null)
    }
  }, [phone, t])

  /** Verify the code; a mismatched code keeps the challenge and the key. */
  const verifyCode = useCallback(async () => {
    if (challenge === null) {
      setFailure(t('errNeedCode'))
      return
    }
    if (!/^\d{6}$/.test(code)) {
      setFailure(t('errCodeFormat'))
      return
    }
    verifyKey.current ??= newKey('sms-session')
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
        setResendIn(0)
        challengeKey.current = null
        verifyKey.current = null
        await refreshCredits()
      } else {
        setFailure(answer.message ?? answer.code ?? t('errGeneric'))
        if (answer.code === 'SMS_CHALLENGE_EXPIRED' || answer.code === 'SMS_CHALLENGE_CONSUMED' || answer.code === '410') {
          setChallenge(null)
          challengeKey.current = null
        }
        verifyKey.current = null
      }
    } catch {
      setFailure(t('loginVerifyFailed'))
      verifyKey.current = null
    } finally {
      setBusy(false)
      setLoginAction(null)
    }
  }, [challenge, code, t])

  /** Sign out: revoke on the platform, clear locally, return to the form. */
  const signOut = useCallback(async () => {
    setBusy(true)
    try {
      await signOutCredits()
    } finally {
      setBusy(false)
      setNotice(t('signedOut'))
    }
  }, [t])

  return (
    <div className={cx(css.page, css.balancePage)}>
      <header className={css.header}>
        <h1 className={css.title}>{t('title')}</h1>
        {signedIn && (
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

      {signedIn && failure !== null && <p className={css.banner} data-tone="error" role="alert">{failure}</p>}
      {signedIn && notice !== null && <p className={css.banner} data-tone="success" role="status">{notice}</p>}
      {!loaded && <p className={css.hint}>{t('loading')}</p>}

      {loaded && !signedIn && (
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
            <form className={css.signInForm} onSubmit={(event) => { event.preventDefault(); if (!busy) void verifyCode() }}>
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
                      challengeKey.current = null; verifyKey.current = null
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
                    onChange={(event) => { setCode(event.target.value.replace(/\D/g, '').slice(0, 6)); verifyKey.current = null }} />
                  <Button className={css.signInSend} variant="outline"
                    onClick={() => { void sendCode() }} disabled={busy || resendIn > 0 || !validPhone}>
                    {loginAction === 'send' ? t('loginSending') : resendIn > 0
                      ? t('resendIn', { seconds: String(resendIn) }) : t('sendCode')}
                  </Button>
                </div>
              </div>
              <div className={css.signInFeedback} aria-live="polite">
                {failure !== null ? <p role="alert" className={css.signInFailure}>{failure}</p>
                  : <p role={notice === null ? undefined : 'status'}>{notice ?? t('loginCodeHint')}</p>}
              </div>
              <Button
                className={css.signInSubmit} type="submit" variant="primary"
                icon={loginAction === 'verify' ? <IconRefreshOutlineRegular className={css.signInSpinner} /> : undefined}
                disabled={busy || code.length !== 6}
              >
                {loginAction === 'verify' ? t('loginVerifying') : t('signIn')}
              </Button>
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
                onClick={() => { void refreshBalance() }}
                disabled={busy}
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
          <UsageOverview key={session.account?.id ?? session.account?.phone ?? 'current'} t={t} creditsPerYuan={creditsPerYuan} />
        </>
      )}
    </div>
  )
}
