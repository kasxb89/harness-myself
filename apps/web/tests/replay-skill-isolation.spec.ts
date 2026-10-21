/** Snapshot provider boundaries through the real Loader, registry and project discovery. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it } from 'vitest'
import { registerCreationWorkflows } from '../../../packages/host/credits-index/src/creation-workflows.ts'
import { replaySkillPatches } from './replay-skill-isolation.ts'

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
  const entries: EntryOptions[] = [
    { id: 'market', name: 'cordis:group', group: true, config: [
      { id: 'univer', name: 'dsh-univer-office', config: { tools: true, skills: true, telemetry: false } },
    ] },
    { id: 'credits-index', name: 'cordis:credits-guidance', isolate: { 'fixture-other': 'retained-realm' } },
  ]
  const patched = applyEntryPatches(entries, replaySkillPatches(entries, bundledSkills || undefined),
    (message) => { throw new Error(message) })
  expect(patched[0]?.config[0]?.config).toEqual({ tools: true, skills: bundledSkills, telemetry: false })
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
  expect(entries[0]?.config[0]?.config.skills).toBe(true)
  expect(entries[1]?.isolate?.skills).toBeUndefined()
})
