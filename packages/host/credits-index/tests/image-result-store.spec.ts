/** Original synchronous image results survive failed saves without another paid submission. */
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageResultStore, validateImageResultItems, type ImageResultScope, type ImageResultRef } from '../src/image-result-store.ts'
import { executeImageTask, type ImageTaskOptions } from '../src/image-task.ts'
import type { CreativeImageReceipt } from '../src/creative-types.ts'
import type { CreativeOperationId, CreativeOwner } from '../src/creative-store.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const fingerprint = 'a'.repeat(64)
const inline = { b64_json: Buffer.from('original-image').toString('base64') }
const remote = { url: 'https://images.example/original.png?signature=private-qa-signature' }
const receipt: CreativeImageReceipt = { model: 'image-qa', route: '/v1/images/generations',
  backendFingerprint: fingerprint, phase: 'submitting', requestId: 'original-sync-request' }

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'image-result-')))
  directories.push(root)
  const owner: CreativeOwner = { accountId: 'one', sessionFingerprint: 'login-one', sessionId: 'chat-one', workspaceRoot: root }
  let live = { accountId: owner.accountId, sessionFingerprint: owner.sessionFingerprint }
  const scope: ImageResultScope = { owner, operationId: 'op_original' as CreativeOperationId, backendFingerprint: fingerprint }
  const config = { directory: join(root, 'private-results'), current: async () => live, maxImageBytes: 1024, maxResponseBytes: 4096 }
  const store = new ImageResultStore(config)
  let ref: ImageResultRef | undefined
  const input = (changes: Partial<ImageTaskOptions> = {}): ImageTaskOptions => ({
    model: receipt.model, route: receipt.route, backendFingerprint: fingerprint, signal: new AbortController().signal,
    submitTimeoutMs: 1000, taskTimeoutMs: 3000, queryTimeoutMs: 100, pollIntervalMs: 1, queryRetryLimit: 0,
    responseMaxBytes: config.maxResponseBytes, imageMaxBytes: config.maxImageBytes,
    submit: vi.fn(async () => new Response(JSON.stringify({ data: [inline, remote] }), {
      headers: { 'x-oneapi-request-id': receipt.requestId! },
    })),
    read: vi.fn(async () => { throw new Error('Synchronous original results have no task GET') }),
    receivedResult: async (items, received) => { ref = await store.retain(scope, received, items) },
    savedResult: async (index, path) => {
      if (ref === undefined) throw new Error('Save cannot precede private result publication')
      await store.saved(scope, ref, index, path)
    },
    save: vi.fn(async (_item, index) => {
      if (ref === undefined) throw new Error('Save cannot precede private result publication')
      const path = join(root, `saved-${String(index)}.png`)
      await writeFile(path, 'original-image', { flag: 'wx' })
      return path
    }), ...changes,
  })
  return { root, owner, scope, config, store, input, getRef: () => {
    if (ref === undefined) throw new Error('Missing retained original result')
    return ref
  }, setLive: (next: typeof live) => { live = next } }
}

describe('private original image results', () => {
  it('retains synchronous URL and inline sources before saving, then recovers only the unsaved index after restart', async () => {
    const f = await fixture()
    const first = f.input()
    const save = first.save
    const failed = f.input({ save: vi.fn(async (item: Record<string, unknown>, index: number, signal: AbortSignal) => {
      if (index === 1) throw new Error('temporary local download failure')
      return save(item, index, signal)
    }) })
    const pending = await executeImageTask(failed)
    expect(pending).toMatchObject({ submissionState: 'pending', resultReceived: true, code: 'IMAGE_DOWNLOAD_UNAVAILABLE',
      requestId: receipt.requestId, paths: [join(f.root, 'saved-0.png')] })
    expect(pending).not.toHaveProperty('taskId')
    expect(JSON.stringify(pending)).not.toMatch(/private-qa-signature|b64_json|original-image/u)
    const ref = f.getRef()
    const manifest = await readFile(join(f.config.directory, ref, 'manifest.json'), 'utf8')
    expect(manifest).not.toContain(inline.b64_json)
    expect(manifest).toContain('private-qa-signature')
    if (process.platform !== 'win32') expect((await stat(join(f.config.directory, ref, 'manifest.json'))).mode & 0o777).toBe(0o600)
    const resumed = f.input({ resumeResult: await new ImageResultStore(f.config).load(f.scope, ref) })
    expect(await executeImageTask(resumed)).toMatchObject({ submissionState: 'completed', paths: [
      join(f.root, 'saved-0.png'), join(f.root, 'saved-1.png'),
    ] })
    expect(failed.submit).toHaveBeenCalledOnce()
    expect(resumed.submit).not.toHaveBeenCalled()
    expect(resumed.read).not.toHaveBeenCalled()
    expect(resumed.save).toHaveBeenCalledExactlyOnceWith(remote, 1, expect.any(AbortSignal))
    expect((await new ImageResultStore(f.config).load(f.scope, ref)).saved).toHaveLength(2)
  })

  it('does not treat deleted or modified saved files as complete and leaves the user-modified file intact', async () => {
    const f = await fixture()
    expect((await executeImageTask(f.input())).ok).toBe(true)
    const firstPath = join(f.root, 'saved-0.png'), secondPath = join(f.root, 'saved-1.png')
    await writeFile(firstPath, 'changed--image')
    await unlink(secondPath)
    const retained = await new ImageResultStore(f.config).load(f.scope, f.getRef())
    expect(retained.saved).toEqual([])
    const resumed = f.input({ resumeResult: retained, save: vi.fn(async (_item, index) => {
      const path = join(f.root, `recovered-${String(index)}.png`)
      await writeFile(path, 'original-image', { flag: 'wx' })
      return path
    }) })
    expect((await executeImageTask(resumed)).submissionState).toBe('completed')
    expect(resumed.save).toHaveBeenCalledTimes(2)
    expect(resumed.submit).not.toHaveBeenCalled()
    expect(await readFile(firstPath, 'utf8')).toBe('changed--image')
  })

  it('allows the original account to sign in again while rejecting another backend, account, chat, workspace or operation', async () => {
    const f = await fixture()
    const ref = await f.store.retain(f.scope, receipt, [inline])
    const nextOwner = { ...f.owner, sessionFingerprint: 'new-login' }
    f.setLive(nextOwner)
    await expect(f.store.load(f.scope, ref)).rejects.toMatchObject({ code: 'CREATIVE_ACCOUNT_CHANGED' })
    const scope = { ...f.scope, owner: nextOwner }
    expect((await new ImageResultStore(f.config).load(scope, ref)).items).toEqual([inline])
    for (const changed of [{ ...scope, backendFingerprint: 'b'.repeat(64) },
      { ...scope, operationId: 'op_other' as CreativeOperationId },
      { ...scope, owner: { ...nextOwner, sessionId: 'another-chat' } },
      { ...scope, owner: { ...nextOwner, workspaceRoot: join(f.root, 'different-workspace') } }]) {
      await expect(f.store.load(changed, ref)).rejects.toMatchObject({ code: 'IMAGE_RESULT_INVALID' })
    }
    const otherOwner = { ...nextOwner, accountId: 'two' }
    f.setLive(otherOwner)
    await expect(f.store.load({ ...scope, owner: otherOwner }, ref)).rejects.toMatchObject({ code: 'IMAGE_RESULT_INVALID' })
  })

  it('publishes one immutable source set across concurrent instances without erasing a save checkpoint', async () => {
    const f = await fixture()
    const refs = await Promise.all(Array.from({ length: 6 }, async () => new ImageResultStore(f.config).retain(f.scope, receipt, [inline])))
    expect(new Set(refs).size).toBe(1)
    const ref = refs[0]!
    const path = join(f.root, 'actual.png')
    await writeFile(path, 'actual')
    await f.store.saved(f.scope, ref, 0, path)
    expect(await f.store.retain(f.scope, receipt, [inline])).toBe(ref)
    expect((await f.store.load(f.scope, ref)).saved).toEqual([{ index: 0, path }])
    const changed = await f.store.retain(f.scope, receipt, [remote])
    expect(changed).not.toBe(ref)
    expect((await f.store.load(f.scope, ref)).items).toEqual([inline])
  })

  it('commits the operation link before the manifest and leaves a rejected link visibly incomplete', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<ImageResultRef>()
    const release = Promise.withResolvers<undefined>()
    const association = join(f.root, 'private-operation-reference.json')
    const retaining = f.store.retain(f.scope, receipt, [inline], async (ref) => {
      await writeFile(association, JSON.stringify({ imageResultRef: ref }), { flag: 'wx', mode: 0o600 })
      entered.resolve(ref)
      await release.promise
    })
    try {
      const ref = await entered.promise
      expect(JSON.parse(await readFile(association, 'utf8'))).toEqual({ imageResultRef: ref })
      await expect(readFile(join(f.config.directory, ref, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      release.resolve(undefined)
      expect(await retaining).toBe(ref)
      expect((await new ImageResultStore(f.config).load(f.scope, ref)).items).toEqual([inline])
    } finally { release.resolve(undefined); await retaining }
    let failedRef: ImageResultRef | undefined
    await expect(f.store.retain(f.scope, receipt, [remote], async (ref) => {
      failedRef = ref
      throw new Error('project association failed')
    })).rejects.toMatchObject({ code: 'IMAGE_RESULT_PERSISTENCE_UNAVAILABLE' })
    if (failedRef === undefined) throw new Error('Expected a deterministic private reference before publication')
    await expect(readFile(join(f.config.directory, failedRef, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(new ImageResultStore(f.config).load(f.scope, failedRef)).rejects.toMatchObject({ code: 'IMAGE_RESULT_UNAVAILABLE' })
  })

  it('keeps the original no-task-id result after cancellation and resumes without POST or GET', async () => {
    const f = await fixture()
    const controller = new AbortController()
    const original = f.input()
    const first = f.input({ signal: controller.signal, receivedResult: async (items, received) => {
      await original.receivedResult?.(items, received)
      controller.abort()
    } })
    expect(await executeImageTask(first)).toMatchObject({ submissionState: 'pending', code: 'IMAGE_WAIT_STOPPED', resultReceived: true })
    expect(first.save).not.toHaveBeenCalled()
    const resumed = f.input({ resumeResult: await new ImageResultStore(f.config).load(f.scope, f.getRef()) })
    expect((await executeImageTask(resumed)).submissionState).toBe('completed')
    expect(resumed.submit).not.toHaveBeenCalled()
    expect(resumed.read).not.toHaveBeenCalled()
  })

  it('awaits cancelled parallel saves and preserves only the actual completed original index', async () => {
    const f = await fixture()
    const controller = new AbortController()
    const savedFirst = Promise.withResolvers<undefined>()
    const secondStarted = Promise.withResolvers<undefined>()
    let secondStopped = false
    const original = f.input()
    const first = f.input({ signal: controller.signal, downloadConcurrency: 2,
      savedResult: async (index, path) => {
        await original.savedResult?.(index, path)
        if (index === 0) savedFirst.resolve(undefined)
      },
      save: vi.fn(async (item: Record<string, unknown>, index: number, signal: AbortSignal) => {
        if (index === 0) return original.save(item, index, signal)
        secondStarted.resolve(undefined)
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => { secondStopped = true; reject(new DOMException('Save stopped', 'AbortError')) }, { once: true })
        })
        throw new Error('Cancelled save must not write an output')
      }) })
    const pending = executeImageTask(first)
    try {
      await Promise.all([savedFirst.promise, secondStarted.promise])
      controller.abort()
      expect(await pending).toMatchObject({ submissionState: 'pending', code: 'IMAGE_WAIT_STOPPED',
        paths: [join(f.root, 'saved-0.png')] })
      expect(secondStopped).toBe(true)
      const resumed = f.input({ resumeResult: await new ImageResultStore(f.config).load(f.scope, f.getRef()) })
      expect((await executeImageTask(resumed)).submissionState).toBe('completed')
      expect(resumed.submit).not.toHaveBeenCalled()
      expect(resumed.read).not.toHaveBeenCalled()
      expect(resumed.save).toHaveBeenCalledExactlyOnceWith(remote, 1, expect.any(AbortSignal))
    } finally { controller.abort(); await pending }
  })

  it('keeps the original GET path for a task id and retains its returned result before saving', async () => {
    const f = await fixture()
    const operations: string[] = []
    const input = f.input({ resumeReceipt: { ...receipt, phase: 'accepted', taskId: 'original-task' },
      read: vi.fn(async () => { operations.push('get'); return new Response(JSON.stringify({ status: 'succeeded', data: [inline] })) }),
      receivedResult: async () => { operations.push('retain') }, savedResult: async () => {},
      save: vi.fn(async () => { operations.push('save'); return join(f.root, 'queried-original.png') }) })
    expect((await executeImageTask(input)).submissionState).toBe('completed')
    expect(operations).toEqual(['get', 'retain', 'save'])
    expect(input.submit).not.toHaveBeenCalled()
    expect(input.read).toHaveBeenCalledExactlyOnceWith('original-task', expect.any(AbortSignal))
  })

  it('stops dependent saves when private result persistence fails without calling the submission unsubmitted', async () => {
    const f = await fixture()
    const first = f.input({ receivedResult: async () => { throw new Error('disk unavailable') } })
    const outcome = await executeImageTask(first)
    expect(outcome).toMatchObject({ submissionState: 'pending', code: 'IMAGE_RESULT_PERSISTENCE_UNAVAILABLE', resultReceived: true })
    expect(first.submit).toHaveBeenCalledOnce()
    expect(first.save).not.toHaveBeenCalled()
    expect(outcome.imageReceipt).toBeDefined()
    const resumed = f.input({ resumeReceipt: outcome.imageReceipt! })
    expect(await executeImageTask(resumed)).toMatchObject({ submissionState: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN' })
    expect(resumed.submit).not.toHaveBeenCalled()
  })

  it('rejects corrupted private inline data instead of generating again', async () => {
    const f = await fixture()
    const ref = await f.store.retain(f.scope, receipt, [inline])
    const blob = (await readdir(join(f.config.directory, ref))).find(name => name.endsWith('.b64'))
    if (blob === undefined) throw new Error('Expected separate private inline file')
    await writeFile(join(f.config.directory, ref, blob), 'tampered')
    await expect(new ImageResultStore(f.config).load(f.scope, ref)).rejects.toMatchObject({ code: 'IMAGE_RESULT_INVALID' })
  })

  // Windows symlink creation depends on Developer Mode or an elevated process.
  it.skipIf(process.platform === 'win32')('preserves saved paths through a parent-directory alias across recovery', async () => {
    const f = await fixture()
    const actualDirectory = join(f.root, 'actual-output')
    const aliasDirectory = join(f.root, 'aliased-output')
    await mkdir(actualDirectory)
    await symlink(actualDirectory, aliasDirectory, 'dir')
    const first = f.input({ save: vi.fn(async (_item, index) => {
      const path = join(aliasDirectory, `saved-${String(index)}.png`)
      await writeFile(path, 'original-image', { flag: 'wx' })
      return path
    }) })
    expect(await executeImageTask(first)).toMatchObject({ submissionState: 'completed', paths: [
      join(aliasDirectory, 'saved-0.png'), join(aliasDirectory, 'saved-1.png'),
    ] })
    expect(await realpath(join(aliasDirectory, 'saved-0.png'))).toBe(join(actualDirectory, 'saved-0.png'))
    const retained = await new ImageResultStore(f.config).load(f.scope, f.getRef())
    expect(retained.saved).toEqual([{ index: 0, path: join(aliasDirectory, 'saved-0.png') },
      { index: 1, path: join(aliasDirectory, 'saved-1.png') }])
    const resumed = f.input({ resumeResult: retained })
    expect((await executeImageTask(resumed)).submissionState).toBe('completed')
    expect(resumed.submit).not.toHaveBeenCalled()
    expect(resumed.read).not.toHaveBeenCalled()
    expect(resumed.save).not.toHaveBeenCalled()
  })

  // Windows symlink creation depends on Developer Mode or an elevated process.
  it.skipIf(process.platform === 'win32')('refuses a saved-file symlink as a completed checkpoint', async () => {
    const f = await fixture()
    expect((await executeImageTask(f.input())).ok).toBe(true)
    const path = join(f.root, 'saved-0.png')
    await unlink(path)
    await symlink(join(f.root, 'saved-1.png'), path)
    await expect(f.store.saved(f.scope, f.getRef(), 0, path)).rejects.toMatchObject({ code: 'IMAGE_RESULT_INVALID' })
    expect((await f.store.load(f.scope, f.getRef())).saved.map(item => item.index)).toEqual([1])
  })
})

describe('bounded result admission', () => {
  it.each([{ b64_json: '!!!!' }, { b64_json: 'a' }, { b64_json: 'aW1hZ2U=' }, { url: 'file:///private/image.png' },
    { url: 'https://user:password@example/image.png' }, { revised_prompt: 'no source' }])('rejects invalid or oversized source %j before saving', async (item) => {
    const f = await fixture()
    const input = f.input({ imageMaxBytes: 2, submit: vi.fn(async () => new Response(JSON.stringify({ data: [item] }))) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'unknown', code: 'IMAGE_RESULT_INVALID' })
    expect(input.save).not.toHaveBeenCalled()
    expect(input.submit).toHaveBeenCalledOnce()
  })

  it('cancels an oversized JSON stream before collecting or parsing the full body', async () => {
    const f = await fixture()
    let pulls = 0
    const cancel = vi.fn()
    const input = f.input({ responseMaxBytes: 1500, submit: vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024)); if (pulls === 100) controller.close() }, cancel,
    }))) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'unknown', code: 'IMAGE_RESPONSE_TOO_LARGE' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(pulls).toBeLessThan(5)
    expect(input.save).not.toHaveBeenCalled()
    expect(input.submit).toHaveBeenCalledOnce()
  })

  it('validates the complete batch instead of publishing only its valid prefix', async () => {
    const f = await fixture()
    const retain = vi.fn()
    const input = f.input({ receivedResult: retain, submit: async () => new Response(JSON.stringify({ data: [inline, {}] })) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'unknown', code: 'IMAGE_RESULT_INVALID' })
    expect(retain).not.toHaveBeenCalled()
    expect(input.save).not.toHaveBeenCalled()
    expect(() => validateImageResultItems([inline, remote], 1024, 10)).toThrow()
  })
})
