/** Real pointer interaction with Chromium's browser-owned media timeline. */
import type { Locator } from 'playwright'
import { expect } from 'vitest'

/**
 * Drag the actual UA timeline and wait for the decoded media to finish seeking.
 * @param video - One visible, finite-duration video in the assembled client.
 * @param fraction - Requested position as a fraction of the media duration.
 * @returns After a real pointer gesture has changed the playback position.
 */
export async function dragNativeVideoTimeline(video: Locator, fraction: number): Promise<void> {
  await video.scrollIntoViewIfNeeded()
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) =>
    Number.isFinite(node.duration) && node.duration > 0 && node.readyState >= 2)).toBe(true)
  expect(await video.evaluate((node: HTMLVideoElement) => node.controls)).toBe(true)
  expect(await video.page().locator('[data-media-progress]').count()).toBe(0)
  await video.hover()
  const initial = await video.evaluate((node: HTMLVideoElement) => {
    node.setAttribute('data-native-seek-test', 'active')
    node.setAttribute('data-native-seek-finished', 'false')
    node.addEventListener('seeked', () => { node.setAttribute('data-native-seek-finished', 'true') }, { once: true })
    return { duration: node.duration, currentTime: node.currentTime, paused: node.paused }
  })
  const debug = await video.page().context().newCDPSession(video.page())
  try {
    const document = await debug.send('DOM.getDocument', { depth: -1, pierce: true })
    type Node = typeof document.root
    const find = (node: Node, attribute: string, value: string): Node | undefined => {
      const attributes = node.attributes ?? []
      for (let index = 0; index < attributes.length; index += 2) {
        if (attributes[index] === attribute && attributes[index + 1] === value) return node
      }
      for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) {
        const found = find(child, attribute, value)
        if (found !== undefined) return found
      }
      return undefined
    }
    const mediaNode = find(document.root, 'data-native-seek-test', 'active')
    const timeline = mediaNode === undefined ? undefined : find(mediaNode, 'pseudo', '-webkit-media-controls-timeline')
    if (timeline === undefined) throw new Error('The native video timeline is missing')
    const { model } = await debug.send('DOM.getBoxModel', { nodeId: timeline.nodeId })
    const [left, top, right, , , bottom] = model.content
    if (left === undefined || top === undefined || right === undefined || bottom === undefined || right - left < 30) {
      throw new Error('The native video timeline has no usable pointer target')
    }
    // The browser's range thumb is inset from its content box by half its width.
    const x = (value: number): number => left + 8 + (right - left - 16) * value
    const mouse = video.page().mouse
    await mouse.move(x(initial.currentTime / initial.duration), (top + bottom) / 2)
    await mouse.down()
    await mouse.move(x(fraction), (top + bottom) / 2, { steps: 10 })
    await mouse.up()
    const target = initial.duration * fraction
    await expect.poll(() => video.getAttribute('data-native-seek-finished')).toBe('true')
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => ({
      seeking: node.seeking, time: node.currentTime, paused: node.paused,
    }))).toMatchObject({ seeking: false, paused: initial.paused })
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(target - 0.12)
    if (initial.paused) {
      expect(await video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeLessThan(target + 0.12)
    }
  } finally {
    await debug.detach()
    await video.evaluate((node) => {
      node.removeAttribute('data-native-seek-test')
      node.removeAttribute('data-native-seek-finished')
    })
  }
}
