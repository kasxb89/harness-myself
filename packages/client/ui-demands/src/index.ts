/** Public page settings are projected before browser plugins activate. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { type Config, DEMANDS_CONFIG_GLOBAL, publicDemandConfig } from './config.ts'

export { Config } from './config.ts'

/**
 * Publish only this feature's explicitly public configuration for the page.
 * @param ctx - Host lifecycle collecting structured page-bootstrap rows.
 * @param config - Validated plugin options; account credentials remain with credits-index.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const value = publicDemandConfig(config)
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: DEMANDS_CONFIG_GLOBAL, value })
  })
}
