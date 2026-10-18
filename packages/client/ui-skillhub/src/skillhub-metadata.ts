/** Validate installed SkillHub metadata and normalize only its skill name. */
import { isMap, isScalar, parseDocument } from 'yaml'

// The filesystem skill loader admits lowercase alphanumeric segments separated by single hyphens.
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Lowercase an official skill name without rewriting its remaining metadata or body.
 * @param raw - Complete SKILL.md text with standalone YAML frontmatter fences.
 * @returns Validated text with a lowercase name, or the original text when unchanged.
 * @throws Error when frontmatter, name, or description cannot be loaded as a skill.
 */
export function normalizeSkillHubMetadata(raw: string): string {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') {
    throw new Error('SkillHub skill requires YAML frontmatter')
  }
  const start = firstLineEnd + 1
  let end = start
  while (end <= raw.length) {
    const nextNewline = raw.indexOf('\n', end)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(end, lineEnd).replace(/\r$/, '') === '---') break
    if (nextNewline < 0) throw new Error('SkillHub skill requires closing frontmatter fence')
    end = nextNewline + 1
  }
  const document = parseDocument(raw.slice(start, end), { keepSourceTokens: true })
  if (document.errors.length > 0 || !isMap(document.contents)) {
    throw new Error('SkillHub skill has invalid YAML frontmatter')
  }
  const name = document.get('name', true)
  const metadata: unknown = document.toJS()
  if (!isScalar(name) || typeof name.value !== 'string'
    || typeof metadata !== 'object' || metadata === null || !('description' in metadata)
    || typeof metadata.description !== 'string' || metadata.description.length === 0) {
    throw new Error('SkillHub skill requires string name and description')
  }
  const normalizedName = name.value.toLowerCase()
  if (!SKILL_NAME.test(normalizedName)) throw new Error('SkillHub skill has an invalid skill name')
  if (normalizedName === name.value) return raw
  // Changing an anchored value would also change metadata that aliases that name.
  if (name.anchor !== undefined) throw new Error('SkillHub skill name normalization would change aliased metadata')

  const range = name.range
  /* v8 ignore if -- Source-parsed YAML scalars always have ranges; the type also permits synthetic nodes. */
  if (range === undefined || range === null) throw new Error('SkillHub skill name has no source range')
  const token = name.srcToken
  if (token?.type === 'block-scalar') {
    const valueStart = start + range[1] - token.source.length
    return raw.slice(0, valueStart) + token.source.toLowerCase() + raw.slice(valueStart + token.source.length)
  }
  return raw.slice(0, start + range[0]) + JSON.stringify(normalizedName) + raw.slice(start + range[1])
}
