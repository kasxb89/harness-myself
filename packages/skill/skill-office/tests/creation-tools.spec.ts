/** Real Loader and local authoring processes, without any model or network calls. */
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { afterEach, describe, expect, it } from 'vitest'
import { execa } from 'execa'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import BashLocal from '@deepseek-ai/dsh-bash-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import * as Office from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []
const runtime = process.env.DSH_OFFICE_TEST_RUNTIME
const assets = fileURLToPath(new URL('../assets/', import.meta.url))
let sequence = 0
function sourceSha(result: ToolExecutionResult): string {
  if (result.isError || result.value === null || typeof result.value !== 'object'
    || !('source_sha256' in result.value) || typeof result.value.source_sha256 !== 'string') throw new Error(JSON.stringify(result))
  return result.value.source_sha256
}
function producedPath(result: ToolExecutionResult): string {
  if (result.isError || result.value === null || typeof result.value !== 'object'
    || !('path' in result.value) || typeof result.value.path !== 'string') throw new Error(JSON.stringify(result))
  return result.value.path
}
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function setup(mode = 'danger-full-access', options: object = {}) {
  const root = await mkdtemp(join(tmpdir(), 'office-structured-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['agents', AgentRegistry], ['systemPrompt', SystemPrompt], ['projections', SessionProjections],
    ['skills', SkillRegistry], ['tools', ToolRuntime], ['fs', LocalFileSystem], ['subprocess', SubprocessLocal],
    ['shell', BashLocal], ['workingDirectory', WorkingDirectory], ['sandboxPolicy', SandboxPolicy], ['office', Office],
  ])
  ctx.loader.internal = { version: 'v2', async import(...[name]: Parameters<ModuleLoaderV2['import']>) {
    if (!modules.has(name)) throw new Error(`Unexpected Loader import: ${name}`)
    return modules.get(name)
  } } as ModuleLoaderV2
  const config = join(root, 'cordis.yml')
  await writeFile(config, [
    '- name: agents', '- name: systemPrompt', '- name: projections', '- name: skills', '- name: tools',
    `- name: fs\n  config:\n    cwd: ${JSON.stringify(root)}`,
    '- name: subprocess', `- name: shell\n  config:\n    cwd: ${JSON.stringify(root)}`,
    '- name: workingDirectory', `- name: sandboxPolicy\n  config:\n    mode: ${mode}\n    workspaceRoot: ${JSON.stringify(root)}`,
    `- name: office\n  config:\n    creation: ${JSON.stringify({ source: runtime ?? root, ...options })}`,
  ].join('\n'))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  let scope: Scope
  const id = SessionId(`office-${++sequence}`)
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: root, isSeeded: false })
  const agent: Agent = {
    id, session, options: {}, status: 'idle', inbox: unsupportedInbox(), get ctx() { return scope.ctx },
    send() {}, followup() {}, inject() {}, cancel() {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools'] }))
  await ctx.agents.register(agent)
  const execute = (name: string, input: object) => ctx.tools.execute({ name, arguments: input,
    callId: ToolCallId(`office-call-${++sequence}`), signal: new AbortController().signal, agent })
  return { ctx, root, execute }
}

it('exposes all five named schemas through a real Loader and unregisters them on disposal', async () => {
  const { ctx } = await setup()
  expect(ctx.tools.schemas().map(entry => entry.name)).toEqual(expect.arrayContaining(['word_create', 'slides_create', 'workbook_create', 'office_inspect', 'office_patch']))
  const office = [...ctx.loader.entries()].find(entry => entry.options.name === 'office')!
  await office.fiber!.dispose()
  expect(ctx.tools.schemas().some(entry => entry.name === 'word_create')).toBe(false)
})

it('honors read-only workspace policy before preparing dependencies or creating files', async () => {
  const { root, execute } = await setup('read-only')
  const result = await execute('word_create', { title: '报告', blocks: [{ kind: 'paragraph', text: '内容' }] })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result)).toContain('permission')
  expect((await readdir(root)).filter(path => path.endsWith('.docx'))).toEqual([])
})

it('enforces configured byte budgets before a local authoring process starts', async () => {
  const { execute } = await setup('danger-full-access', { maxInputBytes: 20 })
  expect(JSON.stringify(await execute('word_create', { title: '报告', blocks: [] }))).toContain('byte budget')
})

describe.skipIf(!runtime)('bundled Python creates actual editable files', () => {
  it.each([
    ['word_create', { title: '中文报告', blocks: [{ kind: 'heading', text: '结果', level: 1 }, { kind: 'paragraph', text: '正文内容' }, { kind: 'table', rows: [['项目', '数量'], ['样例', '2']] }] }, 'docx'],
    ['slides_create', { title: '季度演示', slides: [{ title: '销售趋势', body: ['原生可编辑文字'], chart: { kind: 'bar', categories: ['一月', '二月'], series: [{ name: '营收', values: [10, 20] }] }, notes: '讲稿' }] }, 'pptx'],
    ['workbook_create', { title: '收入明细', sheets: [{ name: '明细', rows: [['月份', '收入'], ['一月', 10], ['二月', 20], ['文本', '=not_a_formula']], column_widths: [{ column: 'A', width: 24 }] }] }, 'xlsx'],
  ] as const)('creates and independently reopens %s in one tool call', async (name, input, extension) => {
    const { root, execute } = await setup()
    const result = await execute(name, input)
    expect(result.isError, JSON.stringify(result)).toBe(false)
    const files = (await readdir(root)).filter(path => path.endsWith(`.${extension}`))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/-[0-9a-f]{8}-[0-9a-f-]{27}\./)
    if (process.env.DSH_OFFICE_SAMPLE_DIR !== undefined) {
      await mkdir(process.env.DSH_OFFICE_SAMPLE_DIR, { recursive: true })
      await cp(join(root, files[0]!), join(process.env.DSH_OFFICE_SAMPLE_DIR, files[0]!), { errorOnExist: true, force: false })
    }
    const python = join(runtime!, 'dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
    const check = await execa(python, [join(assets, 'scripts/check_office.py'), join(root, files[0]!)])
    expect(JSON.parse(check.stdout)).toMatchObject({ verdict: 'pass' })
    if (extension === 'pptx') {
      const verify = await execa(python, ['-c', 'from pptx import Presentation; import sys; p=Presentation(sys.argv[1]); print(sum(s.has_chart for s in p.slides[0].shapes)); print(p.slides[0].notes_slide.notes_text_frame.text)', join(root, files[0]!)])
      expect(verify.stdout).toContain('1\n讲稿')
    }
    if (extension === 'xlsx') {
      const verify = await execa(python, ['-c', 'from openpyxl import load_workbook; import sys; w=load_workbook(sys.argv[1]); print(w.active["B4"].data_type)', join(root, files[0]!)])
      expect(verify.stdout).toBe('s')
    }
    expect((await readdir(root)).some(path => path.startsWith('.office-create-'))).toBe(false)
  })

  it('does not overwrite another creation with the same title', async () => {
    const { root, execute } = await setup()
    const input = { title: '同名报告', blocks: [{ kind: 'paragraph', text: '内容' }] }
    expect((await execute('word_create', input)).isError).toBe(false)
    const original = (await readdir(root)).find(path => path.endsWith('.docx'))!
    const before = await readFile(join(root, original))
    expect((await execute('word_create', input)).isError).toBe(false)
    expect((await readdir(root)).filter(path => path.endsWith('.docx'))).toHaveLength(2)
    expect(await readFile(join(root, original))).toEqual(before)
  })

  it('genuinely recalculates formulas and independently reads their cached values', async () => {
    const { root, execute } = await setup()
    const result = await execute('workbook_create', { title: '公式合计', sheets: [{ name: '收入',
      rows: [['项目', '金额'], ['甲', 10], ['乙', 20], ['合计'], ['允许公式返回空白']],
      formulas: [{ cell: 'B4', expression: '=SUM(B2:B3)', expected_value: 30 }, { cell: 'B5', expression: '=IFERROR(1/0,"")', expected_value: '' }],
    }] })
    expect(result.isError, JSON.stringify(result)).toBe(false)
    const file = (await readdir(root)).find(path => path.endsWith('.xlsx'))!
    const python = join(runtime!, 'dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
    const verify = await execa(python, ['-c', 'from openpyxl import load_workbook; import sys; print(load_workbook(sys.argv[1], data_only=False).active["B4"].data_type); print(load_workbook(sys.argv[1], data_only=True).active["B4"].value)', join(root, file)])
    expect(verify.stdout).toBe('f\n30')
    expect(JSON.stringify(result)).toContain('formula_recalculated')
  }, 30_000)

  it('rejects enormous number-format ranges before allocating workbook cells', async () => {
    const { root, execute } = await setup('danger-full-access', { maxCells: 10 })
    const result = await execute('workbook_create', { title: '边界', sheets: [{ name: '数据', rows: [[1]], number_formats: [{ range: 'A1:XFD1048576', format: '0.00' }] }] })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('cell budget')
    expect((await readdir(root)).filter(path => path.endsWith('.xlsx'))).toEqual([])
  })

  it('binds Word edits to the inspected SHA and preserves run styles and every unrelated part', async () => {
    const { root, execute } = await setup()
    const python = join(runtime!, 'dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
    const source = join(root, '原稿.docx')
    await execa(python, ['-B', '-c', 'from docx import Document; import sys; d=Document(); p=d.add_paragraph(); p.add_run("你好 ").bold=True; p.add_run("朋友").italic=True; d.save(sys.argv[1])', source])
    const before = await readFile(source)
    const inspection = await execute('office_inspect', { source_path: source, paragraph_index: 0 })
    const sha = sourceSha(inspection)
    expect(sha).toBe(createHash('sha256').update(before).digest('hex'))
    const edited = await execute('office_patch', { source_path: source, source_sha256: sha, title: '修订报告',
      operations: [{ kind: 'word_text', paragraph_index: 0, run_index: 0, old_text: '你好', new_text: '大家好' }] })
    const output = producedPath(edited)
    const verified = await execa(python, ['-B', '-c', [
      'from docx import Document', 'import sys,zipfile', 'd=Document(sys.argv[2]); p=d.paragraphs[0]',
      'assert p.text == "大家好 朋友" and p.runs[0].bold and p.runs[1].italic',
      'with zipfile.ZipFile(sys.argv[1]) as a, zipfile.ZipFile(sys.argv[2]) as b:',
      ' assert a.namelist() == b.namelist()',
      ' assert all(a.read(n)==b.read(n) for n in a.namelist() if n != "word/document.xml")',
      'print("preserved")',
    ].join('\n'), source, output])
    expect(verified.stdout).toBe('preserved')
    expect(await readFile(source)).toEqual(before)
    await writeFile(source, Buffer.concat([before, Buffer.from('\nchanged')]))
    const stale = await execute('office_patch', { source_path: source, source_sha256: sha, title: '旧请求',
      operations: [{ kind: 'word_text', paragraph_index: 0, old_text: '你好', new_text: '错误更新' }] })
    expect(stale.isError).toBe(true)
    expect(JSON.stringify(stale)).toContain('no longer matches')
    expect((await readdir(root)).filter(path => path.endsWith('.docx'))).toHaveLength(2)
  })

  it('edits a PowerPoint text shape and notes while preserving its native chart and workbook', async () => {
    const { execute } = await setup()
    const python = join(runtime!, 'dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
    const source = producedPath(await execute('slides_create', { title: '原稿演示', slides: [{ title: '销售', body: ['原始文字'],
      chart: { kind: 'bar', categories: ['一月'], series: [{ name: '收入', values: [10] }] }, notes: '原始讲稿' }] }))
    const before = await readFile(source)
    const sha = sourceSha(await execute('office_inspect', { source_path: source, slide_number: 1 }))
    const identity = await execa(python, ['-B', '-c', 'from pptx import Presentation; import sys; print(next(s.shape_id for s in Presentation(sys.argv[1]).slides[0].shapes if s.has_text_frame and s.text=="原始文字"))', source])
    const output = producedPath(await execute('office_patch', { source_path: source, source_sha256: sha, title: '修订演示', operations: [
      { kind: 'slide_text', slide_number: 1, shape_id: Number(identity.stdout), old_text: '原始文字', new_text: '更新文字' },
      { kind: 'slide_notes', slide_number: 1, old_text: '原始讲稿', new_text: '更新讲稿' },
    ] }))
    const verified = await execa(python, ['-B', '-c', [
      'from pptx import Presentation', 'import sys,zipfile', 'p=Presentation(sys.argv[2]); s=p.slides[0]',
      'assert any(x.has_text_frame and x.text=="更新文字" for x in s.shapes)',
      'assert sum(x.has_chart for x in s.shapes)==1 and s.notes_slide.notes_text_frame.text=="更新讲稿"',
      'with zipfile.ZipFile(sys.argv[1]) as a, zipfile.ZipFile(sys.argv[2]) as b:',
      ' assert all(a.read(n)==b.read(n) for n in a.namelist() if n not in ("ppt/slides/slide1.xml","ppt/notesSlides/notesSlide1.xml"))',
      'print("preserved")',
    ].join('\n'), source, output])
    expect(verified.stdout).toBe('preserved')
    expect(await readFile(source)).toEqual(before)
  })

  it('patches Excel cells and number formats, recalculates caches, and preserves charts and other styles', async () => {
    const { root, execute } = await setup()
    const python = join(runtime!, 'dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
    const source = join(root, '原稿.xlsx')
    await execa(python, ['-B', '-c', [
      'from openpyxl import Workbook', 'from openpyxl.styles import Font', 'from openpyxl.chart import BarChart,Reference', 'import sys',
      'w=Workbook();s=w.active;s.title="收入";s.append(["名称","金额"]);s.append(["甲",10]);s.append(["乙",20]);s.append(["合计","=SUM(B2:B3)"])',
      's["B2"].font=Font(bold=True,color="FF0000");c=BarChart();c.add_data(Reference(s,min_col=2,min_row=1,max_row=3),titles_from_data=True);s.add_chart(c,"D1");w.save(sys.argv[1])',
    ].join('\n'), source])
    const before = await readFile(source)
    const sha = sourceSha(await execute('office_inspect', { source_path: source, sheet: '收入' }))
    const output = producedPath(await execute('office_patch', { source_path: source, source_sha256: sha, title: '修订收入', operations: [
      { kind: 'cell', sheet: '收入', cell: 'B2', value: 15, number_format: '0.00' },
      { kind: 'cell', sheet: '收入', cell: 'C1', value: '=这是文本' },
      { kind: 'cell', sheet: '收入', cell: 'C8', value: '新增范围' },
    ] }))
    const verified = await execa(python, ['-B', '-c', [
      'from openpyxl import load_workbook', 'import sys,zipfile', 'w=load_workbook(sys.argv[2]);s=w.active',
      'assert s["B2"].value==15 and s["B2"].font.bold and s["B2"].font.color.rgb=="00FF0000" and s["B2"].number_format=="0.00"',
      'assert s["C1"].data_type=="s" and s["B4"].value=="=SUM(B2:B3)" and len(s._charts)==1',
      'assert load_workbook(sys.argv[2],data_only=True).active["B4"].value==35',
      'r=load_workbook(sys.argv[2],read_only=True);assert list(r.active.iter_rows(values_only=True))[7][2]=="新增范围";r.close()',
      'with zipfile.ZipFile(sys.argv[1]) as a, zipfile.ZipFile(sys.argv[2]) as b:',
      ' assert all(a.read(n)==b.read(n) for n in a.namelist() if n.startswith("xl/charts/") or n.startswith("xl/drawings/"))',
      'print("preserved")',
    ].join('\n'), source, output])
    expect(verified.stdout).toBe('preserved')
    expect(await readFile(source)).toEqual(before)
  }, 30_000)

  it('reports external relationships as preservation warnings and leaves the programmable workflow available', async () => {
    const { root, execute } = await setup()
    const python = join(runtime!, 'dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
    const source = join(root, '外链.docx')
    await execa(python, ['-B', '-c', [
      'from docx import Document', 'from docx.opc.constants import RELATIONSHIP_TYPE as RT', 'import sys',
      'd=Document();d.add_paragraph("内容");d.part.relate_to("https://example.invalid/",RT.HYPERLINK,is_external=True);d.save(sys.argv[1])',
    ].join('\n'), source])
    const before = await readFile(source)
    const inspected = await execute('office_inspect', { source_path: source })
    expect(inspected).toMatchObject({ isError: false, value: { can_patch: false } })
    const patched = await execute('office_patch', { source_path: source, source_sha256: sourceSha(inspected), title: '安全修改',
      operations: [{ kind: 'word_text', paragraph_index: 0, old_text: '内容', new_text: '更新' }] })
    expect(patched.isError).toBe(true)
    expect(JSON.stringify(patched)).toContain('programmable')
    expect(await readFile(source)).toEqual(before)
    expect((await readdir(root)).filter(path => path.endsWith('.docx'))).toEqual(['外链.docx'])
  })

  it('bounds source bytes, archive expansion, package entries, and populated cells before inspection', async () => {
    const python = join(runtime!, 'dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
    for (const [options, message] of [
      [{ maxFileBytes: 1 }, 'file budget'], [{ maxArchiveEntries: 1 }, 'archive budget'],
      [{ maxUncompressedBytes: 1 }, 'archive budget'], [{ maxCells: 1 }, 'cell budget'],
    ] as const) {
      const { root, execute } = await setup('danger-full-access', options)
      const source = join(root, '有界输入.xlsx')
      await execa(python, ['-B', '-c', 'from openpyxl import Workbook; import sys; w=Workbook();w.active.append([1,2]);w.save(sys.argv[1])', source])
      const result = await execute('office_inspect', { source_path: source })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).toContain(message)
      expect((await readdir(root)).filter(path => path.endsWith('.xlsx'))).toEqual(['有界输入.xlsx'])
    }
  })
})
