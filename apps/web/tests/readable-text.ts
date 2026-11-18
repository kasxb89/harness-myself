import type { Locator } from 'playwright'
import { expect } from 'vitest'

/**
 * Assert readable text against the actual composited UI surface.
 * @param target - A visible text control or label in the isolated browser.
 * @param pseudo - Optional pseudo-element, used for input placeholders.
 * @returns Resolves when the rendered color meets the 4.5:1 text contrast threshold.
 */
export async function assertReadableText(target: Locator, pseudo: string | null = null): Promise<void> {
  const contrast = await target.evaluate((element, pseudo) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) throw new Error('A color sampling context is required')
    const rgba = (color: string): number[] => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const pixel = context.getImageData(0, 0, 1, 1).data
      return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0, (pixel[3] ?? 255) / 255]
    }
    const paint = (foreground: number[], background: number[], opacity = 1): number[] => {
      const alpha = (foreground[3] ?? 1) * opacity
      return foreground.slice(0, 3).map((value, index) => value * alpha + (background[index] ?? 255) * (1 - alpha))
    }
    const layers: number[][] = []
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      layers.unshift(rgba(getComputedStyle(node).backgroundColor))
    }
    const background = layers.reduce((behind, layer) => paint(layer, behind), [255, 255, 255])
    const ink = getComputedStyle(element, pseudo)
    const foreground = paint(rgba(ink.color), background, Number(ink.opacity))
    const luminance = (color: number[]): number => color.reduce((sum, value, index) => {
      const channel = value / 255
      const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      return sum + linear * ([0.2126, 0.7152, 0.0722][index] ?? 0)
    }, 0)
    const first = luminance(foreground), second = luminance(background)
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
  }, pseudo)
  expect(contrast).toBeGreaterThanOrEqual(4.5)
}
