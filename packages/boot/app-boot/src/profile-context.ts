/** Launcher-owned profile locations and composition inputs. */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { composeEntries, loadProfileDirectory, PROFILE_PATCH_FILENAME, type Profile } from './profile.ts'
import { loadOptionalPatches } from './index.ts'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

/** Application-owned package manager executable; environment applies only to package operations. */
export interface ProfilePnpmInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** Current profile facts; scheduling and mutation belong to their callers. */
export interface ProfileContext {
  readonly name: string
  /** Packaged applications supply their bundled runtime instead of a PATH executable. */
  readonly packageManager?: ProfilePnpmInvocation
  readonly dir: string
  readonly patchPath: string
  readonly installAnchor: string
  readonly cwd: string
  readonly home: string
  /** Bundle packages used to start this process, before any persisted edits. */
  readonly startedBundles: readonly string[]
  /** Parsed command-line overlays, applied above profile and home patches. */
  readonly overlays: readonly PatchOptions[]
  /** Launch-time DSH_TELEMETRY_DISABLED value; any non-empty value opts out. */
  readonly telemetryDisabledEnv: string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present only in a profile launched by dsh. */
    profileContext: ProfileContext
  }
}

const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** Read the employee target only when the composed tree gives its id one owner. */
function composedEmployeeName(patches: PatchOptions[]): string | undefined {
  const names: string[] = []
  const visit = (entries: EntryOptions[]): void => {
    for (const entry of entries) {
      if (entry.id === 'custom-mode') names.push(entry.name)
      if (entry.group && Array.isArray(entry.config)) visit(entry.config as EntryOptions[])
    }
  }
  visit(composeEntries([patches]))
  return names.length === 1 ? names[0] : undefined
}

/** Recognize only the bundled employee editor's self-relative entry. */
function bundledEmployeeEntry(profile: Profile): string | undefined {
  const layer = profile.layers.find(candidate => candidate.packageName === 'dsh-custom-mode')
  if (layer === undefined) return undefined
  const name = pathToFileURL(join(layer.packageDir, 'index.mjs')).href
  if (!layer.patches.some(patch => patch.id === undefined && patch.insert?.some(entry =>
    entry.id === 'custom-mode' && entry.name === name))) return undefined
  return composedEmployeeName(profile.layers.flatMap(candidate => candidate.patches)) === name ? name : undefined
}

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without the telemetry row
 * exports nothing, so the switch is then trivially satisfied and no patch is
 * generated — custom profiles need not mount telemetry to run with the
 * switch set.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/** Read current bundle and user layers with the launch-time overlays.
 * Preserve legacy employee name assertions only for the exact self-relative bundled entry.
 * @param binName Diagnostic prefix for malformed or missing configuration.
 * @param context Data supplied by the profile launcher.
 * @param initialProfile Already loaded startup profile; omitted reads the current files.
 * @returns Detached ordered patches; this function does not update the Loader.
 */
export function readProfilePatches(binName: string, context: ProfileContext, initialProfile?: Profile): PatchOptions[] {
  const profile = initialProfile ?? loadProfileDirectory(binName, context.dir, context.installAnchor, { userLayer: false })
  const userPatches = structuredClone([
    ...(initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? []),
    ...(loadOptionalPatches(binName, join(context.home, PROFILE_PATCH_FILENAME)) ?? []),
    ...context.overlays,
  ])
  const patches = structuredClone(profile.layers.flatMap(layer => layer.patches))
  const employeeEntry = bundledEmployeeEntry(profile)
  for (const patch of userPatches) {
    // Preserve the old assertion only while preceding layers still target the exact bundled entry.
    if (employeeEntry !== undefined && patch.insert === undefined && patch.id === 'custom-mode'
      && patch.name === 'dsh-custom-mode' && composedEmployeeName(patches) === employeeEntry) {
      patch.name = employeeEntry
    }
    patches.push(patch)
  }
  const telemetryPatch = resolveTelemetryPatch(context.telemetryDisabledEnv,
    composeEntries([patches]).some(row => row.id === TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) patches.push(telemetryPatch)
  return patches
}
