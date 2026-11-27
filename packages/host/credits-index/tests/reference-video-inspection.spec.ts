/** Reference reads use real workspace authorization and own their cancellation lifetime. */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { registerReferenceVideoInspection } from '../src/reference-video-inspection.ts'
import { createVideoEditor, type VideoEditor } from '../src/video-edit.ts'
import type { VideoProjectOptions } from '../src/video-project-types.ts'
import { mediaV2Object } from '../src/media-v2-protocol.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function fixture(realRuntime?: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'reference-inspection-')))
  const workspace = join(directory, 'workspace'), privateRoot = join(workspace, '.dsh')
  await mkdir(privateRoot, { recursive: true })
  const ctx = new Context()
  cleanup.push(async () => { await rm(directory, { recursive: true, force: true }) })
  cleanup.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: workspace })
  const session = Session.create(SessionId('reference-reader'), [], {
    id: SessionId('reference-reader'), version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false, cwd: workspace,
  })
  const agent: Agent = { id: session.id, ctx, session, options: {}, status: 'running',
    inbox: { nextTurn: [], nextStep: [], clear: vi.fn(), append: vi.fn(), prepend: vi.fn(),
      replace: () => false, remove: () => false, splice: () => [] },
    send: vi.fn(), steer: vi.fn(), followup: vi.fn(), inject: vi.fn(), cancel: vi.fn(), whenIdle: async () => {},
    runMaintenance: async work => await work(new AbortController().signal) }
  await ctx.agents.register(agent)
  const editor = { preflight: vi.fn(async () => {}),
    probe: vi.fn(async () => ({ durationSeconds: 4 })),
    preview: vi.fn<NonNullable<VideoEditor['preview']>>(async () => [{ path: join(workspace, 'sample.jpg'), timeSeconds: 2 }]),
    compose: vi.fn(async () => { throw new Error('Inspection cannot compose') }) } satisfies VideoEditor
  if (realRuntime !== undefined) {
    await ctx.plugin(LocalSubprocess)
    await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: workspace })
    await ctx.plugin(LocalSandbox)
  }
  const options = {
    stateDirectory: join(privateRoot, 'video-projects'), referenceInspectionDeniedRoots: [privateRoot],
    outputDirectory: 'artifacts/videos', maxTotalSeconds: 300, maxSegments: 32,
    pollIntervalMs: 1, taskTimeoutMs: 1000, acquireProvider: vi.fn(async () => { throw new Error('Inspection cannot log in or bill') }),
    editor: vi.fn(() => realRuntime === undefined ? editor : createVideoEditor(ctx, {
      session, workspaceRoot: workspace, runtimeRoot: realRuntime, fps: 10, timeoutMs: 30_000, singlePassMaxInputs: 3,
    })),
  } satisfies VideoProjectOptions
  const fiber = ctx.plugin({ inject: ['tools'], apply(owner: Context) { registerReferenceVideoInspection(owner, options) } })
  await fiber.await()
  const call = async (path: string, signal = new AbortController().signal) => ctx.tools.execute({
    name: 'inspect_reference_video', arguments: { path }, callId: ToolCallId('reference-read'), agent, signal,
  })
  return { ctx, directory, workspace, privateRoot, agent, editor, options, fiber, call }
}

it('returns exact duration, source, frame paths and timestamps without account access or generation', async () => {
  const f = await fixture(), source = join(f.workspace, 'source.mp4')
  await writeFile(source, 'untouched reference')
  const result = await f.call('source.mp4')
  expect(result.value).toMatchObject({ status: 'inspected', source_path: source, duration_seconds: 4,
    frames: [{ path: join(f.workspace, 'sample.jpg'), time_seconds: 2 }] })
  expect(JSON.stringify(result.value)).toContain('不代表看完全部动作、听过音频')
  expect(await readFile(source, 'utf8')).toBe('untouched reference')
  expect(f.options.acquireProvider).not.toHaveBeenCalled()
  expect(f.options.editor).toHaveBeenCalledWith(f.workspace, f.agent.session)
  expect(f.editor.preflight).not.toHaveBeenCalled()
  expect(f.editor.compose).not.toHaveBeenCalled()
  const tool = f.ctx.tools.get('inspect_reference_video')
  expect(tool?.presentCall?.({ path: source })).toMatchObject({ kind: 'read', locations: [{ path: source }] })
  expect(tool?.description).toContain('Analysis-only requests must stop')
  await f.fiber.dispose()
  expect(f.ctx.tools.get('inspect_reference_video')).toBeUndefined()
})

it('rejects outside files, a workspace-contained application home and attachment store, prefix siblings and links', async () => {
  const f = await fixture()
  const outside = join(f.directory, 'outside.mp4'), privateFile = join(f.privateRoot, 'private.mp4')
  await writeFile(outside, 'private')
  await writeFile(privateFile, 'private')
  await mkdir(join(f.privateRoot, 'attachments', 'v1'), { recursive: true })
  const attachment = join(f.privateRoot, 'attachments', 'v1', 'original.mp4')
  await writeFile(attachment, 'private-attachment-store-original')
  await writeFile(join(f.workspace, 'source.mp4'), 'local')
  const sibling = join(f.directory, 'workspace-other')
  await mkdir(sibling)
  await writeFile(join(sibling, 'other.mp4'), 'other')
  await symlink(privateFile, join(f.workspace, 'linked.mp4'))
  await symlink(join(f.workspace, 'source.mp4'), join(f.workspace, 'alias.mp4'))
  for (const path of [outside, '../outside.mp4', privateFile, attachment,
    join(sibling, 'other.mp4'), 'linked.mp4', 'alias.mp4', '.', 'missing.mp4']) {
    expect((await f.call(path)).value, path).toMatchObject({ status: 'failed', code: 'REFERENCE_VIDEO_ACCESS_DENIED' })
  }
  expect(f.options.editor).not.toHaveBeenCalled()
})

it('refuses a linked preview directory before probing or writing private files', async () => {
  const f = await fixture()
  await writeFile(join(f.workspace, 'source.mp4'), 'local')
  await symlink(f.privateRoot, join(f.workspace, '.yunshu-creative'))
  expect((await f.call('source.mp4')).value).toMatchObject({ status: 'failed', code: 'REFERENCE_VIDEO_ACCESS_DENIED' })
  expect(f.editor.probe).not.toHaveBeenCalled()
  expect(f.editor.preview).not.toHaveBeenCalled()
  expect(await readdir(f.privateRoot)).toEqual([])
})

it('settles an active inspection on disposal and preserves a safe failure on extraction errors', async () => {
  const f = await fixture(), source = join(f.workspace, 'source.mp4')
  await writeFile(source, 'original')
  f.editor.preview.mockRejectedValueOnce(new Error('private token /secret/path'))
  const failure = await f.call(source)
  expect(failure.value).toMatchObject({ status: 'failed', code: 'REFERENCE_VIDEO_UNAVAILABLE' })
  expect(JSON.stringify(failure.value)).not.toMatch(/token|secret/u)
  let settled = false
  const entered = Promise.withResolvers<undefined>()
  f.editor.preview.mockImplementationOnce(async (_source, _output, signal) => {
    entered.resolve(undefined)
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { settled = true; resolve() }, { once: true }) })
    signal.throwIfAborted()
    return []
  })
  const result = f.call(source)
  await entered.promise
  await f.fiber.dispose()
  expect(settled).toBe(true)
  expect((await result).value).toMatchObject({ status: 'cancelled', code: 'REFERENCE_VIDEO_CANCELLED' })
  expect(await readFile(source, 'utf8')).toBe('original')
})

const runtime = process.env.DSH_VIDEO_TEST_RUNTIME_ROOT
const ffmpeg = runtime === undefined ? undefined : join(runtime, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
it.skipIf(ffmpeg === undefined || !existsSync(ffmpeg))('extracts three real JPEG samples from a synthetic local video without modifying its source', async () => {
  if (ffmpeg === undefined || runtime === undefined) throw new Error('A prepared local runtime is required')
  const f = await fixture(runtime), source = join(f.workspace, '参考视频 原片.mp4')
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi',
    '-i', 'testsrc2=s=160x120:r=10:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { timeout: 30_000 })
  const original = await readFile(source), result = await f.call(source)
  expect(result.value).toMatchObject({ status: 'inspected', source_path: source, duration_seconds: 2 })
  const value = mediaV2Object(result.value)
  if (!Array.isArray(value.frames)) throw new Error('Expected actual sampled frames')
  const rawFrames: unknown[] = value.frames, frames = rawFrames.map(mediaV2Object)
  expect(frames.map(frame => frame.time_seconds)).toEqual([0, 1, 1.75])
  const paths: string[] = []
  for (const frame of frames) {
    if (typeof frame.path !== 'string') throw new Error('Expected a real frame path')
    const bytes = await readFile(frame.path)
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xd8])
    expect([...bytes.subarray(-2)]).toEqual([0xff, 0xd9])
    expect(frame.path.startsWith(join(f.workspace, '.yunshu-creative', 'reference-inspections'))).toBe(true)
    paths.push(frame.path)
  }
  expect(new Set(paths).size).toBe(3)
  expect((await readFile(source)).equals(original)).toBe(true)
  expect(f.options.acquireProvider).not.toHaveBeenCalled()
}, 60_000)
