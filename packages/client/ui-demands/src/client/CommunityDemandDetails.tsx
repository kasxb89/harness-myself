/** Public demand details accept only adapter-approved public presentation fields. */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CommunityDemandAccess, CommunityOperationView, CommunityPublicDemandView } from './community-view.ts'
import { DemandAttachments } from './DemandAttachments.tsx'
import type { DemandTranslate } from './DemandUI.tsx'
import css from './CommunityDemand.module.css'

/**
 * Show public details and only the actions explicitly granted to this viewer.
 * @param props - Public-safe data, normalized permissions, operation state and owner commands.
 * @returns A public detail dialog; unknown results expose only the original-operation check.
 */
export function CommunityDemandDetails(props: {
  open: boolean
  demand: CommunityPublicDemandView
  access: CommunityDemandAccess
  operation: CommunityOperationView
  onClose: () => void
  onClaim: () => void
  onCheck: () => void
  onOpenConversation: () => void
  onDownloadAttachment: (id: string) => void
  t: DemandTranslate
}): ReactNode {
  const { open, demand, access, operation, onClose, onClaim, onCheck, onOpenConversation, onDownloadAttachment, t } = props
  const unknown = operation.state === 'unknown'
  const submitting = operation.state === 'submitting'
  const action = unknown ? <Button variant="primary" disabled={operation.checking} onClick={onCheck}>{t('communityCheckClaim')}</Button>
    : submitting ? <Button variant="primary" disabled>{t('communityClaiming')}</Button>
      : operation.state === 'failed' && operation.recoverable ? <Button variant="primary" disabled={operation.recovering}
        onClick={onCheck}>{t('communityRetryOriginal')}</Button>
        : access.canOpenConversation ? <Button variant="primary" onClick={onOpenConversation}>{t('communicate')}</Button>
          : access.relation === 'visitor' ? <Button variant="primary" disabled={!access.canClaim} onClick={onClaim}>
            {t('communityClaim')}</Button> : null
  return <Modal open={open} onClose={onClose} title={t('communityPublicDetails')} closeLabel={t('close')}
    className={clsx(css.dialog)} contentClassName={clsx(css.dialogContent)} footer={<div className={css.actions}>
      <Button onClick={onClose}>{t('close')}</Button>{action}
    </div>}>
    <div className={css.details} aria-busy={submitting}>
      <h3>{demand.title}</h3>
      <dl className={css.facts}>
        <div><dt>{t('communityService')}</dt><dd>{demand.serviceName}</dd></div>
        <div><dt>{t('communityAuthor')}</dt><dd>{demand.authorDisplayName}</dd></div>
      </dl>
      <p className={css.brief}>{demand.brief}</p>
      {demand.attachments.length === 0 ? null : <section aria-label={t('communityPublicAttachments')}>
        <h4>{t('communityPublicAttachments')}</h4>
        <DemandAttachments attachments={demand.attachments.map(item => ({ ...item, status: 'ready' as const }))}
          download={onDownloadAttachment} t={t} />
      </section>}
      <p className={css.note}>{t('communityAdminVisibility')}</p>
      {access.reason === null || submitting || unknown ? null : <p className={css.note}>{access.reason}</p>}
      {operation.state !== 'failed' ? null : <p className={css.failure} role="alert">{operation.message}</p>}
      {!unknown ? null : <p className={css.notice} role="status">{operation.message ?? t('communityClaimUnknown')}</p>}
    </div>
  </Modal>
}
