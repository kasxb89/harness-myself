/** Image work consumes the real registry and job_output without creating another provider submission. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobEvent } from '@deepseek-ai/dsh-jobs'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { ImageJobs, type ImageJobResult } from '../src/image-jobs.ts'
import { executeImageTask, type ImageTaskOptions } from '../src/image-task.ts'

const coordinates = { plan_id: 'original-plan', operation_id: 'original-operation' }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function harness(run: (signal: AbortSignal, phase: (stage: string) => void) => Promise<ImageJobResult>, waitMs = 3000) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolJobs)
  const scope = ctx.plugin(() => {})
  const inject = vi.fn()
  const owner: Agent = { id: SessionId('image-owner'), ctx: scope.ctx, status: 'running', inject, options: {},
    followup: vi.fn(), session: Session.create(SessionId('image-owner')),
    inbox: { nextTurn: [], nextStep: [], clear: vi.fn(), append: vi.fn(), prepend: vi.fn(),
      replace: () => false, remove: () => false, splice: () => [] },
    send: vi.fn(), steer: vi.fn(), cancel: vi.fn(), whenIdle: async () => {},
    runMaintenance: async task => await task(new AbortController().signal),
  }
  await ctx.agents.register(owner)
  const settled: JobEvent[] = []
  ctx.jobs.events.subscribe({ owners: 'all' }, (event) => { if (event.type === 'settled') settled.push(event) })
  const images = new ImageJobs(ctx, waitMs)
  cleanups.push(async () => { await images.dispose(); await ctx.fiber.dispose() })
  ctx.tools.register(defineContentToolFixture({ name: 'test_image', description: 'Exercise the image lifecycle without media service calls.', parameters: {},
    async execute(_args, exec) {
      return [{ type: 'text', text: JSON.stringify(await images.run(exec, coordinates, run)) }]
    } }))
  let calls = 0
  async function call(name = 'test_image', args: unknown = {}, signal = new AbortController().signal) {
    const result = await ctx.tools.execute({ signal, callId: ToolCallId(`image-test-${String(++calls)}`), name, arguments: args, agent: owner })
    return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
  }
  return { ctx, owner, inject, images, settled, call }
}

describe('image background registry composition', () => {
  it('returns the fast result, removes its collected job and sends no duplicate completion notice', async () => {
    const run = vi.fn(async () => ({ status: 'succeeded', paths: ['/artifacts/summer.png'] }))
    const fixture = await harness(run)
    expect(JSON.parse(await fixture.call())).toMatchObject({ status: 'succeeded', paths: ['/artifacts/summer.png'] })
    expect(run).toHaveBeenCalledOnce()
    expect(fixture.ctx.jobs.list(fixture.owner.id)).toEqual([])
    expect(fixture.inject).not.toHaveBeenCalled()
  })

  it('returns at the configured 3s wait while generation continues, then job_output supplies the original saved path once', async () => {
    const completion = deferred<ImageJobResult>()
    const run = vi.fn(async (signal: AbortSignal, phase: (stage: string) => void) => {
      signal.addEventListener('abort', () => { completion.resolve({ status: 'unknown' }) }, { once: true })
      phase('generating'); return await completion.promise
    })
    const fixture = await harness(run)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let returned = false
    const pending = fixture.call().then((value) => { returned = true; return value })
    await vi.advanceTimersByTimeAsync(2999)
    expect(returned).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const response: unknown = JSON.parse(await pending)
    expect(response).toMatchObject({ status: 'background', job_id: 'image-generation-1', ...coordinates })
    expect(fixture.ctx.jobs.list(fixture.owner.id)[0]).toMatchObject({ status: 'running', progress: '生成中' })
    completion.resolve({ status: 'succeeded', paths: ['/artifacts/original.png'] })
    await vi.advanceTimersByTimeAsync(0)
    expect(await fixture.call('job_output', { job_id: 'image-generation-1' })).toContain('/artifacts/original.png')
    expect(await fixture.call('job_output', { job_id: 'image-generation-1' })).not.toContain('/artifacts/original.png')
    expect(fixture.inject).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()
  })

  it.each(['pending', 'unknown'])('retains %s as the provider result without declaring provider failure', async (status) => {
    const fixture = await harness(async () => ({ status, ...coordinates, code: 'IMAGE_QUERY_UNAVAILABLE' }))
    expect(JSON.parse(await fixture.call())).toMatchObject({ status, ...coordinates })
    expect(fixture.ctx.jobs.list(fixture.owner.id)).toEqual([])
    expect(fixture.inject).not.toHaveBeenCalled()
    expect(fixture.settled).toMatchObject([{ type: 'settled', awaited: true, job: { status: 'completed' } }])
  })

  it('returns a safe unknown with original recovery coordinates when a producer throws', async () => {
    const fixture = await harness(async () => { throw new Error('private remote response') })
    const response = await fixture.call()
    expect(JSON.parse(response)).toMatchObject({ ...coordinates, status: 'unknown', code: 'IMAGE_OPERATION_UNCONFIRMED' })
    expect(response).not.toContain('private remote response')
    expect(fixture.ctx.jobs.list(fixture.owner.id)).toEqual([])
    expect(fixture.inject).not.toHaveBeenCalled()
  })

  it('keeps monotonic phase durations when the wall clock moves backwards', async () => {
    let elapsed = 100
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const fixture = await harness(async (_signal, phase) => {
      elapsed += 30; phase('catalog')
      vi.mocked(Date.now).mockReturnValue(1)
      elapsed += 40; phase('submitting')
      elapsed += 50
      return { status: 'succeeded' }
    })
    expect(JSON.parse(await fixture.call())).toMatchObject({ elapsed_ms: 120,
      phase_timings: [{ stage: 'preparing', duration_ms: 30 }, { stage: 'catalog', duration_ms: 40 }, { stage: 'submitting', duration_ms: 50 }] })
  })

  it('awaits producer cleanup during disposal and stops an unknown submitted POST without resubmitting', async () => {
    const dispatched = deferred<undefined>()
    const abortObserved = deferred<undefined>()
    const cleanup = deferred<undefined>()
    const submit = vi.fn(async (signal: AbortSignal) => {
      dispatched.resolve(undefined)
      await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => { abortObserved.resolve(undefined); reject(new Error('local wait stopped')) }, { once: true }) })
      return new Response('{}')
    })
    const fixture = await harness(async (signal) => {
      const options: ImageTaskOptions = { model: 'image-model', route: '/v1/images/generations', backendFingerprint: 'a'.repeat(64), signal,
        submitTimeoutMs: 30_000, taskTimeoutMs: 30_000, queryTimeoutMs: 1000, pollIntervalMs: 10, queryRetryLimit: 0,
        submit, read: vi.fn(), save: vi.fn() }
      const result = await executeImageTask(options)
      await cleanup.promise
      return { status: result.submissionState, ...coordinates, ...result.code === undefined ? {} : { code: result.code } }
    }, 1)
    const response = fixture.call()
    await dispatched.promise
    expect(JSON.parse(await response)).toMatchObject({ status: 'background' })
    expect(await fixture.call('job_kill', { job_id: 'image-generation-1' })).toContain('requested cancellation')
    let disposed = false
    const teardown = fixture.images.dispose().then(() => { disposed = true })
    await abortObserved.promise
    expect(disposed).toBe(false)
    cleanup.resolve(undefined)
    await teardown
    expect(submit).toHaveBeenCalledOnce()
    const output = await fixture.call('job_output', { job_id: 'image-generation-1' })
    expect(output).toContain('unknown')
    expect(output).toContain('IMAGE_SUBMISSION_UNKNOWN')
    expect(output).toContain('original-operation')
  })

  it('waits for held POST cleanup after the original tool caller aborts and retains its unknown receipt once', async () => {
    const dispatched = deferred<undefined>()
    const abortObserved = deferred<undefined>()
    const cleanup = deferred<undefined>()
    const submit = vi.fn(async (signal: AbortSignal) => {
      dispatched.resolve(undefined)
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => { abortObserved.resolve(undefined); reject(new Error('local wait stopped')) }, { once: true })
      })
      return new Response('{}')
    })
    const fixture = await harness(async (signal) => {
      const outcome = await executeImageTask({ model: 'image-model', route: '/v1/images/generations',
        backendFingerprint: 'a'.repeat(64), signal, submitTimeoutMs: 30_000, taskTimeoutMs: 30_000,
        queryTimeoutMs: 1000, pollIntervalMs: 10, queryRetryLimit: 0, submit, read: vi.fn(), save: vi.fn() })
      await cleanup.promise
      return { status: outcome.submissionState, ...coordinates, ...outcome.code === undefined ? {} : { code: outcome.code } }
    }, 30_000)
    const caller = new AbortController()
    let returned = false
    const pending = fixture.call('test_image', {}, caller.signal).then((value) => { returned = true; return value })
    await dispatched.promise
    caller.abort()
    await abortObserved.promise
    expect(returned).toBe(false)
    expect(fixture.settled).toHaveLength(0)
    cleanup.resolve(undefined)
    await pending
    expect(returned).toBe(true)
    expect(submit).toHaveBeenCalledOnce()
    expect(fixture.settled).toHaveLength(1)
    const output = await fixture.call('job_output', { job_id: 'image-generation-1' })
    expect(output).toContain('unknown')
    expect(output).toContain('IMAGE_SUBMISSION_UNKNOWN')
    expect(output).toContain('original-operation')
  })

  it('preserves an already saved success when caller cancellation races producer settlement', async () => {
    const dispatched = deferred<undefined>()
    const completion = deferred<ImageJobResult>()
    const run = vi.fn(async () => { dispatched.resolve(undefined); return await completion.promise })
    const fixture = await harness(run, 30_000)
    const caller = new AbortController()
    const pending = fixture.call('test_image', {}, caller.signal)
    await dispatched.promise
    caller.abort()
    completion.resolve({ status: 'succeeded', paths: ['/artifacts/confirmed.png'] })
    await pending
    expect(fixture.settled).toMatchObject([{ type: 'settled', job: { status: 'completed' } }])
    expect(await fixture.call('job_output', { job_id: 'image-generation-1' })).toContain('/artifacts/confirmed.png')
    expect(run).toHaveBeenCalledOnce()
  })
})
