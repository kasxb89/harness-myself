/** Published PDF and spreadsheet chunks retain their bundled license notices. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const bundlePath = join(packageRoot, 'lib/client.js')
const pdfChunkPath = join(packageRoot, 'lib/client.pdf.js')
const require = createRequire(import.meta.url)
const licenseNames = [
  'LICENSE',
  'cmaps/LICENSE',
  'standard_fonts/LICENSE_FOXIT',
  'standard_fonts/LICENSE_LIBERATION',
  'wasm/LICENSE_JBIG2',
  'wasm/LICENSE_OPENJPEG',
  'wasm/LICENSE_PDFJS_JBIG2',
  'wasm/LICENSE_PDFJS_OPENJPEG',
  'wasm/LICENSE_PDFJS_QCMS',
  'wasm/LICENSE_QCMS',
] as const

function run(command: string, args: string[], cwd: string, timeout: number): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout })
  expect(result.error).toBeUndefined()
  expect(result.signal, result.stderr).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

function runPnpm(args: string[], cwd: string, timeout: number): string {
  const entrypoint = process.env.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    if (process.platform === 'win32') throw new Error('npm_execpath is required to run pnpm on Windows')
    return run('pnpm', args, cwd, timeout)
  }
  return /\.[cm]?js$/iu.test(entrypoint)
    ? run(process.execPath, [entrypoint, ...args], cwd, timeout)
    : run(entrypoint, args, cwd, timeout)
}

describe('published document preview licenses', () => {
  it.skipIf(!existsSync(bundlePath))('keeps bundled licenses in the packed lazy chunks', ({ task }) => {
    expect(existsSync(pdfChunkPath)).toBe(true)
    const output = mkdtempSync(join(tmpdir(), 'dsh-document-preview-pack-'))
    try {
      // npm 11 (Node 25) answers with one entry per packed tarball; npm 10
      // answers with the entry itself.
      const packedOutput = JSON.parse(runPnpm([
        'pack', '--json', '--pack-gzip-level', '0', '--pack-destination', output,
      ], packageRoot, task.timeout)) as { filename: string; files: { path: string }[] } | { filename: string; files: { path: string }[] }[]
      const packed = Array.isArray(packedOutput) ? packedOutput[0]! : packedOutput
      expect(packed.files.map(file => file.path)).toContain('lib/client.js')
      expect(packed.files.map(file => file.path)).toContain('lib/client.pdf.js')
      expect(packed.files.map(file => file.path)).toContain('lib/client.frontmatter-fields.js')
      expect(packed.files.some(file => file.path.endsWith('pdfjs-NOTICES.txt'))).toBe(false)

      const chunks = ['client.js', 'client.pdf.js', 'client.excel.js', 'client.frontmatter-fields.js']
      run('tar', ['-xf', resolve(output, packed.filename), '-C', output, ...chunks.map(name => `package/lib/${name}`)], packageRoot, task.timeout)
      const client = readFileSync(join(output, 'package/lib/client.js'), 'utf8')
      const pdf = readFileSync(join(output, 'package/lib/client.pdf.js'), 'utf8')
      expect([...client.matchAll(/require\.async\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1]))
        .toEqual(['./client.frontmatter-fields.js', './client.pdf.js', './client.pdf.js', './client.excel.js'])
      expect([...client.matchAll(/require\.async\("\.\/client\.pdf\.js"\)\)\.(\w+)/gu)].map(match => match[1]))
        .toEqual(['PdfBody', 'ArtifactPdfBody'])
      expect(pdf).toContain('exports.PdfBody = PdfBody')
      expect(pdf).toContain('exports.ArtifactPdfBody = ArtifactPdfBody')
      expect(client).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
      expect([...pdf.matchAll(/require\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1]))
        .toEqual([])
      expect(client).not.toContain('//! Bundled PDF.js license notices')
      expect(client).not.toContain('/pdfjs-dist/')
      expect(pdf).toContain('//! Bundled PDF.js license notices')
      const excel = readFileSync(join(output, 'package/lib/client.excel.js'), 'utf8')
      expect(excel).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
      expect(client).not.toContain('FortuneSheet')
      expect(excel).toContain('//! Bundled spreadsheet license notices')
      expect(excel).toContain('Copyright (c) 2022 Suzhou Ruilisi Technology Co., Ltd')
      expect(excel).toContain('Permission is hereby granted, free of charge')
      for (const dependency of ['xlsx', 'papaparse']) {
        const root = dirname(require.resolve(dependency === 'xlsx' ? dependency : `${dependency}/package.json`))
        const license = readFileSync(join(root, 'LICENSE'), 'utf8').trimEnd()
        expect(excel).toContain(license.split('\n').map(line => `// ${line}`).join('\n'))
      }
      const frontmatter = readFileSync(join(output, 'package/lib/client.frontmatter-fields.js'), 'utf8')
      expect(frontmatter).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
      let frontmatterInitialized = false
      runInNewContext(frontmatter, { window: { __ModuleLoader__: { load: (registration: {
        factory: (resolve: (specifier: string) => unknown) => { FrontmatterFields: unknown }
      }) => {
        const loaded = registration.factory((specifier) => {
          if (specifier === 'react' || specifier === 'react/jsx-runtime') return require(specifier)
          throw new Error(`Unexpected browser dependency: ${specifier}`)
        })
        expect(typeof loaded.FrontmatterFields).toBe('function')
        frontmatterInitialized = true
      } } } })
      expect(frontmatterInitialized).toBe(true)
      let initialized = false
      runInNewContext(excel, { window: { __ModuleLoader__: { load: (registration: {
        factory: (resolve: (specifier: string) => unknown) => { ExcelBody: unknown }
      }) => {
        const loaded = registration.factory((specifier) => {
          if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return {}
          if (specifier === 'react' || specifier === 'react/jsx-runtime' || specifier === 'react-dom') return require(specifier)
          throw new Error(`Unexpected browser dependency: ${specifier}`)
        })
        expect(typeof loaded.ExcelBody).toBe('function')
        initialized = true
      } } } })
      expect(initialized).toBe(true)
      const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'))
      for (const name of licenseNames) {
        const source = readFileSync(join(pdfRoot, name), 'utf8').trimEnd()
        const commented = [`// ${name}`, '// ', ...source.split('\n').map(line => `// ${line}`)].join('\n')
        expect(pdf, `${name} must be visible in package/lib/client.pdf.js`).toContain(commented)
      }
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })
})
