import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertRuntimeLicenses, isPermissive } from './gen-third-party-notices.ts'
import { assertHeicDecoderDistribution, hasExternalHeicModules, HEIC_DECODER_DISTRIBUTION } from './heic-decoder-distribution.ts'

const root = resolve(import.meta.dirname, '..')
const packagePath = 'packages/host/credits-index'
const materials = `${packagePath}/third-party-notices/heic`
const config = readFileSync(resolve(root, packagePath, 'tsdown.config.ts'), 'utf8')

function fixture(): { directory: string; dispose: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'heic-distribution-'))
  mkdirSync(resolve(directory, packagePath), { recursive: true })
  cpSync(resolve(root, materials), resolve(directory, materials), { recursive: true })
  writeFileSync(resolve(directory, packagePath, 'package.json'), JSON.stringify({
    dependencies: { 'heic-decode': '2.1.0', 'libheif-js': '1.23.5' }, files: ['third-party-notices/**'],
  }))
  writeFileSync(resolve(directory, packagePath, 'tsdown.config.ts'), config)
  writeFileSync(resolve(directory, 'pnpm-workspace.yaml'), JSON.stringify({
    overrides: { 'heic-decode@2.1.0>libheif-js': HEIC_DECODER_DISTRIBUTION.version },
  }))
  writeFileSync(resolve(directory, 'pnpm-lock.yaml'), JSON.stringify({
    packages: { 'libheif-js@1.23.5': { resolution: { integrity: HEIC_DECODER_DISTRIBUTION.integrity } } },
    snapshots: { 'heic-decode@2.1.0': { dependencies: { 'libheif-js': '1.23.5' } } },
  }))
  return { directory, dispose: () => { rmSync(directory, { recursive: true, force: true }) } }
}

describe('HEIC accompanying-source distribution', () => {
  it('keeps LGPL non-permissive and admits only the reviewed release identity', () => {
    expect(isPermissive('LGPL-3.0')).toBe(false)
    expect(() => { assertRuntimeLicenses([HEIC_DECODER_DISTRIBUTION]) }).not.toThrow()
    for (const rejected of [
      { ...HEIC_DECODER_DISTRIBUTION, version: '1.23.6' },
      { ...HEIC_DECODER_DISTRIBUTION, name: 'another-lgpl-library' },
      { ...HEIC_DECODER_DISTRIBUTION, license: 'GPL-3.0-only' },
      { ...HEIC_DECODER_DISTRIBUTION, sourceCommit: 'unreviewed' },
      { name: 'libheif-js', version: '1.23.5', license: 'LGPL-3.0' },
    ]) expect(() => { assertRuntimeLicenses([rejected]) }).toThrow('not a permissive license')
  })

  it('requires both modules in the exported external configuration', () => {
    expect(hasExternalHeicModules(config)).toBe(true)
    for (const changed of [
      config.replace("'heic-decode', ", ''),
      config.replace("'libheif-js'", "'unrelated-library'"),
      config.replace('external:', 'noExternal:'),
      config.replace('external:', 'noExternal: true, external:'),
      config.replace('external:', '...otherConfig, external:'),
      config.replace('external:', "external: ['heic-decode'], external:"),
      config.replace('external:', "['external']:"),
      config.replace('export default', 'const unused ='),
      config.replace("from 'tsdown'", "from 'unrelated-builder'"),
      `// ${config.replaceAll('\n', '\n// ')}`,
    ]) expect(hasExternalHeicModules(changed)).toBe(false)
  })

  it('verifies complete source archives, notices, lock integrity and the shipping files', () => {
    const test = fixture()
    try {
      expect(assertHeicDecoderDistribution(test.directory, new Set())).toBe(HEIC_DECODER_DISTRIBUTION.sourceCommit)
      expect(() => assertHeicDecoderDistribution(test.directory, new Set(['libheif-js']))).toThrow('must remain external')
      writeFileSync(resolve(test.directory, materials, 'sources/libheif-413e2a87.tar.gz'), 'changed source')
      expect(() => assertHeicDecoderDistribution(test.directory, new Set())).toThrow('checksum mismatch')
    } finally { test.dispose() }
  })

  it.each(['lock', 'files', 'version', 'override', 'license-text', 'replacement-tool'])('rejects altered %s distribution material', (change) => {
    const test = fixture()
    try {
      if (change === 'lock') writeFileSync(resolve(test.directory, 'pnpm-lock.yaml'), '{}')
      else if (change === 'override') writeFileSync(resolve(test.directory, 'pnpm-workspace.yaml'), JSON.stringify({
        overrides: { 'heic-decode@2.2.0>libheif-js': HEIC_DECODER_DISTRIBUTION.version },
      }))
      else if (change === 'files' || change === 'version') writeFileSync(resolve(test.directory, packagePath, 'package.json'), JSON.stringify({
        dependencies: { 'heic-decode': '2.1.0', 'libheif-js': change === 'version' ? '1.23.6' : '1.23.5' },
        files: change === 'files' ? ['lib/index.js'] : ['third-party-notices/**'],
      }))
      else if (change === 'license-text') writeFileSync(resolve(test.directory, materials, 'libheif-js-1.23.5.LICENSE.txt'), 'truncated')
      else rmSync(resolve(test.directory, materials, 'relink-runtime.mjs'))
      expect(() => assertHeicDecoderDistribution(test.directory, new Set())).toThrow()
    } finally { test.dispose() }
  })
})

describe('offline replacement inventory tool', () => {
  it.each([false, true])('refreshes only library modifications and rejects unrelated changes (%s)', (unrelatedChange) => {
    const directory = mkdtempSync(join(tmpdir(), 'heic-relink-'))
    try {
      const originalFiles = [
        ['node_modules/heic-decode/index.js', 'module.exports = decode'],
        ['node_modules/libheif-js/index.js', 'module.exports = libheif'],
        ['host.js', 'host application'],
      ] as const
      const files = originalFiles.map(([path, value]) => {
        mkdirSync(dirname(resolve(directory, path)), { recursive: true })
        writeFileSync(resolve(directory, path), value)
        return { path, bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex'), executable: false }
      }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      const descriptorPath = resolve(directory, 'desktop-runtime.json')
      const original = `${JSON.stringify({ schemaVersion: 1, platform: process.platform, files, release: { version: 'test' } })}\n`
      writeFileSync(descriptorPath, original)
      writeFileSync(resolve(directory, unrelatedChange ? 'host.js' : 'node_modules/libheif-js/index.js'), 'modified library')
      const tool = resolve(root, materials, 'relink-runtime.mjs')
      if (unrelatedChange) {
        const result = spawnSync(process.execPath, [tool, directory], { encoding: 'utf8' })
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('Files outside heic-decode/libheif-js changed')
        expect(readFileSync(descriptorPath, 'utf8')).toBe(original)
      } else {
        expect(execFileSync(process.execPath, [tool, directory], { encoding: 'utf8' })).toContain('Refreshed HEIC decoder inventory')
        const updated = JSON.parse(readFileSync(descriptorPath, 'utf8')) as { files: typeof files }
        expect(updated.files.find(file => file.path === 'node_modules/libheif-js/index.js')?.sha256)
          .toBe(createHash('sha256').update('modified library').digest('hex'))
        expect(updated.files.find(file => file.path === 'host.js')).toEqual(files.find(file => file.path === 'host.js'))
      }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
