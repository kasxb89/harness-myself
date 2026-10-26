/** Native Office protocol and cached calculation results, without a model or provider call. */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'

const runtime = process.env.DSH_OFFICE_TEST_RUNTIME
const python = join(runtime ?? '', 'dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
const node = join(runtime ?? '', 'dependencies/node/bin', process.platform === 'win32' ? 'node.exe' : 'node')
const kit = join(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json'))), 'lib/cli.js')
const scripts = fileURLToPath(new URL('../assets/scripts/', import.meta.url))
const roots: string[] = []
const limits = { timeout_ms: 120_000, max_cells: 1_000_000, max_items: 1_000_000, max_file_bytes: 52_428_800,
  max_archive_entries: 10_000, max_uncompressed_bytes: 262_144_000, max_inspect_items: 200, max_preview_chars: 1000,
  max_output_bytes: 131_072, node, cli: kit }
let calls = 0

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (process.env.DSH_OFFICE_FIX_EVIDENCE_DIR !== undefined) {
      await mkdir(process.env.DSH_OFFICE_FIX_EVIDENCE_DIR, { recursive: true })
      await cp(root, join(process.env.DSH_OFFICE_FIX_EVIDENCE_DIR, basename(root)), { recursive: true, errorOnExist: true, force: false })
    }
    await rm(root, { recursive: true, force: true })
  }
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'office 中文 空格-'))
  roots.push(root)
  return root
}

function decoded(bytes: Uint8Array): Record<string, unknown> {
  const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error('Missing Office result object')
  return result as Record<string, unknown>
}

function field(result: Record<string, unknown>, name: string): string {
  const value = result[name]
  if (typeof value !== 'string') throw new Error(`Missing Office ${name}: ${JSON.stringify(result)}`)
  return value
}

async function script(root: string, kind: string, spec: object, encoding = 'utf-8', failure = false, subprocessEncoding?: string) {
  const id = String(++calls)
  const input = Buffer.from(JSON.stringify({ kind, spec, ...limits }), 'utf8')
  await writeFile(join(root, `${id}-stdin.bytes`), input)
  const entry = join(scripts, kind === 'inspect' || kind === 'patch' ? 'office_package.py' : 'create_office.py')
  const args = subprocessEncoding === undefined ? ['-B', entry] : ['-B', '-X', 'utf8=0', '-c', [
    'import locale,runpy,sys', 'assert sys.flags.utf8_mode==0', 'locale.getencoding=lambda:sys.argv[1]',
    'sys.path.insert(0,sys.argv[2])', 'runpy.run_path(sys.argv[3],run_name="__main__")',
  ].join(';'), subprocessEncoding, scripts, entry]
  const result = await execa(python, args, {
    cwd: root, input, encoding: 'buffer', env: { PYTHONIOENCODING: encoding, PYTHONUTF8: '0' }, reject: false,
  })
  await writeFile(join(root, `${id}-stdout.bytes`), result.stdout)
  await writeFile(join(root, `${id}-stderr.bytes`), result.stderr)
  expect(result.exitCode, result.stderr.toString()).toBe(failure ? 1 : 0)
  return decoded(failure ? result.stderr : result.stdout)
}

const makeFixture = [
  'from openpyxl import Workbook', 'from openpyxl.worksheet.formula import ArrayFormula',
  'from openpyxl.chart import BarChart,Reference', 'from lxml import etree as E', 'import sys,zipfile',
  'w=Workbook();s=w.active;s.title="数据";kind=sys.argv[2]',
  's["B1"]=2 if kind=="spill" else 10',
  's["A1"]=ArrayFormula(ref="A1:A2",text="=_xlfn.SEQUENCE(B1,1,1,1)" if kind=="spill" else "=ROW(A1:A2)*B1")',
  'if kind=="shared":',
  ' s["A1"]="=$B$1*ROW()";s["A2"]="=$B$1*ROW()";s["A3"]="=$B$1*ROW()"',
  's["A6"]="保留用户备注"',
  'c=BarChart();c.add_data(Reference(s,min_col=2,min_row=1,max_row=1));s.add_chart(c,"D1");w.save(sys.argv[1])',
  'if kind=="shared":',
  ' with zipfile.ZipFile(sys.argv[1]) as z:parts={n:z.read(n) for n in z.namelist()}',
  ' ns={"s":"http://schemas.openxmlformats.org/spreadsheetml/2006/main"};t=E.fromstring(parts["xl/worksheets/sheet1.xml"])',
  ' for cell in t.findall("s:sheetData/s:row/s:c",ns):',
  '  if cell.get("r") not in ("A1","A2","A3"):continue',
  '  f=cell.find("s:f",ns);f.set("t","shared");f.set("si","0");f.text="$B$1*ROW()" if cell.get("r")=="A1" else None',
  '  if cell.get("r")=="A1":f.set("ref","A1:A3")',
  '  cell.find("s:v",ns).text=str(10*int(cell.get("r")[1:]))',
  ' parts["xl/worksheets/sheet1.xml"]=E.tostring(t)',
  ' with zipfile.ZipFile(sys.argv[1],"w") as z:',
  '  for n,b in parts.items():z.writestr(n,b)',
].join('\n')

describe.skipIf(!runtime)('native Office usability regressions', () => {
  it.each([
    { operation: 'create', encoding: 'cp936' }, { operation: 'create', encoding: 'cp1252' },
    { operation: 'patch', encoding: 'cp936' }, { operation: 'patch', encoding: 'cp1252' },
  ])('recalculates a Chinese-path workbook during $operation with subprocess locale $encoding', async ({ operation, encoding }) => {
    const root = join(await workspace(), '企业 数据')
    await mkdir(root)
    const created = await script(root, 'xlsx', { title: '企业数据公式表',
      sheets: [{ name: '数据', rows: [[10]], formulas: [{ cell: 'B1', expression: '=A1*2', expected_value: 20 }] }] },
    'utf-8', false, operation === 'create' ? encoding : undefined)
    expect(created.formula_recalculated).toBe(true)
    const source = field(created, 'path')
    const before = await readFile(source)
    let output = source
    if (operation === 'patch') {
      const inspected = await script(root, 'inspect', { source_path: source })
      const patched = await script(root, 'patch', { source_path: source, source_sha256: field(inspected, 'source_sha256'),
        title: '企业公式修订', operations: [{ kind: 'cell', sheet: '数据', cell: 'A1', value: 20 }] }, 'utf-8', false, encoding)
      expect(patched.formula_recalculated).toBe(true)
      output = field(patched, 'path')
    }
    const checked = await execa(python, ['-X', 'utf8', '-B', '-c', [
      'from openpyxl import load_workbook;import sys',
      'v=load_workbook(sys.argv[1],data_only=True);f=load_workbook(sys.argv[1],data_only=False)',
      'assert v["数据"]["B1"].value==int(sys.argv[2])', 'assert f["数据"]["B1"].value=="=A1*2"',
    ].join(';'), output, operation === 'patch' ? '40' : '20'])
    expect(checked.exitCode).toBe(0)
    expect(await readFile(source)).toEqual(before)
  })

  it.each(['cp936', 'cp1252'])('preserves UTF-8 content, paths, and structured errors when ambient pipes use %s', async (encoding) => {
    const root = await workspace()
    const created = await script(root, 'docx', { title: '中文报告 🌱', blocks: [{ kind: 'paragraph', text: '中文内容与表情 🌱' }] }, encoding)
    const source = field(created, 'path')
    expect(source).toContain('中文报告 🌱')
    const before = await readFile(source)
    const inspected = await script(root, 'inspect', { source_path: source }, encoding)
    const edited = await script(root, 'patch', { source_path: source, source_sha256: field(inspected, 'source_sha256'),
      title: '修订中文报告 🌱', operations: [{ kind: 'word_text', paragraph_index: 1, old_text: '中文内容与表情 🌱', new_text: '修订内容仍为中文 🌱' }] }, encoding)
    const check = await execa(python, ['-X', 'utf8', '-B', '-c',
      'from docx import Document; import sys; assert Document(sys.argv[1]).paragraphs[1].text=="修订内容仍为中文 🌱"', field(edited, 'path')])
    expect(check.exitCode).toBe(0)
    expect(await readFile(source)).toEqual(before)
    const impossible = join(root, '中文图片'.repeat(100))
    const creationError = await script(root, 'docx', { title: '失败保持可读', blocks: [{ kind: 'image', image_path: impossible }] }, encoding, true)
    const inspectionError = await script(root, 'inspect', { source_path: impossible }, encoding, true)
    expect(field(creationError, 'error')).toContain('中文图片')
    expect(field(inspectionError, 'error')).toContain('中文图片')
  })

  it.each(['array', 'shared', 'spill'])('updates the complete %s formula result and preserves template objects', async (kind) => {
    const root = await workspace()
    const initial = join(root, '模板初稿.xlsx')
    await execa(python, ['-X', 'utf8', '-B', '-c', makeFixture, initial, kind])
    const source = join(root, '正常模板.xlsx')
    if (kind === 'shared') await cp(initial, source)
    else await execa(node, [kit, 'recalculate', '--input', initial, '--output', source])
    const before = await readFile(source)
    const inspected = await script(root, 'inspect', { source_path: source })
    expect(inspected.can_patch).toBe(true)
    const patched = await script(root, 'patch', { source_path: source, source_sha256: field(inspected, 'source_sha256'),
      title: '更新模板输入', operations: [{ kind: 'cell', sheet: '数据', cell: 'B1', value: kind === 'spill' ? 4 : 20 }] })
    expect(patched.formula_recalculated).toBe(true)
    const output = field(patched, 'path')
    const validation = [
      'from openpyxl import load_workbook', 'import sys,zipfile,json',
      'w=load_workbook(sys.argv[2],data_only=True);s=w["数据"];kind=sys.argv[3]',
      'values=[s.cell(i,1).value for i in range(1,5)]',
      'assert values==([1,2,3,4] if kind=="spill" else [20,40,60,None] if kind=="shared" else [20,40,None,None]),values',
      'assert s["A6"].value=="保留用户备注"',
      'assert len(load_workbook(sys.argv[2]).active._charts)==1',
      'with zipfile.ZipFile(sys.argv[1]) as a,zipfile.ZipFile(sys.argv[2]) as b:',
      ' assert a.namelist()==b.namelist()',
      ' assert all(a.read(n)==b.read(n) for n in a.namelist() if n!="xl/worksheets/sheet1.xml")',
      ' if kind=="shared":assert b\'t="shared"\' in b.read("xl/worksheets/sheet1.xml")',
      'print(json.dumps(values))',
    ].join('\n')
    const checked = await execa(python, ['-X', 'utf8', '-B', '-c', validation, source, output, kind])
    expect(checked.exitCode).toBe(0)
    expect(await readFile(source)).toEqual(before)
    if (kind === 'spill') {
      const current = await script(root, 'inspect', { source_path: output })
      const shrunk = await script(root, 'patch', { source_path: output, source_sha256: field(current, 'source_sha256'),
        title: '缩小动态范围', operations: [{ kind: 'cell', sheet: '数据', cell: 'B1', value: 1 }] })
      const confirmed = await execa(python, ['-X', 'utf8', '-B', '-c',
        'from openpyxl import load_workbook;import sys;w=load_workbook(sys.argv[1],data_only=True);assert [w.active.cell(i,1).value for i in range(1,5)]==[1,None,None,None];assert w.active["A6"].value=="保留用户备注"', field(shrunk, 'path')])
      expect(confirmed.exitCode).toBe(0)
    }
  })

  it('keeps traditional fixed CSE array extents while refreshing every cached member', async () => {
    const root = await workspace()
    const source = join(root, '固定数组.xlsx')
    await execa(python, ['-X', 'utf8', '-B', '-c', makeFixture, source, 'spill'])
    const inspected = await script(root, 'inspect', { source_path: source })
    const result = await script(root, 'patch', { source_path: source, source_sha256: field(inspected, 'source_sha256'),
      title: '保留固定范围', operations: [{ kind: 'cell', sheet: '数据', cell: 'B1', value: 4 }] })
    const checked = await execa(python, ['-X', 'utf8', '-B', '-c',
      'from openpyxl import load_workbook;import sys;v=load_workbook(sys.argv[1],data_only=True);f=load_workbook(sys.argv[1]);assert [v.active.cell(i,1).value for i in range(1,5)]==[1,2,None,None];assert f.active["A1"].value.ref=="A1:A2"', field(result, 'path')])
    expect(checked.exitCode).toBe(0)
  })

  it('keeps the original template and refuses a dynamic expansion over user content', async () => {
    const root = await workspace()
    const initial = join(root, '动态初稿.xlsx'), source = join(root, '含备注模板.xlsx')
    await execa(python, ['-X', 'utf8', '-B', '-c', makeFixture, initial, 'spill'])
    await execa(node, [kit, 'recalculate', '--input', initial, '--output', source])
    const before = await readFile(source)
    const inspected = await script(root, 'inspect', { source_path: source })
    const failed = await script(root, 'patch', { source_path: source, source_sha256: field(inspected, 'source_sha256'),
      title: '不会覆盖备注', operations: [{ kind: 'cell', sheet: '数据', cell: 'B1', value: 6 }] }, 'utf-8', true)
    expect(field(failed, 'error')).toContain('conflicts with an existing cell')
    expect(await readFile(source)).toEqual(before)
    const files = await readdir(root)
    expect(files.filter(path => path.endsWith('.xlsx')).sort()).toEqual(['动态初稿.xlsx', '含备注模板.xlsx'].sort())
  })
})
