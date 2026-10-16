import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { PromptAssist } from './PromptAssist.tsx'
import { en, NS, zh, type PromptAssistKey } from './locales.ts'

/** Creation context, guarded prompt replacement and operation state owned by each workspace. */
export interface PromptAssistOwner {
  readonly kind: 'image' | 'video'
  readonly prompt: string
  readonly references: readonly string[]
  readonly generation: Readonly<Record<string, string>>
  readonly disabled: boolean
  readonly signedIn: boolean
  readonly accountIdentity: string | null
  readonly onPromptChange: (next: string, expectedPrompt: string) => boolean
  readonly onBusyChange: (busy: boolean) => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'prompt-assist': PromptAssistKey
  }

  interface SlotFactoryMap {
    /** Independent prompt-writing instances in image and video workspaces. */
    'creation.prompt.assist': {
      scope: 'root'
      props: PromptAssistOwner
      locale: 'prompt-assist'
    }
  }
}

/** Required dictionary and factory registries. */
export const inject = ['slots', 'locale']

/**
 * Register an independent prompt-writing assembly for each render occurrence.
 * @param ctx - Client context supplying the dictionary and factory registries.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-prompt-assist: dictionaries')
  ctx.slots.registerFactory({ name: 'creation.prompt.assist', scope: 'root', locale: NS }, PromptAssist)
}
