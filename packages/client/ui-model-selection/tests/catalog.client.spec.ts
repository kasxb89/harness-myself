import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { describe, expect, it, vi } from 'vitest'
import { ModelCatalogDirectory } from '../src/client/catalog.ts'

const catalog = (model: string): ModelCatalog => ({
  default: { provider: 'fixture', model },
  routableProviders: ['fixture'],
  groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: model, name: model }] }],
  failures: [],
})

function directory(models: () => Promise<unknown>): ModelCatalogDirectory {
  // The providing plugin's context, scripted down to the one method it calls.
  return new ModelCatalogDirectory({ remote: { session: { modelCatalog: models } } } as never)
}

describe('ModelCatalogDirectory', () => {
  it('refreshes a cached catalog once for concurrent explicit reads', async () => {
    const fresh = Promise.withResolvers<unknown>()
    const models = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: catalog('ys-1.0') })
      .mockReturnValueOnce(fresh.promise)
    const subject = directory(models)
    await subject.load()
    await subject.load()
    expect(models).toHaveBeenCalledTimes(1)

    const first = subject.reload()
    expect(subject.reload()).toBe(first)
    expect(subject.load()).toBe(first)
    expect(models).toHaveBeenCalledTimes(2)
    expect(subject.store.getSnapshot()).toEqual({
      value: catalog('ys-1.0'), status: 'loading', error: null,
    })
    fresh.resolve({ ok: true, value: catalog('deepseek-v4-flash') })
    await expect(first).resolves.toEqual(catalog('deepseek-v4-flash'))
    expect(subject.store.getSnapshot()).toEqual({
      value: catalog('deepseek-v4-flash'), status: 'ready', error: null,
    })
  })

  it('retains cached models on an explicit refresh failure and retries the endpoint', async () => {
    const models = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: catalog('ys-1.0') })
      .mockRejectedValueOnce(new Error('catalog offline'))
      .mockResolvedValueOnce({ ok: true, value: catalog('deepseek-v4-flash') })
    const subject = directory(models)
    await subject.load()

    await expect(subject.reload()).rejects.toThrow('catalog offline')
    expect(subject.store.getSnapshot()).toEqual({
      value: catalog('ys-1.0'), status: 'error', error: 'catalog offline',
    })
    await expect(subject.reload()).resolves.toEqual(catalog('deepseek-v4-flash'))
    expect(subject.store.getSnapshot()).toMatchObject({ status: 'ready', error: null })
    expect(models).toHaveBeenCalledTimes(3)
  })

  it.each(['success', 'failure'] as const)('ignores an explicit refresh %s after a newer Host generation settles', async (outcome) => {
    const stale = Promise.withResolvers<unknown>()
    const fresh = Promise.withResolvers<unknown>()
    const models = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: catalog('initial') })
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise)
    const subject = directory(models)
    await subject.load()
    const operation = subject.reload()
    const settlement = outcome === 'success'
      ? expect(operation).resolves.toEqual(catalog('stale'))
      : expect(operation).rejects.toThrow('stale failure')

    subject.resetGeneration()
    fresh.resolve({ ok: true, value: catalog('replacement-host') })
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toEqual({ value: catalog('replacement-host'), status: 'ready', error: null })
    })
    if (outcome === 'success') stale.resolve({ ok: true, value: catalog('stale') })
    else stale.reject(new Error('stale failure'))
    await settlement
    expect(subject.store.getSnapshot()).toEqual({ value: catalog('replacement-host'), status: 'ready', error: null })
  })

  it('shares one failing request, exposes the RPC error, and permits a retry', async () => {
    const models = vi.fn()
      .mockResolvedValueOnce({
        ok: false, error: new RemoteError('gateway/internal', 'catalog offline', {}),
      })
      .mockResolvedValueOnce({ ok: true, value: catalog('recovered') })
    const subject = directory(models)

    const first = subject.load()
    expect(subject.load()).toBe(first)
    await expect(first).rejects.toThrow('gateway/internal: catalog offline')
    expect(subject.store.getSnapshot()).toMatchObject({ status: 'error', error: 'gateway/internal: catalog offline' })
    await expect(subject.load()).resolves.toEqual(catalog('recovered'))
    expect(models).toHaveBeenCalledTimes(2)
  })

  it('does not publish a successful result from an invalidated generation', async () => {
    const first = Promise.withResolvers<unknown>()
    const second = Promise.withResolvers<unknown>()
    const models = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const subject = directory(models)

    const stale = subject.load()
    subject.resetGeneration()
    first.resolve({ ok: true, value: catalog('stale') })
    await expect(stale).resolves.toEqual(catalog('stale'))
    expect(subject.store.getSnapshot()).toMatchObject({ value: null, status: 'loading' })
    second.resolve({ ok: true, value: catalog('fresh') })
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toMatchObject({ value: catalog('fresh'), status: 'ready' })
    })
  })

  it('does not publish a failure from an invalidated generation', async () => {
    const first = Promise.withResolvers<unknown>()
    const second = Promise.withResolvers<unknown>()
    const models = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const subject = directory(models)

    const stale = subject.load()
    subject.resetGeneration()
    first.reject(new Error('stale failure'))
    await expect(stale).rejects.toThrow('stale failure')
    expect(subject.store.getSnapshot()).toMatchObject({ value: null, status: 'loading', error: null })
    second.resolve({ ok: true, value: catalog('fresh') })
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toMatchObject({ value: catalog('fresh'), status: 'ready' })
    })
  })

  it('contains refresh failures while retaining old data and clears it on a failed Host reset', async () => {
    const models = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: catalog('old') })
      .mockRejectedValueOnce('refresh failed')
      .mockRejectedValueOnce(new Error('reset failed'))
    const subject = directory(models)
    await subject.load()

    subject.refresh()
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toEqual({
        value: catalog('old'), status: 'error', error: 'refresh failed',
      })
    })

    subject.resetGeneration()
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toEqual({
        value: null, status: 'error', error: 'reset failed',
      })
    })
  })
})
