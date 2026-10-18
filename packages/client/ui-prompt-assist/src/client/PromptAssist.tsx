import { useEffect, useRef, useState } from 'react'
import { Button, IconLoadingOutlineRegular, IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { PromptAssistKey } from './locales.ts'
import { AssistFailure, requestPrompt, verifyAccount } from './request.ts'
import css from './PromptAssist.module.css'

type Props = FactoryComponentPropsOf<'creation.prompt.assist'>

interface WritingOperation {
  readonly controller: AbortController
  readonly context: string
  readonly releaseBusy: () => void
  sent: boolean
}

/**
 * Write directly into the owner's editable prompt using its shared image materials.
 * @param props - Current creation context, guarded replacement and operation callbacks.
 * @returns The writing action, revision feedback field and local operation status.
 */
export function PromptAssist({ kind, prompt, references, generation, disabled, signedIn, accountIdentity,
  onPromptChange, onBusyChange, sessionId, useProjection, t }: Props) {
  const [feedback, setFeedback] = useState('')
  const [phase, setPhase] = useState<'checking' | 'writing' | null>(null)
  const [error, setError] = useState<PromptAssistKey | null>(null)
  const [notice, setNotice] = useState<PromptAssistKey | null>(null)
  const active = useRef<WritingOperation | null>(null)
  const modelSelection = useProjection('modelSelection')
  const expectedSelection = modelSelection?.next ?? null
  const imageReferences = [...new Set(references)]
  const generationEntries = Object.entries(generation).sort(([a], [b]) => a.localeCompare(b))
  const context = JSON.stringify([accountIdentity, sessionId, expectedSelection, kind, prompt, imageReferences, generationEntries])
  const modelReady = sessionId === undefined || modelSelection !== undefined
  const allowed = signedIn && accountIdentity !== null && !disabled && modelReady
  const latest = useRef({ context, allowed, onPromptChange })
  latest.current = { context, allowed, onPromptChange }
  const pending = phase !== null
  const canWrite = Boolean(prompt.trim() || imageReferences.length)
  const referenceLimitExceeded = imageReferences.length > 6

  function finish(operation: WritingOperation, updateState = true): void {
    if (active.current !== operation) return
    active.current = null
    if (updateState) setPhase(null)
    operation.releaseBusy()
  }

  useEffect(() => {
    const operation = active.current
    if (operation !== null && (!allowed || operation.context !== context)) {
      operation.controller.abort()
      finish(operation)
      setNotice('changed')
    }
  }, [context, allowed])

  useEffect(() => () => {
    const operation = active.current
    if (operation !== null) {
      operation.controller.abort()
      finish(operation, false)
    }
  }, [])

  function isCurrent(operation: WritingOperation): boolean {
    return !operation.controller.signal.aborted && active.current === operation
      && latest.current.context === operation.context && latest.current.allowed
  }

  function stop(): void {
    const operation = active.current
    if (operation === null) return
    operation.controller.abort()
    finish(operation)
    setNotice(operation.sent ? 'stopped' : 'stoppedLocal')
  }

  async function write(revise: boolean): Promise<void> {
    if (!allowed || active.current || referenceLimitExceeded
      || (revise ? !prompt.trim() || !feedback.trim() : !canWrite)) return
    const operation: WritingOperation = {
      controller: new AbortController(), context, sent: false,
      releaseBusy: () => { onBusyChange(false) },
    }
    active.current = operation
    setPhase('checking')
    setError(null)
    setNotice(null)
    onBusyChange(true)
    try {
      await verifyAccount(accountIdentity, operation.controller.signal)
      if (!isCurrent(operation)) return
      operation.sent = true
      setPhase('writing')
      const result = await requestPrompt({
        accountId: accountIdentity, sessionId: sessionId ?? null, expectedSelection, kind, prompt,
        instruction: revise ? feedback : '', references: imageReferences, generation: { ...generation },
      }, operation.controller.signal)
      if (!isCurrent(operation)) return
      setPhase('checking')
      await verifyAccount(accountIdentity, operation.controller.signal)
      if (!isCurrent(operation)) return
      if (!latest.current.onPromptChange(result, prompt)) { setError('changed'); return }
      if (revise) setFeedback('')
      setNotice('filled')
    } catch (failure) {
      if (!isCurrent(operation)) return
      setError(failure instanceof AssistFailure ? failure.key : operation.sent ? 'resultUnknown' : 'accountCheckFailed')
    } finally {
      finish(operation)
    }
  }

  const hint = !signedIn ? 'signIn' : accountIdentity === null ? 'accountChanged'
    : disabled ? 'busy' : !modelReady ? 'modelLoading' : referenceLimitExceeded ? 'referenceLimit' : !canWrite ? 'empty' : null

  return <div className={css.root}>
    <div className={css.toolbar}>
      <Button size="sm" variant="ghost" className={css.trigger}
        icon={pending ? <IconLoadingOutlineRegular size={16} className={css.spinner} /> : <IconSparkleRegular size={16} />}
        disabled={!allowed || pending || !canWrite || referenceLimitExceeded}
        onClick={() => { void write(false) }}>{t('title')}</Button>
      {pending && <Button size="sm" onClick={stop}>{t('stop')}</Button>}
      {hint !== null ? <span className={css.hint}>{t(hint)}</span>
        : imageReferences.length > 0 && <span className={css.hint}>{t('referenceCount', { count: String(imageReferences.length) })}</span>}
    </div>
    <div className={css.feedbackRow}>
      <label className={css.field}>
        <span className={css.label}>{t('feedback')}</span>
        <textarea rows={1} maxLength={2000} value={feedback} placeholder={t('feedbackPlaceholder')}
          disabled={!allowed || pending} onChange={(event) => { setFeedback(event.target.value); setNotice(null) }} />
      </label>
      <Button size="sm" variant="outline" disabled={!allowed || pending || !prompt.trim() || !feedback.trim() || referenceLimitExceeded}
        onClick={() => { void write(true) }}>{t('revise')}</Button>
    </div>
    <div className={css.status} aria-live="polite">
      {error ? <p role="alert" className={css.error}>{t(error)}</p>
        : pending ? <p role="status">{t(phase === 'checking' ? 'checkingAccount' : 'working')}</p>
          : notice ? <p role="status">{t(notice)}</p> : null}
    </div>
    <p className={css.disclosure}>{t('requestHint')}</p>
  </div>
}
