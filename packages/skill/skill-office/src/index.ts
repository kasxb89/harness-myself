/** Bundled Office workflows and filesystem resources for document authoring and checks. */

import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { isSea } from 'node:sea'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'
import { registerOfficeCreation } from './creation-tools.ts'
import type { OfficeCreationConfig } from './types.ts'

export { renderOfficeBatch, invalidateOfficeRenderCache } from './render-cache.ts'

const SKILL_NAMES = ['office-docx', 'office-pptx', 'office-xlsx'] as const

/** Office skill resource location. */
export interface Config {
  /** Absolute assets directory containing the three skill folders and shared scripts; defaults to packaged assets. */
  assetRoot?: string
  /** Standalone Node executable; defaults to the current executable outside Electron and SEA. */
  node?: string
  /** Absolute LibreOffice Kit CLI entry; false explicitly disables CLI access. */
  cli?: string | false
  /** Standalone render-cache module outside application archives; defaults to the packaged public entry. */
  renderApi?: string
  /** Optional structured creation tools; Desktop supplies its bundled runtime. */
  creation?: false | (Pick<OfficeCreationConfig, 'source'> & Partial<Omit<OfficeCreationConfig, 'source'>>)
}

const CreationConfig: z<Pick<OfficeCreationConfig, 'source'> & Partial<Omit<OfficeCreationConfig, 'source'>>, OfficeCreationConfig> = z.object({
  source: z.string().min(1).required(), root: z.string().min(1), enabled: z.boolean().default(true),
  timeoutMs: z.number().min(1).default(120_000), maxInputBytes: z.natural().min(1).default(2_097_152),
  maxItems: z.natural().min(1).default(1_000_000), maxOutputBytes: z.natural().min(1).default(131_072),
  maxCells: z.natural().min(1).default(1_000_000),
  maxFileBytes: z.natural().min(1).default(52_428_800), maxArchiveEntries: z.natural().min(1).default(10_000),
  maxUncompressedBytes: z.natural().min(1).default(262_144_000),
  maxInspectItems: z.natural().min(1).default(200), maxPreviewChars: z.natural().min(1).default(1000),
})

/** Validated resource configuration. */
export const Config: z<Config> = z.object({
  assetRoot: z.string().min(1),
  node: z.string().min(1),
  cli: z.union([z.string().min(1), z.const(false)]),
  renderApi: z.string().min(1),
  creation: z.union([z.const(false), CreationConfig]).default(false),
})

/** Cordis plugin identity. */
export const name = 'skill-office'
/** Registry used by the bundled provider. */
export const inject = ['skills']

function parseSkill(raw: string, path: string): { description: string; content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`skill-office: ${path} has no YAML frontmatter`)
  const metadata: unknown = parseYaml(frontmatter[1])
  const description = typeof metadata === 'object' && metadata !== null && 'description' in metadata
    ? metadata.description : undefined
  if (typeof description !== 'string' || description.length === 0) throw new Error(`skill-office: ${path} has no description`)
  return { description, content: raw.slice(frontmatter[0].length).trim() }
}

function officeRuntime(config: Config, assetRoot: string): string {
  if (config.cli === false) return '\n\nLibreOffice Kit is disabled in this deployment.'
  const packagedApplication = isSea() || process.versions.electron !== undefined
  if (config.node === undefined && packagedApplication) {
    throw new Error('skill-office: packaged applications must supply a standalone Node executable')
  }
  if (config.renderApi === undefined && packagedApplication) {
    throw new Error('skill-office: packaged applications must supply a standalone renderApi outside application archives')
  }
  const node = config.node ?? process.execPath
  let cli = config.cli
  if (cli === undefined) {
    const manifestPath = fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json'))
    cli = join(dirname(manifestPath), 'lib', 'cli.js')
  }
  for (const path of [node, cli]) {
    if (!isAbsolute(path) || !statSync(path).isFile()) throw new Error(`skill-office: expected an absolute executable file: ${path}`)
  }
  const renderWrapper = join(assetRoot, 'scripts', 'render_office.mjs')
  const renderApi = config.renderApi ?? fileURLToPath(new URL('../lib/render-cache.js', import.meta.url))
  if (!isAbsolute(renderApi)) throw new Error('skill-office: renderApi must be an absolute file path')
  if (config.renderApi !== undefined && !statSync(renderApi).isFile()) throw new Error('skill-office: renderApi must be a standalone file')
  return `\n\n## Installed LibreOffice Kit\n\nUse these absolute paths for every LibreOffice Kit command. For rendering, pass renderWrapper to Node and renderApi with --api; other operations use the CLI entry.\n\n${JSON.stringify({ libreofficeKit: { node, cli, renderWrapper, renderApi } }, undefined, 2)}`
}

/**
 * Register Office skills with resources readable by the script interpreter.
 * @param ctx - Context carrying the skill registry.
 * @param config - Optional external assets directory for packaged applications.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const assetRoot = config.assetRoot ?? fileURLToPath(new URL('../assets/', import.meta.url))
  if (!isAbsolute(assetRoot)) throw new Error('skill-office: assetRoot must be an absolute directory')
  if (!statSync(join(assetRoot, 'scripts', 'check_office.py')).isFile()) {
    throw new Error('skill-office: assets must contain scripts/check_office.py')
  }
  const runtime = officeRuntime(config, assetRoot)
  const candidates: SkillCandidate[] = SKILL_NAMES.map((skillName) => {
    const directory = join(assetRoot, skillName)
    const path = join(directory, 'SKILL.md')
    const { description } = parseSkill(readFileSync(path, 'utf8'), path)
    return {
      name: skillName, description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-office', source: 'bundled', rank: BUNDLED_SKILL_RANK,
      resourceBase: { kind: 'directory', path: directory }, locator: path,
    }
  })
  const provider: SkillProvider = {
    name: 'dsh-office',
    list: () => Promise.resolve(candidates),
    async get(candidate, options) {
      const { rank: _rank, locator, ...summary } = candidate
      const raw = await readFile(locator as string, { encoding: 'utf8', signal: options.signal })
      return { ...summary, content: parseSkill(raw, locator as string).content + runtime }
    },
  }
  ctx.skills.registerProvider(() => provider)
  if (config.creation !== undefined && config.creation !== false) {
    const creation = CreationConfig(config.creation)
    if (!isAbsolute(creation.source) || (creation.root !== undefined && !isAbsolute(creation.root))) throw new Error('Office creation runtime paths must be absolute')
    if (creation.enabled) ctx.inject(['tools', 'shell', 'workingDirectory', 'sandboxPolicy'], (scope) => {
      const node = config.node ?? process.execPath
      const cli = config.cli === false ? undefined : config.cli ?? join(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json'))), 'lib', 'cli.js')
      registerOfficeCreation(scope, creation, assetRoot, { node, ...cli === undefined ? {} : { cli } })
    })
  }
}
