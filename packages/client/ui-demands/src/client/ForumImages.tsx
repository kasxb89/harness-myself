/** Forum image presentation keeps uploads, confirmed content and explicit retry commands distinct. */
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { Button, ImageLightbox, IconCloseOutlineRegular, IconPaperclipOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { demandBytes, type DemandTranslate } from './DemandUI.tsx'
import type { ForumImageComposerView, ForumImageView } from './forum-view.ts'
import css from './ForumImages.module.css'

/**
 * Open only authorized forum image URLs; text content never becomes an image source.
 * @param props - Confirmed references and localized preview labels.
 * @returns A compact image gallery with the shared accessible lightbox.
 */
export function ForumImages({ images, t }: { images: readonly ForumImageView[]; t: DemandTranslate }): ReactNode {
  const [previewId, setPreviewId] = useState<string | null>(null)
  const close = useCallback(() => { setPreviewId(null) }, [])
  const selected = images.find(image => image.id === previewId)
  if (images.length === 0) return null
  return <div className={css.images}>
    {images.map(image => image.previewUrl === null ? <div className={css.unavailable} key={image.id}>
      <IconPaperclipOutlineRegular size={20} /><span>{image.name}</span></div>
      : <button key={image.id} type="button" className={css.preview}
        aria-label={t('previewAttachmentNamed', { name: image.name })} onClick={() => { setPreviewId(image.id) }}>
        <img src={image.previewUrl} alt={image.name} loading="lazy" decoding="async" draggable={false} />
      </button>)}
    {selected?.previewUrl ? <ImageLightbox src={selected.previewUrl} alt={selected.name}
      labels={{ dialog: t('imagePreview'), close: t('close') }} onClose={close} /> : null}
  </div>
}

/**
 * Render scoped upload status and freeze edits while the exact parent submission is sealed.
 * @param props - Actual upload state, backend-qualified limits and explicit commands.
 * @returns Selection, per-file status, image previews and explicit remove/retry controls.
 */
export function ForumImageComposer({ media, disabled, t }: {
  media: ForumImageComposerView
  disabled: boolean
  t: DemandTranslate
}): ReactNode {
  const input = useRef<HTMLInputElement>(null)
  const retryInput = useRef<HTMLInputElement>(null)
  const retryId = useRef<string | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const close = useCallback(() => { setPreviewId(null) }, [])
  const selected = media.items.find(item => item.id === previewId && item.status === 'ready')
  const qualified = media.canAdd && media.accept !== null && media.accept !== ''
    && media.maxAttachments !== null && media.maxAttachments > 0 && media.maxBytes !== null && media.maxBytes > 0
  const selectionLocked = disabled || !qualified || media.items.length >= media.maxAttachments
  return <div className={css.composer}>
    <input ref={retryInput} className={css.fileInput} type="file" accept={media.accept ?? undefined} disabled={disabled}
      aria-label={t('forumChooseOriginalImage')} onChange={(event) => {
        const id = retryId.current, file = event.target.files?.[0]
        if (!disabled && id !== null && file !== undefined) media.onRetry(id, file)
        retryId.current = null
        event.target.value = ''
      }} />
    {media.items.length === 0 ? null : <ul className={css.uploads} aria-label={t('forumImages')}>
      {media.items.map((item) => {
        const progress = item.progressPercent !== null && Number.isFinite(item.progressPercent)
          ? Math.min(100, Math.max(0, item.progressPercent)) : undefined
        return <li className={css.upload} key={item.id}>
          {item.status === 'ready' && item.previewUrl !== null
            ? <button className={css.uploadPreview} type="button"
              aria-label={t('previewAttachmentNamed', { name: item.name })} onClick={() => { setPreviewId(item.id) }}>
              <img src={item.previewUrl} alt={item.name} loading="lazy" decoding="async" draggable={false} />
            </button> : <span className={css.uploadIcon} aria-hidden="true"><IconPaperclipOutlineRegular size={20} /></span>}
          <div className={css.uploadCopy}><span className={css.fileName}>{item.name}</span>
            <span>{t(item.status === 'ready' ? 'uploadReady' : item.status === 'failed' ? 'uploadFailed' : 'uploading')}
              {item.status === 'uploading' && progress !== undefined ? ` · ${t('uploadPercent', { percent: Math.floor(progress) })}` : ''}</span>
            {item.status !== 'uploading' ? null : <progress max={100} value={progress} aria-label={item.name} />}
            {item.error === null ? null : <span className={css.error} role="status">{item.error}</span>}
          </div>
          {item.status !== 'failed' ? null : <Button variant="ghost" size="sm" disabled={disabled}
            aria-label={item.retryLabel ?? t('retryAttachment')} icon={<IconRefreshOutlineRegular size={16} />}
            onClick={() => {
              if (disabled) return
              if (item.requiresFile) { retryId.current = item.id; retryInput.current?.click() }
              else media.onRetry(item.id)
            }} />}
          <Button variant="ghost" size="sm" disabled={disabled} aria-label={t('removeAttachmentNamed', { name: item.name })}
            icon={<IconCloseOutlineRegular size={16} />} onClick={() => { if (!disabled) media.onRemove(item.id) }} />
        </li>
      })}
    </ul>}
    {!qualified ? null : <div className={css.selection}>
      <input ref={input} className={css.fileInput} type="file" multiple accept={media.accept}
        disabled={selectionLocked} aria-label={t('forumAddImages')} onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          if (!selectionLocked && files.length > 0) media.onAdd(files)
          event.target.value = ''
        }} />
      <Button variant="ghost" disabled={selectionLocked} icon={<IconPaperclipOutlineRegular size={18} />}
        onClick={() => { if (!selectionLocked) input.current?.click() }}>{t('forumAddImages')}</Button>
      <span>{t('forumImageLimits', { count: media.maxAttachments, size: demandBytes(media.maxBytes, t) })}</span>
    </div>}
    {selected?.previewUrl ? <ImageLightbox src={selected.previewUrl} alt={selected.name}
      labels={{ dialog: t('imagePreview'), close: t('close') }} onClose={close} /> : null}
  </div>
}
