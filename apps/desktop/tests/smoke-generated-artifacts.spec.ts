import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Artifacts from '../../../packages/deliverables/artifacts-index/src/index.ts'
import { afterEach, expect, it } from 'vitest'
import { smokeGeneratedArtifacts } from '../scripts/smoke-generated-artifacts.ts'

const fixtures: { context: Context; directory: string }[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    try { await fixture.context.fiber.dispose() }
    finally { await rm(fixture.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
  }
})

async function fixture(roots: (directory: string) => string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-artifacts-probe-'))
  const context = new Context()
  fixtures.push({ context, directory })
  const config = join(directory, 'cordis.yml')
  await writeFile(config, [
    '- name: cordis:webserver',
    '  config: {host: "127.0.0.1", port: 0}',
    '- name: cordis:artifacts',
    `  config: {roots: ${JSON.stringify(roots(await realpath(directory)))}}`,
    '',
  ].join('\n'))
  context.baseUrl = pathToFileURL(directory).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.builtins.webserver = WebServer
  context.loader.builtins.artifacts = Artifacts
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await context.loader.await()
  for (const entry of context.loader.entries()) await entry.fiber?.await()
  return { directory, request: (path: string) => fetch(`http://127.0.0.1:${String(context.webServer.port)}${path}`, {
    signal: AbortSignal.timeout(10_000),
  }) }
}

const media = (directory: string) => [join(directory, 'plugin-data', 'credits', 'media')]

it('finds and previews a saved image when artifact routes return canonical platform paths', async () => {
  const { directory, request } = await fixture(media)
  await expect(smokeGeneratedArtifacts(directory, request)).resolves.toBeUndefined()
})

it('rejects a root belonging to another installation instead of accepting an empty artifact list', async () => {
  const { directory, request } = await fixture(root => [join(root, 'old-installation', 'media')])
  await expect(smokeGeneratedArtifacts(directory, request)).rejects.toThrow('artifact roots')
})

it('rejects indexing private state beside generated media', async () => {
  const { directory, request } = await fixture(root => [join(root, 'plugin-data')])
  await expect(smokeGeneratedArtifacts(directory, request)).rejects.toThrow('artifact roots')
})

it('rejects a changed preview even when the real image listing is correct', async () => {
  const { directory, request } = await fixture(media)
  await expect(smokeGeneratedArtifacts(directory, path => path.startsWith('/artifacts/api/raw')
    ? Promise.resolve(new Response('changed image')) : request(path))).rejects.toThrow('preview changed')
})
