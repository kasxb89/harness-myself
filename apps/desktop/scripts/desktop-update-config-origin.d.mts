/**
 * Read an explicit release input without supplying a production deployment default.
 * @param environment - File-owned release configuration.
 * @returns HTTPS origin, or no configured authority.
 */
export function resolvePackagedDesktopUpdateConfigOrigin(environment: NodeJS.ProcessEnv): string | undefined
