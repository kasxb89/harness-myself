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
import { get, grouped, post, secondsUntil } from './api.ts'
import { cx } from './class-names.ts'
import { CreditsPanelIcon } from './CreditsPanelIcon.tsx'
import { QUICK_AMOUNTS_YUAN } from './recharge-amounts.ts'
import { clearRechargeRequest, useRechargeRequest } from './recharge-request.ts'
import { refreshBalance, refreshCredits, useCreditsSnapshot } from './session-store.ts'
import css from './CreditsPage.module.css'

/** What the plugin injects into the top-up page. */
export interface RechargePageInjected {
  /** Translate one key of this plugin's namespace. */
  readonly t: (key: string, values?: Record<string, string>) => string
  /** Open the balance page, where the sign-in form lives. */
  readonly openBalance: () => void
}

interface OrderCreated {
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
  timer: ReturnType<typeof setTimeout> | null
}

function isActive(active: PaymentOperation): boolean {
  return !active.controller.signal.aborted
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
  const { session, balance, loaded, failure: balanceFailure } = useCreditsSnapshot()
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /* The page opens on the cheapest preset, so the summary and the confirm
   * button already mean something before the operator touches anything. */
  const [amountYuan, setAmountYuan] = useState(String(QUICK_AMOUNTS_YUAN[0]))
  const [order, setOrder] = useState<OrderCreated | null>(null)
  const [orderState, setOrderState] = useState<OrderStatus | null>(null)
  const [polling, setPolling] = useState(false)
  const [copied, setCopied] = useState(false)
  const amountInput = useRef<HTMLInputElement>(null)
  const operation = useRef<PaymentOperation | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recharge = useRechargeRequest()

  const creditsPerYuan = session?.creditsPerYuan ?? 1000
  const signedIn = session?.signedIn === true

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

  const startOperation = useCallback((): PaymentOperation => {
    cancelOperation()
    const next = { controller: new AbortController(), timer: null }
    operation.current = next
    return next
  }, [cancelOperation])

  const accountId = session?.account?.id
  useEffect(() => {
    setOrder(null)
    setOrderState(null)
    setPolling(false)
    setBusy(false)
    setFailure(null)
    setNotice(null)
    return cancelOperation
  }, [accountId, signedIn, cancelOperation])

  useEffect(() => () => {
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
  }, [])

  /** Late reads belong only to their active operation, never a replacement order. */
  const pollOrder = useCallback(async (orderNo: string, attempt: number, active: PaymentOperation): Promise<void> => {
    try {
      const answer = await get<{ status: string; points: number }>(
        `/credits/api/recharge/wechat/order?outTradeNo=${encodeURIComponent(orderNo)}`,
        active.controller.signal,
      )
      if (!isActive(active)) return
      if (answer.sessionInvalid === true) {
        setFailure(t('rechargeSessionExpired'))
        setPolling(false)
        cancelOperation()
        await refreshCredits()
        return
      }
      const remote = answer.payload
      if (!answer.ok || remote === undefined) {
        setFailure(t('rechargePollFailed'))
        setPolling(false)
        return
      }
      const status: OrderStatus = {
        status: remote.status === 'success' ? 'succeeded'
          : remote.status === 'failed' ? 'failed'
            : remote.status === 'expired' ? 'expired'
              : remote.status === 'pending' ? 'pending' : 'unknown',
        points: remote.points,
        failure_code: null,
      }
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
  }, [cancelOperation, t])

  const stopPolling = useCallback(() => {
    cancelOperation()
    setPolling(false)
    setNotice(t('rechargePollingStopped'))
  }, [cancelOperation, t])

  const resumePolling = useCallback(() => {
    if (order === null) return
    setFailure(null)
    setNotice(null)
    setPolling(true)
    void pollOrder(order.merchant_order_no, 0, startOperation())
  }, [order, pollOrder, startOperation])

  /** A create failure is never retried automatically because its outcome may be unknown. */
  const createOrder = useCallback(async () => {
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
    const active = startOperation()
    setPolling(false)
    setBusy(true)
    try {
      const answer = await post<{
        outTradeNo: string | null
        amount: number
        points: number
        expiresAt: number | null
        qrCodeDataUrl: string | null
      }>('/credits/api/recharge/wechat', { amount }, active.controller.signal)
      if (!isActive(active)) return
      if (answer.ok && answer.payload !== undefined && answer.payload.outTradeNo !== null) {
        setOrder({
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
        setFailure(t('rechargeCreateFailed'))
      }
    } catch (error) {
      if (!isActive(active)) return
      setFailure(t('rechargeCreateFailed'))
      // No second create is safe until the user checks the existing order.
      void error
    } finally {
      if (isActive(active)) setBusy(false)
    }
  }, [amountYuan, pollOrder, startOperation, t])

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
  const failureMessage = failure
    ?? (orderState?.status === 'succeeded' && balanceFailure !== null ? t('rechargeBalanceFailed') : null)

  return (
    <div className={css.page}>
      <header className={css.header}>
        <h1 className={css.rechargeTitle}>{t('rechargePageTitle')}</h1>
      </header>

      {failureMessage !== null && <p className={css.banner} data-tone="error" role="alert">{failureMessage}</p>}
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
                onClick={() => { void refreshBalance() }}
                disabled={busy}
              />
            </div>

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
              disabled={busy}
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
                    <Button size="sm" variant="ghost" disabled={busy} onClick={polling ? stopPolling : resumePolling}>
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
