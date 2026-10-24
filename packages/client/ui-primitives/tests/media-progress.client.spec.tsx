// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MediaProgress } from '../src/MediaProgress.tsx'
import { VideoPlayer } from '../src/VideoPlayer.tsx'

const labels = { seek: '播放进度', unavailable: '读取时长后可拖动', failed: '跳转未完成，请重试' }
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function clip(duration = 10): HTMLVideoElement {
  const media = document.createElement('video')
  Object.defineProperty(media, 'duration', { configurable: true, value: duration })
  return media
}

describe('MediaProgress', () => {
  it('waits for a finite duration and updates from actual media events', () => {
    const media = clip(Number.NaN)
    const view = render(<MediaProgress media={media} labels={labels} />)
    expect(view.getByRole('slider')).toHaveProperty('disabled', true)
    expect(view.queryByRole('status')).toBeNull()
    Object.defineProperty(media, 'duration', { configurable: true, value: 20 })
    fireEvent.loadedMetadata(media)
    expect(view.getByRole('slider')).toHaveProperty('disabled', false)
    media.currentTime = 7
    fireEvent.timeUpdate(media)
    expect(view.getByRole('slider')).toHaveProperty('value', '7')
    expect(view.getByRole('slider').getAttribute('aria-valuetext')).toBe('0:07 / 0:20')
  })

  it('seeks without changing playback state and follows native seeks', () => {
    const media = clip()
    const play = vi.spyOn(media, 'play'), pause = vi.spyOn(media, 'pause')
    const view = render(<MediaProgress media={media} labels={labels} />)
    fireEvent.change(view.getByRole('slider', { name: labels.seek }), { target: { value: '6.5' } })
    expect(media.currentTime).toBe(6.5)
    expect(play).not.toHaveBeenCalled()
    expect(pause).not.toHaveBeenCalled()
    media.currentTime = 1
    fireEvent.seeked(media)
    expect(view.getByRole('slider')).toHaveProperty('value', '1')
  })

  it('disconnects old sources and resets a newly loaded video', () => {
    const first = clip(), second = clip(30)
    const view = render(<MediaProgress media={first} labels={labels} />)
    first.currentTime = 4
    fireEvent.timeUpdate(first)
    view.rerender(<MediaProgress media={second} labels={labels} />)
    first.currentTime = 8
    fireEvent.timeUpdate(first)
    expect(view.getByRole('slider')).toHaveProperty('value', '0')
    Object.defineProperty(second, 'duration', { configurable: true, value: Number.POSITIVE_INFINITY })
    fireEvent.emptied(second)
    expect(view.getByRole('slider')).toHaveProperty('disabled', true)
  })

  it('reports an unavailable seek and lets the next user action recover', () => {
    const media = clip()
    let time = 0, blocked = true
    Object.defineProperty(media, 'currentTime', { configurable: true, get: () => time, set: (next: number) => {
      if (blocked) throw new DOMException('not seekable', 'InvalidStateError')
      time = next
    } })
    const view = render(<MediaProgress media={media} labels={labels} />)
    fireEvent.change(view.getByRole('slider'), { target: { value: '3' } })
    expect(view.getByRole('alert').textContent).toBe(labels.failed)
    blocked = false
    fireEvent.change(view.getByRole('slider'), { target: { value: '4' } })
    expect(time).toBe(4)
    expect(view.queryByRole('alert')).toBeNull()
    blocked = true
    fireEvent.change(view.getByRole('slider'), { target: { value: '5' } })
    expect(view.getByRole('alert')).toBeTruthy()
    view.rerender(<MediaProgress media={clip()} labels={labels} />)
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('keeps a null media source disabled', () => {
    const view = render(<MediaProgress media={null} labels={labels} />)
    expect(view.getByRole('slider')).toHaveProperty('disabled', true)
  })
})

it('keeps native controls and releases video playback on unmount', () => {
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  const view = render(<VideoPlayer src="blob:local-video" progressLabels={labels} />)
  const video = view.container.querySelector('video')!
  expect(video.controls).toBe(true)
  expect(view.getByRole('slider', { name: labels.seek })).toBeTruthy()
  view.unmount()
  expect(pause).toHaveBeenCalledTimes(1)
  expect(load).toHaveBeenCalledTimes(1)
  expect(video.hasAttribute('src')).toBe(false)
})
