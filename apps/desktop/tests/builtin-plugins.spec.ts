/** Desktop assistant-editor activation is offline, one-time and preserves user choices. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProfile, readProfileManifest, writeProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { afterEach, expect, it } from 'vitest'
import { initializeBuiltinPlugins } from '../src/builtin-plugins.ts'

const roots: string[] = []
function profile(): string {
  const root = mkdtempSync(join(tmpdir(), 'yunshu-builtin-plugins-'))
  roots.push(root)
  initProfile(root, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('activates the shipped editor once without package downloads or replacing profile data', () => {
  const root = profile()
  const patch = join(root, 'cordis.patch.yml')
  const lock = join(root, 'pnpm-lock.yaml')
  writeFileSync(patch, '# user configuration\n[]\n')
  writeFileSync(lock, 'user lock\n')
  initializeBuiltinPlugins(root)
  const first = readFileSync(join(root, 'package.json'), 'utf8')
  expect(readProfileManifest('test', root).dsh?.profile?.bundles).toEqual([
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-custom-mode',
  ])
  initializeBuiltinPlugins(root)
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(first)
  expect(readFileSync(patch, 'utf8')).toBe('# user configuration\n[]\n')
  expect(readFileSync(lock, 'utf8')).toBe('user lock\n')
})

it('does not duplicate an already selected editor and preserves its pinned dependency', () => {
  const root = profile()
  const manifest = readProfileManifest('test', root)
  writeProfileManifest(root, {
    ...manifest, dependencies: { 'dsh-custom-mode': '2.2.4' },
    dsh: { profile: { bundles: [...manifest.dsh!.profile!.bundles!, 'dsh-custom-mode'] } },
  })
  const before = readFileSync(join(root, 'package.json'), 'utf8')
  initializeBuiltinPlugins(root)
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before)
})

it('respects an existing installation that the user disabled', () => {
  const root = profile()
  const manifest = readProfileManifest('test', root)
  writeProfileManifest(root, { ...manifest, dependencies: { 'dsh-custom-mode': '2.2.5' } })
  initializeBuiltinPlugins(root)
  expect(readProfileManifest('test', root).dsh?.profile?.bundles).not.toContain('dsh-custom-mode')
})

it('does not re-enable the editor after recovery or a later user opt-out', () => {
  const root = profile()
  initializeBuiltinPlugins(root)
  const manifest = readProfileManifest('test', root)
  writeProfileManifest(root, { ...manifest, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } })
  initializeBuiltinPlugins(root)
  expect(readProfileManifest('test', root).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
})

it('reports invalid profile data without recording a completed activation', () => {
  const root = profile()
  writeFileSync(join(root, 'package.json'), '{broken')
  expect(() => { initializeBuiltinPlugins(root) }).toThrow()
  const receipt = join(root, '.yunshu-builtin-plugins-v1.json')
  expect(() => readFileSync(receipt)).toThrow()
})

it('does not rewrite a malformed bundle list', () => {
  const root = profile()
  const path = join(root, 'package.json')
  const invalid = '{"dsh":{"profile":{"bundles":"not-a-list"}}}\n'
  writeFileSync(path, invalid)
  expect(() => { initializeBuiltinPlugins(root) }).toThrow('profile bundles must be a list')
  expect(readFileSync(path, 'utf8')).toBe(invalid)
})
