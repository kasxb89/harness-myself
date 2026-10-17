/** Select local test defaults or platform release settings without changing the caller's environment. */

/**
 * Select unsigned macOS settings without inheriting release identities or credentials.
 * @param environment Parent environment, retained for build tools and networking.
 * @param appRoot Optional application directory whose .env.macos supplies only the application identifier and update authority.
 * @returns Unsigned build environment without signing credentials or mandatory-update policy.
 */
export function localMacOSPackageEnvironment(environment?: NodeJS.ProcessEnv, appRoot?: string): NodeJS.ProcessEnv

/**
 * Read the target's required UTF-8 dotenv file; release settings never fall back to ambient values.
 * @param platform Target platform.
 * @param environment Parent environment, retained only for unrelated build tools.
 * @param appRoot Desktop application directory; relative credential paths resolve here.
 * @returns Isolated environment with file-owned release settings.
 */
export function loadDesktopPackageEnvironment(
  platform: 'win32' | 'darwin',
  environment?: NodeJS.ProcessEnv,
  appRoot?: string,
): NodeJS.ProcessEnv

/**
 * Validate the packaging mode before preparation without invoking a token or Apple's services.
 * @param environment Selected local defaults or file-owned release settings.
 * @param target Selected release target.
 * @param options Explicit packaging mode.
 * @returns Nothing.
 */
export function validateDesktopPackageEnvironment(
  environment: NodeJS.ProcessEnv,
  target: { platform: 'win32' | 'darwin', arch: string },
  options?: { unsigned?: boolean, prepareOnly?: boolean },
): void
