/** The running Chat status: a spinning arc while the agent works. */
import css from './ChatView.module.css'

/**
 * Render the decorative running icon. The arc spins through CSS; a
 * reduced-motion session keeps the same still frame.
 * @returns the indicator element.
 */
export function RunningIndicator() {
  return (
    <span className={css.runningIcon} aria-hidden="true">
      <svg className={css.runningArc} width="100%" height="100%" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeWidth={1.3} opacity={0.25} />
        <path d="M8 2.4a5.6 5.6 0 0 1 5.6 5.6" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
      </svg>
    </span>
  )
}
