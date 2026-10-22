/** Pure naming for isolated Windows installer fixtures. */

/**
 * Copy Windows packaging settings with per-run fixture display and executable names.
 * @template {{ readonly win: object }} T
 * @param {T} config - Production electron-builder configuration.
 * @param {string} productName - Harness Installer Test followed by eight lowercase hexadecimal digits.
 * @returns {Omit<T, 'productName' | 'win'> & { productName: string, win: Omit<T['win'], 'executableName'> & { executableName: string } }} Configuration retaining the other production settings.
 * @throws {Error} When productName is not a per-run fixture name.
 */
export function createWindowsInstallerFixtureConfig(config, productName) {
  if (!/^Harness Installer Test [0-9a-f]{8}$/u.test(productName) || productName.trim() !== productName) {
    throw new Error('Windows installer fixture requires a per-run Harness Installer Test name')
  }
  return { ...config, productName, win: { ...config.win, executableName: productName } }
}
