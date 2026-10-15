/**
 * The Top-up page: amount → WeChat Native QR → order polling.
 *
 * It is its own surface because paying is a different task from reading a
 * balance: the sidebar's top-up entry lands here directly, with the amount the
 * operator asked for already in the field, and the current balance stays in the
 * header so a top-up decision can be made without leaving the page.
 *
 * Idempotency keys are minted once per operation and reused by that operation's
 * retries, and the order poller keeps the platform's `poll_after_ms` cadence —
 * never a tight loop.
 */
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
  readonly status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'closed' | 'review_required'
  readonly points: number
  readonly failure_code: string | null
}

/** One discounted model the platform advertises on the top-up page. */
interface PromoModel {
  readonly id: string
  readonly name: string
  readonly label: string
}

/**
 * PLACEHOLDER CONTENT — design sample only, not a price.
 *
 * The real rows arrive from `GET /credits/api/promo` (`{ models: [{ id, name,
 * label }] }`); whatever that endpoint returns replaces this list entirely. The
 * models named here are the deployment's own, but the discount labels are the
 * reference design's sample values and must not ship as real pricing.
 * Delete this constant once the endpoint answers.
 */
const PROMO_PLACEHOLDER: readonly PromoModel[] = [
  { id: 'glm-5.1', name: 'GLM-5.1', label: '8.5折' },
  { id: 'glm-5.2', name: 'GLM-5.2', label: '8.5折' },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', label: '8.5折' },
  { id: 'kimi-k2.7-code', name: 'Kimi-K2.7', label: '8.5折' },
  { id: 'qwen3.7-max', name: 'Qwen3.7-Max', label: '8折' },
  { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', label: '8折' },
]

/**
 * Top-up bounds the platform's `recharge/wechat` route enforces, in yuan. The
 * page states the same range in its own hint instead of asking the platform for
 * a second opinion, so the two can only disagree by editing this constant.
 */
const MIN_AMOUNT_YUAN = 1
const MAX_AMOUNT_YUAN = 100_000

/** The tag palette matching one order's terminal or in-flight state. */
function statusTone(status: OrderStatus['status']): TagTone {
  if (status === 'succeeded') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'review_required') return 'warning'
  return 'neutral'
}

export function RechargePage(props: PropsRuntime<'main'> & RechargePageInjected): ReactNode {
  const { t, openBalance } = props
  const { session, balance, loaded } = useCreditsSnapshot()
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
  const [promo, setPromo] = useState<readonly PromoModel[]>([])
  const amountInput = useRef<HTMLInputElement>(null)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  useEffect(() => () => {
    if (pollTimer.current !== null) clearTimeout(pollTimer.current)
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
  }, [])

  /**
   * The promo list is deployment data: the host reads new-api's own group
   * ratios, so a channel that goes live with a discount shows up here with the
   * platform's own label. A deployment without one answers with an empty list,
   * and the card says so rather than inventing a number.
   */
  useEffect(() => {
    if (!signedIn) return
    let active = true
    void get<{ models?: readonly PromoModel[] }>('/credits/api/promo')
      .then((answer) => { if (active) setPromo(answer.payload?.models ?? []) })
      .catch(() => { /* An advertisement that cannot be read simply omits itself. */ })
    return () => { active = false }
  }, [signedIn])

  /** Poll one order once, then schedule the next read at the platform's cadence. */
  const pollOrder = useCallback(async (orderNo: string, attempt: number) => {
    const answer = await get<{ status?: string; quota?: number }>(
      `/credits/api/recharge/wechat/order?outTradeNo=${encodeURIComponent(orderNo)}`,
    )
    if (answer.sessionInvalid === true) {
      await refreshCredits()
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
      status: remote.status === 'success' ? 'succeeded' : remote.status === 'failed' ? 'failed' : 'pending',
      points: remote.quota ?? 0,
      failure_code: null,
    }
    setOrderState(status)
    if (status.status === 'succeeded') {
      setPolling(false)
      setNotice(t('rechargeSucceeded', { points: grouped(status.points) }))
      setOrder(null)
      await refreshBalance()
      return
    }
    if (status.status === 'failed' || status.status === 'closed' || status.status === 'review_required') {
      setPolling(false)
      setFailure(t('rechargeTerminal', { status: status.status, code: status.failure_code ?? '—' }))
      return
    }
    const retryAfter = (answer.retryAfterSeconds ?? 0) * 1000
    const backoff = attempt > 4 ? Math.min(30_000, 1000 * 2 ** (attempt - 4)) : 0
    const delay = Math.max(2500, retryAfter, backoff)
    pollTimer.current = setTimeout(() => { void pollOrder(orderNo, attempt + 1) }, delay)
  }, [refreshBalance, t])

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
          expires_at: answer.payload.expiresAt === null ? '' : new Date(answer.payload.expiresAt * 1000).toISOString(),
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

  const amount = Number(amountYuan)
  const pointsPreview = Number.isFinite(amount) && amount > 0 ? Math.round(amount * creditsPerYuan) : null
  const orderExpiry = order === null ? 0 : secondsUntil(order.expires_at)

  return (
    <div className={css.page}>
      <header className={css.header}>
        <h1 className={css.rechargeTitle}>{t('rechargePageTitle')}</h1>
      </header>

      {failure !== null && <p className={css.banner} data-tone="error" role="alert">{failure}</p>}
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
                  {`${grouped(value)} 元`}
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
                  inputMode="decimal"
                  placeholder={t('custom')}
                  onChange={(event) => { setAmountYuan(event.target.value.replace(/[^\d.]/g, '')) }}
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
                </div>
              </div>
            )}
          </section>
          {/* The advertisement beside the payment column: what a top-up buys.
              Its rows come from the platform's own discount data. */}
          <aside className={css.promo}>
            <span className={css.promoTag}>{t('promoTag')}</span>
            <h2 className={css.promoTitle}>{t('promoTitle')}</h2>
            <ul className={css.promoGrid}>
              {(promo.length > 0 ? promo : PROMO_PLACEHOLDER).map(model => (
                <li key={model.id} className={css.promoModel}>
                  <span className={css.promoName} title={model.name}>{model.name}</span>
                  <span className={css.promoPill}>{model.label}</span>
                </li>
              ))}
            </ul>
            <p className={css.promoNote}>{t('promoNote')}</p>
          </aside>
        </div>
      )}
    </div>
  )
}
