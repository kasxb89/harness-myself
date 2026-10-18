/** Product-owned lifecycle and storage for the official SkillHub community CLI. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-skill-filesystem'
import type { InstalledSkill, SkillHubErrorCode, SkillHubSkill } from './types.ts'
import { ensureSkillHubCli } from './skillhub-cache.ts'
import { normalizeSkillHubMetadata } from './skillhub-metadata.ts'

/** Execution budgets resolved once at plugin activation. */
export interface SkillHubExecutionConfig {
  /** Python executable; Desktop supplies its verified bundled interpreter. @default python3 */
  readonly pythonExecutable: string
  /** Complete request deadline in milliseconds. @default 120000 */
  readonly timeoutMs: number
  /** Managed subprocess termination grace in milliseconds. @default 1000 */
  readonly terminationGraceMs: number
  /** Maximum retained stdout and stderr bytes per stream. @default 1048576 */
  readonly maxOutputBytes: number
  /** Maximum official CLI archive bytes accepted for download. @default 1048576 */
  readonly maxDownloadBytes: number
  /** Maximum community skills returned per search or recommendation read. @default 20 */
  readonly searchLimit: number
  /** Official search and recommendation network deadline in milliseconds. @default 15000 */
  readonly searchTimeoutMs: number
}

/** Stable failure carried to localized browser presentation. */
export class SkillHubFailure extends Error {
  /** @param code - Browser-visible failure identity. @param options - Internal diagnostic cause. */
  constructor(readonly code: SkillHubErrorCode, options?: ErrorOptions) {
    super(`skillhub: ${code}`, options)
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Accept one public community coordinate and reject paths, versions, and CLI flags.
 * @param value - Untrusted request or registry coordinate.
 * @returns Whether the coordinate is one slug or a namespace-qualified slug.
 */
export function isSkillHubSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200
    && /^(?:@[a-z0-9][a-z0-9_-]*\/)?[a-z0-9][a-z0-9_-]*$/u.test(value)
}

/**
 * Map a canonical coordinate to one portable direct child of the product skill root.
 * @param slug - Validated public community coordinate.
 * @returns Collision-resistant directory name independent of namespace separators.
 */
export function skillHubStorageName(slug: string): string {
  return `skillhub-${createHash('sha256').update(slug).digest('hex')}`
}

const LOCK = '.skills_store_lock.json'
const ADAPTER = `import sys
sys.path.insert(0, sys.argv[1])
import skills_store_cli as cli
cli.DEFAULT_CLI_HOME = sys.argv[2]
original_search = cli.fetch_remote_search_results
def strict_search(*args, **kwargs):
    result = original_search(*args, **kwargs)
    if result is None:
        raise SystemExit(42)
    return result
cli.fetch_remote_search_results = strict_search
sys.argv = [cli.__file__, *sys.argv[3:]]
cli.main()
`

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function readLock(root: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(join(root, LOCK), 'utf8'))
    if (!record(value) || value.version !== 1 || !record(value.skills)) throw new SkillHubFailure('installed-invalid')
    return value.skills
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

async function verifyTree(root: string): Promise<void> {
  if (!(await lstat(root)).isDirectory()) throw new SkillHubFailure('installed-invalid')
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new SkillHubFailure('installed-invalid')
    if (entry.isDirectory()) await verifyTree(join(root, entry.name))
  }
}

function skillFromLock(slug: string, value: unknown): InstalledSkill {
  if (!isSkillHubSlug(slug) || !record(value) || typeof value.name !== 'string' || typeof value.version !== 'string'
    || (value.installedAt !== undefined && typeof value.installedAt !== 'string')) throw new SkillHubFailure('installed-invalid')
  return { slug, name: value.name, version: value.version,
    ...(value.installedAt === undefined ? {} : { installedAt: value.installedAt }) }
}

async function waitForSetup<T>(setup: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const abort = (): void => { cancelled.reject(new SkillHubFailure('cancelled')) }
  signal.addEventListener('abort', abort, { once: true })
  try { return await Promise.race([setup, cancelled.promise]) }
  finally { signal.removeEventListener('abort', abort) }
}

/** Owns requests, isolated CLI state, and one-at-a-time installation commits. */
export class SkillHubClient {
  private readonly controller = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private preparation: Promise<string> | undefined
  private installing = false

  /**
   * @param ctx - Host subprocess capability.
   * @param config - Explicit execution budgets.
   * @param cacheRoot - Product CLI state.
   * @param skillsRoot - Product user skills directory.
   */
  constructor(private readonly ctx: Context, private readonly config: SkillHubExecutionConfig,
    private readonly cacheRoot: string, private readonly skillsRoot: string) {}

  /** Cancel requests and wait until their subprocesses and cleanup have settled. */
  async dispose(): Promise<void> {
    this.controller.abort()
    await Promise.allSettled([...this.pending, ...(this.preparation === undefined ? [] : [this.preparation])])
  }

  /**
   * Run a request within its deadline and retain it until lifecycle cleanup settles.
   * @param requestSignal - Disconnected browser request.
   * @param action - Operation receiving its complete lifetime signal.
   * @returns The settled operation result.
   */
  run<T>(requestSignal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const deadline = new AbortController()
    const timer = setTimeout(() => { deadline.abort() }, this.config.timeoutMs)
    const signal = AbortSignal.any([requestSignal, this.controller.signal, deadline.signal])
    const result = (async () => {
      try {
        signal.throwIfAborted()
        const value = await action(signal)
        signal.throwIfAborted()
        return value
      } catch (error) {
        if (deadline.signal.aborted) throw new SkillHubFailure('timeout', { cause: error })
        if (signal.aborted) throw new SkillHubFailure('cancelled', { cause: error })
        throw error
      } finally { clearTimeout(timer) }
    })()
    this.pending.add(result)
    void result.finally(() => this.pending.delete(result)).catch((_operationFailed: unknown) => {
      // The caller receives the original rejection; this observer only removes ownership.
    })
    return result
  }

  private async cli(args: readonly string[], signal: AbortSignal, failure: SkillHubErrorCode): Promise<string> {
    let directory: string
    try {
      this.preparation ??= ensureSkillHubCli(this.cacheRoot,
        AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.config.timeoutMs)]), this.config.maxDownloadBytes)
        .catch((error: unknown) => {
          this.preparation = undefined
          throw error
        })
      directory = await waitForSetup(this.preparation, signal)
    } catch (error) {
      throw new SkillHubFailure('download-failed', { cause: error })
    }
    let python: string
    try {
      python = await this.ctx.subprocess.resolveExecutable(this.config.pythonExecutable, undefined, signal)
    } catch (error) { throw new SkillHubFailure('cli-unavailable', { cause: error }) }
    signal.throwIfAborted()
    const state = join(this.cacheRoot, 'state')
    await mkdir(state, { recursive: true, mode: 0o700 })
    if (!(await lstat(state)).isDirectory()) throw new SkillHubFailure('cli-unavailable')
    const handle = this.ctx.subprocess.spawn({
      // Isolated mode ignores PYTHONIOENCODING; Windows pipes need an explicit UTF-8 mode.
      argv: [python, '-I', '-X', 'utf8', '-B', '-c', ADAPTER, directory, state, '--skip-self-upgrade', ...args],
      cwd: state, signal, graceMs: this.config.terminationGraceMs,
      env: {
        PYTHONIOENCODING: 'utf-8', SKILLHUB_SKIP_SELF_UPGRADE: '1', SKILLHUB_SKIP_WORKSPACE_SKILLS: '1',
        SKILLHUB_CONFIG_PATH: join(state, 'config.json'), OPENCLAW_CONFIG_PATH: join(state, 'openclaw.json'),
        SKILLHUB_CLAWHUB_LOCK_PATH: join(state, 'clawhub-lock.json'),
        SKILLHUB_HOST: 'https://api.skillhub.cn', SKILLHUB_API_BASE: 'https://api.skillhub.cn',
        SKILLHUB_SEARCH_URL: 'https://api.skillhub.cn/api/v1/search',
        SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE: 'https://api.skillhub.cn/api/v1/download?slug={slug}',
        SKILLHUB_CALLER: 'none',
      },
      stdio: { stdin: 'ignore', stdout: { maxBytes: this.config.maxOutputBytes }, stderr: { maxBytes: this.config.maxOutputBytes } },
    })
    try {
      const outcome = await handle.done
      signal.throwIfAborted()
      const output = handle.collected.stdout?.readFrom(0)
      if (outcome.exitCode !== 0 || outcome.signal !== null || output === undefined || output.lossy) throw new SkillHubFailure(failure)
      return output.text.trim()
    } catch (error) {
      if (error instanceof SkillHubFailure) throw error
      throw new SkillHubFailure(failure, { cause: error })
    } finally {
      handle.terminate()
      await handle.waitForExit()
    }
  }

  /**
   * Search the official community catalog through the isolated CLI.
   * @param query - Validated nonempty user query.
   * @param signal - Request lifetime.
   * @returns Official community results; network failure rejects.
   */
  async search(query: string, signal: AbortSignal): Promise<readonly SkillHubSkill[]> {
    const output = await this.cli(['search', query, '--json', '--org', 'community', '--search-limit', String(this.config.searchLimit),
      '--search-timeout', String(Math.ceil(this.config.searchTimeoutMs / 1000))], signal, 'search-failed')
    if (output === 'No skills found.') return []
    try {
      const value: unknown = JSON.parse(output)
      if (!record(value) || !Array.isArray(value.results)) throw new Error('missing results')
      return value.results.map((item: unknown) => {
        if (!record(item) || !isSkillHubSlug(item.slug) || typeof item.name !== 'string'
          || typeof item.description !== 'string' || typeof item.version !== 'string' || item.source !== 'community') throw new Error('invalid result')
        return { slug: item.slug, name: item.name, description: item.description, version: item.version, source: item.source }
      })
    } catch (error) { throw new SkillHubFailure('search-failed', { cause: error }) }
  }

  /**
   * Read the official recommended ranking, retaining community coordinates in its published order.
   * @param signal - Request lifetime shared with CLI setup and execution.
   * @returns At most searchLimit community skills; invalid or unavailable rankings reject without installing skills.
   */
  async recommendations(signal: AbortSignal): Promise<readonly SkillHubSkill[]> {
    const output = await this.cli(['skill', 'rankings', '--type', 'recommended', '--host', 'https://api.skillhub.cn',
      '--timeout', String(Math.ceil(this.config.searchTimeoutMs / 1000))], signal, 'recommendations-failed')
    try {
      const value: unknown = JSON.parse(output)
      if (!record(value) || value.section !== 'recommended' || !Array.isArray(value.skills)) throw new Error('invalid ranking')
      const skills = new Map<string, SkillHubSkill>()
      for (const item of value.skills) {
        if (!record(item)) throw new Error('invalid skill')
        if (item.source !== 'community') continue
        const slug = record(item.namespace) ? item.namespace.canonicalName : item.slug
        const description = typeof item.description_zh === 'string' && item.description_zh !== '' ? item.description_zh : item.description
        if (!isSkillHubSlug(slug) || !slug.startsWith('@') || typeof item.name !== 'string' || typeof description !== 'string') {
          throw new Error('invalid community skill')
        }
        if (!skills.has(slug)) skills.set(slug, {
          slug, name: item.name, description, source: item.source,
          version: typeof item.version === 'string' ? item.version : '',
        })
      }
      return [...skills.values()].slice(0, this.config.searchLimit)
    } catch (error) { throw new SkillHubFailure('recommendations-failed', { cause: error }) }
  }

  /**
   * Read committed official lock entries without launching Python or changing skills.
   * @returns Verified product-local inventory.
   */
  async installed(): Promise<readonly InstalledSkill[]> {
    try {
      const lock = await readLock(this.skillsRoot)
      const result: InstalledSkill[] = []
      for (const [slug, value] of Object.entries(lock)) {
        const skill = skillFromLock(slug, value)
        const directory = join(this.skillsRoot, skillHubStorageName(slug))
        if (!(await lstat(directory)).isDirectory() || !(await lstat(join(directory, 'SKILL.md'))).isFile()) throw new SkillHubFailure('installed-invalid')
        result.push(skill)
      }
      return result.sort((a, b) => a.name.localeCompare(b.name))
    } catch (error) { throw new SkillHubFailure('installed-invalid', { cause: error }) }
  }

  /**
   * Install one selected coordinate using an isolated official CLI staging directory.
   * @param slug - Validated public coordinate selected by the user.
   * @param signal - Cancellation before the commit point; committed files remain on a later lock failure.
   * @returns The committed skill after its product lock was written.
   */
  async install(slug: string, signal: AbortSignal): Promise<InstalledSkill> {
    if (!isSkillHubSlug(slug)) throw new SkillHubFailure('invalid-request')
    if (this.installing) throw new SkillHubFailure('busy')
    this.installing = true
    let stage: string | undefined
    try {
      const destination = join(this.skillsRoot, skillHubStorageName(slug))
      if (await exists(destination)) throw new SkillHubFailure('already-installed')
      await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 })
      stage = await realpath(await mkdtemp(join(this.cacheRoot, '.install-')))
      const output = await this.cli(['--dir', stage, 'install', slug, '--json'], signal, 'install-failed')
      const value: unknown = JSON.parse(output)
      if (!record(value) || value.success !== true || value.slug !== slug || typeof value.targetDir !== 'string'
        || resolve(value.targetDir) !== resolve(stage, slug)) throw new SkillHubFailure('install-failed')
      const staged = join(stage, slug)
      await verifyTree(staged)
      if (!(await lstat(join(staged, 'SKILL.md'))).isFile()) throw new SkillHubFailure('install-failed')
      const skillFile = join(staged, 'SKILL.md')
      const original = await readFile(skillFile, { encoding: 'utf8', signal })
      const normalized = normalizeSkillHubMetadata(original)
      if (normalized !== original) await writeFile(skillFile, normalized, { encoding: 'utf8', signal })
      const lock = await readLock(stage)
      const entry = lock[slug]
      if (!record(entry)) throw new SkillHubFailure('install-failed')
      const skill = skillFromLock(slug, entry)
      const previous = await readLock(this.skillsRoot)
      if (Object.hasOwn(previous, slug)) throw new SkillHubFailure('already-installed')
      await mkdir(this.skillsRoot, { recursive: true, mode: 0o700 })
      if ((await lstat(this.skillsRoot)).isSymbolicLink()) throw new SkillHubFailure('install-failed')
      // Reserve the final name exclusively; an existing directory is never replaced.
      await mkdir(destination)
      try {
        signal.throwIfAborted()
        const entries = await readdir(staged)
        for (const entry of entries.filter(entry => entry !== 'SKILL.md')) await rename(join(staged, entry), join(destination, entry))
        signal.throwIfAborted()
        await rename(join(staged, 'SKILL.md'), join(destination, 'SKILL.md'))
      } catch (error) {
        await rm(destination, { recursive: true, force: true })
        throw error
      }
      const lockStage = join(stage, 'committed-lock.json')
      await writeFile(lockStage, JSON.stringify({ version: 1, skills: { ...previous, [slug]: { ...entry, installDir: destination } } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      await rename(lockStage, join(this.skillsRoot, LOCK))
      this.ctx.emit('skill-filesystem/changed', join(destination, 'SKILL.md'))
      return skill
    } catch (error) {
      if (error instanceof SkillHubFailure) throw error
      throw new SkillHubFailure('install-failed', { cause: error })
    } finally {
      try { if (stage !== undefined) await rm(stage, { recursive: true, force: true }) }
      finally { this.installing = false }
    }
  }
}
