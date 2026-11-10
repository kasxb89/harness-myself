/** Public API fixtures supply exact prices; malformed evidence never becomes an advertised discount. */
import { expect, it } from 'vitest'
import fixture from './fixtures/official-price-comparison-api.json' with { type: 'json' }
import { parsePriceComparisons, readPriceComparisons } from '../src/price-comparisons.ts'

const example = fixture.data.find(model => model.model_name === 'ycapi-gpt-5.4-mini')!
const first = example.retail_price_rows![0]!
const response = (row: unknown) => ({ success: true, data: [{ model_name: 'fixture-model', display_name: 'Fixture model', kind: 'text',
  retail_price_rows: [row] }] })

it('preserves all 43 models and 113 exact same-unit prices from the actual public API response', () => {
  const result = parsePriceComparisons(fixture)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.code)
  expect(result.payload.basis).toBe('default')
  expect(result.payload.models).toHaveLength(43)
  expect(result.payload.models.reduce((count, model) => count + model.rows.length, 0)).toBe(113)
  for (const model of result.payload.models) {
    const original = fixture.data.find(item => item.model_name === model.id)
    expect(model.name).toBe(original?.display_name)
    expect(model.rows).toEqual(original?.retail_price_rows)
  }
  expect(result.payload.models.find(model => model.id === 'ycapi-gemini-3.1-flash-tts')?.rows[0]?.official_reference.conditions).toBe('')
  expect(result.payload.models.filter(model => model.kind === 'video').flatMap(model => model.rows)
    .every(row => row.unit === 'CNY / second')).toBe(true)
})

it('selects only public fields and rejects hidden or unrecognized specification fields instead of comparing a partial specification', () => {
  const result = parsePriceComparisons({ ...response({ ...first, procurement_cost: 'private', lane: 'private',
    official_reference: { ...first.official_reference, source_secret: 'private' } }), secret: 'private',
  })
  expect(result.ok).toBe(true)
  expect(JSON.stringify(result)).not.toMatch(/private|procurement|lane|source_secret/u)
  expect(parsePriceComparisons(response({ ...first, params: { lane: 'private' } }))).toEqual({ ok: true,
    payload: { basis: 'default', models: [] } })
  expect(parsePriceComparisons(response({ ...first, params: { resolution: { nested_secret: 'private' } } }))).toEqual({ ok: true,
    payload: { basis: 'default', models: [] } })
})

it.each([
  ['zero', { official_cny: '0' }], ['negative', { official_cny: '-1' }], ['exponent', { official_cny: '1e2' }],
  ['numeric price', { official_cny: 1 }], ['precision overflow', { official_cny: '0.' + '1'.repeat(25) }],
  ['infinite', { official_cny: 'Infinity' }], ['different unit', { unit: 'CNY / second' }],
  ['future schema', { schema_version: 2 }], ['wrong currency', { currency: 'USD' }], ['wrong source currency', { source_currency: 'EUR' }],
  ['missing dollar conversion', { usd_cny: undefined }], ['zero dollar conversion', { usd_cny: '0.0' }],
  ['missing model', { model: undefined }], ['model control', { model: 'official\nmodel' }],
  ['invalid day', { checked_at: '2026-02-30' }], ['invalid month', { checked_at: '2026-13-01' }],
  ['unqualified date', { checked_at: '2026-1-1' }], ['missing conditions', { conditions: undefined }],
  ['long conditions', { conditions: 'x'.repeat(4097) }], ['plain http', { source_url: 'http://official.example/pricing' }],
  ['script source', { source_url: 'javascript:alert(1)' }], ['credential source', { source_url: 'https://user:secret@official.example' }],
  ['missing source', { source_url: '' }], ['invalid total', { official_total_cny: '0' }],
])('omits a price row with %s official evidence', (_name, changed) => {
  expect(parsePriceComparisons(response({ ...first, official_reference: { ...first.official_reference, ...changed } }))).toEqual({
    ok: true, payload: { basis: 'default', models: [] },
  })
})

it.each([
  { retail_cny: '0' }, { retail_cny: '0.00' }, { retail_cny: -1 }, { retail_cny: '1e4' },
  { direction: undefined }, { direction: 'cached-input' }, { retail_total_cny: 'NaN' },
  { params: { speed: Number.NaN } }, { params: { size: 'x'.repeat(129) } },
])('omits malformed retail values %j without filling in a price or direction', (changed) => {
  expect(parsePriceComparisons(response({ ...first, ...changed }))).toEqual({ ok: true, payload: { basis: 'default', models: [] } })
})

it('supports CNY sources without adding a USD conversion and retains scalar specification values', () => {
  const result = parsePriceComparisons(response({ ...first, params: { size: '1K', count: 1, audio: false, mode: null },
    official_reference: { ...first.official_reference, source_currency: 'CNY', usd_cny: undefined } }))
  expect(result.ok && result.payload.models[0]?.rows[0]).toMatchObject({ params: { size: '1K', count: 1, audio: false, mode: null },
    official_reference: { source_currency: 'CNY' } })
  expect(JSON.stringify(result)).not.toContain('usd_cny')
})

it('rejects incompatible media units and directions while preserving a valid neighboring row', () => {
  const media = fixture.data.find(model => model.kind === 'video')!
  const row = media.retail_price_rows![0]!
  expect(parsePriceComparisons({ success: true, data: [{ ...media, retail_price_rows: [row, { ...row, direction: 'input' }] }] }))
    .toMatchObject({ ok: true, payload: { models: [{ rows: [row] }] } })
  expect(parsePriceComparisons({ success: true, data: [{ ...media, kind: 'image' }] })).toEqual({ ok: true,
    payload: { basis: 'default', models: [] } })
})

it('does not extend a configured reference to another specification without its own evidence', () => {
  const model = { model_name: 'configured-image', display_name: 'Configured image', kind: 'image', retail_price_rows: [
    { params: { size: '1K', ratio: '1:1', count: 1 }, retail_cny: '0.2', unit: 'CNY / image',
      official_reference: { schema_version: 1, currency: 'CNY', source_currency: 'CNY', official_cny: '0.4',
        model: 'native-image', unit: 'CNY / image', source_url: 'https://official.example/image-pricing',
        checked_at: '2026-11-11', conditions: 'One square image' } },
    { params: { size: '2K', ratio: '16:9', count: 1 }, retail_cny: '0.3', unit: 'CNY / image' },
  ] }
  const result = parsePriceComparisons({ success: true, data: [model] })
  expect(result).toEqual({ ok: true, payload: { basis: 'default', models: [
    { id: model.model_name, name: model.display_name, kind: 'image', rows: [model.retail_price_rows[0]] },
  ] } })
})

it('returns no comparison for an older API and safely refuses malformed, duplicate or oversized catalogs', () => {
  expect(parsePriceComparisons({ success: true, data: [{ model_name: 'legacy' }] })).toEqual({ ok: true,
    payload: { basis: 'default', models: [] } })
  for (const body of [null, { success: false, data: [] }, { success: true, data: null },
    { success: true, data: [example, example] }, { success: true, data: Array.from({ length: 2049 }, () => ({})) },
    { success: true, data: [{ ...example, retail_price_rows: Array.from({ length: 513 }, () => first) }] }]) {
    expect(parsePriceComparisons(body)).toEqual({ ok: false, code: 'PRICE_COMPARISONS_INVALID' })
  }
})

it('contains observed network, status, malformed and complete-body failures without returning raw diagnostics', async () => {
  const signal = new AbortController().signal
  for (const [status, code] of [[404, 'PRICE_COMPARISONS_UNSUPPORTED'], [503, 'PRICE_COMPARISONS_UNAVAILABLE']] as const) {
    expect(await readPriceComparisons(async () => new Response('secret', { status }), signal)).toEqual({ ok: false, code,
      ...status === 503 ? { httpStatus: 503 } : {} })
  }
  expect(await readPriceComparisons(async () => { throw new TypeError('private network details') }, signal))
    .toEqual({ ok: false, code: 'PRICE_COMPARISONS_NETWORK' })
  for (const body of ['{bad', ' '.repeat(1_048_577)]) {
    expect(await readPriceComparisons(async () => new Response(body), signal)).toEqual({ ok: false, code: 'PRICE_COMPARISONS_INVALID' })
  }
  expect(await readPriceComparisons(async () => new Response(null), signal)).toEqual({ ok: false, code: 'PRICE_COMPARISONS_INVALID' })
  const aborted = AbortSignal.abort(new DOMException('deadline', 'TimeoutError'))
  expect(await readPriceComparisons(async () => { throw new Error('must not read') }, aborted))
    .toEqual({ ok: false, code: 'PRICE_COMPARISONS_NETWORK' })
})

it.each([
  [429, '17', 17], [429, '0.5', 1], [429, 'Mon, 26 Oct 2026 10:00:45 GMT', 45],
  [503, 'Mon, 26 Oct 2026 10:00:45 GMT', 45],
] as const)('retains only HTTP %s cooldown facts from Retry-After %s', async (status, retry, seconds) => {
  const result = await readPriceComparisons(async () => new Response('private upstream diagnostic', {
    status, headers: { 'Retry-After': retry, Date: 'Mon, 26 Oct 2026 10:00:00 GMT',
      'Set-Cookie': 'private-upstream-cookie', 'X-Private-Route': 'private-upstream-route' },
  }), new AbortController().signal)
  expect(result).toEqual({ ok: false, code: status === 429 ? 'PRICE_COMPARISONS_RATE_LIMITED' : 'PRICE_COMPARISONS_UNAVAILABLE',
    httpStatus: status, retryAfterSeconds: seconds })
  expect(JSON.stringify(result)).not.toContain('private')
})

it.each(['not-a-delay', 'NaN', 'Infinity', '9'.repeat(400), '9007199254741'])(
  'omits untrusted or unsafe cooldown %s without guessing a replacement', async (retry) => {
    expect(await readPriceComparisons(async () => new Response('private', { status: 429,
      headers: { 'Retry-After': retry } }), new AbortController().signal))
      .toEqual({ ok: false, code: 'PRICE_COMPARISONS_RATE_LIMITED', httpStatus: 429 })
  },
)

it('does not copy cooldown headers from other statuses or successful pricing documents', async () => {
  const signal = new AbortController().signal
  for (const status of [401, 403, 500]) {
    expect(await readPriceComparisons(async () => new Response('private', {
      status, headers: { 'Retry-After': '45', Date: 'Mon, 26 Oct 2026 10:00:00 GMT', 'X-Private': 'private' },
    }), signal)).toEqual({ ok: false, code: 'PRICE_COMPARISONS_UNAVAILABLE' })
  }
  expect(await readPriceComparisons(async () => Response.json({ success: true, data: [] }, {
    headers: { 'Retry-After': '45' },
  }), signal)).toEqual({ ok: true, payload: { basis: 'default', models: [] } })
})
