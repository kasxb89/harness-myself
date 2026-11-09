// @vitest-environment jsdom
import { act, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelCatalogState } from '../src/client/catalog.ts'
import { SettingsModelCatalog } from '../src/client/SettingsModelCatalog.tsx'
import { en, zh } from '../src/client/locales.ts'

const disposers: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() })

function catalog(count = 36): ModelCatalog {
  return {
    default: { provider: 'product', model: 'model-1' },
    routableProviders: ['product', 'other'],
    groups: [
      { id: 'product', name: 'Yunshu', models: Array.from({ length: count }, (_, index) => ({
        id: `model-${index + 1}`, name: `Model ${index + 1}`,
      })) },
      { id: 'other', name: 'Other provider', models: [{ id: 'exact/other-id', name: 'Another model' }] },
    ],
    failures: [],
  }
}

async function bench(snapshot: ModelCatalogState, locale: 'en' | 'zh' = 'en') {
  const runtime = await SlotTestRuntime.create()
  disposers.push(() => runtime.dispose())
  const copy = new LocaleRuntime(runtime.ctx)
  copy.setLocale(locale)
  runtime.ctx.provide('locale', copy)
  runtime.slots.installLocale(copy)
  runtime.ctx.effect(() => copy.register('model', { en, zh }))
  await runtime.declare({ 'settings.models.catalog': { kind: 'list', scope: 'root' } })
  const store = createSnapshotStore(snapshot)
  const reload = vi.fn()
  runtime.ctx.slots.register({
    name: 'settings.models.catalog', id: 'available-models', locale: 'model',
    inject: () => ({ hooks: { catalog: store }, reload }),
  }, SettingsModelCatalog)
  const output = runtime.renderSlot('settings.models.catalog', {})
  return { output, store, reload }
}

describe('Settings shared model catalog', () => {
  it('shows every model with its exact ID under the provider name, without model actions', async () => {
    const { output } = await bench({ value: catalog(), status: 'ready', error: null })
    expect(output.view.getByRole('heading', { name: en['catalog.title'] })).toBeTruthy()
    expect(output.view.getByText('Models: 37')).toBeTruthy()
    expect(output.view.getAllByRole('listitem')).toHaveLength(37)
    expect(output.view.getByRole('region', { name: 'Yunshu' })).toBeTruthy()
    expect(output.view.getByRole('region', { name: 'Other provider' })).toBeTruthy()
    expect(output.view.getByText('Model 36')).toBeTruthy()
    expect(output.view.getByText('model-36')).toBeTruthy()
    expect(output.view.getByText('exact/other-id')).toBeTruthy()
    expect(output.view.getAllByRole('button').map(button => button.textContent)).toEqual([en['catalog.refresh']])
  })

  it('searches model IDs, names and providers and restores the complete list after clearing', async () => {
    const { output } = await bench({ value: catalog(), status: 'ready', error: null })
    const search = output.view.getByRole('searchbox', { name: en['catalog.search'] })
    fireEvent.change(search, { target: { value: ' EXACT/OTHER-ID ' } })
    expect(output.view.getAllByRole('listitem')).toHaveLength(1)
    expect(output.view.queryByRole('region', { name: 'Yunshu' })).toBeNull()
    fireEvent.change(search, { target: { value: 'Model 36' } })
    expect(output.view.getAllByRole('listitem')).toHaveLength(1)
    fireEvent.change(search, { target: { value: 'Yunshu' } })
    expect(output.view.getAllByRole('listitem')).toHaveLength(36)
    fireEvent.change(search, { target: { value: 'missing-model' } })
    expect(output.view.getByRole('status').textContent).toBe(en['search.empty'])
    fireEvent.change(search, { target: { value: '' } })
    expect(output.view.getAllByRole('listitem')).toHaveLength(37)
  })

  it('hides retained values while refreshing and after failure, with an actionable retry', async () => {
    const held = catalog(1)
    const { output, store, reload } = await bench({ value: held, status: 'loading', error: null })
    expect(output.view.getByRole('status', { name: en['status.loading'] })).toBeTruthy()
    expect(output.view.queryByText('model-1')).toBeNull()
    expect(output.view.queryByText('Models: 2')).toBeNull()
    expect(output.view.getByRole('button', { name: en['catalog.refresh'] }).hasAttribute('disabled')).toBe(true)
    act(() => { store.set({ value: held, status: 'error', error: 'private-upstream-diagnostic' }) })
    expect(output.view.getByRole('alert').textContent).toBe(en['option.loadError'])
    expect(output.view.queryByText('model-1')).toBeNull()
    expect(output.view.queryByText('private-upstream-diagnostic')).toBeNull()
    fireEvent.click(output.view.getByRole('button', { name: en['catalog.retry'] }))
    expect(reload).toHaveBeenCalledOnce()
    act(() => { store.set({ value: held, status: 'ready', error: null }) })
    expect(output.view.getByText('model-1')).toBeTruthy()
  })

  it('identifies unread provider groups without describing a partial response as complete', async () => {
    const partial = { ...catalog(1), failures: [{ id: 'missing', name: 'Unavailable provider', message: 'private diagnostic' }] }
    const { output } = await bench({ value: partial, status: 'ready', error: null }, 'zh')
    expect(output.view.getByText('已读取 2 个模型')).toBeTruthy()
    expect(output.view.getByRole('alert').textContent).toBe('Unavailable provider 的模型列表暂时无法读取，请重试')
    expect(output.view.queryByText('共 2 个模型')).toBeNull()
    expect(output.view.getByRole('searchbox', { name: zh['catalog.search'] })).toBeTruthy()
  })

  it('renders an empty successful catalog and a cold initial state distinctly', async () => {
    const { output, store } = await bench({ value: null, status: 'idle', error: null })
    expect(output.view.getByRole('status', { name: en['status.loading'] })).toBeTruthy()
    act(() => { store.set({ value: { ...catalog(0), groups: [] }, status: 'ready', error: null }) })
    expect(output.view.getByText('Models: 0')).toBeTruthy()
    expect(output.view.getByRole('status').textContent).toBe(en['empty.models'])
  })

  it('reports all provider reads failing without claiming that no models are available', async () => {
    const failed: ModelCatalog = {
      ...catalog(0), groups: [],
      failures: [{ id: 'product', name: 'Yunshu', message: 'private diagnostic' }],
    }
    const { output, reload } = await bench({ value: failed, status: 'ready', error: null })
    expect(output.view.getByText('Models loaded: 0')).toBeTruthy()
    expect(output.view.getByRole('alert').textContent).toBe('The model list for Yunshu could not be loaded. Try again.')
    expect(output.view.queryByText(en['empty.models'])).toBeNull()
    expect(output.view.queryByText(en['search.empty'])).toBeNull()
    expect(output.view.queryByRole('searchbox')).toBeNull()
    fireEvent.click(output.view.getByRole('button', { name: en['catalog.retry'] }))
    expect(reload).toHaveBeenCalledOnce()
  })
})
