/** Industry roles through the shipped declarations, Loader, prompt and tool registries. */
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Group, type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { initProfile, loadOverlayPatches, loadProfileDirectory, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { expect, it, onTestFinished } from 'vitest'
import { load } from 'js-yaml'
import StandardAgentTools from '../src/standard-agent-tools.ts'
import * as Credits from '@deepseek-ai/dsh-credits-index'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  files: string[]
  exports: Record<string, unknown>
  dsh: { bundle: { patch: string[] } }
}
const industryRows = applyEntryPatches([], loadOverlayPatches('employee-test', join(packageRoot, 'presets/industry.patch.yml')), (message) => { throw new Error(message) })
const definitions = industryRows.map(row => row.config as PresetDefinition)
const standardRows = applyEntryPatches([], loadOverlayPatches('employee-test', join(packageRoot, 'presets/standard.patch.yml')), (message) => { throw new Error(message) })
const standard = standardRows[0]?.config as PresetDefinition

/** Resolve only modules the real fixture tree requests to their workspace sources. */
function sourceModules(): Map<string, string> {
  return new Map(globSync('packages/*/*/package.json', { cwd: repositoryRoot }).map((path) => {
    const filename = join(repositoryRoot, path)
    const value = JSON.parse(readFileSync(filename, 'utf8')) as { name: string }
    return [value.name, dirname(filename)]
  }))
}

/** Boot ordinary Cordis rows from a private config outside the package directory. */
async function boot() {
  const directory = mkdtempSync(join(tmpdir(), 'yunshu-employees-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { rmSync(directory, { recursive: true, force: true }) }
  })
  const hosts = [
    'llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop',
    'token-meter', 'commands', 'goal', 'skill', 'working-directory', 'fs-local', process.platform === 'win32' ? 'pwsh-sandbox' : 'bash-sandbox', 'shell-env',
    'jobs-local', 'subagent', 'ptc-runtime-node', 'sandbox-local', 'sandbox-policy', 'subprocess-local',
    'web', 'user-questions',
  ].map(name => ({ name: `@deepseek-ai/dsh-${name}`,
    ...name === 'agent-loop' ? { config: { agents: [] } } : {},
    ...name === 'system-prompt' ? { config: { personaPrefix: 'Host default identity' } } : {},
    ...name === 'fs-local' ? { config: { cwd: directory } } : {},
  }))
  const config = join(directory, 'cordis.json')
  writeFileSync(config, JSON.stringify([
    ...hosts,
    { name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings' },
    { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
    { id: 'credits', name: '@deepseek-ai/dsh-credits-index', config: { stateDir: join(directory, 'credits') } },
    { id: 'presets', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'standard' } },
    ...standardRows, ...industryRows,
  ]))
  const sources = sourceModules()
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  ctx.loader.internal = {
    version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
      if (specifier === '@deepseek-ai/dsh-credits-index') return Credits
      if (specifier === '@deepseek-ai/dsh-web-app/standard-agent-tools') return StandardAgentTools
      const match = /^(@deepseek-ai\/[^/]+)(?:\/(.+))?$/u.exec(specifier)
      const root = match?.[1] === undefined ? undefined : sources.get(match[1])
      if (root === undefined) throw new Error(`unexpected employee fixture module ${specifier}`)
      const loaded: unknown = await import(pathToFileURL(join(root, 'src', `${match?.[2] ?? 'index'}.ts`)).href)
      return loaded
    },
  } as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(row => !row.disabled && row.fiber === undefined)).toEqual([])
  expect(ctx.get('webServer')).toBeDefined()
  const creditsEntry = [...ctx.loader.entries()].find(row => row.options.id === 'credits')
  await creditsEntry?.fiber?.await()
  expect(ctx.tools.schemas().map(row => row.name)).toContain('generate_image')
  return { ctx, directory }
}

it('ships eighteen named roles without changing the model, account, default or existing preset declarations', () => {
  expect(definitions).toHaveLength(18)
  expect(new Set(definitions.map(row => row.id)).size).toBe(18)
  expect(definitions.map(row => row.name)).toEqual([
    '通用助理', '电商运营', '营销策划', '短视频编导', '视觉设计', '客户服务', '销售顾问', '产品经理', '软件工程',
    '数据分析', '人力资源', '行政文秘', '财务助理', '教育教研', '餐饮运营', '文旅策划', '房产顾问', '企业法务',
  ])
  for (const [index, definition] of definitions.entries()) {
    expect(definition.id).toMatch(/^employee-[a-z]+(?:-[a-z]+)*$/u)
    expect(definition.order).toBe(101 + index)
    expect(definition.description).toMatch(/[\u4e00-\u9fff]/u)
    expect(definition.plugins.map(row => row.name)).toEqual(['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-web-app/standard-agent-tools'])
    expect(definition.plugins[0]?.config).toMatchObject({ complete: false, includeRuntimeContext: true })
  }
  expect(industryRows.every(row => row.name === '@deepseek-ai/dsh-agent-preset')).toBe(true)
  const shared = load(readFileSync(join(packageRoot, 'presets/standard-tools.yml'), 'utf8'), { schema: entryListSchema })
  expect(shared).toEqual(standard.plugins.filter(row => row.id !== 'persona'))
  expect(standard.plugins.some(row => row.id === 'tool-fs')).toBe(true)
  expect(standard.plugins.some(row => row.id === 'tool-bash')).toBe(true)
  execFileSync(process.execPath, [join(packageRoot, 'scripts/generate-standard-tools.mjs'), '--check'])
  expect(manifest.dsh.bundle.patch).toContain('./presets/industry.patch.yml')
  for (const file of ['presets/industry.patch.yml', 'presets/standard-tools.yml', 'lib/standard-agent-tools.js']) {
    expect(manifest.files).toContain(file)
  }
  expect(manifest.exports).toHaveProperty('./standard-agent-tools')
})

it('loads the shared tools outside the package directory, isolates each persona, and inherits native media tools', async () => {
  const { ctx, directory } = await boot()
  const roster = await ctx.agentPresets.remoteExportList()
  expect(roster.presets).toHaveLength(19)
  expect(roster.presets.filter(row => row.broken !== undefined)).toEqual([])
  expect(roster.presets.find(row => row.isDefault)?.id).toBe('standard')
  const rendered: string[] = []
  const agents: Agent[] = []
  const handles: { dispose(): Promise<void> }[] = []
  for (const definition of definitions) {
    const handle = await ctx.agents.create({
      sessionId: SessionId(definition.id), meta: { cwd: directory, agentPreset: definition.id },
      agentOptions: { provider: 'existing-provider', model: 'existing-model' },
      setup: async (owner) => { await ctx.agentPresets.mount(owner, definition.id) },
    })
    agents.push(handle.agent)
    handles.push(handle)
    const request = await ctx.systemPrompt.assemble(assembleContextFor(handle.agent))
    const persona = request.sections.filter(row => row.name === 'deployment:persona-prefix' || row.name === 'deployment:persona-suffix')
    rendered.push(`## ${definition.id}\n${persona.map(row => row.text).join('\n')}\n`)
    expect(persona.map(row => row.text).join('\n')).toContain(`你是云枢的${definition.name ?? ''}数字员工`)
    expect(persona.map(row => row.text).join('\n')).toContain('默认使用简体中文')
    const tools = ctx.tools.schemas(handle.agent).map(row => row.name)
    for (const name of ['read', 'skill', 'ask_user_question', 'generate_image', 'generate_video', 'generate_video_project', 'edit_video']) {
      expect(tools, definition.id).toContain(name)
    }
    expect(request.sections.some(row => row.name !== 'deployment:persona-prefix' && row.name !== 'deployment:persona-suffix')).toBe(true)
  }
  const first = agents[0]
  const second = agents[1]
  if (first === undefined || second === undefined) throw new Error('missing employee agents')
  const firstText = (await ctx.systemPrompt.assemble(assembleContextFor(first))).sections.map(row => row.text).join('\n')
  expect(firstText).not.toContain('你是云枢的电商运营数字员工')
  expect(first.session.header.cwd).toBe(directory)
  expect(first.options).toMatchObject({ provider: 'existing-provider', model: 'existing-model' })
  expect(first.session.header.agentPreset).toBe('employee-general-assistant')
  expect(await ctx.agentPresets.select(first, 'employee-visual-designer')).toBe('employee-visual-designer')
  expect(ctx.agentPresets.composedPreset(second.ctx)).toBe('employee-ecommerce-operations')
  expect(first.options).toMatchObject({ provider: 'existing-provider', model: 'existing-model' })
  first.session.append('turn/start', { turn: 1 })
  await expect(ctx.agentPresets.select(first, 'employee-sales-consultant')).rejects.toMatchObject({ code: 'agent-preset/locked' })
  const nativeTools = ctx.tools.schemas(first).filter(row => ['generate_image', 'generate_video', 'generate_video_project', 'edit_video'].includes(row.name))
  await expect(JSON.stringify(nativeTools, null, 2) + '\n').toMatchFileSnapshot('./expected/industry-native-media-tools.expected.json')
  expect((await ctx.skills.get('yunshu-video-director'))?.content).toContain('generate_video_project')
  expect(ctx.agentPresets.inspectCompositions().every(row => row.leakedServices.length === 0)).toBe(true)
  await expect(rendered.join('\n').trimEnd() + '\n').toMatchFileSnapshot('./expected/industry-personas.expected.md')
  const document = await ctx.agentPresets.readDocument('standard')
  expect(document.content).toContain('id: tool-fs')
  expect(document.content).toContain('id: tool-bash')
  for (const handle of handles) await handle.dispose()
  const entries = [...ctx.loader.entries()].filter(row => row.options.id?.startsWith('preset-employee-'))
  for (const entry of entries) await entry.fiber?.dispose()
  expect((await ctx.agentPresets.list()).map(row => row.id)).toEqual(['standard'])
})

it('adds industry declarations to existing Web profiles without rewriting the user layer or its default', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yunshu-employee-profile-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  initProfile(directory, PROFILE_TEMPLATES.web?.bundles ?? [])
  const userPatch = '- id: agent-preset-registry\n  config:\n    default: standard\n    selectedDefault: cordis\n'
  const patch = join(directory, 'cordis.patch.yml')
  writeFileSync(patch, userPatch)
  const before = readFileSync(join(directory, 'package.json'), 'utf8')
  initProfile(directory, PROFILE_TEMPLATES.web?.bundles ?? [])
  const profile = loadProfileDirectory('employee-test', directory, join(repositoryRoot, 'apps/cli/package.json'))
  const patches = [...profile.layers.flatMap(row => row.patches), ...profile.patches]
  const rows = applyEntryPatches([], patches, (message) => { throw new Error(message) })
  expect(rows.filter(row => row.id?.startsWith('preset-employee-'))).toHaveLength(18)
  expect(rows.find(row => row.id === 'agent-preset-registry')?.config).toEqual({ default: 'standard', selectedDefault: 'cordis' })
  expect(readFileSync(patch, 'utf8')).toBe(userPatch)
  expect(readFileSync(join(directory, 'package.json'), 'utf8')).toBe(before)
})
