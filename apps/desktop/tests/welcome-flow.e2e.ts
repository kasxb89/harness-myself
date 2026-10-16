/** Built Desktop Host acceptance; run after the repository build, without provider credentials. */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  it('reads a persisted product phone session across Host restarts', { retry: 0 }, async () => {
    vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3')
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-welcome-'))
    let host: DesktopHostProcess | undefined
    let stage = 'profile preparation'
    let launch = 0
    const lifetime = new AbortController()
    let cleanup: Promise<void> | undefined
    const dispose = (): Promise<void> => {
      cleanup ??= (async () => {
        lifetime.abort()
        await host?.stop()
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
      const nodeBin = join(root, 'runtime/primary-runtime/dependencies/node/bin')
      mkdirSync(nodeBin, { recursive: true })
      cpSync(process.execPath, join(nodeBin, process.platform === 'win32' ? 'node.exe' : 'node'))
      const paths = resolveDesktopPaths(home)
      const manager = new DesktopProjectManager(paths, {
        dsh: project,
      })
      await manager.applyRelease()
      writeFileSync(join(paths.profile, 'cordis.patch.yml'), '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n- id: locale\n  config:\n    preference: zh\n')
      let backend: DesktopWelcomeBackend
      const restart = async (): Promise<void> => {
        stage = `Host ${String(launch)} shutdown`
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
        account: { id: 'fixture-user', phone: '+8613800000000' },
      }), { mode: 0o600 })
      await restart()
      expect(await status()).toMatchObject({ loggedIn: true, hasApiKey: false, localePreference: 'zh' })
      await restart()
      expect(await status()).toMatchObject({ loggedIn: true })
    } finally {
      await dispose()
    }
  })
})
