/**
 * The Credits page: phone sign-in, the platform balance, and WeChat Native
 * top-up (amount → QR → order polling).
 *
 * Every platform call goes through `@deepseek-ai/dsh-credits-index`; this page
 * owns the operator-facing state only. Idempotency keys are minted once per
 * operation and reused by that operation's retries, and the order poller keeps
 * the platform's `poll_after_ms` cadence — never a tight loop.
 *
 * The layout is one balance card and one top-up card: the credit count is the
 * page's subject, so it owns the largest type on the surface, while the account
 * and the rate stay in a quieter row under the same card.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  IconCopyOutlineRegular,
  IconRefreshOutlineRegular,
  Input,
  Pill,
  Tag,
  writeClipboard,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CreditsPanelIcon } from './CreditsPanelIcon.tsx'
import css from './CreditsPage.module.css'

/** What the plugin injects into the page. */
export interface CreditsInjected {
  /** Translate one key of this plugin's namespace. */
  readonly t: (key: string, values?: Record<string, string>) => string
}

/** The envelope every credits route answers with. */
interface Envelope<T> {
  readonly ok: boolean
  readonly code?: string | null
  readonly message?: string | null
  readonly retryAfterSeconds?: number | null
  readonly sessionInvalid?: boolean
  readonly payload?: T
  readonly status?: number
}

interface SessionInfo {
  readonly signedIn: boolean
  readonly creditsPerYuan: number
  readonly account?: { readonly id: string; readonly phone: string }
  readonly expiresAt?: string
  readonly statePath?: string
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

interface BalanceResponse {
  readonly balance_points: number
  readonly as_of: string
}

interface OrderCreated {
  readonly merchant_order_no: string
  readonly amount_cents: number
  readonly points: number
  readonly code_url: string
  readonly expires_at: string
  readonly poll_after_ms: number
  readonly qrCodeDataUrl?: string | null
}

interface OrderStatus {
  readonly merchant_order_no: string
  readonly status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'closed' | 'review_required'
  readonly points: number
  readonly balance_points: number | null
  readonly poll_after_ms: number | null
  readonly failure_code: string | null
}

/**
 * Top-up bounds the platform's `recharge/wechat` route enforces, in yuan. The
 * page states the same range in its own hint instead of asking the platform for
 * a second opinion, so the two can only disagree by editing this constant.
 */
const MIN_AMOUNT_YUAN = 1
const MAX_AMOUNT_YUAN = 100_000

/** Preset amounts offered beside the free-form field, in yuan. */
const QUICK_AMOUNTS_YUAN = [50, 100, 200, 500]

/** A fresh idempotency key; printable ASCII without spaces. */
function newKey(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${String(Date.now())}-${String(Math.random()).slice(2)}`
  return `${prefix}-${random}`.replace(/[^\x21-\x7e]/g, '')
}

/** Join class names, dropping the `undefined` an absent CSS-module key yields. */
function cx(...names: readonly (string | undefined)[]): string {
  return names.filter(name => name !== undefined).join(' ')
}

/** POST one credits route and unwrap its envelope. */
async function post<T>(path: string, body: Record<string, unknown>): Promise<Envelope<T>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  return await response.json() as Envelope<T>
}

/** GET one credits route and unwrap its envelope. */
async function get<T>(path: string): Promise<Envelope<T>> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  return await response.json() as Envelope<T>
}

/** Format an integer with grouping. */
function grouped(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

/** Remaining seconds until an ISO timestamp, floored at zero. */
function secondsUntil(iso: string): number {
  const target = Date.parse(iso)
  if (Number.isNaN(target)) return 0
  return Math.max(0, Math.floor((target - Date.now()) / 1000))
}

/** The tag palette matching one order's terminal or in-flight state. */
function statusTone(status: OrderStatus['status']): TagTone {
  if (status === 'succeeded') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'review_required') return 'warning'
  return 'neutral'
}

export function CreditsPage(props: PropsRuntime<'main'> & CreditsInjected): ReactNode {
  const { t } = props
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [balance, setBalance] = useState<BalanceResponse | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  // Login flow
  const [phone, setPhone] = useState('+861')
  const [code, setCode] = useState('')
  const [challenge, setChallenge] = useState<ChallengeResponse | null>(null)
  const [resendIn, setResendIn] = useState(0)
  const [busy, setBusy] = useState(false)
  const challengeKey = useRef<string | null>(null)
  const verifyKey = useRef<string | null>(null)

  // Recharge flow
  const [amountYuan, setAmountYuan] = useState('100')
  const [order, setOrder] = useState<OrderCreated | null>(null)
  const [orderState, setOrderState] = useState<OrderStatus | null>(null)
  const [polling, setPolling] = useState(false)
  const [copied, setCopied] = useState(false)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const creditsPerYuan = session?.creditsPerYuan ?? 1000

  /** Refresh the balance, returning to login when the session is gone. */
  const loadBalance = useCallback(async () => {
    const answer = await get<BalanceResponse>('/credits/api/summary')
    if (answer.sessionInvalid === true) {
      setSession({ signedIn: false, creditsPerYuan })
      setBalance(null)
      return
    }
    if (answer.payload !== undefined) setBalance(answer.payload)
    else if (answer.code !== null && answer.code !== undefined) setFailure(answer.message ?? answer.code)
  }, [creditsPerYuan])

  /**
   * Re-read the session itself, not only the balance: a sign-in completed
   * outside this page (the login API, another window) must reach the form.
   */
  const loadSession = useCallback(async () => {
    const answer = await get<SessionInfo>('/credits/api/session')
    const info = answer.payload ?? { signedIn: false, creditsPerYuan: 1000 }
    setSession(info)
    setSessionLoaded(true)
    if (info.signedIn) await loadBalance()
  }, [loadBalance])

  useEffect(() => { void loadSession() }, [loadSession])

  /**
   * Heartbeat: the points live on the platform (backed by new-api), so the page
   * re-reads them on a fixed interval instead of trying to account locally.
   */
  useEffect(() => {
    // Unconditional on purpose: a signed-out panel has to notice a sign-in that
    // happened elsewhere, which is exactly the case the gate would hide.
    const timer = setInterval(() => { void loadSession() }, 60_000)
    return () => { clearInterval(timer) }
  }, [loadSession])

  /** A window regaining focus is the operator looking, so refresh immediately. */
  useEffect(() => {
    const onFocus = (): void => { void loadSession() }
    window.addEventListener('focus', onFocus)
    return () => { window.removeEventListener('focus', onFocus) }
  }, [loadSession])

  useEffect(() => {
    if (resendIn <= 0) return undefined
    const timer = setTimeout(() => { setResendIn(seconds => Math.max(0, seconds - 1)) }, 1000)
    return () => { clearTimeout(timer) }
  }, [resendIn])

  useEffect(() => () => {
    if (pollTimer.current !== null) clearTimeout(pollTimer.current)
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
  }, [])

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
        setResendIn(answer.payload.resend_after_seconds)
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
        setNotice(bonus?.status === 'credited'
          ? t('signedInBonus', { points: grouped(bonus.points) })
          : t('signedIn'))
        setCode('')
        setChallenge(null)
        challengeKey.current = null
        verifyKey.current = null
        const info = await get<SessionInfo>('/credits/api/session')
        setSession(info.payload ?? { signedIn: true, creditsPerYuan })
        await loadBalance()
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
  }, [challenge, code, creditsPerYuan, loadBalance, t])

  /** Sign out: revoke on the platform, clear locally, return to the form. */
  const signOut = useCallback(async () => {
    setBusy(true)
    try {
      await post('/credits/api/session/logout', { idempotencyKey: newKey('logout') })
    } catch {
      // Locally cleared regardless; 503 does not prove the revoke did not happen.
    } finally {
      setBusy(false)
      setBalance(null)
      setOrder(null)
      setOrderState(null)
      setSession({ signedIn: false, creditsPerYuan })
      setNotice(t('signedOut'))
    }
  }, [creditsPerYuan, t])

  /** Poll one order once, then schedule the next read at the platform's cadence. */
  const pollOrder = useCallback(async (orderNo: string, attempt: number) => {
    const answer = await get<{ status?: string; quota?: number; amount?: number; paid_at?: number }>(
      `/credits/api/recharge/wechat/order?outTradeNo=${encodeURIComponent(orderNo)}`,
    )
    if (answer.sessionInvalid === true) {
      setSession({ signedIn: false, creditsPerYuan })
      setPolling(false)
      return
    }
    const remote = answer.payload ?? null
    if (remote === null) {
      setFailure(answer.message ?? answer.code ?? t('errGeneric'))
      setPolling(false)
      return
    }
    const status: OrderStatus = {
      merchant_order_no: orderNo,
      status: remote.status === 'success' ? 'succeeded' : remote.status === 'failed' ? 'failed' : 'pending',
      points: remote.quota ?? 0,
      balance_points: null,
      poll_after_ms: 2500,
      failure_code: null,
    }
    setOrderState(status)
    if (status.status === 'succeeded') {
      setPolling(false)
      setNotice(t('rechargeSucceeded', { points: grouped(status.points) }))
      setOrder(null)
      await loadBalance()
      return
    }
    if (status.status === 'failed' || status.status === 'closed' || status.status === 'review_required') {
      setPolling(false)
      setFailure(t('rechargeTerminal', { status: status.status, code: status.failure_code ?? '—' }))
      return
    }
    const base = status.poll_after_ms ?? 2000
    const retryAfter = (answer.retryAfterSeconds ?? 0) * 1000
    const backoff = attempt > 4 ? Math.min(30_000, 1000 * 2 ** (attempt - 4)) : 0
    const delay = Math.max(base, retryAfter, backoff)
    pollTimer.current = setTimeout(() => { void pollOrder(orderNo, attempt + 1) }, delay)
  }, [creditsPerYuan, loadBalance, t])

  /** Create one order; the amount is frozen for this attempt. */
  const createOrder = useCallback(async () => {
    setFailure(null)
    setNotice(null)
    const yuan = Number(amountYuan)
    if (!Number.isFinite(yuan) || yuan <= 0) {
      setFailure(t('errAmount'))
      return
    }
    const amount = Math.round(yuan)
    if (amount < MIN_AMOUNT_YUAN || amount > MAX_AMOUNT_YUAN) {
      setFailure(t('errAmountRange', { min: String(MIN_AMOUNT_YUAN), max: String(MAX_AMOUNT_YUAN) }))
      return
    }
    setBusy(true)
    try {
      // new-api owns WeChat Native pay: one call returns the QR to scan.
      const answer = await post<{
        outTradeNo: string | null
        amount: number
        quota: number | null
        expiresAt: number | null
        qrCodeDataUrl: string | null
      }>('/credits/api/recharge/wechat', { amount })
      if (answer.ok && answer.payload !== undefined && answer.payload.outTradeNo !== null) {
        setOrder({
          merchant_order_no: answer.payload.outTradeNo,
          amount_cents: answer.payload.amount * 100,
          points: answer.payload.quota ?? 0,
          code_url: '',
          expires_at: answer.payload.expiresAt === null ? '' : new Date(answer.payload.expiresAt * 1000).toISOString(),
          poll_after_ms: 2500,
          qrCodeDataUrl: answer.payload.qrCodeDataUrl,
        })
        setOrderState(null)
        setPolling(true)
        void pollOrder(answer.payload.outTradeNo, 0)
      } else {
        setFailure(answer.message ?? answer.code ?? t('errGeneric'))
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [amountYuan, pollOrder, t])

  /** Copy the order number the platform's support flow asks for. */
  const copyOrderNo = useCallback((orderNo: string) => {
    void writeClipboard(orderNo).then((written) => {
      if (!written) return
      setCopied(true)
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => { setCopied(false) }, 1200)
    })
  }, [])

  const signedIn = session?.signedIn === true
  const amount = Number(amountYuan)
  const pointsPreview = Number.isFinite(amount) && amount > 0 ? Math.round(amount * creditsPerYuan) : null
  const orderExpiry = order === null ? 0 : secondsUntil(order.expires_at)

  return (
    <div className={css.page}>
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
      {!sessionLoaded && <p className={css.hint}>{t('loading')}</p>}

      {sessionLoaded && !signedIn && (
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
                onChange={event => { setPhone(event.target.value.trim()); challengeKey.current = null }}
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
                  onChange={event => { setCode(event.target.value.replace(/\D/g, '').slice(0, 6)); verifyKey.current = null }}
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
          <section className={css.card}>
            <div className={css.balance}>
              <div className={css.balanceValue}>
                <span className={css.balanceLabel}>
                  <CreditsPanelIcon size={14} />
                  {t('balance')}
                </span>
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
              <Button
                size="sm"
                variant="ghost"
                icon={<IconRefreshOutlineRegular />}
                onClick={() => { void loadBalance() }}
                disabled={busy}
              >
                {t('refresh')}
              </Button>
            </div>
            <div className={css.divider} />
            <div className={css.metaRow}>
              <span className={css.metaLabel}>{t('account')}</span>
              <span className={css.metaValue}>{session.account?.phone ?? '—'}</span>
              <span className={css.rate}>{t('rate', { credits: grouped(creditsPerYuan) })}</span>
            </div>
          </section>

          <section className={css.card}>
            <div className={css.cardIntro}>
              <h2 className={css.cardTitle}>{t('rechargeTitle')}</h2>
              <p className={css.hint}>
                {t('rechargeRange', { min: grouped(MIN_AMOUNT_YUAN), max: grouped(MAX_AMOUNT_YUAN) })}
              </p>
            </div>
            <div className={css.amountRow}>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('amountYuan')}</span>
                <Input
                  className={cx(css.input, css.amountInput)}
                  value={amountYuan}
                  inputMode="decimal"
                  onChange={event => { setAmountYuan(event.target.value.replace(/[^\d.]/g, '')) }}
                />
              </label>
              {pointsPreview !== null && (
                <span className={css.preview}>
                  {t('pointsPreview', { points: grouped(pointsPreview) })}
                </span>
              )}
              <div className={css.quick}>
                {QUICK_AMOUNTS_YUAN.map(value => (
                  <Pill
                    key={value}
                    active={amountYuan === String(value)}
                    onClick={() => { setAmountYuan(String(value)) }}
                  >
                    {grouped(value)}
                  </Pill>
                ))}
              </div>
              <Button
                className={css.submit}
                variant="primary"
                onClick={() => { void createOrder() }}
                disabled={busy}
              >
                {t('createOrder')}
              </Button>
            </div>

            {order !== null && (
              <div className={css.order}>
                {order.qrCodeDataUrl != null
                  ? <img className={css.qr} src={order.qrCodeDataUrl} alt={t('qrAlt')} />
                  : <p className={css.hint}>{t('qrMissing')}</p>}
                <div className={css.orderMeta}>
                  <div className={css.orderLine}>
                    <span className={css.metaLabel}>{t('orderNo')}</span>
                    <code className={css.code}>{order.merchant_order_no}</code>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<IconCopyOutlineRegular />}
                      onClick={() => { copyOrderNo(order.merchant_order_no) }}
                    >
                      {copied ? t('copied') : t('copy')}
                    </Button>
                  </div>
                  <div className={css.orderLine}>
                    <span className={css.metaLabel}>{t('amountYuan')}</span>
                    <span className={css.metaValue}>
                      {t('orderAmount', {
                        amount: String(order.amount_cents / 100),
                        points: grouped(order.points),
                      })}
                    </span>
                  </div>
                  <div className={css.orderLine}>
                    <span className={css.metaLabel}>{t('orderStatus')}</span>
                    <Tag tone={orderState === null ? 'neutral' : statusTone(orderState.status)}>
                      {orderState === null ? t('statusPending') : t(`status.${orderState.status}`)}
                    </Tag>
                    {orderExpiry > 0 && (
                      <span className={css.hint}>{t('expiresIn', { seconds: String(orderExpiry) })}</span>
                    )}
                  </div>
                  {polling && <p className={css.hint}>{t('polling')}</p>}
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
