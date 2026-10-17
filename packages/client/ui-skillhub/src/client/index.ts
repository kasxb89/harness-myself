/** Native SkillHub catalog page and its sidebar entry. */
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-skill/client'
import { SkillHubPage, type SkillHubInjected } from './SkillHubPage.tsx'
import { SkillHubPanelIcon } from './SkillHubPanelIcon.tsx'
import { installSkill, readInstalledSkills, readRecommendedSkills, searchSkills } from './api.ts'
import { en, NS, zh, type SkillHubKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Community skill store copy. */
    skillhub: SkillHubKey
  }
}

const PANEL_ID = 'skillhub' as MainPanelId

/** Slot and dictionary registries used by this browser plugin. */
export const inject = ['slots', 'locale']

/**
 * Register the product skill store without installing a skill during activation.
 * @param ctx - Browser plugin context whose fiber owns all registrations.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-skillhub: dictionaries')
  const face: SkillHubInjected = {
    readRecommendations: readRecommendedSkills,
    search: searchSkills,
    readInstalled: readInstalledSkills,
    install: async (slug, signal) => {
      const result = await installSkill(slug, signal)
      if (result.ok) ctx.emit('skills/catalog-invalidated')
      return result
    },
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: NS, inject: () => face,
  }, SkillHubPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 45, label: () => t('panel'), locale: NS,
  }, SkillHubPanelIcon))
}
