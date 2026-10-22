/** Independent Hosts contend on real file locks and retain a newer synthetic login. */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { expect, it, onTestFinished } from 'vitest'
import { writePrivateState } from '../src/private-state-file.ts'
import type { StoredSession } from '../src/session-refresh.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function latch() {
  const { promise, resolve } = deferred<undefined>()
  return { promise, resolve: () => { resolve(undefined) } }
}

async function scenario(status: number, newAccount?: number): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-refresh-process-'))
  const path = join(directory, 'session.json')
  const release = latch(), received = latch()
  const children: Array<ReturnType<typeof start>> = []
  const requests: string[] = []
  const server = createServer((request, response) => {
    request.resume()
    requests.push(request.headers.cookie ?? '')
    received.resolve()
    void release.promise.then(() => {
      response.writeHead(status, { 'content-type': 'application/json',
        ...status === 429 ? { 'retry-after': '60' } : {},
        ...status === 200 ? { 'set-cookie': 'new_api_refresh=sid.secret-two; HttpOnly' } : {} })
      response.end(status === 200 ? JSON.stringify({ success: true, data: {
        access_token: 'access-new', access_expires_at: Math.floor(Date.now() / 1000) + 900, user: { id: 7 },
      } }) : '')
    })
  })
  onTestFinished(async () => {
    release.resolve()
    for (const child of children) if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill()
    await Promise.all(children.map(child => child.exit))
    await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
    await rm(directory, { recursive: true, force: true })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Loopback fixture not bound')
  const base = `http://127.0.0.1:${String(address.port)}`
  const previous: StoredSession & { token: string } = { token: 'fixture-owner-one', backendBaseUrl: base,
    expiresAt: '2099-01-01T00:00:00Z', account: { id: '7', phone: '***0000' },
    upstream: { token: 'access-old', refresh: 'sid.secret-one', expiresAt: '2000-01-01T00:00:00Z' } }
  await writePrivateState(path, JSON.stringify(previous))

  function start() {
    const ready = latch(), started = latch(), probe = deferred<boolean>(), done = deferred<boolean>()
    const process = spawn(globalThis.process.execPath, ['--import', 'tsx/esm',
      fileURLToPath(new URL('./fixtures/session-refresh-process.ts', import.meta.url)), path, base],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let stderr = ''
    process.stdout?.resume()
    process.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    process.on('message', (message: unknown) => {
      if (message === null || typeof message !== 'object' || !('kind' in message)) return
      if (message.kind === 'ready') ready.resolve()
      else if (message.kind === 'started') started.resolve()
      else if (message.kind === 'probe' && 'waiting' in message) probe.resolve(message.waiting === true)
      else if (message.kind === 'done' && 'renewed' in message) done.resolve(message.renewed === true)
    })
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      process.once('exit', (code, signal) => { resolve({ code, signal }) })
    })
    return { process, ready: ready.promise, started: started.promise, probe: probe.promise,
      done: done.promise, exit, stderr: () => stderr }
  }

  children.push(start(), start())
  await Promise.all(children.map(child => child.ready))
  for (const child of children) child.process.send('go')
  await Promise.all(children.map(child => child.started))
  await received.promise
  for (const child of children) child.process.send('probe')
  expect((await Promise.all(children.map(child => child.probe))).some(Boolean)).toBe(true)
  let replacement: StoredSession | undefined
  if (newAccount !== undefined) {
    replacement = { ...previous, token: 'fixture-new-login', account: { id: String(newAccount), phone: '***2222' },
      upstream: { token: 'new-login-access', refresh: 'new-session.cookie', expiresAt: '2099-01-01T00:00:00Z' } }
    await withFileLock(path, async () => { await writePrivateState(path, JSON.stringify(replacement)) })
  }
  release.resolve()
  expect(await Promise.all(children.map(child => child.done))).toEqual([status === 200, status === 200])
  for (const child of children) {
    const result = await child.exit
    expect(result.signal, child.stderr()).toBeNull()
    expect(result.code, child.stderr()).toBe(0)
  }
  expect(requests).toEqual(['new_api_refresh=sid.secret-one'])
  const saved = JSON.parse(await readFile(path, 'utf8')) as StoredSession
  expect(saved).toMatchObject(replacement ?? (status === 200 ? { upstream: { token: 'access-new', refresh: 'sid.secret-two' } } : previous))
}

it('makes simultaneous Hosts perform exactly one successful rotation', async () => { await scenario(200) })
it('makes a second Host observe the first Host empty-429 cooldown', async () => { await scenario(429) })
it.each([7, 8])('preserves a new login for account %s after another Host old401', async (id) => { await scenario(401, id) })
