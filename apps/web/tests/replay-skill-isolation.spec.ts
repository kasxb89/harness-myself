/** Snapshot provider boundaries through the real Loader, registry and project discovery. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { afterEach, expect, it, vi } from 'vitest'
import { registerCreationWorkflows } from '../../../packages/host/credits-index/src/creation-workflows.ts'
import * as NativeProvider from '../../../packages/experimental/computer-use-cua-driver-native/src/index.ts'
import { CuaDriver, catalog, fixture, resetFixture } from '../../../packages/experimental/computer-use-cua-driver-native/tests/fixtures/cua-driver.ts'
import { replayNativeComputerUsePatches, replaySkillPatches } from './replay-skill-isolation.ts'

// Resolve the SDK from the provider's dependency root so its dynamic import is intercepted.
vi.mock('../../../packages/experimental/computer-use-cua-driver-native/node_modules/@trycua/cua-driver/dist/index.js',
  async () => import('../../../packages/experimental/computer-use-cua-driver-native/tests/fixtures/cua-driver.ts'))

let ctx: Context | undefined
let root: string | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

it.each([false, true])('keeps project and explicit fixture skills with bundled product skills: %s', async (bundledSkills) => {
  root = await mkdtemp(join(tmpdir(), 'dsh-replay-skill-isolation-'))
  const project = join(root, 'project')
  const skillRoot = join(project, '.agents', 'skills', 'fixture-project')
  await mkdir(skillRoot, { recursive: true })
  await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: fixture-project\ndescription: A fixture-owned project skill\n---\nProject instructions.\n')
  ctx = new Context()
  await ctx.plugin(Loader)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, {
    dshHome: join(root, 'dsh'), agentsHome: join(root, 'agents'),
    bundledSkillDir: join(root, 'bundled'), watch: false,
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.skills.register({ name: 'fixture-explicit', description: 'An explicitly registered fixture skill',
    source: 'runtime', content: 'Explicit instructions.' })
  const tool = defineContentToolFixture({ name: 'fixture-credits-tool', description: 'Ordinary tool identity',
    parameters: {}, execute: async () => [] })
  ctx.tools.register(tool)
  let creditsOwner: Context | undefined
  ctx.loader.builtins['credits-guidance'] = {
    inject: ['tools'],
    apply(owner: Context) {
      creditsOwner = owner
      registerCreationWorkflows(owner)
    },
  }
  const univerEntry = { id: 'univer', name: 'dsh-univer-office', config: { tools: true, skills: true, telemetry: false } }
  const entries: EntryOptions[] = [
    { id: 'market', name: 'cordis:group', group: true, config: [
      univerEntry,
    ] },
    { id: 'credits-index', name: 'cordis:credits-guidance', isolate: { 'fixture-other': 'retained-realm' } },
  ]
  const patched = applyEntryPatches(entries, replaySkillPatches(entries, bundledSkills || undefined),
    (message) => { throw new Error(message) })
  expect(patched[0]).toEqual({ ...entries[0], config: [{ ...univerEntry,
    config: { tools: true, skills: bundledSkills, telemetry: false } }] })
  const credits = patched.find(entry => entry.id === 'credits-index')
  if (credits === undefined) throw new Error('Credits fixture entry is missing')
  expect(credits.isolate?.['fixture-other']).toBe('retained-realm')
  await ctx.loader.create(credits)
  await ctx.loader.await()
  expect(creditsOwner).toBeDefined()
  expect(creditsOwner?.tools.get(tool.name)).toBe(tool)
  const names = (await ctx.skills.list({ cwd: project })).map(skill => skill.name)
  expect(names).toEqual(bundledSkills
    ? ['fixture-explicit', 'fixture-project', 'yunshu-minimax-h3', 'yunshu-video-director']
    : ['fixture-explicit', 'fixture-project'])
  expect(creditsOwner?.get('skills') === undefined).toBe(!bundledSkills)
  expect((await ctx.skills.get('fixture-project', { cwd: project }))?.content).toBe('Project instructions.')
  expect(univerEntry.config.skills).toBe(true)
  expect(entries[1]?.isolate?.skills).toBeUndefined()
})

it('isolates only the native provider in the shipped Host rows', () => {
  const patches = [
    '../../../packages/bundle/base/cordis.patch.yml',
    '../../../packages/bundle/web-app/cordis.patch.yml',
  ].map(file => loadOverlayPatches('portable browser fixture', fileURLToPath(new URL(file, import.meta.url))))
  const entries = composeEntries(patches)
  const patched = applyEntryPatches(entries, replayNativeComputerUsePatches(),
    (message) => { throw new Error(message) })
  const native = entries.find(entry => entry.id === 'computer-use-cua-driver-native')
  expect(native).toBeDefined()
  expect(native?.disabled).not.toBe(true)
  expect(patched.find(entry => entry.id === native?.id)).toEqual({ ...native, disabled: true })
  expect(patched.filter(entry => entry.id !== native?.id)).toEqual(entries.filter(entry => entry.id !== native?.id))
  expect(applyEntryPatches(entries, replayNativeComputerUsePatches(true),
    (message) => { throw new Error(message) })).toEqual(entries)
})

it.each([
  [undefined, false],
  [true, false],
  [true, true],
] as const)('preserves other product tools with native opt-in %s and product disabled %s', async (nativeComputerUse, productDisabled) => {
  resetFixture()
  const sdk = await import('../../../packages/experimental/computer-use-cua-driver-native/node_modules/@trycua/cua-driver/dist/index.js')
  expect(sdk.CuaDriver).toBe(CuaDriver)
  ctx = new Context()
  await ctx.plugin(Loader)
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const toolNames = [
    'dsh_im_return_file', 'edit_video', 'find_dsh_plugin', 'generate_image', 'generate_video',
    'generate_video_project', 'get_creation_plan', 'ipollowork_video_validate', 'query_image_task',
    'query_video_task', 'resume_video_project', 'univer_api', 'univer_compile_svg', 'univer_execute',
    'univer_export', 'univer_import', 'univer_inspect', 'univer_lint', 'univer_new', 'univer_print_pdf',
    'univer_resources', 'univer_screenshot', 'univer_status', 'univer_unit', 'univer_worktree',
    'update_creation_plan', 'video_project_status',
  ]
  const tools = toolNames.map(name => defineContentToolFixture({
    name, description: 'Product tool retained by the portable fixture', parameters: {}, execute: async () => [],
  }))
  ctx.loader.builtins['fixture-product-tools'] = {
    inject: ['tools'],
    apply(owner: Context) { for (const tool of tools) owner.tools.register(tool) },
  }
  ctx.loader.builtins['fixture-native-provider'] = NativeProvider
  const entries: EntryOptions[] = [
    { id: 'product-tools', name: 'cordis:fixture-product-tools' },
    { id: 'computer-use-cua-driver-native', name: 'cordis:fixture-native-provider', disabled: productDisabled },
  ]
  const patched = applyEntryPatches(entries, replayNativeComputerUsePatches(nativeComputerUse),
    (message) => { throw new Error(message) })
  for (const entry of patched) await ctx.loader.create(entry)
  await ctx.loader.await()
  const nativeEnabled = nativeComputerUse === true && !productDisabled
  expect(fixture.creates).toBe(nativeEnabled ? 1 : 0)
  expect(fixture.calls).toEqual([])
  expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual([
    ...toolNames,
    ...nativeEnabled ? catalog.tools.map(tool => `cua_driver_native__${tool.name}`) : [],
  ].sort())
  for (const tool of tools) expect(ctx.tools.get(tool.name)).toBe(tool)
  const prompt = await ctx.systemPrompt.assemble({})
  expect(prompt.sections.some(section => section.name === 'computer-use:cua-driver-native')).toBe(nativeEnabled)
  expect(entries[1]?.disabled).toBe(productDisabled)
  await ctx.fiber.dispose()
  ctx = undefined
  expect(fixture.shutdowns).toBe(nativeEnabled ? 1 : 0)
  expect(fixture.destroys).toBe(nativeEnabled ? 1 : 0)
})
