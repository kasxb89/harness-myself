/** Strict decoding of the local administration service's public document. */
import type { CreationContent, CreationTemplate, LocalizedText, ModeContent } from './types.ts'

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid creation content')
  return value as Record<string, unknown>
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || Array.from(value).length > limit) throw new Error('Invalid creation text')
  return value
}
function localized(value: unknown, limit: number): LocalizedText {
  const item = record(value)
  return { zh: text(item.zh, limit), ...(item.en === undefined ? {} : { en: text(item.en, limit) }) }
}
function id(value: unknown): string {
  const result = text(value, 80)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(result)) throw new Error('Invalid creation identifier')
  return result
}
function asset(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !/^cc_[a-f0-9]{64}$/.test(value)) throw new Error('Invalid creation asset')
  return value
}
function order(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > 1_000_000) throw new Error('Invalid creation order')
  return value
}
function status(value: unknown): 'draft' | 'published' {
  if (value !== 'draft' && value !== 'published') throw new Error('Invalid creation status')
  return value
}
function list<T extends { readonly id: string; readonly sortOrder: number }>(
  value: unknown, max: number, parse: (value: unknown) => T,
): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid creation list')
  const result = value.map(parse)
  if (new Set(result.map(item => item.id)).size !== result.length) throw new Error('Duplicate creation identifier')
  return result.sort((a, b) => a.sortOrder - b.sortOrder)
}
function mode(value: unknown): ModeContent {
  const item = record(value)
  const categories = list(item.categories, 100, (entry) => {
    const row = record(entry)
    if (typeof row.enabled !== 'boolean') throw new Error('Invalid creation category')
    return { id: id(row.id), label: localized(row.label, 200), sortOrder: order(row.sortOrder), enabled: row.enabled }
  }).filter(category => category.enabled)
  const categoryIds = new Set(categories.map(category => category.id))
  const templates = list<CreationTemplate>(item.templates, 500, (entry) => {
    const row = record(entry)
    return {
      id: id(row.id), categoryId: row.categoryId === null ? null : id(row.categoryId),
      title: localized(row.title, 200), description: localized(row.description, 2000), prompt: localized(row.prompt, 7000),
      coverAssetId: asset(row.coverAssetId), demoVideoAssetId: asset(row.demoVideoAssetId),
      sortOrder: order(row.sortOrder), status: status(row.status),
    }
  }).filter(template => template.status === 'published'
    && (template.categoryId === null || categoryIds.has(template.categoryId)))
  const presets = list(item.presets, 200, (entry) => {
    const row = record(entry)
    return {
      id: id(row.id), label: localized(row.label, 200), promptSuffix: localized(row.promptSuffix, 2000),
      sortOrder: order(row.sortOrder), status: status(row.status),
    }
  }).filter(preset => preset.status === 'published')
  return {
    title: localized(item.title, 200), description: localized(item.description, 2000),
    promptPlaceholder: localized(item.promptPlaceholder, 7000), categories, templates, presets,
  }
}

/**
 * Decode a public JSON document, excluding unpublished content.
 * @param value Untrusted response document.
 * @returns Validated publication.
 */
export function parseContent(value: unknown): CreationContent {
  const item = record(value)
  if (item.schemaVersion !== 1) throw new Error('Unsupported creation content version')
  return { schemaVersion: 1, revision: text(item.revision, 128), image: mode(item.image), video: mode(item.video) }
}
