/** SkillHub community catalog and installation responses shared by Host and browser. */

/** One community skill returned by the official SkillHub catalog. */
export interface SkillHubSkill {
  readonly slug: string
  readonly name: string
  readonly description: string
  readonly version: string
  readonly source: string
}

/** A SkillHub skill committed to the product's user skill directory. */
export interface InstalledSkill {
  readonly slug: string
  readonly name: string
  readonly version: string
  readonly installedAt?: string
}

/** Stable failures translated by the browser without exposing private CLI diagnostics. */
export type SkillHubErrorCode =
  | 'invalid-request'
  | 'cli-unavailable'
  | 'search-failed'
  | 'recommendations-failed'
  | 'install-failed'
  | 'already-installed'
  | 'installed-invalid'
  | 'busy'
  | 'cancelled'
  | 'timeout'
  | 'download-failed'
  | 'unexpected'

/** Failure response for each authenticated SkillHub operation. */
export interface SkillHubError {
  readonly ok: false
  readonly code: SkillHubErrorCode
}

/** Community catalog search or recommendation result. */
export type SkillHubSearchResponse = { readonly ok: true; readonly skills: readonly SkillHubSkill[] } | SkillHubError

/** Product-local SkillHub installation inventory. */
export type SkillHubInstalledResponse = { readonly ok: true; readonly skills: readonly InstalledSkill[] } | SkillHubError

/** Completed installation response, emitted only after the skill is available locally. */
export type SkillHubInstallResponse = { readonly ok: true; readonly skill: InstalledSkill } | SkillHubError
