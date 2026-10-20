/** Bundled Standard tool composition shared by industry employee presets. */
import type { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'

/** Load the package-owned tools beside either the source or published entry. */
export default class StandardAgentTools extends Include {
  /**
   * @param ctx - the preset scope that owns the shared tool subtree.
   */
  constructor(ctx: Context) {
    super(ctx, { path: new URL('../presets/standard-tools.yml', import.meta.url).href })
  }
}
