// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { CreativeOutputId } from '@deepseek-ai/dsh-credits-index/src/creative-types.ts'
import { SavedMedia } from '../src/client/CreativeMedia.tsx'
import { StoryboardTimeline } from '../src/client/CreativePanels.tsx'
import { en } from '../src/client/locales.ts'
import { mediaUrl, project } from './fixtures.ts'

let base: HTMLBaseElement
beforeEach(() => { base = document.createElement('base'); base.href = '/mount/'; document.head.append(base) })
afterEach(() => { cleanup(); base.remove() })
const t = makeTranslate(en)

it('mounts saved image, video, audio, poster, frame, download and lightbox paths at their render sites', () => {
  const url = mediaUrl()
  const output = { id: 'out1' as CreativeOutputId, name: 'cat.png', kind: 'image' as const, url }
  const image = render(<SavedMedia output={output} visible t={t} />)
  expect(screen.getByRole('img').getAttribute('src')).toBe(`/mount${url}`)
  expect(screen.getByRole('link').getAttribute('href')).toBe(`/mount${url}`)
  fireEvent.click(screen.getByRole('button', { name: en.preview }))
  expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe(`/mount${url}`)
  image.unmount()
  const frame = `${url}&frame=0`
  const video = render(<SavedMedia output={{ ...output, kind: 'video', posterUrl: frame,
    frames: [{ url: frame, timeSeconds: 1 }] }} visible t={t} />)
  expect(video.container.querySelector('video')?.getAttribute('src')).toBe(`/mount${url}`)
  expect(video.container.querySelector('video')?.getAttribute('poster')).toBe(`/mount${frame}`)
  expect(video.container.querySelector('img')?.getAttribute('src')).toBe(`/mount${frame}`)
  video.unmount()
  const audio = render(<SavedMedia output={{ ...output, kind: 'audio' }} visible t={t} />)
  expect(audio.container.querySelector('audio')?.getAttribute('src')).toBe(`/mount${url}`)
  expect(output.url).toBe(url)
})

it('mounts storyboard thumbnails without rewriting the canonical project record', () => {
  const original = project()
  const shot = original.shots[0]
  if (shot === undefined) throw new Error('Expected a storyboard fixture')
  const url = mediaUrl()
  const view = render(<StoryboardTimeline shots={[{ ...shot, outputs: [{ id: 'out1' as CreativeOutputId,
    name: 'cat.png', kind: 'image', url }] }]} selected={null} select={() => {}} move={() => {}} busy={false} t={t} />)
  expect(view.container.querySelector('img')?.getAttribute('src')).toBe(`/mount${url}`)
})
