// @vitest-environment jsdom
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Creation from '../src/client/index.ts'
import type { CreationContent } from '../src/client/types.ts'

let ctx: Context | undefined
let directory: string | undefined
let requestSignal: AbortSignal | undefined
const emptyMode = () => ({ title: { zh: '' }, description: { zh: '' }, promptPlaceholder: { zh: '' }, categories: [], templates: [], presets: [] })
const content = (revision: string): CreationContent => ({ schemaVersion: 1, revision, image: emptyMode(), video: emptyMode() })

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
  requestSignal = undefined
  vi.unstubAllGlobals()
})

async function boot(): Promise<Context> {
  directory = await mkdtemp(join(tmpdir(), 'dsh-creation-content-client-'))
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, "- name: '@deepseek-ai/dsh-client-creation-content'\n  config:\n    refreshIntervalMs: 300000\n    timeoutMs: 1000\n")
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
      if (specifier !== '@deepseek-ai/dsh-client-creation-content') throw new Error(`Unexpected import ${specifier}`)
      return Creation
    },
  } as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  await ctx.creationContent.refresh()
  return ctx
}

function response(value: unknown): Response {
  return new Response(JSON.stringify({ ok: true, payload: value }), { headers: { 'content-type': 'application/json' } })
}

describe('creation publications through the real Client Loader', () => {
  it('shares published updates, retains last content on errors and recovers to an empty publication', async () => {
    const first = content('one')
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(first))
    vi.stubGlobal('fetch', fetcher)
    const context = await boot()
    const source = context.creationContent
    expect(source.getSnapshot()).toEqual({ status: 'ready', content: first })
    expect(fetcher).toHaveBeenCalledWith('/credits/api/creation/content', expect.objectContaining({ credentials: 'same-origin', redirect: 'error' }))
    const stable = source.getSnapshot()
    fetcher.mockResolvedValue(response(first))
    await source.refresh()
    expect(source.getSnapshot()).toBe(stable)
    const listener = vi.fn()
    source.subscribe(listener)
    const updated = { ...content('two'), image: { ...emptyMode(), templates: [{
      id: 'real-template', categoryId: null, title: { zh: '管理员上传', en: 'Uploaded by administrator' }, description: { zh: '真实内容' }, prompt: { zh: '暖色产品摄影' },
      coverAssetId: 'cc_' + 'a'.repeat(64), demoVideoAssetId: null, sortOrder: 1, status: 'published',
    }, {
      id: 'draft-template', categoryId: null, title: { zh: '草稿' }, description: { zh: '' }, prompt: { zh: '' }, coverAssetId: null, demoVideoAssetId: null, sortOrder: 2, status: 'draft',
    }] } }
    fetcher.mockResolvedValue(response(updated))
    await source.refresh()
    expect(source.getSnapshot().content?.image.templates.map(row => row.id)).toEqual(['real-template'])
    expect(listener).toHaveBeenCalledTimes(1)
    fetcher.mockResolvedValue(response({ ...updated, schemaVersion: 2 }))
    await source.refresh()
    expect(source.getSnapshot().status).toBe('error')
    expect(source.getSnapshot().content?.revision).toBe('two')
    fetcher.mockResolvedValue(response(content('three')))
    await source.refresh()
    expect(source.getSnapshot()).toEqual({ status: 'ready', content: content('three') })
  })

  it('coalesces concurrent reads and awaits cancellation on plugin disposal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(content('one')))
    vi.stubGlobal('fetch', fetcher)
    const context = await boot()
    fetcher.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined
      requestSignal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    }))
    const listener = vi.fn()
    context.creationContent.subscribe(listener)
    const pending = context.creationContent.refresh()
    expect(context.creationContent.refresh()).toBe(pending)
    const fiber = [...context.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-client-creation-content')?.fiber
    await fiber?.dispose()
    await pending
    expect(requestSignal?.aborted).toBe(true)
    expect(listener).not.toHaveBeenCalled()
  })
})
