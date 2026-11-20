/** Authorized media previews and upload feedback, without reading file contents in React. */
import { useCallback, useState, type ReactNode } from 'react'
import {
  Button, ImageLightbox, Tooltip, IconDownloadOutlineRegular, IconPaperclipOutlineRegular,
  IconRefreshOutlineRegular, IconCloseOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DemandAttachment } from './types.ts'
import { demandBytes, type DemandTranslate } from './DemandUI.tsx'
import css from './DemandPage.module.css'

/**
 * Preview confirmed media using current authorization URLs; downloads are owner-authorized.
 * @param props - Authorized attachment metadata, download command and localized labels.
 * @returns Media previews and the selected image lightbox, or null for an empty list.
 */
export function DemandAttachments(props: {
  attachments: readonly DemandAttachment[]
  download: (id: string) => void
  t: DemandTranslate
}): ReactNode {
  const { attachments, download, t } = props
  const [previewId, setPreviewId] = useState<string | null>(null)
  const closePreview = useCallback(() => { setPreviewId(null) }, [])
  const preview = attachments.find(attachment => attachment.id === previewId)
  if (attachments.length === 0) return null
  return <div className={css.attachments}>
    {attachments.map(attachment => <div key={attachment.id} className={css.mediaAttachment}>
      {attachment.kind === 'image' && attachment.previewUrl ? <button type="button" className={css.imagePreview}
        aria-label={t('previewAttachmentNamed', { name: attachment.name })} onClick={() => { setPreviewId(attachment.id) }}>
        <img src={attachment.previewUrl} alt={attachment.name} loading="lazy" draggable={false} />
      </button> : attachment.kind === 'video' && attachment.previewUrl
        ? <video className={css.videoPreview} src={attachment.previewUrl} controls preload="metadata" aria-label={attachment.name} />
        : <div className={css.filePreview} aria-hidden="true"><IconPaperclipOutlineRegular size={22} /></div>}
      <div className={css.attachmentMeta}>
        <span><span className={css.fileName}>{attachment.name}</span><small>{demandBytes(attachment.sizeBytes, t)}</small></span>
        <Tooltip label={t('downloadAttachmentNamed', { name: attachment.name })}>
          <Button size="sm" variant="ghost" disabled={attachment.status !== 'ready'}
            aria-label={t('downloadAttachmentNamed', { name: attachment.name })}
            onClick={() => { download(attachment.id) }} icon={<IconDownloadOutlineRegular size={16} />} />
        </Tooltip>
      </div>
    </div>)}
    {preview?.previewUrl ? <ImageLightbox src={preview.previewUrl} alt={preview.name}
      labels={{ dialog: t('imagePreview'), close: t('close') }} onClose={closePreview} /> : null}
  </div>
}

/**
 * Keep staged uploads distinct from confirmed messages and freeze pending operations.
 * @param props - Upload metadata, allowed commands, lock state and localized labels.
 * @returns Per-file progress and actions, or null for an empty list.
 */
export function DemandUploads(props: {
  attachments: readonly DemandAttachment[]
  remove: (id: string) => void
  retry: (id: string) => void
  disabled?: boolean
  t: DemandTranslate
}): ReactNode {
  const { attachments, remove, retry, disabled = false, t } = props
  const [previewId, setPreviewId] = useState<string | null>(null)
  const closePreview = useCallback(() => { setPreviewId(null) }, [])
  const preview = attachments.find(attachment => attachment.id === previewId && attachment.status === 'ready')
  if (attachments.length === 0) return null
  return <><ul className={css.uploads}>
    {attachments.map((attachment) => {
      const progress = typeof attachment.progressPercent === 'number' && Number.isFinite(attachment.progressPercent)
        ? Math.min(100, Math.max(0, attachment.progressPercent)) : undefined
      return <li key={attachment.id} className={css.upload} data-state={attachment.status}>
        {attachment.status === 'ready' && attachment.previewUrl && attachment.kind === 'image'
          ? <button type="button" className={css.uploadPreview} aria-label={t('previewAttachmentNamed', { name: attachment.name })}
            onClick={() => { setPreviewId(attachment.id) }}>
            <img src={attachment.previewUrl} alt={attachment.name} loading="lazy" decoding="async" draggable={false} />
          </button>
          : attachment.status === 'ready' && attachment.previewUrl && attachment.kind === 'video'
            ? <video className={css.uploadVideo} src={attachment.previewUrl} aria-label={attachment.name}
              controls playsInline preload="metadata" />
            : <span className={css.uploadIcon} aria-hidden="true"><IconPaperclipOutlineRegular size={18} /></span>}
        <div className={css.uploadCopy}>
          <span className={css.fileName}>{attachment.name}</span>
          <span className={css.uploadState}>
            {attachment.status === 'ready' ? t('uploadReady') : attachment.status === 'failed' ? t('uploadFailed') : t('uploading')}
            {attachment.status !== 'uploading' || progress === undefined ? null : <span>{t('uploadPercent', { percent: Math.floor(progress) })}</span>}
          </span>
          {attachment.status === 'uploading' ? <progress max={100} value={progress} aria-label={attachment.name} /> : null}
          {attachment.status !== 'failed' || !attachment.error ? null : <span className={css.errorCopy}>{attachment.error}</span>}
        </div>
        {attachment.status !== 'failed' ? null : <Tooltip label={t('retryAttachment')}>
          <Button variant="ghost" size="sm" disabled={disabled} aria-label={t('retryAttachment')}
            onClick={() => { retry(attachment.id) }} icon={<IconRefreshOutlineRegular size={16} />} />
        </Tooltip>}
        <Tooltip label={t('removeAttachmentNamed', { name: attachment.name })}>
          <Button variant="ghost" size="sm" disabled={disabled} aria-label={t('removeAttachmentNamed', { name: attachment.name })}
            onClick={() => { remove(attachment.id) }} icon={<IconCloseOutlineRegular size={16} />} />
        </Tooltip>
      </li>
    })}
  </ul>
  {preview?.kind === 'image' && preview.previewUrl ? <ImageLightbox src={preview.previewUrl} alt={preview.name}
    labels={{ dialog: t('imagePreview'), close: t('close') }} onClose={closePreview} /> : null}
  </>
}
