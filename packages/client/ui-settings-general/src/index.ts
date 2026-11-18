/** Welcome acknowledgement stored in the plugin configuration. */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile, Context } from '@deepseek-ai/cordis'

import z from '@deepseek-ai/schemastery'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Last acknowledged welcome notice version. */
  welcomeNoticeVersion: Volatile<string | undefined>
  /** Existing section ids displayed as tabs inside another installed section. */
  sectionGroups?: Record<string, string[]>
}

/** Live welcome preference. */
export const Config = z.object({
  welcomeNoticeVersion: z.string().volatile(),
  sectionGroups: z.dict(z.array(z.string())).default({}),
})

/** The browser consumes the configuration form projection.
 * @param ctx Plugin context used for optional settings presentation.
 */
export function apply(ctx: Context, config: Config): void {
  const groups = config.sectionGroups ?? {}
  const parents = new Set(Object.keys(groups))
  const members = new Set<string>()
  for (const [parent, children] of Object.entries(groups)) {
    if (parent.trim() === '') throw new Error('settings section group ids cannot be empty')
    for (const child of children) {
      if (child.trim() === '' || parents.has(child) || members.has(child)) {
        throw new Error(`settings section group member ${JSON.stringify(child)} must belong to one unnested group`)
      }
      members.add(child)
    }
  }
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
