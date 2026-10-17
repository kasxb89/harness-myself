/** Creation guidance assembled by the real Loader and Web runtime. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished } from 'vitest'
import * as WebApp from '../src/index.ts'

it('assembles clarification and structured media planning guidance and removes it when the Web entry unloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-workspace-clarification-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    { id: 'system-prompt', name: 'system-prompt', config: { personaPrefix: '' } },
    { id: 'webserver', name: 'webserver', config: { host: '127.0.0.1', port: 0 } },
    {
      id: 'web-app', name: 'web-app',
      config: { openBrowser: false, printUrl: false, surfaceContext: true, publicUrl: 'https://product.example/workspace/' },
    },
  ]))
  const modules = new Map<string, unknown>([
    ['system-prompt', SystemPrompt], ['webserver', WebServer], ['web-app', WebApp],
  ])
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
      if (!modules.has(specifier)) throw new Error(`unexpected clarification fixture module: ${specifier}`)
      return modules.get(specifier)
    },
  } as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'web-app')
  if (entry?.fiber === undefined) throw new Error('Web runtime did not mount')
  await entry.fiber.await()
  expect(ctx.webServer.port).toBeGreaterThan(0)

  const sections = (await ctx.systemPrompt.assemble()).sections
  const text = sections.find(section => section.name === 'app:web-surface')?.text
  if (text === undefined) throw new Error('workspace question policy is missing from the assembled model prompt')
  await expect(text + '\n').toMatchFileSnapshot('./expected/workspace-clarification-prompt.expected.md')
  expect(text).toContain('use ask_user_question to show the structured question card')
  expect(text).toContain('“做个网站”')
  expect(text).toContain('site\'s purpose, visual style, and main content or functionality')
  expect(text).toContain('“做个40秒视频”, retain the stated 40-second duration')
  expect(text).toContain('clarify only missing subject, visual style, or aspect ratio')
  expect(text).toContain('without repeating the questionnaire')
  expect(text).toContain('if they ask only to review the guidance or postpone creation, keep that limit after they answer')
  expect(text).toContain('“你定”, “直接做”')
  expect(text).toContain('When the request is already specific, proceed directly')
  expect(text).toContain('Before generating images or videos, call update_creation_plan')
  expect(text).toContain('Keep a simple single image to a short brief and one shot')
  expect(text).toContain('appearance, clothing, personality and voice')
  expect(text).toContain('source_path_or_asset_id (empty for a planned asset, a real source for an existing one)')
  expect(text).toContain('camera, scene, action, character_ids, asset_ids')
  expect(text).toContain('dialogue string')
  expect(text).toContain('subtitles string')
  expect(text).toContain('Pass the returned plan_id and the matching shot_id')
  expect(text).toContain('call generate_image with plan_id and asset_id instead; never pass both asset_id and shot_id')
  expect(text).toContain('A video plan may first generate character reference images')
  expect(text).toContain('characters[].reference_asset_ids')
  expect(text).toContain('ordered shot_ids and shot_prompts aligned one-to-one')
  expect(text).toContain('Use the original plan_id')
  expect(text).toContain('First call get_creation_plan with that plan_id to read the complete current plan')
  expect(text).toContain('preserving unrelated content and existing execution associations')
  expect(text).toContain('Never associate work by guessing the latest task')
  expect(text).toContain('real inputs supported by reference_images and the selected model')
  expect(text).toContain('Speech, lip-sync and subtitle settings are requirements awaiting verification')
  expect(text).toContain('Saved files alone do not establish that those requirements are met')
  expect(text).toContain('Read the returned job_id through job_output for real progress')
  expect(text).toContain('present the saved final_path only after completion')

  await entry.fiber.dispose()
  expect((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'app:web-surface')).toBe(false)
})

it('ships the question-card UI and model question tool for every creation-capable preset', () => {
  const files = [
    '../../base/cordis.patch.yml', '../cordis.patch.yml',
    '../presets/standard.patch.yml', '../presets/ptc.patch.yml', '../presets/cordis.patch.yml',
  ]
  const patches = files.flatMap(path => loadOverlayPatches('workspace-clarification', fileURLToPath(new URL(path, import.meta.url))))
  const rows = applyEntryPatches([], patches, (message) => { throw new Error(message) })
  for (const id of ['user-questions', 'ui-user-questions']) {
    const row = rows.find(candidate => candidate.id === id)
    expect(row, `${id} must be available to render and answer model questions`).toBeDefined()
    expect(row?.disabled).not.toBe(true)
  }
  for (const id of ['standard', 'ptc', 'cordis']) {
    const preset = rows.find(candidate => candidate.id === `preset-${id}`)
    const config = preset?.config as { plugins?: { id?: string; name?: string; disabled?: boolean }[] } | undefined
    const tool = config?.plugins?.find(plugin => plugin.id === 'tool-ask-user')
    expect(tool?.name).toBe('@deepseek-ai/dsh-tool-ask-user')
    expect(tool?.disabled).not.toBe(true)
  }
})
