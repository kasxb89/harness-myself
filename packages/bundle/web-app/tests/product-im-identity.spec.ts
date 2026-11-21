/** Product identities assembled through Loader, real presets and live Agent scopes. */
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Group, type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { expect, it, onTestFinished } from 'vitest'
import { provideSessionRelayFixture } from './fixtures/session-relay.ts'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/** Load the shipping product prompt and complete presets without starting an IM transport or inference. */
async function boot(directory: string): Promise<Context> {
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { rmSync(directory, { recursive: true, force: true }) }
  })
  const rows = applyEntryPatches([], [
    ...loadOverlayPatches('product-im-identity', join(packageRoot, '../base/cordis.patch.yml')),
    ...loadOverlayPatches('product-im-identity', join(packageRoot, 'cordis.patch.yml')),
    ...loadOverlayPatches('product-im-identity', join(packageRoot, 'presets/standard.patch.yml')),
    ...loadOverlayPatches('product-im-identity', join(packageRoot, 'presets/ptc.patch.yml')),
  ], (message) => { throw new Error(message) })
  const systemPrompt = rows.find(row => row.id === 'system-prompt')
  if (systemPrompt === undefined) throw new Error('The product system-prompt row is missing')
  const hosts = [
    'llm', 'session', 'session-projection', 'tools', 'agent', 'agent-loop',
    'token-meter', 'commands', 'goal', 'skill', 'working-directory', 'fs-local',
    process.platform === 'win32' ? 'pwsh-sandbox' : 'bash-sandbox', 'shell-env',
    'jobs-local', 'subagent', 'ptc-runtime-node', 'sandbox-local', 'sandbox-policy',
    'subprocess-local', 'web', 'user-questions',
  ].map(name => ({ name: `@deepseek-ai/dsh-${name}`,
    ...name === 'agent-loop' ? { config: { agents: [] } } : {},
    ...name === 'fs-local' ? { config: { cwd: directory } } : {},
  }))
  const configPath = join(directory, 'cordis.yml')
  writeFileSync(configPath, JSON.stringify([
    ...hosts,
    systemPrompt,
    { name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings' },
    { name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'standard' } },
    ...rows.filter(row => row.id === 'preset-standard' || row.id === 'preset-ptc'),
    {
      id: 'preset-authored', name: '@deepseek-ai/dsh-agent-preset', config: {
        id: 'authored', plugins: [{ name: '@deepseek-ai/dsh-persona', config: {
          prefix: 'You are Maple, the customer\'s travel assistant, powered by {{model}}.',
          suffix: 'Keep the customer-authored role and its instructions.',
        } }],
      },
    },
  ]))
  const sources = new Map(globSync('packages/*/*/package.json', { cwd: repositoryRoot }).map((path) => {
    const filename = join(repositoryRoot, path)
    return [(JSON.parse(readFileSync(filename, 'utf8')) as { name: string }).name, dirname(filename)]
  }))
  provideSessionRelayFixture(ctx)
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  ctx.loader.internal = {
    version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
      const match = /^(@deepseek-ai\/[^/]+)(?:\/(.+))?$/u.exec(specifier)
      const root = match?.[1] === undefined ? undefined : sources.get(match[1])
      if (root === undefined) throw new Error(`Unexpected product identity module: ${specifier}`)
      const loaded: unknown = await import(pathToFileURL(join(root, 'src', `${match?.[2] ?? 'index'}.ts`)).href)
      return loaded
    },
  } as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(row => !row.disabled && row.fiber === undefined)
    .map(row => ({ id: row.id, name: row.options.name }))).toEqual([])
  return ctx
}

/** Inspect the actual model-visible identity after scoped preset shadowing and variable interpolation. */
async function identity(ctx: Context, agent: Agent): Promise<{ prefix: string | undefined; suffix: string | undefined }> {
  const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
  const text = renderPrompt(assembly)
  expect(assembly.variables.model).toBe('yunshu-flash')
  expect(assembly.sections.some(section => section.name === 'harness:identity')).toBe(false)
  expect(text).not.toContain('You are an AI agent powered by DeepSeek Harness.')
  expect(text).not.toContain('You are a coding agent powered by')
  const prefix = assembly.sections.find(section => section.name === 'deployment:persona-prefix')
  const suffix = assembly.sections.find(section => section.name === 'deployment:persona-suffix')
  return {
    prefix: prefix === undefined ? undefined : renderPrompt({ ...assembly, sections: [prefix] }),
    suffix: suffix === undefined ? undefined : renderPrompt({ ...assembly, sections: [suffix] }),
  }
}

// Complete shipping presets import their real capability graph, matching the employee composition suite's budget.
it('uses the Yunshu identity in shared product agents while preserving an authored custom preset', { timeout: 60_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yunshu-im-identity-'))
  const ctx = await boot(directory)
  const identities: Record<string, Awaited<ReturnType<typeof identity>>> = {}
  for (const preset of [undefined, 'standard', 'ptc', 'authored']) {
    const handle = await ctx.agents.create({
      sessionId: SessionId(`product-im-identity-${preset ?? 'fallback'}`),
      meta: { cwd: directory, ...preset === undefined ? {} : { agentPreset: preset } },
      agentOptions: { provider: 'keyless-identity', model: 'yunshu-flash' },
      ...preset === undefined ? {} : { setup: async (owner: Context) => { await ctx.agentPresets.mount(owner, preset) } },
    })
    identities[preset ?? 'fallback'] = await identity(ctx, handle.agent)
  }
  expect(identities).toMatchInlineSnapshot(`
    {
      "authored": {
        "prefix": "You are Maple, the customer's travel assistant, powered by yunshu-flash.",
        "suffix": "Keep the customer-authored role and its instructions.",
      },
      "fallback": {
        "prefix": "You are the Yunshu assistant (云枢助手), powered by the yunshu-flash model. 默认使用简体中文与用户沟通，包括回复、进度和工具调用说明；用户明确指定其他输出语言时遵从。 用户可见的创作要求、人物设定、素材说明、分镜、场景、运镜、动作和生成提示词同样遵从这个语言，接口字段名与协议标记保持原样。",
        "suffix": "",
      },
      "ptc": {
        "prefix": "You are the Yunshu assistant (云枢助手), powered by the yunshu-flash model.",
        "suffix": "",
      },
      "standard": {
        "prefix": "You are the Yunshu assistant (云枢助手), powered by the yunshu-flash model.",
        "suffix": "",
      },
    }
  `)
})
