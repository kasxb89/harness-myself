// @vitest-environment jsdom
/** The real Loader and Models page render the shared model service, without a selected chat. */
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, vi } from 'vitest'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { ModelCatalog, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { en as settingsCopy } from '@deepseek-ai/dsh-client-ui-settings-models/src/client/locales.ts'
import { en } from '../src/client/locales.ts'
import { PRODUCT_TEXT_MODEL_IDS } from './fixtures/product-text-model-ids-20261109.ts'

const SELF = '@deepseek-ai/dsh-client-ui-model-selection'
const MODELS = '@deepseek-ai/dsh-client-ui-settings-models'
const SETTINGS = '@deepseek-ai/dsh-client-ui-settings-general'
const it = createClientTest({ roster: webApp.closure([SELF, MODELS, SETTINGS]) }, { mount: true })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function catalog(ids: readonly string[]): ModelCatalog {
  return {
    default: { provider: 'yunshu-local', model: ids[0] ?? 'yunshu-flash' },
    routableProviders: ids.length > 0 ? ['yunshu-local'] : [],
    groups: ids.length === 0 ? [] : [{ id: 'yunshu-local', name: 'Yunshu', models: ids.map(id => ({ id, name: `Name ${id}` })) }],
    failures: [],
  }
}

function capacityCatalog(override?: { contextWindow: number; maxOutputTokens: number }): ModelCatalog {
  const base = catalog(PRODUCT_TEXT_MODEL_IDS)
  return { ...base, default: { provider: 'yunshu-local', model: 'yunshu-flash' }, groups: base.groups.map(group => ({
    ...group, models: group.models.map((model, index) => ({ ...model,
      limits: { contextWindow: index === 0 && override !== undefined ? override.contextWindow : 1048576,
        maxOutputTokens: index === 0 && override !== undefined ? override.maxOutputTokens : 384000,
        platform: { contextWindow: 1048576, maxOutputTokens: 384000 }, managedScope: 'account-A',
        ...index !== 0 || override === undefined ? {} : { override } },
      limitSettings: { settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'yunshu-local'] },
    })),
  })) }
}

function capacityNamespace(revision: number, override?: { contextWindow: number; maxTokens: number }): SettingsNamespaceView {
  const providers = { 'yunshu-local': {
    // Historical fields must stay untouched and must not become the dialog's effective values.
    models: [{ id: PRODUCT_TEXT_MODEL_IDS[0], contextWindow: 4096, maxTokens: 128 }],
    modelLimitOverrides: override === undefined ? {} : { [PRODUCT_TEXT_MODEL_IDS[0]]: { scope: 'account-A', ...override } },
  } }
  return { ns: 'llm-pi-ai', revision, autoGenerate: true, applies: 'live', secrets: [],
    value: { providers }, user: { providers }, base: { providers: {} },
    schema: { uid: 0, refs: {
      '0': { type: 'object', dict: { providers: 1 } }, '1': { type: 'dict', inner: 2 },
      '2': { type: 'object', dict: { modelLimitOverrides: 3, models: 7 } },
      '3': { type: 'dict', inner: 4 }, '4': { type: 'object', dict: { scope: 5, contextWindow: 6, maxTokens: 6 } },
      '5': { type: 'string' }, '6': { type: 'number' }, '7': { type: 'array', inner: 8 },
      '8': { type: 'object', dict: { id: 5, contextWindow: 6, maxTokens: 6 } },
    } },
  }
}

describe('Settings catalog real Loader composition', () => {
  it('edits every dated product model through single-record CAS writes, raises a reduced value and resets to live platform limits', async ({ start, remote, mock }) => {
    vi.stubGlobal('__DSH_MODELS_ONBOARDING__', { credentialOnboarding: false })
    remote.llm.listProviders.mockResolvedValue({ ok: true, value: [] })
    remote.llm.listConfigurableProviders.mockResolvedValue({ ok: true, value: [] })
    let namespace = capacityNamespace(3, { contextWindow: 128000, maxTokens: 8192 })
    let current = capacityCatalog({ contextWindow: 128000, maxOutputTokens: 8192 })
    remote.settings.describe.mockImplementation(() => Promise.resolve({
      ok: true, value: { writable: true, hasDocument: false, namespaces: [namespace] },
    }))
    remote.session.modelCatalog.mockImplementation(() => Promise.resolve({ ok: true, value: current }))
    const client = await start()
    await act(async () => { client.ctx.emit('ui-settings/open-section', 'models') })
    await client.flush()
    const card = within(screen.getByRole('region', { name: en['catalog.title'] }))
    expect(card.getAllByRole('listitem').map(row => row.querySelector('code')?.textContent)).toEqual([...PRODUCT_TEXT_MODEL_IDS])
    expect(card.getAllByRole('button', { name: /^Adjust parameters for /u })).toHaveLength(34)
    const open = async () => {
      await act(async () => { fireEvent.click(card.getByRole('button', { name: `Adjust parameters for Yunshu / Name ${PRODUCT_TEXT_MODEL_IDS[0]}` })) })
      return within(screen.getByRole('dialog', { name: en['capacity.title'] }))
    }
    let editor = await open()
    expect(editor.getByLabelText<HTMLInputElement>(en['capacity.contextWindow']).value).toBe('128000')
    expect(editor.getByText('Platform maximum: 1048576 tokens')).toBeTruthy()
    remote.settings.mutate.mockImplementationOnce(() => {
      namespace = capacityNamespace(4, { contextWindow: 500000, maxTokens: 32000 })
      current = capacityCatalog({ contextWindow: 500000, maxOutputTokens: 32000 })
      return Promise.resolve({ ok: true, value: namespace })
    })
    await act(async () => {
      fireEvent.change(editor.getByLabelText(en['capacity.contextWindow']), { target: { value: '500000' } })
      fireEvent.change(editor.getByLabelText(en['capacity.maxTokens']), { target: { value: '32000' } })
      fireEvent.click(editor.getByRole('button', { name: en['capacity.save'] }))
    })
    await client.flush()
    expect(remote.settings.mutate).toHaveBeenNthCalledWith(1, 'llm-pi-ai', [{ op: 'set',
      path: ['providers', 'yunshu-local', 'modelLimitOverrides', PRODUCT_TEXT_MODEL_IDS[0]],
      value: { scope: 'account-A', contextWindow: 500000, maxTokens: 32000 },
    }], 3)
    expect(card.getByText('Effective: context 500000 · output 32000')).toBeTruthy()

    editor = await open()
    remote.settings.mutate.mockImplementationOnce(() => {
      namespace = capacityNamespace(5, { contextWindow: 1048576, maxTokens: 384000 })
      current = capacityCatalog({ contextWindow: 1048576, maxOutputTokens: 384000 })
      return Promise.resolve({ ok: true, value: namespace })
    })
    await act(async () => {
      fireEvent.change(editor.getByLabelText(en['capacity.contextWindow']), { target: { value: '1048576' } })
      fireEvent.change(editor.getByLabelText(en['capacity.maxTokens']), { target: { value: '384000' } })
      fireEvent.click(editor.getByRole('button', { name: en['capacity.save'] }))
    })
    await client.flush()
    expect(remote.settings.mutate).toHaveBeenNthCalledWith(2, 'llm-pi-ai', [{ op: 'set',
      path: ['providers', 'yunshu-local', 'modelLimitOverrides', PRODUCT_TEXT_MODEL_IDS[0]],
      value: { scope: 'account-A', contextWindow: 1048576, maxTokens: 384000 },
    }], 4)
    editor = await open()
    remote.settings.mutate.mockImplementationOnce(() => {
      namespace = capacityNamespace(6)
      current = capacityCatalog()
      return Promise.resolve({ ok: true, value: namespace })
    })
    await act(async () => { fireEvent.click(editor.getByRole('button', { name: en['capacity.reset'] })) })
    await client.flush()
    expect(remote.settings.mutate).toHaveBeenNthCalledWith(3, 'llm-pi-ai', [{ op: 'unset',
      path: ['providers', 'yunshu-local', 'modelLimitOverrides', PRODUCT_TEXT_MODEL_IDS[0]],
    }], 5)
    editor = await open()
    expect(editor.getByLabelText<HTMLInputElement>(en['capacity.contextWindow']).value).toBe('')
    expect(editor.getByLabelText<HTMLInputElement>(en['capacity.maxTokens']).value).toBe('')
    expect(namespace.value).toEqual({ providers: { 'yunshu-local': {
      models: [{ id: PRODUCT_TEXT_MODEL_IDS[0], contextWindow: 4096, maxTokens: 128 }], modelLimitOverrides: {},
    } } })
    expect(mock.log.calls('session/selectModel')).toEqual([])
    expect(mock.log.calls('credentials/set')).toEqual([])
  }, 60_000)

  it('shows the dated 34-model catalog while search, refresh and retry preserve an unsaved provider draft', async ({ start, remote, mock }) => {
    vi.stubGlobal('__DSH_MODELS_ONBOARDING__', { credentialOnboarding: false })
    remote.llm.listProviders.mockResolvedValue({ ok: true, value: [] })
    remote.llm.listConfigurableProviders.mockResolvedValue({ ok: true, value: [] })
    // A serialized Host settings namespace enables the production custom-provider form.
    remote.settings.describe.mockResolvedValue({ ok: true, value: {
      writable: true, hasDocument: false,
      namespaces: [{
        ns: 'llm-pi-ai', revision: 3, autoGenerate: true, applies: 'live', secrets: [],
        value: { providers: {} }, base: { providers: {} }, user: { providers: {} },
        schema: { uid: 0, refs: {
          '0': { type: 'object', dict: { providers: 1 } },
          '1': { type: 'dict', inner: 2 },
          '2': { type: 'object', dict: { api: 3, displayName: 5, baseURL: 5, models: 6 } },
          '3': { type: 'union', list: [4, 10] },
          '4': { type: 'const', value: 'openai-completions' },
          '5': { type: 'string' },
          '6': { type: 'array', inner: 7 },
          '7': { type: 'object', dict: { id: 8, name: 5, contextWindow: 9, maxTokens: 9 } },
          '8': { type: 'string', meta: { required: true } },
          '9': { type: 'number' },
          '10': { type: 'const', value: 'anthropic-messages' },
        } },
      }],
    } })
    const current = catalog(PRODUCT_TEXT_MODEL_IDS)
    remote.session.modelCatalog.mockResolvedValue({ ok: true, value: current })
    const client = await start()
    await act(async () => { client.ctx.emit('ui-settings/open-section', 'models') })
    await client.flush()
    const card = within(screen.getByRole('region', { name: en['catalog.title'] }))
    const expectCompleteCatalog = (): void => {
      expect(card.getByText('Models: 34')).toBeTruthy()
      expect(card.getAllByRole('listitem').map(row => row.querySelector('code')?.textContent))
        .toEqual([...PRODUCT_TEXT_MODEL_IDS])
    }
    expectCompleteCatalog()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: settingsCopy.add })) })
    const fields: Readonly<Record<string, string>> = {
      [settingsCopy.customRoute]: 'unsaved-provider',
      [settingsCopy.customDisplayName]: 'Unsaved provider',
      [settingsCopy.baseUrl]: 'https://draft.example/v1',
      [`${settingsCopy.modelId} 1`]: 'unsaved-model',
      [`${settingsCopy.modelName} 1`]: 'Draft custom model',
      [`${settingsCopy.contextWindow} 1`]: '192K',
      [`${settingsCopy.maxTokens} 1`]: '24K',
    }
    await act(async () => {
      fireEvent.change(screen.getByLabelText(settingsCopy.customRoute), { target: { value: fields[settingsCopy.customRoute] } })
      fireEvent.change(screen.getByLabelText(settingsCopy.customDisplayName), { target: { value: fields[settingsCopy.customDisplayName] } })
      fireEvent.change(screen.getByLabelText(settingsCopy.baseUrl), { target: { value: fields[settingsCopy.baseUrl] } })
      fireEvent.change(screen.getByRole('combobox', { name: settingsCopy.customApi }), { target: { value: 'anthropic-messages' } })
      fireEvent.click(screen.getByRole('button', { name: settingsCopy.addModel }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `${settingsCopy.modelAdvanced} 1` }))
    })
    await act(async () => {
      for (const [label, value] of Object.entries(fields)) {
        fireEvent.change(screen.getByLabelText(label), { target: { value } })
      }
    })
    const expectDraft = (): void => {
      for (const [label, value] of Object.entries(fields)) {
        expect(screen.getByLabelText<HTMLInputElement>(label).value).toBe(value)
      }
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: settingsCopy.customApi }).value).toBe('anthropic-messages')
    }
    expectDraft()
    const search = card.getByRole('searchbox', { name: en['catalog.search'] })
    await act(async () => { fireEvent.change(search, { target: { value: PRODUCT_TEXT_MODEL_IDS[0] } }) })
    expect(card.getAllByRole('listitem')).toHaveLength(1)
    expectDraft()
    await act(async () => { fireEvent.change(search, { target: { value: '' } }) })
    expectCompleteCatalog()

    let pendingRefresh: Promise<ModelCatalog> | undefined
    const refreshed = Promise.withResolvers<{ ok: true; value: ModelCatalog }>()
    try {
      remote.session.modelCatalog.mockReturnValueOnce(refreshed.promise)
      await act(async () => {
        fireEvent.click(card.getByRole('button', { name: en['catalog.refresh'] }))
        pendingRefresh = client.ctx.modelDirectories.catalog.load()
      })
      expect(card.getByRole('status', { name: en['status.loading'] })).toBeTruthy()
      expectDraft()
      await act(async () => {
        refreshed.resolve({ ok: true, value: current })
        await pendingRefresh
      })
      await client.flush()
      expectCompleteCatalog()
      expectDraft()
    } finally {
      await act(async () => {
        refreshed.resolve({ ok: true, value: current })
        await pendingRefresh
      })
    }

    remote.session.modelCatalog.mockRejectedValueOnce(new Error('catalog refresh unavailable'))
    await act(async () => { fireEvent.click(card.getByRole('button', { name: en['catalog.refresh'] })) })
    await client.flush()
    expect(card.getByRole('alert').textContent).toBe(en['option.loadError'])
    expectDraft()
    await act(async () => { fireEvent.click(card.getByRole('button', { name: en['catalog.retry'] })) })
    await client.flush()
    expectCompleteCatalog()
    expectDraft()
    expect(mock.log.calls('settings/mutate')).toEqual([])
    expect(mock.log.calls('session/selectModel')).toEqual([])
    expect(mock.log.calls('credentials/set')).toEqual([])
  }, 60_000)

  it('shares one live catalog across refresh, a failed read, and account model updates without settings writes', async ({ start, remote, mock }) => {
    vi.stubGlobal('__DSH_MODELS_ONBOARDING__', { credentialOnboarding: false })
    remote.llm.listProviders.mockResolvedValue({ ok: true, value: [] })
    remote.llm.listConfigurableProviders.mockResolvedValue({ ok: true, value: [] })
    remote.session.modelCatalog.mockResolvedValue({ ok: true, value: catalog(['initial-model']) })
    const client = await start()
    await act(async () => { client.ctx.emit('ui-settings/open-section', 'models') })
    await client.flush()
    const card = within(screen.getByRole('region', { name: en['catalog.title'] }))
    expect(card.getByText('initial-model')).toBeTruthy()
    expect(card.getByText('Models: 1')).toBeTruthy()
    const before = remote.session.modelCatalog.mock.calls.length
    let pending: Promise<ModelCatalog> | undefined
    const nextCatalog = catalog(Array.from({ length: 35 }, (_, index) => `fresh-${index + 1}`))
    const fresh = Promise.withResolvers<{ ok: true; value: ModelCatalog }>()
    try {
      remote.session.modelCatalog.mockReturnValueOnce(fresh.promise)
      await act(async () => {
        fireEvent.click(card.getByRole('button', { name: en['catalog.refresh'] }))
        // An additional consumer joins the same request rather than fetching its own directory.
        pending = client.ctx.modelDirectories.catalog.reload()
      })
      expect(card.queryByText('initial-model')).toBeNull()
      expect(card.getByRole('status', { name: en['status.loading'] })).toBeTruthy()
      expect(remote.session.modelCatalog.mock.calls.length).toBe(before + 1)
      await act(async () => {
        fresh.resolve({ ok: true, value: nextCatalog })
        await pending
      })
    } finally {
      await act(async () => {
        fresh.resolve({ ok: true, value: nextCatalog })
        await pending
      })
    }
    expect(card.getAllByRole('listitem')).toHaveLength(35)
    expect(card.getByText('fresh-35')).toBeTruthy()
    remote.session.modelCatalog.mockRejectedValueOnce(new Error('private failure'))
    await act(async () => { fireEvent.click(card.getByRole('button', { name: en['catalog.refresh'] })) })
    await client.flush()
    expect(card.getByRole('alert').textContent).toBe(en['option.loadError'])
    expect(card.queryByText('fresh-35')).toBeNull()
    remote.session.modelCatalog.mockResolvedValue({ ok: true, value: catalog(['account-replacement']) })
    await act(async () => {
      mock.streams.push('$events', { type: 'emit', event: 'api-session/model-catalog-changed', args: [] })
      await mock.streams.drained('$events')
    })
    await client.flush()
    expect(card.getByText('account-replacement')).toBeTruthy()
    expect(card.queryByText('fresh-35')).toBeNull()
    remote.session.modelCatalog.mockResolvedValue({ ok: true, value: catalog([]) })
    await act(async () => {
      mock.streams.push('$events', { type: 'emit', event: 'credentials/record-updated', args: [] })
      await mock.streams.drained('$events')
    })
    await client.flush()
    expect(card.getByRole('status').textContent).toBe(en['empty.models'])
    expect(card.queryByText('account-replacement')).toBeNull()
    expect(mock.log.calls('settings/mutate')).toEqual([])
    expect(mock.log.calls('session/selectModel')).toEqual([])
    await act(async () => { await client.unload(SELF) })
    expect(screen.queryByRole('region', { name: en['catalog.title'] })).toBeNull()
  }, 60_000)
})
