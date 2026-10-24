/** Only finite metadata reaches a bounded, non-blocking diagnostic transport. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientToolErrorReporter, parseClientToolError, type ClientToolErrorAccount, type ClientToolErrorReporterOptions } from '../src/client-tool-errors.ts'

const known = new Set(['MiniMax-H3', 'sd-20-9/3/3-1', 'yunshu-internal-gpt-image-2'])
const failure = { status: 'failed', code: 'DURATION_NOT_SUPPORTED' }
const reporters: ClientToolErrorReporter[] = []

function latch<T>() {
  let complete: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => { complete = resolve })
  return { promise, resolve: (value: T) => { complete?.(value) } }
}

afterEach(async () => {
  await Promise.all(reporters.splice(0).map(reporter => reporter.dispose()))
})

function fixture(overrides: Partial<ClientToolErrorReporterOptions> = {}) {
  const send = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }))
  const key = vi.fn(async () => ({ accountId: 'account-a', token: 'product-access-token' }))
  const reporter = new ClientToolErrorReporter({
    baseUrl: 'https://relay.example/harness', timeoutMs: 3000, key, knownModelIds: () => known, fetch: send, ...overrides,
  })
  reporters.push(reporter)
  const submit = (tool: string, args: unknown, value: unknown, invocation?: object, expectedAccountId = 'account-a'): void => {
    reporter.submit(tool, args, value, invocation, expectedAccountId)
  }
  return { reporter, send, key, submit }
}

describe('creation failure report selection', () => {
  it.each(['generate_video', 'generate_video_project', 'generate_image', 'generate_image_project'])('admits only a declared result from %s', (tool) => {
    expect(parseClientToolError(tool, { model: 'MiniMax-H3' }, failure, known)).toEqual({
      tool, code: 'DURATION_NOT_SUPPORTED', stage: 'preflight', model: 'MiniMax-H3',
    })
  })

  it.each([
    ['AUDIO_NOT_SUPPORTED', 'AUDIO_NOT_SUPPORTED', 'preflight'],
    ['SHOT_DURATION_UNSUPPORTED', 'SHOT_DURATION_UNSUPPORTED', 'preflight'],
    ['VIDEO_MODEL_UNAVAILABLE', 'MODEL_NOT_AVAILABLE', 'preflight'],
    ['CREATIVE_VIDEO_INTENT_UNAVAILABLE', 'CREATIVE_VIDEO_INTENT_UNAVAILABLE', 'preflight'],
    ['RESOLUTION_NOT_SUPPORTED', 'INVALID_ARGUMENT', 'preflight'],
    ['VIDEO_SUBMISSION_UNKNOWN', 'CREATIVE_SUBMISSION_UNKNOWN', 'submit'],
    ['SUBMISSION_UNKNOWN', 'CREATIVE_SUBMISSION_UNKNOWN', 'submit'],
    ['VIDEO_QUERY_TIMEOUT', 'TRANSPORT_TIMEOUT', 'query'],
    ['VIDEO_SUBMIT_TIMEOUT', 'TRANSPORT_TIMEOUT', 'submit'],
    ['VIDEO_TASK_TIMEOUT', 'QUEUE_WAIT_TIMEOUT', 'query'],
    ['PROVIDER_TASK_FAILED', 'TASK_FAILED', 'query'],
    ['PROJECT_STORAGE_FAILED', 'LOCAL_SAVE_FAILED', 'local-save'],
  ])('maps %s without parsing error prose', (source, code, stage) => {
    expect(parseClientToolError('generate_video', {}, { status: 'failed', code: source }, known))
      .toEqual({ tool: 'generate_video', code, stage })
  })

  it('reports a confirmed failed task even when the outer tool result is not an exception', () => {
    expect(parseClientToolError('generate_image', {}, { status: 'failed', code: 'TASK_FAILED', isError: false }, known))
      .toEqual({ tool: 'generate_image', code: 'TASK_FAILED', stage: 'query' })
  })

  it.each(['unknown', 'pending'])('does not count an unconfirmed %s task or preflight as a confirmed failure', (status) => {
    for (const code of ['TASK_FAILED', 'PROVIDER_TASK_FAILED', 'DURATION_NOT_SUPPORTED']) {
      expect(parseClientToolError('generate_image', {}, { status, code }, known)).toBeNull()
    }
  })

  it.each(['TRANSPORT', 'NETWORK', 'ECONNRESET', 'HTTP_408', 'HTTP_503', 'ABORTED', 'CANCELLED', 'PRIVATE_CODE'])(
    'never infers a task or server failure from the connection, status or cancellation code %s', (code) => {
      expect(parseClientToolError('generate_video', {}, {
        status: 'failed', code, message: 'server TASK_FAILED', source: 'server', serverFault: true,
      }, known)).toBeNull()
    },
  )

  it('never serializes content, association ids, user identity, time, headers or arbitrary fields', () => {
    const unsafe = { prompt: 'private prompt', path: 'C:\\private\\image.png', message: 'Bearer sk-secret',
      password: 'password', token: 'access-secret', request_id: 'unverified', task_id: 'unverified', user_id: 16,
      timestamp: 1792650000, stack: 'raw exception', raw_response: 'private', tool: 'pwsh', stage: 'submit' }
    const report = parseClientToolError('generate_video_project', { ...unsafe, model: 'MiniMax-H3' },
      { ...unsafe, status: 'failed', code: 'SHOT_DURATION_UNSUPPORTED', model: 'sd-20-9/3/3-1' }, known)
    expect(report).toEqual({ tool: 'generate_video_project', code: 'SHOT_DURATION_UNSUPPORTED', stage: 'preflight', model: 'sd-20-9/3/3-1' })
    expect(JSON.stringify(report)).not.toMatch(/private|secret|password|unverified|user_id|timestamp|request_id|task_id/u)
  })

  it('reports an unavailable video authorization without leaking the retained request or blaming the server', () => {
    const report = parseClientToolError('generate_video_project', { model: 'MiniMax-H3', prompt: 'private request' }, {
      status: 'failed', code: 'CREATIVE_VIDEO_INTENT_UNAVAILABLE', message: 'private legacy evidence',
      requestGrant: { messageId: 'private-message' }, token: 'secret', source: 'server', serverFault: true,
    }, known)
    expect(report).toEqual({ tool: 'generate_video_project', code: 'CREATIVE_VIDEO_INTENT_UNAVAILABLE', stage: 'preflight', model: 'MiniMax-H3' })
    for (const status of ['pending', 'unknown', 'background']) {
      expect(parseClientToolError('generate_video_project', {}, { status, code: 'CREATIVE_VIDEO_INTENT_UNAVAILABLE' }, known)).toBeNull()
    }
  })

  it('selects an exact known result model or argument model and omits all other values', () => {
    expect(parseClientToolError('generate_video', { model: 'MiniMax-H3' }, { ...failure, model: 'sd-20-9/3/3-1' }, known)?.model).toBe('sd-20-9/3/3-1')
    expect(parseClientToolError('generate_video', { model: 'MiniMax-H3' }, { ...failure, model: 'unknown' }, known)?.model).toBe('MiniMax-H3')
    for (const model of ['minimax-h3', ' MiniMax-H3 ', 'C:\\private\\image.png', 'sk-secret', '', null, 42]) {
      expect(parseClientToolError('generate_video', { model }, { ...failure, model }, known)).not.toHaveProperty('model')
    }
  })

  it.each([
    undefined, null, [], 'raw failure', { code: 'TASK_FAILED' }, { status: ['failed'], code: 'TASK_FAILED' },
    { status: 'succeeded', code: 'TASK_FAILED' }, { status: 'background', code: 'TASK_FAILED' },
    { status: 'failed', code: '__proto__' }, { status: 'failed', code: 'HTTP_503', message: 'TASK_FAILED' },
    { status: 'pending', code: 'VIDEO_QUEUE_WAITING' }, { status: 'pending', code: 'VIDEO_GENERATION_PENDING' },
  ])('does not turn malformed, unknown or ordinary waiting data into an error report: %j', (value) => {
    expect(parseClientToolError('generate_video', {}, value, known)).toBeNull()
  })

  it('refuses unrelated tools and ambiguous timeout stages', () => {
    for (const tool of ['pwsh', 'query_video_task', 'job_output', 'generate_video_project ', '__proto__']) {
      expect(parseClientToolError(tool, {}, failure, known)).toBeNull()
    }
    for (const stage of [undefined, 'preflight', 'local-save', 'QUERY', null]) {
      expect(parseClientToolError('generate_video', {}, { status: 'pending', code: 'TRANSPORT_TIMEOUT', stage }, known)).toBeNull()
    }
    for (const stage of ['submit', 'query']) {
      expect(parseClientToolError('generate_video', {}, { status: 'pending', code: 'TRANSPORT_TIMEOUT', stage }, known))
        .toEqual({ tool: 'generate_video', code: 'TRANSPORT_TIMEOUT', stage })
    }
  })
})

describe('single-attempt creation error forwarding', () => {
  it('does not dispatch local connection or cancellation diagnostics as backend task failures', async () => {
    const f = fixture()
    for (const code of ['TRANSPORT', 'ECONNRESET', 'HTTP_408', 'ABORTED']) {
      f.submit('generate_video', {}, { status: 'failed', code, message: 'TASK_FAILED server error' })
    }
    await f.reporter.dispose()
    expect(f.key).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it('returns immediately and sends only whitelisted JSON under the configured API prefix', async () => {
    const f = fixture()
    f.submit('generate_video', { model: 'MiniMax-H3', prompt: 'private' }, { ...failure, message: 'private' })
    expect(f.key).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(f.send).toHaveBeenCalledOnce() })
    const [url, init] = f.send.mock.calls[0]!
    expect(url).toBe('https://relay.example/harness/api/client-errors')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: {
      authorization: 'Bearer product-access-token', 'content-type': 'application/json',
    } })
    if (typeof init.body !== 'string') throw new Error('Expected whitelisted JSON text')
    expect(JSON.parse(init.body)).toEqual({ tool: 'generate_video', code: 'DURATION_NOT_SUPPORTED', stage: 'preflight', model: 'MiniMax-H3' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it.each([400, 401, 403, 404, 413, 415, 429, 500])('drops HTTP %s without retrying or recursively reporting', async (status) => {
    const send = vi.fn(async () => new Response('private body', { status }))
    const f = fixture({ fetch: send })
    const invocation = {}
    f.submit('generate_video', {}, failure, invocation)
    f.submit('generate_video', {}, failure, invocation)
    await vi.waitFor(() => { expect(send).toHaveBeenCalledOnce() })
    await f.reporter.dispose()
    expect(send).toHaveBeenCalledOnce()
  })

  it('keeps at most two active requests and drops overflow rather than queueing it', async () => {
    const response = latch<Response>()
    const send = vi.fn(() => response.promise)
    const f = fixture({ fetch: send })
    f.submit('generate_video', {}, failure, {})
    f.submit('generate_image', {}, failure, {})
    f.submit('generate_video_project', {}, failure, {})
    await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(2) })
    response.resolve(new Response(null, { status: 200 }))
    await f.reporter.dispose()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not send when signed out and contains credential/catalog/transport failures', async () => {
    for (const overrides of [
      { key: async () => undefined },
      { key: async (): Promise<ClientToolErrorAccount> => { throw new Error('private credential error') } },
      { knownModelIds: (): ReadonlySet<string> => { throw new Error('catalog not ready') } },
    ]) {
      const f = fixture(overrides)
      f.submit('generate_video', {}, failure)
      await f.reporter.dispose()
      expect(f.send).not.toHaveBeenCalled()
    }
    const send = vi.fn(async (): Promise<Response> => { throw new Error('private transport error') })
    const f = fixture({ fetch: send })
    f.submit('generate_video', {}, failure)
    await vi.waitFor(() => { expect(send).toHaveBeenCalledOnce() })
    await f.reporter.dispose()
    expect(send).toHaveBeenCalledOnce()
  })

  it('aborts pending requests and joins their settlement before disposal completes', async () => {
    let stopped = 0
    const send = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { stopped += 1; reject(new Error('report stopped')) }, { once: true })
    }))
    const f = fixture({ fetch: send })
    f.submit('generate_video', {}, failure)
    f.submit('generate_image', {}, failure)
    await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(2) })
    await f.reporter.dispose()
    expect(stopped).toBe(2)
    f.submit('generate_video', {}, failure)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not dispatch a late credential after disposal', async () => {
    const token = latch<ClientToolErrorAccount>()
    const key = vi.fn(() => token.promise)
    const f = fixture({ key })
    f.submit('generate_video', {}, failure)
    await vi.waitFor(() => { expect(key).toHaveBeenCalledOnce() })
    await f.reporter.dispose()
    token.resolve({ accountId: 'account-a', token: 'late-access-token' })
    await token.promise
    expect(f.send).not.toHaveBeenCalled()
  })

  it('drops an old account outcome when a later login resolves the fresh credential', async () => {
    const token = latch<ClientToolErrorAccount>()
    const key = vi.fn(() => token.promise)
    const f = fixture({ key })
    f.submit('generate_video', { model: 'MiniMax-H3' }, failure, {}, 'account-a')
    await vi.waitFor(() => { expect(key).toHaveBeenCalledOnce() })
    token.resolve({ accountId: 'account-b', token: 'other-account-token' })
    await token.promise
    await f.reporter.dispose()
    expect(f.send).not.toHaveBeenCalled()
  })

  it('refuses a report with no captured initiating account without resolving credentials', async () => {
    const f = fixture()
    f.reporter.submit('generate_video', {}, failure, {})
    await f.reporter.dispose()
    expect(f.key).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it('cancels the transport when the complete report deadline expires', async () => {
    const deadline = new AbortController()
    const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    try {
      const started = latch<AbortSignal>()
      const send = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        if (init.signal === null || init.signal === undefined) throw new Error('Expected report cancellation')
        started.resolve(init.signal)
        init.signal.addEventListener('abort', () => { reject(new Error('report deadline')) }, { once: true })
      }))
      const f = fixture({ fetch: send })
      f.submit('generate_video', {}, failure)
      const signal = await started.promise
      deadline.abort(new DOMException('deadline', 'TimeoutError'))
      expect(signal.aborted).toBe(true)
      await f.reporter.dispose()
      expect(send).toHaveBeenCalledOnce()
    } finally { timer.mockRestore() }
  })

  it('closes a late response from a transport that ignored disposal without reading its body', async () => {
    const response = latch<Response>()
    const send = vi.fn(() => response.promise)
    const f = fixture({ fetch: send })
    f.submit('generate_video', {}, failure)
    await vi.waitFor(() => { expect(send).toHaveBeenCalledOnce() })
    await f.reporter.dispose()
    const cancel = vi.fn()
    response.resolve(new Response(new ReadableStream({ cancel })))
    await vi.waitFor(() => { expect(cancel).toHaveBeenCalledOnce() })
    expect(send).toHaveBeenCalledOnce()
  })

  it('joins immediate disposal at a successful response boundary without an unhandled body cancellation', async () => {
    const observed = latch<undefined>()
    let bodyErrored = false
    const send = vi.fn(async (_url: string, init: RequestInit) => {
      const response = new Response(new ReadableStream({
        start(controller) {
          init.signal?.addEventListener('abort', () => {
            bodyErrored = true
            controller.error(new DOMException('response aborted', 'AbortError'))
          }, { once: true })
        },
      }))
      observed.resolve(undefined)
      return response
    })
    const f = fixture({ fetch: send })
    f.submit('generate_video', {}, failure)
    await observed.promise
    await f.reporter.dispose()
    expect(bodyErrored).toBe(true)
    expect(send).toHaveBeenCalledOnce()
    // Node reports an unhandled rejected cleanup promise at the event-loop boundary.
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  })

  it('observes an already rejected body cancellation when cancellation itself disposes the owner', async () => {
    let disposing: Promise<void> | undefined
    const send = vi.fn(async () => new Response(new ReadableStream({
      cancel() {
        disposing = f.reporter.dispose()
        return Promise.reject(new DOMException('body cancelled during disposal', 'AbortError'))
      },
    })))
    const f = fixture({ fetch: send })
    f.submit('generate_video', {}, failure)
    await vi.waitFor(() => { expect(disposing).toBeDefined() })
    await disposing
    expect(send).toHaveBeenCalledOnce()
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  })

  it('enforces the complete three-second maximum before starting work', () => {
    for (const timeoutMs of [0, -1, 1.5, 3001, Infinity]) {
      expect(() => fixture({ timeoutMs })).toThrow(RangeError)
    }
    expect(() => fixture({ baseUrl: 'https://8.133.202.230' })).toThrow('Harness API')
  })
})
