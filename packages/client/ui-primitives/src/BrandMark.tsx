import type { IconProps } from './icons/props.ts'

/** Native viewBox of {@link BRAND_MARK_PATH} (square, one ink). */
export const BRAND_MARK_VIEWBOX = { width: 24, height: 24 }

/**
 * The Yunshu cloud-ring mark: three rounded ribbons around an open central hub.
 * Paints in one currentColor for both light and dark surfaces.
 */
export const BRAND_MARK_PATH = 'M6.4 8.9C7 4.3 10.7 2 14.5 3.5C18.1 4.9 19.3 8.1 18 11.6L16.8 14.2C16.8 11 15.6 8.7 13.3 7.5C11 6.4 8.6 6.9 6.4 8.9ZM17.4847 8.7003C21.1684 11.5199 21.3103 15.8742 18.1112 18.4151C15.0988 20.8328 11.7275 20.272 9.3464 17.3962L7.6947 15.0569C10.466 16.6569 13.0579 16.7677 15.2471 15.3758C17.3497 13.934 18.1167 11.6055 17.4847 8.7003ZM12.1153 18.3997C7.8316 20.1801 3.9897 18.1258 3.3888 14.0849C2.8012 10.2672 4.9725 7.628 8.6536 7.0038L11.5053 6.7431C8.734 8.3431 7.3421 10.5323 7.4529 13.1242C7.6503 15.666 9.2833 17.4945 12.1153 18.3997Z'

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
      <path d={BRAND_MARK_PATH} fill="currentColor" />
    </svg>
  )
}
