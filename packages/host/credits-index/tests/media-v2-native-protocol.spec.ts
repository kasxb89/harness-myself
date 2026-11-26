import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { mediaV2Object, parseMediaV2Catalog, parseMediaV2Request, parseMediaV2Task } from '../src/media-v2-protocol.ts'

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
  })
})

describe('catalog compatibility', () => {
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
