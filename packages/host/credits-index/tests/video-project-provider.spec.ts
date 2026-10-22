/** Real local HTTP exercises account credentials, bounded content, and request cleanup. */
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVideoProjectRelay, VideoRelayError, type VideoRelayOptions } from '../src/video-project-provider.ts'

interface RecordedRequest {
  path: string
  method: string
  authorization: string | undefined
  clientSource: string | string[] | undefined
  contentType: string | undefined
  body: string
}

type Handler = (request: IncomingMessage, response: ServerResponse, recorded: RecordedRequest) => void | Promise<void>
const servers: Server[] = []
const directories: string[] = []
const media = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 109, 112, 52, 50])
const signal = (): AbortSignal => new AbortController().signal

function latch() {
  let wake: (() => void) | undefined
  const promise = new Promise<void>((resolve) => { wake = resolve })
  return { promise, resolve: () => { wake?.() } }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    server.closeAllConnections()
  })))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function upstream(handler: Handler) {
  const calls: RecordedRequest[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const recorded = {
        path: request.url ?? '/', method: request.method ?? 'GET',
        authorization: request.headers.authorization, clientSource: request.headers['x-yunshu-client'],
        contentType: request.headers['content-type'], body: Buffer.concat(chunks).toString('utf8'),
      }
      calls.push(recorded)
      await handler(request, response, recorded)
    })().catch((error: unknown) => { response.destroy(error instanceof Error ? error : undefined) })
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a local upstream port')
  return { origin: `http://127.0.0.1:${String(address.port)}`, calls }
}

async function fixture(handler: Handler, overrides: Partial<Omit<VideoRelayOptions, 'origin' | 'cacheRoot'>> = {}, prefix = '') {
  const source = await upstream(handler)
  const root = await mkdtemp(join(tmpdir(), 'dsh-video-relay-'))
  directories.push(root)
  const cacheRoot = join(root, 'private-cache')
  await mkdir(cacheRoot, { mode: 0o700 })
  const key = vi.fn(async () => `account-key-${String(key.mock.calls.length)}`)
  const relay = createVideoProjectRelay({
    origin: source.origin + prefix, timeoutMs: 1000, submitTimeoutMs: overrides.timeoutMs ?? 1000, maxDownloadBytes: 1024,
    cacheRoot, key, ...overrides,
  })
  return { ...source, root, cacheRoot, key, relay, destination: join(cacheRoot, 'clip.mp4') }
}

function json(response: ServerResponse, value: unknown): void {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(value))
}

function finishAfter(response: ServerResponse, bytes: string | Buffer, delayMs: number): void {
  const timer = setTimeout(() => { response.end(bytes) }, delayMs)
  response.once('close', () => { clearTimeout(timer) })
}

async function rejection(operation: Promise<unknown>): Promise<Error> {
  try { await operation } catch (error) {
    if (error instanceof Error) return error
    throw new Error('Expected a structured operation failure')
  }
  throw new Error('Expected the operation to fail')
}

describe('account-bound video relay requests', () => {
  it.each([
    { status: 429, body: { code: 'h3_account_capacity_exhausted', data: null, submission_state: 'not_submitted', retryable: false, resubmittable: true },
      code: 'H3_ACCOUNT_CAPACITY_EXHAUSTED', state: 'not_submitted', taskId: undefined },
    { status: 502, body: { code: 'h3_upstream_auth_rejected', data: null, submission_state: 'failed', id: 'failed-h3-task', task_id: 'failed-h3-task',
      refund_confirmed: true, retryable: false, resubmittable: false }, code: 'H3_UPSTREAM_AUTH_REJECTED', state: 'failed', taskId: 'failed-h3-task' },
  ])('reads a complete H3 $status settlement through real HTTP without retrying or exposing supplier text', async ({ status, body, code, state, taskId }) => {
    const f = await fixture((_request, response) => {
      response.statusCode = status
      response.setHeader('x-new-api-task-id', 'untrusted-header-task')
      json(response, { ...body, message: 'private supplier credentials' })
    })
    const error = await rejection(f.relay.submit({ model: 'MiniMax-H3' }, '/v1/video/generations', signal()))
    expect(error).toMatchObject({ code, submissionState: state })
    expect(error).toHaveProperty('taskId', taskId)
    expect(error.message).not.toContain('private')
    expect(f.calls).toHaveLength(1)
  })

  it.each([
    { status: 429, body: { code: 'h3_account_capacity_exhausted', data: null, submission_state: 'unknown', retryable: false, resubmittable: true }, code: 'VIDEO_SUBMIT_BUSY' },
    { status: 502, body: { code: 'h3_upstream_auth_rejected', data: null, submission_state: 'failed', refund_confirmed: false, retryable: false, resubmittable: false }, code: 'VIDEO_SUBMIT_REJECTED' },
  ])('does not classify a partial H3 $status response as confirmed settlement', async ({ status, body, code }) => {
    const f = await fixture((_request, response) => { response.statusCode = status; json(response, body) })
    await expect(f.relay.submit({ model: 'MiniMax-H3' }, '/v1/video/generations', signal())).rejects.toMatchObject({ code })
    expect(f.calls).toHaveLength(1)
  })

  it('retains an H3 unknown 202 id and only reads the original task during recovery', async () => {
    let complete = false
    const unknown = { id: 'h3-original-task', task_id: 'h3-original-task', status: 'unknown', submission_state: 'unknown',
      resubmittable: false, retryable: false, code: 'h3_submission_unknown' }
    const f = await fixture((request, response) => {
      if (request.method === 'POST') { response.statusCode = 202; json(response, unknown) }
      else json(response, complete ? { id: 'h3-original-task', status: 'completed' } : unknown)
    })
    expect(await f.relay.submit({ model: 'MiniMax-H3', duration: 5 }, '/v1/video/generations', signal())).toEqual({ taskId: 'h3-original-task' })
    await expect(f.relay.check('h3-original-task', '/v1/video/generations', signal())).rejects.toMatchObject({ code: 'VIDEO_STATUS_INVALID' })
    complete = true
    expect(await f.relay.check('h3-original-task', '/v1/video/generations', signal())).toEqual({ status: 'succeeded' })
    expect(f.calls.map(call => [call.method, call.path])).toEqual([
      ['POST', '/v1/video/generations'], ['GET', '/v1/video/generations/h3-original-task'], ['GET', '/v1/video/generations/h3-original-task'],
    ])
  })

  it.each([undefined, 'desktop'] as const)('sends the optional %s source only to fixed video task endpoints', async (clientSource) => {
    const remote = await upstream((_request, response) => { response.end(media) })
    const f = await fixture((_request, response, recorded) => {
      if (recorded.path === '/v1/models') json(response, { data: [{ id: 'video-a' }] })
      else if (recorded.path === '/v1/videos') json(response, { task_id: 'source-task' })
      else if (recorded.path.endsWith('/content')) response.end(media)
      else json(response, { status: 'completed', result_url: remote.origin + '/private.mp4' })
    }, { clientSource })
    expect(await f.relay.modelIds(signal())).toEqual(['video-a'])
    expect(await f.relay.submit({ model: 'video-a', seconds: 4 }, '/v1/videos', signal())).toEqual({ taskId: 'source-task' })
    expect(await f.relay.check('source-task', '/v1/videos', signal())).toEqual({ status: 'succeeded' })
    await f.relay.download('source-task', f.destination, signal())
    expect(f.calls.map(call => call.clientSource)).toEqual([undefined, clientSource, clientSource, clientSource])
    expect(f.calls[1]).toMatchObject({ contentType: 'application/json', body: JSON.stringify({ model: 'video-a', seconds: 4 }) })
    expect(f.calls.every(call => call.authorization?.startsWith('Bearer account-key-'))).toBe(true)
    expect(await readFile(f.destination)).toEqual(media)
    expect(remote.calls).toEqual([])
  })

  it('keeps the Desktop source and credentials at the configured API when content redirects', async () => {
    const remote = await upstream((_request, response) => { response.end(media) })
    const f = await fixture((_request, response) => {
      response.writeHead(307, { location: remote.origin + '/private.mp4' }); response.end()
    }, { clientSource: 'desktop' })
    await expect(f.relay.download('source-task', f.destination, signal())).rejects.toMatchObject({ code: 'VIDEO_READ_UNAVAILABLE' })
    expect(f.calls).toMatchObject([{ path: '/v1/videos/source-task/content', clientSource: 'desktop', authorization: 'Bearer account-key-1' }])
    expect(remote.calls).toEqual([])
    expect(await readdir(f.cacheRoot)).toEqual([])
  })

  it('preserves the Desktop source alongside fetch-owned multipart content headers', async () => {
    const f = await fixture((_request, response) => { json(response, { task_id: 'reference-task' }) }, { clientSource: 'desktop' })
    await f.relay.submit({ model: 'model_5', prompt: 'A cup', seconds: 4, size: '1280x720', n: 1, gen_type: 'reference_to_video',
      _blackrxReferences: [{ kind: 'image', mediaType: 'image/png', filename: 'reference.png', base64: Buffer.from('fixture image').toString('base64') }] }, '/v1/videos', signal())
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]?.clientSource).toBe('desktop')
    expect(f.calls[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/u)
    expect(f.calls[0]?.body).toContain('name="images"; filename="reference.png"')
    expect(f.calls[0]?.body).not.toContain('x-yunshu-client')
  })

  it.each([
    [{ error: { code: 'insufficient_user_quota', type: 'new_api_error' } }, 'INSUFFICIENT_BALANCE'],
    [{ error: { code: 'insufficient_user_quota', type: 'invalid_request_error' } }, 'INSUFFICIENT_BALANCE'],
    [{ code: 'insufficient_user_quota' }, 'INSUFFICIENT_BALANCE'],
    [{ error: { code: 'insufficient_quota', type: 'upstream_error' } }, 'VIDEO_SUBMIT_REJECTED'],
    [{ code: 'permission_denied', message: 'insufficient balance' }, 'VIDEO_SUBMIT_REJECTED'],
    [{ error: { code: 'pre_consume_token_quota_failed', type: 'new_api_error' } }, 'VIDEO_SUBMIT_REJECTED'],
  ])('classifies only gateway user funding rejection, without repeating the paid POST', async (body, code) => {
    const f = await fixture((_request, response) => { response.statusCode = 403; json(response, body) })
    await expect(f.relay.submit({ model: 'MiniMax-H3' }, '/v1/video/generations', signal())).rejects.toMatchObject({ code })
    expect(f.calls).toHaveLength(1)
    expect(await readdir(f.cacheRoot)).toEqual([])
  })
  it.each([
    'http://relay.example', 'https://user:secret@relay.example', 'https://8.133.202.230',
    'https://relay.example?credential=secret', 'https://relay.example#private', 'ftp://relay.example',
  ])('rejects an untrusted or non-origin relay configuration (%s)', (origin) => {
    const key = vi.fn(async () => 'unused-key')
    expect(() => createVideoProjectRelay({
      origin, timeoutMs: 1000, maxDownloadBytes: 1024, cacheRoot: '/unused', key,
    })).toThrow(VideoRelayError)
    expect(key).not.toHaveBeenCalled()
  })

  it('retains /harness for catalog, submission, status and content requests', async () => {
    const f = await fixture((_request, response, recorded) => {
      if (recorded.path === '/harness/v1/models') json(response, { data: [{ id: 'video-a' }] })
      else if (recorded.path === '/harness/v1/video/generations') json(response, { code: 'success', data: { task_id: 'task-one' } })
      else if (recorded.path === '/harness/v1/video/generations/task-one') json(response, { code: 'success', data: { status: 'SUCCESS', result_url: 'https://ignored.invalid/content.mp4' } })
      else if (recorded.path === '/harness/v1/videos/task-one/content') response.end(media)
      else { response.writeHead(404); response.end() }
    }, {}, '/harness')
    expect(await f.relay.modelIds(signal())).toEqual(['video-a'])
    await f.relay.submit({ model: 'MiniMax-H3' }, '/v1/video/generations', signal())
    expect(await f.relay.check('task-one', '/v1/video/generations', signal())).toEqual({ status: 'succeeded' })
    await f.relay.download('task-one', f.destination, signal())
    expect(f.calls.map(call => call.path)).toEqual([
      '/harness/v1/models', '/harness/v1/video/generations', '/harness/v1/video/generations/task-one', '/harness/v1/videos/task-one/content',
    ])
  })

  it('rejects a same-origin redirect from /harness to the adjacent root API', async () => {
    const f = await fixture((_request, response) => {
      response.writeHead(307, { location: '/v1/models' }); response.end()
    }, {}, '/harness')
    await expect(f.relay.modelIds(signal())).rejects.toBeInstanceOf(VideoRelayError)
    expect(f.calls.map(call => call.path)).toEqual(['/harness/v1/models'])
  })

  it('resolves a fresh account key for each request and uses only the fixed model/task/content endpoints', async () => {
    const f = await fixture((_request, response, recorded) => {
      if (recorded.path === '/v1/models') json(response, { data: [{ id: 'video-a' }, { id: '' }, null, { id: 3 }, { id: 'x'.repeat(257) }, { id: 'video-b' }] })
      else if (recorded.path === '/v1/videos') json(response, { data: { task_id: 'task:first' } })
      else if (recorded.path.endsWith('/content')) { response.setHeader('content-type', 'video/mp4'); response.end(media) }
      else json(response, { data: { status: 'completed' } })
    })
    expect(await f.relay.modelIds(signal())).toEqual(['video-a', 'video-b'])
    expect(await f.relay.submit({ model: 'video-a', prompt: 'A cup', duration: 15 }, '/v1/videos', signal())).toEqual({ taskId: 'task:first' })
    expect(await f.relay.check('task:first', '/v1/videos', signal())).toEqual({ status: 'succeeded' })
    await f.relay.download('task:first', f.destination, signal())
    expect(f.calls.map(call => [call.method, call.path])).toEqual([
      ['GET', '/v1/models'], ['POST', '/v1/videos'], ['GET', '/v1/videos/task%3Afirst'], ['GET', '/v1/videos/task%3Afirst/content'],
    ])
    expect(f.calls.map(call => call.authorization)).toEqual([1, 2, 3, 4].map(index => `Bearer account-key-${String(index)}`))
    expect(JSON.parse(f.calls[1]?.body ?? 'null')).toEqual({ model: 'video-a', prompt: 'A cup', duration: 15 })
    expect(await readFile(f.destination)).toEqual(media)
    expect(await readdir(f.cacheRoot)).toEqual(['clip.mp4'])
    if (process.platform !== 'win32') expect((await stat(f.destination)).mode & 0o777).toBe(0o600)
  })

  it.each([
    ['NOT_START', 'queued'], ['SUBMITTED', 'queued'], ['QUEUED', 'queued'], ['IN_PROGRESS', 'running'], ['SUCCESS', 'succeeded'], ['FAILURE', 'failed'],
    ['pending', 'queued'], ['in_queue', 'queued'], ['created', 'queued'], ['queued', 'queued'], ['processing', 'running'],
    ['generating', 'running'], ['succeeded', 'succeeded'], ['completed', 'succeeded'], ['failed', 'failed'], ['cancelled', 'failed'],
  ] as const)('projects %s as %s without returning upstream messages', async (upstreamStatus, expected) => {
    const f = await fixture((_request, response) => { json(response, { task_status: upstreamStatus, message: 'secret-upstream-body' }) })
    const result = await f.relay.check('task-one', '/v1/videos', signal())
    expect(result.status).toBe(expected)
    expect(JSON.stringify(result)).not.toContain('secret-upstream-body')
  })

  it('does not claim acceptance or queue admission after a throttled POST without a task id', async () => {
    const f = await fixture((_request, response) => { response.writeHead(429); response.end('private rate-limit detail') })
    const error = await rejection(f.relay.submit({ model: 'video-a' }, '/v1/videos', signal()))
    expect(error).toMatchObject({ code: 'VIDEO_SUBMIT_BUSY' })
    expect(error.message).toContain('繁忙')
    expect(error.message).toContain('提交结果尚未确认')
    expect(error.message).not.toContain('排队')
    expect(error.message).not.toContain('private')
    expect(f.calls.map(call => call.method)).toEqual(['POST'])
  })

  it('refuses an unknown task state rather than treating it as successful or starting another submission', async () => {
    const f = await fixture((_request, response) => { json(response, { status: 'unexpected', message: 'secret-upstream-body' }) })
    const error = await rejection(f.relay.check('task-one', '/v1/videos', signal()))
    expect(error).toMatchObject({ code: 'VIDEO_STATUS_INVALID' })
    expect(error.message).not.toContain('secret-upstream-body')
    expect(f.calls.map(call => call.method)).toEqual(['GET'])
  })

  it.each([{ data: {} }, { id: '' }, { task_id: '../escape' }, { id: '..' }, { data: { task_id: '.' } }])(
    'keeps a successful POST with no usable task id uncertain and never retries (%j)', async (body) => {
      const f = await fixture((_request, response) => { json(response, body) })
      await expect(f.relay.submit({ model: 'video-a', prompt: 'A cup' }, '/v1/videos', signal())).rejects.toMatchObject({ code: 'VIDEO_SUBMIT_UNKNOWN' })
      expect(f.calls).toHaveLength(1)
      expect(f.calls[0]?.method).toBe('POST')
    },
  )

  it('does not automatically repeat a paid POST after a connection drops', async () => {
    const f = await fixture((_request, response) => { response.destroy() })
    const error = await rejection(f.relay.submit({ model: 'video-a', prompt: 'A cup' }, '/v1/videos', signal()))
    expect(error).toMatchObject({ code: 'VIDEO_SUBMIT_UNKNOWN' })
    expect(error.message).toContain('可能已计费')
    expect(f.calls.map(call => call.method)).toEqual(['POST'])
    expect(f.key).toHaveBeenCalledTimes(1)
  })

  it.each(['modelIds', 'submit', 'check', 'download'] as const)('rejects %s redirects without sending credentials to another origin', async (method) => {
    const sink = await upstream((_request, response) => { response.end(media) })
    const f = await fixture((_request, response) => {
      response.writeHead(307, { location: sink.origin + '/private-content' })
      response.end()
    })
    const operation = method === 'modelIds' ? f.relay.modelIds(signal())
      : method === 'submit' ? f.relay.submit({ model: 'video-a' }, '/v1/videos', signal())
        : method === 'check' ? f.relay.check('task-one', '/v1/videos', signal()) : f.relay.download('task-one', f.destination, signal())
    await expect(operation).rejects.toBeInstanceOf(VideoRelayError)
    expect(f.calls).toHaveLength(1)
    expect(sink.calls).toEqual([])
    expect(await readdir(f.cacheRoot)).toEqual([])
  })

  it('ignores URLs inside status and downloads only through the original origin content endpoint', async () => {
    const sink = await upstream((_request, response) => { response.end(media) })
    const f = await fixture((_request, response, recorded) => {
      if (recorded.path.endsWith('/content')) response.end(media)
      else json(response, { status: 'completed', url: sink.origin + '/leak', data: { video_url: sink.origin + '/another-leak' } })
    })
    expect(await f.relay.check('task-one', '/v1/videos', signal())).toEqual({ status: 'succeeded' })
    await f.relay.download('task-one', f.destination, signal())
    expect(f.calls.map(call => call.path)).toEqual(['/v1/videos/task-one', '/v1/videos/task-one/content'])
    expect(sink.calls).toEqual([])
    expect(await readFile(f.destination)).toEqual(media)
  })

  it.each([403, 500])('contains an upstream HTTP %s without exposing its body, credentials or URL', async (status) => {
    const f = await fixture((_request, response) => { response.writeHead(status); response.end('secret-account-key remote-stack https://private.invalid/path') })
    for (const operation of [
      () => f.relay.modelIds(signal()), () => f.relay.submit({ prompt: 'A cup' }, '/v1/videos', signal()),
      () => f.relay.check('task-one', '/v1/videos', signal()), () => f.relay.download('task-one', f.destination, signal()),
    ]) {
      const error = await rejection(operation())
      expect(error).toBeInstanceOf(VideoRelayError)
      expect(error.message).not.toMatch(/secret-account-key|remote-stack|private\.invalid|Bearer/u)
    }
    expect(f.calls).toHaveLength(4)
    expect(await readdir(f.cacheRoot)).toEqual([])
  })

  it('stops before networking when the fresh account key cannot be resolved', async () => {
    const accountChanged = new Error('Account changed')
    const key = vi.fn(async (): Promise<string> => { throw accountChanged })
    const f = await fixture((_request, response) => { json(response, {}) }, { key })
    await expect(f.relay.submit({ prompt: 'A cup' }, '/v1/videos', signal())).rejects.toBe(accountChanged)
    expect(key).toHaveBeenCalledTimes(1)
    expect(f.calls).toEqual([])
  })

  it('cancels an oversized JSON response instead of buffering an unbounded model catalog', async () => {
    let closed = false
    const f = await fixture((_request, response) => {
      response.on('close', () => { closed = true })
      response.write('{"data":"' + 'x'.repeat(262_145))
    })
    await expect(f.relay.modelIds(signal())).rejects.toMatchObject({ code: 'VIDEO_RESPONSE_LIMIT' })
    await vi.waitFor(() => { expect(closed).toBe(true) })
    expect(f.calls).toHaveLength(1)
  })
})

describe('bounded private video downloads', () => {
  it.each(['declared', 'streamed'] as const)('stops a %s oversized file, closes the stream, and removes every partial file', async (mode) => {
    let closed = false
    const f = await fixture((_request, response) => {
      response.on('close', () => { closed = true })
      if (mode === 'declared') response.setHeader('content-length', 1000)
      response.write(Buffer.concat([media, Buffer.alloc(64)]))
    }, { maxDownloadBytes: 32 })
    await expect(f.relay.download('task-one', f.destination, signal())).rejects.toMatchObject({ code: 'VIDEO_CONTENT_LIMIT' })
    await vi.waitFor(() => { expect(closed).toBe(true) })
    expect(await readdir(f.cacheRoot)).toEqual([])
  })

  it.each([Buffer.alloc(0), Buffer.from('not a video file'), Buffer.from([0, 0, 0, 8, 102, 116, 121, 112])])(
    'rejects malformed or truncated video bytes without publishing a destination (%j)', async (bytes) => {
      const f = await fixture((_request, response) => { response.end(bytes) })
      await expect(f.relay.download('task-one', f.destination, signal())).rejects.toMatchObject({ code: 'VIDEO_CONTENT_INVALID' })
      expect(await readdir(f.cacheRoot)).toEqual([])
    },
  )

  it('preserves an existing destination and removes the failed promotion temporary file', async () => {
    const f = await fixture((_request, response) => { response.end(media) })
    await writeFile(f.destination, 'already saved clip', { mode: 0o600 })
    await expect(f.relay.download('task-one', f.destination, signal())).rejects.toThrow()
    expect(await readFile(f.destination, 'utf8')).toBe('already saved clip')
    expect(await readdir(f.cacheRoot)).toEqual(['clip.mp4'])
  })

  it('rejects cache escapes and symlinked destination parents before resolving an account key', async () => {
    const f = await fixture((_request, response) => { response.end(media) })
    const linkedParent = join(f.cacheRoot, 'linked')
    await symlink(f.root, linkedParent, process.platform === 'win32' ? 'junction' : 'dir')
    for (const destination of [join(f.root, 'outside.mp4'), join(f.cacheRoot, '..', 'traversal.mp4'), join(linkedParent, 'linked.mp4')]) {
      await expect(f.relay.download('task-one', destination, signal())).rejects.toMatchObject({ code: 'VIDEO_OUTPUT_UNSAFE' })
    }
    expect(f.calls).toEqual([])
    expect(f.key).not.toHaveBeenCalled()
    expect(await readdir(f.cacheRoot)).toEqual(['linked'])
  })

  it.each(['..', '.', 'bad/task', 'task?secret=yes', 'task#fragment'])('rejects unsafe task id %s before any download request', async (taskId) => {
    const f = await fixture((_request, response) => { response.end(media) })
    await expect(f.relay.download(taskId, f.destination, signal())).rejects.toMatchObject({ code: 'VIDEO_TASK_INVALID' })
    expect(f.calls).toEqual([])
    expect(f.key).not.toHaveBeenCalled()
    expect(await readdir(f.cacheRoot)).toEqual([])
  })

  it('removes partial media after an upstream connection closes mid-download', async () => {
    const received = latch()
    const disconnect = latch()
    const f = await fixture(async (_request, response) => {
      response.setHeader('content-length', media.length * 2)
      response.once('close', disconnect.resolve)
      response.write(media)
      received.resolve()
      await disconnect.promise
      response.destroy()
    })
    const operation = rejection(f.relay.download('task-one', f.destination, signal()))
    try {
      await received.promise
      await vi.waitFor(async () => { expect(await readdir(f.cacheRoot)).toHaveLength(1) })
      disconnect.resolve()
      const error = await operation
      expect(error).toBeInstanceOf(VideoRelayError)
      expect(error).toMatchObject({ code: 'VIDEO_DOWNLOAD_UNAVAILABLE' })
      expect(error.message).not.toMatch(/account-key|Bearer|https?:\/\//u)
      expect(await readdir(f.cacheRoot)).toEqual([])
      expect(f.calls).toHaveLength(1)
    } finally {
      disconnect.resolve()
      await operation
    }
  })

  it('cancels the content response if the validated cache parent becomes unavailable before opening a temporary file', async () => {
    let closed = false
    const f = await fixture(async (_request, response) => {
      response.on('close', () => { closed = true })
      await rename(f.cacheRoot, join(f.root, 'moved-cache'))
      await writeFile(f.cacheRoot, 'cache parent replaced')
      response.write(media)
    }, { timeoutMs: 5000 })
    await expect(f.relay.download('task-one', f.destination, signal())).rejects.toThrow()
    await vi.waitFor(() => { expect(closed).toBe(true) })
    expect(await readFile(f.cacheRoot, 'utf8')).toBe('cache parent replaced')
    expect(await readdir(join(f.root, 'moved-cache'))).toEqual([])
    expect(f.calls).toHaveLength(1)
  })
})

describe('relay cancellation and deadlines', () => {
  it('allows a complete content transfer to outlast the ordinary request deadline', async () => {
    const releaseContent = latch()
    const f = await fixture(async (_request, response, recorded) => {
      if (recorded.path.endsWith('/content')) {
        response.once('close', releaseContent.resolve)
        response.setHeader('content-type', 'video/mp4')
        response.write(media.subarray(0, 12))
        await releaseContent.promise
        response.end(media.subarray(12))
      } else {
        response.write('{"data":')
      }
    }, { timeoutMs: 100, downloadTimeoutMs: 10_000 })
    const controller = new AbortController()
    const operation = f.relay.download('task-one', f.destination, controller.signal).catch((error: unknown) => error)
    try {
      await vi.waitFor(async () => { expect(await readdir(f.cacheRoot)).toHaveLength(1) })
      // This complete request deadline elapses while the content body is held open.
      await expect(f.relay.modelIds(signal())).rejects.toThrow()
      releaseContent.resolve()
      expect(await operation).toBeUndefined()
      expect(await readFile(f.destination)).toEqual(media)
      expect(await readdir(f.cacheRoot)).toEqual(['clip.mp4'])
      expect(f.calls.map(call => call.path)).toEqual(['/v1/videos/task-one/content', '/v1/models'])
    } finally {
      controller.abort(new Error('Content fixture disposed'))
      releaseContent.resolve()
      await operation
    }
  })

  it.each(['modelIds', 'check'] as const)('keeps %s on the ordinary deadline when content transfers have a longer deadline', async (method) => {
    let closed = false
    const f = await fixture((_request, response) => {
      response.on('close', () => { closed = true })
      response.setHeader('content-type', 'application/json')
      response.write('{"data":')
      finishAfter(response, method === 'modelIds' ? '[{"id":"video-a"}]}' : '{"status":"SUCCESS"}}', 250)
    }, { timeoutMs: 100, downloadTimeoutMs: 800 })
    await expect(method === 'modelIds' ? f.relay.modelIds(signal()) : f.relay.check('task-one', '/v1/videos', signal())).rejects.toThrow()
    await vi.waitFor(() => { expect(closed).toBe(true) })
    expect(f.calls).toHaveLength(1)
    expect(await readdir(f.cacheRoot)).toEqual([])
  })

  it('still bounds a stalled transfer by its separate content deadline and removes the partial file', async () => {
    let closed = false
    const f = await fixture((_request, response) => {
      response.on('close', () => { closed = true })
      response.write(media)
    }, { timeoutMs: 100, downloadTimeoutMs: 200 })
    const error = await rejection(f.relay.download('task-one', f.destination, signal()))
    expect(error).toBeInstanceOf(VideoRelayError)
    expect(error).toMatchObject({ code: 'VIDEO_DOWNLOAD_UNAVAILABLE' })
    expect(error.message).not.toMatch(/account-key|Bearer|https?:\/\//u)
    await vi.waitFor(() => { expect(closed).toBe(true) })
    expect(f.calls).toHaveLength(1)
    expect(await readdir(f.cacheRoot)).toEqual([])
  })

  it.each(['modelIds', 'submit', 'download'] as const)('closes a stalled %s response on its deadline without retries or partial output', async (method) => {
    let closed = false
    const f = await fixture((_request, response) => {
      response.on('close', () => { closed = true })
      response.setHeader('content-type', method === 'download' ? 'video/mp4' : 'application/json')
      response.write(method === 'download' ? media : '{"data":')
    }, { timeoutMs: 200 })
    const operation = method === 'modelIds' ? f.relay.modelIds(signal())
      : method === 'submit' ? f.relay.submit({ prompt: 'A cup' }, '/v1/videos', signal()) : f.relay.download('task-one', f.destination, signal())
    const error = await rejection(operation)
    if (method === 'download') {
      expect(error).toBeInstanceOf(VideoRelayError)
      expect(error).toMatchObject({ code: 'VIDEO_DOWNLOAD_UNAVAILABLE' })
    }
    await vi.waitFor(() => { expect(closed).toBe(true) })
    expect(f.calls).toHaveLength(1)
    expect(await readdir(f.cacheRoot)).toEqual([])
  })

  it.each(['modelIds', 'download'] as const)('closes a stalled %s response when the caller cancels', async (method) => {
    const started = latch()
    let closed = false
    const f = await fixture((_request, response) => {
      response.on('close', () => { closed = true })
      response.write(method === 'download' ? media : '{"data":')
      started.resolve()
    })
    const controller = new AbortController()
    const operation = rejection(method === 'modelIds'
      ? f.relay.modelIds(controller.signal) : f.relay.download('task-one', f.destination, controller.signal))
    const stopped = new Error('Caller stopped')
    try {
      await started.promise
      if (method === 'download') await vi.waitFor(async () => { expect(await readdir(f.cacheRoot)).toHaveLength(1) })
      controller.abort(stopped)
      const error = await operation
      if (method === 'download') expect(error).toBe(stopped)
      await vi.waitFor(() => { expect(closed).toBe(true) })
      expect(f.calls).toHaveLength(1)
      expect(await readdir(f.cacheRoot)).toEqual([])
    } finally {
      controller.abort(stopped)
      await operation
    }
  })

  it('does not resolve a key or start a request for an already cancelled operation', async () => {
    const f = await fixture((_request, response) => { response.end(media) })
    const controller = new AbortController()
    const stopped = new Error('Already stopped')
    controller.abort(stopped)
    await expect(f.relay.modelIds(controller.signal)).rejects.toBe(stopped)
    await expect(f.relay.submit({ prompt: 'A cup' }, '/v1/videos', controller.signal)).rejects.toBe(stopped)
    expect(f.calls).toEqual([])
    expect(f.key).not.toHaveBeenCalled()
  })
})
