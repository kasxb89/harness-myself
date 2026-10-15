/**
 * Sidebar Image entry, node half. The empty apply gives Loader a host-side row
 * while the browser half ships through `exports["./client"]`; the generation
 * itself is proxied by `@deepseek-ai/dsh-credits-index`.
 */

/** Host plugin body — this package contributes browser presentation only. */
export function apply(): void {}
