/** Public entry patches keeping snapshot catalogs owned by their fixture. */
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

function findEntry(entries: readonly EntryOptions[], id: string): EntryOptions | undefined {
  for (const entry of entries) {
    if (entry.id === id) return entry
    if (entry.group && Array.isArray(entry.config)) {
      const nested = findEntry(entry.config, id)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * Keep product-provided catalogs out of ordinary recordings and replays.
 * Filesystem roots alone cannot constrain providers registered in the Host's
 * shared skill registry. Explicit product-catalog scenarios retain both.
 * @param entries - already composed product and scenario rows.
 * @param bundledSkills - opt into the product's bundled skill providers.
 * @returns test-only Loader patches; product bundle defaults stay unchanged.
 */
export function replaySkillPatches(entries: readonly EntryOptions[], bundledSkills = false): PatchOptions[] {
  if (bundledSkills) return []
  const univerConfig: unknown = findEntry(entries, 'univer')?.config
  if (univerConfig != null && (typeof univerConfig !== 'object' || Array.isArray(univerConfig))) {
    throw new Error('snapshot Univer configuration must be an object')
  }
  return [
    { id: 'univer', config: { ...univerConfig, skills: false } },
    // Credits reads skills only in its optional directing-guidance injection.
    // Its routes and tools retain their ordinary service identities.
    { id: 'credits-index', isolate: { ...findEntry(entries, 'credits-index')?.isolate, skills: true } },
  ]
}
