import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureSkillHubCli } from '../src/skillhub-cache.ts'
import { SkillHubClient, isSkillHubSlug, skillHubStorageName, type SkillHubExecutionConfig } from '../src/skillhub-cli.ts'

vi.mock('../src/skillhub-cache.ts', () => ({ ensureSkillHubCli: vi.fn(async () => '/verified-official-cli') }))

let root: string
let ctx: Context
let provider: FixtureProcess
const budget: SkillHubExecutionConfig = { pythonExecutable: 'python3', timeoutMs: 10_000, terminationGraceMs: 100,
  maxOutputBytes: 100_000, maxDownloadBytes: 100_000, searchLimit: 20, searchTimeoutMs: 10_000 }

class FixtureProcess extends SubprocessRuntime {
  specs: SubprocessSpawnSpec[] = []
  output: (spec: SubprocessSpawnSpec) => Promise<string> = async () => ''
  exitCode = 0
  lossy = false
  waited = vi.fn(async () => true)
  terminated = vi.fn()
  override resolveExecutable(): Promise<string> { return Promise.resolve(process.execPath) }
  override terminalEnvironment(): never { throw new Error('unused terminal environment') }
  override spawnTerminal(): never { throw new Error('unused terminal') }
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    let output = ''
    const done = this.output(spec).then((text) => {
      output = text
      return { exitCode: this.exitCode, signal: null } satisfies SubprocessOutcome
    })
    return { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, done,
      collected: { stdout: { readFrom: () => ({ text: output, nextOffset: Buffer.byteLength(output), lossy: this.lossy }) } },
      terminate: this.terminated, waitForExit: this.waited }
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'yunshu-skillhub-'))
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root })
  const fiber = ctx.plugin((owner) => { provider = new FixtureProcess(owner) })
  await fiber.await()
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

function client(config = budget): SkillHubClient { return new SkillHubClient(ctx, config, join(root, 'cache'), join(root, 'skills')) }
function signal(): AbortSignal { return new AbortController().signal }
async function stageSkill(spec: SubprocessSpawnSpec, slug = 'hello'): Promise<string> {
  const stage = spec.argv[spec.argv.indexOf('--dir') + 1]!
  const targetDir = join(stage, slug)
  await mkdir(targetDir, { recursive: true })
  await writeFile(join(targetDir, 'SKILL.md'), '---\nname: hello\ndescription: A greeting\n---\n\n# Example\n')
  await writeFile(join(stage, '.skills_store_lock.json'), JSON.stringify({ version: 1, skills: { [slug]: { name: 'Hello', version: '1.0', installedAt: '2026-10-16T00:00:00Z' } } }))
  return JSON.stringify({ success: true, slug, targetDir })
}

describe('SkillHub product CLI isolation', () => {
  it.each(['hello', 'hello-world_1', '@team/hello'])('accepts public community coordinate %s', (value) =>{  expect(isSkillHubSlug(value)).toBe(true) })
  it.each(['../hello', '/hello', '@team/../hello', '--force', 'hello@1', 'hello\\other', 'hello:other', '', '@team/hello/extra', 'HELLO'])('rejects path or flag %s', (value) =>{  expect(isSkillHubSlug(value)).toBe(false) })

  it('maps official community results and isolates CLI files and environment', async () => {
    provider.output = async () => JSON.stringify({ results: [{ slug: '@team/hello', name: 'Hello', description: 'A skill', version: '1', source: 'community' }] })
    const instance = client()
    await expect(instance.run(signal(), s => instance.search('writing', s))).resolves.toEqual([{ slug: '@team/hello', name: 'Hello', description: 'A skill', version: '1', source: 'community' }])
    const spec = provider.specs[0]!
    expect(spec.argv).toContain('--skip-self-upgrade')
    expect(spec.argv.slice(-5)).toEqual(['community', '--search-limit', '20', '--search-timeout', '10'])
    expect(spec.argv).toContain('-I')
    expect(spec.env).toMatchObject({ SKILLHUB_SKIP_SELF_UPGRADE: '1', SKILLHUB_SKIP_WORKSPACE_SKILLS: '1', SKILLHUB_CALLER: 'none', SKILLHUB_CONFIG_PATH: join(root, 'cache', 'state', 'config.json'),
      OPENCLAW_CONFIG_PATH: join(root, 'cache', 'state', 'openclaw.json'), SKILLHUB_CLAWHUB_LOCK_PATH: join(root, 'cache', 'state', 'clawhub-lock.json') })
    expect(provider.waited).toHaveBeenCalledOnce()
    await instance.dispose()
  })

  it('returns an official empty result while rejecting failed and truncated subprocess results', async () => {
    const instance = client()
    provider.output = async () => 'No skills found.'
    await expect(instance.run(signal(), s => instance.search('empty', s))).resolves.toEqual([])
    provider.exitCode = 42
    await expect(instance.run(signal(), s => instance.search('offline', s))).rejects.toMatchObject({ code: 'search-failed' })
    provider.exitCode = 0
    provider.lossy = true
    await expect(instance.run(signal(), s => instance.search('huge', s))).rejects.toMatchObject({ code: 'search-failed' })
    await instance.dispose()
  })

  it.each(['{}', '{"results":[{"slug":"../escape"}]}', 'not json'])('rejects invalid CLI search response %s', async (output) => {
    provider.output = async () => output
    const instance = client()
    await expect(instance.run(signal(), s => instance.search('test', s))).rejects.toMatchObject({ code: 'search-failed' })
    await instance.dispose()
  })

  it('reads product inventory without Python and refuses corrupt or missing skill entries', async () => {
    const instance = client()
    await expect(instance.installed()).resolves.toEqual([])
    const directory = join(root, 'skills')
    await mkdir(join(directory, skillHubStorageName('hello')), { recursive: true })
    await writeFile(join(directory, '.skills_store_lock.json'), JSON.stringify({ version: 1, skills: { hello: { name: 'Hello', version: '1' } } }))
    await expect(instance.installed()).rejects.toMatchObject({ code: 'installed-invalid' })
    await writeFile(join(directory, skillHubStorageName('hello'), 'SKILL.md'), '# Hello\n')
    await expect(instance.installed()).resolves.toEqual([{ slug: 'hello', name: 'Hello', version: '1' }])
    await writeFile(join(directory, '.skills_store_lock.json'), '{broken')
    await expect(instance.installed()).rejects.toMatchObject({ code: 'installed-invalid' })
    expect(provider.specs).toEqual([])
    await instance.dispose()
  })

  it.each(['hello', '@team/hello'])('commits selected %s from private staging into product skills without overwrite', async (slug) => {
    provider.output = spec => stageSkill(spec, slug)
    const instance = client()
    const installed = await instance.run(signal(), s => instance.install(slug, s))
    expect(installed).toEqual({ slug, name: 'Hello', version: '1.0', installedAt: '2026-10-16T00:00:00Z' })
    expect(await readFile(join(root, 'skills', skillHubStorageName(slug), 'SKILL.md'), 'utf8')).toContain('# Example\n')
    expect(await instance.installed()).toEqual([installed])
    expect(provider.specs[0]!.argv).not.toContain('--force')
    expect(provider.specs[0]!.argv[provider.specs[0]!.argv.indexOf('--dir') + 1]).toContain(join('cache', '.install-'))
    await expect(instance.run(signal(), s => instance.install(slug, s))).rejects.toMatchObject({ code: 'already-installed' })
    expect(provider.specs).toHaveLength(1)
    await instance.dispose()
  })

  it('refreshes a warm filesystem catalog immediately after installing a namespace skill', async () => {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false, customSkillDirs: [join(root, 'skills')], watch: false })
    expect(await ctx.skills.snapshot()).toEqual({ skills: [], complete: true })
    provider.output = spec => stageSkill(spec, '@team/hello')
    const instance = client()
    await instance.run(signal(), s => instance.install('@team/hello', s))
    const catalog = await ctx.skills.snapshot()
    expect(catalog.complete).toBe(true)
    expect(catalog.skills.map(skill => skill.name)).toEqual(['hello'])
    expect((await ctx.skills.get('hello'))?.content).toContain('# Example')
    await instance.dispose()
  })

  it('refuses a mismatched returned coordinate before modifying product skills', async () => {
    provider.output = async (spec) => {
      const result = JSON.parse(await stageSkill(spec)) as { success: boolean; slug: string; targetDir: string }
      return JSON.stringify({ ...result, targetDir: join(root, 'escape') })
    }
    const instance = client()
    await expect(instance.run(signal(), s => instance.install('hello', s))).rejects.toMatchObject({ code: 'install-failed' })
    await expect(instance.installed()).resolves.toEqual([])
    await instance.dispose()
  })

  it('keeps shared first-use setup alive when a superseded search aborts', async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const ready = Promise.withResolvers<string>()
    vi.mocked(ensureSkillHubCli).mockImplementationOnce(async (_root, sharedSignal) => {
      started.resolve(sharedSignal)
      return await ready.promise
    })
    provider.output = async () => 'No skills found.'
    const instance = client()
    const obsolete = new AbortController()
    const first = instance.run(obsolete.signal, s => instance.search('first', s))
    const firstFailure = expect(first).rejects.toMatchObject({ code: 'cancelled' })
    const setupSignal = await started.promise
    const second = instance.run(signal(), s => instance.search('second', s))
    obsolete.abort()
    await firstFailure
    expect(setupSignal.aborted).toBe(false)
    expect(provider.specs).toEqual([])
    ready.resolve('/verified-official-cli')
    await expect(second).resolves.toEqual([])
    expect(provider.specs).toHaveLength(1)
    expect(provider.specs[0]!.argv).toContain('second')
    await instance.dispose()
  })

  it('joins shared setup during disposal even after its only request stopped waiting', async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const closed = Promise.withResolvers<string>()
    const cancellation = Promise.withResolvers<undefined>()
    vi.mocked(ensureSkillHubCli).mockImplementationOnce(async (_root, sharedSignal) => {
      sharedSignal.addEventListener('abort', () => { cancellation.resolve(undefined) }, { once: true })
      started.resolve(sharedSignal)
      return await closed.promise
    })
    const instance = client()
    const request = new AbortController()
    const pending = instance.run(request.signal, s => instance.search('first', s))
    const failure = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await started.promise
    request.abort()
    await failure
    let disposed = false
    const disposal = instance.dispose().then(() => { disposed = true })
    await cancellation.promise
    expect(disposed).toBe(false)
    expect(provider.specs).toEqual([])
    closed.resolve('/verified-official-cli')
    await disposal
    expect(disposed).toBe(true)
  })

  it('rejects overlapping installations and waits for request cancellation to settle', async () => {
    let started!: () => void
    const readiness = new Promise<void>((resolve) => { started = resolve })
    let exited!: () => void
    const exit = new Promise<void>((resolve) => { exited = resolve })
    provider.output = spec => new Promise<string>((_resolve, reject) => {
      spec.signal!.addEventListener('abort', () =>{  reject(new Error('request cancelled')) }, { once: true })
      started()
    })
    provider.waited = vi.fn(async () => { await exit; return true })
    const instance = client()
    const request = instance.run(signal(), s => instance.install('hello', s))
    const rejection = expect(request).rejects.toMatchObject({ code: 'cancelled' })
    await readiness
    await expect(instance.run(signal(), s => instance.install('other', s))).rejects.toMatchObject({ code: 'busy' })
    let disposed = false
    const disposal = instance.dispose().then(() => { disposed = true })
    await vi.waitFor(() =>{  expect(provider.waited).toHaveBeenCalledOnce() })
    expect(disposed).toBe(false)
    exited()
    await disposal
    await rejection
    expect(disposed).toBe(true)
  })
})
