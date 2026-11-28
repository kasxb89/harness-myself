/** One new actual-Go R02 static projection; no supplier, transport, service or paid request. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it, onTestFinished } from 'vitest'
import { mediaV2FormIssues } from '../src/media-v2-form.ts'
import { isMediaV2Value, mediaV2Data, mediaV2Object, parseMediaV2Catalog, readMediaV2SpecificationPricing } from '../src/media-v2-types.ts'
import type { MediaV2Value } from '../src/media-v2-types.ts'

interface Observation {
  snapshot: string
  model: string
  parameters: Record<string, MediaV2Value>
  allowed: boolean
  issues: ReturnType<typeof mediaV2FormIssues>
}

const fixture = new URL('./fixtures/yc30-r02-20261128/', import.meta.url)
const snapshots = [
  { file: 'HOST-R02-TRANSPORT-R01.baseline.json', sha256: '5cc4c36e387fe807643ffb1ac57b6e95f264603e1620589cc80d5cc9180cbac5', models: 11, rows: 21,
    original: 'ACTUAL-GO-HTTP-CATALOG-BASELINE-R04.json', originalSHA: '6ab94b1ca32d94561aec4d45b523b23b742d59748d6fdd4d35487eee9a6a5986' },
  { file: 'HOST-R02-TRANSPORT-R01.promo4k.json', sha256: 'ff8dda0bb2622f696c5ac583d181e0bc40e4773fb5abd51b09397e72354767b3', models: 1, rows: 1,
    original: 'ACTUAL-GO-HTTP-CATALOG-PROMO4K-R04.json', originalSHA: '116e903314cbb3f947603dc58909a4b81ac2d1d9f70e9b38edaecf7fb334515a' },
]
function read(file: string, digest: string): unknown {
  const bytes = readFileSync(new URL(file, fixture))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest)
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  return value
}
function parameters(raw: unknown): Record<string, MediaV2Value> {
  const object = mediaV2Object(raw)
  if (object === null) throw new Error('Expected original native parameter object')
  return Object.fromEntries(Object.entries(object).map(([name, value]) => {
    if (!isMediaV2Value(value)) throw new Error('Invalid original native parameter value')
    return [name, value]
  }))
}
it('consumes new actual-Go R02 baseline and promo snapshots independently, admitting 22 rows and rejecting the original five controls', () => {
  const report: Observation[] = []
  let status = 'failed'
  onTestFinished(() => {
    const target = process.env.DSH_YC30_UI_CONSUMER_REPORT
    if (target !== undefined) writeFileSync(target, JSON.stringify({ status,
      mode: 'actual-Go R02 to normal Host catalog to current UI parser/form; Host rate1250 is explicitly synthetic, not production',
      snapshots, results: report, transport_created: false, quote_POST: 0, generation_POST: 0, external_HTTP: 0 }, null, 2) + '\n')
  })
  let allowed = 0
  for (const snapshot of snapshots) {
    const raw = read(snapshot.file, snapshot.sha256), rawData = mediaV2Object(mediaV2Object(raw)?.data)
    const goData = mediaV2Object(mediaV2Data(read(snapshot.original, snapshot.originalSHA)))
    if (!Array.isArray(rawData?.models) || !Array.isArray(goData?.models)) throw new Error('Expected original Go and normal Host catalogs')
    const before = JSON.stringify(raw), catalog = parseMediaV2Catalog(mediaV2Data(raw))
    expect(catalog.models).toHaveLength(snapshot.models)
    expect(catalog.capabilities.selection_constraints_v1).toBe(true)
    expect(catalog.credits_per_yuan).toBe(1250)
    let rows = 0
    for (const model of catalog.models) {
      const original = rawData.models.map(mediaV2Object).find(item => item?.id === model.id)
      const goOriginal = goData.models.map(mediaV2Object).find(item => item?.id === model.id)
      if (original === undefined || original === null || goOriginal === undefined || goOriginal === null) throw new Error('Missing original model')
      expect(model.parameters_schema).toEqual(goOriginal.parameters_schema)
      expect(model.selection_constraints).toEqual(goOriginal.selection_constraints)
      expect(model.asset_fields).toEqual(goOriginal.asset_fields)
      expect(model.pricing).toEqual({ ...mediaV2Object(goOriginal.pricing), credits_per_yuan: 1250 })
      expect(model.parameters_schema).toEqual(original.parameters_schema)
      expect(model.selection_constraints).toEqual(original.selection_constraints)
      expect(model.parameter_conditions).toEqual(original.parameter_conditions)
      expect(model.conditions).toEqual(original.conditions)
      expect(model.quantity).toEqual(original.quantity)
      expect(model.pricing).toEqual(original.pricing)
      const pricing = readMediaV2SpecificationPricing(model.pricing)
      if (pricing === undefined || pricing === null || pricing.specification_rows === undefined) throw new Error('Expected original indicative price rows')
      for (const row of pricing.specification_rows) {
        const selected: Record<string, MediaV2Value> = { ...row.parameters, prompt: 'Static UI validation only; retain the exact thirty-second request' }
        expect(selected.duration).toBe('30')
        const issues = mediaV2FormIssues(model, 'text', selected, [], 0, catalog.capabilities.native_video_batch_v1 === true)
        report.push({ snapshot: snapshot.file, model: model.id, parameters: selected, allowed: true, issues })
        expect(issues, `${snapshot.file}/${model.id}/${JSON.stringify(row.parameters)}`).toEqual([])
        rows++; allowed++
      }
    }
    expect(rows).toBe(snapshot.rows)
    expect(JSON.stringify(raw)).toBe(before)
  }
  expect(allowed).toBe(22)
  const negative = mediaV2Object(read('negative-cases.json', '470f30074a486ed399aa1500b79e5363df99d082c2f51ee183c5399108b5cf74'))
  expect(negative?.source_sha256).toBe('2016a8523d2b9bbd62da36078379c53ba101e6d97d11262c1e32663256aff01f')
  expect(negative?.source_pointer).toBe('/negative_cases')
  if (!Array.isArray(negative?.negative_cases)) throw new Error('Expected exact original Go rejection cases')
  expect(negative.negative_cases).toHaveLength(5)
  const baseline = parseMediaV2Catalog(mediaV2Data(read(snapshots[0]!.file, snapshots[0]!.sha256)))
  for (const raw of negative.negative_cases) {
    const value = mediaV2Object(raw), model = baseline.models.find(item => item.id === value?.model)
    if (model === undefined || value?.allowed !== false || value.billing !== 0 || value.vendor_IO !== 0) throw new Error('Changed original rejection case')
    const selected = parameters(value.parameters), before = JSON.stringify(selected)
    expect(selected.duration).toBe('30')
    const issues = mediaV2FormIssues(model, 'text', selected, [], 0, baseline.capabilities.native_video_batch_v1 === true)
    report.push({ snapshot: 'original Go /negative_cases', model: model.id, parameters: selected, allowed: false, issues })
    expect(issues, `${model.id}/${JSON.stringify(selected)}`).toContainEqual({ field: 'parameters', reason: 'parameterCondition' })
    expect(JSON.stringify(selected)).toBe(before)
  }
  status = 'passed'
})
