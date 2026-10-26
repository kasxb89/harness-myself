/** Built Desktop Host acceptance; run after the repository build, without provider credentials. */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { DesktopHostProcess } from '../src/host-process.ts'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { connectDesktopWelcome, type DesktopWelcomeBackend } from '../src/welcome-backend.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { prepareDevelopmentProject } from '../scripts/development-project.ts'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const builtHost = join(repository, 'apps/desktop-host/lib/index.js')
afterEach(() => { vi.unstubAllEnvs() })

function version(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version
}

describe.skipIf(!existsSync(builtHost))('built Desktop welcome flow', () => {
  it('recovers temporary account failures and preserves product sign-in across Host restarts', { retry: 0 }, async () => {
    vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3')
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-welcome-'))
    let host: DesktopHostProcess | undefined
    let backend: DesktopWelcomeBackend | undefined
    let stage = 'profile preparation'
    let launch = 0
    const lifetime = new AbortController()
    let cleanup: Promise<void> | undefined
    let selfReply: 'verified' | 'network' | 'timeout' | 'malformed' | 401 | 408 | 429 | 503 = 'verified'
    let refreshStatus = 200
    let refreshes = 0
    const unexpected: string[] = []
    const upstream = createServer((request, response) => {
      const path = request.url ?? '/'
      response.setHeader('content-type', 'application/json')
      const answer = (data: unknown): void => { response.end(JSON.stringify({ success: true, data })) }
      if (path === '/harness/api/status') { answer({ quota_per_unit: 500_000, usd_exchange_rate: 7.3 }); return }
      if (path === '/harness/api/pricing') { answer([]); return }
      if (path === '/harness/v1/models') { response.end(JSON.stringify({ data: [] })); return }
      if (path === '/harness/api/user/self') {
        if (selfReply === 'network') { response.destroy(); return }
        if (selfReply === 'timeout') return
        if (selfReply === 'malformed') { response.end('{'); return }
        if (typeof selfReply === 'number') { response.writeHead(selfReply); response.end('{}'); return }
        answer({ id: 7, username: 'fixture-user', group: 'default', quota: 1000 }); return
      }
      if (path === '/harness/api/user/auth/refresh') {
        refreshes++
        if (refreshStatus !== 200) { response.writeHead(refreshStatus); response.end('{}'); return }
        response.setHeader('set-cookie', 'new_api_refresh=fixture-renewed; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: 'fixture-renewed-access', access_expires_at: Math.floor(Date.now() / 1000) + 900, user: { id: 7 } }); return
      }
      unexpected.push(`${request.method ?? 'unknown'} ${path}`)
      response.writeHead(404); response.end('{}')
    })
    const dispose = (): Promise<void> => {
      cleanup ??= (async () => {
        lifetime.abort()
        backend?.dispose()
        await host?.stop()
        if (upstream.listening) await new Promise<void>((resolve, reject) => {
          upstream.close((error) => { if (error === undefined) resolve(); else reject(error) })
          upstream.closeAllConnections()
        })
        rmSync(root, { recursive: true, force: true })
      })()
      return cleanup
    }
    onTestFailed(() => { console.error(`Desktop welcome acceptance failed during: ${stage}`) })
    onTestFinished(dispose)
    try {
      for (const name of Object.keys(process.env)) {
        if (/KEY|TOKEN|SECRET|PASSWORD/u.test(name)) vi.stubEnv(name, undefined)
      }
      const home = join(root, 'home')
      mkdirSync(home)
      vi.stubEnv('DSH_HOME', home)
      vi.stubEnv('DSH_TELEMETRY_MODE', 'DISABLED')
      await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', resolve) })
      const address = upstream.address()
      if (address === null || typeof address === 'string') throw new Error('Missing welcome fixture listener')
      const api = `http://127.0.0.1:${String(address.port)}/harness`
      const project = prepareDevelopmentProject({
        projectDir: join(root, 'project'),
        cliDir: join(repository, 'apps/cli'),
        hostDir: join(repository, 'apps/desktop-host'),
        dependencyDir: join(repository, 'node_modules/.pnpm/node_modules'),
        release: {
          schemaVersion: 1,
          version: version(join(repository, 'apps/desktop/package.json')),
          pnpmVersion: version(join(repository, 'apps/desktop/node_modules/pnpm/package.json')),
          nodeVersion: process.versions.node,
          hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        },
        // This suite assembles a synthetic project on hosts that prepare no Desktop target, and
        // nothing it exercises compares the descriptor's platform/arch outside packaging.
        target: 'mac-x64',
      })
      cpSync(join(repository, 'packages/skill/skill-office/assets'), join(root, 'runtime/office-skills'), { recursive: true })
      cpSync(join(repository, 'packages/skill/skill-office/lib/render-cache.js'), join(root, 'runtime/office-skills/scripts/render-cache.mjs'))
      const nodeBin = join(root, 'runtime/primary-runtime/dependencies/node/bin')
      mkdirSync(nodeBin, { recursive: true })
      cpSync(process.execPath, join(nodeBin, process.platform === 'win32' ? 'node.exe' : 'node'))
      const runtime = join(root, 'runtime/primary-runtime')
      const python = join(runtime, 'dependencies/python')
      mkdirSync(join(runtime, 'dependencies/node/node_modules'), { recursive: true })
      mkdirSync(join(python, 'bin'), { recursive: true })
      mkdirSync(join(python, ...(process.platform === 'win32' ? ['Lib'] : ['lib', 'python3.12']), 'site-packages'), { recursive: true })
      // Account acceptance never executes Python; the Host still validates its private payload entries.
      writeFileSync(join(python, ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3'])), 'fixture interpreter\n')
      writeFileSync(join(runtime, 'runtime.json'), JSON.stringify({ desktopVersion: '1.2.3', platform: process.platform,
        arch: process.arch, python: '3.12.14', node: process.versions.node, pythonPackages: {} }))
      const paths = resolveDesktopPaths(home)
      const manager = new DesktopProjectManager(paths, {
        dsh: project,
      })
      await manager.applyRelease()
      writeFileSync(join(paths.profile, 'cordis.patch.yml'), JSON.stringify([
        { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
        { id: 'locale', config: { preference: 'zh' } },
        { id: 'credits-index', config: { newApiBaseUrl: api, timeoutMs: 1000, refreshRetryBaseDelayMs: 1000, refreshRetryMaxDelayMs: 1000 } },
      ]))
      const restart = async (): Promise<void> => {
        stage = `Host ${String(launch)} shutdown`
        backend?.dispose()
        await host?.stop()
        lifetime.signal.throwIfAborted()
        launch++
        stage = `Host ${String(launch)} startup`
        host = new DesktopHostProcess(process.execPath, project, paths.profile)
        const { url } = await host.start()
        let cookie = ''
        const send: typeof fetch = async (input, init) => {
          stage = `Host ${String(launch)} HTTP ${new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname}`
          const headers = new Headers(init?.headers)
          if (cookie !== '') headers.set('cookie', cookie)
          const response = await fetch(input, { ...init, headers, redirect: 'manual',
            signal: init?.signal === undefined || init.signal === null ? lifetime.signal : AbortSignal.any([init.signal, lifetime.signal]),
          })
          if (response.status !== 303) return response
          cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
          await response.body?.cancel()
          return fetch(new URL(response.headers.get('location')!, url), { headers: { cookie }, signal: lifetime.signal })
        }
        stage = `Host ${String(launch)} welcome authentication`
        backend = await connectDesktopWelcome(url, send, () => Promise.resolve(cookie))
      }
      const status = async () => {
        stage = `Host ${String(launch)} product session read`
        if (backend === undefined) throw new Error('Missing welcome fixture backend')
        return backend.read()
      }
      await restart()
      expect(await status()).toMatchObject({ loggedIn: false, hasApiKey: false, localePreference: 'zh' })
      // A disposable product fixture exercises the real session route across process restarts.
      stage = 'Host 1 shutdown before product fixture'
      await host!.stop()
      const creditsState = join(home, 'plugin-data', 'credits')
      mkdirSync(creditsState, { recursive: true })
      writeFileSync(join(creditsState, 'session.json'), JSON.stringify({
        token: 'fixture-product-session',
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        backendBaseUrl: api,
        account: { id: '7', phone: '+8613800000000' },
        upstream: { token: 'fixture-access', refresh: 'fixture-refresh', expiresAt: new Date(Date.now() + 86400_000).toISOString() },
        relay: { key: 'sk-fixture-only' },
      }), { mode: 0o600 })
      await restart()
      expect(await status()).toMatchObject({ loggedIn: true, hasApiKey: false, localePreference: 'zh' })
      await restart()
      expect(await status()).toMatchObject({ loggedIn: true })
      const stored = readFileSync(join(creditsState, 'session.json'), 'utf8')
      for (const [fault, reason] of [
        ['network', 'network'], ['timeout', 'timeout'], [408, 'timeout'],
        [429, 'rate_limited'], [503, 'upstream_unavailable'], ['malformed', 'protocol'],
      ] as const) {
        selfReply = fault
        stage = `recoverable account ${String(fault)}`
        expect(await status()).toMatchObject({ loggedIn: false, sessionIssue: reason })
        expect(readFileSync(join(creditsState, 'session.json'), 'utf8')).toBe(stored)
        selfReply = 'verified'
        expect(await status()).toMatchObject({ loggedIn: true })
      }
      await host!.stop()
      const expired = JSON.parse(stored) as { upstream: { expiresAt: string } }
      expired.upstream.expiresAt = '2000-01-01T00:00:00.000Z'
      writeFileSync(join(creditsState, 'session.json'), JSON.stringify(expired), { mode: 0o600 })
      refreshStatus = 503
      await restart()
      expect(await status()).toMatchObject({ loggedIn: false, sessionIssue: 'upstream_unavailable' })
      expect(readFileSync(join(creditsState, 'session.json'), 'utf8')).toBe(JSON.stringify(expired))
      refreshStatus = 200
      await expect.poll(status, { timeout: 10_000 }).toMatchObject({ loggedIn: true })
      expect(refreshes).toBeGreaterThanOrEqual(2)
      selfReply = 401
      refreshStatus = 401
      const terminal = await status()
      expect(terminal).toMatchObject({ loggedIn: false })
      expect(terminal).not.toHaveProperty('sessionIssue')
      expect(JSON.parse(readFileSync(join(creditsState, 'session.json'), 'utf8'))).not.toHaveProperty('token')
      expect(unexpected).toEqual([])
    } finally {
      await dispose()
    }
  })
})
