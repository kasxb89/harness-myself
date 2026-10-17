/** Composer entry for explicitly enabling and preparing the optional voice bundle. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconMicrophoneOutlineRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './VoiceInputLauncher.module.css'

/** Setup navigation never records audio, downloads recognition models, or changes the draft. */
export interface VoiceInputLauncherFace {
  /**
   * @param signal - closing the dialog or locking the composer cancels pending activation.
   * @returns navigation outcome; unavailable inventories remain retryable.
   */
  openVoiceSetup: (signal: AbortSignal) => Promise<'opened' | 'failed' | 'unavailable' | 'cancelled'>
}

/** Composer lock, localized copy, and the manager-owned activation action. */
export type VoiceInputLauncherProps = Pick<PropsRuntime<'conversation.input.activity'>, 'locked'>
  & PropsLocale<'pluginManager'> & InjectFace<VoiceInputLauncherFace>

/**
 * Offer voice setup without requesting microphone permission before recording.
 * @param props - composer lock, setup action, and locale seat.
 * @returns the compact microphone and its explicit first-use dialog.
 */
export function VoiceInputLauncher({ locked, openVoiceSetup, t }: VoiceInputLauncherProps): ReactNode {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<'failed' | 'unavailable'>()
  const operation = useRef<AbortController>()
  useEffect(() => () => { operation.current?.abort() }, [])
  useEffect(() => { if (locked) { operation.current?.abort(); setBusy(false) } }, [locked])
  const close = (): void => { operation.current?.abort(); setOpen(false); setBusy(false) }
  const launch = async (): Promise<void> => {
    const current = new AbortController()
    operation.current?.abort(); operation.current = current
    setBusy(true); setFailure(undefined)
    let outcome: Awaited<ReturnType<VoiceInputLauncherFace['openVoiceSetup']>>
    try { outcome = await openVoiceSetup(current.signal) } catch (_error) { outcome = 'failed' }
    if (current !== operation.current || current.signal.aborted) return
    operation.current = undefined
    setBusy(false)
    if (outcome === 'opened' || outcome === 'cancelled') setOpen(false)
    else setFailure(outcome)
  }
  return <>
    <Tooltip label={t('voiceLauncher.trigger')} side="top" portal>
      <span className={css.anchor}>
        <Button size="sm" className={css.trigger} disabled={locked} aria-haspopup="dialog"
          aria-label={t('voiceLauncher.trigger')} onMouseDown={(event) => { event.preventDefault() }}
          onClick={() => { setFailure(undefined); setOpen(true) }}><IconMicrophoneOutlineRegular size={18} /></Button>
      </span>
    </Tooltip>
    <Modal open={open} onClose={close} title={t('voiceLauncher.title')} closeLabel={t('close')}
      description={t('voiceLauncher.description')} footer={<>
        <Button variant="outline" onClick={close}>{t('cancel')}</Button>
        <Button variant="primary" disabled={locked || busy} onClick={() => { void launch() }}>
          {t(busy ? 'voiceLauncher.opening' : failure ? 'retry' : 'voiceLauncher.enable')}
        </Button>
      </>}>
      {failure && <p className={css.error} role="alert">{t(failure === 'failed' ? 'voiceLauncher.failed' : 'voiceLauncher.unavailable')}</p>}
    </Modal>
  </>
}
