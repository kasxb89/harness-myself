/** Read actual local Go HTTP captures without rewriting their bodies or claiming a live ledger replay. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import z from 'zod'

const entrySchema = z.object({ name: z.string().min(1), status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.array(z.string())), body: z.unknown().optional(),
  body_base64: z.string().min(1).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u).optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  path: z.string().regex(/^\/(?!\/)[^\u0000-\u0020]*$/u).optional(),
  native_request: z.record(z.string(), z.unknown()).optional(),
  observations: z.object({ consume_count: z.number().int().nonnegative(), provider_post_count: z.number().int().nonnegative(),
    task_count: z.number().int().nonnegative(), token_quota: z.number().int().nonnegative(),
    user_quota: z.number().int().nonnegative() }).strict().optional() }).strict()
  .refine(entry => Object.hasOwn(entry, 'body') !== Object.hasOwn(entry, 'body_base64'), 'Exactly one actual response body representation is required')
export type ApiHttpFixture = z.infer<typeof entrySchema>
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
  return value as Record<string, unknown>
}
export function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected text')
  return value
}
export function apiFixtureSet(): { fixtures: ApiHttpFixture[]; sha256: string; captures: { file: string; sha256: string }[] } {
  const names = ['media-http-fixtures.json', 'text-http-fixtures.json', 'catalog-http-fixtures.json',
    'image-http-fixtures.json', 'quote-http-fixtures.json', 'new-media-catalog-http-fixtures.json', 'old-h3-live-task-http-fixtures.json']
  const captures = names.flatMap((file) => {
    const url = new URL(file, import.meta.url)
    if (!existsSync(url)) return []
    const bytes = readFileSync(url)
    return [{ file, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }]
  })
  const fixtures = captures.flatMap(capture => z.array(entrySchema).parse(JSON.parse(capture.bytes.toString('utf8'))))
  if (new Set(fixtures.map(entry => entry.name)).size !== fixtures.length) throw new Error('Duplicate Go HTTP fixture names')
  return { fixtures, sha256: createHash('sha256').update(Buffer.concat(captures.map(capture => capture.bytes))).digest('hex'),
    captures: captures.map(({ file, sha256 }) => ({ file, sha256 })) }
}
export function apiFixture(name: string): ApiHttpFixture {
  const fixture = apiFixtureSet().fixtures.find(entry => entry.name === name)
  if (fixture === undefined) throw new Error(`Missing actual Go HTTP fixture ${name}; run the API owner's local exporter, never invent its response`)
  return fixture
}
export function fixtureHeader(fixture: ApiHttpFixture, name: string): string | undefined {
  const entries = Object.entries(fixture.headers).filter(([field]) => field.toLowerCase() === name.toLowerCase())
  if (entries.length === 0) return undefined
  if (entries.length !== 1 || entries[0]![1].length !== 1) throw new Error(`Ambiguous actual HTTP header ${name}`)
  return entries[0]![1][0]
}
export function fixtureRows(fixture: ApiHttpFixture): Record<string, unknown>[] {
  const data = object(fixture.body).data
  if (!Array.isArray(data)) throw new Error(`Actual fixture ${fixture.name} has no data array`)
  return data.map(object)
}
