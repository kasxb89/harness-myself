/** Real filesystem batches and the fixed Node wrapper mock only the external public Kit engine. */
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RenderImagesRequest } from '@deepseek-ai/libreoffice-kit'
import { invalidateOfficeRenderCache, renderOfficeBatch, type OfficeRenderCacheConfig, type OfficeRenderRuntime } from '../src/render-cache.ts'

const roots: string[] = []
const digest = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')
const bytes = Buffer.from('local-fake-png')
const signal = (): AbortSignal => new AbortController().signal
const sourceModule = fileURLToPath(new URL('../src/render-cache.ts', import.meta.url))
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'office-batch-cache-'))
  roots.push(root)
  await mkdir(join(root, 'fonts'))
  await writeFile(join(root, 'fonts', 'test.ttf'), 'font-one')
  const inputPath = join(root, 'source.docx')
  await writeFile(inputPath, 'saved-document-one')
  const fontInventoryPath = join(root, 'font-inventory.json')
  const inventory = async () => { await writeFile(fontInventoryPath, JSON.stringify({ schemaVersion: 1, complete: true,
    platform: process.platform, roots: [join(root, 'fonts')],
    files: [{ path: join(root, 'fonts', 'test.ttf'), sha256: digest(await readFile(join(root, 'fonts', 'test.ttf'))) }],
  })) }
  await inventory()
  const config: OfficeRenderCacheConfig = { kitCli: join(root, 'kit', 'cli.js'), cacheDirectory: join(root, 'cache'),
    ttlMs: 60_000, maxCacheBytes: 100_000, fontInventoryPath }
  const dispose = vi.fn(async () => {})
  const renderImages = vi.fn(async (request: RenderImagesRequest, activeSignal?: AbortSignal) => {
    activeSignal?.throwIfAborted()
    await mkdir(request.outputDir)
    const pages = request.pages === undefined || request.pages === 'all' ? [1, 2, 3] : request.pages
    const images = []
    for (const [index, page] of pages.entries()) {
      const path = join(request.outputDir, `page-${String(page)}.png`)
      await writeFile(path, bytes)
      images.push({ index, page, path, width: 20, height: 10, rectangle: { x: 0, y: 0, width: 20, height: 10 }, byteLength: bytes.length })
    }
    return { schemaVersion: 1 as const, backend: 'native' as const, rasterEngine: 'libreoffice' as const,
      source: 'saved' as const, inputPath: request.inputPath, sourceSha256: digest(await readFile(request.inputPath)),
      dpi: request.dpi ?? 144, pageCount: 3, images, missingFonts: [] }
  })
  const create = vi.fn(async () => ({ renderImages, dispose }))
  const runtime: OfficeRenderRuntime = { engineIdentity: 'kit-test-engine-one', create }
  const request = (name: string, changes: Partial<RenderImagesRequest> = {}): RenderImagesRequest => ({
    inputPath, outputDir: join(root, name), pages: [1, 3], dpi: 144, ...changes,
  })
  return { root, inputPath, config, inventory, runtime, create, renderImages, dispose, request }
}

describe('one-shot batched Office render cache', () => {
  it('renders relevant pages together once, then reuses identical saved bytes and settings into a fresh exclusive directory', async () => {
    const f = await setup()
    const first = await renderOfficeBatch(f.request('first'), f.config, signal(), f.runtime)
    const second = await renderOfficeBatch(f.request('second'), f.config, signal(), f.runtime)
    expect(first.cacheHit).toBe(false)
    expect(second.cacheHit).toBe(true)
    expect(f.renderImages).toHaveBeenCalledOnce()
    expect(f.renderImages.mock.calls[0]?.[0].pages).toEqual([1, 3])
    expect(f.dispose).toHaveBeenCalledOnce()
    expect(second.images.map(image => image.page)).toEqual([1, 3])
    expect(await readFile(second.images[0]!.path)).toEqual(bytes)
    expect(JSON.parse(await readFile(join(f.root, 'second', 'manifest.json'), 'utf8'))).toMatchObject({ cacheHit: true, inputPath: f.inputPath })
    await expect(renderOfficeBatch(f.request('second'), f.config, signal(), f.runtime)).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    expect(await readFile(f.inputPath, 'utf8')).toBe('saved-document-one')
  })

  it('invalidates when file bytes, selected pages, DPI, engine or verified font inventory change', async () => {
    const f = await setup()
    await renderOfficeBatch(f.request('a'), f.config, signal(), f.runtime)
    await writeFile(f.inputPath, 'saved-document-two')
    await renderOfficeBatch(f.request('b'), f.config, signal(), f.runtime)
    await renderOfficeBatch(f.request('c', { pages: [2] }), f.config, signal(), f.runtime)
    await renderOfficeBatch(f.request('d', { dpi: 192 }), f.config, signal(), f.runtime)
    await renderOfficeBatch(f.request('e'), f.config, signal(), { ...f.runtime, engineIdentity: 'kit-test-engine-two' })
    await writeFile(join(f.root, 'fonts', 'test.ttf'), 'font-two')
    await f.inventory()
    await renderOfficeBatch(f.request('f'), f.config, signal(), f.runtime)
    expect(f.create).toHaveBeenCalledTimes(6)
    expect(f.dispose).toHaveBeenCalledTimes(6)
  })

  it('does not cache when the complete font inventory is missing, changed or unverifiable', async () => {
    const f = await setup()
    const { fontInventoryPath: _inventory, ...unverified } = f.config
    expect((await renderOfficeBatch(f.request('a'), unverified, signal(), f.runtime)).cacheStatus).toBe('unverified-fonts')
    await renderOfficeBatch(f.request('b'), unverified, signal(), f.runtime)
    await writeFile(join(f.root, 'fonts', 'new-font.otf'), 'another-font')
    expect((await renderOfficeBatch(f.request('c'), f.config, signal(), f.runtime)).cacheStatus).toBe('unverified-fonts')
    await renderOfficeBatch(f.request('d'), f.config, signal(), f.runtime)
    expect(f.create).toHaveBeenCalledTimes(4)
    await expect(readdir(f.config.cacheDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps rendering when cache storage is unavailable and bounds the source snapshot before starting an engine', async () => {
    const f = await setup()
    await writeFile(f.config.cacheDirectory, 'not-a-directory')
    expect((await renderOfficeBatch(f.request('fresh'), f.config, signal(), f.runtime)).cacheStatus).toBe('disabled')
    expect(f.create).toHaveBeenCalledOnce()
    await expect(renderOfficeBatch(f.request('oversized'), { ...f.config, converterOptions: { maxInputBytes: 1 } }, signal(), f.runtime))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    expect(f.create).toHaveBeenCalledOnce()
    expect(await readFile(f.inputPath, 'utf8')).toBe('saved-document-one')
  })

  it('merges concurrent identical cacheable page batches without publishing partial outputs', async () => {
    const f = await setup()
    const ready = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const actualRender = f.renderImages.getMockImplementation()!
    f.renderImages.mockImplementation(async (request, activeSignal) => {
      ready.resolve(undefined); await gate.promise
      return await actualRender(request, activeSignal)
    })
    const first = renderOfficeBatch(f.request('first'), f.config, signal(), f.runtime)
    await ready.promise
    const second = renderOfficeBatch(f.request('second'), f.config, signal(), f.runtime)
    await expect(readFile(join(f.root, 'first', 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    gate.resolve(undefined)
    const results = await Promise.all([first, second])
    expect(results.map(result => result.cacheHit)).toEqual([false, true])
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.dispose).toHaveBeenCalledOnce()
  })

  it('a cancelled waiting reader does not cancel the owner or poison the subsequent cache', async () => {
    const f = await setup()
    const ready = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const actualRender = f.renderImages.getMockImplementation()!
    f.renderImages.mockImplementation(async (request, activeSignal) => {
      ready.resolve(undefined); await gate.promise
      return await actualRender(request, activeSignal)
    })
    const first = renderOfficeBatch(f.request('first'), f.config, signal(), f.runtime)
    await ready.promise
    const cancel = new AbortController()
    const second = renderOfficeBatch(f.request('cancelled'), f.config, cancel.signal, f.runtime)
    cancel.abort()
    await expect(second).rejects.toThrow()
    gate.resolve(undefined)
    await first
    expect((await renderOfficeBatch(f.request('last'), f.config, signal(), f.runtime)).cacheHit).toBe(true)
    expect(f.create).toHaveBeenCalledOnce()
    await expect(readdir(join(f.root, 'cancelled'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('a cancelled owner awaits engine disposal and cannot publish a partial cache or output', async () => {
    const f = await setup()
    const ready = Promise.withResolvers<undefined>()
    const drained = Promise.withResolvers<undefined>()
    const cleanup = Promise.withResolvers<undefined>()
    f.renderImages.mockImplementation(async (_request, activeSignal) => {
      ready.resolve(undefined)
      await new Promise<void>((_resolve, reject) => { activeSignal?.addEventListener('abort', () => { reject(new Error('render stopped')) }, { once: true }) })
      throw new Error('unreachable')
    })
    f.dispose.mockImplementation(async () => { drained.resolve(undefined); await cleanup.promise })
    const cancel = new AbortController()
    let settled = false
    const task = renderOfficeBatch(f.request('cancelled'), f.config, cancel.signal, f.runtime)
    const observed = task.catch((error: unknown) => { settled = true; throw error })
    await ready.promise
    cancel.abort()
    await drained.promise
    expect(settled).toBe(false)
    cleanup.resolve(undefined)
    await expect(observed).rejects.toThrow('render stopped')
    expect((await readdir(f.config.cacheDirectory)).filter(name => /^[a-f0-9]{64}$/u.test(name))).toEqual([])
    await expect(readdir(join(f.root, 'cancelled'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not cache engine errors, corrupted cache bytes, expired entries or results from a future wall clock', async () => {
    const f = await setup()
    const actualRender = f.renderImages.getMockImplementation()!
    f.renderImages.mockRejectedValueOnce(new Error('engine failed'))
    await expect(renderOfficeBatch(f.request('bad'), f.config, signal(), f.runtime)).rejects.toThrow('engine failed')
    await renderOfficeBatch(f.request('good'), f.config, signal(), f.runtime)
    const key = (await readdir(f.config.cacheDirectory)).find(name => /^[a-f0-9]{64}$/u.test(name))!
    await writeFile(join(f.config.cacheDirectory, key, '0.png'), 'corrupt')
    await renderOfficeBatch(f.request('repaired'), f.config, signal(), f.runtime)
    const realNow = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(realNow + f.config.ttlMs)
    await renderOfficeBatch(f.request('expired'), f.config, signal(), f.runtime)
    vi.mocked(Date.now).mockReturnValue(realNow)
    await renderOfficeBatch(f.request('rollback'), f.config, signal(), f.runtime)
    expect(actualRender).toBeDefined()
    expect(f.create).toHaveBeenCalledTimes(5)
  })

  it('keeps the disk byte budget and explicit invalidation prevents old producers repopulating the new generation', async () => {
    const f = await setup()
    const config = { ...f.config, maxCacheBytes: 2000 }
    await renderOfficeBatch(f.request('first'), config, signal(), f.runtime)
    const ready = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const actualRender = f.renderImages.getMockImplementation()!
    f.renderImages.mockImplementationOnce(async (request, activeSignal) => {
      ready.resolve(undefined); await gate.promise
      return await actualRender(request, activeSignal)
    })
    const pending = renderOfficeBatch(f.request('old-producer', { pages: [2] }), config, signal(), f.runtime)
    await ready.promise
    await invalidateOfficeRenderCache(config)
    gate.resolve(undefined)
    await pending
    expect((await readdir(config.cacheDirectory)).filter(name => /^[a-f0-9]{64}$/u.test(name))).toEqual([])
    await renderOfficeBatch(f.request('after-invalidate'), config, signal(), f.runtime)
    await renderOfficeBatch(f.request('other', { pages: [2] }), config, signal(), f.runtime)
    let retained = 0
    for (const name of await readdir(config.cacheDirectory)) {
      if (!/^[a-f0-9]{64}$/u.test(name)) continue
      for (const file of await readdir(join(config.cacheDirectory, name))) {
        retained += (await readFile(join(config.cacheDirectory, name, file))).length
      }
    }
    expect(retained).toBeLessThanOrEqual(config.maxCacheBytes)
    expect(await readFile(f.inputPath, 'utf8')).toBe('saved-document-one')
  })
})

describe('fixed Office renderer Node entry', () => {
  it('consumes the public kit API once for all requested pages through the shipped wrapper', async () => {
    const f = await setup()
    const scripts = join(f.root, 'assets', 'scripts')
    await mkdir(scripts, { recursive: true })
    await mkdir(join(f.root, 'lib'))
    await mkdir(join(f.root, 'kit'))
    await writeFile(join(f.root, 'package.json'), '{"type":"module"}')
    await writeFile(join(f.root, 'lib', 'render-cache.js'), `export { renderOfficeBatch, invalidateOfficeRenderCache } from ${JSON.stringify(pathToFileURL(sourceModule).href)};`)
    const wrapper = join(scripts, 'render_office.mjs')
    await cp(fileURLToPath(new URL('../assets/scripts/render_office.mjs', import.meta.url)), wrapper)
    await writeFile(f.config.kitCli, '/* configured kit CLI identity */')
    await writeFile(join(f.root, 'kit', 'index.js'), `
import {mkdir,readFile,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export const ENGINE_VERSION='test-1'; export const ENGINE_VERSIONS={native:'test-1'};
export async function discoverRuntime(){return {version:'test-1',backend:'native'}}
export async function createConverter(){return {
 async renderImages(r){
  await appendFile(${JSON.stringify(join(f.root, 'calls'))},JSON.stringify(r.pages)+'\\n'); await mkdir(r.outputDir);
  const b=Buffer.from('complete-test-image'); const images=[];
  for(const [index,page] of r.pages.entries()){const path=join(r.outputDir,String(page)+'.png'); await writeFile(path,b);
   images.push({index,page,path,width:20,height:10,rectangle:{x:0,y:0,width:20,height:10},byteLength:b.length});}
  return {schemaVersion:1,backend:'native',rasterEngine:'libreoffice',source:'saved',inputPath:r.inputPath,
   sourceSha256:createHash('sha256').update(await readFile(r.inputPath)).digest('hex'),dpi:r.dpi,pageCount:3,images,missingFonts:[]};
 },async dispose(){await appendFile(${JSON.stringify(join(f.root, 'disposed'))},'yes\\n')}
}}`)
    const result = await execa(process.execPath, [wrapper, '--api', join(f.root, 'lib', 'render-cache.js'), '--cli', f.config.kitCli, '--input', f.inputPath,
      '--output-dir', join(f.root, 'wrapper-output'), '--pages', '1,3', '--dpi', '144'])
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, cacheHit: false, cacheStatus: 'unverified-fonts',
      images: [{ page: 1 }, { page: 3 }] })
    expect(await readFile(join(f.root, 'calls'), 'utf8')).toBe('[1,3]\n')
    expect(await readFile(join(f.root, 'disposed'), 'utf8')).toBe('yes\n')
    expect(await readFile(f.inputPath, 'utf8')).toBe('saved-document-one')
    const cachedArgs = [wrapper, '--api', join(f.root, 'lib', 'render-cache.js'), '--cli', f.config.kitCli, '--input', f.inputPath, '--pages', '1,3', '--dpi', '144',
      '--cache-dir', f.config.cacheDirectory, '--cache-ttl-ms', '60000', '--cache-max-bytes', '100000',
      '--font-inventory', f.config.fontInventoryPath!]
    await execa(process.execPath, [...cachedArgs, '--output-dir', join(f.root, 'wrapper-cache-one')])
    const hit = await execa(process.execPath, [...cachedArgs, '--output-dir', join(f.root, 'wrapper-cache-two')])
    expect(JSON.parse(hit.stdout)).toMatchObject({ ok: true, cacheHit: true, images: [{ page: 1 }, { page: 3 }] })
    expect(await readFile(join(f.root, 'calls'), 'utf8')).toBe('[1,3]\n[1,3]\n')
    const invalidated = await execa(process.execPath, [wrapper, '--api', join(f.root, 'lib', 'render-cache.js'), '--cli', f.config.kitCli,
      '--cache-dir', f.config.cacheDirectory, '--invalidate-cache'])
    expect(JSON.parse(invalidated.stdout)).toEqual({ ok: true, invalidated: true })
  })
})
