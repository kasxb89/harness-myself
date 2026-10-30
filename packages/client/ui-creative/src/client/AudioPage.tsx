/** Main AI creation speech panel using the ordinary account and conversation sources. @module */
import { useId, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-credits/client'
import { AudioCreation } from './AudioCreation.tsx'
import type {} from './locales.ts'
import css from './AudioPage.module.css'

/** Plain navigation callbacks and standard reactive account/chat facts. */
export interface AudioPageInjected {
  readonly hooks: { readonly creationSession: HostObservable<StandardSourceBinding>; readonly creditsSession: Context['creditsSession'] }
  readonly openImage: () => void
  readonly openVideo: () => void
}

/** The AI creation audio mode, with account changes discarding stale forms and estimates. */
export type AudioPageProps = PropsRuntime<'main'> & PropsLocale<'creative'> & InjectFace<AudioPageInjected>

/** @param props - Framework-derived account, chat, navigation and copy. @returns Main audio creation panel. */
export function AudioPage(props: AudioPageProps): ReactNode {
  const tabsId = useId()
  const sessionId = props.useCreationSession(value => value.key)
  const accountId = props.useCreditsSession(value => value.session?.signedIn === true ? value.session.account?.id ?? null : null)
  const epoch = props.useCreditsSession(value => value.accountEpoch)
  const t = props.t
  return <main className={css.page}>
    <div className={css.content}>
      <header className={css.header}><h1 className={css.title}>{t('audio.creationTitle')}</h1>
        <SegmentedControl id={tabsId} label={t('audio.modes')} value="audio"
          options={[{ value: 'image', label: t('kind.image') }, { value: 'video', label: t('kind.video') }, { value: 'audio', label: t('kind.audio') }]}
          onChange={(value) => { if (value === 'image') props.openImage(); else if (value === 'video') props.openVideo() }} />
      </header>
      {accountId === null ? <p>{t('signedOut')}</p> : sessionId === undefined ? <p>{t('chooseSession')}</p>
        : <AudioCreation key={`${accountId}:${epoch}:${sessionId}`} sessionId={sessionId} t={t} expanded />}
    </div>
  </main>
}
