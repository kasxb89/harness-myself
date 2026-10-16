/**
 * Join class names, dropping the `undefined` an absent CSS-module key yields.
 * @param names - defined class names or absent CSS-module values.
 * @returns the defined names joined by single spaces.
 */
export function cx(...names: readonly (string | undefined)[]): string {
  return names.filter(name => name !== undefined).join(' ')
}
