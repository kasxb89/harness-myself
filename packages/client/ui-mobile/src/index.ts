/**
 * Sidebar Mobile entry, node half. The empty apply gives Loader a host-side row
 * while the browser half ships through `exports["./client"]`; the WeChat binding
 * front it shows is the IM bridge's own panel, reached through the client
 * service that bridge provides.
 */

/** Host plugin body — this package contributes browser presentation only. */
export function apply(): void {}
