/**
 * Sidebar Artifacts entry, node half. The empty apply gives Loader a host-side
 * row while the browser half ships through `exports["./client"]`; the file
 * listing itself is served by `@deepseek-ai/dsh-artifacts-index`.
 */

/** Host plugin body — this package contributes browser presentation only. */
export function apply(): void {}
