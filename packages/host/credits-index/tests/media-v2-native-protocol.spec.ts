import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { mediaV2Object, parseMediaV2Catalog, parseMediaV2Operation, parseMediaV2Quote, parseMediaV2Request, parseMediaV2Task, parseMediaV2Batch, parseMediaV2TaskBatch, mediaV2TaskComplete } from '../src/media-v2-protocol.ts'

const request = { client_operation_id: '02d6a836-08a6-4db8-8e08-1e562c50ee3c', model: 'synthetic-native',
  model_version: 'original-version', intent: 'reference', parameters: { prompt: '原画面' },
  assets: { first_frame: ['asset-first'], videos: ['asset-video'], audios: ['asset-audio'] } }
const capabilities = { media_generation_v2: true, quote_required: true, durable_operation_receipt: true, all_artifacts: true }
const syntheticAudio = { id: 'synthetic-audio', display_name: 'Synthetic audio', kind: 'audio', model_version: 'audio-1',
  parameters_schema: { type: 'object', properties: { text: { type: 'string' } } }, asset_fields: [],
  intents: [{ id: 'text', label: 'Text', requires_assets: false }], enabled: true,
  pricing: { display: 'Synthetic quote only', credits_per_yuan: 1000, quote_required: true } }

async function actualGoCatalog(): Promise<Record<string, unknown> & { models: readonly Record<string, unknown>[] }> {
  const value: unknown = JSON.parse(await readFile(new URL('./fixtures/media-v2-native-go-catalog.json', import.meta.url), 'utf8'))
  const data = mediaV2Object(mediaV2Object(value).data)
  if (!Array.isArray(data.models)) throw new Error('Actual Go catalog fixture has no models')
  return { ...data, models: data.models.map((model: unknown) => mediaV2Object(model)) }
}

describe('native media protocol values', () => {
  it('retains recursive JSON controls and every ordered material without rewriting caller data', () => {
    const parameters = { prompt: '同一角色', frames: [{ time: 0, settings: { strength: 0.5, enabled: false, mask: null } },
      { time: 2, settings: { strength: 1, enabled: true, mask: 'alpha' } }], weights: [0.2, 0.8], flags: [true, false] }
    const input = { ...request, parameters }, before = JSON.stringify(input)
    const parsed = parseMediaV2Request(input)
    expect(parsed.parameters).toEqual(parameters)
    expect(parsed.assets).toEqual(request.assets)
    expect(parsed.client_operation_id).toBe(request.client_operation_id)
    expect(JSON.stringify(input)).toBe(before)
    expect(parsed.parameters.frames).not.toBe(parameters.frames)
  })

  it.each([NaN, Infinity, undefined, new Uint8Array([1]), new Date(0)])('rejects a non-JSON parameter before dispatch: %s', (value) => {
    expect(() => parseMediaV2Request({ ...request, parameters: { value } })).toThrow()
  })

  it('bounds depth, collection size and complete parameter bytes rather than truncating input', () => {
    let nested: object = { value: 'root' }
    for (let i = 0; i < 14; i++) nested = { next: nested }
    expect(() => parseMediaV2Request({ ...request, parameters: { nested } })).toThrow()
    expect(() => parseMediaV2Request({ ...request, parameters: { values: Array(1001).fill(1) } })).toThrow()
    const tooManyFields = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`key${i}`, 1]))
    expect(() => parseMediaV2Request({ ...request, parameters: tooManyFields })).toThrow()
    expect(() => parseMediaV2Request({ ...request, parameters: { values: Array.from({ length: 11 }, () => 'x'.repeat(100_000)) } })).toThrow()
    const tooManyValues = Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => 1))
    expect(() => parseMediaV2Request({ ...request, parameters: { values: tooManyValues } })).toThrow()
  })

  it('continues to reject missing materials and reference-to-text coercion', () => {
    expect(() => parseMediaV2Request({ ...request, assets: {} })).toThrow()
    expect(() => parseMediaV2Request({ ...request, intent: 'text' })).toThrow()
    expect(() => parseMediaV2Request({ ...request, parameters: { '$future-rule': true } })).toThrow()
  })
})

describe('catalog compatibility', () => {
  it.each([true, false, undefined])('retains the optional material-condition capability without inventing support: %s', (advertised) => {
    const parsed = parseMediaV2Catalog({ capabilities: {
      ...capabilities, ...advertised === undefined ? {} : { material_conditions_v1: advertised },
    }, credits_per_yuan: 1000, models: [syntheticAudio] })
    expect(parsed.capabilities.material_conditions_v1).toBe(advertised)
    expect('material_conditions_v1' in parsed.capabilities).toBe(advertised !== undefined)
  })

  it.each([[null], [1], ['true'], [{}], [[]]])('rejects a malformed advertised material-condition capability: %s', (advertised) => {
    expect(() => parseMediaV2Catalog({ capabilities: { ...capabilities, material_conditions_v1: advertised },
      credits_per_yuan: 1000, models: [syntheticAudio] })).toThrow()
  })

  it.each([
    { schema_version: 1, rules: [{ id: 'reference-image-count', when: { mode: ['reference'] }, asset_field: 'images',
      disallowed_counts: [1], message: 'Select explicit first-frame mode for one image' }] },
    { schema_version: 1, rules: [{ id: 'reference-audio-requires-visual', when: { mode: ['reference'] }, asset_field: 'audios',
      requires_any_assets: ['images', 'videos'], message: 'Reference audio needs a visual reference' }] },
    { schema_version: 2, rules: [{ '$future-rule': { depends_on: ['images'] } }] },
    { schema_version: 1, rules: 'unknown rule array' },
  ])('preserves declared and unsupported condition data independently of other models', (conditions) => {
    const input = { capabilities: { ...capabilities, material_conditions_v1: true }, credits_per_yuan: 1000,
      models: [{ ...syntheticAudio, conditions }, { ...syntheticAudio, id: 'unaffected-model' }] }
    const before = JSON.stringify(input), parsed = parseMediaV2Catalog(input)
    expect(parsed.models[0]?.conditions).toEqual(conditions)
    expect(parsed.models[1]?.conditions).toBeUndefined()
    expect(JSON.stringify(input)).toBe(before)
  })

  it('keeps non-JSON or excessive condition data outside the catalog parser budget', () => {
    const catalog = { capabilities, credits_per_yuan: 1000, models: [syntheticAudio] }
    for (const conditions of [NaN, new Date(0), new Uint8Array([1]), { rules: 'x'.repeat(100_001) }]) {
      expect(() => parseMediaV2Catalog({ ...catalog, models: [{ ...syntheticAudio, conditions }] })).toThrow()
    }
  })

  it('decodes an accepted original receipt without consulting newer model conditions or quantity limits', () => {
    const originalId = request.client_operation_id
    const task = { id: 'old-original-task', model: request.model, kind: 'video', status: 'succeeded', is_final: true,
      created_at: 1, updated_at: 2, artifacts: [{ key: 'original', type: 'video', mime_type: 'video/mp4', order: 0,
        content_url: '/v1/tasks/old-original-task/artifacts/original/content', sha256: 'c'.repeat(64), bytes: 123 }] }
    const quoted = { ...request, parameters: { mode: 'reference', count: 2 }, assets: { videos: ['first-video', 'second-video'] },
      quote_id: 'original-quote', request_sha256: 'b'.repeat(64), retail_cny: '1.00', credits: 1000, credits_per_yuan: 1000,
      expires_at: 1, operation_state: 'accepted', task }
    const input = { client_operation_id: originalId, state: 'accepted', quote_id: quoted.quote_id, task, quote: quoted }
    const before = JSON.stringify(input), parsed = parseMediaV2Operation(input)
    expect(parsed.client_operation_id).toBe(originalId)
    expect(parsed.quote?.parameters).toEqual({ mode: 'reference', count: 2 })
    expect(parsed.quote?.assets).toEqual({ videos: ['first-video', 'second-video'] })
    expect(parsed.task?.artifacts).toEqual(task.artifacts)
    expect(JSON.stringify(input)).toBe(before)
  })

  it('preserves the actual Go model definitions and all native constraints', async () => {
    const raw = await actualGoCatalog()
    const parsed = parseMediaV2Catalog({ ...raw, credits_per_yuan: 1000 })
    expect(parsed.models).toHaveLength(2)
    for (const model of parsed.models) {
      const original = raw.models.find(item => item.id === model.id)
      expect(model.parameters_schema).toEqual(original?.parameters_schema)
      expect(model.asset_fields).toEqual(original?.asset_fields)
      expect(model.model_version).toBe(original?.model_version)
    }
  })

  it('keeps image/video catalogs readable alongside a declared audio model and retains conditions', async () => {
    const raw = await actualGoCatalog()
    const conditions = [{ when: { mode: ['reference'] }, requires: ['images'] }]
    const parsed = parseMediaV2Catalog({ ...raw, credits_per_yuan: 1000,
      capabilities: { ...capabilities, max_upload_bytes: 200 * 1024 * 1024 },
      models: [...raw.models, { ...syntheticAudio, conditions }] })
    expect(parsed.models.map(model => model.kind)).toEqual(['image', 'video', 'audio'])
    expect(parsed.models[2]?.conditions).toEqual(conditions)
    expect(parsed.capabilities.max_upload_bytes).toBe(200 * 1024 * 1024)
    expect(() => parseMediaV2Catalog({ ...raw, credits_per_yuan: 1000,
      capabilities: { ...capabilities, max_upload_bytes: -1 } })).toThrow()
  })

  it('decodes an original audio task and every companion output without granting generation', () => {
    const task = parseMediaV2Task({ id: 'task-original-audio', model: syntheticAudio.id, kind: 'audio', status: 'succeeded',
      is_final: true, created_at: 1, updated_at: 2, artifacts: [
        { key: 'main', type: 'audio', mime_type: 'audio/wav', order: 0, content_url: '/v1/tasks/task-original-audio/artifacts/main/content' },
        { key: 'subtitle', type: 'file', mime_type: 'text/plain', order: 1, content_url: '/v1/tasks/task-original-audio/artifacts/subtitle/content' },
      ] })
    expect(task.kind).toBe('audio')
    expect(task.artifacts.map(artifact => artifact.key)).toEqual(['main', 'subtitle'])
  })
})

describe('qualified native batch metadata', () => {
  const quantity = { schema_version: 1, parameter: 'count', minimum: 1, maximum: 4, default: 1,
    semantics: 'native_operation_main_outputs', meter: 'total_output_seconds', admission_unit: 'native_operation', admission_weight: 1,
    partial_policy: 'retain_reservation_until_complete', policy_revision: 'd'.repeat(64) }
  const batch = { schema_version: 1, requested_output_count: 2, expected_main_output_count: 2, output_duration_seconds: 5,
    total_output_seconds: 10, meter: 'total_output_seconds', admission_unit: 'native_operation', admission_weight: 1,
    partial_policy: 'retain_reservation_until_complete', policy_revision: quantity.policy_revision }
  const selected = { ...request, parameters: { prompt: 'Two original videos', count: 2, duration: 5 } }
  const quote = { ...selected, quote_id: 'batch-original-quote', request_sha256: 'b'.repeat(64), retail_cny: '1.70', credits: 1700,
    credits_per_yuan: 1000, expires_at: 2000000000, operation_state: 'quoted', batch }
  const complete = { id: 'batch-original-task', model: request.model, kind: 'video', status: 'succeeded', is_final: true,
    created_at: 1, updated_at: 2, batch: { ...batch, received_main_output_count: 2, completeness: 'complete' },
    artifacts: [1, 2].map((n, order) => ({ key: `video-${n}`, type: 'video', mime_type: 'video/mp4', role: 'main',
      output_id: `main-${n}`, output_index: order, order, content_url: `/v1/tasks/batch-original-task/artifacts/video-${n}/content` })) }

  it.each(['parameter_conditions_v1', 'native_video_batch_v1'])('retains explicit boolean %s capability', (name) => {
    for (const enabled of [true, false]) {
      const parsed = parseMediaV2Catalog({ capabilities: { ...capabilities, [name]: enabled },
        models: [syntheticAudio], credits_per_yuan: 1000 })
      expect(mediaV2Object(parsed.capabilities)[name]).toBe(enabled)
    }
    for (const value of ['true', null, 1, {}, []]) expect(() => parseMediaV2Catalog({ capabilities: { ...capabilities, [name]: value },
      models: [syntheticAudio], credits_per_yuan: 1000 })).toThrow()
  })

  it('preserves quantity and parameter rules including unknown JSON without breaking a neighboring model', () => {
    const parameterConditions = { schema_version: 2, rules: [{ id: 'niji-version', parameter: 'version',
      when: { bot_type: ['NIJI_JOURNEY'] }, disallowed_values: ['8.2'], message: 'Use a supported engine version' }] }
    for (const metadata of [quantity, { schema_version: 999, '$future-quantity': { maximum: 50 } }]) {
      const input = { capabilities: { ...capabilities, parameter_conditions_v1: true, native_video_batch_v1: true },
        models: [{ ...syntheticAudio, quantity: metadata, parameter_conditions: parameterConditions }, { ...syntheticAudio, id: 'unaffected' }], credits_per_yuan: 1000 }
      const before = JSON.stringify(input), parsed = parseMediaV2Catalog(input)
      expect(parsed.models[0]).toMatchObject({ quantity: metadata, parameter_conditions: parameterConditions })
      expect(parsed.models[1]?.id).toBe('unaffected')
      expect(JSON.stringify(input)).toBe(before)
    }
  })

  it('retains the aggregate batch price and frozen quantity policy on the original quotation', () => {
    expect(parseMediaV2Quote(quote)).toMatchObject({ retail_cny: '1.70', batch })
  })

  it('retains logical video output identities and companion aliases without counting them as extra outputs', () => {
    const artifacts = [...complete.artifacts, { ...complete.artifacts[0], key: 'duplicate-video', role: 'duplicate', order: 2 },
      { key: 'preview', type: 'image', mime_type: 'image/png', role: 'preview', output_id: 'main-1', output_index: 0,
        order: 3, content_url: '/v1/tasks/batch-original-task/artifacts/preview/content' }]
    const parsed = parseMediaV2Task({ ...complete, artifacts })
    expect(parsed).toMatchObject({ batch: complete.batch, artifacts })
    expect(parsed.artifacts).toHaveLength(4)
  })

  it.each([
    { requested_output_count: 2.5 }, { requested_output_count: 51 }, { expected_main_output_count: 1 },
    { total_output_seconds: 9 }, { total_output_seconds: 3601 }, { output_duration_seconds: -1 },
    { meter: 'unknown-meter' }, { policy_revision: 'not-a-sha' }, { admission_weight: 2 },
  ])('blocks new actions for inconsistent batch metadata while retaining the original quote JSON: %s', (change) => {
    const retained = parseMediaV2Quote({ ...quote, batch: { ...batch, ...change } })
    expect(retained).toMatchObject({ batch: { ...batch, ...change } })
    expect(() => parseMediaV2Batch(retained.batch)).toThrow()
  })

  it('never claims missing outputs or a partial batch as a successful completed task', () => {
    expect(mediaV2TaskComplete(parseMediaV2Task(complete), batch)).toBe(true)
    expect(mediaV2TaskComplete(parseMediaV2Task({ ...complete,
      batch: { ...complete.batch, failure_reason: 'main_outputs_missing' } }), batch)).toBe(false)
    expect(mediaV2TaskComplete(parseMediaV2Task({ ...complete, artifacts: complete.artifacts.slice(0, 1) }), batch)).toBe(false)
    expect(mediaV2TaskComplete(parseMediaV2Task({ ...complete,
      batch: { ...complete.batch, received_main_output_count: 1, completeness: 'partial' } }), batch)).toBe(false)
    expect(mediaV2TaskComplete(parseMediaV2Task({ ...complete,
      batch: { ...complete.batch, policy_revision: 'e'.repeat(64) } }), batch)).toBe(false)
    expect(() => parseMediaV2Task({ ...complete,
      artifacts: [{ ...complete.artifacts[0], output_id: 'main-2', output_index: 0 }, complete.artifacts[1]] })).toThrow()
  })
  it('never completes a known video batch when the task claims another media kind', () => {
    const wrongKind = parseMediaV2Task({ ...complete, kind: 'image' })
    expect(mediaV2TaskComplete(wrongKind, batch)).toBe(false)
  })
  it('requires every completed-batch artifact role and link to agree with the frozen logical main set', () => {
    for (const companion of [
      { key: 'outside-preview', type: 'image', mime_type: 'image/png', role: 'preview', output_id: 'main-3', output_index: 2 },
      { key: 'missing-role', type: 'file', mime_type: 'text/plain' },
      { key: 'non-video-main', type: 'file', mime_type: 'text/plain', role: 'main', output_id: 'main-1', output_index: 0 },
    ]) {
      const decoded = parseMediaV2Task({ ...complete, artifacts: [...complete.artifacts,
        { ...companion, order: 2, content_url: `/v1/tasks/batch-original-task/artifacts/${companion.key}/content` }] })
      expect(mediaV2TaskComplete(decoded, batch)).toBe(false)
    }
  })
  it('retains future batch metadata for original GET without authorizing a fresh action or complete output', () => {
    const future = { schema_version: 999, '$future-batch': { outputs: [1, 2] } }
    const originalQuote = parseMediaV2Quote({ ...quote, batch: future })
    const originalTask = parseMediaV2Task({ ...complete, batch: future })
    expect(originalQuote).toMatchObject({ batch: future })
    expect(originalTask).toMatchObject({ batch: future, id: complete.id, artifacts: complete.artifacts })
    expect(() => parseMediaV2Batch(originalQuote.batch)).toThrow()
    expect(mediaV2TaskComplete(originalTask, future)).toBe(false)
    expect(mediaV2TaskComplete(originalTask, batch)).toBe(false)
    expect(mediaV2TaskComplete(originalTask)).toBe(false)
  })
  it('retains mismatch counters and out-of-request output indexes within the supplier bound', () => {
    const mismatch = { ...complete, status: 'unknown', is_final: false, artifacts: [],
      batch: { ...batch, received_main_output_count: 3, completeness: 'mismatch', failure_reason: 'main_outputs_mismatch' } }
    expect(parseMediaV2TaskBatch(parseMediaV2Task(mismatch).batch)).toEqual(mismatch.batch)
    const extra = { ...complete.artifacts[0], output_id: 'main-64', output_index: 63 }
    expect(parseMediaV2Task({ ...mismatch, artifacts: [extra] }).artifacts[0]).toMatchObject(extra)
    expect(() => parseMediaV2TaskBatch({ ...mismatch.batch, received_main_output_count: 65 })).toThrow()
    expect(() => parseMediaV2Task({ ...mismatch, artifacts: [{ ...extra, output_index: 64, output_id: 'main-65' }] })).toThrow()
  })
})
