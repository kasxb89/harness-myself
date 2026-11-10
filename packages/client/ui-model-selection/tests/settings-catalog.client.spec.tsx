// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsMirrorSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ModelCatalogState } from '../src/client/catalog.ts'
import { SettingsModelCatalog } from '../src/client/SettingsModelCatalog.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { SettingsModelCatalogInjected } from '../src/client/SettingsModelCatalog.tsx'

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
  const settings = createSnapshotStore<SettingsMirrorSnapshot>({ status: 'ready', error: null,
    view: { writable: true, hasDocument: false, namespaces: [{
      ns: 'llm-pi-ai', revision: 3, value: { providers: {} }, schema: { type: 'object' },
      autoGenerate: true, applies: 'live', secrets: [],
    }] } })
  const reload = vi.fn()
  const writeLimits = vi.fn<SettingsModelCatalogInjected['writeLimits']>().mockResolvedValue({ ok: true })
  runtime.ctx.slots.register({
    name: 'settings.models.catalog', id: 'available-models', locale: 'model',
    inject: () => ({ hooks: { catalog: store, settings }, reload, writeLimits }),
  }, SettingsModelCatalog)
  const output = runtime.renderSlot('settings.models.catalog', {})
  return { output, store, settings, reload, writeLimits }
}

function editableCatalog(scope = 'account-A'): ModelCatalog {
  return { ...catalog(1), groups: [{ id: 'product', name: 'Yunshu', models: [{
    id: 'model-1', name: 'Model 1',
    limits: { contextWindow: 128000, maxOutputTokens: 8192,
      platform: { contextWindow: 1048576, maxOutputTokens: 384000 },
      override: { contextWindow: 128000, maxOutputTokens: 8192 }, managedScope: scope },
    limitSettings: { settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'product'] },
  }] }] }
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

  it('edits a previously reduced capacity up to the current platform maximum and submits only explicit fields', async () => {
    const { output, writeLimits } = await bench({ value: editableCatalog(), status: 'ready', error: null })
    expect(output.view.getByText('Effective: context 128000 · output 8192')).toBeTruthy()
    fireEvent.click(output.view.getByRole('button', { name: 'Adjust parameters for Yunshu / Model 1' }))
    const dialog = within(screen.getByRole('dialog', { name: en['capacity.title'] }))
    expect(dialog.getByText('Platform maximum: 1048576 tokens')).toBeTruthy()
    expect(dialog.getByText('Platform maximum: 384000 tokens')).toBeTruthy()
    expect(dialog.getByLabelText<HTMLInputElement>(en['capacity.contextWindow']).value).toBe('128000')
    fireEvent.change(dialog.getByLabelText(en['capacity.contextWindow']), { target: { value: '1048576' } })
    fireEvent.change(dialog.getByLabelText(en['capacity.maxTokens']), { target: { value: '384000' } })
    fireEvent.click(dialog.getByRole('button', { name: en['capacity.save'] }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: en['capacity.title'] })).toBeNull() })
    expect(writeLimits).toHaveBeenCalledExactlyOnceWith({
      provider: 'product', model: 'model-1', scope: 'account-A', expectedRevision: 3,
      values: { contextWindow: 1048576, maxTokens: 384000 },
    })
  })

  it('rejects invalid or oversized values while keeping Restore platform defaults available', async () => {
    const { output, writeLimits } = await bench({ value: editableCatalog(), status: 'ready', error: null })
    fireEvent.click(output.view.getByRole('button', { name: 'Adjust parameters for Yunshu / Model 1' }))
    const dialog = within(screen.getByRole('dialog', { name: en['capacity.title'] }))
    const input = dialog.getByLabelText(en['capacity.contextWindow'])
    fireEvent.change(input, { target: { value: '0' } })
    expect(dialog.getByRole('alert').textContent).toBe(en['capacity.invalid'])
    expect(dialog.getByRole<HTMLButtonElement>('button', { name: en['capacity.save'] }).disabled).toBe(true)
    fireEvent.change(input, { target: { value: '1048577' } })
    expect(dialog.getByRole('alert').textContent).toBe(en['capacity.exceeded'])
    fireEvent.change(input, { target: { value: '4096' } })
    expect(dialog.getByRole('alert').textContent).toBe(en['capacity.outputExceeded'])
    fireEvent.click(dialog.getByRole('button', { name: en['capacity.reset'] }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: en['capacity.title'] })).toBeNull() })
    expect(writeLimits).toHaveBeenCalledExactlyOnceWith({ provider: 'product', model: 'model-1', scope: 'account-A', expectedRevision: 3 })
  })

  it('keeps a same-account draft through directory loading and failure, but never shows it for a replacement account', async () => {
    const held = editableCatalog()
    const { output, store } = await bench({ value: held, status: 'ready', error: null })
    fireEvent.click(output.view.getByRole('button', { name: 'Adjust parameters for Yunshu / Model 1' }))
    fireEvent.change(screen.getByLabelText(en['capacity.contextWindow']), { target: { value: '500000' } })
    act(() => { store.set({ value: held, status: 'loading', error: null }) })
    expect(screen.queryByRole('dialog', { name: en['capacity.title'] })).toBeNull()
    expect(output.view.queryByText('model-1')).toBeNull()
    act(() => { store.set({ value: held, status: 'error', error: 'private diagnostic' }) })
    expect(screen.queryByRole('dialog', { name: en['capacity.title'] })).toBeNull()
    act(() => { store.set({ value: held, status: 'ready', error: null }) })
    expect(screen.getByLabelText<HTMLInputElement>(en['capacity.contextWindow']).value).toBe('500000')
    act(() => { store.set({ value: editableCatalog('account-B'), status: 'ready', error: null }) })
    expect(screen.queryByRole('dialog', { name: en['capacity.title'] })).toBeNull()
    fireEvent.click(output.view.getByRole('button', { name: 'Adjust parameters for Yunshu / Model 1' }))
    expect(screen.getByLabelText<HTMLInputElement>(en['capacity.contextWindow']).value).toBe('128000')
    expect(screen.queryByDisplayValue('500000')).toBeNull()
  })

  it('preserves edited values on a revision conflict and retries against the accepted latest revision', async () => {
    const { output, writeLimits } = await bench({ value: editableCatalog(), status: 'ready', error: null })
    writeLimits.mockResolvedValueOnce({ ok: false, reason: 'conflict', revision: 4 })
    fireEvent.click(output.view.getByRole('button', { name: 'Adjust parameters for Yunshu / Model 1' }))
    fireEvent.change(screen.getByLabelText(en['capacity.contextWindow']), { target: { value: '500000' } })
    fireEvent.click(screen.getByRole('button', { name: en['capacity.save'] }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en['capacity.conflict']) })
    expect(screen.getByLabelText<HTMLInputElement>(en['capacity.contextWindow']).value).toBe('500000')
    // A write error must not disable retrying an otherwise valid draft.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en['capacity.save'] }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en['capacity.save'] }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: en['capacity.title'] })).toBeNull() })
    expect(writeLimits).toHaveBeenLastCalledWith({ provider: 'product', model: 'model-1', scope: 'account-A', expectedRevision: 4,
      values: { contextWindow: 500000, maxTokens: 8192 } })
  })

  it('keeps unknown platform ceilings and read-only settings unavailable for editing', async () => {
    const missing = editableCatalog()
    const model = missing.groups[0]!.models[0]!
    const value: ModelCatalog = { ...missing, groups: [{ ...missing.groups[0]!, models: [{
      ...model, limits: { ...model.limits!, platform: { contextWindow: 1048576 } },
    }] }] }
    const { output, store, settings, writeLimits } = await bench({ value, status: 'ready', error: null })
    expect(output.view.getByRole<HTMLButtonElement>('button', { name: 'Adjust parameters for Yunshu / Model 1' }).disabled).toBe(true)
    act(() => {
      store.set({ value: editableCatalog(), status: 'ready', error: null })
      settings.update((draft) => { draft.view!.writable = false })
    })
    expect(output.view.getByRole<HTMLButtonElement>('button', { name: 'Adjust parameters for Yunshu / Model 1' }).disabled).toBe(true)
    expect(writeLimits).not.toHaveBeenCalled()
  })

  it('uses blank fields to follow the platform and preserves a failed save without exposing diagnostics', async () => {
    const { output, writeLimits } = await bench({ value: editableCatalog(), status: 'ready', error: null })
    writeLimits.mockRejectedValueOnce(new Error('private transport failure'))
    fireEvent.click(output.view.getByRole('button', { name: 'Adjust parameters for Yunshu / Model 1' }))
    fireEvent.change(screen.getByLabelText(en['capacity.contextWindow']), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText(en['capacity.maxTokens']), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: en['capacity.save'] }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en['capacity.failed']) })
    expect(screen.queryByText('private transport failure')).toBeNull()
    expect(screen.getByLabelText<HTMLInputElement>(en['capacity.contextWindow']).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: en['capacity.save'] }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: en['capacity.title'] })).toBeNull() })
    expect(writeLimits).toHaveBeenLastCalledWith({ provider: 'product', model: 'model-1', scope: 'account-A', expectedRevision: 3 })
  })
})
