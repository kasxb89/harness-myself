/** Top-up amounts, WeChat Native QR presentation, and lifecycle-owned order reads. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  IconCopyOutlineRegular,
  IconRefreshOutlineRegular,
  Input,
  Tag,
  writeClipboard,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { get, grouped, post, secondsUntil, type Envelope } from './api.ts'
import { cx } from './class-names.ts'
import { CreditsPanelIcon } from './CreditsPanelIcon.tsx'
import { QUICK_AMOUNTS_YUAN } from './recharge-amounts.ts'
import { clearRechargeRequest, useRechargeRequest } from './recharge-request.ts'
import { readCreditsSnapshot, refreshBalance, refreshCredits, useCreditsSnapshot, type CreditsSnapshot } from './session-store.ts'
import { creditsReadFailure, creditsRetrySeconds, type CreditsReadFailure } from './read-failure.ts'
import css from './CreditsPage.module.css'

/** What the plugin injects into the top-up page. */
export interface RechargePageInjected {
  /** Translate one key of this plugin's namespace. */
  readonly t: (key: string, values?: Record<string, string>) => string
  /** Open the balance page, where the sign-in form lives. */
  readonly openBalance: () => void
}

interface RechargeOwner { readonly id: string; readonly login: string; readonly epoch: number }

interface OrderCreated {
  readonly owner: RechargeOwner
  readonly merchant_order_no: string
  readonly amount_cents: number
  readonly points: number
  readonly expires_at: string
  readonly qrCodeDataUrl?: string | null
}

interface OrderStatus {
  readonly status: 'pending' | 'succeeded' | 'failed' | 'expired' | 'unknown'
  readonly points: number
  readonly failure_code: string | null
}

/** Product top-up bounds, in whole yuan. */
const MIN_AMOUNT_YUAN = 1
const MAX_AMOUNT_YUAN = 100_000

interface PaymentOperation {
  readonly controller: AbortController
  readonly owner: RechargeOwner
  phase: 'checking' | 'creating' | 'polling' | 'stopped'
  timer: ReturnType<typeof setTimeout> | null
}

function ownerOf(snapshot: CreditsSnapshot): RechargeOwner | undefined {
  const session = snapshot.session
  if (session?.signedIn !== true || session.account?.id === undefined || session.accountOwner === undefined
    || !/^[a-f0-9]{64}$/u.test(session.accountOwner)) return undefined
  return { id: session.account.id, login: session.accountOwner, epoch: snapshot.accountEpoch }
}

function ownerMatches(owner: RechargeOwner, snapshot: CreditsSnapshot): boolean {
  const current = ownerOf(snapshot)
  return current?.id === owner.id && current.login === owner.login && current.epoch === owner.epoch
}

function responseMatchesOwner(answer: Envelope<unknown>, owner: RechargeOwner): boolean {
  return answer.account?.id === owner.id && answer.accountOwner === owner.login
}

/** The tag palette matching one order's terminal or in-flight state. */
function statusTone(status: OrderStatus['status']): TagTone {
  if (status === 'succeeded') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'unknown') return 'warning'
  return 'neutral'
}

export function RechargePage(props: PropsRuntime<'main'> & RechargePageInjected): ReactNode {
  const { t, openBalance } = props
  const snapshot = useCreditsSnapshot()
  const { session, balance, loaded, failure: balanceFailure, readFailure, refreshing, accountEpoch } = snapshot
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ownerFailure, setOwnerFailure] = useState<'changed' | 'missing' | null>(null)
  const [paymentFailure, setPaymentFailure] = useState<CreditsReadFailure | null>(null)
  const [retrySeconds, setRetrySeconds] = useState(0)

  /* The page opens on the cheapest preset, so the summary and the confirm
   * button already mean something before the operator touches anything. */
  const [amountYuan, setAmountYuan] = useState(String(QUICK_AMOUNTS_YUAN[0]))
  const [storedOrder, setOrder] = useState<OrderCreated | null>(null)
  const [orderState, setOrderState] = useState<OrderStatus | null>(null)
  const [polling, setPolling] = useState(false)
  const [copied, setCopied] = useState(false)
  const amountInput = useRef<HTMLInputElement>(null)
  const operation = useRef<PaymentOperation | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recharge = useRechargeRequest()

  const creditsPerYuan = session?.creditsPerYuan ?? 1000
  const signedIn = session?.signedIn === true
  const identityBlocked = ownerOf(snapshot) === undefined || ownerFailure !== null
    || readFailure?.kind === 'accountChanged' || readFailure?.kind === 'sessionRefresh' || readFailure?.kind === 'auth'
  const order = storedOrder !== null && !identityBlocked && ownerMatches(storedOrder.owner, snapshot) ? storedOrder : null
  const cooldown = useCallback((): number => Math.max(creditsRetrySeconds(readCreditsSnapshot().readFailure),
    creditsRetrySeconds(paymentFailure)), [paymentFailure])
  useEffect(() => {
    const tick = (): void => { setRetrySeconds(cooldown()) }
    tick()
    if (cooldown() === 0) return undefined
    const timer = setInterval(() => { tick(); if (cooldown() === 0) clearInterval(timer) }, 1000)
    return () => { clearInterval(timer) }
  }, [cooldown, readFailure])

  /** The sidebar's top-up entry hands this page its amount. */
  useEffect(() => {
    if (recharge === null) return
    setAmountYuan(recharge.amount === null ? '' : String(recharge.amount))
    clearRechargeRequest()
    amountInput.current?.focus()
    amountInput.current?.select()
  }, [recharge])

  const cancelOperation = useCallback(() => {
    const previous = operation.current
    if (previous === null) return
    previous.controller.abort()
    if (previous.timer !== null) clearTimeout(previous.timer)
    operation.current = null
  }, [])

  const startOperation = useCallback((owner: RechargeOwner, phase: PaymentOperation['phase']): PaymentOperation => {
    cancelOperation()
    const next: PaymentOperation = { controller: new AbortController(), owner, phase, timer: null }
    operation.current = next
    return next
  }, [cancelOperation])

  const isActive = useCallback((active: PaymentOperation): boolean => operation.current === active
    && !active.controller.signal.aborted && ownerMatches(active.owner, readCreditsSnapshot()), [])
  const clearPayment = useCallback(() => {
    cancelOperation(); setOrder(null); setOrderState(null); setPolling(false); setBusy(false)
  }, [cancelOperation])
  const accountId = session?.account?.id
  const accountOwner = session?.accountOwner
  useEffect(() => {
    clearPayment()
    setOwnerFailure(null)
    setFailure(null)
    setNotice(null)
    return cancelOperation
  }, [accountEpoch, accountId, accountOwner, signedIn, cancelOperation, clearPayment])

  useEffect(() => { if (identityBlocked) clearPayment() }, [identityBlocked, clearPayment])

  const refreshAccount = useCallback(async (): Promise<void> => {
    if (cooldown() > 0 || busy) return
    clearPayment(); setFailure(null); setNotice(null); setBusy(true)
    try {
      const verified = await refreshCredits()
      const current = readCreditsSnapshot()
      if (!verified) { setFailure(t('rechargeAccountUnconfirmed')); return }
      setOwnerFailure(ownerOf(current) === undefined ? 'missing' : null)
    } finally { setBusy(false) }
  }, [busy, clearPayment, cooldown, t])

  const failOwnership = useCallback((missing: boolean) => {
    clearPayment(); setOwnerFailure(missing ? 'missing' : 'changed')
  }, [clearPayment])

  useEffect(() => () => {
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
  }, [])

  /** Late reads belong only to their active operation, never a replacement order. */
  const pollOrder = useCallback(async (orderNo: string, attempt: number, active: PaymentOperation): Promise<void> => {
    if (!isActive(active) || cooldown() > 0) { if (isActive(active)) setPolling(false); return }
    try {
      const query = new URLSearchParams({ outTradeNo: orderNo, expected_account_id: active.owner.id,
        expected_account_owner: active.owner.login })
      const answer = await get<{ status: string; points: number }>(
        `/credits/api/recharge/wechat/order?${query.toString()}`,
        active.controller.signal,
      )
      if (!isActive(active)) return
      if (answer.code === 'ACCOUNT_CHANGED' || answer.code === 'SESSION_REFRESH_REQUIRED') {
        failOwnership(answer.code === 'SESSION_REFRESH_REQUIRED'); return
      }
      if (answer.sessionInvalid === true || answer.httpStatus === 401) {
        setFailure(t('rechargeSessionExpired'))
        setPolling(false)
        failOwnership(false)
        return
      }
      const remote = answer.payload
      if (!answer.ok || remote === undefined) {
        setPaymentFailure(creditsReadFailure(answer, 'RECHARGE_UNAVAILABLE'))
        active.phase = 'stopped'
        setFailure(t('rechargePollFailed'))
        setPolling(false)
        return
      }
      if (!responseMatchesOwner(answer, active.owner)) { failOwnership(answer.accountOwner === undefined); return }
      const status: OrderStatus = {
        status: remote.status === 'success' ? 'succeeded'
          : remote.status === 'failed' ? 'failed'
            : remote.status === 'expired' ? 'expired'
              : remote.status === 'pending' ? 'pending' : 'unknown',
        points: remote.points,
        failure_code: null,
      }
      active.phase = status.status === 'pending' ? 'polling' : 'stopped'
      setOrderState(status)
      if (status.status === 'succeeded') {
        setPolling(false)
        setNotice(t('rechargeSucceeded', { points: grouped(status.points) }))
        try {
          await refreshBalance()
        } catch (error) {
          if (isActive(active)) setFailure(t('rechargeBalanceFailed'))
          // The confirmed payment remains successful when its balance read fails.
          void error
        }
        return
      }
      if (status.status === 'unknown') {
        setPolling(false)
        setFailure(t('rechargeStatusUnknown', { status: remote.status }))
        return
      }
      if (status.status === 'failed' || status.status === 'expired') {
        setPolling(false)
        setFailure(t('rechargeTerminal', {
          status: t(`status.${status.status}`), code: status.failure_code ?? '—',
        }))
        return
      }
      const retryAfter = (answer.retryAfterSeconds ?? 0) * 1000
      const backoff = attempt > 4 ? Math.min(30_000, 1000 * 2 ** (attempt - 4)) : 0
      const delay = Math.max(2500, retryAfter, backoff)
      active.timer = setTimeout(() => {
        active.timer = null
        void pollOrder(orderNo, attempt + 1, active)
      }, delay)
    } catch (error) {
      if (!isActive(active)) return
      setPolling(false)
      setFailure(t('rechargePollFailed'))
      // The failed read does not establish whether payment completed.
      void error
    }
  }, [cooldown, failOwnership, isActive, t])

  const stopPolling = useCallback(() => {
    cancelOperation()
    setPolling(false)
    setNotice(t('rechargePollingStopped'))
  }, [cancelOperation, t])

  const resumePolling = useCallback(() => {
    if (order === null || cooldown() > 0 || !ownerMatches(order.owner, readCreditsSnapshot())) return
    setFailure(null)
    setNotice(null)
    setPolling(true)
    void pollOrder(order.merchant_order_no, 0, startOperation(order.owner, 'polling'))
  }, [cooldown, order, pollOrder, startOperation])

  /** A create failure is never retried automatically because its outcome may be unknown. */
  const createOrder = useCallback(async () => {
    if (cooldown() > 0 || identityBlocked || operation.current?.phase === 'checking' || operation.current?.phase === 'creating') return
    const observed = ownerOf(snapshot)
    if (observed === undefined || !ownerMatches(observed, readCreditsSnapshot())) { failOwnership(observed === undefined); return }
    setFailure(null)
    setNotice(null)
    const amount = Number(amountYuan)
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      setFailure(t('errAmount'))
      return
    }
    if (amount < MIN_AMOUNT_YUAN || amount > MAX_AMOUNT_YUAN) {
      setFailure(t('errAmountRange', { min: String(MIN_AMOUNT_YUAN), max: String(MAX_AMOUNT_YUAN) }))
      return
    }
    const active = startOperation(observed, 'checking')
    setPolling(false)
    setBusy(true)
    try {
      const verified = await refreshCredits(active.controller.signal)
      if (!isActive(active)) return
      if (!verified || cooldown() > 0) {
        active.phase = 'stopped'
        setOrder(null); setOrderState(null)
        setFailure(t('rechargeAccountUnconfirmed'))
        return
      }
      const latest = readCreditsSnapshot()
      if (!ownerMatches(observed, latest) || latest.readFailure?.kind === 'accountChanged'
        || latest.readFailure?.kind === 'sessionRefresh' || latest.readFailure?.kind === 'auth') { failOwnership(false); return }
      active.phase = 'creating'
      const answer = await post<{
        outTradeNo: string | null
        amount: number
        points: number
        expiresAt: number | null
        qrCodeDataUrl: string | null
      }>('/credits/api/recharge/wechat', { amount, expected_account_id: observed.id,
        expected_account_owner: observed.login }, active.controller.signal)
      if (!isActive(active)) return
      if (answer.code === 'ACCOUNT_CHANGED' || answer.code === 'SESSION_REFRESH_REQUIRED') {
        failOwnership(answer.code === 'SESSION_REFRESH_REQUIRED'); return
      }
      if (answer.ok && answer.payload !== undefined && answer.payload.outTradeNo !== null) {
        if (!responseMatchesOwner(answer, observed)) { failOwnership(answer.accountOwner === undefined); return }
        active.phase = 'polling'
        setOrder({
          owner: observed,
          merchant_order_no: answer.payload.outTradeNo,
          amount_cents: answer.payload.amount * 100,
          points: answer.payload.points,
          expires_at: answer.payload.expiresAt === null ? '' : new Date(answer.payload.expiresAt * 1000).toISOString(),
          qrCodeDataUrl: answer.payload.qrCodeDataUrl,
        })
        setOrderState(null)
        setPolling(true)
        setCopied(false)
        void pollOrder(answer.payload.outTradeNo, 0, active)
      } else {
        active.phase = 'stopped'
        setPaymentFailure(creditsReadFailure(answer, 'RECHARGE_UNAVAILABLE'))
        setFailure(t('rechargeCreateFailed'))
      }
    } catch (error) {
      if (!isActive(active)) return
      active.phase = 'stopped'
      setFailure(t('rechargeCreateFailed'))
      // No second create is safe until the user checks the existing order.
      void error
    } finally {
      if (isActive(active)) setBusy(false)
    }
  }, [amountYuan, cooldown, failOwnership, identityBlocked, isActive, pollOrder, snapshot, startOperation, t])

  /** Copy the order number the platform's support flow asks for. */
  const copyOrderNo = useCallback((orderNo: string) => {
    void writeClipboard(orderNo).then((written) => {
      if (!written) return
      setCopied(true)
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => { setCopied(false) }, 1200)
    })
  }, [])

  const amount = Number(amountYuan)
  const pointsPreview = Number.isSafeInteger(amount) && amount > 0 ? amount * creditsPerYuan : null
  const orderExpiry = order === null ? 0 : secondsUntil(order.expires_at)
  const identityMessage = ownerFailure === 'changed' || readFailure?.kind === 'accountChanged' ? t('rechargeAccountChanged')
    : identityBlocked ? t('rechargeIdentityRequired') : null
  const failureMessage = identityMessage ?? failure
    ?? (balanceFailure === null ? null : orderState?.status === 'succeeded' ? t('rechargeBalanceFailed')
      : t(`read.error.${readFailure?.kind ?? 'unavailable'}`))

  return (
    <div className={css.page}>
      <header className={css.header}>
        <h1 className={css.rechargeTitle}>{t('rechargePageTitle')}</h1>
      </header>

      {failureMessage !== null && <div className={css.banner} data-tone="error">
        <span role="alert">{failureMessage}</span>
        {signedIn && <Button size="sm" variant="ghost" disabled={busy || refreshing || retrySeconds > 0}
          onClick={() => { void refreshAccount() }}>{t('rechargeRefreshAccount')}</Button>}
      </div>}
      {retrySeconds > 0 && <p className={css.hint}>{t('read.retryAfter', { seconds: String(retrySeconds) })}</p>}
      {notice !== null && <p className={css.banner} data-tone="success" role="status">{notice}</p>}
      {!loaded && <p className={css.hint}>{t('loading')}</p>}

      {loaded && !signedIn && (
        <section className={css.card}>
          <div className={css.cardIntro}>
            <h2 className={css.cardTitle}>{t('needSignIn')}</h2>
            <p className={css.hint}>{t('loginHint')}</p>
          </div>
          <div>
            <Button variant="primary" onClick={openBalance}>{t('goSignIn')}</Button>
          </div>
        </section>
      )}

      {signedIn && (
        <div className={css.rechargeLayout}>
          <section className={css.card}>
            {/* Balance row: what is left, with the same refresh the balance page
              offers — the number decides the amount below it. */}
            <div className={css.balanceRow}>
              <CreditsPanelIcon size={16} />
              <span className={css.balanceRowLabel}>{t('currentPoints')}</span>
              <span className={css.balanceRowValue}>
                {balance === null ? '—' : grouped(balance.balance_points)}
              </span>
              <span className={css.balanceRowUnit}>{t('points')}</span>
              <Button
                size="sm"
                variant="ghost"
                icon={<IconRefreshOutlineRegular />}
                aria-label={t('refresh')}
                onClick={() => { void refreshAccount() }}
                disabled={busy || refreshing || retrySeconds > 0}
              />
            </div>

            <p className={css.hint}>{t('rechargeAccountLabel', { account: session.account?.phone ?? '—' })}</p>
            <h2 className={css.sectionTitle}>
              <CreditsPanelIcon size={18} />
              {t('selectAmount')}
            </h2>
            <div className={css.amountGrid}>
              {QUICK_AMOUNTS_YUAN.map(value => (
                <button
                  key={value}
                  type="button"
                  className={amountYuan === String(value) ? cx(css.amountCard, css.amountCardActive) : css.amountCard}
                  aria-pressed={amountYuan === String(value)}
                  onClick={() => { setAmountYuan(String(value)) }}
                >
                  {t('amountOption', { amount: grouped(value) })}
                </button>
              ))}
              <label className={cx(
                css.amountCard,
                css.amountCustom,
                amountYuan !== '' && !QUICK_AMOUNTS_YUAN.some(value => String(value) === amountYuan)
                  ? css.amountCardActive
                  : '',
              )}>
                <Input
                  ref={amountInput}
                  className={cx(css.customInput)}
                  /* A preset already names its own card, so the free-amount field
                   only carries what the operator typed itself. */
                  value={QUICK_AMOUNTS_YUAN.some(value => String(value) === amountYuan) ? '' : amountYuan}
                  inputMode="numeric"
                  aria-label={t('customAmount')}
                  placeholder={t('custom')}
                  onChange={(event) => { setAmountYuan(event.target.value) }}
                />
              </label>
            </div>
            <p className={css.hint}>
              {t('rateHint', { points: grouped(10 * creditsPerYuan) })}
              {' · '}
              {t('rechargeRange', { min: grouped(MIN_AMOUNT_YUAN), max: grouped(MAX_AMOUNT_YUAN) })}
            </p>

            <div className={css.payRow}>
              <span className={css.payAmount}>
                {t('payAmount')}：¥{pointsPreview === null ? '0.00' : Number(amountYuan).toFixed(2)}
              </span>
              {pointsPreview !== null && (
                <span className={css.payGain}>
                  {t('willGet')} <strong className={css.payGainValue}>{grouped(pointsPreview)}</strong> {t('points')}
                </span>
              )}
            </div>
            <Button
              className={css.payButton}
              variant="primary"
              onClick={() => { void createOrder() }}
              disabled={busy || identityBlocked || retrySeconds > 0}
            >
              {t('confirmPay')}
            </Button>

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
                  {(orderState === null || orderState.status === 'pending' || orderState.status === 'unknown') && (
                    <Button size="sm" variant="ghost" disabled={busy || retrySeconds > 0} onClick={polling ? stopPolling : resumePolling}>
                      {polling ? t('stopPolling') : t('checkPayment')}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
