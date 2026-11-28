/** Optional immutable actual-Go metadata consumption; never invokes a provider or a running API. */
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { expect, it, vi } from 'vitest'
import { MediaV2Client } from '../src/media-v2-client.ts'
import { mediaV2Object, readMediaV2SpecificationPricing } from '../src/media-v2-protocol.ts'
import { mediaPreferencePoints } from '../src/media-preference-pricing.ts'

const readyPath = process.env.DSH_MEDIA_EXACT_PRICING_READY
const reportPath = process.env.DSH_MEDIA_EXACT_PRICING_REPORT
const priorPath = process.env.DSH_MEDIA_EXACT_PRICING_PRIOR
const handoffPath = process.env.DSH_MEDIA_EXACT_PRICING_R02_HANDOFF
const transportReport = process.env.DSH_MEDIA_EXACT_PRICING_R02_TRANSPORT
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const object = mediaV2Object
const values = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error('Expected retained actual-Go array')
  return value as unknown[]
}
const string = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Expected retained actual-Go string')
  return value
}

it.skipIf(handoffPath === undefined)('bridges formal R02 actual-Go catalogs through normal Host credit projection for the UI', async () => {
  if (handoffPath === undefined || transportReport === undefined) throw new Error('R02 handoff and transport report paths are required')
  const handoffBytes = await readFile(handoffPath), handoff = object(JSON.parse(handoffBytes.toString('utf8')))
  const handoffSHA = hash(handoffBytes)
  await writeFile(transportReport + '.once', JSON.stringify({ handoffSHA, handoffPath, at: new Date().toISOString() }), { flag: 'wx' })
  const directory = await mkdtemp(join(tmpdir(), 'media-v2-r02-transport-'))
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No actual network in the normal Host metadata bridge'))
  const calls: { path: string; method: string }[] = [], inputs: Record<string, unknown>[] = [], outputs: Record<string, unknown>[] = []
  const evidence: Record<string, unknown> = { schema: 1, status: 'running', handoff: { path: handoffPath, sha256: handoffSHA },
    source: handoff.source, rate_basis: { creditsPerYuan: 1250, synthetic_configured_Host_rate: true, not_production_rate: true },
    paid_qualification: false, actual_network: 0, uploads: 0, quote_POSTs: 0, task_POSTs: 0, new_Go_services: 0 }
  try {
    expect(handoff.source).toBe('502226ce4ce7dbac344d2c81d47a83bdf61ef5e8')
    expect(handoff.tree_clean).toBe(true)
    const publicInputs = new Map<string, Buffer>()
    const descriptors = [...Object.values(handoff).filter(value => value !== null && typeof value === 'object'
      && !Array.isArray(value) && typeof object(value).path === 'string' && typeof object(value).sha256 === 'string'),
    ...values(handoff.validation_evidence)]
    for (const value of descriptors) {
      const descriptor = object(value), path = string(descriptor.path), bytes = await readFile(path)
      expect(hash(bytes), path).toBe(descriptor.sha256); expect(bytes.length).toBe(descriptor.bytes as number)
      inputs.push({ path, sha256: hash(bytes), bytes: bytes.length })
      if (path === object(handoff.public_native_baseline).path || path === object(handoff.public_native_promo4k).path) {
        publicInputs.set(path, bytes)
      }
    }
    expect(publicInputs.size).toBe(2)
    for (const [name, descriptor, expectedModels, expectedRows] of [
      ['baseline', object(handoff.public_native_baseline), 11, 21],
      ['promo4k', object(handoff.public_native_promo4k), 1, 1],
    ] as const) {
      const inputPath = string(descriptor.path), raw = publicInputs.get(inputPath)
      if (raw === undefined) throw new Error('Missing hash-verified original public response')
      const original = object(object(JSON.parse(raw.toString('utf8'))).data), originalModels = values(original.models)
      const client = new MediaV2Client({ baseUrl: 'https://synthetic.invalid', directory, timeoutMs: 1000, creditsPerYuan: 1250 })
      let reads = 0
      const catalog = await client.catalog({ owner: 'r02-metadata-only-owner', fetch: async (path, init) => {
        reads += 1; calls.push({ path, method: init.method ?? 'GET' })
        expect(path).toBe('/v1/media-v2/models'); expect(init.method).toBe('GET'); expect(init.body).toBeUndefined()
        expect(new Headers(init.headers).has('X-Yunshu-Media-Requote')).toBe(false)
        return new Response(raw.toString('utf8'), { headers: { 'content-type': 'application/json' } })
      } }, new AbortController().signal)
      expect(reads).toBe(1); expect(catalog.models).toHaveLength(expectedModels)
      expect(catalog.credits_per_yuan).toBe(1250)
      expect(catalog.capabilities).toMatchObject({ selection_constraints_v1: true,
        exact_specification_pricing_v1: true, explicit_requote_v1: true })
      let count = 0
      for (const model of catalog.models) {
        const source = object(originalModels.find(value => object(value).id === model.id)), pricing = object(source.pricing)
        expect(model.parameters_schema).toEqual(source.parameters_schema)
        expect(model.asset_fields).toEqual(source.asset_fields)
        expect(model.selection_constraints).toEqual(source.selection_constraints)
        expect(model.pricing).toEqual({ ...pricing, credits_per_yuan: pricing.credits_per_yuan ?? original.credits_per_yuan ?? 1250 })
        const parsed = readMediaV2SpecificationPricing(model.pricing)
        if (parsed === undefined || parsed === null) throw new Error('Exact original pricing failed strict Host metadata decode')
        count += parsed.specification_rows?.length ?? 0
      }
      expect(count).toBe(expectedRows)
      // Exactly the existing proxy's public success/data envelope; data is the normal Host return, without hand-injected fields.
      const bytes = Buffer.from(JSON.stringify({ success: true, data: catalog }))
      const path = transportReport.replace(/\.json$/u, '') + '.' + name + '.json'
      await writeFile(path, bytes, { flag: 'wx' })
      outputs.push({ path, sha256: hash(bytes), bytes: bytes.length, name, models: catalog.models.length,
        pricing_rows: count, input: { path: inputPath, sha256: descriptor.sha256 },
        scope: 'Exact normal MediaV2Client.catalog output in unchanged proxy success/data envelope; no UI rewrite' })
    }
    expect(calls).toEqual([{ path: '/v1/media-v2/models', method: 'GET' }, { path: '/v1/media-v2/models', method: 'GET' }])
    expect(external).not.toHaveBeenCalled()
    for (const input of inputs) expect(hash(await readFile(string(input.path)))).toBe(input.sha256)
    expect(hash(await readFile(handoffPath))).toBe(handoffSHA)
    evidence.status = 'passed'
    evidence.client_source_sha256 = Object.fromEntries(await Promise.all(['../src/media-v2-client.ts', '../src/media-v2-protocol.ts']
      .map(async file => [file, hash(await readFile(new URL(file, import.meta.url)))])))
  } catch (error) {
    evidence.status = 'failed'; evidence.error = error instanceof Error ? error.message : String(error); throw error
  } finally {
    external.mockRestore(); await rm(directory, { recursive: true, force: true })
    await writeFile(transportReport, JSON.stringify({ ...evidence, inputs, outputs, local_Response_GETs: calls }, null, 2) + '\n', { flag: 'wx' })
  }
})

it.skipIf(readyPath === undefined)('consumes source-bound actual-Go exact prices without changing snapshots or calling an API', async () => {
  if (readyPath === undefined || reportPath === undefined) throw new Error('Exact-pricing fixture and new report paths are required')
  const readyBytes = await readFile(readyPath), ready = object(JSON.parse(readyBytes.toString('utf8')))
  const readySHA = hash(readyBytes)
  await writeFile(reportPath + '.once', JSON.stringify({ readyPath, readySHA, at: new Date().toISOString() }), { flag: 'wx' })
  const directory = await mkdtemp(join(tmpdir(), 'media-v2-exact-go-'))
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Actual network is prohibited for this metadata consumer'))
  const evidence: Record<string, unknown> = { schema: 1, status: 'running', ready: { path: readyPath, sha256: readySHA },
    source: ready.source, synthetic: true, scope: 'actual-Go catalog metadata consumption only',
    UI_grammar_qualified: false, paid_execution_qualified: false, actual_network: 0, uploads: 0, quote_POSTs: 0, tasks_POSTs: 0 }
  const referenced: { path: string; sha256: string }[] = [], calls: string[] = [], snapshots: Record<string, unknown>[] = []
  try {
    expect(ready.schema).toBe(1)
    expect(ready.status).toBe('FINAL_SOURCE_BOUND_ACTUAL_GO_CONFIG_FIXTURES')
    expect(ready.source).toBe('6331f3e4d8c42b5069d7f7d674fa032c65f05ba0')
    expect(ready.synthetic).toBe(true); expect(ready.execution_qualified).toBe(false)
    expect(ready.continuous_Go_service).toBe(false)
    const retained = async (descriptor: Record<string, unknown>): Promise<Buffer> => {
      const path = string(descriptor.path), bytes = await readFile(path), sha256 = hash(bytes)
      expect(sha256, path).toBe(descriptor.sha256)
      referenced.push({ path, sha256 }); return bytes
    }
    const originalReady = await readFile(join(dirname(readyPath), 'ACTUAL-GO-CONFIG-FIXTURES-READY.json'))
    expect(hash(originalReady)).toBe(ready.original_READY_sha256)
    referenced.push({ path: join(dirname(readyPath), 'ACTUAL-GO-CONFIG-FIXTURES-READY.json'), sha256: hash(originalReady) })
    const fixture = object(JSON.parse((await retained(object(ready.fixture))).toString('utf8')))
    expect(fixture.allowed_specifications).toBe(22); expect(fixture.blocked_specifications).toBe(5)
    expect(fixture.synthetic).toBe(true); expect(fixture.execution_qualified).toBe(false)
    expect(fixture.provider_requests).toBe(0); expect(fixture.database_writes).toBe(0)
    const descriptors = values(ready.public_HTTP_catalogs)
    expect(descriptors).toHaveLength(2)
    const allRows: { model: string; parameters: object }[] = []
    let prior: Record<string, unknown> | undefined
    if (priorPath !== undefined) {
      const bytes = await readFile(priorPath)
      expect(hash(bytes)).toBe(process.env.DSH_MEDIA_EXACT_PRICING_PRIOR_SHA256)
      prior = object(JSON.parse(bytes.toString('utf8')))
      expect(prior.status).toBe('failed'); expect(prior.source).toBe(ready.source)
      expect(values(prior.snapshots)).toHaveLength(1)
      expect(prior.local_Response_GETs).toEqual(['/v1/media-v2/models'])
      evidence.continuation = { original_result: { path: priorPath, sha256: hash(bytes), status: 'failed' },
        original_passed_rows: 21, repeated_original_Response_GETs: 0, rawScriptsAllGreen: false }
    }
    for (const [index, value] of descriptors.entries()) {
      const descriptor = object(value), raw = await retained(descriptor), data = object(object(JSON.parse(raw.toString('utf8'))).data)
      const models = values(data.models)
      expect(models).toHaveLength(index === 0 ? 11 : 1)
      expect(models).toHaveLength(descriptor.models as number)
      expect(new Set(models.map(value => object(value).id)).size).toBe(models.length)
      if (index === 0) expect(data).toEqual(fixture.data)
      else expect(data.models).toEqual(object(values(fixture.alternate_catalogs)[index - 1]).models)
      if (index === 0 && prior !== undefined) {
        const snapshot = object(values(prior.snapshots)[0]), rows = values(snapshot.rows)
        expect(snapshot.path).toBe(descriptor.path); expect(snapshot.models).toBe(11); expect(rows).toHaveLength(21)
        const originalRows = models.flatMap((value) => {
          const model = object(value)
          return values(object(model.pricing).specification_rows).map(row => ({ model: model.id, ...object(row) }))
        })
        const observedRows = rows.map(value => Object.fromEntries(Object.entries(object(value))
          .filter(([key]) => key !== 'credits_per_yuan' && key !== 'indicative_total_points')))
        expect(observedRows).toEqual(originalRows)
        allRows.push(...rows.map(value => ({ model: string(object(value).model), parameters: object(object(value).parameters) })))
        snapshots.push(snapshot)
        continue
      }
      const client = new MediaV2Client({ baseUrl: 'https://synthetic.invalid', directory, timeoutMs: 1000, creditsPerYuan: 1250 })
      const catalog = await client.catalog({ owner: 'metadata-only-owner', fetch: async (path, init) => {
        calls.push(path); expect(path).toBe('/v1/media-v2/models'); expect(init.method).toBe('GET')
        expect(init.body).toBeUndefined(); expect(new Headers(init.headers).has('X-Yunshu-Media-Requote')).toBe(false)
        return new Response(raw.toString('utf8'), { headers: { 'content-type': 'application/json' } })
      } }, new AbortController().signal)
      expect(catalog.capabilities).toMatchObject({ exact_specification_pricing_v1: true, explicit_requote_v1: true })
      const decodedRows: Record<string, unknown>[] = []
      for (const model of catalog.models) {
        const original = object(models.find(value => object(value).id === model.id))
        const pricing = object(original.pricing), parsed = readMediaV2SpecificationPricing(model.pricing)
        expect(parsed, model.id).not.toBeNull(); expect(parsed, model.id).not.toBeUndefined()
        if (parsed === null || parsed === undefined) throw new Error('Strict pricing metadata unexpectedly invalid')
        expect(parsed.currency).toBe(pricing.currency); expect(parsed.policy_revision).toBe(pricing.policy_revision)
        expect(parsed.specification_rows).toEqual(pricing.specification_rows)
        expect(model.parameters_schema).toEqual(original.parameters_schema)
        expect(model.asset_fields).toEqual(original.asset_fields)
        expect(model.pricing.credits_per_yuan).toBe(pricing.credits_per_yuan ?? data.credits_per_yuan ?? 1250)
        const rows = parsed.specification_rows ?? []
        for (const row of rows) {
          expect(row.parameters.duration).toBe('30'); expect(row.parameters.count).toBe(1)
          expect(row.parameters.mode).toBe('text-to-video'); expect(row.parameters.aspect_ratio).toBe('16:9')
          expect(row.quantity).toBe(row.billing_unit === 'per_video' ? 1 : 30)
          expect(row.quote_required).toBe(true)
          expect(mediaPreferencePoints(row.total_cny, model.pricing.credits_per_yuan)).toBeDefined()
          allRows.push({ model: model.id, parameters: row.parameters })
          decodedRows.push({ model: model.id, ...row, credits_per_yuan: model.pricing.credits_per_yuan,
            indicative_total_points: mediaPreferencePoints(row.total_cny, model.pricing.credits_per_yuan) })
        }
      }
      expect(decodedRows).toHaveLength(index === 0 ? 21 : 1)
      expect(decodedRows).toHaveLength(descriptor.pricing_rows as number)
      snapshots.push({ path: descriptor.path, models: catalog.models.length, rows: decodedRows,
        rate_basis: '1250 is an explicitly synthetic configured Host fallback only when the backend omits its optional rate' })
    }
    expect(allRows).toHaveLength(22)
    const negatives = values(fixture.negative_cases)
    expect(negatives).toHaveLength(5)
    for (const value of negatives) {
      const negative = object(value), parameters = Object.fromEntries(Object.entries(object(negative.parameters))
        .filter(([key]) => key !== 'prompt' && key !== 'negative_prompt'))
      expect(negative.allowed).toBe(false); expect(negative.billing).toBe(0); expect(negative.vendor_IO).toBe(0)
      expect(allRows.some(row => row.model === negative.model && isDeepStrictEqual(row.parameters, parameters))).toBe(false)
    }
    expect(calls).toEqual(prior === undefined ? ['/v1/media-v2/models', '/v1/media-v2/models'] : ['/v1/media-v2/models'])
    expect(external).not.toHaveBeenCalled()
    for (const file of referenced) expect(hash(await readFile(file.path))).toBe(file.sha256)
    expect(hash(await readFile(readyPath))).toBe(readySHA)
    evidence.status = 'passed'; evidence.snapshots = snapshots; evidence.blocked_specifications = negatives
    evidence.referenced = referenced; evidence.local_Response_GETs = calls
    const sourceFiles = ['../src/media-v2-client.ts', '../src/media-v2-protocol.ts', '../src/media-preference-pricing.ts']
    evidence.client_source_sha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
      [file, hash(await readFile(new URL(file, import.meta.url)))])))
  } catch (error) {
    evidence.status = 'failed'; evidence.referenced = referenced; evidence.snapshots = snapshots; evidence.local_Response_GETs = calls
    evidence.error = error instanceof Error ? error.message : String(error); throw error
  } finally {
    external.mockRestore()
    await rm(directory, { recursive: true, force: true })
    await writeFile(reportPath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' })
  }
})
