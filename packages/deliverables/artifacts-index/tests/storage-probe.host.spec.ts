/** Real filesystem preflight with injected unsupported exclusive-link failures. */
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ArtifactStore } from '../src/storage.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, link: vi.fn(original.link) }
})

const fixtures: { ctx: Context; directory: string }[] = []
afterEach(async () => {
  vi.mocked(link).mockReset()
  for (const { ctx, directory } of fixtures.splice(0)) {
    try { await ctx.fiber.dispose() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
})

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'artifacts-probe-')))
  const ctx = new Context()
  fixtures.push({ ctx, directory })
  const output = join(directory, 'output')
  const state = join(directory, 'private-state')
  const selected = join(directory, 'selected')
  await mkdir(selected)
  const store = await ArtifactStore.create(ctx, output, state, [])
  await store.setDirectory(selected, 0, new AbortController().signal)
  await writeFile(join(selected, 'user.txt'), 'keep original')
  return { store, output, state, selected }
}

it('refuses unsupported exclusive publication before capture, resume validation, or changing persisted preferences', async () => {
  const f = await fixture()
  const preferences = f.store.info()
  const persisted = await readFile(join(f.state, 'storage.json'), 'utf8')
  const unsupported = () => Object.assign(new Error('Filesystem cannot create hard links'), { code: 'ENOTSUP' })
  vi.mocked(link).mockRejectedValueOnce(unsupported())
  await expect(f.store.capture(new AbortController().signal)).rejects.toMatchObject({ code: 'ARTIFACT_MOVE_UNSUPPORTED' })
  vi.mocked(link).mockRejectedValueOnce(unsupported())
  await expect(f.store.validate({ directory: f.selected }, new AbortController().signal)).rejects.toMatchObject({ code: 'ARTIFACT_MOVE_UNSUPPORTED' })
  vi.mocked(link).mockRejectedValueOnce(unsupported())
  await expect(f.store.setDirectory(f.output, preferences.revision, new AbortController().signal)).rejects.toMatchObject({ code: 'ARTIFACT_MOVE_UNSUPPORTED' })
  expect(f.store.info()).toEqual(preferences)
  expect(await readFile(join(f.state, 'storage.json'), 'utf8')).toBe(persisted)
  expect(await readFile(join(f.selected, 'user.txt'), 'utf8')).toBe('keep original')
  expect(await readdir(f.selected)).toEqual(['user.txt'])
  expect(await readdir(f.output)).toEqual([])
})

it('cleans its own source probe while preserving an occupied link destination', async () => {
  const f = await fixture()
  let occupied: string | undefined
  vi.mocked(link).mockImplementationOnce(async (_source, target) => {
    if (typeof target !== 'string') throw new Error('Expected string probe destination')
    occupied = target
    await writeFile(target, 'unrelated file', { flag: 'wx' })
    throw Object.assign(new Error('File exists'), { code: 'EEXIST' })
  })
  await expect(f.store.capture(new AbortController().signal)).rejects.toMatchObject({ code: 'ARTIFACT_MOVE_UNSUPPORTED' })
  if (occupied === undefined) throw new Error('Missing occupied probe path')
  expect(await readFile(occupied, 'utf8')).toBe('unrelated file')
  expect((await readdir(f.selected)).sort()).toEqual([basename(occupied), 'user.txt'].sort())
  expect(await readFile(join(f.selected, 'user.txt'), 'utf8')).toBe('keep original')
})
