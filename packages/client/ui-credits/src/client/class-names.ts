/** Join class names, dropping the `undefined` an absent CSS-module key yields. */
export function cx(...names: readonly (string | undefined)[]): string {
  return names.filter(name => name !== undefined).join(' ')
}
