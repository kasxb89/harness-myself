import { mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CreativeOwner, CreativeOperationId, CreativeProjectId } from '../src/creative-store.ts'
import type { VideoProjectId } from '../src/video-project.ts'
import { VideoWorkStore, type VideoWorkLink, type VideoWorkRevision, type VideoWorkSource } from '../src/video-work-store.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'video-work-store-')))
  directories.push(root)
  const owner: CreativeOwner = { accountId: 'account-1', sessionFingerprint: 'login-1', sessionId: 'chat-1', workspaceRoot: root }
  let live = { accountId: owner.accountId, sessionFingerprint: owner.sessionFingerprint }
  const options = { directory: join(root, 'works'), current: async () => live }
  const source: VideoWorkSource = { messageId: 'human-1', sourceSeq: 4, turn: 1, callId: 'call-1', rootCallSeq: 8 }
  return { root, owner, source, options, store: new VideoWorkStore(options), setLive: (next: typeof live) => { live = next } }
}

function link(index = 1): VideoWorkLink {
  const suffix = String(index).padStart(12, '0')
  return { projectId: `cp_00000000-0000-0000-0000-${suffix}` as CreativeProjectId,
    operationId: `op_${String(index)}` as CreativeOperationId,
    videoProjectId: `vp_00000000-0000-0000-0000-${suffix}` as VideoProjectId }
}

describe('durable finished-video works', () => {
  it('prepares one by default and does not expand or reset it after call-id or count changes', async () => {
    const { store, owner, source } = await fixture()
    const first = await store.prepare(owner, source)
    expect(first.works).toHaveLength(1)
    expect(first.works[0]).toMatchObject({ index: 1, state: 'prepared' })
    expect(await store.prepare(owner, { ...source, callId: 'model-retry', rootCallSeq: 20 }, 10)).toEqual(first)
    const claimed = await store.claim(owner, source)
    expect(claimed.kind).toBe('claimed')
    expect((await store.prepare(owner, source, 100)).works).toEqual([claimed.work])
  })

  it('creates independent work lists for new real messages, sequence numbers and chats regardless of identical content', async () => {
    const { store, owner, source } = await fixture()
    const original = await store.prepare(owner, source)
    const second = await store.prepare(owner, { ...source, messageId: 'human-2', sourceSeq: 20 })
    const renumbered = await store.prepare(owner, { ...source, sourceSeq: 30 })
    const otherChat = await store.prepare({ ...owner, sessionId: 'chat-2' }, source)
    expect(new Set([original, second, renumbered, otherChat].map(batch => batch.requestId)).size).toBe(4)
    expect(new Set([original, second, renumbered, otherChat].map(batch => batch.works[0]!.workId)).size).toBe(4)
  })

  it('gives exactly one claim to concurrent independent instances and retains preparing across restart', async () => {
    const { store, owner, source, options } = await fixture()
    const other = new VideoWorkStore(options)
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      (index % 2 === 0 ? store : other).claim(owner, { ...source, callId: `retry-${String(index)}` })))
    expect(results.filter(result => result.kind === 'claimed')).toHaveLength(1)
    expect(results.filter(result => result.kind === 'existing')).toHaveLength(11)
    expect(new Set(results.map(result => result.work.workId)).size).toBe(1)
    const restarted = await new VideoWorkStore(options).claim(owner, { ...source, callId: 'after-restart' })
    expect(restarted).toMatchObject({ kind: 'existing', work: { state: 'preparing' } })
    expect(restarted).not.toHaveProperty('claim')
    expect(JSON.stringify(restarted)).not.toContain('nonce')
  })

  it('claims only specifically prepared slots, preserving every other pending work', async () => {
    const { store, owner, source } = await fixture()
    const batch = await store.prepare(owner, source, 3)
    const middle = await store.claim(owner, source, batch.works[1]!.workId)
    expect(middle).toMatchObject({ kind: 'claimed', work: { index: 2, state: 'preparing' } })
    expect(await store.pending(owner, middle.work.workId)).toEqual([batch.works[0]!.workId, batch.works[2]!.workId])
    await expect(store.claim(owner, source, batch.works[0]!.workId.replace(/_1$/u, '_4')))
      .rejects.toMatchObject({ code: 'VIDEO_WORK_INVALID' })
    expect((await store.claim(owner, source)).work.index).toBe(1)
  })

  it('keeps a linked original operation across retry, restart and attempted release', async () => {
    const { store, owner, source, options } = await fixture()
    const result = await store.claim(owner, source)
    if (result.kind !== 'claimed') throw new Error('expected unique claim')
    const linked = await store.attach(result.claim, link())
    expect(linked).toMatchObject({ state: 'linked', link: link() })
    expect(await store.attach(result.claim, link())).toEqual(linked)
    expect(await store.release(result.claim)).toBe(false)
    await expect(store.attach(result.claim, link(2))).rejects.toMatchObject({ code: 'VIDEO_WORK_INVALID' })
    const restarted = await new VideoWorkStore(options).claim(owner, { ...source, callId: 'new-call-after-unknown' })
    expect(restarted).toMatchObject({ kind: 'existing', work: linked })
    expect(await store.pending(owner, linked.workId)).toEqual([])
  })

  it('releases an unlinked preparation once and refuses a stale nonce after a new claim', async () => {
    const { store, owner, source, options } = await fixture()
    const first = await store.claim(owner, source)
    if (first.kind !== 'claimed') throw new Error('expected initial claim')
    expect(await store.release(first.claim)).toBe(true)
    const next = await new VideoWorkStore(options).claim(owner, source)
    if (next.kind !== 'claimed') throw new Error('expected replacement claim')
    expect(next.claim.nonce).not.toBe(first.claim.nonce)
    await expect(store.release(first.claim)).rejects.toMatchObject({ code: 'VIDEO_WORK_INVALID' })
    await expect(store.attach(first.claim, link())).rejects.toMatchObject({ code: 'VIDEO_WORK_INVALID' })
    expect(await store.claim(owner, source)).toMatchObject({ kind: 'existing', work: { state: 'preparing' } })
    expect(await store.attach(next.claim, link())).toMatchObject({ state: 'linked' })
  })

  it.each([false, true])('retains cancellation without reviving work or losing an existing link (%s)', async (attached) => {
    const { store, owner, source, options } = await fixture()
    const result = await store.claim(owner, source)
    if (result.kind !== 'claimed') throw new Error('expected claim')
    if (attached) await store.attach(result.claim, link())
    const cancelled = await store.cancel(result.claim)
    expect(cancelled).toMatchObject({ state: 'cancelled', ...attached ? { link: link() } : {} })
    expect(await store.release(result.claim)).toBe(false)
    await expect(store.attach(result.claim, link())).rejects.toMatchObject({ code: 'VIDEO_WORK_INVALID' })
    expect(await new VideoWorkStore(options).claim(owner, source)).toMatchObject({ kind: 'existing', work: cancelled })
  })

  it('adopts only existing original-source operations and never creates extra slots beside legacy unknown work', async () => {
    const { store, owner, source, options } = await fixture()
    const batch = await store.prepare(owner, source, 5, [link(), link(2)])
    expect(batch.works).toHaveLength(2)
    expect(batch.works.map(work => work.state)).toEqual(['linked', 'linked'])
    expect(batch.works.map(work => work.link)).toEqual([link(), link(2)])
    expect(await store.claim(owner, { ...source, callId: 'new-model-call' })).toMatchObject({ kind: 'existing', work: batch.works[0] })
    expect(await new VideoWorkStore(options).prepare(owner, source, 8)).toEqual(batch)
    expect(await store.pending(owner, batch.works[1]!.workId)).toEqual([])
    expect((await store.prepare(owner, { ...source, messageId: 'new-human', sourceSeq: 100 })).works[0]?.state).toBe('prepared')
  })

  it('does not treat a missing claim as prepared when the original creation operation still exists', async () => {
    const { store, owner, source, options } = await fixture()
    const claimed = await store.claim(owner, source)
    if (claimed.kind !== 'claimed') throw new Error('expected claim')
    await store.attach(claimed.claim, link())
    await unlink(join(options.directory, `${claimed.work.workId}.json`))
    await expect(new VideoWorkStore(options).prepare(owner, source, 1, [link()]))
      .rejects.toMatchObject({ code: 'VIDEO_WORK_INVALID' })
  })

  it('retains an operation created before attaching its link without reviving its reserved work', async () => {
    const { store, owner, source, options } = await fixture()
    const claimed = await store.claim(owner, source)
    expect(claimed.kind).toBe('claimed')
    expect((await new VideoWorkStore(options).prepare(owner, source, 1, [link()])).works)
      .toEqual([{ ...claimed.work, state: 'preparing' }])
  })

  it.each(['chat', 'workspace', 'account'] as const)('rejects an explicit work id from another %s', async (scope) => {
    const { store, owner, source, setLive } = await fixture()
    const batch = await store.prepare(owner, source)
    const foreign = { ...owner, ...scope === 'chat' ? { sessionId: 'other-chat' }
      : scope === 'workspace' ? { workspaceRoot: join(owner.workspaceRoot, 'other') } : { accountId: 'other-account' } }
    if (scope === 'account') setLive({ accountId: foreign.accountId, sessionFingerprint: foreign.sessionFingerprint })
    await expect(store.claim(foreign, source, batch.works[0]!.workId)).rejects.toMatchObject({ code: 'CREATIVE_ACCESS_DENIED' })
    await expect(store.pending(foreign, batch.works[0]!.workId)).rejects.toMatchObject({ code: 'CREATIVE_ACCESS_DENIED' })
  })

  it('rejects a stale login but lets the same account observe the original work after signing in again', async () => {
    const { store, owner, source, setLive } = await fixture()
    const result = await store.claim(owner, source)
    if (result.kind !== 'claimed') throw new Error('expected claim')
    setLive({ accountId: owner.accountId, sessionFingerprint: 'login-2' })
    await expect(store.attach(result.claim, link())).rejects.toMatchObject({ code: 'CREATIVE_ACCOUNT_CHANGED' })
    await expect(store.claim(owner, source)).rejects.toMatchObject({ code: 'CREATIVE_ACCOUNT_CHANGED' })
    expect(await store.claim({ ...owner, sessionFingerprint: 'login-2' }, source)).toMatchObject({
      kind: 'existing', work: { workId: result.work.workId, state: 'preparing' },
    })
  })

  it.each(['broken-json', 'unknown-field', 'oversize', 'symlink'] as const)('does not reinterpret a damaged claim as an unsubmitted work: %s', async (damage) => {
    const { store, owner, source, options, root } = await fixture()
    const result = await store.claim(owner, source)
    const path = join(options.directory, `${result.work.workId}.json`)
    if (damage === 'broken-json') await writeFile(path, '{')
    else if (damage === 'oversize') await writeFile(path, ' '.repeat(2 * 1024 * 1024 + 1))
    else if (damage === 'unknown-field') {
      const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      await writeFile(path, JSON.stringify({ ...record, unexpected: true }))
    } else {
      const target = join(root, 'unrelated.json')
      await writeFile(target, '{}')
      await unlink(path)
      await symlink(target, path)
    }
    await expect(new VideoWorkStore(options).claim(owner, source)).rejects.toMatchObject({
      code: damage === 'broken-json' ? 'VIDEO_WORK_UNAVAILABLE' : 'VIDEO_WORK_INVALID',
    })
  })

  it('does not follow a symlinked storage directory', async () => {
    const { store, owner, source, options, root } = await fixture()
    await store.prepare(owner, source)
    await rm(options.directory, { recursive: true })
    const target = join(root, 'target')
    await symlink(root, options.directory)
    await expect(new VideoWorkStore(options).prepare(owner, source)).rejects.toMatchObject({ code: 'VIDEO_WORK_INVALID' })
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('bounds complete record bytes without imposing the old conversational work-count ceiling', async () => {
    const { store, owner, source } = await fixture()
    const batch = await store.prepare(owner, source, 1200)
    expect(batch.works).toHaveLength(1200)
    await expect(store.prepare(owner, { ...source, messageId: 'too-large' }, 1_000_000_000))
      .rejects.toMatchObject({ code: 'VIDEO_WORK_LIMIT' })
  })

  it.each([0, -1, 1.2, NaN, Infinity])('refuses an invalid concrete list size %s without claiming anything', async (count) => {
    const { store, owner, source } = await fixture()
    await expect(store.prepare(owner, source, count)).rejects.toMatchObject({ code: 'VIDEO_WORK_INVALID' })
    expect((await store.prepare(owner, source)).works).toHaveLength(1)
  })
})

describe('real reply additions to finished-video work lists', () => {
  const reply: VideoWorkRevision = { messageId: 'real-answer-1', seq: 20 }

  it('appends only additional works after a real answer and preserves the original claim and task association', async () => {
    const { store, owner, source, options } = await fixture()
    const first = await store.claim(owner, source)
    if (first.kind !== 'claimed') throw new Error('expected original claim')
    await store.attach(first.claim, link())
    const claimPath = join(options.directory, `${first.work.workId}.json`)
    const originalClaim = await readFile(claimPath, 'utf8')
    const expanded = await store.append(owner, source, 2, reply)
    expect(expanded.requestId).toBe(first.batch.requestId)
    expect(expanded.works).toHaveLength(3)
    expect(expanded.works[0]).toMatchObject({ workId: first.work.workId, index: 1, state: 'linked', link: link() })
    expect(expanded.works.slice(1).map(work => ({ index: work.index, state: work.state })))
      .toEqual([{ index: 2, state: 'prepared' }, { index: 3, state: 'prepared' }])
    expect(await store.pending(owner, first.work.workId)).toEqual(expanded.works.slice(1).map(work => work.workId))
    expect(await readFile(claimPath, 'utf8')).toBe(originalClaim)
    expect(await store.claim(owner, source, first.work.workId)).toMatchObject({ kind: 'existing', work: expanded.works[0] })
    const saved: unknown = JSON.parse(await readFile(join(options.directory, `${expanded.requestId}.json`), 'utf8'))
    expect(saved).toMatchObject({ version: 2, preparedCount: 1, preparedRevision: { messageId: source.messageId, seq: source.sourceSeq },
      revisions: [{ revision: reply, count: 2, startIndex: 2, endIndex: 3 }] })
  })

  it('consumes a real reply only once across independent concurrent stores, changed counts and restart', async () => {
    const { store, owner, source, options } = await fixture()
    const initial = await store.prepare(owner, source)
    const expanded = await Promise.all(Array.from({ length: 8 }, () => new VideoWorkStore(options).append(owner, source, 2, reply)))
    expect(expanded.every(batch => batch.requestId === initial.requestId && batch.works.length === 3)).toBe(true)
    const restarted = await new VideoWorkStore(options).append(owner, source, 9, reply)
    expect(restarted).toEqual(expanded[0])
    expect(await store.prepare(owner, source, 20)).toEqual(restarted)
  })

  it('does not append again when the same real reply already prepared the initial list', async () => {
    const { store, owner, source } = await fixture()
    const prepared = await store.prepare(owner, source, 3, [], reply)
    expect(await store.append(owner, source, 3, reply)).toEqual(prepared)
    const later = { messageId: 'real-answer-2', seq: 30 }
    const expanded = await store.append(owner, source, 2, later)
    expect(expanded.works).toHaveLength(5)
    expect(await store.append(owner, source, 20, reply)).toEqual(expanded)
  })

  it('does not consume a new reply merely by reading an already prepared list', async () => {
    const { store, owner, source } = await fixture()
    const initial = await store.prepare(owner, source)
    expect(await store.prepare(owner, source, 3, [], reply)).toEqual(initial)
    expect((await store.append(owner, source, 2, reply)).works).toHaveLength(3)
  })

  it('adopts legacy tasks without consuming a new reply or adding new empty works during adoption', async () => {
    const { store, owner, source, options } = await fixture()
    const adopted = await store.prepare(owner, source, 3, [link()], reply)
    expect(adopted.works).toHaveLength(1)
    expect(adopted.works[0]).toMatchObject({ state: 'linked', link: link() })
    const expanded = await store.append(owner, source, 2, reply)
    expect(expanded.works).toHaveLength(3)
    expect(expanded.works[0]).toEqual(adopted.works[0])
    expect(await new VideoWorkStore(options).append(owner, source, 2, reply)).toEqual(expanded)
  })

  it('upgrades a private v1 list without revision metadata while retaining all existing work ids', async () => {
    const { store, owner, source, options } = await fixture()
    const original = await store.prepare(owner, source, 2)
    const claimed = await store.claim(owner, source, original.works[0]!.workId)
    if (claimed.kind !== 'claimed') throw new Error('expected original claim')
    await store.attach(claimed.claim, link())
    const retained = await store.prepare(owner, source)
    const claimPath = join(options.directory, `${claimed.work.workId}.json`)
    const originalClaim = await readFile(claimPath, 'utf8')
    const path = join(options.directory, `${original.requestId}.json`)
    const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    saved.version = 1
    delete saved.preparedRevision
    delete saved.preparedCount
    delete saved.revisions
    await writeFile(path, JSON.stringify(saved))
    const expanded = await new VideoWorkStore(options).append(owner, source, 2, reply)
    expect(expanded.works).toHaveLength(4)
    expect(expanded.works.slice(0, 2)).toEqual(retained.works)
    expect(await readFile(claimPath, 'utf8')).toBe(originalClaim)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 2, preparedCount: 2,
      preparedRevision: { messageId: source.messageId, seq: source.sourceSeq },
      revisions: [{ revision: reply, count: 2, startIndex: 3, endIndex: 4 }] })
    expect(await new VideoWorkStore(options).append(owner, source, 2, reply)).toEqual(expanded)
  })

  it.each(['missing-history', 'missing-prepared-revision', 'missing-prepared-count', 'downgrade', 'unknown-version',
    'candidate-v1-history', 'candidate-v1-prepared', 'empty-history', 'truncated-history'] as const)(
    'refuses replay of an already consumed reply when batch history is damaged: %s', async (damage) => {
      const { store, owner, source, options } = await fixture()
      const original = await store.prepare(owner, source)
      await store.append(owner, source, 2, reply)
      await store.append(owner, source, 1, { messageId: 'later-answer', seq: 30 })
      const path = join(options.directory, `${original.requestId}.json`)
      const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      if (damage === 'missing-history') delete saved.revisions
      else if (damage === 'missing-prepared-revision') delete saved.preparedRevision
      else if (damage === 'missing-prepared-count') delete saved.preparedCount
      else if (damage === 'downgrade') saved.version = 1
      else if (damage === 'unknown-version') saved.version = 3
      else if (damage === 'empty-history') saved.revisions = []
      else if (damage === 'truncated-history') {
        if (!Array.isArray(saved.revisions)) throw new Error('expected persisted reply history')
        saved.revisions = saved.revisions.slice(0, 1)
      }
      else {
        saved.version = 1
        delete saved.preparedCount
        if (damage === 'candidate-v1-history') delete saved.preparedRevision
        else delete saved.revisions
      }
      await writeFile(path, JSON.stringify(saved))
      const damaged = await readFile(path, 'utf8')
      await expect(new VideoWorkStore(options).append(owner, source, 2, reply))
        .rejects.toMatchObject({ code: 'VIDEO_WORK_INVALID' })
      await expect(new VideoWorkStore(options).prepare(owner, source))
        .rejects.toMatchObject({ code: 'VIDEO_WORK_INVALID' })
      expect(await readFile(path, 'utf8')).toBe(damaged)
    },
  )

  it('rejects a source anchor or an unconsumed out-of-order reply without changing the list', async () => {
    const { store, owner, source, options } = await fixture()
    const initial = await store.prepare(owner, source, 1, [], reply)
    const path = join(options.directory, `${initial.requestId}.json`)
    const before = await readFile(path, 'utf8')
    for (const revision of [
      { messageId: source.messageId, seq: source.sourceSeq }, { messageId: source.messageId, seq: 30 },
      { messageId: 'unconsumed-older-answer', seq: 10 }, { messageId: 'different-answer-at-the-same-seq', seq: 20 },
      { messageId: reply.messageId, seq: 30 },
    ]) {
      await expect(store.append(owner, source, 2, revision)).rejects.toMatchObject({ code: 'VIDEO_WORK_INVALID' })
      expect(await readFile(path, 'utf8')).toBe(before)
    }
    await expect(store.append(owner, { ...source, turn: source.turn + 1 }, 2, { messageId: 'later-answer', seq: 30 }))
      .rejects.toMatchObject({ code: 'VIDEO_WORK_INVALID' })
    await expect(store.append(owner, { ...source, messageId: 'another-original-source' }, 2, reply))
      .rejects.toMatchObject({ code: 'VIDEO_WORK_INVALID' })
  })

  it('returns the current complete list for an already consumed older reply but rejects a new stale reply', async () => {
    const { store, owner, source } = await fixture()
    await store.prepare(owner, source)
    await store.append(owner, source, 1, reply)
    const current = await store.append(owner, source, 1, { messageId: 'later-answer', seq: 40 })
    expect(await store.append(owner, source, 99, reply)).toEqual(current)
    await expect(store.append(owner, source, 1, { messageId: 'unconsumed-middle-answer', seq: 30 }))
      .rejects.toMatchObject({ code: 'VIDEO_WORK_INVALID' })
  })

  it('requires an existing original work list rather than preparing one implicitly during append', async () => {
    const { store, owner, source } = await fixture()
    await expect(store.append(owner, source, 2, reply)).rejects.toMatchObject({ code: 'VIDEO_WORK_INVALID' })
    const initial = await store.prepare(owner, source)
    expect(initial.works).toHaveLength(1)
    expect((await store.append(owner, source, 2, reply)).works).toHaveLength(3)
  })

  it('rejects a stale login and a different chat or workspace before appending work', async () => {
    const { store, owner, source, setLive } = await fixture()
    await store.prepare(owner, source)
    await expect(store.append({ ...owner, sessionId: 'other-chat' }, source, 2, reply))
      .rejects.toMatchObject({ code: 'VIDEO_WORK_INVALID' })
    await expect(store.append({ ...owner, workspaceRoot: join(owner.workspaceRoot, 'other') }, source, 2, reply))
      .rejects.toMatchObject({ code: 'VIDEO_WORK_INVALID' })
    setLive({ accountId: owner.accountId, sessionFingerprint: 'next-login' })
    await expect(store.append(owner, source, 2, reply)).rejects.toMatchObject({ code: 'CREATIVE_ACCOUNT_CHANGED' })
  })

  it.each(['missing-revision', 'count-mismatch', 'range-gap', 'range-overlap', 'stale-revision', 'unknown-field'] as const)(
    'does not append after durable revision history damage: %s', async (damage) => {
      const { store, owner, source, options } = await fixture()
      const initial = await store.prepare(owner, source)
      await store.append(owner, source, 2, reply)
      const path = join(options.directory, `${initial.requestId}.json`)
      const saved = JSON.parse(await readFile(path, 'utf8')) as { revisions: Record<string, unknown>[] }
      const entry = saved.revisions[0]!
      if (damage === 'missing-revision') delete entry.revision
      else if (damage === 'count-mismatch') entry.count = 1
      else if (damage === 'range-gap') entry.startIndex = 3
      else if (damage === 'range-overlap') entry.startIndex = 1
      else if (damage === 'stale-revision') entry.revision = { messageId: 'stale', seq: source.sourceSeq }
      else entry.unknown = true
      await writeFile(path, JSON.stringify(saved))
      await expect(new VideoWorkStore(options).append(owner, source, 1, { messageId: 'next-answer', seq: 30 }))
        .rejects.toMatchObject({ code: 'VIDEO_WORK_INVALID' })
    },
  )

  it.each([0, -1, 1.2, NaN, Infinity])('does not consume the reply when its additional count is invalid: %s', async (count) => {
    const { store, owner, source } = await fixture()
    await store.prepare(owner, source)
    await expect(store.append(owner, source, count, reply)).rejects.toMatchObject({ code: 'VIDEO_WORK_INVALID' })
    expect((await store.append(owner, source, 2, reply)).works).toHaveLength(3)
  })

  it('checks complete metadata and list bytes before allocating an excessive addition', async () => {
    const { store, owner, source, options } = await fixture()
    const initial = await store.prepare(owner, source)
    const path = join(options.directory, `${initial.requestId}.json`)
    const before = await readFile(path, 'utf8')
    await expect(store.append(owner, source, 1_000_000_000, reply)).rejects.toMatchObject({ code: 'VIDEO_WORK_LIMIT' })
    expect(await readFile(path, 'utf8')).toBe(before)
    expect((await store.append(owner, source, 2, reply)).works).toHaveLength(3)
  })
})
