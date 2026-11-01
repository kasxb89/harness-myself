// @vitest-environment jsdom
/** The actual composer editors save only supported, reviewed choices through their root controller. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatMediaPreferences } from '../src/client/ChatMediaPreferences.tsx'
import { createMediaPreferences } from '../src/client/media-preferences-controller.ts'
import { en, zh, type CreditsKey } from '../src/client/locales.ts'
import type { CreditsSnapshot } from '../src/client/session-store.ts'
import type { MediaPreferences, PreferenceModel, requestPreferences } from '../src/client/media-preferences.ts'

const stops: (() => void)[] = []
afterEach(() => { cleanup(); for (const stop of stops.splice(0)) stop(); vi.unstubAllGlobals() })
const image: PreferenceModel = { id: 'picture-one', kind: 'image', displayName: 'Picture One', verified: true, source: 'fixture', notes: [], params: { sizes: ['1024x1024', '1536x1024'], qualities: ['standard', 'high'], maxCount: 1, backgrounds: ['auto'], formats: ['png', 'jpeg'], moderations: [], seed: true }, pricing: { schema_version: 1, status: 'available', basis: 'default', source: 'public-retail',
  unit: 'points/image', credits_per_yuan: '1250', coverage: 'complete', rows: [
    { parameters: { size: '1024x1024', quality: 'standard', count: 1 }, points: '250', input: 'unspecified' },
    { parameters: { size: '1536x1024', quality: 'standard', count: 1 }, points: '250', input: 'unspecified' },
    { parameters: { size: '1024x1024', quality: 'high', count: 1 }, points: '375', input: 'unspecified' },
    { parameters: { size: '1536x1024', quality: 'high', count: 1 }, points: '375', input: 'unspecified' },
  ] } }
const video: PreferenceModel = { id: 'video-one', kind: 'video', displayName: 'Video One', verified: true, source: 'fixture', notes: [], params: { specifications: [{ resolution: '768P', seconds: 15, ratio: '16:9' }, { resolution: '2K', seconds: 5, ratio: '9:16' }], audioToggle: true, seed: false },
  pricing: { schema_version: 1, status: 'available', basis: 'default', source: 'public-retail',
    unit: 'points/second', credits_per_yuan: '1250', coverage: 'complete', rows: [
      { parameters: { resolution: '768P', seconds: 15, ratio: '16:9', count: 1 }, points: '125', input: 'unspecified' },
      { parameters: { resolution: '2K', seconds: 5, ratio: '9:16', count: 1 }, points: '250', input: 'unspecified' },
    ] } }
function fixture(saved: Partial<MediaPreferences> = {}, available = true, english = false, unitPrices = true) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const imageModel = { ...image }
  const videoModel = { ...video }
  if (!unitPrices) { delete imageModel.pricing; delete videoModel.pricing }
  let prefs: MediaPreferences = { schema_version: 1, scope: 'b'.repeat(64), revision: 'c'.repeat(64), image: null, video: null, ...saved }
  let account: CreditsSnapshot = { loaded: true, accountEpoch: 1, failure: null, balance: null, session: { signedIn: true, creditsPerYuan: 1000, account: { id: '7', phone: 'fixture' }, accountOwner: 'a'.repeat(64) } }
  const listeners = new Set<() => void>()
  const source = { getSnapshot: () => account, subscribe: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener) }
  } }
  let fail = false
  const transport = vi.fn<typeof requestPreferences>(async (operation, _signal, body) => {
    if (operation === 'save') {
      if (fail) return { ok: false, failure: 'conflict' }
      prefs = { ...prefs, revision: 'd'.repeat(64), image: body?.image as MediaPreferences['image'], video: body?.video as MediaPreferences['video'] }
    }
    return { ok: true, reply: { accountId: '7', accountOwner: 'a'.repeat(64), preferences: prefs,
      ...operation === 'catalog' ? { catalog: { image: [imageModel], video: [videoModel], defaults: { image: { model: image.id, configured: true, available: true }, video: { model: video.id, configured: true, available: true } } } } : {} } }
  })
  const controller = createMediaPreferences(source, 20_000, transport)
  stops.push(controller.start())
  const view = controller.hooks.mediaPreferences
  const useMediaPreferences: Parameters<typeof ChatMediaPreferences>[0]['useMediaPreferences'] = selector => selector(useSyncExternalStore(listener => view.subscribe(listener), () => view.getSnapshot()))
  const t = (key: string, values?: Record<string, unknown>): string => {
    let text: string = (english ? en : zh)[key as CreditsKey] ?? key
    for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }
  const props = { useMediaPreferences, loadCatalog: controller.loadCatalog,
    savePreference: controller.savePreference, savePreferences: controller.savePreferences, available,
    useSession: (selector: (snapshot: { removed: boolean }) => unknown) => selector({ removed: false }),
    t } as Parameters<typeof ChatMediaPreferences>[0]
  render(<ChatMediaPreferences {...props} />)
  return { controller, transport, setFailure: (value: boolean) => { fail = value },
    setCanonical: (value: MediaPreferences) => { prefs = value },
    signOut: () => {
      account = { ...account, accountEpoch: account.accountEpoch + 1, session: { signedIn: false, creditsPerYuan: 1000 } }
      for (const listener of listeners) listener()
    },
  }
}
async function open(kind: 'image' | 'video' = 'image') {
  await act(async () => { fireEvent.click(await screen.findByRole('button', { name: zh['media.entryAria'] })) })
  const dialog = await screen.findByRole('dialog', { name: zh['media.title'] })
  fireEvent.click(within(dialog).getByRole('tab', { name: zh[kind === 'image' ? 'media.image' : 'media.video'] }))
  return dialog
}
const saves = (transport: ReturnType<typeof fixture>['transport']) => transport.mock.calls.filter(([operation]) => operation === 'save')

describe('compact chat media preferences', () => {
  it('adds one settings button and does not read the remote catalog or show model prices before opening it', async () => {
    const f = fixture()
    const entry = await screen.findByRole('button', { name: zh['media.entryAria'] })
    await act(async () => { await Promise.resolve() })
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(entry.textContent).toBe(zh['media.entry'])
    expect(entry.textContent).not.toMatch(/积分|Picture|Video/u)
    expect(f.transport.mock.calls.map(([operation]) => operation)).toEqual(['read'])
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect({ entry: entry.textContent, aria: entry.getAttribute('aria-label'), buttons: screen.getAllByRole('button').length }).toMatchSnapshot()
  })

  it('preserves both tab drafts and saves the image and video selections in one acknowledged write', async () => {
    const f = fixture()
    const dialog = await open()
    fireEvent.change(within(dialog).getByRole('textbox', { name: zh['media.search'] }), { target: { value: 'picture' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Picture One picture-one' }))
    fireEvent.change(within(dialog).getByRole('combobox', { name: zh['media.param.size'] }), { target: { value: JSON.stringify('1536x1024') } })
    fireEvent.change(within(dialog).getByRole('combobox', { name: zh['media.param.quality'] }), { target: { value: JSON.stringify('high') } })
    expect(within(dialog).getAllByText('约 375 积分/张').length).toBeGreaterThan(0)
    fireEvent.click(within(dialog).getByRole('tab', { name: zh['media.video'] }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Video One video-one' }))
    fireEvent.change(within(dialog).getByRole('combobox', { name: zh['media.param.resolution'] }), { target: { value: JSON.stringify('2K') } })
    expect(within(dialog).getAllByText('约 250 积分/秒').length).toBeGreaterThan(0)
    expect(within(dialog).getByRole('combobox', { name: zh['media.param.seconds'] }).textContent).not.toContain('15')
    fireEvent.click(within(dialog).getByRole('tab', { name: zh['media.image'] }))
    expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: zh['media.param.size'] }).value).toBe(JSON.stringify('1536x1024'))
    expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: zh['media.param.quality'] }).value).toBe(JSON.stringify('high'))
    expect({ tabs: within(dialog).getAllByRole('tab').map(tab => tab.textContent), note: within(dialog).getByText(zh['media.price.note']).textContent,
      price: within(dialog).getAllByText('约 375 积分/张').map(value => value.textContent),
      parameters: within(dialog).getAllByRole('combobox').map(value => value.getAttribute('aria-label')) }).toMatchSnapshot()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh['media.save'] })) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(saves(f.transport)).toHaveLength(1)
    expect(saves(f.transport)[0]?.[2]).toMatchObject({ image: { model: image.id, parameters: { size: '1536x1024', quality: 'high' } },
      video: { model: video.id, parameters: { resolution: '2K' } } })
    expect(f.controller.promptHint()?.revision).toBe('d'.repeat(64))
    expect(screen.getByRole('button', { name: zh['media.entryAria'] }).textContent).toBe(zh['media.entry'])
  })

  it('cancels both unsaved tab drafts without changing preferences and closes with Escape', async () => {
    const f = fixture()
    const dialog = await open()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Picture One picture-one' }))
    fireEvent.click(within(dialog).getByRole('tab', { name: zh['media.video'] }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Video One video-one' }))
    fireEvent.click(within(dialog).getByRole('button', { name: zh['media.cancel'] }))
    expect(saves(f.transport)).toHaveLength(0)
    expect(f.controller.hooks.mediaPreferences.getSnapshot().saved).toMatchObject({ image: null, video: null })
    const reopened = await open('video')
    expect(within(reopened).getByRole('button', { name: /跟随平台默认/u }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('allows saving another kind and resetting while unchanged unavailable choices remain preserved', async () => {
    const oldVideo = { model: 'retired-video', parameters: { resolution: '4K' } }
    const f = fixture({ image: { model: 'retired-image', parameters: {} }, video: oldVideo })
    const dialog = await open()
    expect(within(dialog).getByRole('tab', { name: zh['media.video'] }).textContent).toContain(zh['media.unavailableShort'])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Picture One picture-one' }))
    expect(within(dialog).getByRole('button', { name: zh['media.save'] }).hasAttribute('disabled')).toBe(false)
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh['media.save'] })) })
    expect(saves(f.transport)[0]?.[2]).toMatchObject({ image: { model: image.id, parameters: {} }, video: oldVideo })
    const reopened = await open('video')
    expect(within(reopened).getByText('retired-video 当前不可用')).toBeDefined()
    fireEvent.click(within(reopened).getByRole('button', { name: /跟随平台默认/u }))
    await act(async () => { fireEvent.click(within(reopened).getByRole('button', { name: zh['media.save'] })) })
    expect(f.controller.hooks.mediaPreferences.getSnapshot().saved?.video).toBeNull()
  })

  it('blocks only changed invalid parameters and keeps the other tab draft until they are corrected', async () => {
    const f = fixture()
    const dialog = await open()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Picture One picture-one' }))
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: zh['media.param.seed'] }), { target: { value: '1.5' } })
    fireEvent.click(within(dialog).getByRole('tab', { name: zh['media.video'] }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Video One video-one' }))
    expect(within(dialog).getByRole('tab', { name: zh['media.image'] }).textContent).toContain(zh['media.needsAdjustment'])
    expect(within(dialog).getByRole('alert').textContent).toContain('请调整图片参数')
    expect(within(dialog).getByRole('button', { name: zh['media.save'] }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(dialog).getByRole('tab', { name: zh['media.image'] }))
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: zh['media.param.seed'] }), { target: { value: '2' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh['media.save'] })) })
    expect(saves(f.transport)[0]?.[2]).toMatchObject({ image: { model: image.id, parameters: { seed: 2 } },
      video: { model: video.id, parameters: {} } })
  })

  it('retains both drafts on conflict and merges only an unedited kind after an explicit catalog recheck', async () => {
    const f = fixture()
    const dialog = await open()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Picture One picture-one' }))
    f.setFailure(true)
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh['media.save'] })) })
    expect(within(dialog).getByRole('alert').textContent).toContain(zh['media.error.conflict'])
    f.setCanonical({ schema_version: 1, scope: 'b'.repeat(64), revision: 'e'.repeat(64), image: null,
      video: { model: video.id, parameters: { resolution: '2K' } } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh['media.retry'] })) })
    expect(within(dialog).getByRole('button', { name: 'Picture One picture-one' }).getAttribute('aria-pressed')).toBe('true')
    f.setFailure(false)
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh['media.save'] })) })
    expect(saves(f.transport)[1]?.[2]).toMatchObject({ expected_revision: 'e'.repeat(64), image: { model: image.id, parameters: {} },
      video: { model: video.id, parameters: { resolution: '2K' } } })
  })

  it('compares scalar parameters by meaning rather than insertion order', async () => {
    const f = fixture({ image: { model: image.id, parameters: { size: '1024x1024', quality: 'standard' } } })
    const dialog = await open()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Picture One picture-one' }))
    fireEvent.change(within(dialog).getByRole('combobox', { name: zh['media.param.quality'] }), { target: { value: JSON.stringify('standard') } })
    fireEvent.change(within(dialog).getByRole('combobox', { name: zh['media.param.size'] }), { target: { value: JSON.stringify('1024x1024') } })
    expect(within(dialog).getByRole('button', { name: zh['media.save'] }).hasAttribute('disabled')).toBe(true)
    expect(saves(f.transport)).toHaveLength(0)
  })

  it('allows model-only choices without a reliable price and discards the editor on sign-out', async () => {
    const f = fixture({}, true, false, false)
    const dialog = await open('video')
    expect(within(dialog).getAllByText('积分/秒待核价').length).toBeGreaterThan(0)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Video One video-one' }))
    expect(within(dialog).getByRole('button', { name: zh['media.save'] }).hasAttribute('disabled')).toBe(false)
    await act(async () => { f.signOut() })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: zh['media.entryAria'] })).toBeNull()
    expect(saves(f.transport)).toHaveLength(0)
  })

  it('hides addressed-subagent controls and uses English chrome', async () => {
    fixture({}, false)
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    fixture({}, true, true)
    expect(await screen.findByRole('button', { name: en['media.entryAria'] })).toHaveProperty('textContent', en['media.entry'])
  })
})
