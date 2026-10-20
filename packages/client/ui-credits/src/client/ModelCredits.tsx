/** Session and turn model-credit readings use verified Host receipts and bounded refresh. */
import { useEffect, useRef, useState } from 'react'
import { Button, IconDatabaseOutlineRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { readChatUsage, type ChatUsage } from './chat-usage.ts'
import type { CreditsSnapshot } from './session-store.ts'
import { cx } from './class-names.ts'
import css from './ModelCredits.module.css'

/** The account source is bound by the framework; navigation stays in the registrant. */
export interface ModelCreditsInjected {
  readonly hooks: { readonly creditsSession: ObservableSnapshot<CreditsSnapshot> }
  readonly openBalance: () => void
}

type DockProps = PropsRuntime<'conversation.composer.dock'> & InjectFace<ModelCreditsInjected> & PropsLocale<'credits'>
type TurnProps = PropsRuntime<'conversation.chat.turnTail'> & InjectFace<ModelCreditsInjected> & PropsLocale<'credits'>
type ReadingProps = Pick<DockProps, 'sessionId' | 'useCreditsSession' | 'openBalance' | 't'> & {
  readonly turn?: number
  readonly running: boolean
  readonly revision: string
}
interface Reading { readonly key: string; readonly usage: ChatUsage | null }

/**
 * Display this conversation's chat-model credits after settlement.
 * @param props - Current conversation, account observation and localized navigation.
 * @returns One composer pill; streamed text never triggers receipt reads.
 */
export function SessionModelCredits(props: DockProps) {
  const running = props.useSession(value => value.running)
  const revision = props.useChat((value) => {
    const turn = value.timeline.turnOrder.at(-1)
    const location = turn === undefined ? undefined : value.timeline.turns.get(turn)
    return `${String(turn ?? 0)}:${String(location?.end?.seq ?? 0)}`
  })
  return <ModelCredits sessionId={props.sessionId} useCreditsSession={props.useCreditsSession}
    openBalance={props.openBalance} t={props.t} running={running} revision={revision} />
}

/**
 * Display only this turn's model credits, retaining its exact turn identity.
 * @param props - Attached conversation and Chat-owned turn location.
 * @returns A turn-tail pill with the same account isolation and receipt rules.
 */
export function TurnModelCredits(props: TurnProps) {
  const running = props.useSession(value => value.running)
  return <ModelCredits sessionId={props.sessionId} useCreditsSession={props.useCreditsSession}
    openBalance={props.openBalance} t={props.t} turn={props.turn.turn}
    running={props.turn.status === 'open' && running}
    revision={`${props.turn.status}:${String(props.turn.end?.seq ?? 0)}`} />
}

function ModelCredits({ sessionId, turn, running, revision, useCreditsSession, openBalance, t }: ReadingProps) {
  const accountId = useCreditsSession(value => value.session?.signedIn === true ? value.session.account?.id ?? null : null)
  const epoch = useCreditsSession(value => value.accountEpoch)
  const [reading, setReading] = useState<Reading | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [details, setDetails] = useState<string | null>(null)
  const identity = JSON.stringify([accountId, epoch, sessionId, turn ?? null])
  const key = JSON.stringify([identity, running, revision, refresh])
  const current = useRef(key)
  current.current = key

  useEffect(() => {
    if (accountId === null) return
    const controller = new AbortController()
    let disposed = false
    let poll: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    const load = async (): Promise<void> => {
      deadline = setTimeout(() => { controller.abort(); if (!disposed && current.current === key) setReading({ key, usage: null }) }, 8000)
      const usage = await readChatUsage({ sessionId, accountId, ...turn === undefined ? {} : { turn } }, controller.signal)
      clearTimeout(deadline)
      if (disposed || controller.signal.aborted || current.current !== key) return
      setReading({ key, usage })
      if (usage?.status === 'pending' && attempts < 3) {
        attempts += 1
        poll = setTimeout(() => { void load() }, 2000)
      }
    }
    void load()
    return () => { disposed = true; clearTimeout(poll); clearTimeout(deadline); controller.abort() }
  }, [accountId, key, sessionId, turn])

  if (accountId === null) return null
  const usage = reading?.key === key ? reading.usage : undefined
  const status = running || usage === undefined ? 'pending' : usage?.status ?? 'unavailable'
  const label = t(turn === undefined ? 'chatUsage.session' : 'chatUsage.turn')
  const value = status === 'settled' && usage?.status === 'settled'
    ? usage.points > 0 && usage.points < 0.000001 ? t('chatUsage.smallPoints')
      : t('chatUsage.points', { points: usage.points.toLocaleString(undefined, { maximumFractionDigits: 6 }) })
    : t(status === 'pending' ? 'chatUsage.pending' : 'chatUsage.unavailable')
  const open = details === identity

  return <>
    <Tooltip label={t('chatUsage.details')} portal side="top">
      <button type="button" className={css.pill} data-composer-stat={turn === undefined ? 'usage' : undefined}
        aria-label={`${label}：${value}`} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => { setDetails(identity) }}>
        <IconDatabaseOutlineRegular size={14} /><span>{label}</span><span className={css.value}>{value}</span>
      </button>
    </Tooltip>
    <Modal open={open} title={label} closeLabel={t('chatUsage.close')} onClose={() => { setDetails(null) }}
      className={cx(css.dialog)} footer={<>
        <Button size="sm" onClick={() => { setRefresh(value => value + 1) }}>{t('chatUsage.refresh')}</Button>
        <Button size="sm" variant="primary" onClick={() => { setDetails(null); openBalance() }}>{t('chatUsage.allUsage')}</Button>
      </>}>
      <p className={css.amount}>{value}</p>
      <p className={css.note}>{t('chatUsage.scope')}</p>
      {usage !== undefined && usage !== null && <p className={css.note}>{t('chatUsage.requests', {
        settled: usage.settledRequests, total: usage.totalRequests,
      })}</p>}
      {status !== 'settled' && <p className={css.note}>{t(status === 'pending' ? 'chatUsage.pendingHint' : 'chatUsage.unavailableHint')}</p>}
    </Modal>
  </>
}
