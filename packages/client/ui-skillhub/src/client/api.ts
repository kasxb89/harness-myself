/** Same-origin, cancellable requests to the authenticated SkillHub Host routes. */
import { SKILLHUB_INSTALL_PATH, SKILLHUB_INSTALLED_PATH, SKILLHUB_SEARCH_PATH } from '../paths.ts'
import type {
  InstalledSkill, SkillHubError, SkillHubErrorCode, SkillHubInstallResponse,
  SkillHubInstalledResponse, SkillHubSearchResponse, SkillHubSkill,
} from '../types.ts'

const ERROR_CODES: readonly SkillHubErrorCode[] = [
  'invalid-request', 'cli-unavailable', 'search-failed', 'install-failed', 'already-installed',
  'installed-invalid', 'busy', 'cancelled', 'timeout', 'download-failed', 'unexpected',
]

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function installedSkill(value: unknown): value is InstalledSkill {
  return record(value) && typeof value.slug === 'string' && value.slug.length > 0
    && typeof value.name === 'string' && typeof value.version === 'string'
    && (value.installedAt === undefined || typeof value.installedAt === 'string')
}

function catalogSkill(value: unknown): value is SkillHubSkill {
  return installedSkill(value) && record(value) && typeof value.description === 'string' && typeof value.source === 'string'
}

function failure(value: Record<string, unknown>): SkillHubError | undefined {
  if (value.ok !== false) return undefined
  const code = ERROR_CODES.find(code => code === value.code)
  return { ok: false, code: code ?? 'unexpected' }
}

async function request<T>(
  path: string, signal: AbortSignal,
  parse: (value: Record<string, unknown>) => T | undefined,
  payload?: { slug: string },
): Promise<T | SkillHubError> {
  try {
    signal.throwIfAborted()
    const response = await fetch(new Request(new URL(path, window.location.href), {
      method: payload === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: payload === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      signal,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }))
    const value: unknown = await response.json()
    signal.throwIfAborted()
    if (!record(value)) return { ok: false, code: 'unexpected' }
    const error = failure(value)
    if (error !== undefined) return error
    if (!response.ok) return { ok: false, code: 'unexpected' }
    return parse(value) ?? { ok: false, code: 'unexpected' }
  } catch (_error) {
    // Transport and decoding errors stay on the panel; private diagnostics never become product copy.
    return { ok: false, code: signal.aborted ? 'cancelled' : 'unexpected' }
  }
}

/**
 * Search the community catalog only for an explicitly submitted nonempty query.
 * @param query - User-entered skill name or purpose.
 * @param signal - Search lifetime, cancelled when superseded or unmounted.
 * @returns Validated catalog results or a localized failure code.
 */
export function searchSkills(query: string, signal: AbortSignal): Promise<SkillHubSearchResponse> {
  if (query.trim() === '') return Promise.resolve({ ok: false, code: 'invalid-request' })
  return request(`${SKILLHUB_SEARCH_PATH}?${new URLSearchParams({ q: query.trim() })}`, signal, value =>
    value.ok === true && Array.isArray(value.skills) && value.skills.every(catalogSkill)
      ? { ok: true as const, skills: value.skills } : undefined)
}

/**
 * Read the locally installed SkillHub inventory without installing anything.
 * @param signal - Panel or explicit refresh lifetime.
 * @returns Validated installed skills or a localized failure code.
 */
export function readInstalledSkills(signal: AbortSignal): Promise<SkillHubInstalledResponse> {
  return request(SKILLHUB_INSTALLED_PATH, signal, value =>
    value.ok === true && Array.isArray(value.skills) && value.skills.every(installedSkill)
      ? { ok: true as const, skills: value.skills } : undefined)
}

/**
 * Install the explicitly selected slug without requesting an overwrite.
 * @param slug - Canonical community skill identity returned by search.
 * @param signal - Installation request lifetime.
 * @returns The committed installation or a localized failure code.
 */
export function installSkill(slug: string, signal: AbortSignal): Promise<SkillHubInstallResponse> {
  return request(SKILLHUB_INSTALL_PATH, signal, value =>
    value.ok === true && installedSkill(value.skill) && value.skill.slug === slug
      ? { ok: true as const, skill: value.skill } : undefined, { slug })
}
