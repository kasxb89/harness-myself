import { describe, expect, it } from 'vitest'
import { comparisonDiscount, comparisonModels } from '../src/client/price-comparisons.ts'
import { parsePriceComparisons } from '../../../host/credits-index/src/price-comparisons.ts'
import pricing from '../../../host/credits-index/tests/fixtures/official-price-comparison-api.json' with { type: 'json' }

function priceFixture() {
  return { basis: 'default', models: [{ id: 'gpt-fixture', name: 'GPT Fixture', kind: 'text', rows: [
    { params: {}, retail_cny: '6.6611', unit: 'CNY / million tokens', direction: 'input',
      official_reference: { schema_version: 1, currency: 'CNY', source_currency: 'USD', official_cny: '13.4276',
        model: 'gpt-fixture-official', unit: 'CNY / million tokens', source_url: 'https://openai.com/api/pricing/',
        checked_at: '2026-10-31', conditions: 'Standard, non-cached input', usd_cny: '6.7138' } },
  ] }] }
}
function row(retail: string, official: string) {
  const value = priceFixture()
  value.models[0]!.rows[0]!.retail_cny = retail
  value.models[0]!.rows[0]!.official_reference.official_cny = official
  const parsed = comparisonModels(value)[0]?.rows[0]
  if (parsed === undefined) throw new Error('Expected valid decimal fixture')
  return parsed
}

describe('public model price comparisons', () => {
  it('preserves all 43 models and 113 real API rows through the actual Host and UI parsers', () => {
    const projected = parsePriceComparisons(pricing)
    if (!projected.ok) throw new Error('Expected exact public API fixture to pass the real Host projection')
    const models = comparisonModels(projected.payload)
    expect(models).toHaveLength(43)
    expect(models.reduce((count, model) => count + model.rows.length, 0)).toBe(113)
    expect(models.flatMap(model => model.rows).filter(item => item.official_reference.conditions === '')).toHaveLength(7)
  })

  it('compares exact decimals in the conservative direction without using top-up amounts', () => {
    expect(comparisonDiscount(row('6.6611', '13.4276'))).toEqual({ kind: 'lower', zhe: '4.97', percent: '49.7', saving: '50.3' })
    expect(comparisonDiscount(row('1', '2'))).toEqual({ kind: 'lower', zhe: '5', percent: '50', saving: '50' })
    expect(comparisonDiscount(row('0.000000000000000001', '99'))).toEqual({ kind: 'lower', zhe: '0.01', percent: '0.1', saving: '99.9' })
    expect(comparisonDiscount(row('0.000000000000000000000001', '1'))).toMatchObject({ zhe: '0.01', saving: '99.9' })
    expect(comparisonDiscount(row('1', '1'))).toEqual({ kind: 'equal' })
    expect(comparisonDiscount(row('2', '1'))).toEqual({ kind: 'higher' })
  })

  it.each([
    ['missing proof', (value: ReturnType<typeof priceFixture>) => { Reflect.deleteProperty(value.models[0]!.rows[0]!, 'official_reference') }],
    ['wrong unit', (value: ReturnType<typeof priceFixture>) => { value.models[0]!.rows[0]!.official_reference.unit = 'CNY / image' }],
    ['zero official', (value: ReturnType<typeof priceFixture>) => { value.models[0]!.rows[0]!.official_reference.official_cny = '0' }],
    ['zero retail', (value: ReturnType<typeof priceFixture>) => { value.models[0]!.rows[0]!.retail_cny = '0' }],
    ['negative', (value: ReturnType<typeof priceFixture>) => { value.models[0]!.rows[0]!.retail_cny = '-1' }],
    ['exponent', (value: ReturnType<typeof priceFixture>) => { value.models[0]!.rows[0]!.retail_cny = '1e-10' }],
    ['unsafe URL', (value: ReturnType<typeof priceFixture>) => { value.models[0]!.rows[0]!.official_reference.source_url = 'javascript:alert(1)' }],
    ['credential URL', (value: ReturnType<typeof priceFixture>) => { value.models[0]!.rows[0]!.official_reference.source_url = 'https://token@openai.com/' }],
    ['wrong date', (value: ReturnType<typeof priceFixture>) => { value.models[0]!.rows[0]!.official_reference.checked_at = '2026-02-30' }],
    ['no direction', (value: ReturnType<typeof priceFixture>) => { Reflect.deleteProperty(value.models[0]!.rows[0]!, 'direction') }],
    ['no FX', (value: ReturnType<typeof priceFixture>) => { Reflect.deleteProperty(value.models[0]!.rows[0]!.official_reference, 'usd_cny') }],
  ])('omits %s instead of inventing an official discount', (_label, mutate) => {
    const value = priceFixture(); mutate(value)
    expect(comparisonModels(value)).toEqual([])
  })

  it('omits unsupported payloads, bounds and empty models', () => {
    expect(comparisonModels(null)).toEqual([])
    expect(comparisonModels({ models: [] })).toEqual([])
    expect(comparisonModels({ basis: 'default', models: [] })).toEqual([])
    expect(comparisonModels({ basis: 'default', models: Array.from({ length: 257 }, () => priceFixture().models[0]) })).toEqual([])
  })

  it('whitelists reference fields and preserves input and output as distinct rows', () => {
    const value = priceFixture()
    value.models[0]!.rows.push({ ...value.models[0]!.rows[0]!, direction: 'output', retail_cny: '33.3055' })
    Object.assign(value.models[0]!.rows[0]!.official_reference, { cost: 'private', lane_id: 'private' })
    const result = comparisonModels(value)
    expect(result[0]?.rows.map(item => item.direction)).toEqual(['input', 'output'])
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('uses updated gateway reference values and removes withdrawn references without retaining earlier comparisons', () => {
    const original = { success: true, data: [{ model_name: 'configured-text', display_name: 'Configured text', kind: 'text',
      retail_price_rows: priceFixture().models[0]!.rows }] }
    original.data[0]!.retail_price_rows[0]!.retail_cny = '1'
    original.data[0]!.retail_price_rows[0]!.official_reference.official_cny = '2'
    const initial = parsePriceComparisons(original)
    if (!initial.ok) throw new Error('Expected initial gateway reference')
    const initialRow = comparisonModels(initial.payload)[0]?.rows[0]
    if (initialRow === undefined) throw new Error('Expected initial comparison row')
    expect(comparisonDiscount(initialRow)).toMatchObject({ kind: 'lower', saving: '50' })

    const updated = structuredClone(original)
    Object.assign(updated.data[0]!.retail_price_rows[0]!.official_reference, { source_currency: 'CNY', usd_cny: undefined,
      official_cny: '0.5', model: 'updated-native-model', source_url: 'https://official.example/new-pricing',
      checked_at: '2026-11-11', conditions: 'Updated standard input reference' })
    const current = parsePriceComparisons(updated)
    if (!current.ok) throw new Error('Expected updated gateway reference')
    const currentRow = comparisonModels(current.payload)[0]?.rows[0]
    expect(currentRow).toEqual({ params: {}, retail_cny: '1', unit: 'CNY / million tokens', direction: 'input',
      official_reference: { source_currency: 'CNY', official_cny: '0.5', model: 'updated-native-model',
        unit: 'CNY / million tokens', source_url: 'https://official.example/new-pricing', checked_at: '2026-11-11',
        conditions: 'Updated standard input reference' } })
    if (currentRow === undefined) throw new Error('Expected current comparison row')
    expect(comparisonDiscount(currentRow)).toEqual({ kind: 'higher' })
    expect(initialRow.official_reference.official_cny).toBe('2')

    Reflect.deleteProperty(updated.data[0]!.retail_price_rows[0]!, 'official_reference')
    const withdrawn = parsePriceComparisons(updated)
    if (!withdrawn.ok) throw new Error('Expected a supported response after reference withdrawal')
    expect(comparisonModels(withdrawn.payload)).toEqual([])
  })
})
