/** Shared administrator-published creation content for browser workspaces. */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../index.ts'
import type { CreationContentCatalog } from './types.ts'
import { Catalog } from './catalog.ts'

export { Config } from '../index.ts'

export type { CreationContent, CreationContentCatalog, CreationContentSnapshot, CreationCategory, CreationPreset, CreationTemplate, LocalizedText, ModeContent } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Latest public creation document, shared across creation workspaces. */
    creationContent: CreationContentCatalog
  }
}

/**
 * Provide one publication reader and dispose its polling with the plugin.
 * @param ctx Client plugin context.
 * @param config Validated read intervals.
 */
export function apply(ctx: Context, config: Config): void {
  const catalog = new Catalog(config, (error) => { ctx.logger.warn('Creation publication read failed: %s', error instanceof Error ? error.message : String(error)) })
  ctx.provide('creationContent', catalog)
  ctx.effect(() => {
    const refresh = (): void => { if (document.visibilityState !== 'hidden') void catalog.refresh() }
    const interval = setInterval(refresh, config.refreshIntervalMs)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    refresh()
    return async () => {
      clearInterval(interval)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      await catalog.dispose()
    }
  }, 'creation-content: published content refresh')
}
