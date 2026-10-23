import { describe, expect, it, vi } from 'vitest'
import { Config } from '../src/index.ts'
import { DEFAULT_IMAGE_CONCURRENCY, ImageConcurrency, imageConcurrencyCeiling } from '../src/image-concurrency.ts'

const declared = { schema: 1, atomic_admission: true, max_parallelism: 2,
  model: 'image-model', scope: 'shared_account_pool', reservation: false }
const signal = (): AbortSignal => new AbortController().signal
const row = (hint: unknown): object => ({ model_name: 'image-model', parameters: { 'x-client-concurrency': hint } })

describe('independent image execution concurrency', () => {
  it('has an independent configurable default of ten, without changing provider batch size', () => {
    expect(DEFAULT_IMAGE_CONCURRENCY).toBe(10)
    expect(Config({}).imageConcurrency).toBeUndefined()
    expect(Config({}).videoProjectConcurrency).toBeUndefined()
    expect(Config({ imageConcurrency: 2 })).toMatchObject({ imageConcurrency: 2 })
    for (const invalid of [0, -1, 1.2, 65, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => Config({ imageConcurrency: invalid })).toThrow()
      expect(() => new ImageConcurrency(invalid)).toThrow()
    }
  })

  it('admits ten independent invocations and queues the eleventh until one finishes', async () => {
    const scheduler = new ImageConcurrency()
    const releases = await Promise.all(Array.from({ length: 10 }, async () => scheduler.acquire('image-model', undefined, signal())))
    const admitted = vi.fn()
    const queued = scheduler.acquire('image-model', undefined, signal()).then((release) => { admitted(); return release })
    await Promise.resolve()
    expect(admitted).not.toHaveBeenCalled()
    releases[0]!()
    const release = await queued
    expect(admitted).toHaveBeenCalledOnce()
    releases.forEach((done) => { done() })
    release()
    release()
    const following = await Promise.all(Array.from({ length: 10 }, async () => scheduler.acquire('image-model', undefined, signal())))
    following.forEach((done) => { done() })
  })

  it('shares the local limit across models and does not head-block other eligible models', async () => {
    const scheduler = new ImageConcurrency(2)
    const first = await scheduler.acquire('limited', 1, signal())
    const order: string[] = []
    const limited = scheduler.acquire('limited', 1, signal()).then((done) => { order.push('limited'); return done })
    const other = await scheduler.acquire('other', undefined, signal())
    expect(order).toEqual([])
    other()
    expect(order).toEqual([])
    first()
    const release = await limited
    expect(order).toEqual(['limited'])
    release()
  })

  it('honors a current lower ceiling and preserves same-model FIFO order', async () => {
    const scheduler = new ImageConcurrency(10)
    const first = await scheduler.acquire('image-model', 1, signal())
    const order: number[] = []
    const second = scheduler.acquire('image-model', 1, signal()).then((done) => { order.push(2); return done })
    const third = scheduler.acquire('image-model', 1, signal()).then((done) => { order.push(3); return done })
    expect(order).toEqual([])
    first()
    const doneSecond = await second
    expect(order).toEqual([2])
    doneSecond()
    const doneThird = await third
    expect(order).toEqual([2, 3])
    doneThird()
  })

  it('admits a verified forty-slot pool in auto mode and queues the forty-first invocation', async () => {
    const scheduler = new ImageConcurrency()
    const releases = await Promise.all(Array.from({ length: 40 }, async () => scheduler.acquire('image-model', 40, signal())))
    const admitted = vi.fn()
    const queued = scheduler.acquire('image-model', 40, signal()).then((release) => { admitted(); return release })
    await Promise.resolve()
    expect(admitted).not.toHaveBeenCalled()
    releases[0]!()
    const release = await queued
    expect(admitted).toHaveBeenCalledOnce()
    releases.forEach((done) => { done() })
    release()
  })

  it('keeps an explicit local ten-slot ceiling even for a verified forty-slot pool', async () => {
    const scheduler = new ImageConcurrency(10)
    const releases = await Promise.all(Array.from({ length: 10 }, async () => scheduler.acquire('image-model', 40, signal())))
    const admitted = vi.fn()
    const queued = scheduler.acquire('image-model', 40, signal()).then((release) => { admitted(); return release })
    await Promise.resolve()
    expect(admitted).not.toHaveBeenCalled()
    releases[0]!()
    const release = await queued
    expect(admitted).toHaveBeenCalledOnce()
    releases.forEach((done) => { done() })
    release()
  })

  it('keeps the undeclared auto ceiling global across distinct image models', async () => {
    const scheduler = new ImageConcurrency()
    const releases = await Promise.all(Array.from({ length: 10 }, async (_, index) => scheduler.acquire(`model-${String(index)}`, undefined, signal())))
    const admitted = vi.fn()
    const queued = scheduler.acquire('another-model', undefined, signal()).then((release) => { admitted(); return release })
    await Promise.resolve()
    expect(admitted).not.toHaveBeenCalled()
    releases[0]!()
    const release = await queued
    expect(admitted).toHaveBeenCalledOnce()
    releases.forEach((done) => { done() })
    release()
  })

  it('does not reuse a previous login pool ceiling or an idle historical model declaration', async () => {
    const scheduler = new ImageConcurrency()
    const old = await scheduler.acquire('old-account-image', 40, signal(), 1)
    const current = await Promise.all(Array.from({ length: 9 }, async () => scheduler.acquire('new-account-image', undefined, signal(), 2)))
    const admitted = vi.fn()
    const queued = scheduler.acquire('new-account-image', undefined, signal(), 2).then((release) => { admitted(); return release })
    await Promise.resolve()
    expect(admitted).not.toHaveBeenCalled()
    old()
    const release = await queued
    current.forEach((done) => { done() })
    release()
    const historical = await scheduler.acquire('temporary-pool', 40, signal(), 2)
    historical()
    const following = await Promise.all(Array.from({ length: 10 }, async (_, index) => scheduler.acquire(`model-${String(index)}`, undefined, signal(), 2)))
    admitted.mockClear()
    const final = scheduler.acquire('another-model', undefined, signal(), 2).then((done) => { admitted(); return done })
    await Promise.resolve()
    expect(admitted).not.toHaveBeenCalled()
    following[0]!()
    const done = await final
    following.forEach((finish) => { finish() })
    done()
  })

  it('uses the lower local limit even when the gateway permits more', async () => {
    const scheduler = new ImageConcurrency(1)
    const first = await scheduler.acquire('image-model', 16, signal())
    const admitted = vi.fn()
    const next = scheduler.acquire('different-model', 16, signal()).then((done) => { admitted(); return done })
    await Promise.resolve()
    expect(admitted).not.toHaveBeenCalled()
    first()
    const release = await next
    expect(admitted).toHaveBeenCalledOnce()
    release()
  })

  it('never admits a cancelled queued invocation and removes its listener', async () => {
    const scheduler = new ImageConcurrency(1)
    const first = await scheduler.acquire('image-model', undefined, signal())
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const rejected = expect(scheduler.acquire('image-model', undefined, controller.signal)).rejects.toThrow('cancelled before submission')
    controller.abort(new Error('cancelled before submission'))
    await rejected
    expect(remove).toHaveBeenCalledOnce()
    first()
    const release = await scheduler.acquire('image-model', undefined, signal())
    release()
    expect(() => scheduler.acquire('image-model', undefined, controller.signal)).toThrow('cancelled before submission')
  })

  it('does not cancel an admitted operation by releasing another operation', async () => {
    const scheduler = new ImageConcurrency(2)
    const controller = new AbortController()
    const first = await scheduler.acquire('image-model', undefined, controller.signal)
    const second = await scheduler.acquire('image-model', undefined, signal())
    controller.abort()
    const admitted = vi.fn()
    const queued = scheduler.acquire('image-model', undefined, signal()).then((done) => { admitted(); return done })
    await Promise.resolve()
    expect(admitted).not.toHaveBeenCalled()
    second()
    const done = await queued
    expect(admitted).toHaveBeenCalledOnce()
    first()
    done()
  })

  it('adapts a newly lowered ceiling without interrupting already admitted tasks', async () => {
    const scheduler = new ImageConcurrency(10)
    const first = await scheduler.acquire('image-model', undefined, signal())
    const second = await scheduler.acquire('image-model', undefined, signal())
    const admitted = vi.fn()
    const queued = scheduler.acquire('image-model', 1, signal()).then((done) => { admitted(); return done })
    first()
    await Promise.resolve()
    expect(admitted).not.toHaveBeenCalled()
    second()
    const release = await queued
    expect(admitted).toHaveBeenCalledOnce()
    release()
    expect(() => scheduler.acquire('image-model', 0, signal())).toThrow('Invalid image model concurrency')
  })
})

describe('exact image model concurrency declarations', () => {
  it.each([1, 2, 10, 16, 64])('reads the declared ceiling %s without inferring free slots', (maximum) => {
    expect(imageConcurrencyCeiling([row({ ...declared, max_parallelism: maximum })], 'image-model')).toBe(maximum)
  })

  it.each([
    undefined, null, [], {}, { ...declared, schema: 2 }, { ...declared, schema: '1' },
    { ...declared, atomic_admission: false }, { ...declared, model: 'other-model' },
    { ...declared, scope: 'account' }, { ...declared, reservation: true },
    ...[0, -1, 1.5, 65, '2', Number.NaN, Number.POSITIVE_INFINITY].map(max_parallelism => ({ ...declared, max_parallelism })),
  ])('ignores absent or unverified declarations and retains the local default: %j', (hint) => {
    expect(imageConcurrencyCeiling([row(hint)], 'image-model')).toBeUndefined()
  })

  it('does not infer capacity from duplicate rows, another model, or account counts', () => {
    expect(imageConcurrencyCeiling([row(declared), row(declared)], 'image-model')).toBeUndefined()
    expect(imageConcurrencyCeiling([row(declared)], 'other-model')).toBeUndefined()
    expect(imageConcurrencyCeiling([null, [], 'image-model'], 'image-model')).toBeUndefined()
    expect(imageConcurrencyCeiling([{ model_name: 'image-model', account_count: 4, max_parallelism: 2 }], 'image-model')).toBeUndefined()
    expect(imageConcurrencyCeiling([], '')).toBeUndefined()
  })
})
