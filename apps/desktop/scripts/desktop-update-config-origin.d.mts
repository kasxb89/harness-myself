/**
 * Read an explicit release input without supplying a production deployment default.
 * @param environment - File-owned release configuration.
 * @returns HTTPS backend base, or no configured authority.
 */
export function resolvePackagedDesktopUpdateConfigOrigin(environment: NodeJS.ProcessEnv): string | undefined

/**
 * Resolve backend discovery for an explicitly unsigned product package.
 * @param environment - File-owned packaging settings.
 * @param platform - Target Node.js platform.
 * @param arch - Target Node.js architecture.
 * @returns Validated backend and inert generic bootstrap directory; runtime replaces the feed from backend status before checking.
 */
export function resolveUnsignedDesktopUpdateConfig(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  arch: string,
): { authority: string, publicUrl: string }
