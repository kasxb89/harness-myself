/** Source-chat action whose loading and errors belong to one selected file. */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ArtifactEntry, ArtifactsInjected } from './ArtifactsPage.tsx'
import type { ArtifactOrigin, ArtifactResult } from './api.ts'
import css from './ArtifactPreview.module.css'

/**
 * Resolve the selected file's exact recorded source before offering navigation.
 * @param props - Selected file, cancellable source read and shell-owned navigation action.
 * @returns A back-to-chat button or an explicit source-unavailable state.
 */
export function ArtifactChatLink({ entry, readOrigin, returnToChat, t }: {
  entry: ArtifactEntry
} & Pick<ArtifactsInjected, 'readOrigin' | 'returnToChat' | 't'>) {
  const [result, setResult] = useState<ArtifactResult<ArtifactOrigin | null> | null>(null)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setResult(null)
    void readOrigin(entry, controller.signal).then((value) => { if (!controller.signal.aborted) setResult(value) })
    return () => { controller.abort() }
  }, [entry.path, entry.workspaceId, entry.size, entry.mtimeMs, readOrigin, revision])
  if (result === null) return null
  if (!result.ok) return <span className={css.originStatus} role="status">
    {t('preview.originError')}
    <Button size="sm" variant="ghost" onClick={() => { setRevision(value => value + 1) }}>{t('retry')}</Button>
  </span>
  if (result.value === null) return <span className={css.originStatus}>{t('preview.originUnavailable')}</span>
  return <Button size="sm" disabled={busy} onClick={() => {
    setBusy(true)
    void returnToChat(entry).finally(() => { setBusy(false) })
  }}>{t('preview.backToChat')}</Button>
}
