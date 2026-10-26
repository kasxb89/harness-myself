/** Cross-process image invocation claims retain original operations without paid retries. */
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ImageInvocationStore } from '../src/image-invocation.ts'
import type { CreativeOwner, CreativeProjectId, CreativeOperationId } from '../src/creative-store.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'image-invocation-')))
  directories.push(root)
  const owner: CreativeOwner = { accountId: 'account-one', sessionFingerprint: 'login-one', sessionId: 'chat-one', workspaceRoot: root }
  let live = { accountId: owner.accountId, sessionFingerprint: owner.sessionFingerprint }
  const options = { directory: join(root, 'claims'), apiBaseUrl: 'https://8.133.202.230/harness', current: async () => live }
  const source = { sourceSeq: 4, rootCallId: 'root-call-one', callId: 'call-one' }
  const link = { projectId: 'cp_00000000-0000-0000-0000-000000000001' as CreativeProjectId,
    operationId: 'op_00000000-0000-0000-0000-000000000001' as CreativeOperationId }
  return { root, owner, source, options, link, store: new ImageInvocationStore(options), setLive: (next: typeof live) => { live = next } }
}

describe('durable image submission identity', () => {
  it('admits exactly one of eight independent instances then replays original coordinates after restart', async () => {
    const f = await fixture()
    const outcomes = await Promise.all(Array.from({ length: 8 },
      async () => await new ImageInvocationStore(f.options).claim(f.owner, f.source)))
    expect(outcomes.filter(value => value.kind === 'claimed')).toHaveLength(1)
    expect(outcomes.filter(value => value.kind === 'existing')).toHaveLength(7)
    const winner = outcomes.find(value => value.kind === 'claimed')
    if (winner?.kind !== 'claimed') throw new Error('missing exclusive claim')
    const linked = await f.store.attach(winner.claim, f.link)
    expect(linked).toMatchObject({ state: 'linked', link: f.link })
    expect(await new ImageInvocationStore(f.options).claim(f.owner, f.source)).toEqual({ kind: 'existing', view: linked })
    expect(await f.store.attach(winner.claim, f.link)).toEqual(linked)
    await expect(f.store.attach(winner.claim, { ...f.link, operationId: 'op_other' as CreativeOperationId }))
      .rejects.toMatchObject({ code: 'IMAGE_INVOCATION_INVALID' })
  })
  it('retains an orphan preparing claim and permits independent new human requests and calls', async () => {
    const f = await fixture()
    const first = await f.store.claim(f.owner, f.source)
    expect(first.kind).toBe('claimed')
    expect(await new ImageInvocationStore(f.options).claim(f.owner, f.source)).toMatchObject({ kind: 'existing', view: { state: 'preparing' } })
    expect((await f.store.claim(f.owner, { ...f.source, sourceSeq: 20 })).kind).toBe('claimed')
    expect((await f.store.claim(f.owner, { ...f.source, callId: 'second-requested-image' })).kind).toBe('claimed')
    expect((await f.store.claim({ ...f.owner, sessionId: 'another-chat' }, f.source)).kind).toBe('claimed')
  })
  it('distinguishes real root-call sequences when a provider reuses call ids within the same human request', async () => {
    const f = await fixture()
    const first = await f.store.claim(f.owner, { ...f.source, rootCallSeq: 10 })
    expect(first.kind).toBe('claimed')
    const replay = await new ImageInvocationStore(f.options).claim(f.owner, { ...f.source, rootCallSeq: 10 })
    expect(replay).toMatchObject({ kind: 'existing', view: first.view })
    const next = await f.store.claim(f.owner, { ...f.source, rootCallSeq: 20 })
    expect(next.kind).toBe('claimed')
    expect(next.view.invocationId).not.toBe(first.view.invocationId)
    expect((await f.store.claim(f.owner, f.source)).kind).toBe('claimed')
    expect((await new ImageInvocationStore(f.options).claim(f.owner, f.source)).kind).toBe('existing')
  })
  it('isolates login, account and API identities without persisting prompts or credentials', async () => {
    const f = await fixture()
    const first = await f.store.claim(f.owner, f.source)
    const other = { ...f.owner, accountId: 'account-two', sessionFingerprint: 'login-two' }
    f.setLive(other)
    await expect(f.store.claim(f.owner, f.source)).rejects.toMatchObject({ code: 'CREATIVE_ACCOUNT_CHANGED' })
    const second = await f.store.claim(other, f.source)
    expect(first.view.invocationId).not.toBe(second.view.invocationId)
    const api = new ImageInvocationStore({ ...f.options, apiBaseUrl: 'https://other.example/harness' })
    expect((await api.claim(other, f.source)).view.invocationId).not.toBe(second.view.invocationId)
    const raw = await readFile(join(f.options.directory, `${first.view.invocationId}.json`), 'utf8')
    expect(raw).not.toMatch(/prompt|access_token|refresh|sk-/u)
  })
  it('refuses corrupted durable claims instead of treating them as a fresh submit', async () => {
    const f = await fixture()
    const first = await f.store.claim(f.owner, f.source)
    await writeFile(join(f.options.directory, `${first.view.invocationId}.json`), '{"version":1}')
    await expect(f.store.claim(f.owner, f.source)).rejects.toMatchObject({ code: 'IMAGE_INVOCATION_INVALID' })
  })
})
