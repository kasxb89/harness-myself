/** Desktop-derived permission defaults recorded and replayed through the public dsh Web carrier. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import {
  fixtureContext, formatSystemPromptSnapshot, formatToolSchemasSnapshot, latestPersistedSessionPaths,
  normalizeSessionSnapshots, normalizedSystemPrompts, normalizedToolSchemas, redactSessionSnapshotIds,
  scrubSessionSnapshot, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import { expect, it, vi } from 'vitest'
import { mountPermissionProfile } from '../../desktop/tests/permission-profile.ts'
import { fixtureUserPrompts, normalizeWebSessionVolatiles, webSnapshotMode } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/desktop-permission-default', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v4.jsonl')
const PROMPTS = [
  'Reply with exactly DESKTOP_PERMISSION_OK. Do not call tools.',
  'Reply again with exactly DESKTOP_PERMISSION_OK. Do not call tools.',
] as const
const KEY = 'DSH_DESKTOP_PERMISSION_FIXTURE_KEY'
const REPLAY_MODULE = pathToFileURL(createRequire(join(REPO_ROOT, 'apps/cli/package.json'))
  .resolve('@deepseek-ai/dsh-llm-replay')).href

type JsonRow = Record<string, unknown>
type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

function rows(raw: string): JsonRow[] {
  return raw.trimEnd().split('\n').map(line => JSON.parse(line) as JsonRow)
}

async function storedSession(root: string, id: string): Promise<string> {
  const paths = (await readdir(root, { recursive: true })).map(path => join(root, path))
  for (const path of latestPersistedSessionPaths(paths)) {
    const raw = await readFile(path, 'utf8')
    if (rows(raw)[0]?.id === id) return raw
  }
  throw new Error(`No persisted Session ${id}`)
}

async function startWeb(root: string, workspace: string, overlay: string) {
  const launch = resolveExampleLaunch({
    srcBin: join(REPO_ROOT, 'apps/cli/src/bin.ts'), sourceImport: 'tsx/esm',
    tsconfigPath: join(REPO_ROOT, 'tsconfig.json'),
    configArgs: ['--profile', 'web', '--patch', overlay, '--host', '127.0.0.1', '--port', '0', '--no-open'],
    env: {
      DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'),
      DSH_BUNDLED_SKILL_DIR: join(root, 'bundled-skills'), DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: undefined, [KEY]: 'keyless-permission-fixture',
    },
  })
  const child = spawn(launch.command, launch.args, {
    cwd: workspace, env: { ...process.env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + String(chunk)).slice(-40_000) })
  const completion = new Promise<void>((resolve, reject) => {
    child.once('close', () => { resolve() })
    child.once('error', reject)
  })
  const stop = async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    let forced = false
    const timer = setTimeout(() => { forced = true; child.kill('SIGKILL') }, 10_000)
    timer.unref()
    try { await completion } finally { clearTimeout(timer) }
    if (forced) throw new Error('The owned Web process did not stop after SIGTERM')
  }
  try {
    await expect.poll(() => {
      if (child.exitCode !== null) throw new Error(output)
      return /dsh web: (http:\/\/\S+)/u.exec(output)?.[1]
    }, { timeout: 60_000 }).toBeDefined()
    const authenticatedUrl = /dsh web: (http:\/\/\S+)/u.exec(output)?.[1]
    if (authenticatedUrl === undefined) throw new Error('Web startup supplied no authenticated URL')
    const exchange = await fetch(authenticatedUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
    if (cookie === undefined) throw new Error('Web startup supplied no authentication cookie')
    const remote = async <T>(endpoint: string, args: Readonly<Record<string, unknown>>): Promise<T> => {
      const response = await fetch(new URL(`/api/${endpoint}`, authenticatedUrl), {
        method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}: ${await response.text()}`)
      const { result } = await response.json() as { result: RpcResult<T> }
      if (!result.ok) throw new Error(`${endpoint}: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    return { stop, remote, webUrl: new URL(authenticatedUrl).origin }
  } catch (error) {
    await stop()
    throw error
  }
}

it('records Desktop-derived full permissions, an explicit lower choice, and their preservation after restart', async (test) => {
  const mode = webSnapshotMode()
  if (mode === 'record') throw new Error('This authored scenario records only against its loopback fixture in refresh mode')
  const firstRecording = !existsSync(FIXTURE)
  if (firstRecording && mode !== 'refresh') throw new Error('Create this authored fixture with DSH_SNAPSHOT=refresh')
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-permission-roundtrip-'))
  const evidence = await mkdtemp(join(REPO_ROOT, '.artifacts/desktop-permission-roundtrip-'))
  test.onTestFinished(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('DSH_PERMISSION_MODE', undefined)
  test.onTestFinished(() => { vi.unstubAllEnvs() })
  const desktop = new Context()
  try {
    const profileRoot = join(root, 'desktop-source')
    await mkdir(profileRoot)
    await mountPermissionProfile(desktop, profileRoot)
    expect(desktop.permissionPresets.catalog().defaultPreset).toBe('danger-full-access')
  } catch (error) {
    await desktop.fiber.dispose()
    throw error
  }
  const desktopDefault = desktop.permissionPresets.catalog().defaultPreset
  const desktopPresets = Object.fromEntries(desktop.permissionPresets.names.map(name => [name, desktop.permissionPresets.resolve(name)]))
  await desktop.fiber.dispose()

  const server = firstRecording
    ? await startMockLlmServer({ sequence: ['success', 'success'], successText: 'DESKTOP_PERMISSION_OK', apiKey: 'keyless-permission-fixture' })
    : undefined
  test.onTestFinished(async () => { await server?.close() })
  const workspace = join(root, 'workspace')
  const persistence = join(root, 'sessions')
  await Promise.all([mkdir(workspace), mkdir(persistence)])
  const overlay = join(root, 'permission-roundtrip.patch.json')
  await writeFile(overlay, JSON.stringify([
    // The Web carrier receives the value resolved from the actual Desktop
    // Loader. It does not impersonate Desktop or replace its permission code.
    { id: 'permission', config: { presets: desktopPresets, defaultPreset: desktopDefault } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' } },
    { id: 'session-persistence-jsonl', config: { root: persistence, compression: 'none' } },
    { id: 'session-title-llm', disabled: true },
    { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'product-extensions', disabled: true },
    { id: 'computer-use', disabled: true },
    { id: 'computer-use-cua-driver-native', disabled: true },
    { id: 'credits-index', config: { newApiBaseUrl: 'http://127.0.0.1:1', baseUrl: '', bridgeBaseUrl: '', creditsPerYuan: 1000, stateDir: '' } },
    { id: 'llm-pi-ai', disabled: true },
    { id: 'llm-deepseek', disabled: !firstRecording, config: {
      apiKeyEnv: KEY, baseURL: server?.baseURL ?? 'http://127.0.0.1:1', reasoningEffort: 'off', thinking: 'disabled',
      models: [{ id: 'deepseek-v4-flash', contextWindow: 128_000, inputModalities: ['text'] }],
    } },
    ...firstRecording ? [] : [{ insert: [{ id: 'llm-replay', name: REPLAY_MODULE, config: {
      file: FIXTURE, providers: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{
        id: 'deepseek-v4-flash', contextWindow: 128_000, inputModalities: ['text'],
        defaultMaxTokens: 256_000,
        reasoningEfforts: ['off'], defaultReasoningEffort: 'off',
      }] }],
    } }] }],
  ]))
  let host = await startWeb(root, workspace, overlay)
  test.onTestFinished(async () => { await host.stop() })
  const { sessionId } = await host.remote<{ sessionId: string }>('session/create', { request: { cwd: workspace } })
  const projection = () => host.remote<{ values: { permissions: { currentValue: string } } }>('session/projections', { request: { sessionId } })
  expect((await projection()).values.permissions.currentValue).toBe('danger-full-access')
  if (!firstRecording) expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual(PROMPTS)
  for (const [index, prompt] of PROMPTS.entries()) {
    if (index === 1) {
      await host.remote('commands/execute', { agentId: sessionId, line: '/permission read-only', submittedAttachments: [] })
      expect((await projection()).values.permissions.currentValue).toBe('read-only')
    }
    await host.remote('session/prompt', { request: {
      requestId: `desktop-permission-${index}`, sessionId, mode: 'queue', clientTimeZone: 'Asia/Shanghai',
      content: [{ type: 'text', text: prompt }],
    } })
    await expect.poll(async () => {
      try { return rows(await storedSession(persistence, sessionId)).filter(row => row.type === 'turn/end').length }
      catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT'
          || error instanceof Error && error.message.startsWith('No persisted Session')) return 0
        throw error
      }
    }, { timeout: 30_000 }).toBe(index + 1)
  }
  await host.stop()
  const raw = await storedSession(persistence, sessionId)
  await writeFile(join(evidence, 'session.raw.jsonl'), raw)
  const events = rows(raw)
  expect(events.filter(row => row.type === 'permission/preset').map(row => row.data)).toEqual([
    { preset: 'danger-full-access' }, { preset: 'read-only' },
  ])
  expect(events.filter(row => row.type === 'sandbox/mode').map(row => row.data)).toEqual([
    { mode: 'danger-full-access' }, { mode: 'read-only' },
  ])
  expect(events.filter(row => row.type === 'approval/policy').map(row => row.data)).toEqual([
    { policy: 'never' }, { policy: 'ask' },
  ])
  expect(events.filter(row => row.type === 'turn/end')).toMatchObject([
    { data: { reason: { kind: 'completed' } } }, { data: { reason: { kind: 'completed' } } },
  ])
  expect(events.filter(row => row.type === 'assistant/message')).toHaveLength(2)
  expect(raw).toContain('Current DSH file policy: danger-full-access.')
  expect(raw).toContain('Approval prompts are disabled in this session')
  expect(raw).toContain('Current DSH file policy: read-only.')
  expect(raw).toContain('Approval policy: ask.')
  if (server !== undefined) {
    expect(server.requests).toHaveLength(2)
    expect(JSON.stringify(server.requests[0]?.body)).toContain('Current DSH file policy: danger-full-access.')
    expect(JSON.stringify(server.requests[1]?.body)).toContain('Current DSH file policy: read-only.')
  }

  const normalizedRaw = normalizeWebSessionVolatiles(raw)
  const context = { sessionIds: [sessionId], cwd: workspace }
  const prompts = normalizedSystemPrompts(normalizedRaw, context)
    .map(prompt => prompt.split(REPO_ROOT).join('{{sourceRoot}}').split(host.webUrl).join('{{webUrl}}'))
  const schemas = normalizedToolSchemas(normalizedRaw, context)
  const promptSidecar = formatSystemPromptSnapshot(prompts[0]!, prompts.slice(1))
  const schemaSidecar = formatToolSchemasSnapshot(schemas[0]!, schemas.slice(1))
  if (firstRecording) {
    await writeFile(FIXTURE, redactSessionSnapshotIds([scrubSessionSnapshot(tokenizeSessionFixtureCwd(normalizedRaw))])[0]!)
  }
  if (mode === 'refresh') {
    await Promise.all([
      writeFile(join(SNAPSHOT_DIR, 'system-prompt.expected.md'), promptSidecar),
      writeFile(join(SNAPSHOT_DIR, 'tool-schemas.expected.json'), schemaSidecar),
    ])
  }
  const expected = await readFile(FIXTURE, 'utf8')
  expect(normalizeSessionSnapshots([normalizedRaw], context)[0])
    .toBe(normalizeSessionSnapshots([expected], fixtureContext(expected))[0])
  expect(promptSidecar).toBe(await readFile(join(SNAPSHOT_DIR, 'system-prompt.expected.md'), 'utf8'))
  expect(schemaSidecar).toBe(await readFile(join(SNAPSHOT_DIR, 'tool-schemas.expected.json'), 'utf8'))

  host = await startWeb(root, workspace, overlay)
  await host.remote('session/create', { request: { cwd: workspace, sessionId } })
  expect((await projection()).values.permissions.currentValue).toBe('read-only')
  const fresh = await host.remote<{ sessionId: string }>('session/create', { request: { cwd: workspace } })
  expect((await host.remote<{ values: { permissions: { currentValue: string } } }>('session/projections', {
    request: { sessionId: fresh.sessionId },
  })).values.permissions.currentValue).toBe('danger-full-access')
  await host.stop()
  expect(rows(await storedSession(persistence, sessionId)).filter(row => row.type === 'sandbox/mode').map(row => row.data))
    .toEqual([{ mode: 'danger-full-access' }, { mode: 'read-only' }])
  await Promise.all([
    writeFile(join(evidence, 'session.raw.jsonl'), raw),
    writeFile(join(evidence, 'summary.json'), JSON.stringify({
      firstRecording, modelRequests: server?.requests.length ?? 0, desktopDefault,
      restored: 'read-only', freshAfterRestart: 'danger-full-access', packageBuilt: false,
    }, undefined, 2) + '\n'),
  ])
})
