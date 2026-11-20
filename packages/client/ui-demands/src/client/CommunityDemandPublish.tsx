/** Explicit public publication form; uploads and operation identity stay with the owner. */
import { useId, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Checkbox, FileTypeIcon, Input, Menu, Modal, IconPaperclipOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
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
  const [dragging, setDragging] = useState(false)
  const unknown = operation.state === 'unknown'
  const editingLocked = props.locked || operation.state === 'submitting' || unknown
    || operation.state === 'failed' && operation.recoverable === true
  const allowedTypes = attachmentAccept.toLowerCase().split(',').map(value => value.trim())
  const allowsImages = allowedTypes.some(value => value.startsWith('image/') || /^\.(?:avif|gif|heic|heif|jpe?g|png|webp)$/u.test(value))
  const allowsVideos = allowedTypes.some(value => value.startsWith('video/') || /^\.(?:avi|m4v|mkv|mov|mp4|webm)$/u.test(value))
  const uploadLabel = allowsImages && allowsVideos ? 'communityUploadMedia'
    : allowsImages ? 'communityUploadImages' : allowsVideos ? 'communityUploadVideos' : 'addAttachments'
  const uploadLocked = editingLocked || !canPublish || attachmentAccept.trim() === ''
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
      {unknown ? <Button variant="accent" disabled={operation.checking} onClick={props.onCheck}>{t('communityCheckPublication')}</Button>
        : operation.state === 'failed' && operation.recoverable
          ? <Button variant="accent" disabled={operation.recovering} onClick={props.onCheck}>{t('communityRetryOriginal')}</Button>
          : <Button variant="accent" type="submit" form={formId} disabled={!ready}>
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
      <section className={css.field} aria-label={t('communityPublicAttachments')}>
        <span>{t('communityPublicAttachments')}</span>
        <Button type="button" variant="outline" className={css.uploadTarget} disabled={uploadLocked}
          data-dragging={dragging && !uploadLocked} aria-labelledby={`${formId}-upload-label`}
          aria-describedby={`${formId}-upload-hint`} onClick={() => { files.current?.click() }}
          onDragOver={(event) => {
            if (uploadLocked || !Array.from(event.dataTransfer.types).includes('Files')) return
            event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true)
          }} onDragLeave={(event) => {
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
            setDragging(false)
          }} onDrop={(event) => {
            event.preventDefault(); setDragging(false)
            if (!uploadLocked && event.dataTransfer.files.length > 0) props.onAddAttachments(Array.from(event.dataTransfer.files))
          }}>
          <span className={css.uploadMediaIcons} aria-hidden="true">
            {allowsImages ? <FileTypeIcon kind="image" size={32} /> : null}
            {allowsVideos ? <FileTypeIcon kind="video" size={32} /> : null}
            {allowsImages || allowsVideos ? null : <IconPaperclipOutlineRegular size={28} />}
          </span>
          <span className={css.uploadTargetCopy}>
            <span id={`${formId}-upload-label`} className={css.uploadTargetTitle}>{t(uploadLabel)}</span>
            <span id={`${formId}-upload-hint`} className={css.uploadTargetHint}>{t('communityUploadHint')}</span>
          </span>
        </Button>
        <DemandUploads attachments={attachments} remove={props.onRemoveAttachment} retry={props.onRetryAttachment}
          disabled={editingLocked} t={t} />
        <input ref={files} type="file" hidden multiple accept={attachmentAccept} disabled={uploadLocked}
          aria-label={t('selectAttachmentFiles')} onChange={(event) => {
            if (!uploadLocked && event.target.files !== null) props.onAddAttachments(Array.from(event.target.files))
            event.target.value = ''
          }} />
      </section>
      <div className={css.publishTerms} data-single={draft.expectedDeliveryDate === undefined}>
        <label className={css.field} htmlFor={`${formId}-budget`}><span>{t('communityBudget')}</span>
          <Input id={`${formId}-budget`} value={draft.publicBudget ?? ''} disabled={editingLocked} maxLength={100}
            onChange={(event) => { update({ publicBudget: event.target.value }) }} /></label>
        {draft.expectedDeliveryDate === undefined ? null : <label className={css.field} htmlFor={`${formId}-delivery`}>
          <span>{t('communityExpectedDelivery')}</span>
          <Input id={`${formId}-delivery`} type="date" value={draft.expectedDeliveryDate} disabled={editingLocked}
            onChange={(event) => { update({ expectedDeliveryDate: event.target.value }) }} /></label>}
      </div>
      {services.length === 0 ? null : <div className={css.field}>
        <span id={`${formId}-service`}>{t('communityService')}</span>
        <Menu open={serviceMenu && !editingLocked} portal selectedId={draft.serviceId}
          items={services.map(item => ({ id: item.id, label: item.label, disabled: item.disabled ?? false }))}
          onClose={() => { setServiceMenu(false) }} onSelect={(id) => { update({ serviceId: id }); setServiceMenu(false) }}
          anchor={<Button variant="outline" disabled={editingLocked} aria-labelledby={`${formId}-service ${formId}-service-value`}
            aria-haspopup="menu" aria-expanded={serviceMenu && !editingLocked} onClick={() => { setServiceMenu(value => !value) }}>
            <span id={`${formId}-service-value`}>{selected?.label ?? t('communityChooseService')}</span></Button>} />
      </div>}
      <Checkbox checked={allowPublic} disabled={editingLocked} label={t('communityPublicConsent')}
        onChange={(value) => { update({ allowPublic: value }) }} />
      <p className={css.note}>{t('communityPublicScope')}</p>
      {allowPublic ? <section className={css.preview} aria-label={t('communityPublicationPreview')}>
        <h3>{t('communityPublicationPreview')}</h3><strong>{draft.title}</strong><p className={css.brief}>{draft.brief}</p>
        {selected === undefined ? null : <p>{selected.label}</p>}
        {!draft.publicBudget?.trim() ? null : <p>{t('communityBudget')} {draft.publicBudget}</p>}
        {!draft.expectedDeliveryDate?.trim() ? null : <p>{t('communityExpectedDelivery')}
          <time dateTime={draft.expectedDeliveryDate}>{draft.expectedDeliveryDate}</time></p>}
        {attachments.length === 0 ? null : <ul>{attachments.map(item => <li key={item.id}>{item.name}</li>)}</ul>}
      </section> : null}
      <p className={css.note}>{t('communityAdminVisibility')}</p>
      {unavailableReason === null ? null : <p className={css.note}>{unavailableReason}</p>}
      {operation.state !== 'failed' ? null : <p className={css.failure} role="alert">{operation.message}</p>}
      {!unknown ? null : <p className={css.notice} role="status">{operation.message ?? t('communityPublicationUnknown')}</p>}
    </form>
  </Modal>
}
