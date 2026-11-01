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
  const account: CreditsSnapshot = { loaded: true, accountEpoch: 1, failure: null, balance: null, session: { signedIn: true, creditsPerYuan: 1000, account: { id: '7', phone: 'fixture' }, accountOwner: 'a'.repeat(64) } }
  const source = { getSnapshot: () => account, subscribe: () => () => {} }
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
  const props = { useMediaPreferences, loadCatalog: controller.loadCatalog, savePreference: controller.savePreference, available,
    useSession: (selector: (snapshot: { removed: boolean }) => unknown) => selector({ removed: false }),
    t } as Parameters<typeof ChatMediaPreferences>[0]
  render(<ChatMediaPreferences {...props} />)
  return { controller, transport, setFailure: (value: boolean) => { fail = value } }
}
async function open(kind: 'image' | 'video') {
  await act(async () => { fireEvent.click(await screen.findByRole('button', { name: zh[kind === 'image' ? 'media.imageTitle' : 'media.videoTitle'] })) })
  return await screen.findByRole('dialog', { name: zh[kind === 'image' ? 'media.imageTitle' : 'media.videoTitle'] })
}

describe('chat media preference editors', () => {
  it('searches available models, exposes supported parameters and saves a reviewed selection', async () => {
    const f = fixture()
    const dialog = await open('image')
    expect(screen.getByRole('button', { name: zh['media.imageTitle'] }).textContent).toContain('约 250–375 积分/张')
    expect(within(dialog).getByRole('button', { name: 'Picture One picture-one' }).textContent).toContain('约 250–375 积分/张')
    fireEvent.change(within(dialog).getByRole('textbox', { name: zh['media.search'] }), { target: { value: 'picture' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Picture One picture-one' }))
    fireEvent.change(within(dialog).getByRole('combobox', { name: zh['media.param.size'] }), { target: { value: JSON.stringify('1536x1024') } })
    fireEvent.change(within(dialog).getByRole('combobox', { name: zh['media.param.quality'] }), { target: { value: JSON.stringify('high') } })
    expect(within(dialog).queryByRole('combobox', { name: zh['media.param.seconds'] })).toBeNull()
    expect({
      title: within(dialog).getByText(zh['media.imageTitle']).textContent,
      guidance: within(dialog).getByText(zh['media.description']).textContent,
      parameters: within(dialog).getAllByRole('combobox').map(control => ({
        name: control.getAttribute('aria-label'), options: control.textContent, value: (control as HTMLSelectElement).value,
      })),
      count: within(dialog).getByRole('spinbutton', { name: zh['media.param.count'] }).getAttribute('placeholder'),
      selected: within(dialog).getByRole('button', { name: 'Picture One picture-one' }).getAttribute('aria-pressed'),
      price: within(dialog).getByText('当前参数参考单价：约 375 积分/张').textContent,
    }).toMatchSnapshot()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh['media.save'] })) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: zh['media.imageTitle'] }).textContent).toContain('Picture One')
    expect(screen.getByRole('button', { name: zh['media.imageTitle'] }).textContent).toContain('约 375 积分/张')
    fireEvent.mouseEnter(screen.getByRole('button', { name: zh['media.imageTitle'] }))
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toContain(zh['media.price.note'])
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toContain('约 375 积分/张')
    fireEvent.mouseLeave(screen.getByRole('button', { name: zh['media.imageTitle'] }))
    expect(f.transport.mock.calls.find(([operation]) => operation === 'save')?.[2]).toMatchObject({ image: { model: image.id, parameters: { size: '1536x1024', quality: 'high' } }, video: null })
  })
  it('links video specifications and labels durations as a single clip', async () => {
    fixture()
    const dialog = await open('video')
    expect(screen.getByRole('button', { name: zh['media.videoTitle'] }).textContent).toContain('约 125–250 积分/秒')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Video One video-one' }))
    fireEvent.change(within(dialog).getByRole('combobox', { name: zh['media.param.resolution'] }), { target: { value: JSON.stringify('2K') } })
    const seconds = within(dialog).getByRole('combobox', { name: zh['media.param.seconds'] })
    expect(seconds.textContent).not.toContain('15')
    expect(seconds.textContent).toContain('5')
    expect(within(dialog).getByText('当前参数参考单价：约 250 积分/秒')).toBeDefined()
    expect(within(dialog).getByRole('button', { name: 'Video One video-one' }).textContent).toContain('约 250 积分/秒')
    expect(screen.getByRole('button', { name: zh['media.videoTitle'] }).textContent).toContain('约 125–250 积分/秒')
    expect(within(dialog).getByText(zh['media.videoHint'])).toBeDefined()
    expect(within(dialog).getByRole('combobox', { name: zh['media.param.audio'] })).toBeDefined()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('retains drafts and the saved composer label on CAS conflict, then resets an unavailable choice explicitly', async () => {
    const f = fixture({ video: { model: 'retired-model', parameters: { resolution: '4K' } } })
    const dialog = await open('video')
    expect(within(dialog).getAllByText(/retired-model/u).length).toBeGreaterThan(0)
    expect(within(dialog).getByRole('button', { name: zh['media.save'] }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Video One video-one' }))
    f.setFailure(true)
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh['media.save'] })) })
    expect(within(dialog).getByRole('alert').textContent).toContain(zh['media.error.conflict'])
    expect(within(dialog).getByRole('button', { name: 'Video One video-one' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: zh['media.videoTitle'] }).textContent).toContain(zh['media.unavailableShort'])
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh['media.retry'] })) })
    f.setFailure(false)
    fireEvent.click(within(dialog).getByRole('button', { name: /跟随平台默认/u }))
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh['media.save'] })) })
    expect(f.controller.hooks.mediaPreferences.getSnapshot().saved?.video).toBeNull()
  })
  it('allows choosing and saving a model while an older Host has no reliable unit price', async () => {
    const f = fixture({}, true, false, false)
    const dialog = await open('video')
    expect(screen.getByRole('button', { name: zh['media.videoTitle'] }).textContent).toContain('积分/秒待核价')
    expect(within(dialog).getByRole('button', { name: 'Video One video-one' }).textContent).toContain('积分/秒待核价')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Video One video-one' }))
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh['media.save'] })) })
    expect(f.controller.hooks.mediaPreferences.getSnapshot().saved?.video?.model).toBe(video.id)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('does not show selectors on addressed subagents and uses English locale chrome', async () => {
    fixture({}, false)
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    fixture({}, true, true)
    expect(await screen.findByRole('button', { name: en['media.imageTitle'] })).toBeDefined()
  })
})
