import { describe, expect, it, vi } from 'vitest'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm, ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'
import { ModelCatalogDirectory } from '../src/client/catalog.ts'
import { capacityWriter } from '../src/client/settings-capacity.ts'

const value: ModelCatalog = {
  default: { provider: 'product', model: 'model/with.dots' }, routableProviders: ['product'], failures: [],
  groups: [{ id: 'product', name: 'Product', models: [{
    id: 'model/with.dots', name: 'Model',
    limits: { contextWindow: 1000000, maxOutputTokens: 384000, platform: { contextWindow: 1000000, maxOutputTokens: 384000 }, managedScope: 'account-A' },
    limitSettings: { settingsNs: 'llm-instance', settingsPath: ['providers', 'product'] },
  }] }],
}

async function bench() {
  const read = vi.fn().mockResolvedValue({ ok: true, value })
  const catalog = new ModelCatalogDirectory({ remote: { session: { modelCatalog: read } } } as never)
  await catalog.load()
  let revision = 3
  let writable = true
  const mutate = vi.fn<ConfigForm<unknown>['mutate']>().mockResolvedValue(true)
  const forms: Pick<ConfigForms, 'describe' | 'get'> = {
    describe: () => ({
      getSnapshot: () => ({ status: 'ready', error: null, view: { writable, hasDocument: false, namespaces: [{
        ns: 'llm-instance', revision, autoGenerate: true, applies: 'live', secrets: [],
        value: {}, user: {}, base: {}, schema: { uid: 0, refs: { '0': { type: 'object', dict: {} } } },
      }] } }),
      subscribe: () => () => {}, ensure: () => Promise.resolve(), acceptView: () => {},
    }),
    get: <T>(): ConfigForm<T> => ({
      mutate,
      getSnapshot: () => ({ revision, status: 'ready', value: undefined, base: undefined, user: undefined, writable, mode: 'host' }),
      subscribe: () => () => {}, set: () => Promise.resolve(true), unset: () => Promise.resolve(true),
    }),
  }
  return { write: capacityWriter(catalog, forms), mutate, read, catalog,
    revision: (next: number) => { revision = next }, writable: (next: boolean) => { writable = next } }
}

const request = { provider: 'product', model: 'model/with.dots', scope: 'account-A', expectedRevision: 3 }

describe('Settings capacity write boundary', () => {
  it('writes one opaque model-ID dictionary item through the existing revision-fenced form queue', async () => {
    const b = await bench()
    await expect(b.write({ ...request, values: { contextWindow: 500000, maxTokens: 32000 } })).resolves.toEqual({ ok: true })
    expect(b.mutate).toHaveBeenCalledExactlyOnceWith([{ op: 'set',
      path: ['providers', 'product', 'modelLimitOverrides', 'model/with.dots'],
      value: { scope: 'account-A', contextWindow: 500000, maxTokens: 32000 },
    }], 3)
    await vi.waitFor(() => { expect(b.read).toHaveBeenCalledTimes(2) })
  })

  it('resets by unsetting only the explicit preference, never writing scope-only values or the models array', async () => {
    const b = await bench()
    await expect(b.write(request)).resolves.toEqual({ ok: true })
    expect(b.mutate).toHaveBeenCalledExactlyOnceWith([{ op: 'unset',
      path: ['providers', 'product', 'modelLimitOverrides', 'model/with.dots'],
    }], 3)
  })

  it('rejects stale accounts, read-only settings and stale revisions without a write', async () => {
    const b = await bench()
    await expect(b.write({ ...request, scope: 'account-B' })).resolves.toEqual({ ok: false, reason: 'changed' })
    b.writable(false)
    await expect(b.write(request)).resolves.toEqual({ ok: false, reason: 'readOnly' })
    b.writable(true)
    b.revision(4)
    await expect(b.write(request)).resolves.toEqual({ ok: false, reason: 'conflict', revision: 4 })
    expect(b.mutate).not.toHaveBeenCalled()
  })

  it.each([{ contextWindow: 1000001 }, { maxTokens: 384001 }, { contextWindow: 0 }, {}, { contextWindow: 1000, maxTokens: 2000 }])(
    'rejects an invalid explicit capacity record %j without a write', async (values) => {
      const b = await bench()
      await expect(b.write({ ...request, values })).resolves.toEqual({ ok: false, reason: 'failed' })
      expect(b.mutate).not.toHaveBeenCalled()
    },
  )

  it('keeps omitted output inherited when lowering the context and reports the form queue recovery revision', async () => {
    const b = await bench()
    b.mutate.mockImplementationOnce(() => { b.revision(4); return Promise.resolve(false) })
    await expect(b.write({ ...request, values: { contextWindow: 20000 } })).resolves.toEqual({ ok: false, reason: 'conflict', revision: 4 })
    expect(b.mutate).toHaveBeenCalledExactlyOnceWith([{ op: 'set',
      path: ['providers', 'product', 'modelLimitOverrides', 'model/with.dots'], value: { scope: 'account-A', contextWindow: 20000 },
    }], 3)
    b.mutate.mockRejectedValueOnce(new Error('private transport diagnostic'))
    await expect(b.write({ ...request, expectedRevision: 4 })).resolves.toEqual({ ok: false, reason: 'failed' })
  })
})
