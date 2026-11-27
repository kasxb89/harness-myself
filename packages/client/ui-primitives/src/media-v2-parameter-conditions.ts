/** Reviewed scalar dependencies and finite native-text syntax from the public media catalog. */
import { mediaV2Object, type MediaV2Model, type MediaV2Value } from './media-v2-types.ts'

type Scalar = string | number | boolean
type TextPolicy = { readonly kind: 'tokens' } | { readonly kind: 'flags'; readonly allowed: readonly string[] }
interface Rule {
  readonly when: Readonly<Record<string, readonly Scalar[]>>
  readonly parameter: string
  readonly predicate: { readonly values: readonly Scalar[] } | { readonly text: TextPolicy }
}
const only = (row: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(row).every(key => keys.includes(key))
const name = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(value)
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/u.test(value)
function unicodeText(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) return false
  }
  return true
}
function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && unicodeText(value) && new TextEncoder().encode(value).byteLength <= maximum
}
const scalar = (value: unknown): value is Scalar => typeof value === 'boolean'
  || typeof value === 'number' && Number.isFinite(value) || boundedText(value, 256)
function literals(value: unknown): value is readonly Scalar[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 64 && value.every(scalar)
}
function names(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.length <= 64 && value.every(name) ? value : null
}
function textPolicy(value: unknown): TextPolicy | null {
  const row = mediaV2Object(value)
  if (row === null || !only(row, ['profile', 'allowed_names', 'forbidden_names', 'reserved_aliases', 'require_double_dash'])) return null
  const allowed = row.allowed_names === undefined ? [] : names(row.allowed_names)
  const forbidden = row.forbidden_names === undefined ? [] : names(row.forbidden_names)
  const reserved = row.reserved_aliases === undefined ? {} : mediaV2Object(row.reserved_aliases)
  if (allowed === null || forbidden === null || reserved === null || Object.keys(reserved).length > 64
    || !Object.entries(reserved).every(([alias, parameter]) => name(alias) && name(parameter))) return null
  if (row.profile === 'text-no-native-parameter-token-v1') {
    return allowed.length === 0 && forbidden.length === 0 && Object.keys(reserved).length === 0
      && (row.require_double_dash === undefined || row.require_double_dash === false) ? { kind: 'tokens' } : null
  }
  if (row.profile !== 'reviewed-native-flags-v1' || row.require_double_dash !== true || allowed.length === 0) return null
  const flags = [...allowed, ...forbidden, ...Object.keys(reserved)]
  if (new Set(flags).size !== flags.length) return null
  return { kind: 'flags', allowed }
}
function readRule(value: unknown): { readonly id: string; readonly rule: Rule } | null {
  const row = mediaV2Object(value)
  if (row === null || !only(row, ['id', 'when', 'parameter', 'disallowed_values', 'text_flags', 'message'])
    || !id(row.id) || !name(row.parameter) || !boundedText(row.message, 1024) || row.message === '') return null
  const when = row.when === undefined ? {} : mediaV2Object(row.when)
  if (when === null || Object.keys(when).length > 16) return null
  const admitted: Record<string, readonly Scalar[]> = {}
  for (const [key, values] of Object.entries(when)) {
    if (!name(key) || !literals(values)) return null
    admitted[key] = values
  }
  if ((row.disallowed_values !== undefined) === (row.text_flags !== undefined)) return null
  if (row.disallowed_values !== undefined) {
    return literals(row.disallowed_values)
      ? { id: row.id, rule: { parameter: row.parameter, when: admitted, predicate: { values: row.disallowed_values } } } : null
  }
  const policy = textPolicy(row.text_flags)
  return policy === null ? null : { id: row.id, rule: { parameter: row.parameter, when: admitted, predicate: { text: policy } } }
}
function whitespace(code: number): boolean {
  return code >= 0x09 && code <= 0x0d || code === 0x20 || code === 0x85 || code === 0xa0 || code === 0x1680
    || code >= 0x2000 && code <= 0x200a || [0x2028, 0x2029, 0x202f, 0x205f, 0x3000].includes(code)
}
function acceptedText(policy: TextPolicy, value: string): boolean {
  if (!unicodeText(value)) return false
  if (policy.kind === 'tokens') {
    for (let index = 0; index + 1 < value.length; index += 1) {
      if (value[index] === '-' && value[index + 1] === '-'
        && (index === 0 || value[index - 1] === ',' || whitespace(value.charCodeAt(index - 1)))) return false
    }
    return true
  }
  const seen = new Set<string>()
  for (const token of value.split(/[ \t\n\r]+/u).filter(token => token !== '')) {
    if (!token.startsWith('--')) return false
    const flag = token.slice(2)
    if (!name(flag) || !policy.allowed.includes(flag) || seen.has(flag)) return false
    seen.add(flag)
  }
  return true
}

/**
 * Validate the entire reviewed parameter document before evaluating exact scalar and fixed text predicates.
 * @param model - Selected model whose unknown rules block only its new actions.
 * @param values - Retained native parameters; accepted text is neither removed nor rewritten.
 * @returns Localized issue identities, without changing materials or any original operation.
 */
export function mediaV2ParameterIssues(model: MediaV2Model, values: Readonly<Record<string, MediaV2Value>>):
readonly { field: string; reason: 'parameterCondition' | 'invalid' | 'unsupported' }[] {
  if (model.parameter_conditions === undefined) return []
  const unsupported = [{ field: 'parameters', reason: 'unsupported' as const }]
  const document = mediaV2Object(model.parameter_conditions)
  if (document === null || !only(document, ['schema_version', 'rules']) || document.schema_version !== 2
    || !Array.isArray(document.rules) || document.rules.length === 0 || document.rules.length > 32) return unsupported
  const rules: Rule[] = [], ids = new Set<string>()
  for (const value of document.rules) {
    const parsed = readRule(value)
    if (parsed === null || ids.has(parsed.id)) return unsupported
    ids.add(parsed.id); rules.push(parsed.rule)
  }
  return rules.flatMap((rule): { field: string; reason: 'parameterCondition' | 'invalid' }[] => {
    if (!Object.entries(rule.when).every(([key, choices]) => Object.hasOwn(values, key)
      && choices.some(choice => choice === values[key]))) return []
    if (!Object.hasOwn(values, rule.parameter)) return []
    const value = values[rule.parameter]
    if (value === undefined) return []
    if (value === null) return [{ field: rule.parameter, reason: 'invalid' as const }]
    const rejected = 'values' in rule.predicate ? rule.predicate.values.some(choice => choice === value)
      : typeof value !== 'string' || !acceptedText(rule.predicate.text, value)
    return rejected ? [{ field: rule.parameter, reason: 'parameterCondition' as const }] : []
  })
}
