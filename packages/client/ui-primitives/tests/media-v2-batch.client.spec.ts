import { expect, it } from 'vitest'
import { mediaV2FormIssues } from '../src/media-v2-form.ts'
import { parseMediaV2Catalog, parseMediaV2Record, readMediaV2Batch, readMediaV2Quantity, mediaV2TaskComplete, mediaV2QuoteBatchValid } from '../src/media-v2-types.ts'
import type { MediaV2Model } from '../src/media-v2-types.ts'

const model: MediaV2Model = { id: 'synthetic-native-batch', kind: 'video', display_name: 'Synthetic native batch', model_version: 'v1', enabled: true,
  parameters_schema: { properties: { count: { type: 'integer', minimum: 1, maximum: 4, default: 1 },
    mode: { type: 'string', enum: ['approved', 'other'], default: 'approved' } } }, asset_fields: [],
  intents: [{ id: 'text', label: 'Text', requires_assets: false }], pricing: { display: '', credits_per_yuan: 1000, quote_required: true } }
const quantity = { schema_version: 1, parameter: 'count', minimum: 1, maximum: 4, default: 1, semantics: 'native_operation_main_outputs',
  meter: 'output_count', admission_unit: 'native_operation', admission_weight: 1,
  partial_policy: 'retain_reservation_until_complete', policy_revision: 'a'.repeat(64), modes: ['approved'] }
const batch = { schema_version: 1, requested_output_count: 2, expected_main_output_count: 2, output_duration_seconds: 5,
  total_output_seconds: 10, meter: 'output_count', admission_unit: 'native_operation', admission_weight: 1,
  partial_policy: 'retain_reservation_until_complete', policy_revision: 'a'.repeat(64) }
function record(quoteBatch: unknown = batch, taskBatch: unknown = { ...batch, received_main_output_count: 2, completeness: 'complete' }) {
  return { version: 1, owner: 'synthetic-owner', state: 'accepted', updated_at: 1,
    request: { client_operation_id: '10000000-0000-4000-8000-000000000081', model: model.id, model_version: 'v0', intent: 'text',
      parameters: { mode: 'approved', count: 2 }, assets: {} },
    quote: { quote_id: 'synthetic-quote', client_operation_id: '10000000-0000-4000-8000-000000000081', request_sha256: 'b'.repeat(64),
      retail_cny: '0.75', credits: 750, credits_per_yuan: 1000, expires_at: 10000, batch: quoteBatch },
    task: { id: 'synthetic-task', model: model.id, kind: 'video', status: 'succeeded', is_final: true, batch: taskBatch,
      artifacts: [
        { key: 'first', type: 'video', mime_type: 'video/mp4', order: 0, role: 'main', output_id: 'main-1', output_index: 0 },
        { key: 'second', type: 'video', mime_type: 'video/mp4', order: 1, role: 'main', output_id: 'main-2', output_index: 1 },
        { key: 'preview', type: 'image', mime_type: 'image/png', order: 2, role: 'preview' },
        { key: 'duplicate', type: 'video', mime_type: 'video/mp4', order: 3, role: 'duplicate', output_id: 'main-1', output_index: 0 },
      ] } }
}

it('retains native quantity and the explicit optional batch capability as catalog data', () => {
  const parsed = parseMediaV2Catalog({ models: [{ ...model, quantity }], credits_per_yuan: 1000,
    capabilities: { native_video_batch_v1: true } })
  expect(parsed.capabilities).toMatchObject({ native_video_batch_v1: true })
  expect(parsed.models[0]).toMatchObject({ quantity })
})
it('retains unknown quantity metadata on only its model without destroying the catalog', () => {
  const unknown = { schema_version: 999, future_policy: true }
  const parsed = parseMediaV2Catalog({ models: [{ ...model, quantity: unknown }, { ...model, id: 'unaffected' }], credits_per_yuan: 1000 })
  expect(parsed.models[0]).toMatchObject({ quantity: unknown })
  expect(parsed.models[1]).not.toHaveProperty('quantity')
})
it('retains frozen aggregate quote, task counters and every logical or auxiliary artifact', () => {
  const input = record(), before = JSON.stringify(input), parsed = parseMediaV2Record(input)
  expect(parsed.quote).toMatchObject({ batch, retail_cny: '0.75', credits: 750 })
  expect(parsed.task).toMatchObject({ batch: input.task.batch, artifacts: input.task.artifacts })
  expect(parsed.request.parameters).toEqual({ mode: 'approved', count: 2 })
  expect(JSON.stringify(input)).toBe(before)
})
it('retains future batch metadata for original-operation read recovery instead of dropping it into legacy success', () => {
  const future = { schema_version: 999, future_counter: 3 }, input = record(future, future)
  const parsed = parseMediaV2Record(input)
  expect(parsed.quote).toMatchObject({ batch: future })
  expect(parsed.task).toMatchObject({ batch: future, artifacts: input.task.artifacts })
})
it('conservatively blocks unqualified native video count above one without changing legacy image quantity', () => {
  expect(mediaV2FormIssues(model, 'text', { count: 2, mode: 'approved' }, [], 0))
    .toContainEqual({ field: 'count', reason: 'limit' })
  expect(mediaV2FormIssues(model, 'text', { count: 1, mode: 'approved' }, [], 0)).toEqual([])
  expect(mediaV2FormIssues({ ...model, kind: 'image' }, 'text', { count: 2, mode: 'approved' }, [], 0)).toEqual([])
})

it('permits only an explicit supported quantity/capability/mode and never raises the published schema maximum', () => {
  const candidate = { ...model, quantity }
  expect(mediaV2FormIssues(candidate, 'text', { count: 4, mode: 'approved' }, [], 0, true)).toEqual([])
  expect(mediaV2FormIssues(candidate, 'text', { count: 2, mode: 'approved' }, [], 0, false))
    .toContainEqual({ field: 'count', reason: 'limit' })
  expect(mediaV2FormIssues(candidate, 'text', { count: 2, mode: 'other' }, [], 0, true))
    .toContainEqual({ field: 'mode', reason: 'unavailable' })
  expect(mediaV2FormIssues({ ...model, quantity: { ...quantity, maximum: 5 } }, 'text', { count: 2, mode: 'approved' }, [], 0, true))
    .toContainEqual({ field: 'parameters', reason: 'unsupported' })
  expect(mediaV2FormIssues({ ...model, quantity: { ...quantity, schema_version: 999 } }, 'text', { count: 1 }, [], 0, true))
    .toContainEqual({ field: 'parameters', reason: 'unsupported' })
})
it.each([{ ...quantity, maximum: 51 }, { ...quantity, default: 2 }, { ...quantity, modes: [] }, { ...quantity, modes: ['approved', 'approved'] },
  { ...quantity, meter: ['output_count'] }, { ...quantity, policy_revision: 'NOT-A-HASH' }, { ...quantity, future_rule: true }])(
  'keeps malformed quantity metadata unsupported: %j', (value) => { expect(readMediaV2Quantity(value)).toBeNull() })
it('uses only matching original quote/task main identities for batch completion', () => {
  const input = record(), parsed = parseMediaV2Record(input)
  expect(mediaV2TaskComplete(parsed)).toBe(true)
  expect(mediaV2QuoteBatchValid(parsed, 'video')).toBe(true)
  const partial = parseMediaV2Record(record(batch, { ...batch, received_main_output_count: 1, completeness: 'partial' }))
  expect(mediaV2TaskComplete(partial)).toBe(false)
  const mismatch = parseMediaV2Record(record(batch, { ...batch, received_main_output_count: 3, completeness: 'mismatch' }))
  expect(mediaV2TaskComplete(mismatch)).toBe(false)
  if (parsed.task === undefined) throw new Error('Expected original task')
  const { batch: _batch, ...withoutBatch } = parsed.task
  expect(mediaV2TaskComplete({ ...parsed, task: withoutBatch })).toBe(false)
  expect(mediaV2TaskComplete(parseMediaV2Record(record(batch, { ...batch, policy_revision: 'c'.repeat(64),
    received_main_output_count: 2, completeness: 'complete' })))).toBe(false)
  const duplicate = parseMediaV2Record(record())
  if (duplicate.task === undefined) throw new Error('Expected original task')
  expect(mediaV2TaskComplete({ ...duplicate, task: { ...duplicate.task, artifacts: duplicate.task.artifacts.filter(item => item.key !== 'second') } })).toBe(false)
  expect(mediaV2TaskComplete(parseMediaV2Record(record({ ...batch, schema_version: 999 }, { ...batch, schema_version: 999 })))).toBe(false)
})
it('preserves excess-output metadata for mismatch but never uses it to claim a complete result', () => {
  const mismatch = { ...batch, received_main_output_count: 64, completeness: 'mismatch' }
  expect(readMediaV2Batch(mismatch, 'task')).toMatchObject({ received_main_output_count: 64, completeness: 'mismatch' })
  const input = record(batch, mismatch)
  input.task.artifacts.push({ key: 'excess', type: 'video', mime_type: 'video/mp4', order: 4, role: 'main', output_id: 'main-64', output_index: 63 })
  const parsed = parseMediaV2Record(input)
  expect(parsed.task?.artifacts).toHaveLength(5)
  expect(mediaV2TaskComplete(parsed)).toBe(false)
})
it.each([{ ...batch, total_output_seconds: 9 }, { ...batch, output_duration_seconds: -1 }, { ...batch, requested_output_count: 51 },
  { ...batch, meter: 'total_output_seconds', output_duration_seconds: 0, total_output_seconds: 0 },
  { ...batch, schema_version: 999 }, { ...batch, future_rule: true }])('does not interpret malformed batch metadata as completion: %j', (value) => {
  expect(readMediaV2Batch(value, 'quote')).toBeNull()
})

it.each(['kind', 'model'] as const)('does not complete a known batch attached to another task identity: %s', (field) => {
  const original = parseMediaV2Record(record())
  if (original.task === undefined) throw new Error('Expected original task')
  const task = field === 'kind' ? { ...original.task, kind: 'image' as const } : { ...original.task, model: 'another-model' }
  expect(mediaV2TaskComplete({ ...original, task })).toBe(false)
  expect(mediaV2TaskComplete(original)).toBe(true)
})

it('allows an ordinary single video in a native mode outside the reviewed batch modes while blocking multiple outputs there', () => {
  const candidate = { ...model, parameters_schema: { properties: {
    count: { type: 'integer', minimum: 1, maximum: 4, default: 1 },
    mode: { type: 'string', enum: ['text-to-video', 'first-frame'], default: 'text-to-video' },
  } }, quantity: { ...quantity, modes: ['first-frame'] } }
  expect(mediaV2FormIssues(candidate, 'text', { count: 1, mode: 'text-to-video' }, [], 0, true)).toEqual([])
  expect(mediaV2FormIssues(candidate, 'text', { count: 2, mode: 'text-to-video' }, [], 0, true))
    .toContainEqual({ field: 'mode', reason: 'unavailable' })
})
