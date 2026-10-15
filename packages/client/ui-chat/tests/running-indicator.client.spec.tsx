// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RunningIndicator } from '../src/client/chat/RunningIndicator.tsx'

afterEach(cleanup)

describe('RunningIndicator', () => {
  it('renders one decorative arc without inline styles or SMIL', () => {
    const view = render(<RunningIndicator />)
    const icon = view.container.firstElementChild!
    expect(icon.tagName).toBe('SPAN')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    const svg = icon.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(svg.querySelector('circle')).not.toBeNull()
    expect(svg.querySelector('path')?.getAttribute('stroke')).toBe('currentColor')
    expect(view.container.querySelector('animate')).toBeNull()
    expect(view.container.querySelector('[style]')).toBeNull()
  })
})
