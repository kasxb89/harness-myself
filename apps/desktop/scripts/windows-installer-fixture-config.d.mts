/** Types for isolated Windows installer fixture naming. */

/**
 * Copy Windows packaging settings with per-run fixture display and executable names.
 * @param config - Production electron-builder configuration.
 * @param productName - Harness Installer Test followed by eight lowercase hexadecimal digits.
 * @returns Configuration retaining the other production settings.
 * @throws {Error} When productName is not a per-run fixture name.
 */
export function createWindowsInstallerFixtureConfig<T extends { readonly win: object }>(
  config: T,
  productName: string,
): Omit<T, 'productName' | 'win'> & {
  productName: string
  win: Omit<T['win'], 'executableName'> & { executableName: string }
}
