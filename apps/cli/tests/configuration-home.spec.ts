/** Application configuration isolation uses the real Loader without moving product data. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initProfile, loadProfileDirectory, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import ConfigEditor from '../../../packages/boot/config-editor/src/index.ts'
import Settings from '../../../packages/settings/settings/src/index.ts'
import DefaultModel from '../../../packages/core/agent-default-model/src/index.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { runProfile } from '../src/profile-boot.ts'
import { collectConfigDumpLayers } from '../src/dump-config.ts'

// The real Loader mounts the fixture's declared entries; source imports avoid
// requiring a prior build of every package in an otherwise source-based suite.
vi.mock('@deepseek-ai/dsh-app-boot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-app-boot')>()
  return { ...actual, boot: (async (name, root, patches, setup) => actual.boot(name, root, patches, async (ctx) => {
    await setup?.(ctx)
    Object.assign(ctx.loader.builtins, { fixtureEditor: ConfigEditor, fixtureSettings: Settings, fixtureModel: DefaultModel })
  })) satisfies typeof actual.boot }
})

afterEach(() => { vi.unstubAllEnvs() })

it('boots product configuration while account and storage files stay in the existing data home', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yunshu-configuration-home-'))
  const dataHome = join(root, 'data')
  const configurationHome = join(dataHome, 'products', 'yunshu')
  const profileDir = join(configurationHome, 'profiles', 'desktop')
  const account = join(dataHome, 'plugin-data', 'credits', 'session.json')
  const history = join(dataHome, 'sessions', 'original.txt')
  const rootPatch = '- id: agent-default-model\n  config: { provider: foreign, model: root-override }\n'
  const rootLegacy = 'agent-default-model:\n  provider: foreign\n  model: legacy-override\n'
  const oldExitCode = process.exitCode
  const listeners = {
    SIGTERM: new Set(process.listeners('SIGTERM')),
    SIGINT: new Set(process.listeners('SIGINT')),
    unhandledRejection: new Set(process.listeners('unhandledRejection')),
    uncaughtException: new Set(process.listeners('uncaughtException')),
  }
  let shutdown: Awaited<ReturnType<typeof runProfile>>['shutdown'] | undefined
  try {
    mkdirSync(join(dataHome, 'plugin-data', 'credits'), { recursive: true })
    mkdirSync(join(dataHome, 'sessions'))
    writeFileSync(account, '{"token":"synthetic-kept-token","relay":{"key":"synthetic-kept-relay"}}\n')
    writeFileSync(history, 'synthetic existing chat\n')
    writeFileSync(join(dataHome, 'cordis.patch.yml'), rootPatch)
    writeFileSync(join(dataHome, 'settings.yaml'), rootLegacy)
    vi.stubEnv('DSH_HOME', dataHome)
    initProfile(profileDir, ['configuration-isolation-fixture'])
    const bundle = join(profileDir, 'node_modules', 'configuration-isolation-fixture')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({
      name: 'configuration-isolation-fixture', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'config-editor', name: 'cordis:fixtureEditor' },
      { id: 'settings', name: 'cordis:fixtureSettings' },
      { id: 'agent-default-model', name: 'cordis:fixtureModel', config: { provider: 'yunshu-local', model: 'yunshu-flash' } },
    ] }]))
    const installAnchor = fileURLToPath(new URL('../package.json', import.meta.url))
    const profile = loadProfileDirectory('configuration isolation', profileDir, installAnchor)
    const application = await runProfile({
      environment: createLaunchEnvironmentSnapshot([]), profile: 'desktop',
      configurationHome, resolvedProfile: { profile, installAnchor }, patchFiles: [], args: [],
    })
    shutdown = application.shutdown
    const { ctx } = application
    await ctx.loader.await()
    await vi.waitFor(() => { expect(ctx.settings.describe().some(row => row.ns === 'agent-default-model')).toBe(true) })
    expect(ctx.profileContext).toMatchObject({ name: 'desktop', home: configurationHome, dir: profileDir })
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'yunshu-local', model: 'yunshu-flash' })
    expect(readProfilePatches('configuration isolation', ctx.profileContext)).not.toContainEqual({ id: 'agent-default-model', config: { provider: 'foreign', model: 'root-override' } })
    expect(process.env.DSH_HOME).toBe(dataHome)
    expect(readFileSync(account, 'utf8')).toBe('{"token":"synthetic-kept-token","relay":{"key":"synthetic-kept-relay"}}\n')
    expect(readFileSync(history, 'utf8')).toBe('synthetic existing chat\n')
    expect(readFileSync(join(dataHome, 'cordis.patch.yml'), 'utf8')).toBe(rootPatch)
    expect(readFileSync(join(dataHome, 'settings.yaml'), 'utf8')).toBe(rootLegacy)
    expect(existsSync(join(dataHome, 'settings.yaml.imported'))).toBe(false)

    const productPatch = '- id: agent-default-model\n  config: { provider: yunshu-local, model: product-home-choice }\n'
    writeFileSync(join(configurationHome, 'cordis.patch.yml'), productPatch)
    const dumpLayers = collectConfigDumpLayers(profile, false, [], configurationHome)
    expect(dumpLayers.at(-1)?.label).toBe(join(configurationHome, 'cordis.patch.yml'))
    expect(JSON.stringify(dumpLayers)).not.toContain('root-override')
    expect(readProfilePatches('configuration isolation', ctx.profileContext).at(-1)).toEqual({
      id: 'agent-default-model', config: { provider: 'yunshu-local', model: 'product-home-choice' },
    })
  } finally {
    await shutdown?.shutdown(0)
    for (const listener of process.listeners('SIGTERM')) {
      if (!listeners.SIGTERM.has(listener)) process.removeListener('SIGTERM', listener)
    }
    for (const listener of process.listeners('SIGINT')) {
      if (!listeners.SIGINT.has(listener)) process.removeListener('SIGINT', listener)
    }
    for (const listener of process.listeners('unhandledRejection')) {
      if (!listeners.unhandledRejection.has(listener)) process.removeListener('unhandledRejection', listener)
    }
    for (const listener of process.listeners('uncaughtException')) {
      if (!listeners.uncaughtException.has(listener)) process.removeListener('uncaughtException', listener)
    }
    process.exitCode = oldExitCode
    rmSync(root, { recursive: true, force: true })
  }
})
