// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import * as primitives from '../src/index.ts'
import * as legacy from '../src/icons/legacy.tsx'

afterEach(cleanup)

const compatibilityIcons = [
  ['IconApiOutline14', primitives.IconApiOutlineRegular, 14],
  ['IconBrowseOutline16', primitives.IconBrowseOutlineRegular, 16],
  ['IconCheckOutline16', primitives.IconCheckOutlineRegular, 16],
  ['IconChevronDownOutline14', primitives.IconChevronDownOutlineRegular, 14],
  ['IconChevronLeftOutline14', primitives.IconChevronLeftOutlineRegular, 14],
  ['IconChevronRightOutline14', primitives.IconChevronRightOutlineRegular, 14],
  ['IconCloseFill14', primitives.IconCloseFillRegular, 14],
  ['IconCloseOutline16', primitives.IconCloseOutlineRegular, 16],
  ['IconCodeOutline16', primitives.IconCodeOutlineRegular, 16],
  ['IconCopyOutline16', primitives.IconCopyOutlineRegular, 16],
  ['IconDownloadOutline16', primitives.IconDownloadOutlineRegular, 16],
  ['IconEditOutline16', primitives.IconEditOutlineRegular, 16],
  ['IconFolderOpen16', primitives.IconFolderOpenRegular, 16],
  ['IconLinkOutline14', primitives.IconLinkOutlineRegular, 14],
  ['IconLinkOutline16', primitives.IconLinkOutlineRegular, 16],
  ['IconListPenOutline16', primitives.IconListPenOutlineRegular, 16],
  ['IconNewChatOutline16', primitives.IconNewChatOutlineRegular, 16],
  ['IconPanelLeftOutline16', primitives.IconPanelLeftOutlineRegular, 16],
  ['IconPlusOutline16', primitives.IconPlusOutlineRegular, 16],
  ['IconRefreshOutline14', primitives.IconRefreshOutlineRegular, 14],
  ['IconRefreshOutline16', primitives.IconRefreshOutlineRegular, 16],
  ['IconRightUpOutline16', primitives.IconRightUpOutlineRegular, 16],
  ['IconSearchOutline16', primitives.IconSearchOutlineRegular, 16],
  ['IconSendOutline16', primitives.IconSendOutlineRegular, 16],
  ['IconSettingsOutline16', primitives.IconSettingsOutlineRegular, 16],
  ['IconSparkle16', primitives.IconSparkleRegular, 16],
  ['IconStopFill16', primitives.IconStopFillRegular, 16],
  ['IconTrashOutline16', primitives.IconTrashOutlineRegular, 16],
  ['IconWarningOutline16', primitives.IconWarningOutlineRegular, 14],
] as const

describe('size-suffixed icons used by dsh-better-sidebar 0.19.1', () => {
  it('exposes all 29 compatibility components through the public entry', () => {
    expect(Object.keys(legacy).sort()).toEqual(compatibilityIcons.map(([name]) => name).sort())
    for (const [name] of compatibilityIcons) expect(primitives[name]).toBe(legacy[name])
  })

  it('preserves modern defaults where the compatibility defaults differ', () => {
    for (const [Icon, size] of [
      [primitives.IconLinkOutlineRegular, 16],
      [primitives.IconRefreshOutlineRegular, 16],
      [primitives.IconSendOutlineRegular, 14],
      [primitives.IconWarningOutlineRegular, 16],
    ] as const) {
      const { container } = render(<Icon />)
      expect(container.querySelector('svg')?.getAttribute('width')).toBe(String(size))
      expect(container.querySelector('svg')?.getAttribute('height')).toBe(String(size))
    }
  })

  it.each(compatibilityIcons)('%s renders current Regular artwork at its legacy default', (name, Regular, size) => {
    const Legacy = primitives[name]
    const compatible = render(<Legacy />)
    const current = render(<Regular size={size} />)
    const svg = compatible.container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe(String(size))
    expect(svg.getAttribute('height')).toBe(String(size))
    expect(compatible.container.innerHTML).toBe(current.container.innerHTML)

    compatible.rerender(<Legacy size={undefined} />)
    expect(compatible.container.innerHTML).toBe(current.container.innerHTML)
  })

  it.each(compatibilityIcons)('%s forwards explicit size and className like the modern export', (name, Regular) => {
    const Legacy = primitives[name]
    const compatible = render(<Legacy size={20} className="plugin-icon" />)
    const current = render(<Regular size={20} className="plugin-icon" />)
    expect(compatible.container.innerHTML).toBe(current.container.innerHTML)
    expect(compatible.container.querySelector('svg')?.getAttribute('width')).toBe('20')
    expect(compatible.container.querySelector('svg')?.getAttribute('height')).toBe('20')
  })
})
