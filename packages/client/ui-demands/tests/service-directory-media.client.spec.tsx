// @vitest-environment jsdom
/** Published service media can be inspected without creating a private customer request. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceDirectory } from '../src/client/ServiceDirectory.tsx'
import type { DemandTranslate } from '../src/client/DemandUI.tsx'
import type { DemandPageState, DemandServiceMedia, DemandServiceProfile } from '../src/client/types.ts'
import { zh } from '../src/client/locales.ts'
import { demandState, serviceProfile } from './fixtures.client.ts'

const dictionary: ReadonlyMap<string, string> = new Map(Object.entries(zh))
const t: DemandTranslate = (key, values) => (dictionary.get(key) ?? key).replace(/\{(\w+)\}/gu,
  (match: string, name: string) => values !== undefined && name in values ? String(values[name]) : match)
const image: DemandServiceMedia = { id: 'service-image', name: '订单看板.png', kind: 'image', previewUrl: '/credits/api/demands/service-media/image/content' }
const video: DemandServiceMedia = { id: 'service-video', name: '订单演示.mp4', kind: 'video',
  previewUrl: '/credits/api/demands/service-media/video/content', posterUrl: '/credits/api/demands/service-media/poster/content' }
const previewLabel = (name: string): string => zh.servicePreviewNamed.replace('{name}', name)
const mediaLabel = (index: number): string => zh.serviceMediaIndex.replace('{index}', String(index))
const pause = vi.fn<() => void>()

beforeEach(() => {
  pause.mockClear()
  vi.stubGlobal('ResizeObserver', class {
    observe(): void { /* Browser layout is verified separately. */ }
    unobserve(): void { /* No retained layout observer. */ }
    disconnect(): void { /* No retained layout observer. */ }
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
})
afterEach(() => { cleanup(); document.querySelector('base')?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function directory(profiles: readonly DemandServiceProfile[], patch: Partial<DemandPageState> = {}) {
  const actions = { start: vi.fn(), filter: vi.fn(), loadMore: vi.fn(), refresh: vi.fn() }
  const view = render(<ServiceDirectory state={demandState({ directoryMode: 'services', serviceProfiles: profiles,
    servicesTotal: profiles.length, ...patch })} {...actions} t={t} />)
  return { ...view, ...actions, set(next: readonly DemandServiceProfile[]) {
    view.rerender(<ServiceDirectory state={demandState({ directoryMode: 'services', serviceProfiles: next,
      servicesTotal: next.length, ...patch })} {...actions} t={t} />)
  } }
}

describe('official service material previews', () => {
  it('preserves legacy service cards and only submits through the explicit communication action', () => {
    const profile = serviceProfile(), actions = directory([profile])
    expect(screen.queryByRole('button', { name: previewLabel(profile.displayName) })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.startServiceRequestNamed.replace('{name}', profile.displayName) }))
    expect(actions.start).toHaveBeenCalledExactlyOnceWith(profile.id)
  })

  it('opens the actual service gallery, switches native media and restores focus without starting a request', () => {
    const profile = serviceProfile({ coverUrl: image.previewUrl, media: [image, video] })
    const actions = directory([profile], { servicesTotal: 100, servicesHaveMore: true })
    expect(screen.getByText('100 项服务')).toBeTruthy()
    const trigger = screen.getByRole('button', { name: previewLabel(profile.displayName) })
    expect(within(trigger).getByAltText('').getAttribute('loading')).toBe('lazy')
    trigger.focus(); fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: profile.displayName })
    expect(within(dialog).getByRole('img', { name: image.name }).getAttribute('src')).toBe(image.previewUrl)
    const materials = within(dialog).getByRole('group', { name: zh.serviceMaterials })
    expect(materials.querySelectorAll('img')).toHaveLength(2)
    fireEvent.click(within(materials).getByRole('button', { name: mediaLabel(2) }))
    const player = dialog.querySelector('video')
    expect(player?.getAttribute('src')).toBe(video.previewUrl)
    expect(player?.getAttribute('poster')).toBe(video.posterUrl)
    expect(player?.hasAttribute('controls')).toBe(true)
    expect(player?.hasAttribute('playsinline')).toBe(true)
    expect(player?.getAttribute('preload')).toBe('metadata')
    expect(player?.hasAttribute('autoplay')).toBe(false)
    expect(dialog.querySelectorAll('video')).toHaveLength(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(pause).toHaveBeenCalled()
    expect(actions.start).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.loadMoreServices }))
    expect(actions.loadMore).toHaveBeenCalledOnce()
  })

  it('retries only a failed selected image or video and retains the gallery selection', () => {
    const profile = serviceProfile({ media: [image, video] }), actions = directory([profile])
    fireEvent.click(screen.getByRole('button', { name: previewLabel(profile.displayName) }))
    const dialog = screen.getByRole('dialog', { name: profile.displayName })
    const original = within(dialog).getByRole('img', { name: image.name })
    fireEvent.error(original)
    expect(within(dialog).getByRole('status').textContent).toContain(zh.serviceMediaUnavailable)
    fireEvent.click(within(dialog).getByRole('button', { name: zh.serviceMediaRetry }))
    const replacement = within(dialog).getByRole('img', { name: image.name })
    expect(replacement).not.toBe(original)
    expect(replacement.getAttribute('src')).toBe(image.previewUrl)
    fireEvent.click(within(dialog).getByRole('button', { name: mediaLabel(2) }))
    const firstPlayer = dialog.querySelector('video')
    if (firstPlayer === null) throw new Error('The selected recording is rendered')
    fireEvent.error(firstPlayer)
    fireEvent.click(within(dialog).getByRole('button', { name: zh.serviceMediaRetry }))
    expect(dialog.querySelector('video')).not.toBe(firstPlayer)
    expect(dialog.querySelector('video')?.getAttribute('src')).toBe(video.previewUrl)
    expect(within(dialog).getByRole('button', { name: mediaLabel(2) }).getAttribute('aria-pressed')).toBe('true')
    expect(actions.start).not.toHaveBeenCalled()
    expect(actions.refresh).not.toHaveBeenCalled()
  })

  it('keeps a broken cover actionable and distinguishes same-name services by ID', () => {
    const first = serviceProfile({ coverUrl: image.previewUrl, media: [image] })
    const otherImage = { ...image, id: 'other-image', name: '另一订单看板.png', previewUrl: '/credits/api/demands/service-media/other/content' }
    const second = serviceProfile({ id: 'another-service', displayName: first.displayName, coverUrl: otherImage.previewUrl, media: [otherImage] })
    const actions = directory([first, second])
    const triggers = screen.getAllByRole('button', { name: previewLabel(first.displayName) })
    const trigger = triggers[1]
    if (trigger === undefined) throw new Error('The second independently published service is visible')
    fireEvent.error(within(trigger).getByAltText(''))
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: second.displayName })
    expect(within(dialog).getByRole('img', { name: otherImage.name }).getAttribute('src')).toBe(otherImage.previewUrl)
    expect(within(dialog).queryByRole('img', { name: image.name })).toBeNull()
    expect(actions.start).not.toHaveBeenCalled()
  })

  it('resolves media beneath the application mount and contains unavailable or unsafe paths', () => {
    const base = document.createElement('base'); base.href = 'https://app.invalid/preview/'; document.head.append(base)
    const profile = serviceProfile({ media: [image, { ...video, previewUrl: 'javascript:alert(1)', posterUrl: '//other.invalid/poster' }] })
    const actions = directory([profile])
    fireEvent.click(screen.getByRole('button', { name: previewLabel(profile.displayName) }))
    const dialog = screen.getByRole('dialog', { name: profile.displayName })
    expect(within(dialog).getByRole('img', { name: image.name }).getAttribute('src')).toBe(`/preview${image.previewUrl}`)
    fireEvent.click(within(dialog).getByRole('button', { name: mediaLabel(2) }))
    expect(dialog.querySelector('video')).toBeNull()
    expect(within(dialog).getByRole('status').textContent).toContain(zh.serviceMediaUnavailable)
    expect(within(dialog).queryByRole('button', { name: zh.serviceMediaRetry })).toBeNull()
    actions.set([serviceProfile({ media: [{ ...image, previewUrl: null }] })])
    expect(dialog.querySelector('img[src]')).toBeNull()
    expect(actions.start).not.toHaveBeenCalled()
  })

  it('drops a removed service preview and releases video when the actual catalogue changes', () => {
    const profile = serviceProfile({ media: [video] }), actions = directory([profile])
    fireEvent.click(screen.getByRole('button', { name: previewLabel(profile.displayName) }))
    expect(screen.getByRole('dialog').querySelector('video')).toBeTruthy()
    actions.set([])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(pause).toHaveBeenCalled()
    expect(actions.start).not.toHaveBeenCalled()
  })
})
