import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-demands/client'
import type {} from '@deepseek-ai/dsh-client-ui-credits/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createForumController } from './controller.ts'
import { ForumPage } from './ForumPage.tsx'
import { en, zh, type ForumLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Community discussions inside demand publication. */ forum: ForumLocaleKey
  }
}
/** Product login and typed slot/locale services. */
export const inject = ['slots', 'locale', 'creditsSession']
/** Forum read deadlines and visible-page refresh cadence. */
export interface Config {
  requestTimeoutMs?: number
  refreshMs?: number
}
/** Validated forum transport configuration. */
export const Config: z<Config> = z.object({
  requestTimeoutMs: z.natural().min(1000).max(300_000).default(20_000),
  refreshMs: z.natural().min(1000).max(300_000).default(15_000),
})
/** @param ctx - Existing login and UI services. @param config - Forum deadlines. */
export function apply(ctx: Context, config: Config = {}): void {
  const t = ctx.locale.bind('forum')
  ctx.effect(() => ctx.locale.register('forum', { zh, en }), 'ui-forum: dictionaries')
  const { start, ...face } = createForumController(ctx.creditsSession, Config(config) as Required<Config>, t)
  ctx.effect(() => start(), 'ui-forum: account-owned requests')
  ctx.slots.inject('demands.forum', () =>
    ctx.slots.register({ name: 'demands.forum', locale: 'forum', inject: () => face }, ForumPage),
  )
}
