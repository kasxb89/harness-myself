import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ensureSkillHubCli } from '../src/skillhub-cache.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'yunshu-skillhub-cache-')) })
afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }) })

it('rejects unexpected archive bytes and preserves an existing invalid cache for inspection', async () => {
  await mkdir(join(root, '2026.8.5'))
  await writeFile(join(root, '2026.8.5', 'skills_store_cli.py'), 'existing altered source')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('unexpected source')))
  await expect(ensureSkillHubCli(root, new AbortController().signal, 1024)).rejects.toThrow('checksum mismatch')
  expect(await readFile(join(root, '2026.8.5', 'skills_store_cli.py'), 'utf8')).toBe('existing altered source')
  expect(await readdir(root)).toEqual(['2026.8.5'])
})
it('bounds downloads and removes its private temporary directory', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('too large')))
  await expect(ensureSkillHubCli(root, new AbortController().signal, 2)).rejects.toThrow('too large')
  expect(await readdir(root)).toEqual([])
})
it('fails visibly for unsuccessful downloads', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
  await expect(ensureSkillHubCli(root, new AbortController().signal, 1024)).rejects.toThrow('download failed')
  expect(await readdir(root)).toEqual([])
})
