/** Real HTTP and CONNECT requests keep third-party downloads out of the GitHub-only upstream. */
import { once } from 'node:events'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createServer, request, type Server as HttpServer, type IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import type { Socket } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { Server } from 'proxy-chain'
import { expect, it, onTestFinished } from 'vitest'
import { createGithubProxyOperation, isGithubProxySpec, normalizeGithubProxy } from '../src/github-proxy.ts'
import { parseInstallSpec } from '../src/install-spec.ts'
import { readPnpmProxyEnvironment } from '../src/pnpm-proxy-settings.ts'

const DIRECT_ENV = { http_proxy: '', HTTP_PROXY: '', https_proxy: '', HTTPS_PROXY: '', all_proxy: '', ALL_PROXY: '', no_proxy: '', NO_PROXY: '' }

it('provides the pnpm reader peers when production profiles disable automatic peer installation', () => {
  interface Manifest {
    name: string
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    peerDependenciesMeta?: Record<string, { optional?: boolean }>
  }
  const manager = fileURLToPath(new URL('../package.json', import.meta.url))
  const provided = new Set<string>()
  const required: { consumer: string; peer: string }[] = []
  const visited = new Set<string>()
  const packageManifest = (from: string, name: string): string => {
    for (const directory of createRequire(from).resolve.paths(name) ?? []) {
      const path = join(directory, name, 'package.json')
      if (existsSync(path)) return realpathSync(path)
    }
    throw new Error(`No manifest for runtime dependency ${name}`)
  }
  const visit = (path: string): void => {
    if (visited.has(path)) return
    visited.add(path)
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest
    provided.add(manifest.name)
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[peer]?.optional !== true) required.push({ consumer: manifest.name, peer })
    }
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (/^(?:workspace|file|link):/u.test(spec)) continue
      provided.add(name)
      visit(packageManifest(path, name))
    }
  }
  // The manager's optional Harness services are injected; only external runtime packages need this peer check.
  const manifest = JSON.parse(readFileSync(manager, 'utf8')) as Manifest
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (!name.startsWith('@pnpm/') || /^(?:workspace|file|link):/u.test(spec)) continue
    visit(packageManifest(manager, name))
  }
  expect(required.filter(({ peer }) => !provided.has(peer))).toEqual([])
})

function childCommands(cwd: string, env: Readonly<Record<string, string>>) {
  const controller = new AbortController()
  const tasks: Promise<unknown>[] = []
  onTestFinished(async () => { controller.abort(); await Promise.allSettled(tasks) })
  return (command: string, args: string[]) => {
    const task = execa(command, args, { cwd, env, extendEnv: false, cancelSignal: controller.signal, killDescendants: true })
    tasks.push(task)
    return task
  }
}

async function router(proxy = 'https://github-proxy.example:8443', env: Record<string, string> = {}) {
  const controller = new AbortController()
  const operation = await createGithubProxyOperation(proxy, { ...DIRECT_ENV, ...env }, { signal: controller.signal, idleTimeoutMs: 3000 })
  onTestFinished(() => operation.close())
  return { operation, controller }
}

async function origin() {
  const paths: string[] = []
  const server = createServer((req, response) => { paths.push(req.url ?? ''); response.end('third-party-package') })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('origin did not bind a port')
  return { server, paths, url: `http://127.0.0.1:${String(address.port)}`, authority: `127.0.0.1:${String(address.port)}` }
}

async function upstream(connectServer: HttpServer) {
  const hosts: string[] = []
  const server = new Server({ host: '127.0.0.1', port: 0, prepareRequestFunction: ({ hostname, isHttp }) => {
    hosts.push(hostname)
    return isHttp ? { customResponseFunction: () => ({ body: 'original-proxy-response' }) } : { customConnectServer: connectServer }
  } })
  onTestFinished(() => server.close(true))
  await server.listen()
  return { server, hosts, url: `http://127.0.0.1:${String(server.port)}` }
}

async function get(proxy: string, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const call = request(proxy, { path: target, agent: false }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.once('end', () => { resolve(Buffer.concat(chunks).toString()) })
      response.once('error', reject)
    })
    onTestFinished(() => { call.destroy() })
    call.once('error', reject)
    call.end()
  })
}

async function connect(proxy: string, authority: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const call = request(proxy, { method: 'CONNECT', path: authority, agent: false })
    onTestFinished(() => { call.destroy() })
    call.once('error', reject)
    call.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) { socket.destroy(); reject(new Error(`CONNECT failed: ${String(response.statusCode)}`)); return }
      const chunks: Buffer[] = [head]
      onTestFinished(() => { socket.destroy() })
      socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      socket.once('error', reject)
      socket.once('end', () => { resolve(Buffer.concat(chunks).toString()) })
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`)
    })
    call.end()
  })
}

it('routes only GitHub CONNECT to the node while an unknown tarball and scoped registry remain direct', async () => {
  const target = await origin()
  const remote = await upstream(target.server)
  const { operation } = await router(remote.url)
  expect(await connect(operation.env.HTTPS_PROXY as string, 'github.com:443', '/github-package.tgz')).toContain('third-party-package')
  expect(await get(operation.env.HTTP_PROXY as string, `${target.url}/@custom-scope%2fpackage`)).toBe('third-party-package')
  expect(await connect(operation.env.HTTPS_PROXY as string, target.authority, '/unknown-cdn/package.tgz')).toContain('third-party-package')
  expect(target.paths).toEqual(['/github-package.tgz', '/@custom-scope%2fpackage', '/unknown-cdn/package.tgz'])
  expect(remote.hosts).toEqual(['github.com'])
})

it('keeps custom registry and tarball hosts on their original proxy rather than the GitHub node', async () => {
  const target = await origin()
  const remote = await upstream(target.server)
  const original = await upstream(target.server)
  const { operation } = await router(remote.url, { HTTP_PROXY: original.url, HTTPS_PROXY: original.url })
  expect(await get(operation.env.HTTP_PROXY as string, 'http://registry.private.example/@custom%2fpackage')).toBe('original-proxy-response')
  expect(await connect(operation.env.HTTPS_PROXY as string, 'external-cdn.example:443', '/package.tgz')).toContain('third-party-package')
  expect(await connect(operation.env.HTTPS_PROXY as string, 'codeload.github.com:443', '/github.tar.gz')).toContain('third-party-package')
  expect(original.hosts).toEqual(['registry.private.example', 'external-cdn.example'])
  expect(remote.hosts).toEqual(['codeload.github.com'])
})

it('retains effective user/profile npmrc precedence and keeps their original proxy for a registry and unknown tarball', async () => {
  const target = await origin()
  const remote = await upstream(target.server)
  const original = await upstream(target.server)
  const dir = await mkdtemp(join(tmpdir(), 'plugin-manager-pnpm-original-proxy-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const pnpm = fileURLToPath(new URL('../../../../apps/desktop/node_modules/pnpm/bin/pnpm.mjs', import.meta.url))
  const user = join(dir, 'user.npmrc')
  await writeFile(user, `https-proxy=${remote.url}\nhttp-proxy=${remote.url}\n`)
  await writeFile(join(dir, 'package.json'), '{"name":"original-proxy-fixture","private":true}')
  await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n')
  await writeFile(join(dir, '.npmrc'), `https-proxy=${original.url}\nhttp-proxy=${original.url}\nno-proxy=direct.example\n`)
  const controller = new AbortController()
  onTestFinished(() => { controller.abort() })
  const before = { ...process.env }
  const env = await readPnpmProxyEnvironment(dir, {
    command: process.execPath, args: ['--expose-internals', pnpm],
    env: { ...DIRECT_ENV, pnpm_config_userconfig: user }, signal: controller.signal, timeoutMs: 4000,
  })
  expect(new URL(env.https_proxy as string).origin).toBe(original.url)
  expect(env.no_proxy).toBe('direct.example')
  const { operation } = await router(remote.url, { ...env })
  expect(await get(operation.env.HTTP_PROXY as string, 'http://registry.private.example/@custom%2fpackage')).toBe('original-proxy-response')
  expect(await connect(operation.env.HTTPS_PROXY as string, 'external-cdn.example:443', '/package.tgz')).toContain('third-party-package')
  expect(await connect(operation.env.HTTPS_PROXY as string, 'github.com:443', '/github-package.tgz')).toContain('third-party-package')
  expect(original.hosts).toEqual(['registry.private.example', 'external-cdn.example'])
  expect(remote.hosts).toEqual(['github.com'])
  expect(process.env).toEqual(before)
})

it('keeps workspace YAML proxy settings ahead of npmrc and ambient proxy variables', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-manager-pnpm-yaml-proxy-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const pnpm = fileURLToPath(new URL('../../../../apps/desktop/node_modules/pnpm/bin/pnpm.mjs', import.meta.url))
  await writeFile(join(dir, 'package.json'), '{"name":"yaml-proxy-fixture","private":true}')
  await writeFile(join(dir, '.npmrc'), 'https-proxy=http://ini-proxy.example:1234\nno-proxy=ini-direct.example\n')
  await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages: []\nhttpsProxy: http://yaml-proxy.example:5678\nhttpProxy: http://yaml-proxy.example:5678\nnoProxy: yaml-direct.example\n')
  const controller = new AbortController()
  onTestFinished(() => { controller.abort() })
  const env = await readPnpmProxyEnvironment(dir, {
    command: process.execPath, args: ['--expose-internals', pnpm],
    env: { ...DIRECT_ENV, HTTPS_PROXY: 'http://environment-proxy.example:9012' }, signal: controller.signal, timeoutMs: 4000,
  })
  expect(new URL(env.https_proxy as string).origin).toBe('http://yaml-proxy.example:5678')
  expect(new URL(env.http_proxy as string).origin).toBe('http://yaml-proxy.example:5678')
  expect(env.no_proxy).toBe('yaml-direct.example')
})

it('closes a live CONNECT tunnel and its listener when cancelled', async () => {
  const target = await origin()
  const remote = await upstream(target.server)
  const { operation, controller } = await router(remote.url)
  const call = request(operation.env.HTTPS_PROXY as string, { method: 'CONNECT', path: 'github.com:443', agent: false })
  onTestFinished(() => { call.destroy() })
  const connected = once(call, 'connect')
  call.end()
  const [response, socket] = await connected as [IncomingMessage, Socket]
  expect(response.statusCode).toBe(200)
  const closed = once(socket, 'close')
  controller.abort()
  await operation.closed
  await closed
  await operation.close()
  await expect(get(operation.env.HTTP_PROXY as string, `${target.url}/after-close`)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
})

it('closes a direct third-party CONNECT target when cancelled', async () => {
  const target = await origin()
  const accepted = once(target.server, 'connection')
  const { operation, controller } = await router()
  const call = request(operation.env.HTTPS_PROXY as string, { method: 'CONNECT', path: target.authority, agent: false })
  onTestFinished(() => { call.destroy() })
  const connected = once(call, 'connect')
  call.end()
  const [, client] = await connected as [IncomingMessage, Socket]
  const [destination] = await accepted as [Socket]
  const destinationClosed = once(destination, 'close')
  const clientClosed = once(client, 'close')
  controller.abort()
  await operation.closed
  await clientClosed
  await destinationClosed
})

it('resolves GitHub proxy and SSH overrides without changing Git files or other hosts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-manager-github-proxy-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const config = join(dir, 'git.config')
  await writeFile(config, '[http]\n proxy = https://existing-proxy.example\n')
  const { operation } = await router(normalizeGithubProxy('https://GITHUB-PROXY.example:8443/'),
    { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' })
  const run = childCommands(dir, operation.env)
  const read = (args: string[]) => run('git', ['config', ...args])
  expect((await read(['--get-urlmatch', 'http.proxy', 'https://github.com/acme/plugin.git'])).stdout).toBe(operation.env.HTTPS_PROXY)
  expect((await read(['--get-urlmatch', 'http.proxy', 'https://gitlab.com/acme/plugin.git'])).stdout).toBe('https://existing-proxy.example')
  expect((await read(['--get-all', 'url.https://github.com/.insteadOf'])).stdout.split('\n')).toEqual([
    'git@github.com:', 'ssh://git@github.com/', 'ssh://git@github.com:22/', 'http://github.com/',
  ])
  expect(await readFile(config, 'utf8')).toBe('[http]\n proxy = https://existing-proxy.example\n')
})

it('passes local routing and bypass settings to the bundled pnpm configuration reader', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-manager-pnpm-proxy-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const pnpm = fileURLToPath(new URL('../../../../apps/desktop/node_modules/pnpm/bin/pnpm.mjs', import.meta.url))
  await writeFile(join(dir, 'package.json'), '{"name":"proxy-config-fixture","private":true}')
  const { operation } = await router()
  const run = childCommands(dir, operation.env)
  const read = (setting: string) => run(process.execPath, ['--expose-internals', pnpm, 'config', 'get', setting])
  expect((await read('https-proxy')).stdout).toBe(`${operation.env.HTTPS_PROXY}/`)
  expect((await read('no-proxy')).stdout).toBe(operation.env.NO_PROXY)
})

it('does not select registry packages, local paths, or other Git hosts for GitHub routing', () => {
  for (const spec of ['@acme/plugin', 'https://gitlab.com/acme/plugin.git', 'https://github.com.evil.example/acme/plugin.git']) {
    expect(isGithubProxySpec(parseInstallSpec(spec))).toBe(false)
  }
})
