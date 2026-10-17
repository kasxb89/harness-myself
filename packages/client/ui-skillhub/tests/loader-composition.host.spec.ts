import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SubprocessRuntime, type SubprocessHandle, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { skillHubStorageName } from '../src/skillhub-cli.ts'
import * as SkillHub from '../src/index.ts'

vi.mock('../src/skillhub-cache.ts', () => ({ ensureSkillHubCli: vi.fn(async () => '/verified-official-cli') }))

class FixtureProcess extends SubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []
  override resolveExecutable(): Promise<string> { return Promise.resolve(process.execPath) }
  override terminalEnvironment(): never { throw new Error('unused') }
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (!spec.argv.includes('rankings') || spec.argv.includes('install')) throw new Error('only read-only rankings may run')
    this.specs.push(spec)
    const text = JSON.stringify({ section: 'recommended', skills: [{ slug: 'hello', namespace: { canonicalName: '@team/hello' },
      name: 'Hello', description: 'A skill', version: '1', source: 'community' }] })
    return {
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      done: Promise.resolve({ exitCode: 0, signal: null }),
      collected: { stdout: { readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) } },
      terminate: () => {}, waitForExit: async () => true,
    }
  }
  override spawnTerminal(): never { throw new Error('unused') }
}

let root: string | undefined
let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

it('requires explicit product directories and rejects relative paths before registering routes', () => {
  expect(() => Schema.resolve({}, SkillHub.Config, {})).toThrow()
  expect(() => Schema.resolve({ skillsDirectory: '/skills' }, SkillHub.Config, {})).toThrow()
  const owner = new Context()
  ctx = owner
  const config = SkillHub.Config({
    skillsDirectory: 'skills', cacheDirectory: 'cache', pythonExecutable: 'python3',
    timeoutMs: 120_000, terminationGraceMs: 1_000, maxOutputBytes: 1_048_576,
    maxDownloadBytes: 1_048_576, searchLimit: 20, searchTimeoutMs: 15_000,
  })
  expect(() => { SkillHub.apply(owner, config) }).toThrow('must be absolute paths')
})

it('serves inventory and official recommendations through a real Loader and withdraws every route on disposal', async () => {
  root = await mkdtemp(join(tmpdir(), 'yunshu-skillhub-loader-'))
  vi.stubEnv('DSH_HOME', root)
  const skills = join(root, 'skills')
  await mkdir(join(skills, skillHubStorageName('hello')), { recursive: true })
  await writeFile(join(skills, skillHubStorageName('hello'), 'SKILL.md'), '# Hello\n')
  await writeFile(join(skills, '.skills_store_lock.json'), JSON.stringify({ version: 1, skills: { hello: { name: 'Hello', version: '1' } } }))
  const config = join(root, 'cordis.yml')
  await writeFile(config, ['- name: cordis:fixture-credentials', '- name: cordis:fixture-connection', '- name: cordis:fixture-process', '- name: cordis:fixture-fs', `  config: { cwd: ${JSON.stringify(root)} }`, '- name: cordis:skillhub',
    '  config:', `    skillsDirectory: ${JSON.stringify(skills)}`, `    cacheDirectory: ${JSON.stringify(join(root, 'cache', 'skillhub'))}`, ''].join('\n'))
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins['fixture-credentials'] = MemoryCredentials
  ctx.loader.builtins['fixture-process'] = FixtureProcess
  ctx.loader.builtins['fixture-fs'] = LocalFileSystem
  ctx.loader.builtins['fixture-connection'] = { inject: ['credentials'], async apply(owner: Context) {
    new HostConnectionService(owner, [], await BrowserAuth.create(owner.root, owner.credentials, 30))
  } }
  ctx.loader.builtins.skillhub = SkillHub
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const connection = ctx.connection
  expect(connection.requestRejection({ headers: { host: '127.0.0.1' } })).toBe(401)
  expect(connection.requestRejection({ headers: { host: 'untrusted.example' } })).toBe(403)
  const handler = connection.createSharedFetchHandler('/api')
  const inventory = await handler.fetch(new Request('http://127.0.0.1/api/skillhub/installed'))
  expect(inventory.status).toBe(200)
  expect(await inventory.json()).toEqual({ ok: true, skills: [{ slug: 'hello', name: 'Hello', version: '1' }] })
  const processFixture = ctx.subprocess as FixtureProcess
  expect(processFixture.specs).toEqual([])
  const recommendations = await handler.fetch(new Request('http://127.0.0.1/api/skillhub/recommendations'))
  expect(recommendations.status).toBe(200)
  expect(await recommendations.json()).toEqual({ ok: true, skills: [
    { slug: '@team/hello', name: 'Hello', description: 'A skill', version: '1', source: 'community' },
  ] })
  expect(processFixture.specs).toHaveLength(1)
  expect(processFixture.specs[0]!.argv).not.toContain('install')
  const emptyQuery = await handler.fetch(new Request('http://127.0.0.1/api/skillhub/search?q='))
  expect(emptyQuery.status).toBe(400)
  expect(await emptyQuery.json()).toEqual({ ok: false, code: 'invalid-request' })
  const invalidInstall = await handler.fetch(new Request('http://127.0.0.1/api/skillhub/install', { method: 'POST', body: '{"slug":"../escape"}' }))
  expect(invalidInstall.status).toBe(400)
  expect(await invalidInstall.json()).toEqual({ ok: false, code: 'invalid-request' })
  const malformedInstall = await handler.fetch(new Request('http://127.0.0.1/api/skillhub/install', { method: 'POST', body: '{' }))
  expect(await malformedInstall.json()).toEqual({ ok: false, code: 'invalid-request' })
  const entry = [...ctx.loader.entries()].find(item => item.options.name === 'cordis:skillhub')
  expect(entry?.fiber).toBeDefined()
  await entry!.fiber!.dispose()
  for (const [path, method] of [['installed', 'GET'], ['recommendations', 'GET'], ['search?q=hello', 'GET'], ['install', 'POST']] as const) {
    expect((await handler.fetch(new Request(`http://127.0.0.1/api/skillhub/${path}`, { method }))).status).toBe(404)
  }
})
