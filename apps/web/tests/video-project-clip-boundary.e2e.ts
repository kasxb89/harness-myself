/** A completed recorded project trims provider padding at every planned clip boundary. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  captureExpectedWorkspaceSnapshot, captureWorkspaceSnapshot, fixtureContext,
  formatSystemPromptSnapshot, formatToolSchemasSnapshot, latestPersistedSessionPaths,
  normalizeSessionSnapshots, normalizedSystemPrompts, normalizedToolSchemas,
  redactSessionSnapshotIds, scrubSessionSnapshot, tokenizeSessionFixtureCwd,
  type WorkspaceSnapshotEntry,
} from '@deepseek-ai/dsh-session-snapshot'
import { expect, it } from 'vitest'
import { startProfileWeb } from './profile-process.ts'
import { fixtureUserPrompts, normalizeWebSessionVolatiles, webSnapshotMode } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/video-project-clip-boundary', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v4.jsonl')
const PROMPTS = ['用H3生成一条8秒的视频，红色画面切换蓝色，最后半秒黄色。'] as const
const KEY = 'DSH_VIDEO_CLIP_BOUNDARY_FIXTURE_KEY'
const runtimeRoot = process.env.DSH_VIDEO_TEST_RUNTIME_ROOT
const available = runtimeRoot !== undefined && ['ffmpeg', 'ffprobe'].every(tool =>
  existsSync(join(runtimeRoot, 'bin', process.platform === 'win32' ? `${tool}.exe` : tool)))
type JsonRow = Record<string, unknown>
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
function object(value: unknown): JsonRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object')
  return value as JsonRow
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected text')
  return value
}
function rows(raw: string): JsonRow[] { return raw.trimEnd().split('\n').map(line => object(JSON.parse(line))) }
function toolResults(raw: string): { name: string; callId: string; text: string }[] {
  const events = rows(raw)
  const calls = new Map(events.filter(row => row.type === 'tool/call').map((row) => {
    const data = object(row.data)
    return [data.callId, text(data.name)]
  }))
  return events.filter(row => row.type === 'tool/result').map((row) => {
    const message = object(object(row.data).message)
    const content = (message.content as unknown[]).map(object)
    return { name: calls.get(message.toolCallId) ?? '', callId: text(message.toolCallId),
      text: content.filter(block => block.type === 'text').map(block => text(block.text)).join('') }
  })
}
async function storedSession(directory: string, id: string): Promise<string | undefined> {
  const paths = (await readdir(directory, { recursive: true })).map(path => join(directory, path))
  for (const path of latestPersistedSessionPaths(paths)) {
    const raw = await readFile(path, 'utf8')
    if (rows(raw)[0]?.id === id) return raw
  }
  return undefined
}
function completedSummary(output: string): JsonRow {
  const line = output.split('\n').find(value => value.startsWith('{') && value.includes('"final_path"'))
  if (line === undefined) throw new Error('Expected a completed project with its actual final_path')
  return object(JSON.parse(line))
}
function modelResult(body: unknown, id: string): JsonRow {
  const messages = object(body).messages as { content: unknown }[]
  const block = messages.flatMap(message => Array.isArray(message.content) ? message.content.map(object) : [])
    .find(value => value.type === 'tool_result' && value.tool_use_id === id)
  if (block === undefined) throw new Error(`Expected the actual ${id} result`)
  const content = typeof block.content === 'string' ? block.content
    : (block.content as unknown[]).map(object).filter(value => value.type === 'text').map(value => text(value.text)).join('')
  return object(JSON.parse(content))
}

/** Capture only actual returned native creation identities and validated saved media paths. */
function normalizeProject(raw: string, start: JsonRow, mediaPaths: readonly string[]): string {
  const replacements = new Map<string, string>()
  for (const [key, prefix] of [['project_id', 'vp_'], ['plan_id', 'cp_'], ['operation_id', 'op_']] as const) {
    const id = start[key]
    if (id === undefined && key !== 'project_id') continue
    if (typeof id !== 'string' || !id.startsWith(prefix)
      || !/^[a-z]{2}_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id)) throw new Error(`Invalid ${key}`)
    replacements.set(id, `{{id:${String(1001 + replacements.size)}}}`)
  }
  const request = text(start.work_request_id), work = text(start.work_id)
  if (!/^vr_[a-f0-9]{64}$/u.test(request) || !new RegExp(`^vw_${request.slice(3)}_[1-9][0-9]*$`, 'u').test(work)) {
    throw new Error('Invalid returned work relationship')
  }
  replacements.set(request, '{{videoWorkRequest:1}}')
  replacements.set(work, '{{videoWork:1}}')
  for (const [index, path] of mediaPaths.entries()) {
    if (!isAbsolute(path)) throw new Error('Expected an absolute saved media path')
    replacements.set(path, `{{artifactPath:${String(index + 1)}}}`)
  }
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let result = value
      // Replace complete saved paths before identities embedded in their directory names.
      for (const [source, token] of [...replacements].sort((left, right) => right[0].length - left[0].length)) {
        result = result.split(JSON.stringify(source).slice(1, -1)).join(token).split(source).join(token)
      }
      return result
    }
    if (Array.isArray(value)) return value.map(replace)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
    return value
  }
  return rows(raw).map(row => JSON.stringify(replace(row))).join('\n') + '\n'
}

/** Keep the complete output tree while comparing every decoded frame/sample across encoder builds. */
function assertCompleteDecodedMediaWorkspace(
  actual: readonly WorkspaceSnapshotEntry[], expected: readonly WorkspaceSnapshotEntry[], mediaPath: string,
  actualMediaPath: string, expectedMediaPath: string, ffmpeg: string, ffprobe: string,
  previews: readonly { path: string; actualPath: string; expectedPath: string }[],
): {
  frames: number
  audioSamplesPerChannel: number
  maximumRgbError: number
  maximumFrameMeanError: number
  previewImages: number
  maximumPreviewRgbError: number
} {
  const previewPaths = new Set(previews.map(preview => preview.path))
  expect(previewPaths.size).toBe(9)
  expect(actual.map(entry => ({ path: entry.path, kind: entry.kind })))
    .toEqual(expected.map(entry => ({ path: entry.path, kind: entry.kind })))
  for (const [index, entry] of actual.entries()) {
    if (entry.path !== mediaPath && !previewPaths.has(entry.path)) expect(entry).toEqual(expected[index])
    else {
      expect(entry.kind).toBe('binary')
      expect(expected[index]?.kind).toBe('binary')
    }
  }
  expect(actual.filter(entry => entry.path === mediaPath)).toHaveLength(1)
  const actualBlob = actual.find(entry => entry.path === mediaPath), expectedBlob = expected.find(entry => entry.path === mediaPath)
  if (actualBlob?.kind !== 'binary' || expectedBlob?.kind !== 'binary') throw new Error('Expected captured video blobs')
  expect(Buffer.from(actualBlob.base64, 'base64').equals(readFileSync(actualMediaPath))).toBe(true)
  expect(Buffer.from(expectedBlob.base64, 'base64').equals(readFileSync(expectedMediaPath))).toBe(true)
  let maximumPreviewRgbError = 0
  for (const preview of previews) {
    const actualImage = actual.find(entry => entry.path === preview.path)
    const expectedImage = expected.find(entry => entry.path === preview.path)
    if (actualImage?.kind !== 'binary' || expectedImage?.kind !== 'binary') throw new Error('Expected the captured preview image')
    expect(Buffer.from(actualImage.base64, 'base64').equals(readFileSync(preview.actualPath))).toBe(true)
    expect(Buffer.from(expectedImage.base64, 'base64').equals(readFileSync(preview.expectedPath))).toBe(true)
    const images = [preview.actualPath, preview.expectedPath].map(path => object(JSON.parse(execFileSync(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', path,
    ], { encoding: 'utf8', timeout: 30000 }))))
    expect(images[0]!.streams).toEqual(images[1]!.streams)
    expect(images[0]!.streams).toEqual([{ codec_name: 'mjpeg', width: 480, height: 270 }])
    const decoded = [preview.actualPath, preview.expectedPath].map(path => execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 }))
    const pixels = decoded[0]!, golden = decoded[1]!
    expect(pixels.length).toBe(480 * 270 * 3)
    expect(golden.length).toBe(pixels.length)
    let sum = 0, maximum = 0
    for (let pixel = 0; pixel < pixels.length; pixel += 1) {
      const difference = Math.abs(pixels[pixel]! - golden[pixel]!)
      maximum = Math.max(maximum, difference); sum += difference
    }
    maximumPreviewRgbError = Math.max(maximumPreviewRgbError, maximum)
    expect(maximum).toBeLessThanOrEqual(6)
    expect(sum / pixels.length).toBeLessThanOrEqual(2)
  }
  const mediaProbe = (path: string): JsonRow => object(JSON.parse(execFileSync(ffprobe, [
    '-v', 'error', '-show_entries',
    'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,nb_frames,sample_rate,channels', '-of', 'json', path,
  ], { encoding: 'utf8', timeout: 30000 })))
  const actualProbe = mediaProbe(actualMediaPath), expectedProbe = mediaProbe(expectedMediaPath)
  expect(actualProbe.streams).toEqual(expectedProbe.streams)
  for (const value of [actualProbe, expectedProbe]) {
    expect(Number(object(value.format).duration)).toBeCloseTo(8, 2)
    expect(value.streams).toContainEqual({ codec_name: 'h264', codec_type: 'video', width: 160, height: 90,
      avg_frame_rate: '10/1', nb_frames: '80' })
    expect((value.streams as unknown[]).map(object).find(stream => stream.codec_type === 'audio'))
      .toMatchObject({ codec_name: 'aac', codec_type: 'audio', sample_rate: '48000', channels: 2 })
  }
  const decode = (path: string, audio: boolean): Buffer => execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path,
    ...audio ? ['-map', '0:a:0', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1']
      : ['-map', '0:v:0', '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
  ], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 })
  const pixels = decode(actualMediaPath, false), goldenPixels = decode(expectedMediaPath, false)
  const frameBytes = 160 * 90 * 3
  expect(pixels.length).toBe(80 * frameBytes)
  expect(goldenPixels.length).toBe(pixels.length)
  let maximumRgbError = 0, maximumFrameMeanError = 0
  for (let offset = 0; offset < pixels.length; offset += frameBytes) {
    let sum = 0
    for (let pixel = offset; pixel < offset + frameBytes; pixel += 1) {
      const difference = Math.abs(pixels[pixel]! - goldenPixels[pixel]!)
      maximumRgbError = Math.max(maximumRgbError, difference)
      sum += difference
    }
    maximumFrameMeanError = Math.max(maximumFrameMeanError, sum / frameBytes)
  }
  // Flat-color fixtures permit only small libx264 quantization changes, never a substituted frame.
  if (maximumRgbError > 6 || maximumFrameMeanError > 2) throw new Error(
    `Decoded video pixels differ: maximum=${String(maximumRgbError)}, frame mean=${String(maximumFrameMeanError)}`)
  const audio = decode(actualMediaPath, true), goldenAudio = decode(expectedMediaPath, true)
  expect(audio.length).toBe(goldenAudio.length)
  expect(audio.length % 8).toBe(0)
  expect(audio.length / 8).toBeGreaterThanOrEqual(8 * 48000)
  expect(audio.length / 8).toBeLessThanOrEqual(8 * 48000 + 1024)
  let maximumSampleAmplitude = 0
  for (let offset = 0; offset < audio.length; offset += 4) {
    const actualSample = audio.readFloatLE(offset), expectedSample = goldenAudio.readFloatLE(offset)
    if (!Number.isFinite(actualSample) || !Number.isFinite(expectedSample)) throw new Error('Decoded audio contains a nonfinite sample')
    maximumSampleAmplitude = Math.max(maximumSampleAmplitude, Math.abs(actualSample), Math.abs(expectedSample))
  }
  expect(maximumSampleAmplitude).toBeLessThanOrEqual(0.000001)
  return { frames: pixels.length / frameBytes, audioSamplesPerChannel: audio.length / 8, maximumRgbError, maximumFrameMeanError,
    previewImages: previews.length, maximumPreviewRgbError }
}

it.skipIf(!available)('records a completed project whose padded source clips change at the planned frame boundaries (requires prepared DSH_VIDEO_TEST_RUNTIME_ROOT)', async (test) => {
  if (runtimeRoot === undefined) throw new Error('Provide the prepared native video runtime')
  const ffmpeg = join(runtimeRoot, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  const ffprobe = join(runtimeRoot, 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  const mode = webSnapshotMode()
  if (mode === 'record') throw new Error('This keyless authored owner is captured through official refresh')
  if (!existsSync(FIXTURE) && mode !== 'refresh') throw new Error('Create this owner with DSH_SNAPSHOT=refresh')
  const script = mode === 'refresh' ? undefined : deriveReplayScript(parseSessionLog(await readFile(FIXTURE, 'utf8')))
  if (script !== undefined) expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual(PROMPTS)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-video-clip-boundary-')))
  const workspace = join(root, 'workspace'), credits = join(root, 'credits'), persistence = join(root, 'sessions')
  const published = join(root, 'published')
  await Promise.all([workspace, persistence, published].map(path => mkdir(path)))
  const cleanup: { host?: () => Promise<void>; server?: () => Promise<void>; socket?: () => Promise<void> } = {}
  let lastRaw = ''
  const posts: JsonRow[] = [], queries: string[] = [], downloads: string[] = [], modelRequests: unknown[] = [], errors: string[] = []
  test.onTestFailed(async () => {
    const evidence = process.env.DSH_VIDEO_BOUNDARY_EVIDENCE_DIRECTORY
    if (evidence === undefined) return
    await mkdir(evidence, { recursive: true })
    if (lastRaw !== '') await writeFile(join(evidence, 'failure-session.jsonl'), lastRaw)
    if (existsSync(workspace)) {
      await writeFile(join(evidence, 'failure-workspace.json'), JSON.stringify(await captureWorkspaceSnapshot(workspace), null, 2) + '\n')
    }
    await writeFile(join(evidence, 'failure-context.json'), JSON.stringify({ posts, queries, downloads,
      modelRequests: modelRequests.length, errors }, null, 2) + '\n')
  })
  test.onTestFinished(async () => {
    try { await cleanup.socket?.() }
    finally {
      try { await cleanup.host?.() }
      finally {
        try { await cleanup.server?.() }
        finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  })
  const sourcePaths = ['source-red-padding.mp4', 'source-blue-yellow-padding.mp4'].map(name => join(root, name))
  for (const [index, path] of sourcePaths.entries()) execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i',
    `color=c=${index === 0 ? 'red' : 'blue'}:s=160x90:r=10:d=4.7`, '-vf',
    `${index === 0 ? '' : "drawbox=color=yellow:t=fill:enable='gte(t,3.5)*lt(t,4)',"}drawbox=color=magenta:t=fill:enable='gte(t,4)'`,
    '-an', '-threads', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path,
  ], { timeout: 30_000 })
  const sourceBytes = await Promise.all(sourcePaths.map(path => readFile(path)))
  const probe = (path: string): JsonRow => object(JSON.parse(execFileSync(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', path,
  ], { encoding: 'utf8', timeout: 30_000 })))
  const frame = (path: string, seconds: number): Buffer => execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(seconds), '-i', path,
    '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { timeout: 30_000 })
  for (const path of sourcePaths) expect(Number(object(probe(path).format).duration)).toBeCloseTo(4.7, 1)
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const body: unknown = chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      response.setHeader('content-type', 'application/json')
      const answer = (value: unknown): void => { response.end(JSON.stringify({ success: true, data: value })) }
      if (path === '/harness/api/status') { answer({ quota_per_unit: 500000, usd_exchange_rate: 7.3 }); return }
      if (path === '/harness/api/user/phone/challenge') {
        answer({ challenge_id: 'boundary-challenge', delivery_status: 'accepted', expires_at: Math.floor(Date.now() / 1000) + 300,
          resend_after_seconds: 60, expires_in_minutes: 5 }); return
      }
      if (path === '/harness/api/user/phone/login') {
        response.setHeader('set-cookie', 'new_api_refresh=boundary-refresh; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: 'boundary-access', access_expires_at: Math.floor(Date.now() / 1000) + 900,
          relay_key: 'sk-boundary-relay', relay_key_id: 9, session: { sid: 'boundary-login', current: true },
          user: { id: 7, username: 'boundary-user', quota: 500000 } }); return
      }
      if (path === '/harness/api/user/self') { answer({ id: 7, username: 'boundary-user', group: 'product', quota: 500000 }); return }
      if (path === '/harness/api/client-activity/heartbeat') { answer({ heartbeat_interval_seconds: 60 }); return }
      if (path === '/harness/v1/models') {
        expect(request.headers.authorization).toBe('Bearer sk-boundary-relay')
        response.end(JSON.stringify({ data: [{ id: 'MiniMax-H3', object: 'model', supported_endpoint_types: ['openai-video'] }] })); return
      }
      if (path === '/harness/api/pricing') {
        answer([{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'], parameters: {
          seconds: { enum: [4] }, resolution: { enum: ['768P'] }, ratio: { enum: ['16:9'] },
          'x-client-concurrency': { schema: 1, atomic_admission: true, max_parallelism: 2, model: 'MiniMax-H3',
            scope: 'shared_account_pool', reservation: false },
        } }]); return
      }
      if (path === '/harness/v1/video/generations' && request.method === 'POST') {
        expect(request.headers.authorization).toBe('Bearer sk-boundary-relay')
        const value = object(body)
        expect(value).toMatchObject({ model: 'MiniMax-H3', duration: 4, seconds: 4, resolution: '768P' })
        posts.push(value)
        if (posts.length > 2) throw new Error('Unexpected repeated generation')
        const shot = /当前分镜 ([12])\/2/u.exec(text(value.prompt))?.[1]
        if (shot === undefined) throw new Error('Expected the actual planned shot ordinal')
        expect(posts.filter(post => text(post.prompt).includes(`当前分镜 ${shot}/2`))).toHaveLength(1)
        response.end(JSON.stringify({ code: 'success', data: { task_id: `boundary-task-${shot}` } })); return
      }
      if (/^\/harness\/v1\/tasks\/boundary-task-[12]$/u.test(path)) {
        expect(request.headers.authorization).toBe('Bearer sk-boundary-relay')
        queries.push(path)
        response.end(JSON.stringify({ code: 'success', data: { status: 'SUCCESS' } })); return
      }
      const download = /^\/harness\/v1\/videos\/boundary-task-([12])\/content$/u.exec(path)
      if (download !== null) {
        expect(request.headers.authorization).toBe('Bearer sk-boundary-relay')
        downloads.push(path)
        const bytes = sourceBytes[Number(download[1]) - 1]
        if (bytes === undefined) throw new Error('Expected source clip')
        response.setHeader('content-type', 'video/mp4'); response.setHeader('content-length', bytes.length)
        response.end(bytes); return
      }
      if (path === '/v1/messages') {
        expect(request.headers['x-api-key']).toBe('keyless-video-boundary-fixture')
        modelRequests.push(body)
        const attempt = modelRequests.length
        let tool: { id: string; name: string; args: JsonRow } | undefined
        let reply = 'VIDEO_BOUNDARIES_VERIFIED'
        if (script === undefined) {
          if (attempt === 1) tool = { id: 'boundary-start', name: 'generate_video_project', args: {
            model: 'MiniMax-H3', prompt: '红色切换蓝色，最后半秒黄色', total_duration_seconds: 8,
          } }
          if (attempt === 2) tool = { id: 'boundary-read', name: 'job_output', args: {
            job_id: modelResult(body, 'boundary-start').job_id, wait: true, timeout_ms: 120000,
          } }
        } else {
          const entry = script[attempt - 1]
          if (entry?.kind !== 'chunks') throw new Error('Expected recorded model step')
          const tools = entry.chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'
            ? [{ id: chunk.block.id, name: chunk.block.name, args: object(JSON.parse(chunk.block.arguments)) }] : [])
          if (tools.length > 1) throw new Error('Expected one native call per model step')
          tool = tools[0]
          reply = entry.chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'text' ? [chunk.block.text] : []).join('')
        }
        if (attempt > 3 || attempt < 3 && tool === undefined || attempt === 3 && tool !== undefined) throw new Error('Unexpected model continuation')
        response.setHeader('content-type', 'text/event-stream')
        const events: object[] = [{ type: 'message_start', message: { id: `boundary-message-${String(attempt)}`,
          type: 'message', role: 'assistant', model: 'synthetic', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }]
        events.push({ type: 'content_block_start', index: 0, content_block: tool === undefined
          ? { type: 'text', text: '' } : { type: 'tool_use', id: tool.id, name: tool.name, input: {} } },
        { type: 'content_block_delta', index: 0, delta: tool === undefined ? { type: 'text_delta', text: reply }
          : { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } }, { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: tool === undefined ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } },
        { type: 'message_stop' })
        response.end(events.map(event => `event: ${text(object(event).type)}\ndata: ${JSON.stringify(event)}\n\n`).join('')); return
      }
      errors.push(path); response.writeHead(404); response.end('{}')
    })().catch((error: unknown) => { errors.push(String(error)); response.destroy() })
  })
  cleanup.server = () => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) }); server.closeAllConnections()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected loopback fixture')
  const origin = `http://127.0.0.1:${String(address.port)}`
  const overlay = join(root, 'boundary.patch.json')
  await writeFile(overlay, JSON.stringify([
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' } },
    { id: 'session-persistence-jsonl', config: { root: persistence, compression: 'none' } },
    { id: 'session-title-llm', disabled: true }, { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'product-extensions', disabled: true }, { id: 'agent-instructions', disabled: true },
    { id: 'computer-use', disabled: true }, { id: 'computer-use-cua-driver-native', disabled: true },
    { id: 'artifacts-index', config: { defaultOutputDirectory: published, stateDirectory: join(root, 'artifact-state'), roots: [published] } },
    { id: 'credits-index', config: { newApiBaseUrl: `${origin}/harness`, baseUrl: '', bridgeBaseUrl: '', creditsPerYuan: 1000,
      stateDir: credits, videoRuntimeRoot: runtimeRoot, videoProjectOutputDirectory: 'renders', videoEditFps: 10,
      videoProjectConcurrency: 1, videoProjectPollIntervalMs: 250, videoProjectTaskTimeoutMs: 120000, videoEditTimeoutMs: 60000 } },
    { id: 'llm-pi-ai', disabled: true }, { id: 'llm-deepseek', disabled: false, config: { apiKeyEnv: KEY, baseURL: origin,
      reasoningEffort: 'off', thinking: 'disabled', models: [{ id: 'deepseek-v4-flash', contextWindow: 128000, inputModalities: ['text'] }] } },
  ]))
  const host = await startProfileWeb(root, workspace, overlay, { [KEY]: 'keyless-video-boundary-fixture' })
  cleanup.host = () => host.stop()
  const post = async (path: string, args: object): Promise<JsonRow> => {
    const response = await fetch(new URL(path, host.webUrl), { method: 'POST', headers: { 'content-type': 'application/json', cookie: host.cookie },
      body: JSON.stringify(args), signal: AbortSignal.timeout(10000) })
    expect(response.ok).toBe(true)
    return object(await response.json())
  }
  expect(await post('/credits/api/session/challenge', { phone: '+8613800000000', idempotencyKey: 'boundary-challenge' })).toMatchObject({ ok: true })
  expect(await post('/credits/api/session/verify', { challengeId: 'boundary-challenge', code: '123456', idempotencyKey: 'boundary-login' })).toMatchObject({ ok: true })
  const { sessionId } = await host.remote<{ sessionId: string }>('session/create', { request: { cwd: workspace } })
  for (const index of [0, 1]) {
    if (index === 1) {
      const accepted = toolResults(lastRaw).find(result => result.name === 'generate_video_project')
      if (accepted === undefined) throw new Error('Expected the actual accepted project before observing its completion')
      const project = object(JSON.parse(accepted.text))
      // The public observer sees actual settlement; the normal completion notice opens the next model turn.
      const socket = new WebSocket(host.webUrl.replace(/^http/u, 'ws') + '/api/remote.mux', { headers: { cookie: host.cookie } })
      const closed = new Promise<void>(resolve => socket.once('close', () => { resolve() }))
      cleanup.socket = async () => {
        socket.close()
        const timer = setTimeout(() => { socket.terminate() }, 2000)
        timer.unref()
        try { await closed } finally { clearTimeout(timer) }
      }
      let status: unknown
      socket.on('message', (bytes) => {
        const data = Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
        const frame = object(JSON.parse(data.toString('utf8')))
        if (frame.type === 'item') {
          const value = object(frame.value)
          if (value.type === 'status') {
            const job = object(value.job)
            expect(job.id).toBe(project.job_id)
            status = job.status
          }
        }
        if (frame.type === 'error') errors.push(JSON.stringify(frame))
      })
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
      socket.send(JSON.stringify({ type: 'open', streamId: 'boundary-follow', endpoint: 'job/follow',
        payload: { args: { request: { sessionId, jobId: project.job_id } } } }))
      await expect.poll(() => status, { timeout: 60000 }).toBe('completed')
      await cleanup.socket()
    } else await host.remote('session/prompt', { request: { requestId: 'boundary-human-1', sessionId,
      mode: 'queue', clientTimeZone: 'Asia/Shanghai', content: [{ type: 'text', text: PROMPTS[0] }] } })
    await expect.poll(async () => {
      const raw = await storedSession(persistence, sessionId)
      if (raw !== undefined) lastRaw = raw
      return raw === undefined ? 0 : rows(raw).filter(row => row.type === 'turn/end').length
    }, { timeout: 90000 }).toBe(index + 1)
  }
  const raw = await storedSession(persistence, sessionId)
  if (raw === undefined) throw new Error('Expected actual persisted Session')
  const results = toolResults(raw)
  expect(rows(raw).filter(row => row.type === 'user/message' && object(object(row.data).source).kind === 'user')
    .map(row => object(object(row.data).source).rpcId)).toEqual(['boundary-human-1'])
  expect(rows(raw).filter(row => row.type === 'user/message' && object(object(row.data).source).kind === 'tool-jobs')).toHaveLength(1)
  expect(results.map(result => result.name)).toEqual(['generate_video_project', 'job_output'])
  const start = object(JSON.parse(results[0]!.text)), summary = completedSummary(results[1]!.text)
  expect(start).toMatchObject({ status: 'background', plan_seconds: [4, 4], remaining_works: 0 })
  expect(summary).toMatchObject({ status: 'succeeded', project_id: start.project_id, duration_seconds: 8 })
  const finalPath = text(summary.final_path), clipPaths = (summary.clip_paths as unknown[]).map(text)
  expect(clipPaths).toHaveLength(2)
  expect(finalPath.startsWith(published + sep)).toBe(true)
  expect(new Set([finalPath, ...clipPaths]).size).toBe(3)
  for (const [index, path] of clipPaths.entries()) expect(digest(await readFile(path))).toBe(digest(sourceBytes[index]!))
  const metadata = probe(finalPath)
  expect(Number(object(metadata.format).duration)).toBeCloseTo(8, 1)
  expect(metadata.streams).toContainEqual({ codec_type: 'video', width: 160, height: 90 })
  const checkpoints = [{ sourceSeconds: 0.2, finalSeconds: 4.2, color: [0, 0, 255] },
    { sourceSeconds: 3.8, finalSeconds: 7.8, color: [255, 255, 0] }].map((checkpoint) => {
    const expected = [...frame(sourcePaths[1]!, checkpoint.sourceSeconds)], actual = [...frame(finalPath, checkpoint.finalSeconds)]
    expect(expected).toHaveLength(3); expect(actual).toHaveLength(3)
    for (const channel of [0, 1, 2]) {
      expect(Math.abs(expected[channel]! - checkpoint.color[channel]!)).toBeLessThanOrEqual(5)
      expect(Math.abs(actual[channel]! - expected[channel]!)).toBeLessThanOrEqual(5)
    }
    return { ...checkpoint, expected, actual }
  })
  expect(posts).toHaveLength(2)
  expect(new Set(queries)).toEqual(new Set(['/harness/v1/tasks/boundary-task-1', '/harness/v1/tasks/boundary-task-2']))
  expect(downloads.toSorted()).toEqual(['/harness/v1/videos/boundary-task-1/content', '/harness/v1/videos/boundary-task-2/content'])
  expect(modelRequests).toHaveLength(3); expect(errors).toEqual([])
  const manifestPath = join(credits, 'video-projects', text(start.project_id), 'manifest.json')
  const manifest = object(JSON.parse(await readFile(manifestPath, 'utf8')))
  expect(manifest).toMatchObject({ status: 'completed', finalPath, finalDurationSeconds: 8 })
  expect((manifest.segments as unknown[]).map(value => object(value).durationSeconds)).toEqual([4, 4])
  const localFinalPath = text(manifest.composedPath)
  expect(localFinalPath.startsWith(workspace + sep)).toBe(true)
  expect(digest(await readFile(localFinalPath))).toBe(digest(await readFile(finalPath)))
  const projectionResponse = await fetch(new URL(`/credits/api/creative/projects?session_id=${sessionId}`, host.webUrl), {
    headers: { cookie: host.cookie }, signal: AbortSignal.timeout(10000),
  })
  expect(projectionResponse.ok).toBe(true)
  const projects = object(object(await projectionResponse.json()).payload).projects as unknown[]
  const projectView = projects.map(object).find(project => project.id === start.plan_id)
  if (projectView === undefined) throw new Error('Expected the original public project projection')
  const previewContent = new Map<string, Buffer[]>()
  for (const role of ['clip_1', 'clip_2', 'final']) {
    const output = (projectView.outputs as unknown[]).map(object).find(value => value.id === `${text(start.operation_id)}_${role}`)
    if (output === undefined) throw new Error('Expected every actual output in the public project projection')
    const frames = (output.frames as unknown[]).map(object)
    expect(frames).toHaveLength(3)
    const bytes: Buffer[] = []
    for (const [index, value] of frames.entries()) {
      const url = new URL(text(value.url), host.webUrl)
      expect(url.pathname).toBe('/credits/api/creative/media')
      expect(url.searchParams.get('session_id')).toBe(sessionId)
      expect(url.searchParams.get('project_id')).toBe(start.plan_id)
      expect(url.searchParams.get('output_id')).toBe(output.id)
      expect(url.searchParams.get('frame')).toBe(String(index))
      const response = await fetch(url, { headers: { cookie: host.cookie }, signal: AbortSignal.timeout(10000) })
      expect(response.ok).toBe(true)
      bytes.push(Buffer.from(await response.arrayBuffer()))
    }
    previewContent.set(role, bytes)
  }
  await host.stop()
  const originalWorkspace = await captureWorkspaceSnapshot(workspace)
  const previewDirectories = new Map<string, Map<string, Buffer>>()
  for (const entry of originalWorkspace) {
    const preview = /^\.yunshu-creative\/previews\/(op_[a-f0-9-]{36})\/(frames-[A-Za-z0-9]{6})\/(frame-[0-2]\.jpg)$/u.exec(entry.path)
    if (preview === null) continue
    expect(preview[1]).toBe(start.operation_id)
    if (entry.kind !== 'binary') throw new Error('Expected original JPEG bytes')
    const directory = preview[2]!, frames = previewDirectories.get(directory) ?? new Map<string, Buffer>()
    frames.set(preview[3]!, Buffer.from(entry.base64, 'base64')); previewDirectories.set(directory, frames)
  }
  expect(previewDirectories.size).toBe(3)
  const previewRoles = new Map<string, string>()
  for (const [role, frames] of previewContent) {
    const matches = [...previewDirectories].filter(([_directory, candidates]) => candidates.size === 3
      && frames.every((bytes, index) => candidates.get(`frame-${String(index)}.jpg`)?.equals(bytes)))
    expect(matches, 'the complete public three-frame tuple identifies one retained directory').toHaveLength(1)
    previewRoles.set(matches[0]![0], role)
  }
  expect(previewRoles.size).toBe(3)
  const sourceByPath = new Map<string, string>()
  const nativeRelativeFinal = relative(workspace, localFinalPath).split(sep).join('/')
  const actualWorkspace = originalWorkspace.map((entry) => {
    const preview = /^\.yunshu-creative\/previews\/(op_[a-f0-9-]{36})\/(frames-[A-Za-z0-9]{6})\/(frame-[0-2]\.jpg)$/u.exec(entry.path)
    let path = entry.path === nativeRelativeFinal ? 'renders/project-1/final.mp4' : entry.path
    if (preview !== null) {
      const role = previewRoles.get(preview[2]!)
      if (role === undefined) throw new Error('Expected the exact publicly captured preview directory')
      path = `.yunshu-creative/previews/operation-1/${role}/${preview[3]!}`
    }
    sourceByPath.set(path, join(workspace, entry.path))
    return { ...entry, path }
  }).toSorted((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  const expectedDirectory = join(SNAPSHOT_DIR, 'workspace.expected')
  const mediaRelativePath = 'renders/project-1/final.mp4'
  if (!existsSync(expectedDirectory)) {
    if (mode !== 'refresh' || process.env.DSH_VIDEO_BOUNDARY_INITIALIZE_ORACLE !== '1') {
      throw new Error('Initialize this new independent workspace oracle explicitly once; refresh never replaces an existing oracle')
    }
    expect(actualWorkspace.map(entry => ({ path: entry.path, kind: entry.kind })))
      .toEqual([...['clip_1', 'clip_2', 'final'].flatMap(role => Array.from({ length: 3 }, (_value, index) => ({
        path: `.yunshu-creative/previews/operation-1/${role}/frame-${String(index)}.jpg`, kind: 'binary',
      }))), { path: mediaRelativePath, kind: 'binary' }])
    for (const entry of actualWorkspace) {
      const source = sourceByPath.get(entry.path)
      if (source === undefined) throw new Error('Expected the captured original workspace path')
      const destination = join(expectedDirectory, entry.path)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source, destination)
    }
  }
  const expectedWorkspace = await captureExpectedWorkspaceSnapshot(expectedDirectory)
  const previewComparisons = ['clip_1', 'clip_2', 'final'].flatMap(role => Array.from({ length: 3 }, (_value, index) => {
    const path = `.yunshu-creative/previews/operation-1/${role}/frame-${String(index)}.jpg`
    const actualPath = sourceByPath.get(path)
    if (actualPath === undefined) throw new Error('Expected each exact captured preview path')
    return { path, actualPath, expectedPath: join(expectedDirectory, path) }
  }))
  const decodedWorkspace = assertCompleteDecodedMediaWorkspace(actualWorkspace,
    expectedWorkspace, mediaRelativePath, localFinalPath,
    join(expectedDirectory, mediaRelativePath), ffmpeg, ffprobe, previewComparisons)
  const remux = join(root, 'equivalent-remux.mp4'), wrong = join(root, 'wrong-boundary-8s.mp4')
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', join(expectedDirectory, mediaRelativePath),
    '-map', '0', '-c', 'copy', '-metadata', 'title=clip-boundary-equivalent-remux', '-movflags', '+faststart', remux], { timeout: 30000 })
  const remuxBytes = await readFile(remux)
  expect(remuxBytes.equals(await readFile(join(expectedDirectory, mediaRelativePath)))).toBe(false)
  const controlTree = (bytes: Buffer): WorkspaceSnapshotEntry[] => actualWorkspace.map(entry => entry.path === mediaRelativePath
    ? { path: entry.path, kind: 'binary', base64: bytes.toString('base64') } : entry)
  const equivalentControl = assertCompleteDecodedMediaWorkspace(controlTree(remuxBytes), expectedWorkspace,
    mediaRelativePath, remux, join(expectedDirectory, mediaRelativePath), ffmpeg, ffprobe, previewComparisons)
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', sourcePaths[0]!, '-i', sourcePaths[1]!,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-filter_complex',
    '[0:v:0][1:v:0]concat=n=2:v=1:a=0,fps=10,format=yuv420p[v]', '-map', '[v]', '-map', '2:a:0', '-t', '8', '-r', '10',
    '-fps_mode', 'cfr', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', wrong],
  { timeout: 30000 })
  const wrongBytes = await readFile(wrong)
  expect(Number(object(probe(wrong).format).duration)).toBeCloseTo(8, 2)
  expect(() => assertCompleteDecodedMediaWorkspace(controlTree(wrongBytes), expectedWorkspace,
    mediaRelativePath, wrong, join(expectedDirectory, mediaRelativePath), ffmpeg, ffprobe, previewComparisons))
    .toThrow('Decoded video pixels differ')
  const normalized = normalizeProject(normalizeWebSessionVolatiles(raw), start, [finalPath, ...clipPaths])
  const context = { sessionIds: [sessionId], cwd: workspace }
  const prompts = normalizedSystemPrompts(normalized, context)
    .map(value => value.split(REPO_ROOT).join('{{sourceRoot}}').split(host.webUrl).join('{{webUrl}}'))
  const schemas = normalizedToolSchemas(normalized, context)
  const promptSidecar = formatSystemPromptSnapshot(prompts[0]!, prompts.slice(1))
  const schemaSidecar = formatToolSchemasSnapshot(schemas[0]!, schemas.slice(1))
  const evidence = process.env.DSH_VIDEO_BOUNDARY_EVIDENCE_DIRECTORY
  if (evidence !== undefined) {
    await mkdir(evidence, { recursive: true })
    for (const [index, path] of sourcePaths.entries()) await copyFile(path, join(evidence, `source-${String(index + 1)}.mp4`))
    await copyFile(finalPath, join(evidence, 'final-8s.mp4'))
    await writeFile(join(evidence, 'result.json'), JSON.stringify({ mode, sourceDurations: sourcePaths.map(path => Number(object(probe(path).format).duration)),
      finalDuration: Number(object(metadata.format).duration), checkpoints, posts, queries, downloads,
      finalHash: digest(await readFile(finalPath)),
      workspacePaths: actualWorkspace.map(entry => entry.path), localFinalPath: relative(workspace, localFinalPath), decodedWorkspace,
      equivalentControl, byteDifferentRemuxAccepted: true, wrongBoundaryRejectedByPixels: true,
      realUpstreamCalls: 0, paidCalls: 0 }, null, 2) + '\n')
  }
  if (mode === 'refresh') {
    await writeFile(FIXTURE, redactSessionSnapshotIds([scrubSessionSnapshot(tokenizeSessionFixtureCwd(normalized))])[0]!)
    await writeFile(join(SNAPSHOT_DIR, 'system-prompt.expected.md'), promptSidecar)
    await writeFile(join(SNAPSHOT_DIR, 'tool-schemas.expected.json'), schemaSidecar)
  }
  const expected = await readFile(FIXTURE, 'utf8')
  expect(normalizeSessionSnapshots([normalized], context)[0]).toBe(normalizeSessionSnapshots([expected], fixtureContext(expected))[0])
  expect(promptSidecar).toBe(await readFile(join(SNAPSHOT_DIR, 'system-prompt.expected.md'), 'utf8'))
  expect(schemaSidecar).toBe(await readFile(join(SNAPSHOT_DIR, 'tool-schemas.expected.json'), 'utf8'))
})
