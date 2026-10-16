/** Natural-language workspace examples that only edit the current unsent draft. */
import { useEffect, useId, useRef } from 'react'
import { Button, IconInfoOutlineRegular, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useCreditsSnapshot } from './session-store.ts'
import { cx } from './class-names.ts'
import type { WorkspaceGuideInjected, WorkspaceGuideNotice } from './workspace-guide-store.ts'
import css from './WorkspaceGuide.module.css'

type GuideProps = Pick<PropsRuntime<'conversation.input.dock'>, 'sessionId' | 'session' | 'input' | 'inputActions'>
  & PropsLocale<'credits'> & InjectFace<WorkspaceGuideInjected>
type Insertion = ReturnType<GuideProps['inputActions']['captureInsertion']>

/**
 * Show workspace examples only when the user opens the composer entry.
 * Examples insert at the captured selection's end without replacing any selected
 * content or attachments. A changed revision or busy composer refuses insertion.
 * @param props - current composer, account-aware root guide actions, and copy.
 * @returns the guide entry and its dismissible modal.
 */
export function WorkspaceGuide({
  sessionId, session, input, inputActions, useWorkspaceGuide,
  claim, dismiss, release, notify, t,
}: GuideProps) {
  const { session: account } = useCreditsSnapshot()
  const accountId = account?.signedIn === true ? account.account?.id : undefined
  const instanceId = useId()
  const ownerId = `${sessionId}:${instanceId}`
  const active = useWorkspaceGuide(value => value.active)
  const open = active?.ownerId === ownerId && active.accountId === accountId
  const capture = useRef<{ span: Insertion; populated: boolean } | null>(null)
  const busy = session.running || input.phase !== 'plain'

  const rememberInsertion = (): void => {
    const span = inputActions.captureInsertion()
    capture.current = { span: { ...span, start: span.end }, populated: input.draft.length > 0 }
  }

  useEffect(() => () => { release(ownerId) }, [accountId, ownerId, release])

  if (accountId === undefined) return null

  const close = (): void => { dismiss(ownerId); capture.current = null }
  const insert = (text: string): void => {
    if (busy) { notify('busy'); return }
    const saved = capture.current
    if (saved === null || !inputActions.insertText(saved.populated ? `\n${text}\n` : text, saved.span)) {
      notify('changed')
      return
    }
    inputActions.persistDraft()
    close()
    notify('inserted')
  }

  return (
    <div className={css.entry}>
      <Button
        size="sm"
        icon={<IconInfoOutlineRegular size={14} />}
        onClick={() => {
          if (claim(ownerId, accountId)) rememberInsertion()
          else notify('alreadyOpen')
        }}
      >{t('guide.entry')}</Button>
      <Modal
        open={open}
        title={t('guide.title')}
        description={t('guide.description')}
        closeLabel={t('guide.close')}
        onClose={close}
        className={cx(css.dialog)}
        contentClassName={cx(css.content)}
        footer={<Button variant="primary" onClick={close}>{t('guide.done')}</Button>}
      >
        <ol className={css.steps}>
          <li><span>{t('guide.step.plan.title')}</span><p>{t('guide.step.plan.description')}</p></li>
          <li><span>{t('guide.step.generate.title')}</span><p>{t('guide.step.generate.description')}</p></li>
          <li><span>{t('guide.step.edit.title')}</span><p>{t('guide.step.edit.description')}</p></li>
        </ol>
        <div className={css.examples}>
          <h3>{t('guide.examples')}</h3>
          <Button variant="outline" className={css.example} onClick={() => { insert(t('guide.prompt.create')) }}>
            {t('guide.example.create')}
          </Button>
          <Button variant="outline" className={css.example} onClick={() => { insert(t('guide.prompt.edit')) }}>
            {t('guide.example.edit')}
          </Button>
        </div>
        <p className={css.hint}>{busy ? t('guide.busy') : t('guide.hint')}</p>
      </Modal>
    </div>
  )
}

type NoticeProps = Pick<InjectFace<WorkspaceGuideInjected>, 'useWorkspaceGuide' | 'dismissNotice'> & PropsLocale<'credits'>
const noticeKeys = {
  inserted: 'guide.inserted', changed: 'guide.changed', busy: 'guide.busy', alreadyOpen: 'guide.alreadyOpen',
} as const satisfies Record<WorkspaceGuideNotice, string>

/**
 * Keep insertion feedback visible after the guide or composer disappears.
 * @param props - root-owned notice source, dismissal callback, and copy.
 * @returns one transient notice or null.
 */
export function WorkspaceGuideToast({ useWorkspaceGuide, dismissNotice, t }: NoticeProps) {
  const notice = useWorkspaceGuide(value => value.notice)
  if (notice === null) return null
  return <Toast key={notice.seq} text={t(noticeKeys[notice.kind])} {...notice.kind === 'inserted' ? { tone: 'success' as const } : {}} onDone={dismissNotice} />
}
