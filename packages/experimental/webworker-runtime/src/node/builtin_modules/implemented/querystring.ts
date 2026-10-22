/** Flat query decoding for the IM client's default Node querystring.parse call. */
import type { ParsedUrlQuery, ParseOptions } from 'node:querystring'
import { notAvailableError } from '../../notImplementedFail.ts'

/**
 * Decode default ampersand/equal query syntax, retaining duplicates and null-prototype keys.
 * @param text - Query text without implicit question-mark removal.
 * @param separator - Only the default `&` separator is supported.
 * @param equals - Only the default `=` assignment separator is supported.
 * @param options - Custom decoding and limits are unsupported; the Node default is 1000 fields.
 * @returns Decoded strings and duplicate-key arrays in a null-prototype record.
 */
export function parse(text: string, separator?: string, equals?: string, options?: ParseOptions): ParsedUrlQuery {
  if ((separator !== undefined && separator !== '&') || (equals !== undefined && equals !== '=') || options !== undefined) {
    throw notAvailableError('node:querystring', 'parse custom separators or options')
  }
  const result = Object.create(null) as ParsedUrlQuery
  if (typeof text !== 'string' || text === '') return result
  if (!text.isWellFormed()) throw notAvailableError('node:querystring', 'parse malformed UTF-16')
  // A leading ampersand prevents URLSearchParams from stripping a literal '?'.
  // Slice fields first: Node's limit also counts empty delimiter-separated fields.
  const parameters = new URLSearchParams('&' + text.split('&', 1000).join('&'))
  for (const [key, value] of parameters) {
    const previous = result[key]
    if (previous === undefined) result[key] = value
    else if (typeof previous === 'string') result[key] = [previous, value]
    else previous.push(value)
  }
  return result
}

/** CommonJS interop marker. */
export const __esModule = true
/** Only the current default flat decoder is exposed. */
export default { parse } satisfies Partial<typeof import('node:querystring')>
