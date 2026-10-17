/** Draft insertion outcomes remain visible if the requesting tab closes. */
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'

/** Registration-owned transient outcome, independent of tab mounts. */
export interface CreativeDraftNoticeInjected {
  readonly hooks: { readonly notice: HostObservable<{ seq: number; success: boolean } | null> }
  readonly dismiss: () => void
}

/** @param props - framework-bound notice and locale. @returns shared shell toast or no output. */
export function CreativeDraftNotice({ useNotice, dismiss, t }: InjectFace<CreativeDraftNoticeInjected> & PropsLocale<'creative'>) {
  const value = useNotice(snapshot => snapshot)
  return value === null ? null : <Toast key={value.seq} text={t(value.success ? 'draft.added' : 'draft.blocked')}
    {...value.success ? { tone: 'success' as const } : {}} onDone={dismiss} />
}
