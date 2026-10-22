/** Product sign-in defaults after the base and Web bundle patches compose in order. */
import { fileURLToPath } from 'node:url'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'

it('keeps product sign-in, Chat, and AI Creation defaults when bundle patches compose', () => {
  const patches = ['../../base/cordis.patch.yml', '../cordis.patch.yml'].flatMap(path =>
    loadOverlayPatches('product-account-defaults', fileURLToPath(new URL(path, import.meta.url))))
  const rows = applyEntryPatches([], patches, (message) => { throw new Error(message) })
  const flatten = (entries: EntryOptions[]): EntryOptions[] => entries.flatMap(row =>
    row.group && Array.isArray(row.config) ? [row, ...flatten(row.config as EntryOptions[])] : [row])
  const entries = flatten(rows)
  const entry = (id: string) => {
    const row = entries.find(candidate => candidate.id === id)
    if (row === undefined) throw new Error(`missing composed entry: ${id}`)
    return row
  }
  expect(entry('system-prompt').config).toHaveProperty(
    'personaPrefix', expect.stringContaining('默认使用简体中文与用户沟通'),
  )
  for (const id of ['llm-deepseek', 'llm-deepseek-account', 'ui-settings-account']) {
    expect(entry(id).disabled).toBe(true)
  }
  for (const id of ['credentials', 'credits-index', 'ui-credits', 'llm-pi-ai']) {
    expect(entry(id).disabled).not.toBe(true)
  }
  expect(entry('ui-settings-models').config).toEqual({ credentialOnboarding: false })
  expect(entry('credits-index').config).toMatchObject({
    baseUrl: '', bridgeBaseUrl: '', newApiBaseUrl: 'https://8.133.202.230/harness',
  })
  expect(entry('llm-pi-ai').config).toEqual({
    providers: {
      'yunshu-local': {
        displayName: '云枢', api: 'openai-completions', baseURL: 'https://8.133.202.230/harness/v1',
        apiKeyEnv: 'YUNSHU_RELAY_TOKEN', models: [{ id: 'deepseek-v4-flash' }],
        compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
      },
    },
  })
  expect(entry('agent-default-model').config).toEqual({ provider: 'yunshu-local', model: 'deepseek-v4-flash', followPolicy: true })
  for (const id of ['dsh-market', 'dsh-skin-market']) {
    expect(entry(id).config).toMatchObject({ githubProxy: 'https://8.216.52.27/github-relay' })
  }
  expect(entry('plugin-manager').config).toMatchObject({ githubProxy: 'https://8.216.52.27:8443' })
  expect(entry('ui-conversation').config).toEqual({
    hiddenViews: ['trajectory', 'ipollowork-video-studio'],
  })
  expect(entry('ui-videogen').disabled).not.toBe(true)
  expect(entry('ipollowork-video-studio').disabled).not.toBe(true)
})
