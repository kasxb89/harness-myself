/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver and frontend-static rows, and every
 * assertion observes the served HTTP surface — asset serving, explicit index
 * entry points with index taps, 404 misses, traversal rejection, 405 on non-
 * GET/HEAD, and seat release on fiber disposal (HMR safety).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as FrontendStatic from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a dist fixture and the authenticated Web rows, then boot them through the real Loader. */
async function loadComposition(media = false): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-frontend-static-'))
  const dist = join(root, 'dist')
  await mkdir(dist)
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, '<head></head><body>shell</body>')
  await writeFile(join(dist, 'app.js'), 'export {}')
  await writeFile(join(dist, 'blob.bin'), 'BLOB')
  await writeFile(join(dist, 'manifest.webmanifest'), '{}')
  if (media) {
    await writeFile(join(dist, 'cover.png'), await readFile(new URL('../../../llm/llm-deepseek/tests/fixtures/red.png', import.meta.url)))
    await writeFile(join(dist, 'clip.mp4'), await readFile(new URL('../../../../apps/web/tests/fixtures/sidebar-media/preview.mp4', import.meta.url)))
    await writeFile(join(dist, 'empty.mp4'), '')
  }
  await mkdir(join(dist, 'empty'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: '${join(root, '.credentials.yaml')}'`,
    '    watch: false',
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-client-connection'",
    '- id: frontend',
    "  name: '@deepseek-ai/dsh-host-frontend-static'",
    '  config:',
    `    distIndex: '${distIndex}'`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-credentials-local', LocalCredentials],
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-client-connection', Connection],
    ['@deepseek-ai/dsh-host-frontend-static', FrontendStatic],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** GET (by default) one path against the running server; returns status, content-type, and the body. */
async function request(port: number, path: string, init?: RequestInit): Promise<{ status: number; type: string | null; body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    body: await response.text(),
  }
}

describe('real Loader composition', () => {
  it('serves media with its MIME type and explicit byte length while HEAD omits bytes', async () => {
    const loaded = await loadComposition(true)
    for (const [file, type] of [['cover.png', 'image/png'], ['clip.mp4', 'video/mp4']] as const) {
      const bytes = await readFile(join(root!, 'dist', file))
      const url = `http://127.0.0.1:${String(loaded.webServer.port)}/${file}`
      const get = await fetch(url)
      expect(get.status).toBe(200)
      expect(get.headers.get('content-type')).toBe(type)
      expect(get.headers.get('content-length')).toBe(String(bytes.length))
      expect(get.headers.get('accept-ranges')).toBe('bytes')
      expect(Buffer.from(await get.arrayBuffer())).toEqual(bytes)
      const head = await fetch(url, { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(head.headers.get('content-type')).toBe(type)
      expect(head.headers.get('content-length')).toBe(String(bytes.length))
      expect(await head.text()).toBe('')
    }
    const origin = `http://127.0.0.1:${String(loaded.webServer.port)}`
    expect((await fetch(origin + '/', { headers: { range: 'bytes=0-31' } })).status).toBe(401)
    const script = await fetch(origin + '/app.js', { headers: { range: 'bytes=0-1' } })
    expect(script.status).toBe(200)
    expect(script.headers.get('content-range')).toBeNull()
    expect(script.headers.get('accept-ranges')).toBeNull()
    expect(await script.text()).toBe('export {}')
  })

  it('serves exact media prefix, suffix and open-ended ranges for GET and HEAD', async () => {
    const loaded = await loadComposition(true)
    const bytes = await readFile(join(root!, 'dist', 'clip.mp4'))
    const url = `http://127.0.0.1:${String(loaded.webServer.port)}/clip.mp4`
    for (const [range, start, end] of [
      ['bytes=0-31', 0, 31],
      ['bytes=8-', 8, bytes.length - 1],
      ['bytes=-32', bytes.length - 32, bytes.length - 1],
      [`bytes=0-${String(bytes.length + 50)}`, 0, bytes.length - 1],
      [`bytes=-${String(bytes.length + 50)}`, 0, bytes.length - 1],
    ] as const) {
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(url, { method, headers: { range } })
        expect(response.status).toBe(206)
        expect(response.headers.get('content-type')).toBe('video/mp4')
        expect(response.headers.get('accept-ranges')).toBe('bytes')
        expect(response.headers.get('content-range')).toBe(`bytes ${String(start)}-${String(end)}/${String(bytes.length)}`)
        expect(response.headers.get('content-length')).toBe(String(end - start + 1))
        expect(Buffer.from(await response.arrayBuffer())).toEqual(method === 'GET' ? bytes.subarray(start, end + 1) : Buffer.alloc(0))
      }
    }
  })

  it('rejects invalid or unsatisfiable media ranges without returning the complete file', async () => {
    const loaded = await loadComposition(true)
    const bytes = await readFile(join(root!, 'dist', 'clip.mp4'))
    const url = `http://127.0.0.1:${String(loaded.webServer.port)}`
    for (const range of ['', 'bytes=', 'bytes=0-1,4-5', 'bytes=9-4', 'bytes=-0', `bytes=${String(bytes.length)}-`, 'bytes=9007199254740992-']) {
      const response = await fetch(url + '/clip.mp4', { headers: { range } })
      expect(response.status).toBe(416)
      expect(response.headers.get('content-range')).toBe(`bytes */${String(bytes.length)}`)
      expect(response.headers.get('content-length')).toBe('0')
      expect(await response.text()).toBe('')
    }
    const empty = await fetch(url + '/empty.mp4', { headers: { range: 'bytes=0-0' } })
    expect(empty.status).toBe(416)
    expect(empty.headers.get('content-range')).toBe('bytes */0')
    expect(await empty.text()).toBe('')
  })

  it('serves explicit index entries and files while preserving HTTP error semantics', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    const server = loaded.webServer
    const port = server.port
    const launchUrl = loaded.connection.authenticatedUrl(`http://127.0.0.1:${String(port)}`)
    const exchange = await fetch(launchUrl, { redirect: 'manual' })
    expect(exchange.status).toBe(303)
    expect(exchange.headers.get('location')).toBe('./')
    const setCookie = exchange.headers.get('set-cookie')
    if (setCookie === null) throw new Error('authenticated frontend did not set a cookie')
    const cookie = setCookie.split(';', 1)[0]!
    const authenticated = (init?: RequestInit): RequestInit => {
      const headers = new Headers(init?.headers)
      headers.set('cookie', cookie)
      return { ...init, headers }
    }

    expect(await request(port, '/')).toMatchObject({
      status: 401,
      type: 'text/plain; charset=utf-8',
      body: 'dsh web authentication required; reopen the URL printed by dsh web.\n',
    })

    // Real assets with their MIME types; a live rebuild is served on the next read.
    expect(await request(port, '/app.js')).toMatchObject({ status: 200, type: 'text/javascript; charset=utf-8', body: 'export {}' })
    expect(await request(port, '/manifest.webmanifest')).toMatchObject({
      status: 200,
      type: 'application/manifest+json',
      body: '{}',
    })
    expect(await request(port, '/app.js', { method: 'HEAD' })).toEqual({
      status: 200,
      type: 'text/javascript; charset=utf-8',
      body: '',
    })
    await writeFile(join(root!, 'dist', 'app.js'), 'export const rebuilt = true')
    expect(await request(port, '/app.js')).toMatchObject({ status: 200, body: 'export const rebuilt = true' })

    // Unknown extension ships as octet-stream.
    expect(await request(port, '/blob.bin')).toMatchObject({ status: 200, type: 'application/octet-stream', body: 'BLOB' })

    // Only the root and index path render index.html through registered taps.
    const untap = server.tapIndex(html => html.replace('<head>', '<head><script>window.__T__=1</script>'))
    // A plugin row stands in for the Host's plugin-resource rows: the base the
    // shell inserts must precede it, not merely exist.
    const offRows = loaded.on('webserver/index-inject', (rows) => {
      rows.push({ kind: 'script-preload', src: 'plugins/boot.js' })
    })
    for (const path of ['/', '/index.html', '/?view=test']) {
      const got = await request(port, path, authenticated())
      expect(got.status).toBe(200)
      expect(got.type).toBe('text/html; charset=utf-8')
      expect(got.body).toContain('__T__')
      expect(got.body).toContain('shell')
      // The served document carries the entry-directory base exactly once, and
      // it precedes every injected row and tap markup, so the shell's
      // app-owned routes and the Host's resource rows resolve under one mount.
      expect(got.body.match(/<base\b/g)).toHaveLength(1)
      const base = got.body.indexOf('<base href="./">')
      expect(base).toBeLessThan(got.body.indexOf('<link rel="preload" as="script" href="plugins/boot.js">'))
      expect(base).toBeLessThan(got.body.indexOf('<script>window.__T__=1</script>'))
    }
    offRows()
    expect(await request(port, '/', authenticated({ method: 'HEAD' }))).toEqual({
      status: 200,
      type: 'text/html; charset=utf-8',
      body: '',
    })
    untap()
    expect((await request(port, '/', authenticated())).body).not.toContain('__T__')

    // A missing configured index follows the same empty-404 contract for both
    // of its public entry paths and for both supported methods.
    await rm(join(root!, 'dist', 'index.html'))
    for (const path of ['/', '/index.html']) {
      const get = await request(port, path, authenticated())
      const head = await request(port, path, authenticated({ method: 'HEAD' }))
      expect(get).toEqual({ status: 404, type: null, body: '' })
      expect(head).toEqual(get)
    }

    // Ordinary unknown paths and static-resource misses are empty 404s for
    // both GET and HEAD; neither class can be mistaken for the HTML shell.
    const ordinaryMisses = ['/no/such/route', '/empty', '/app.js/child']
    const assetMisses = [
      '/missing.js',
      '/missing.css',
      '/missing.mjs',
      '/missing.js.map',
      '/missing.webmanifest',
      '/missing.manifest',
    ]
    for (const path of [...ordinaryMisses, ...assetMisses]) {
      const get = await request(port, path)
      const head = await request(port, path, { method: 'HEAD' })
      expect(get).toEqual({ status: 404, type: null, body: '' })
      expect(head).toEqual(get)
    }
    expect(await request(port, '/api/no/such/route', authenticated())).toEqual({
      status: 404,
      type: 'text/plain;charset=UTF-8',
      body: 'not found',
    })

    // Traversal outside the dist root is 403, non-GET/HEAD is 405, and a
    // malformed filesystem target still reaches the webserver's 400 guard.
    expect((await request(port, '/..%2f..%2fetc%2fpasswd')).status).toBe(403)
    expect((await request(port, '/app.js', { method: 'POST' })).status).toBe(405)
    expect((await request(port, '/bad%00path')).status).toBe(400)

    // HMR safety: disposing the frontend row releases the fallback seat (the
    // unclaimed webserver answers 404) and the seat is claimable again.
    const frontendEntry = [...loaded.loader.entries()].find(e => e.options.id === 'frontend')
    expect(frontendEntry).toBeDefined()
    await frontendEntry!.fiber?.dispose()
    expect((await request(port, '/no/such/route')).status).toBe(404)
    expect(() => server.registerFallback(() => {})).not.toThrow()
  })
})
