/** Explicit public publication form; uploads and operation identity stay with the owner. */
import { useId, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Checkbox, Input, Menu, Modal, IconPaperclipOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CommunityOperationView, CommunityPublishDraft, CommunityServiceChoice } from './community-view.ts'
import type { DemandAttachment } from './types.ts'
import { DemandUploads } from './DemandAttachments.tsx'
import type { DemandTranslate } from './DemandUI.tsx'
import css from './CommunityDemand.module.css'

/**
 * Require explicit consent before submitting the displayed text and selected materials publicly.
 * @param props - Controlled fields, supplied choices and uploads, authoritative locks and owner commands.
 * @returns A publication dialog that never creates a private community request or uploads files itself.
 */
export function CommunityDemandPublish(props: {
  open: boolean
  draft: CommunityPublishDraft
  services: readonly CommunityServiceChoice[]
  attachments: readonly DemandAttachment[]
  attachmentAccept: string
  canPublish: boolean
  unavailableReason: string | null
  locked: boolean
  operation: CommunityOperationView
  onClose: () => void
  onChange: (patch: Partial<CommunityPublishDraft>) => void
  onAddAttachments: (files: readonly File[]) => void
  onRemoveAttachment: (id: string) => void
  onRetryAttachment: (id: string) => void
  onSubmit: () => void
  onCheck: () => void
  onOfficialCustomization?: () => void
  t: DemandTranslate
}): ReactNode {
  const { open, draft, services, attachments, attachmentAccept, canPublish, unavailableReason, operation, t } = props
  const formId = useId()
  const files = useRef<HTMLInputElement>(null)
  const [serviceMenu, setServiceMenu] = useState(false)
  const unknown = operation.state === 'unknown'
  const editingLocked = props.locked || operation.state === 'submitting' || unknown
  const selected = services.find(item => item.id === draft.serviceId)
  const allowPublic = draft.allowPublic === true
  const validService = services.length === 0 || selected !== undefined && selected.disabled !== true
  const ready = canPublish && !editingLocked && allowPublic && draft.title.trim() !== '' && draft.brief.trim() !== ''
    && validService && attachments.every(item => item.status === 'ready')
  const update = (patch: Partial<CommunityPublishDraft>) => { if (!editingLocked) props.onChange(patch) }
  return <Modal open={open} onClose={props.onClose} title={t('communityPublishTitle')} closeLabel={t('close')}
    className={clsx(css.dialog)} contentClassName={clsx(css.dialogContent)} footer={<div className={css.actions}>
      {props.onOfficialCustomization === undefined ? null : <Button disabled={editingLocked}
        onClick={props.onOfficialCustomization}>{t('officialCustomization')}</Button>}
      <Button onClick={props.onClose}>{t('cancel')}</Button>
      {unknown ? <Button variant="primary" disabled={operation.checking} onClick={props.onCheck}>{t('communityCheckPublication')}</Button>
        : operation.state === 'failed' && operation.recoverable
          ? <Button variant="primary" disabled={operation.recovering} onClick={props.onCheck}>{t('communityRetryOriginal')}</Button>
          : <Button variant="primary" type="submit" form={formId} disabled={!ready}>
            {t(operation.state === 'submitting' ? 'communityPublishing' : 'communityPublish')}</Button>}
    </div>}>
    <form id={formId} className={css.form} aria-busy={operation.state === 'submitting'} onSubmit={(event) => {
      event.preventDefault()
      if (ready) props.onSubmit()
    }}>
      <label className={css.field} htmlFor={`${formId}-title`}><span>{t('titleLabel')}</span>
        <Input id={`${formId}-title`} value={draft.title} disabled={editingLocked} required
          onChange={(event) => { update({ title: event.target.value }) }} /></label>
      <label className={css.field} htmlFor={`${formId}-brief`}><span>{t('communityBrief')}</span>
        <textarea id={`${formId}-brief`} value={draft.brief} disabled={editingLocked} required rows={4}
          onChange={(event) => { update({ brief: event.target.value }) }} /></label>
      {services.length === 0 ? null : <div className={css.field}>
        <span id={`${formId}-service`}>{t('communityService')}</span>
        <Menu open={serviceMenu && !editingLocked} portal selectedId={draft.serviceId}
          items={services.map(item => ({ id: item.id, label: item.label, disabled: item.disabled ?? false }))}
          onClose={() => { setServiceMenu(false) }} onSelect={(id) => { update({ serviceId: id }); setServiceMenu(false) }}
          anchor={<Button variant="outline" disabled={editingLocked} aria-labelledby={`${formId}-service ${formId}-service-value`}
            aria-haspopup="menu" aria-expanded={serviceMenu && !editingLocked} onClick={() => { setServiceMenu(value => !value) }}>
            <span id={`${formId}-service-value`}>{selected?.label ?? t('communityChooseService')}</span></Button>} />
      </div>}
      <section className={css.field} aria-label={t('communityPublicAttachments')}>
        <span>{t('communityPublicAttachments')}</span>
        <DemandUploads attachments={attachments} remove={props.onRemoveAttachment} retry={props.onRetryAttachment}
          disabled={editingLocked} t={t} />
        <div><Button size="sm" variant="outline" disabled={editingLocked} icon={<IconPaperclipOutlineRegular size={16} />}
          onClick={() => { files.current?.click() }}>{t('addAttachments')}</Button></div>
        <input ref={files} type="file" hidden multiple accept={attachmentAccept} disabled={editingLocked}
          aria-label={t('selectAttachmentFiles')} onChange={(event) => {
            if (!editingLocked && event.target.files !== null) props.onAddAttachments(Array.from(event.target.files))
            event.target.value = ''
          }} />
      </section>
      <Checkbox checked={allowPublic} disabled={editingLocked} label={t('communityPublicConsent')}
        onChange={(value) => { update({ allowPublic: value }) }} />
      <p className={css.note}>{t('communityPublicScope')}</p>
      {allowPublic ? <section className={css.preview} aria-label={t('communityPublicationPreview')}>
        <h3>{t('communityPublicationPreview')}</h3><strong>{draft.title}</strong><p className={css.brief}>{draft.brief}</p>
        {selected === undefined ? null : <p>{selected.label}</p>}
        {attachments.length === 0 ? null : <ul>{attachments.map(item => <li key={item.id}>{item.name}</li>)}</ul>}
      </section> : null}
      <p className={css.note}>{t('communityAdminVisibility')}</p>
      {unavailableReason === null ? null : <p className={css.note}>{unavailableReason}</p>}
      {operation.state !== 'failed' ? null : <p className={css.failure} role="alert">{operation.message}</p>}
      {!unknown ? null : <p className={css.notice} role="status">{operation.message ?? t('communityPublicationUnknown')}</p>}
    </form>
  </Modal>
}
