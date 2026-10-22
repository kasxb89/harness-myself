/** Loader-backed permission selection from the actual product profile layers. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dump } from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, loadProfileDirectory, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import PermissionPresets from '@deepseek-ai/dsh-permission-presets'
import { expect } from 'vitest'
import { createPluginProfile } from '../src/project-manager.ts'

/**
 * Mount production permission rows without unrelated product services.
 * @param ctx - Caller-owned context; dispose after reading its permissions.
 * @param directory - Caller-owned private root for this profile and Loader file.
 * @param options - Surface identity and optional persisted user default.
 */
export async function mountPermissionProfile(
  ctx: Context,
  directory: string,
  options: { profile?: string; savedDefault?: string } = {},
): Promise<void> {
  const profileDir = join(directory, 'profiles', options.profile ?? 'desktop')
  createPluginProfile(profileDir)
  if (options.savedDefault !== undefined) {
    await writeFile(join(profileDir, 'cordis.patch.yml'), dump([
      { id: 'permission', config: { defaultPreset: options.savedDefault } },
    ]))
  }
  const installAnchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
  const profile = loadProfileDirectory('dsh desktop', profileDir, installAnchor)
  const profileContext = {
    name: options.profile ?? 'desktop', dir: profileDir, patchPath: profile.patchPath,
    installAnchor, cwd: directory, home: directory,
    startedBundles: profile.layers.map(layer => layer.packageName),
    overlays: [], telemetryDisabledEnv: undefined,
  }
  ctx.provide('profileContext', profileContext)
  const warnings: string[] = []
  const rows = composeEntries([readProfilePatches('dsh desktop', profileContext, profile)], message => warnings.push(message))
  expect(warnings).toEqual([])
  // Other product services are unnecessary here; their permission consumers
  // receive the same session facts from these unchanged production rows.
  const entries = ['sandbox-policy', 'approval', 'permission'].map((id) => {
    const row = rows.find(row => row.id === id)
    expect(row).toBeDefined()
    return { ...row, name: `cordis:${id}` }
  })
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, dump([
    { name: 'cordis:sessions' }, { name: 'cordis:projections' }, ...entries,
  ], { schema: entryListSchema }))
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  ctx.provide('shell', {
    get sandboxMode() { return ctx.sandboxPolicy.defaultMode },
    resolve() { throw new Error('permission-defaults does not execute shell commands') },
    run() { throw new Error('permission-defaults does not execute shell commands') },
    start() { throw new Error('permission-defaults does not execute shell commands') },
  })
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, sessions: SessionStore, projections: SessionProjectionRegistry,
    'sandbox-policy': SandboxPolicy, approval: ApprovalService, permission: PermissionPresets,
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
}
