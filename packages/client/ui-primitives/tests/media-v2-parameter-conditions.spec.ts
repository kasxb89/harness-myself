/** Reviewed parameter predicates stay independent from material rules and never rewrite text. */
import { expect, it } from 'vitest'
import { mediaV2ParameterIssues } from '../src/media-v2-parameter-conditions.ts'
import { mediaV2FormIssues } from '../src/media-v2-form.ts'
import type { MediaV2Model, MediaV2Value } from '../src/media-v2-types.ts'

const model: MediaV2Model = {
  id: 'synthetic-reviewed-parameters', display_name: 'Synthetic reviewed parameters', kind: 'image', model_version: 'v1', enabled: true,
  parameters_schema: { type: 'object', additionalProperties: false, properties: {
    prompt: { type: 'string' }, negative_prompt: { type: 'string' }, extra: { type: 'string' },
    bot_type: { type: 'string' }, version: { type: 'string' }, quality: { type: 'number' },
  } }, asset_fields: [], intents: [{ id: 'text', label: 'Text', requires_assets: false }],
  pricing: { display: '', quote_required: true, credits_per_yuan: 1000 },
}
const versionRule = { id: 'reviewed-version', when: { bot_type: ['NIJI_JOURNEY'] }, parameter: 'version',
  disallowed_values: ['8.2', '8.1', '6.1', '5.2', '5.1'], message: 'Unavailable explicit version' }
const extraRule = { id: 'reviewed-extra', parameter: 'extra', text_flags: { profile: 'reviewed-native-flags-v1',
  allowed_names: ['sameseed', 'fast', 'turbo', 'relax'], forbidden_names: ['repeat', 'r', 'video', 'bs', 'edit'],
  reserved_aliases: { version: 'version', v: 'version', quality: 'quality', q: 'quality' }, require_double_dash: true },
message: 'Use declared controls' }
const prototypeWhen: unknown = JSON.parse('{"__proto__":["x"]}')
const promptRule = { id: 'reviewed-prompt', parameter: 'prompt',
  text_flags: { profile: 'text-no-native-parameter-token-v1' }, message: 'Use declared controls' }
function issues(rules: readonly unknown[], values: Readonly<Record<string, MediaV2Value>>) {
  return mediaV2FormIssues({ ...model, parameter_conditions: { schema_version: 2, rules } }, 'text', values, [], 0)
}

it.each(['8.2', '8.1', '6.1', '5.2', '5.1'])('rejects only explicit blocked versions for the selected engine: %s', (version) => {
  expect(issues([versionRule], { bot_type: 'NIJI_JOURNEY', version }))
    .toContainEqual({ field: 'version', reason: 'parameterCondition' })
  expect(issues([versionRule], { bot_type: 'MID_JOURNEY', version })).toEqual([])
})
it.each(['6', '7', ''])('preserves supported or account-default versions: %s', (version) => {
  const values = { bot_type: 'NIJI_JOURNEY', version }
  expect(issues([versionRule], values)).toEqual([])
  expect(values.version).toBe(version)
})
it('skips a missing target while refusing an explicit null target', () => {
  expect(issues([versionRule], { bot_type: 'NIJI_JOURNEY' })).toEqual([])
  expect(issues([versionRule], { bot_type: 'NIJI_JOURNEY', version: null })).toContainEqual({ field: 'version', reason: 'invalid' })
})
it.each(['--repeat 2', '--r', '--video', '--bs', '--edit', '--v 7', '--quality 2', '--FAST', '-fast', '---fast',
  '--fast=1', '--fast --fast', '"--fast"', '\\--fast', '--fast arg', '--fast\u00a0--turbo'])('rejects unsupported extra flag syntax without rewriting: %s', (extra) => {
  const values = { extra }
  expect(issues([extraRule], values)).toContainEqual({ field: 'extra', reason: 'parameterCondition' })
  expect(values.extra).toBe(extra)
})
it.each(['', ' \t\n\r', '--fast', ' \t--fast\r\n--turbo\t--relax  ', '--sameseed'])('preserves accepted zero-argument advanced text byte-for-byte: %j', (extra) => {
  const values = { extra }
  expect(issues([extraRule], values)).toEqual([])
  expect(values.extra).toBe(extra)
})
it.each(['--video', 'scene --video', 'scene,--ar 1:1', 'scene\u0085--fast', 'scene\u2003--fast'])('rejects prompt-native tokens at reviewed boundaries: %j', (prompt) => {
  expect(issues([promptRule], { prompt })).toContainEqual({ field: 'prompt', reason: 'parameterCondition' })
})
it.each(['black-and-white', 'letters--numbers', 'scene\ufeff--fast', 'scene;--fast', 'hello'])('keeps literal prompt content outside reviewed boundaries: %j', (prompt) => {
  expect(issues([promptRule], { prompt })).toEqual([])
})
it('validates inactive rules and rejects an unknown document version without changing the draft', () => {
  const values = { prompt: 'original prompt', bot_type: 'MID_JOURNEY', version: '7' }
  expect(issues([{ ...versionRule, future_operator: true }], values)).toContainEqual({ field: 'parameters', reason: 'unsupported' })
  expect(mediaV2FormIssues({ ...model, parameter_conditions: { schema_version: 999, rules: [versionRule] } }, 'text', values, [], 0))
    .toContainEqual({ field: 'parameters', reason: 'unsupported' })
  expect(values.prompt).toBe('original prompt')
})

it('evaluates AND predicates and scalar equality without type coercion', () => {
  const candidate = { ...model, parameter_conditions: { schema_version: 2, rules: [
    { ...versionRule, when: { bot_type: ['NIJI_JOURNEY'], quality: [2] } },
  ] } }
  expect(mediaV2ParameterIssues(candidate, { bot_type: 'NIJI_JOURNEY', quality: 2, version: '8.2' }))
    .toContainEqual({ field: 'version', reason: 'parameterCondition' })
  expect(mediaV2ParameterIssues(candidate, { bot_type: 'NIJI_JOURNEY', quality: '2', version: '8.2' })).toEqual([])
  expect(mediaV2ParameterIssues(candidate, { bot_type: 'MID_JOURNEY', quality: 2, version: '8.2' })).toEqual([])
  expect(mediaV2ParameterIssues(candidate, { bot_type: 'NIJI_JOURNEY', version: '8.2' })).toEqual([])
})
it('accepts explicitly empty known options for the token profile without interpreting any flags', () => {
  expect(issues([{ ...promptRule, text_flags: { ...promptRule.text_flags, allowed_names: [], forbidden_names: [],
    reserved_aliases: {}, require_double_dash: false } }], { prompt: 'literal text' })).toEqual([])
})
it.each([
  { schema_version: 2, rules: [] },
  { schema_version: 2, rules: [promptRule], new_root_key: true },
  { schema_version: 2, rules: [promptRule, promptRule] },
  { schema_version: 2, rules: [{ ...promptRule, id: 'Uppercase' }] },
  { schema_version: 2, rules: [{ ...promptRule, parameter: '__proto__' }] },
  { schema_version: 2, rules: [{ ...promptRule, parameter: 'bad-name' }] },
  { schema_version: 2, rules: [{ ...versionRule, disallowed_values: [null] }] },
  { schema_version: 2, rules: [{ ...versionRule, disallowed_values: [Number.NaN] }] },
  { schema_version: 2, rules: [{ ...versionRule, disallowed_values: [Number.POSITIVE_INFINITY] }] },
  { schema_version: 2, rules: [{ ...versionRule, disallowed_values: ['字'.repeat(86)] }] },
  { schema_version: 2, rules: [{ ...versionRule, disallowed_values: ['\ud800'] }] },
  { schema_version: 2, rules: [{ ...promptRule, message: '字'.repeat(342) }] },
  { schema_version: 2, rules: [{ ...versionRule, when: prototypeWhen }] },
  { schema_version: 2, rules: [{ ...promptRule, disallowed_values: ['x'] }] },
  { schema_version: 2, rules: [{ ...extraRule, text_flags: { ...extraRule.text_flags, profile: 'future-profile' } }] },
  { schema_version: 2, rules: [{ ...extraRule, text_flags: { ...extraRule.text_flags, require_double_dash: false } }] },
  { schema_version: 2, rules: [{ ...extraRule, text_flags: { ...extraRule.text_flags, allowed_names: ['fast', 'fast'] } }] },
  { schema_version: 2, rules: [{ ...extraRule, text_flags: { ...extraRule.text_flags, forbidden_names: ['fast'] } }] },
  { schema_version: 2, rules: [{ ...extraRule, text_flags: { ...extraRule.text_flags, reserved_aliases: { fast: 'version' } } }] },
  { schema_version: 2, rules: [{ ...extraRule, text_flags: { ...extraRule.text_flags, arbitrary_regex: '.*' } }] },
  { schema_version: 2, rules: [{ ...promptRule, text_flags: { ...promptRule.text_flags, allowed_names: ['fast'] } }] },
])('blocks the affected model for malformed complete parameter documents: %j', (parameter_conditions) => {
  expect(mediaV2FormIssues({ ...model, parameter_conditions }, 'text', {}, [], 0))
    .toContainEqual({ field: 'parameters', reason: 'unsupported' })
  expect(mediaV2FormIssues(model, 'text', {}, [], 0)).toEqual([])
})
it('enforces exact document, name, UTF-8 literal and predicate bounds', () => {
  expect(issues(Array.from({ length: 32 }, (_value, index) => ({ ...promptRule, id: `rule-${String(index)}` })), {})).toEqual([])
  expect(issues(Array.from({ length: 33 }, (_value, index) => ({ ...promptRule, id: `rule-${String(index)}` })), {}))
    .toContainEqual({ field: 'parameters', reason: 'unsupported' })
  expect(issues([{ ...promptRule, id: 'r'.repeat(64) }], {})).toEqual([])
  expect(issues([{ ...promptRule, id: 'r'.repeat(65) }], {})).toContainEqual({ field: 'parameters', reason: 'unsupported' })
  const when = Object.fromEntries(Array.from({ length: 16 }, (_value, index) => [`field_${String(index)}`, ['literal']]))
  expect(issues([{ ...versionRule, when }], {})).toEqual([])
  expect(issues([{ ...versionRule, when: { ...when, field_16: ['literal'] } }], {}))
    .toContainEqual({ field: 'parameters', reason: 'unsupported' })
  expect(issues([{ ...versionRule, disallowed_values: Array.from({ length: 64 }, (_value, index) => index) }], {})).toEqual([])
  expect(issues([{ ...versionRule, disallowed_values: Array.from({ length: 65 }, (_value, index) => index) }], {}))
    .toContainEqual({ field: 'parameters', reason: 'unsupported' })
  expect(issues([{ ...versionRule, disallowed_values: ['x'.repeat(256), '字'.repeat(85)] }], {})).toEqual([])
  expect(issues([{ ...versionRule, disallowed_values: ['x'.repeat(257)] }], {}))
    .toContainEqual({ field: 'parameters', reason: 'unsupported' })
})

it('retains rules for native parameters hidden from the current form without granting permission to submit them', () => {
  const candidate = { ...model, parameters_schema: { properties: { prompt: { type: 'string' } } },
    parameter_conditions: { schema_version: 2, rules: [extraRule, versionRule] } }
  expect(mediaV2FormIssues(candidate, 'text', { prompt: 'literal text' }, [], 0)).toEqual([])
  const values = { prompt: 'literal text', extra: '--fast' }
  expect(mediaV2FormIssues(candidate, 'text', values, [], 0)).toContainEqual({ field: 'extra', reason: 'unavailable' })
  expect(values.extra).toBe('--fast')
})
it('accepts the exact message byte bound while preserving exact boolean predicates', () => {
  const candidate = { ...model, parameter_conditions: { schema_version: 2,
    rules: [{ id: 'exact-boolean', parameter: 'quality', disallowed_values: [true], message: 'x'.repeat(1024) }] } }
  expect(mediaV2ParameterIssues(candidate, { quality: true })).toContainEqual({ field: 'quality', reason: 'parameterCondition' })
  expect(mediaV2ParameterIssues(candidate, { quality: 'true' })).toEqual([])
  expect(mediaV2ParameterIssues(candidate, { quality: 1 })).toEqual([])
  expect(mediaV2ParameterIssues({ ...candidate, parameter_conditions: { schema_version: 2,
    rules: [{ id: 'exact-boolean', parameter: 'quality', disallowed_values: [true], message: 'x'.repeat(1025) }] } }, {}))
    .toContainEqual({ field: 'parameters', reason: 'unsupported' })
})

it('treats inherited object properties as missing parameter-map entries', () => {
  const candidate = { ...model, parameter_conditions: { schema_version: 2, rules: [
    { ...promptRule, id: 'hidden-constructor', parameter: 'constructor' },
  ] } }
  expect(mediaV2ParameterIssues(candidate, {})).toEqual([])
  const values: Record<string, MediaV2Value> = { version: '8.2' }
  Object.setPrototypeOf(values, { bot_type: 'NIJI_JOURNEY' })
  expect(mediaV2ParameterIssues({ ...model, parameter_conditions: { schema_version: 2, rules: [versionRule] } }, values)).toEqual([])
})
