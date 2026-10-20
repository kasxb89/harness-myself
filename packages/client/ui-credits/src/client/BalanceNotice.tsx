/** Product-owned recharge action for a confirmed user-balance rejection. */
import { useEffect, useRef } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { QuotaNoticeOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { CreditsSnapshot } from './session-store.ts'

/** The recharge panel owner supplies navigation and the live signed-in identity. */
export interface BalanceNoticeInjected {
  readonly openRecharge: () => void
  readonly hooks: { readonly creditsSession: ObservableSnapshot<CreditsSnapshot> }
}

type Props = PropsRuntime<'shell.quota-notice'> & PropsLocale<'credits'> & InjectFace<BalanceNoticeInjected>
  & { readonly matched: QuotaNoticeOwnerProps }

/** @param props - Confirmed rejection and the existing recharge route. @returns An account-bound recharge notice. */
export function BalanceNotice({ matched, openRecharge, useCreditsSession, t }: Props) {
  const snapshot = useCreditsSession(value => value)
  const identity = snapshot.session?.signedIn === true ? snapshot.session.account?.id : undefined
  const original = useRef({ identity, epoch: snapshot.accountEpoch })
  if (original.current.identity === undefined && identity !== undefined) {
    original.current = { identity, epoch: snapshot.accountEpoch }
  }
  const changed = original.current.identity !== undefined
    && (identity !== original.current.identity || snapshot.accountEpoch !== original.current.epoch)
  useEffect(() => { if (changed) matched.dismiss() }, [changed, matched.dismiss])
  if (changed) return null
  return <Modal open title={t('balanceInsufficient')} closeLabel={t('close')} onClose={matched.dismiss}
    description={t('balanceInsufficientHint')}
    footer={<>
      <Button variant="outline" onClick={matched.dismiss}>{t('close')}</Button>
      <Button variant="primary" disabled={identity === undefined} onClick={() => { matched.dismiss(); openRecharge() }}>{t('goRecharge')}</Button>
    </>} />
}
