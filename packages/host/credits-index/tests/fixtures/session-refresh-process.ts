/** One isolated library-test process sharing only a synthetic account document. */
import { readFile } from 'node:fs/promises'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { SessionRefresh, type StoredSession } from '../../src/session-refresh.ts'
import { writePrivateState } from '../../src/private-state-file.ts'

const path = process.argv[2]
const origin = new URL(process.argv[3] ?? '')
if (path === undefined || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') throw new Error('Expected owned loopback fixture')
const store = {
  path,
  async read(): Promise<StoredSession | null> {
    const session = JSON.parse(await readFile(path, 'utf8')) as StoredSession
    return session.token === undefined ? null : session
  },
  async write(session: StoredSession & { token: string }): Promise<void> {
    await writePrivateState(path, JSON.stringify(session))
  },
}
const previous = await store.read()
if (previous === null) throw new Error('Synthetic session is missing')
const mutate = async <T>(operation: () => Promise<T>): Promise<T> => await withFileLock(path, operation)
const renewal = new SessionRefresh({
  store, mutate, baseUrl: origin.origin, timeoutMs: 5000, retryBaseDelayMs: 1000,
  retryMaxDelayMs: 60_000, recoveryRetryLimit: 1, version: () => 0,
  unavailable: () => {},
  fetch: async (cookie, signal) => await fetch(new URL('/refresh', origin), {
    method: 'POST', headers: { cookie: `new_api_refresh=${cookie}` }, body: '{}', signal,
  }),
  unauthorized: async captured => await mutate(async () => {
    const current = await store.read()
    if (current === null || current.token !== captured.token || current.upstream?.refresh !== captured.upstream?.refresh) return false
    await writePrivateState(path, '{}')
    return true
  }),
})
let pending = false
async function run(): Promise<void> {
  pending = true
  const operation = renewal.refresh(previous!)
  process.send?.({ kind: 'started' })
  const result = await operation
  pending = false
  await renewal.dispose()
  process.send?.({ kind: 'done', renewed: result?.upstream?.token === 'access-new' })
  process.disconnect()
}
process.on('message', (message: unknown) => {
  if (message === 'go') {
    void run().catch(async () => {
      await renewal.dispose()
      process.send?.({ kind: 'failed' })
      process.exitCode = 1
      process.disconnect()
    })
  } else if (message === 'probe') {
    void readFile(`${path}.renewal.lock`, 'utf8').then((owner) => {
      process.send?.({ kind: 'probe', waiting: pending && Number(owner.trim()) !== process.pid })
    }, () => { process.send?.({ kind: 'probe', waiting: false }) })
  }
})
process.send?.({ kind: 'ready' })
