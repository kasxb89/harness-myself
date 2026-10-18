import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { normalizeSkillHubMetadata } from '../src/skillhub-metadata.ts'

describe('SkillHub installed metadata', () => {
  it('normalizes an official uppercase name while preserving comments, metadata, and body bytes', () => {
    const raw = '---\n# Header Comment\nname: Writing # Preserve Name Comment\ndescription: >-\n  Write prose and dialogue.\nmetadata:\n  category: Writing\n  enabled: true\n---\n\n# Writing\n正文保持原样 🌟\n\n---\n'
    expect(normalizeSkillHubMetadata(raw)).toBe(raw.replace('name: Writing', 'name: "writing"'))
  })

  it.each(["'DeepSeek-Writer'", '"DeepSeek-Writer"', '"DeepSeek-\\u0057riter"'])('normalizes quoted scalar %s', (name) => {
    const raw = `---\nname: ${name}\ndescription: "Write: prose # carefully"\n---\nbody\n`
    expect(normalizeSkillHubMetadata(raw)).toBe(raw.replace(`name: ${name}`, 'name: "deepseek-writer"'))
  })

  it('preserves CRLF frontmatter and mixed body newlines', () => {
    const raw = '---\r\nname: Writing # Comment\r\ndescription: |\r\n  Line One\r\n  Line Two\r\n---\r\nbody\n\n---\r\n'
    expect(normalizeSkillHubMetadata(raw)).toBe(raw.replace('name: Writing', 'name: "writing"'))
  })

  it.each(['>-', '|-'])('preserves block scalar %s name syntax and comments', (style) => {
    const raw = `---\nname: ${style} # Preserve Case\n  Writing\ndescription: Write prose\n---\nbody\n`
    const result = normalizeSkillHubMetadata(raw)
    expect(result).toBe(raw.replace('  Writing\n', '  writing\n'))
    expect(parse(result.slice(4, result.indexOf('\n---', 4)))).toMatchObject({ name: 'writing', description: 'Write prose' })
  })

  it('preserves a CRLF block scalar and accepts an ending fence at EOF', () => {
    const raw = '---\r\nname: >- # Preserve Case\r\n  Writing\r\ndescription: Write prose\r\n---'
    expect(normalizeSkillHubMetadata(raw)).toBe(raw.replace('  Writing\r\n', '  writing\r\n'))
  })

  it('accepts an aliased string description like the filesystem skill loader', () => {
    const raw = '---\nmetadata:\n  summary: &summary Write prose\nname: Writing\ndescription: *summary\n---\nbody\n'
    expect(normalizeSkillHubMetadata(raw)).toBe(raw.replace('name: Writing', 'name: "writing"'))
  })

  it.each([
    '---\nname: writing\ndescription: prose\n---\nbody\n',
    '---\r\nname: "writing" # comment\r\ndescription: >-\r\n  Write prose\r\n---\r\nbody\r\n',
    '---\nname: &skill writing\ndescription: Write prose\nmetadata:\n  original: *skill\n---\nbody\n',
  ])('returns valid lowercase metadata byte-for-byte', (raw) => {
    expect(normalizeSkillHubMetadata(raw)).toBe(raw)
  })

  it.each([
    'name: Writing\ndescription: prose\n',
    '---',
    '\n---\nname: Writing\ndescription: prose\n---\n',
    '--- \nname: Writing\ndescription: prose\n---\n',
    '---\nname: Writing\ndescription: prose\n',
    '---\nname: Writing\ndescription: prose\n--- # trailing comment\n',
    '---\nname: Writing\nname: Other\ndescription: prose\n---\n',
    '---\nname: [Writing\ndescription: prose\n---\n',
    '---\n- Writing\n- prose\n---\n',
    '---\nnull\n---\n',
    '---\nname: 123\ndescription: prose\n---\n',
    '---\nname: [Writing]\ndescription: prose\n---\n',
    '---\noriginal: &skill Writing\nname: *skill\ndescription: prose\n---\n',
    '---\nname: &skill Writing\ndescription: prose\nmetadata:\n  original: *skill\n---\nbody\n',
    '---\nname: Writing\n---\n',
    '---\nname: Writing\ndescription: 42\n---\n',
    '---\nname: Writing\ndescription: ""\n---\n',
    '---\nname: ""\ndescription: prose\n---\n',
    '---\nname: Writing Skill\ndescription: prose\n---\n',
    '---\nname: Writing_Skill\ndescription: prose\n---\n',
    '---\nname: 写作\ndescription: prose\n---\n',
    '---\nname: ../Writing\ndescription: prose\n---\n',
    '---\nname: -Writing\ndescription: prose\n---\n',
  ])('rejects metadata that would remain unloadable: %j', (raw) => {
    expect(() => normalizeSkillHubMetadata(raw)).toThrow(Error)
  })
})
