import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Credits from '../src/index.ts'

let context: Context | undefined
let root: string | undefined
let source: Server | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (source !== undefined) await new Promise<void>((resolve, reject) => {
    source?.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
    source?.closeAllConnections()
  })
  source = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('usage HTTP routes through the real Loader', () => {
  it('serves current-account usage, validates selectors, and removes the route on disposal', async () => {
    const start = 1_792_000_800
    const end = start + 86_399
    const upstreamCalls: string[] = []
    source = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      upstreamCalls.push(url.pathname)
      let body: unknown
      if (url.pathname === '/harness/api/user/self') body = { success: true, data: { id: 7 } }
      else if (url.pathname === '/harness/api/log/self') body = {
        success: true,
        data: { page: 1, page_size: 100, total: 1, items: [{
          id: 1, type: 2, user_id: 7, created_at: start, model_name: 'chat-model',
          quota: 10, prompt_tokens: 100, completion_tokens: 25, other: '{}',
        }] },
      }
      else if (url.pathname === '/harness/api/status') body = { success: true, data: { quota_per_unit: 500_000, usd_exchange_rate: 7.3 } }
      else { response.writeHead(404); response.end(); return }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(body))
    })
    await new Promise<void>(resolve => source?.listen(0, '127.0.0.1', resolve))
    const address = source.address()
    if (address === null || typeof address === 'string') throw new Error('missing source port')
    root = await mkdtemp(join(tmpdir(), 'dsh-usage-loader-'))
    const stateDir = join(root, 'credits')
    await mkdir(stateDir)
    await writeFile(join(stateDir, 'session.json'), JSON.stringify({
      token: 'product-session', expiresAt: '9999-01-01T00:00:00.000Z',
      account: { id: '7', phone: '+8613800000000' }, upstream: { token: 'user-token' },
    }), { mode: 0o600 })
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:', "    host: '127.0.0.1'", '    port: 0',
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-credits-index'",
      '  config:', `    stateDir: '${stateDir}'`,
      `    newApiBaseUrl: 'http://127.0.0.1:${String(address.port)}/harness'`,
      '    timeoutMs: 1000', '',
    ].join('\n'))
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', Tools], ['@deepseek-ai/dsh-credits-index', Credits],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    const base = `http://127.0.0.1:${String(context.webServer.port)}`
    const route = `${base}/credits/api/usage?start=${String(start)}&end=${String(end)}`
    const result = await fetch(route)
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(await result.json()).toMatchObject({
      ok: true,
      payload: { start, end, delayMinutes: 0, rows: [{ timestamp: start, model: 'chat-model', billingRecords: 1, consumedPoints: 0.146, totalTokens: 125 }] },
    })
    expect(upstreamCalls).toEqual(['/harness/api/user/self', '/harness/api/status', '/harness/api/log/self'])
    expect(await (await fetch(`${route}&userId=8`)).json()).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect((await fetch(route, { headers: { origin: 'https://untrusted.example' } })).status).toBe(403)
    const fiber = [...context.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-credits-index')?.fiber
    expect(fiber).toBeDefined()
    await fiber?.dispose()
    expect((await fetch(route)).status).toBe(404)
  })
})
