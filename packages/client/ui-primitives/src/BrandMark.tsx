import type { IconProps } from './icons/props.ts'

/** Native viewBox of {@link BRAND_MARK_PATH} (square, one ink). */
export const BRAND_MARK_VIEWBOX = { width: 24, height: 24 }

/**
 * The product's brand mark (云枢): a droplet cut out of a rounded tile.
 *
 * One path for both, drawn even-odd so the droplet is negative space — the
 * mark paints in a single `currentColor` and stays legible on the sidebar's
 * glass, the light palette's white, and the hero's oversized rendering alike.
 */
export const BRAND_MARK_PATH = 'M8 2h8a6 6 0 0 1 6 6v8a6 6 0 0 1-6 6H8a6 6 0 0 1-6-6V8a6 6 0 0 1 6-6ZM12 6.1C9.2 9.6 7.7 12 7.7 14a4.3 4.3 0 0 0 8.6 0c0-2-1.5-4.4-4.3-7.9Z'

/**
 * Render the brand mark.
 * @param props.size - width in px (default 24; the mark is square).
 * @param props.className - extra class for layout placement.
 * @returns the mark svg (aria-hidden; pair with a wordmark for accessibility).
 */
export function BrandMark({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox={`0 0 ${BRAND_MARK_VIEWBOX.width} ${BRAND_MARK_VIEWBOX.height}`}
      fill="none"
      aria-hidden="true"
    >
      <path d={BRAND_MARK_PATH} fill="currentColor" fillRule="evenodd" clipRule="evenodd" />
    </svg>
  )
}
