/** Exercise cache reuse with real pnpm and a private, synthetic registry. */

import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { removeFixtureSafely } from '../../../scripts/test-fixture-cleanup.ts'
import { desktopDependencyCacheArguments, prepareDesktopDependencyCache, type DesktopDependencyCache } from '../scripts/desktop-dependency-cache.ts'

const require = createRequire(import.meta.url)
const pnpm = join(dirname(require.resolve('pnpm')), 'bin/pnpm.cjs')
const versions = { pnpmVersion: '11.28.5', nodeVersion: '24.21.0' }
const roots: string[] = []
const servers: Server[] = []
const execute = promisify(execFile)

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-desktop-cache-'))
  roots.push(path)
  return path
}

function write(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function archive(path: string, name: string, value: string, build = false): Buffer {
  write(join(path, 'package/package.json'), JSON.stringify({
    name, version: '1.0.0', type: 'module', main: 'index.js',
    ...build ? { scripts: { postinstall: 'node install.cjs' } } : {},
  }))
  write(join(path, 'package/index.js'), `export const value = ${JSON.stringify(value)};\n`)
  if (build) write(join(path, 'package/install.cjs'), "require('node:fs').writeFileSync('built.txt', process.env.DSH_CACHE_FIXTURE_BUILD);\n")
  execFileSync('tar', ['-czf', join(path, 'package.tgz'), '-C', path, 'package'])
  return readFileSync(join(path, 'package.tgz'))
}

async function install(project: string, cache: DesktopDependencyCache, value: string): Promise<void> {
  write(join(project, 'package.json'), JSON.stringify({
    name: 'cache-project', private: true, dependencies: { 'cache-fixture': '1.0.0', 'local-fixture': 'file:local.tgz' },
  }))
  write(join(project, 'local.tgz'), archive(join(project, 'archive'), 'local-fixture', value))
  write(join(project, 'pnpm-workspace.yaml'), JSON.stringify({ allowBuilds: { 'cache-fixture': true } }))
  const config = join(project, 'config')
  write(join(config, 'npmrc'), '')
  const excluded = /KEY|SECRET|TOKEN|PASSWORD|^(?:npm|pnpm|corepack)_|^NODE_(?:OPTIONS|PATH)$|^(?:HTTP|HTTPS|ALL|NO)_PROXY$/iu
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !excluded.test(name)))
  const options = {
    cwd: project, env: { ...env, DSH_CACHE_FIXTURE_BUILD: value,
      XDG_CACHE_HOME: cache.metadata, XDG_CONFIG_HOME: config, XDG_STATE_HOME: join(project, 'state') },
    timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
  }
  const args = [pnpm, ...desktopDependencyCacheArguments(cache), `--config.userconfig=${join(config, 'npmrc')}`, '--config.fetch-retries=0']
  try {
    await execute(process.execPath, [...args, 'install', '--lockfile-only'], options)
    await execute(process.execPath, [...args, 'install', '--prod', '--frozen-lockfile', '--trust-lockfile'], options)
  } catch (error) {
    if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string') {
      throw new Error(`${error.message}\n${error.stdout}`, { cause: error })
    }
    throw error
  }
}

function findFile(directory: string, contents: string): string | undefined {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const found = findFile(path, contents)
      if (found !== undefined) return found
    } else if (entry.isFile() && readFileSync(path).equals(Buffer.from(contents))) return path
  }
  return undefined
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  }
  for (const path of roots.splice(0)) removeFixtureSafely(path)
})

describe('Desktop dependency cache', () => {
  it('shares downloads across worktrees and partitions target, tool versions, and registry', () => {
    const home = root()
    const first = prepareDesktopDependencyCache({}, 'mac-arm64', versions, home)
    expect(prepareDesktopDependencyCache({}, 'mac-arm64', versions, home)).toEqual(first)
    for (const cache of [
      prepareDesktopDependencyCache({}, 'mac-x64', versions, home),
      prepareDesktopDependencyCache({}, 'win-x64', versions, home),
      prepareDesktopDependencyCache({}, 'mac-arm64', { ...versions, pnpmVersion: '11.28.6' }, home),
      prepareDesktopDependencyCache({}, 'mac-arm64', { ...versions, nodeVersion: '24.22.0' }, home),
      prepareDesktopDependencyCache({ DSH_DESKTOP_NPM_REGISTRY: 'https://registry.example.com' }, 'mac-arm64', versions, home),
    ]) expect(cache.directory).not.toBe(first.directory)
    expect(prepareDesktopDependencyCache({ DSH_DESKTOP_NPM_REGISTRY: 'https://registry.npmjs.org/' }, 'mac-arm64', versions, home)).toEqual(first)
  })

  it('rejects relative, root, and linked cache locations without writing through the link', () => {
    const home = root()
    for (const path of ['', 'relative', parse(home).root]) {
      expect(() => prepareDesktopDependencyCache({ DSH_DESKTOP_DEPENDENCY_CACHE_DIR: path }, 'win-x64', versions, home))
        .toThrow(/absolute non-root directory/u)
    }
    const destination = join(home, 'destination')
    mkdirSync(destination)
    const link = join(home, 'link')
    symlinkSync(destination, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => prepareDesktopDependencyCache({ DSH_DESKTOP_DEPENDENCY_CACHE_DIR: link }, 'win-x64', versions, home))
      .toThrow(/real directory/u)
    expect(readdirSync(destination)).toEqual([])
  })

  it('reuses downloads concurrently, rebuilds local tarballs and lifecycle files, and detects corrupted stored bytes', async () => {
    const home = root()
    const payload = archive(join(home, 'registry-payload'), 'cache-fixture', 'downloaded', true)
    let origin = ''
    let downloads = 0
    let requests = 0
    let rejectNetwork = false
    const server = createServer((request, response) => {
      requests++
      if (rejectNetwork) { response.writeHead(503).end(); return }
      if (request.url === '/cache-fixture') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ name: 'cache-fixture', 'dist-tags': { latest: '1.0.0' },
          time: { created: '2020-01-01T00:00:00.000Z', modified: '2020-01-01T00:00:00.000Z', '1.0.0': '2020-01-01T00:00:00.000Z' }, versions: {
            '1.0.0': { name: 'cache-fixture', version: '1.0.0', dist: {
              tarball: `${origin}/payload.tgz`, integrity: `sha512-${createHash('sha512').update(payload).digest('base64')}`,
            } },
          } }))
      } else if (request.url === '/payload.tgz') { downloads++; response.end(payload) }
      else response.writeHead(404).end()
    })
    servers.push(server)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('cache fixture requires a TCP listener')
    origin = `http://127.0.0.1:${String(address.port)}`
    const cache = { ...prepareDesktopDependencyCache({}, 'win-x64', versions, home), registry: origin }
    await install(join(home, 'cold'), cache, 'cold')
    expect(downloads).toBe(1)
    writeFileSync(join(home, 'cold/node_modules/cache-fixture/index.js'), 'local installation changed\n')
    const initialRequests = requests
    rejectNetwork = true
    const warmResults = await Promise.allSettled(['warm-a', 'warm-b'].map(async (name) => {
      const project = join(home, name)
      await install(project, cache, name)
      expect(readFileSync(join(project, 'node_modules/local-fixture/index.js'), 'utf8')).toContain(JSON.stringify(name))
      expect(readFileSync(join(project, 'node_modules/cache-fixture/built.txt'), 'utf8')).toBe(name)
      expect(readFileSync(join(project, 'node_modules/cache-fixture/index.js'), 'utf8')).toContain('"downloaded"')
    }))
    for (const result of warmResults) if (result.status === 'rejected') throw result.reason
    expect(requests).toBe(initialRequests)
    const stored = findFile(cache.store, 'export const value = "downloaded";\n')
    expect(stored).toBeDefined()
    if (stored === undefined) throw new Error('cache fixture did not materialize stored package contents')
    writeFileSync(stored, 'export const value = "corrupted";\n')
    rejectNetwork = false
    const repaired = join(home, 'repair')
    await install(repaired, cache, 'repair')
    expect(downloads).toBe(2)
    expect(readFileSync(join(repaired, 'node_modules/cache-fixture/index.js'), 'utf8')).toContain('"downloaded"')
  })
})
