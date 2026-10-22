/** Strict client scheduling hints from the configured gateway's current media catalog. @module */

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Read the exact H3 pool's enforced scheduling ceiling; every unknown value keeps projects serial.
 * @param rows - Current pricing rows from the configured gateway, before model-menu projection.
 * @returns A positive ceiling at most sixteen; this is never a free-slot or reservation count.
 */
export function h3ProjectParallelism(rows: readonly unknown[]): number {
  const matches = rows.map(object).filter(row => row?.model_name === 'MiniMax-H3')
  if (matches.length !== 1) return 1
  const parameters = object(matches[0]?.parameters)
  const hint = object(parameters?.['x-client-concurrency'])
  const maximum = hint?.max_parallelism
  if (hint?.schema !== 1 || hint.atomic_admission !== true || hint.model !== 'MiniMax-H3'
    || hint.scope !== 'shared_account_pool' || hint.reservation !== false
    || typeof maximum !== 'number' || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16) return 1
  return maximum
}
