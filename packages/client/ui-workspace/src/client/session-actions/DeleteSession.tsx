/** Permanent Session-record deletion, separate from recoverable archival. */
import { useState } from 'react'
import {
  Button, IconTrashOutlineRegular, MenuItemButton, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  DeleteSessionInjected, SessionDeleteDialogProps, SessionDeleteTarget, SessionMenuItemProps,
} from '../contract/slots.ts'
import css from '../rows/WorkspaceBrowser.module.css'

/**
 * Open confirmation without calling the Host deletion method.
 * @param props - row identity, menu state, and confirmation request callback.
 * @returns one destructive menu item.
 */
export function DeleteSessionMenuItem({
  sessionId, displayTitle, useMenuOpenState, requestSessionDelete, t,
}: SessionMenuItemProps<DeleteSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton
      danger
      separatorBefore
      icon={<IconTrashOutlineRegular size={14} />}
      onSelect={() => {
        setMenuOpen(false)
        requestSessionDelete(sessionId, displayTitle)
      }}
    >
      {t('menu.deleteSession')}
    </MenuItemButton>
  )
}

/**
 * Render the pending confirmation outside the row menu's lifetime.
 * @param props - pending identity, settlement, and confirmed deletion callback.
 * @returns a confirmation dialog, or nothing.
 */
export function SessionDeleteDialog({ useDeleteRequest, settleSessionDelete, deleteSession, t }: SessionDeleteDialogProps) {
  const request = useDeleteRequest(value => value)
  if (request === null) return null
  return <DeleteConfirmForm key={request.sessionId} request={request} onSettle={settleSessionDelete} deleteSession={deleteSession} t={t} />
}

/** The operation's pending/error state belongs to one exact confirmation. */
function DeleteConfirmForm({ request, onSettle, deleteSession, t }: {
  request: SessionDeleteTarget
  onSettle: SessionDeleteDialogProps['settleSessionDelete']
  deleteSession: SessionDeleteDialogProps['deleteSession']
  t: SessionDeleteDialogProps['t']
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => { if (!deleting) onSettle() }
  const confirm = () => {
    if (deleting || request.cwd === undefined) return
    setDeleting(true)
    setError(null)
    deleteSession(request.sessionId, request.cwd).then(() => {
      onSettle()
    }).catch((reason: unknown) => {
      setDeleting(false)
      setError(reason instanceof Error ? reason.message : t('delete.session.unknown'))
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('delete.session.title')}
      description={t('delete.session.desc', { title: request.displayTitle || t('session.new') })}
      footer={(
        <>
          <Button data-modal-autofocus variant="outline" disabled={deleting} onClick={close}>{t('cancel')}</Button>
          <Button variant="outline" className={css.deleteAction} disabled={deleting || request.cwd === undefined} onClick={confirm}>
            {t('delete.session.action')}
          </Button>
        </>
      )}
    >
      <p>{t('delete.session.filesRetained')}</p>
      {request.cwd === undefined && <div className={css.renameError} role="alert">{t('delete.session.missingWorkspace')}</div>}
      {deleting && <div className={css.deleteStatus} role="status">{t('delete.session.pending')}</div>}
      {error !== null && <div className={css.renameError} role="alert">{error}</div>}
    </Modal>
  )
}
