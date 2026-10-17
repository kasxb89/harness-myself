/** Operation feedback lives in the shell so changing panels does not dismiss it. */
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, PropsHooks } from '@deepseek-ai/dsh-client-ui-slots'

/** One localized operation outcome; no paths or Host exception diagnostics are retained. */
export interface ArtifactNotice { seq: number; text: string; success: boolean }

/** Framework-bound notice source and its owner-provided dismissal. */
export interface ArtifactNoticeInjected {
  hooks: { notice: HostObservable<ArtifactNotice | null> }
  dismiss: () => void
}

/** Render a single operation outcome independently of the artifacts page lifetime. */
export function OperationToast({ useNotice, dismiss }: Omit<ArtifactNoticeInjected, 'hooks'> & PropsHooks<ArtifactNoticeInjected['hooks']>) {
  const notice = useNotice(value => value)
  if (notice === null) return null
  return <Toast key={notice.seq} text={notice.text} {...notice.success ? { tone: 'success' } : {}}
    icon={<IconWarningOutlineRegular />} holdMs={6000} onDone={dismiss} />
}
