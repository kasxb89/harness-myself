/** Local video concurrency with strict optional gateway scheduling ceilings. @module */

/** User-selected default for video clips; this does not assert available provider slots. */
export const DEFAULT_VIDEO_PROJECT_PARALLELISM = 4

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Read one exact model's enforced ceiling, otherwise use the local video default.
 * @param rows - Current pricing rows from the configured gateway, before model-menu projection.
 * @param model - Exact authorized video model whose project is being scheduled.
 * @returns A positive ceiling at most sixteen; this is never a free-slot or reservation count.
 */
export function videoProjectParallelism(rows: readonly unknown[], model: string): number {
  if (model.length === 0) return DEFAULT_VIDEO_PROJECT_PARALLELISM
  const matches = rows.map(object).filter(row => row?.model_name === model)
  const ceilings = matches.flatMap((row) => {
    const parameters = object(row?.parameters)
    const hint = object(parameters?.['x-client-concurrency'])
    const maximum = hint?.max_parallelism
    if (hint?.schema !== 1 || hint.atomic_admission !== true || hint.model !== model
      || hint.scope !== 'shared_account_pool' || hint.reservation !== false
      || typeof maximum !== 'number' || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16) return []
    return [maximum]
  })
  if (matches.length === 1 && ceilings.length === 1) return ceilings[0] ?? DEFAULT_VIDEO_PROJECT_PARALLELISM
  // Conflicting rows cannot raise the default, but a verified lower ceiling still constrains it.
  return Math.min(DEFAULT_VIDEO_PROJECT_PARALLELISM, ...ceilings)
}
