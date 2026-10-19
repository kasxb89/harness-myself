/** Validate the reviewed HEIC library, accompanying sources and replacement mechanism. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import ts from 'typescript'

/** Exact npm library covered by the accompanying-source distribution decision. */
export const HEIC_DECODER_DISTRIBUTION = Object.freeze({
  name: 'libheif-js',
  version: '1.23.5',
  license: 'LGPL-3.0',
  sourceCommit: 'd8ec4bc3bc5bf8055975577bccbbc7e1d7313c2d',
  integrity: 'sha512-umXZPthnWZtF3iG/5mQG+AZ2V6i0UeYpo3z2CkggTEgL8dKmIIwJT6TDuAMuabXa1yTW8uJ1ZAgR+CxNTklYYw==',
})

const PACKAGE = 'packages/host/credits-index'
const SOURCE_DIRECTORY = `${PACKAGE}/third-party-notices/heic`
const ACCOMPANYING_FILES: Readonly<Record<string, string>> = {
  'sources/heic-decode-2.1.0.tar.gz': '9abe45633cf5f04e8f269ec37dd7dfb2a5ebc2a97ae09654ae43bafc22cfa5e5',
  'sources/libheif-js-1.23.5.tar.gz': 'db9c0c25b15c5c351ac5b045b01009cc446f5712091300656902f9e40a2934db',
  'sources/libheif-emscripten-v1.23.5.tar.gz': '5e524ec5746bb0676c5865c9ce76d40cee871def4a9d437d0a96595830cd235a',
  'sources/libheif-413e2a87.tar.gz': 'ef8e86a4e5670b7338a58b17553e306b8be88e506587b265dfdfe44495896999',
  'sources/libde265-1.0.15.tar.gz': '00251986c29d34d3af7117ed05874950c875dd9292d016be29d3b3762666511d',
  'libheif-js-1.23.5.LICENSE.txt': 'e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118',
  'libheif-413e2a87.COPYING.txt': 'fa81ce652315b013359d6e8e4744335f31a50c7c192907176d3632f78a3b4596',
  'libde265-1.0.15.COPYING.txt': '02cc1585a20677992e0ba578fa692635dc193735f2691dc81de924b51c4e8020',
}

interface DependencyManifest {
  dependencies?: Record<string, string>
  files?: string[]
}

interface DecoderLock {
  packages?: Record<string, { resolution?: { integrity?: string } }>
  snapshots?: Record<string, { dependencies?: Record<string, string> }>
}

/**
 * Match only the library release for which source and replacement materials ship.
 * @param dependency - Declared runtime identity and source pin.
 * @returns Whether the exact reviewed LGPL library release matches.
 */
export function isReviewedHeicRuntime(dependency: {
  name: string
  version?: string
  license: string
  sourceCommit?: string
}): boolean {
  const reviewed = HEIC_DECODER_DISTRIBUTION
  return dependency.name === reviewed.name && dependency.version === reviewed.version
    && dependency.license === reviewed.license && dependency.sourceCommit === reviewed.sourceCommit
}

/**
 * Require explicit, literal external modules without a competing inline rule.
 * @param source - Package-local tsdown configuration source.
 * @returns Whether both HEIC module identities remain external to application bundles.
 */
export function hasExternalHeicModules(source: string): boolean {
  const file = ts.createSourceFile('tsdown.config.ts', source, ts.ScriptTarget.Latest, true)
  const imported = file.statements.some(node => ts.isImportDeclaration(node)
    && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'tsdown'
    && node.importClause?.namedBindings !== undefined && ts.isNamedImports(node.importClause.namedBindings)
    && node.importClause.namedBindings.elements.some(element => element.name.text === 'defineConfig'
      && (element.propertyName === undefined || element.propertyName.text === 'defineConfig')))
  if (!imported) return false
  const exported = file.statements.find(ts.isExportAssignment)
  if (exported === undefined || exported.isExportEquals || !ts.isCallExpression(exported.expression)
    || !ts.isIdentifier(exported.expression.expression) || exported.expression.expression.text !== 'defineConfig') return false
  const config = exported.expression.arguments[0]
  if (config === undefined || !ts.isObjectLiteralExpression(config)) return false
  const externals = new Set<string>()
  let externalProperty = false
  for (const property of config.properties) {
    if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) return false
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined
    if (name === 'noExternal') return false
    if (name === 'external' && ts.isArrayLiteralExpression(property.initializer)) {
      if (externalProperty) return false
      externalProperty = true
      for (const entry of property.initializer.elements) if (ts.isStringLiteral(entry)) externals.add(entry.text)
    }
  }
  return ['heic-decode', 'libheif-js'].every(name => externals.has(name))
}

/**
 * Reject missing source archives, altered release bytes or an inline decoder.
 * @param repositoryRoot - Repository containing the locked dependencies and source materials.
 * @param browserPackages - Packages reached by shipped browser bundles.
 * @returns Verified source pin of the independently loaded LGPL library.
 */
export function assertHeicDecoderDistribution(repositoryRoot: string, browserPackages: ReadonlySet<string>): string {
  const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, PACKAGE, 'package.json'), 'utf8')) as DependencyManifest
  if (manifest.dependencies?.['libheif-js'] !== HEIC_DECODER_DISTRIBUTION.version
    || manifest.dependencies['heic-decode'] !== '2.1.0'
    || !manifest.files?.includes('third-party-notices/**')) {
    throw new Error('HEIC distribution: exact decoder dependencies and accompanying-source package files are required')
  }
  if (['heic-decode', 'libheif-js'].some(name => browserPackages.has(name))
    || !hasExternalHeicModules(readFileSync(resolve(repositoryRoot, PACKAGE, 'tsdown.config.ts'), 'utf8'))) {
    throw new Error('HEIC distribution: decoder modules must remain external to application and browser bundles')
  }
  const settings = load(readFileSync(resolve(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8')) as { overrides?: Record<string, string> }
  if (settings.overrides?.['heic-decode@2.1.0>libheif-js'] !== HEIC_DECODER_DISTRIBUTION.version) {
    throw new Error('HEIC distribution: the exact reviewed decoder dependency override is required')
  }
  const lock = load(readFileSync(resolve(repositoryRoot, 'pnpm-lock.yaml'), 'utf8')) as DecoderLock
  if (lock.packages?.['libheif-js@1.23.5']?.resolution?.integrity !== HEIC_DECODER_DISTRIBUTION.integrity
    || lock.snapshots?.['heic-decode@2.1.0']?.dependencies?.['libheif-js'] !== '1.23.5') {
    throw new Error('HEIC distribution: the lockfile must resolve the reviewed unmodified decoder bytes')
  }
  for (const [file, hash] of Object.entries(ACCOMPANYING_FILES)) {
    const actual = createHash('sha256').update(readFileSync(resolve(repositoryRoot, SOURCE_DIRECTORY, file))).digest('hex')
    if (actual !== hash) throw new Error(`HEIC distribution: accompanying source checksum mismatch: ${file}`)
  }
  for (const file of ['libheif-413e2a87.COPYING.txt', 'libde265-1.0.15.COPYING.txt']) {
    const notice = readFileSync(resolve(repositoryRoot, SOURCE_DIRECTORY, file), 'utf8')
    if (!notice.includes('GNU LESSER GENERAL PUBLIC LICENSE') || !notice.includes('GNU GENERAL PUBLIC LICENSE')) {
      throw new Error(`HEIC distribution: complete GPL and LGPL texts are required: ${file}`)
    }
  }
  for (const file of ['DISTRIBUTION.txt', 'relink-runtime.mjs', 'sources.json', 'libheif-js-1.23.5.LICENSE.txt']) {
    if (readFileSync(resolve(repositoryRoot, SOURCE_DIRECTORY, file)).byteLength === 0) {
      throw new Error(`HEIC distribution: missing replacement or licensing material: ${file}`)
    }
  }
  return HEIC_DECODER_DISTRIBUTION.sourceCommit
}
