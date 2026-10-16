/** Product sign-in defaults after the base and Web bundle patches compose in order. */
import { fileURLToPath } from 'node:url'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'

it('keeps product sign-in, Chat, and AI Creation defaults when bundle patches compose', () => {
  const patches = ['../../base/cordis.patch.yml', '../cordis.patch.yml'].flatMap(path =>
    loadOverlayPatches('product-account-defaults', fileURLToPath(new URL(path, import.meta.url))))
  const rows = applyEntryPatches([], patches, (message) => { throw new Error(message) })
  const entry = (id: string) => {
    const row = rows.find(candidate => candidate.id === id)
    if (row === undefined) throw new Error(`missing composed entry: ${id}`)
    return row
  }
  for (const id of ['llm-deepseek', 'llm-deepseek-account', 'ui-settings-account']) {
    expect(entry(id).disabled).toBe(true)
  }
  for (const id of ['credentials', 'credits-index', 'ui-credits', 'llm-pi-ai']) {
    expect(entry(id).disabled).not.toBe(true)
  }
  expect(entry('ui-settings-models').config).toEqual({ credentialOnboarding: false })
  expect(entry('ui-conversation').config).toEqual({
    hiddenViews: ['trajectory', 'ipollowork-video-studio'],
  })
  expect(entry('ui-videogen').disabled).not.toBe(true)
  expect(entry('ipollowork-video-studio').disabled).not.toBe(true)
})
