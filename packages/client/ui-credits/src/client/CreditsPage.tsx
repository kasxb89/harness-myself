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
  Button, IconChevronRightOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconUserOutlineRegular, Input,
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
  readonly status: string
  readonly session_token: string
  readonly expires_at: string
  readonly registration_bonus: { readonly status: string; readonly points: number }
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
  const [phone, setPhone] = useState('+861')
  const [code, setCode] = useState('')
  const [challenge, setChallenge] = useState<ChallengeResponse | null>(null)
  const [resendIn, setResendIn] = useState(0)
  const challengeKey = useRef<string | null>(null)
  const verifyKey = useRef<string | null>(null)

  const creditsPerYuan = session?.creditsPerYuan ?? 1000
  const signedIn = session?.signedIn === true
  const accountPhone = session.account?.phone.replace(/^(\+86)(1\d{2})(\d{4})(\d{4})$/, '$1 $2 $3 $4') ?? '—'

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
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
      challengeKey.current = null
    } finally {
      setBusy(false)
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
    setFailure(null)
    try {
      const answer = await post<SessionResponse>('/credits/api/session/verify', {
        challengeId: challenge.challenge_id,
        code,
        idempotencyKey: verifyKey.current,
      })
      if (answer.ok && answer.payload !== undefined) {
        const bonus = answer.payload.registration_bonus
        setNotice(bonus.status === 'credited'
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
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
      verifyKey.current = null
    } finally {
      setBusy(false)
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

      {failure !== null && <p className={css.banner} data-tone="error" role="alert">{failure}</p>}
      {notice !== null && <p className={css.banner} data-tone="success" role="status">{notice}</p>}
      {!loaded && <p className={css.hint}>{t('loading')}</p>}

      {loaded && !signedIn && (
        <section className={css.card}>
          <div className={css.cardIntro}>
            <h2 className={css.cardTitle}>{t('loginTitle')}</h2>
            <p className={css.hint}>{t('loginHint')}</p>
          </div>
          <div className={css.form}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('phone')}</span>
              <Input
                className={cx(css.input)}
                value={phone}
                inputMode="tel"
                autoComplete="tel"
                placeholder="+8613800138000"
                onChange={(event) => { setPhone(event.target.value.trim()); challengeKey.current = null }}
              />
            </label>
            <div className={css.fieldRow}>
              <label className={cx(css.field, css.codeField)}>
                <span className={css.fieldLabel}>{t('code')}</span>
                <Input
                  className={cx(css.input)}
                  value={code}
                  inputMode="numeric"
                  maxLength={6}
                  placeholder={t('codePlaceholder')}
                  onChange={(event) => { setCode(event.target.value.replace(/\D/g, '').slice(0, 6)); verifyKey.current = null }}
                />
              </label>
              <Button
                variant="outline"
                onClick={() => { void sendCode() }}
                disabled={busy || resendIn > 0}
              >
                {resendIn > 0 ? t('resendIn', { seconds: String(resendIn) }) : t('sendCode')}
              </Button>
              <Button
                variant="primary"
                onClick={() => { void verifyCode() }}
                disabled={busy}
              >
                {t('signIn')}
              </Button>
            </div>
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
                <p className={css.balanceSub}>
                  {balance === null
                    ? t('loading')
                    : t('yuanInline', { amount: grouped(balance.balance_points / creditsPerYuan) })}
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
