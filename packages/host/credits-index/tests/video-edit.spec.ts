/** Local editor safety and keyless real-binary assembly checks. */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxMode, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { expect, it, vi } from 'vitest'
import { createVideoEditor } from '../src/video-edit.ts'
import type { VideoEditorOptions } from '../src/video-edit.ts'

async function fixture(mode: SandboxMode, finish: (callback: () => Promise<void>) => void, runtimeRoot = '/missing-video-runtime') {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-video-edit-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const ctx = new Context()
  const fibers: Awaited<ReturnType<Context['plugin']>>[] = []
  finish(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  fibers.push(await ctx.plugin(SessionProjectionRegistry))
  fibers.push(await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace }))
  fibers.push(await ctx.plugin(LocalFileSystem, { cwd: workspace }))
  fibers.push(await ctx.plugin(LocalSubprocessRuntime))
  const options: VideoEditorOptions = { session: Session.create(SessionId('video-edit-fixture')), workspaceRoot: workspace,
    runtimeRoot, width: 320, height: 180, fps: 10, timeoutMs: 60_000 }
  return { directory, workspace, ctx, options, editor: createVideoEditor(ctx, options) }
}

it('refuses read-only workspaces before resolving or launching media executables', async ({ onTestFinished }) => {
  const { ctx, editor } = await fixture('read-only', onTestFinished)
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  await expect(editor.preflight(new AbortController().signal)).rejects.toMatchObject({ code: 'VIDEO_EDIT_SANDBOX_DENIED' })
  expect(spawn).not.toHaveBeenCalled()
})

it('requires the explicit bundled executable directory and never falls back to PATH', async ({ onTestFinished }) => {
  const { ctx, editor } = await fixture('danger-full-access', onTestFinished)
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  await expect(editor.preflight(new AbortController().signal)).rejects.toMatchObject({ code: 'VIDEO_EDIT_RUNTIME_UNAVAILABLE' })
  expect(spawn).not.toHaveBeenCalled()
})

it('fails closed when the session sandbox refuses a video subprocess', async ({ onTestFinished }) => {
  const { ctx, editor } = await fixture('workspace-write', onTestFinished)
  class DeniedSandbox extends SandboxProvider {
    override async confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv> {
      expect(argv[1]).toBe('-version')
      expect(policy.mode).toBe('workspace-write')
      throw new Error('fixture sandbox unavailable')
    }
  }
  const sandbox = await ctx.plugin(DeniedSandbox)
  onTestFinished(async () => { await sandbox.dispose() })
  vi.spyOn(ctx.subprocess, 'resolveExecutable').mockResolvedValue('/fixture/ffmpeg')
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  await expect(editor.preflight(new AbortController().signal)).rejects.toMatchObject({ code: 'VIDEO_EDIT_SANDBOX_DENIED' })
  expect(spawn).not.toHaveBeenCalled()
})

it('rejects input outside the workspace and authorized project directories before probing', async ({ onTestFinished }) => {
  const { directory, ctx, editor } = await fixture('danger-full-access', onTestFinished)
  const outside = join(directory, 'private.mp4')
  await writeFile(outside, 'private-video')
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  await expect(editor.probe(outside, new AbortController().signal)).rejects.toMatchObject({ code: 'VIDEO_EDIT_INVALID_INPUT' })
  expect(spawn).not.toHaveBeenCalled()
})

it('rejects linked generated clips even when their target is in the authorized project', async ({ onTestFinished }) => {
  const { directory, ctx, options } = await fixture('danger-full-access', onTestFinished)
  const owned = join(directory, 'project-clips')
  await mkdir(owned)
  await writeFile(join(owned, 'original.mp4'), 'private-video')
  await symlink(join(owned, 'original.mp4'), join(owned, 'alias.mp4'))
  const editor = createVideoEditor(ctx, { ...options, ownedMediaRoots: [owned] })
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  await expect(editor.probe(join(owned, 'alias.mp4'), new AbortController().signal)).rejects.toMatchObject({ code: 'VIDEO_EDIT_INVALID_INPUT' })
  expect(spawn).not.toHaveBeenCalled()
})

it('rejects an output subtree symlink escaping the workspace before starting any process', async ({ onTestFinished }) => {
  const { directory, workspace, ctx, editor } = await fixture('danger-full-access', onTestFinished)
  const outside = join(directory, 'outside')
  await mkdir(outside)
  const linked = join(workspace, 'linked-output')
  await symlink(outside, linked)
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  await expect(editor.preflight(new AbortController().signal, join(linked, 'project')))
    .rejects.toMatchObject({ code: 'VIDEO_EDIT_INVALID_INPUT' })
  expect(spawn).not.toHaveBeenCalled()
  expect(await readdir(outside)).toEqual([])
})

const binaryRoot = process.env.DSH_VIDEO_TEST_RUNTIME_ROOT
const native = binaryRoot !== undefined && existsSync(join(binaryRoot, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))

it.skipIf(!native)('checks the exact export tree through session filesystem policy before encoding', async ({ onTestFinished }) => {
  const { workspace, ctx, editor } = await fixture('danger-full-access', onTestFinished, binaryRoot)
  const outputDirectory = join(workspace, 'artifacts', 'restricted-project')
  const write = vi.spyOn(ctx.fs, 'writeText').mockRejectedValueOnce(new Error('fixture target is not writable'))
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  await expect(editor.preflight(new AbortController().signal, outputDirectory))
    .rejects.toMatchObject({ code: 'VIDEO_EDIT_RUNTIME_UNAVAILABLE' })
  const target = write.mock.calls[0]?.[0]
  expect(target).toBeDefined()
  if (target === undefined) throw new Error('missing output permission check')
  expect(ctx.fs.processPath(target)).toContain(outputDirectory)
  expect(write.mock.calls[0]?.[4]?.mode).toBe('danger-full-access')
  expect(spawn.mock.calls.every(([spec]) => spec.argv[1] === '-version')).toBe(true)
  expect(existsSync(outputDirectory)).toBe(false)
})

it.skipIf(!native)('normalizes real clips with and without audio, trims and publishes a verified MP4 without changing sources', async ({ onTestFinished }) => {
  const { workspace, editor } = await fixture('danger-full-access', onTestFinished, binaryRoot)
  const binary = join(binaryRoot!, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  const first = join(workspace, 'first.mp4'), second = join(workspace, 'second.mp4')
  execFileSync(binary, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=10:d=1.2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', first], { timeout: 30_000 })
  execFileSync(binary, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24:d=1.6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', second], { timeout: 30_000 })
  const originalFirst = await readFile(first), originalSecond = await readFile(second)
  const output = join(workspace, 'artifacts', 'final.mp4')
  const result = await editor.compose({ clips: [{ path: first, startSeconds: 0.2, endSeconds: 1.1 },
    { path: second, startSeconds: 0.1, endSeconds: 1.1 }],
  outputPath: output, totalDurationSeconds: 1.5, signal: new AbortController().signal })
  expect(result.durationSeconds).toBeCloseTo(1.5, 1)
  expect(await editor.probe(output, new AbortController().signal)).toMatchObject({ durationSeconds: result.durationSeconds })
  expect((await readFile(first)).equals(originalFirst)).toBe(true)
  expect((await readFile(second)).equals(originalSecond)).toBe(true)
  expect(await readdir(join(workspace, 'artifacts'))).toEqual(['final.mp4'])
  await expect(editor.compose({ clips: [{ path: first }], outputPath: output, signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: 'VIDEO_EDIT_INVALID_INPUT' })
}, 60_000)

it.skipIf(!native)('cancels a real encoding and waits for its process range before deleting temporary files', async ({ onTestFinished }) => {
  const { workspace, ctx, editor } = await fixture('danger-full-access', onTestFinished, binaryRoot)
  const binary = join(binaryRoot!, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  const first = join(workspace, 'source.mp4'), output = join(workspace, 'artifacts', 'cancelled.mp4')
  execFileSync(binary, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=10:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', first], { timeout: 30_000 })
  const abort = new AbortController()
  const originalSpawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  let encoding: SubprocessHandle | undefined
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const child = originalSpawn(spec)
    if (spec.argv.includes('-filter_complex')) {
      encoding = child
      setTimeout(() => { abort.abort(new Error('fixture cancellation')) }, 5)
    }
    return child
  })
  await expect(editor.compose({ clips: [{ path: first }], outputPath: output, signal: abort.signal }))
    .rejects.toMatchObject({ code: 'VIDEO_EDIT_CANCELLED' })
  expect(encoding).toBeDefined()
  expect(await encoding!.waitForExit()).toBe(true)
  expect(existsSync(output)).toBe(false)
  expect(await readdir(join(workspace, 'artifacts'))).toEqual([])
  expect(existsSync(first)).toBe(true)
}, 60_000)

it.skipIf(!native)('keeps the first generated clip’s portrait canvas and reads only its authorized private directory', async ({ onTestFinished }) => {
  const { directory, workspace, ctx, options } = await fixture('danger-full-access', onTestFinished, binaryRoot)
  const owned = join(directory, 'owned-project-clips')
  await mkdir(owned)
  const binary = join(binaryRoot!, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  const first = join(owned, 'portrait.mp4'), second = join(workspace, 'landscape.mp4')
  for (const [path, size] of [[first, '160x240'], [second, '320x180']]) {
    execFileSync(binary, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=${size!}:r=10:d=0.7`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path!], { timeout: 30_000 })
  }
  const editor = createVideoEditor(ctx, { ...options, width: undefined, height: undefined, ownedMediaRoots: [owned] })
  const output = join(workspace, 'portrait-output.mp4')
  await editor.compose({ clips: [{ path: first }, { path: second }], outputPath: output,
    totalDurationSeconds: 1, signal: new AbortController().signal })
  const metadata = execFileSync(join(binaryRoot!, 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'),
    ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', output], { encoding: 'utf8' })
  expect(JSON.parse(metadata)).toMatchObject({ streams: [{ codec_type: 'video', width: 160, height: 240 }, { codec_type: 'audio' }] })
}, 60_000)
