/** Two explicit capacity preferences; blank fields continue following the platform. */
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SettingsModelCatalog.module.css'

/** The only user-owned fields the capacity form changes. */
export type CapacityField = 'contextWindow' | 'maxTokens'

/** Pure form inputs; the owning catalog retains drafts while its rows reload. */
export interface CapacityEditorProps extends PropsLocale<'model'> {
  open: boolean
  model: string
  values: Record<CapacityField, string>
  maxima: Partial<Record<CapacityField, number>>
  busy: boolean
  disabled: boolean
  invalid: boolean
  error: string | undefined
  onChange: (field: CapacityField, value: string) => void
  onSave: () => void
  onReset: () => void
  onClose: () => void
}

/**
 * Render the shared modal over the model directory without owning any external state.
 * @param props - draft fields, current platform bounds and the owner's commands.
 * @returns the parameter dialog.
 */
export function CapacityEditor({
  open, model, values, maxima, busy, disabled, invalid, error, onChange, onSave, onReset, onClose, t,
}: CapacityEditorProps) {
  return <Modal open={open} onClose={busy ? () => {} : onClose}
    title={t('capacity.title')} description={model} closeLabel={t('capacity.close')}
    footer={<div className={css.editorActions}>
      <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={onReset}>{t('capacity.reset')}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={onClose}>{t('capacity.cancel')}</Button>
      <Button size="sm" variant="primary" disabled={disabled || busy || invalid} onClick={onSave}>
        {t(busy ? 'capacity.saving' : 'capacity.save')}
      </Button>
    </div>}>
    <div className={css.editorFields}>
      {(['contextWindow', 'maxTokens'] as const).map((field, index) => {
        const maximum = maxima[field]
        return <label key={field} className={css.editorField}>
          <span>{t(field === 'contextWindow' ? 'capacity.contextWindow' : 'capacity.maxTokens')}</span>
          <Input value={values[field]} inputMode="numeric" disabled={disabled || busy}
            aria-label={t(field === 'contextWindow' ? 'capacity.contextWindow' : 'capacity.maxTokens')}
            data-modal-autofocus={index === 0 ? true : undefined}
            placeholder={t('capacity.followPlatform')}
            onChange={(event) => { onChange(field, event.target.value) }} />
          <span className={css.limit}>{maximum === undefined ? t('capacity.unreported')
            : t('capacity.platformMax', { tokens: maximum })}</span>
        </label>
      })}
      {error === undefined ? null : <p role="alert" className={css.notice}>{error}</p>}
    </div>
  </Modal>
}
