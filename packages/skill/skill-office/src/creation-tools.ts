/** Structured Office creation using the existing permission-aware shell executor. */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { installPrimaryRuntime, resolvePrimaryRuntime, type WorkspaceDependencies } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import type { OfficeCreationConfig } from './types.ts'

const value = { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] } as const
const rows = { type: 'array', items: { type: 'array', items: value } } as const
const textRows = { type: 'array', items: { type: 'array', items: { type: 'string' } } } as const
const output = {
  type: 'object', additionalProperties: false,
  properties: {
    path: { type: 'string', required: true }, format: { type: 'string', required: true },
    check_summary: { type: 'string', required: true }, formula_recalculated: { type: 'boolean', required: true },
    visual_check_required: { type: 'boolean', required: true }, elapsed_ms: { type: 'number', required: true },
  },
} as const

function quote(path: string): string {
  return process.platform === 'win32' ? `'${path.replaceAll("'", "''")}'` : `'${path.replaceAll("'", "'\\''")}'`
}

function validateInput(spec: object, config: OfficeCreationConfig): void {
  const body = JSON.stringify(spec)
  if (Buffer.byteLength(body) > config.maxInputBytes) throw new Error('Office creation input exceeds its configured byte budget; use a local-data script for large inputs.')
  let count = 0
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) { count += entry.length; for (const item of entry) visit(item) }
    else if (entry !== null && typeof entry === 'object') for (const item of Object.values(entry)) visit(item)
  }
  visit(spec)
  if (count > config.maxItems) throw new Error('Office creation input exceeds its configured item budget; use the programmable workflow for this task.')
}

function parseResult(text: string): {
  path: string
  format: string
  check_summary: string
  formula_recalculated: boolean
  visual_check_required: boolean
  elapsed_ms: number
} {
  const result: unknown = JSON.parse(text)
  if (result === null || typeof result !== 'object' || !('path' in result) || typeof result.path !== 'string'
    || !('format' in result) || typeof result.format !== 'string'
    || !('check_summary' in result) || typeof result.check_summary !== 'string'
    || !('formula_recalculated' in result) || typeof result.formula_recalculated !== 'boolean'
    || !('visual_check_required' in result) || typeof result.visual_check_required !== 'boolean'
    || !('elapsed_ms' in result) || typeof result.elapsed_ms !== 'number' || !Number.isFinite(result.elapsed_ms)) {
    throw new Error('Office creation returned incomplete output metadata.')
  }
  return { path: result.path, format: result.format, check_summary: result.check_summary,
    formula_recalculated: result.formula_recalculated, visual_check_required: result.visual_check_required, elapsed_ms: result.elapsed_ms }
}

function parseInspection(text: string): {
  source_sha256: string
  format: string
  can_patch: boolean
  summary: string
  compatibility_warnings: string[]
} {
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object'
    || !('source_sha256' in value) || typeof value.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.source_sha256)
    || !('format' in value) || typeof value.format !== 'string'
    || !('can_patch' in value) || typeof value.can_patch !== 'boolean'
    || !('summary' in value) || typeof value.summary !== 'string'
    || !('compatibility_warnings' in value) || !Array.isArray(value.compatibility_warnings)
    || !value.compatibility_warnings.every((entry): entry is string => typeof entry === 'string')) {
    throw new Error('Office inspection returned incomplete source metadata.')
  }
  return { source_sha256: value.source_sha256, format: value.format, can_patch: value.can_patch,
    summary: value.summary, compatibility_warnings: value.compatibility_warnings }
}

/**
 * Register common editable-file creation tools, leaving complex scripts available.
 * @param ctx - Scope carrying the ordinary tool, shell, working-directory, and sandbox services.
 * @param config - Validated runtime, input, and execution bounds.
 * @param assetRoot - Read-only packaged Office scripts.
 * @param runtime - Bundled CLI and standalone Node paths, when configured.
 */
export function registerOfficeCreation(
  ctx: Context, config: OfficeCreationConfig, assetRoot: string, runtime: { node?: string; cli?: string },
): void {
  let preparation: Promise<WorkspaceDependencies> | undefined
  const lifetime = new AbortController()
  const active = new Set<Promise<unknown>>()
  ctx.effect(() => async () => { lifetime.abort(); await Promise.allSettled(active) })
  const run = async (kind: 'docx' | 'pptx' | 'xlsx' | 'inspect' | 'patch', spec: object, exec: ToolRunContext): Promise<string> => {
    if (exec.agent === undefined) throw new Error('Office creation requires a chat workspace.')
    const signal = AbortSignal.any([exec.signal, lifetime.signal])
    signal.throwIfAborted()
    validateInput(spec, config)
    const policy = ctx.sandboxPolicy.resolve({ session: exec.agent.session })
    if (policy.mode === 'read-only' && kind !== 'inspect') throw new Error('Office creation needs permission to write a file in this workspace.')
    const cwd = await ctx.workingDirectory.ensure(exec.agent, signal)
    preparation ??= (config.root === undefined ? resolvePrimaryRuntime(config.source) : installPrimaryRuntime(config.source, config.root))
      .catch((error: unknown) => { preparation = undefined; throw error })
    const dependencies = await preparation
    signal.throwIfAborted()
    const script = kind === 'inspect' || kind === 'patch' ? 'office_package.py' : 'create_office.py'
    const command = `${process.platform === 'win32' ? '& ' : ''}${quote(dependencies.python)} -B ${quote(join(assetRoot, 'scripts', script))}`
    const processHandle = await ctx.shell.execute(ctx.shell.resolve({ command, workdir: cwd,
      stdin: JSON.stringify({ kind, spec, ...runtime, timeout_ms: config.timeoutMs, max_cells: config.maxCells, max_items: config.maxItems,
        max_file_bytes: config.maxFileBytes, max_archive_entries: config.maxArchiveEntries,
        max_uncompressed_bytes: config.maxUncompressedBytes,
        max_inspect_items: config.maxInspectItems, max_preview_chars: config.maxPreviewChars, max_output_bytes: config.maxOutputBytes }),
      timeoutMs: config.timeoutMs, stdoutMaxBytes: config.maxOutputBytes, signal, sandboxPolicy: policy }))
    const result = await processHandle.result()
    if (result.aborted || signal.aborted) throw new Error('Office creation was cancelled; completed source files are never overwritten.')
    if (result.timedOut) throw new Error('Office creation exceeded its configured execution budget; use the programmable workflow for a larger task.')
    if (result.exitCode !== 0 || result.signal !== null) {
      throw new Error(`Office creation failed: ${result.stderr.text.trim() || 'the local authoring process could not finish'}`)
    }
    if (result.stdout.truncated) throw new Error('Office creation output exceeded its configured result budget.')
    return result.stdout.text
  }
  const execute = (kind: 'docx' | 'pptx' | 'xlsx' | 'inspect' | 'patch', spec: object, exec: ToolRunContext) => {
    const task = run(kind, spec, exec)
    active.add(task)
    void task.finally(() => { active.delete(task) }).catch(() => undefined)
    return task
  }
  ctx.tools.register(defineTool({
    name: 'word_create',
    description: 'Create an editable Word document in one call with native headings, paragraphs, tables, and local images. Uses bundled libraries and structural checks. For complex designs, templates, tracked edits, or existing documents use the Office skill and programmable tools. When visual_check_required is true, follow the skill layout checks before present.',
    parameters: {
      title: { type: 'string', required: true }, font: { type: 'string' },
      blocks: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', required: true, enum: ['heading', 'paragraph', 'bullet', 'table', 'image', 'page_break'] },
        text: { type: 'string' }, level: { type: 'integer' }, rows: textRows,
        image_path: { type: 'string' }, width_inches: { type: 'number' },
      } } },
    },
    output: { schema: output, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: async (args, exec) => parseResult(await execute('docx', args, exec)),
    presentCall: args => ({ card: 'generic', title: `Create Word: ${args.title}`, kind: 'execute' }),
  }))
  ctx.tools.register(defineTool({
    name: 'slides_create',
    description: 'Create a 16:9 editable PowerPoint deck in one call using native text, tables, charts, notes, and local images. Each slide supports body text plus one image/table/chart. Keep custom layouts and existing-deck edits in the programmable Office workflow. Inspect new-deck layout using the Office skill before present.',
    parameters: {
      title: { type: 'string', required: true },
      slides: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        title: { type: 'string', required: true }, body: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' },
        image_path: { type: 'string' }, table: textRows,
        chart: { type: 'object', additionalProperties: false, properties: {
          kind: { type: 'string', required: true, enum: ['bar', 'line', 'pie'] },
          categories: { type: 'array', required: true, items: { type: 'string' } },
          series: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            name: { type: 'string', required: true }, values: { type: 'array', required: true, items: { type: 'number' } },
          } } },
        } },
      } } },
    },
    output: { schema: output, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: async (args, exec) => parseResult(await execute('pptx', args, exec)),
    presentCall: args => ({ card: 'generic', title: `Create PowerPoint: ${args.title}`, kind: 'execute' }),
  }))
  ctx.tools.register(defineTool({
    name: 'workbook_create',
    description: 'Create an editable Excel workbook in one call with typed data, header styles, widths, number formats, and explicit formulas. Formulas are genuinely recalculated with bundled LibreOffice and checked; data strings beginning = stay text. Complex workbooks, large local data, charts, and existing-file edits remain available through the programmable Office skill.',
    parameters: {
      title: { type: 'string', required: true },
      sheets: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        name: { type: 'string', required: true }, rows, header: { type: 'boolean' },
        column_widths: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          column: { type: 'string', required: true }, width: { type: 'number', required: true },
        } } },
        number_formats: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          range: { type: 'string', required: true }, format: { type: 'string', required: true },
        } } },
        formulas: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          cell: { type: 'string', required: true }, expression: { type: 'string', required: true }, expected_value: value,
        } } },
      } } },
    },
    output: { schema: output, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: async (args, exec) => parseResult(await execute('xlsx', args, exec)),
    presentCall: args => ({ card: 'generic', title: `Create Excel: ${args.title}`, kind: 'execute' }),
  }))
  ctx.tools.register(defineTool({
    name: 'office_inspect',
    description: 'Inspect a local DOCX, PPTX, or XLSX before a focused edit. Returns the exact source SHA256, paragraph/run indices, slide/shape identifiers or sheet/cell coordinates, and preservation warnings. Select a paragraph, slide, or sheet for more detail. Unsupported advanced features keep the original file and remain available through the programmable Office workflow.',
    parameters: {
      source_path: { type: 'string', required: true }, paragraph_index: { type: 'integer' },
      slide_number: { type: 'integer' }, sheet: { type: 'string' }, max_items: { type: 'integer' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      source_sha256: { type: 'string', required: true }, format: { type: 'string', required: true },
      can_patch: { type: 'boolean', required: true }, summary: { type: 'string', required: true },
      compatibility_warnings: { type: 'array', required: true, items: { type: 'string' } },
    } }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: async (args, exec) => parseInspection(await execute('inspect', args, exec)),
    presentCall: () => ({ card: 'generic', title: 'Inspect Office document', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'office_patch',
    description: 'Apply focused edits to a DOCX/PPTX/XLSX whose source_sha256 exactly matches office_inspect, publishing a new semantic UUID file. Word/PPT replace one exact old_text while preserving run formatting; Excel changes explicit cells/number formats and genuinely recalculates affected workbook formulas. Unrelated package parts remain unchanged. Advanced/macro/external content uses the programmable workflow; do not flatten it.',
    parameters: {
      source_path: { type: 'string', required: true }, source_sha256: { type: 'string', required: true }, title: { type: 'string', required: true },
      operations: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', required: true, enum: ['word_text', 'slide_text', 'slide_notes', 'cell'] },
        paragraph_index: { type: 'integer' }, run_index: { type: 'integer' }, slide_number: { type: 'integer' }, shape_id: { type: 'integer' },
        old_text: { type: 'string' }, new_text: { type: 'string' }, sheet: { type: 'string' }, cell: { type: 'string' },
        value, formula: { type: 'string' }, expected_value: value, number_format: { type: 'string' },
      } } },
    },
    output: { schema: output, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: async (args, exec) => parseResult(await execute('patch', args, exec)),
    presentCall: args => ({ card: 'generic', title: `Edit Office: ${args.title}`, kind: 'execute' }),
  }))
}
