/**
 * Immersive backdrop plugin, browser half.
 *
 * The plugin owns a stylesheet plus two shell-level decisions: which preset is
 * painted, and whether the application frame keeps an opaque base fill. It never
 * renders a slot, so it cannot collide with feature occupants, and it re-binds
 * the shell fill aliases **on the frame element** rather than on `body` — menus,
 * dialogs, and the boot page live outside `#root` and keep their own fills.
 *
 * @module @deepseek-ai/dsh-client-ui-background
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import backdropCss from './backdrop.css?inline'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ui-background'

/** Backdrop presets; `off` restores the stock shell without unloading the row. */
export const BACKDROP_PRESETS = ['aurora', 'obsidian', 'pearl', 'off'] as const

/** A selectable backdrop preset. */
export type BackdropPreset = typeof BACKDROP_PRESETS[number]

/** Plugin config: preset, strength, grain, and sidebar translucency. */
export interface Config {
  /** Which backdrop to paint; `off` leaves the shell untouched. */
  preset?: BackdropPreset
  /** Wash and drift strength, 0–1. */
  intensity?: number
  /** Paint the soft-light film grain layer over the wash. */
  grain?: boolean
  /** Let the sidebar fill read as translucent glass over the backdrop. */
  glassSidebar?: boolean
}

export const Config: z<Config> = z.object({
  preset: z.union(BACKDROP_PRESETS).default('aurora'),
  intensity: z.number().min(0).max(1).default(0.72),
  grain: z.boolean().default(true),
  glassSidebar: z.boolean().default(true),
})

/** Resolved configuration: schemastery already filled every defaulted field. */
type ResolvedConfig = Required<Config>

/** Shell fill aliases this plugin re-binds on the frame element. */
const FRAME_PROPERTIES = ['--dsw-alias-bg-base', '--dsw-specific-sidebar-fill'] as const

/** The application frame: the shell's only `#root` child. */
function frameElements(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('#root > *')]
}

export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const { preset, intensity, grain, glassSidebar } = resolved

  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-dsh-backdrop-style', '')
    style.textContent = backdropCss
    document.head.append(style)

    const root = document.documentElement
    root.dataset.dshBackdrop = preset
    root.dataset.dshBackdropGrain = grain ? 'on' : 'off'
    root.style.setProperty('--dsh-backdrop-intensity', String(intensity))

    // Previous inline values are restored on disposal: the frame may carry
    // shell-owned overrides (for example the Windows content radius) that must
    // survive this plugin.
    const previous = new Map<HTMLElement, Map<string, string>>()

    /** Remember the frame's own inline declarations, then paint the shell fills. */
    const paintFrame = (element: HTMLElement): void => {
      if (!previous.has(element)) {
        previous.set(element, new Map(FRAME_PROPERTIES.map(
          property => [property, element.style.getPropertyValue(property)],
        )))
      }
      if (preset === 'off') return
      // The wash lives on the page; the frame only stops covering it.
      element.style.setProperty('--dsw-alias-bg-base', 'transparent')
      if (glassSidebar) {
        // The theme-provided glass fill keeps both themes correct without
        // restating a single palette value in this plugin.
        element.style.setProperty('--dsw-specific-sidebar-fill', 'var(--dsh-backdrop-glass)')
      }
    }

    /** Restore one frame's inline declarations and forget it. */
    const releaseFrame = (element: HTMLElement): void => {
      const before = previous.get(element)
      previous.delete(element)
      if (before === undefined) return
      for (const [property, value] of before) {
        if (value === '') element.style.removeProperty(property)
        else element.style.setProperty(property, value)
      }
    }

    const syncFrames = (): void => {
      const frames = new Set(frameElements())
      for (const element of [...previous.keys()]) {
        if (!frames.has(element)) releaseFrame(element)
      }
      for (const element of frames) paintFrame(element)
    }

    syncFrames()
    const shellRoot = document.querySelector('#root') ?? root
    const observer = new MutationObserver(() => {
      syncFrames()
    })
    observer.observe(shellRoot, { childList: true })

    return () => {
      observer.disconnect()
      for (const element of [...previous.keys()]) releaseFrame(element)
      style.remove()
      root.style.removeProperty('--dsh-backdrop-intensity')
      delete root.dataset.dshBackdrop
      delete root.dataset.dshBackdropGrain
    }
  }, 'ui-background: stylesheet + shell fills')
}
