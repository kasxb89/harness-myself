/**
 * Sidebar Plaza entry, node half. The empty apply gives Loader a host-side row
 * while the browser half ships through `exports["./client"]`; the market panel
 * itself is served by the profile's market plugin.
 */

/** Host plugin body — this package contributes browser presentation only. */
export function apply(): void {}
