/** Custom employees through the real editor, Loader, prompt assembly and relay adapter. */
import { cpSync, globSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Group, type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, createRuntimeResolution, initProfile, loadOverlayPatches, loadProfileDirectory, PluginPackages, readProfileManifest, readProfilePatches, writeProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { expect, it, onTestFinished, vi } from 'vitest'
import { closeMockServers, mockServer, textEvents } from '../../../llm/llm-pi-ai/tests/mock-server.ts'
import { provideSessionRelayFixture } from './fixtures/session-relay.ts'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const customRoot = dirname(createRequire(join(repositoryRoot, 'apps/cli/package.json')).resolve('dsh-custom-mode/package.json'))
const presetRoot = join(customRoot, 'preset')

interface CreatedAssistant { ok: boolean; id: string }

/** Boot source modules through an ordinary config file; only the upstream/account are fixtures. */
async function boot(directory: string, relayUrl: string, legacyEntry = false): Promise<Context> {
  const ctx = new Context()
  provideSessionRelayFixture(ctx)
  onTestFinished(() => ctx.fiber.dispose())
  const hosts = [
    'llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop',
    'token-meter', 'commands', 'goal', 'skill', 'working-directory', 'fs-local',
    process.platform === 'win32' ? 'pwsh-sandbox' : 'bash-sandbox', 'shell-env',
    'jobs-local', 'subagent', 'ptc-runtime-node', 'sandbox-local', 'sandbox-policy', 'subprocess-local',
    'web', 'user-questions',
  ].map(name => ({ name: `@deepseek-ai/dsh-${name}`,
    ...name === 'agent-loop' ? { config: { agents: [] } } : {},
    ...name === 'system-prompt' ? { config: { personaPrefix: 'Host default {{model}}' } } : {},
    ...name === 'fs-local' ? { config: { cwd: directory } } : {},
  }))
  const standard = applyEntryPatches([], loadOverlayPatches('custom-employee-test', join(packageRoot, 'presets/standard.patch.yml')), (message) => { throw new Error(message) })
  const installAnchor = join(repositoryRoot, 'apps/cli/package.json')
  const profileDir = join(directory, 'profiles', 'desktop')
  initProfile(profileDir, ['dsh-custom-mode'])
  const previousPackage = join(profileDir, 'node_modules', 'dsh-custom-mode')
  cpSync(customRoot, previousPackage, { recursive: true })
  const previousReader = join(previousPackage, 'preset', 'prompt-reader.mjs')
  const reader = readFileSync(previousReader, 'utf8')
    .replace("const DEFAULT_SUFFIX = ''", "const DEFAULT_SUFFIX = 'Your working directory is {{cwd}}.'")
    .replace(/  \/\/ Old user-owned prompts[\s\S]*?\n  \}\)\n\n/u, '')
  expect(reader).not.toContain("systemPrompt.variable('cwd'")
  expect(reader).toContain("const DEFAULT_SUFFIX = 'Your working directory is {{cwd}}.'")
  writeFileSync(previousReader, reader)
  const manifest = readProfileManifest('test', profileDir)
  writeProfileManifest(profileDir, { ...manifest, dependencies: { 'dsh-custom-mode': '2.2.5' } })
  const profile = loadProfileDirectory('test', profileDir, installAnchor)
  const profileContext = { name: 'desktop', dir: profileDir, patchPath: profile.patchPath, installAnchor,
    cwd: directory, home: directory, startedBundles: ['dsh-custom-mode'], overlays: [], telemetryDisabledEnv: undefined }
  const employeeRows = composeEntries([readProfilePatches('test', profileContext, profile)])
  const employeeEntry = employeeRows.find(row => row.id === 'custom-mode')?.name
  expect(employeeEntry?.startsWith('file:')).toBe(true)
  if (employeeEntry === undefined) throw new Error('The bundled employee entry is missing')
  expect(realpathSync(fileURLToPath(employeeEntry))).toBe(realpathSync(join(customRoot, 'index.mjs')))
  const config = join(profileDir, 'cordis.json')
  writeFileSync(config, JSON.stringify([
    ...hosts,
    { name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings' },
    { name: '@deepseek-ai/dsh-credentials-local', config: { dshHome: directory, watch: false } },
    { name: '@deepseek-ai/dsh-client-connection' },
    { name: 'fixture:account' },
    { name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { 'yunshu-local': {
      api: 'openai-completions', baseURL: relayUrl, apiKeyEnv: 'YUNSHU_RELAY_TOKEN', models: [{ id: 'deepseek-flash' }],
    } } } },
    { name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'standard' } },
    ...standard,
    ...legacyEntry ? [{ id: 'custom-mode', name: 'dsh-custom-mode' }] : employeeRows,
  ]))
  const sources = new Map(globSync('packages/*/*/package.json', { cwd: repositoryRoot }).map((path) => {
    const filename = join(repositoryRoot, path)
    return [(JSON.parse(readFileSync(filename, 'utf8')) as { name: string }).name, dirname(filename)]
  }))
  ctx.baseUrl = pathToFileURL(profileDir).href + '/'
  await ctx.plugin(Loader)
  await ctx.plugin(PluginPackages, { resolution: await createRuntimeResolution({ installAnchor, profile, home: directory }) })
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  ctx.loader.internal = {
    version: 'v2', async import(...[specifier, parent]: Parameters<ModuleLoaderV2['import']>) {
      if (specifier === 'fixture:account') return { apply(owner: Context) {
        owner.provide('harnessAccount', {
          provider: 'yunshu-local', refreshModels: async () => ['deepseek-flash'],
          resolveRelayKey: async (baseURL: string) => baseURL === relayUrl ? 'sk-employee-fixture-account' : undefined,
        })
      } }
      if (specifier === 'dsh-custom-mode') {
        const resolved = createRequire(parent).resolve(specifier)
        expect(realpathSync(resolved)).toBe(realpathSync(join(previousPackage, 'index.mjs')))
        const loaded: unknown = await import(pathToFileURL(resolved).href)
        return loaded
      }
      if (specifier.startsWith('file:')) {
        const loaded: unknown = await import(specifier)
        return loaded
      }
      const match = /^(@deepseek-ai\/[^/]+)(?:\/(.+))?$/u.exec(specifier)
      const root = match?.[1] === undefined ? undefined : sources.get(match[1])
      if (root === undefined) throw new Error(`unexpected custom employee module ${specifier}`)
      const loaded: unknown = await import(pathToFileURL(join(root, 'src', `${match?.[2] ?? 'index'}.ts`)).href)
      return loaded
    },
  } as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(row => !row.disabled && row.fiber === undefined)
    .map(row => ({ id: row.id, name: row.options.name }))).toEqual([])
  const standardExport = (await ctx.agentPresets.remoteExportList()).presets.find(row => row.id === 'standard')
  expect(standardExport).toBeDefined()
  expect(standardExport?.broken).toBeUndefined()
  return ctx
}

it('reproduces the old bare entry selecting an installed market copy before the bundled employee fix', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yunshu-old-employee-profile-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs() })
  onTestFinished(closeMockServers)
  vi.stubEnv('DSH_HOME', directory)
  vi.stubEnv('DSH_PRESET_PATCH_DIR', join(packageRoot, 'presets'))
  const relay = await mockServer([{ events: textEvents }])
  const ctx = await boot(directory, relay.url, true)
  const handler = (ctx.connection as HostConnectionService).createSharedFetchHandler('/api')
  const response = await handler.fetch(new Request('http://127.0.0.1/api/custom-mode/create', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Existing market employee' }),
  }))
  expect(response.status).toBe(200)
  const created = await response.json() as CreatedAssistant
  const reader = readFileSync(join(directory, '.agent-presets', created.id, 'prompt-reader.mjs'), 'utf8')
  expect(reader).toContain("const DEFAULT_SUFFIX = 'Your working directory is {{cwd}}.'")
  const handle = await ctx.agents.create({ sessionId: SessionId('old-market-employee'),
    meta: { cwd: directory, agentPreset: created.id }, agentOptions: { provider: 'yunshu-local', model: 'deepseek-flash' },
    setup: async (owner) => { await ctx.agentPresets.mount(owner, created.id) },
  })
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Synthetic request' }], source: { kind: 'user' } }))
  await handle.agent.whenIdle()
  const ended = handle.agent.session.snapshotEvents().at(-1)
  if (ended?.type !== 'turn/end' || ended.data.reason.kind !== 'error') throw new Error('The legacy employee did not reproduce its prompt failure')
  expect(ended.data.reason.error.message).toContain('unknown prompt variable "{{cwd}}"')
  expect(relay.requests).toHaveLength(0)
})

it('runs new and upgraded employees twice with the same account/model and preserves authored files', { timeout: 60_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yunshu-custom-employees-'))
  // Cleanup registration precedes every allocation; the Host is disposed first.
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs() })
  onTestFinished(closeMockServers)
  vi.stubEnv('DSH_HOME', directory)
  vi.stubEnv('DSH_PRESET_PATCH_DIR', join(packageRoot, 'presets'))
  vi.stubEnv('YUNSHU_RELAY_TOKEN', 'wrong-ambient-key')

  const legacyDir = join(directory, '.agent-presets', 'legacy-employee')
  mkdirSync(legacyDir, { recursive: true })
  const legacyPrompt = 'Existing authored role. Model {{model}}, provider {{provider}}, directory {{cwd}}.\n'
  const legacyMeta = 'name: Existing employee\ndescription: Preserved personal instructions\norder: 9\n'
  const legacyComposition = [
    '- id: persona', "  name: './prompt-reader.mjs'", '  config:', '    complete: false',
    '- id: custom-prompt-tool', "  name: './prompt-tool.mjs'", '',
  ].join('\n')
  writeFileSync(join(legacyDir, 'prompt.md'), legacyPrompt)
  writeFileSync(join(legacyDir, 'prompt.starter.md'), legacyPrompt)
  writeFileSync(join(legacyDir, 'preset.yml'), legacyMeta)
  writeFileSync(join(legacyDir, 'agent.cordis.yml'), legacyComposition)
  writeFileSync(join(legacyDir, 'prompt-reader.mjs'), 'export function apply() { throw new Error("old copied module") }\n')
  writeFileSync(join(legacyDir, 'prompt-tool.mjs'), 'export function apply() { throw new Error("old copied module") }\n')

  const relay = await mockServer(Array.from({ length: 8 }, () => ({ events: textEvents })))
  const ctx = await boot(directory, relay.url)
  const handler = (ctx.connection as HostConnectionService).createSharedFetchHandler('/api')
  const call = async (path: string, data?: object): Promise<Response> => await handler.fetch(new Request(`http://127.0.0.1/api/custom-mode${path}`, {
    ...(data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }),
  }))
  expect((await call('')).ok).toBe(true)
  const brokenModule = join(directory, 'old-suffix.mjs')
  writeFileSync(brokenModule, [
    "export const inject = ['systemPrompt']",
    'export function apply(ctx) {',
    '  ctx.effect(() => ctx.systemPrompt.section({',
    "    name: 'deployment:persona-suffix', order: 10200, text: 'Your working directory is {{cwd}}.',",
    '  }))',
    '}', '',
  ].join('\n'))
  await ctx.agentPresets.register({ id: 'old-suffix-control', plugins: [{ name: pathToFileURL(brokenModule).href }] })
  const control = await ctx.agents.create({ sessionId: SessionId('old-suffix-control'), meta: { cwd: directory },
    agentOptions: { provider: 'yunshu-local', model: 'deepseek-flash' }, setup: async (owner) => { await ctx.agentPresets.mount(owner, 'old-suffix-control') },
  })
  control.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Local negative control' }], source: { kind: 'user' } }))
  await control.agent.whenIdle()
  const failed = control.agent.session.snapshotEvents().at(-1)
  expect(failed?.type === 'turn/end' && failed.data.reason).toMatchInlineSnapshot(`
    {
      "error": {
        "code": "UNKNOWN",
        "message": "unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"; registered variables: provider, model",
      },
      "kind": "error",
    }
  `)
  expect(control.agent.session.snapshotEvents().some(event => event.type === 'request/header')).toBe(false)
  expect(relay.requests).toHaveLength(0)
  for (const filename of ['prompt-reader.mjs', 'prompt-tool.mjs']) {
    expect(readFileSync(join(legacyDir, filename), 'utf8')).toBe(readFileSync(join(presetRoot, filename), 'utf8'))
  }
  expect(readFileSync(join(legacyDir, 'prompt.md'), 'utf8')).toBe(legacyPrompt)
  expect(readFileSync(join(legacyDir, 'prompt.starter.md'), 'utf8')).toBe(legacyPrompt)
  expect(readFileSync(join(legacyDir, 'preset.yml'), 'utf8')).toBe(legacyMeta)
  expect(readFileSync(join(legacyDir, 'agent.cordis.yml'), 'utf8')).toBe(legacyComposition)

  const created: string[] = []
  for (const name of ['Writing assistant', 'Cost engineer']) {
    const response = await call('/create', { name })
    expect(response.status).toBe(200)
    const result = await response.json() as CreatedAssistant
    expect(result.ok).toBe(true)
    created.push(result.id)
    expect(readFileSync(join(directory, '.agent-presets', result.id, 'prompt.md'), 'utf8')).not.toContain('{{cwd}}')
  }
  const first = created[0]
  if (first === undefined) throw new Error('employee was not created')
  const saved = await call('/state', { id: first, mode: 'standard', overrides: {}, name: 'Writing assistant',
    prompt: 'You write clear Chinese. Keep the role for {{model}}. Legacy directory {{cwd}}.', description: '' })
  expect(saved.status).toBe(200)
  const duplicateResponse = await call('/create', { name: 'Copied writer', from: first })
  expect(duplicateResponse.status).toBe(200)
  const duplicate = await duplicateResponse.json() as CreatedAssistant
  expect(duplicate.ok).toBe(true)
  created.push(duplicate.id)

  const agents: Agent[] = []
  for (const id of [...created, 'legacy-employee']) {
    const handle = await ctx.agents.create({ sessionId: SessionId(`employee-${id}`),
      meta: { cwd: directory, agentPreset: id }, agentOptions: { provider: 'yunshu-local', model: 'deepseek-flash' },
      setup: async (owner) => { await ctx.agentPresets.mount(owner, id) },
    })
    agents.push(handle.agent)
    for (const text of ['First request', 'Second request']) {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      expect(handle.agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
      expect(handle.agent.session.deriveMessages().at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'hello' }] })
    }
    expect(handle.agent.options).toMatchObject({ provider: 'yunshu-local', model: 'deepseek-flash' })
    expect(ctx.tools.schemas(handle.agent).map(tool => tool.name)).toContain('custom_prompt')
  }
  expect(relay.requests).toHaveLength(8)
  expect(relay.headers.every(headers => headers.authorization === 'Bearer sk-employee-fixture-account')).toBe(true)
  expect(relay.requests.every(request => request !== null && typeof request === 'object' && 'model' in request && request.model === 'deepseek-flash')).toBe(true)
  expect(JSON.stringify(relay.requests)).not.toContain('{{cwd}}')
  const legacy = agents.at(-1)
  if (legacy === undefined) throw new Error('legacy employee was not mounted')
  const moved = join(directory, 'moved-workspace')
  mkdirSync(moved)
  await ctx.workingDirectory.set(legacy, moved)
  const assembly = await ctx.systemPrompt.assemble(assembleContextFor(legacy))
  expect(renderPrompt(assembly)).toContain(moved)
  expect(assembly.contexts.find(row => row.name === 'working-directory:current')?.text).toContain(moved)
  rmSync(moved, { recursive: true })
  const recovered = await ctx.systemPrompt.assemble(assembleContextFor(legacy))
  expect(recovered.variables['cwd']).toBe(realpathSync(directory))
  expect(renderPrompt(recovered)).not.toContain(moved)
  const standard = await ctx.agents.create({ sessionId: SessionId('standard-control'), meta: { cwd: directory },
    agentOptions: { provider: 'yunshu-local', model: 'deepseek-flash' }, setup: async (owner) => { await ctx.agentPresets.mount(owner, 'standard') },
  })
  expect((await ctx.systemPrompt.assemble(assembleContextFor(standard.agent))).variables).not.toHaveProperty('cwd')
  expect((await ctx.agentPresets.remoteExportList()).presets.find(row => row.isDefault)?.id).toBe('standard')
  expect(readFileSync(join(legacyDir, 'prompt.md'), 'utf8')).toBe(legacyPrompt)
})
