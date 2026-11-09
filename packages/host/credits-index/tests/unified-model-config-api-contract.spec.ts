/** Consume actual local Go HTTP replies through client guards and transports; local counts are never Go ledger evidence. */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { JobId, type JobHandle } from '@deepseek-ai/dsh-jobs'
import { harnessFetch } from '@deepseek-ai/dsh-llm-pi-ai/src/harness-fetch.ts'
import { catalogFromPricing, type VideoParams } from '../src/media.ts'
import { readModelConfigVersion, readModelConfigRevision } from '../src/model-config-version.ts'
import { readProductModelLimits } from '../src/model-limits.ts'
import { mediaModelConfigRejection, type MediaModelConfigBinding } from '../src/media-model-config-result.ts'
import { executeImageTask, type ImageTaskOptions } from '../src/image-task.ts'
import { executeVideoTask, type VideoTaskOptions } from '../src/video-task.ts'
import { createVideoProjectRelay } from '../src/video-project-provider.ts'
import { bindVideoServerQueueRecovery } from '../src/video-server-queue.ts'
import { resolveMediaSpecification } from '../src/media-request-specification.ts'
import { readVideoModelQuote } from '../src/video-model-choice.ts'
import { prepareVideoProject, readVideoProject, runVideoProject } from '../src/video-project.ts'
import type { VideoProjectOptions, VideoProjectProvider } from '../src/video-project-types.ts'
import type { VideoEditor } from '../src/video-edit.ts'
import { apiFixture, apiFixtureSet, fixtureHeader, fixtureRows, object, text, type ApiHttpFixture } from './fixtures/unified-model-config/http-fixtures.ts'
import capturedV1 from './fixtures/unified-model-config/actual-base35405-v1-manifest.json' with { type: 'json' }

const signal = (): AbortSignal => new AbortController().signal
const fingerprint = 'f'.repeat(64)
const request = { model: 'MiniMax-H3', prompt: 'Local protocol contract', seconds: 5, duration: 5 }
function publishedText(): Record<string, unknown> {
  const row = fixtureRows(apiFixture('new-text-directory')).find(value => value.kind === 'text' || value.kind === 'chat')
  if (row === undefined) throw new Error('Actual published text model fixture is required')
  return row
}

async function fixtureServer(reply: (method: string, path: string) => ApiHttpFixture) {
  const calls: { method: string; path: string; body: unknown; version?: string }[] = []
  const server = createServer((incoming, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const path = new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname, method = incoming.method ?? 'GET'
      expect(incoming.headers.authorization).toBe('Bearer synthetic-contract-relay')
      calls.push({ method, path, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
        ...typeof incoming.headers['x-yunshu-model-config-version'] === 'string'
          ? { version: incoming.headers['x-yunshu-model-config-version'] } : {} })
      const fixture = reply(method, path)
      response.statusCode = fixture.status
      // Captures retain parsed JSON, so this loopback emitter owns its serialized byte length.
      for (const [name, values] of Object.entries(fixture.headers)) {
        if (name.toLowerCase() !== 'content-length') response.setHeader(name, values)
      }
      const bytes = Buffer.from(JSON.stringify(fixture.body))
      response.setHeader('content-length', bytes.length); response.end(bytes)
    })().catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(() => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) }); server.closeAllConnections()
  }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected isolated loopback server')
  const origin = `http://127.0.0.1:${String(address.port)}/harness`
  const fetchReply = (path: string, method = 'POST', body: unknown = request, version?: string): Promise<Response> => fetch(origin + path, {
    method, headers: { authorization: 'Bearer synthetic-contract-relay',
      ...version === undefined ? {} : { 'X-Yunshu-Model-Config-Version': version } },
    ...method === 'POST' ? { body: JSON.stringify(body) } : {},
  })
  return { origin, calls, fetchReply }
}

describe('unified model configuration actual-Go response interoperability', () => {
  it('A: draft remains invisible and a published new model is declared consistently in both actual directories', () => {
    const before = fixtureRows(apiFixture('catalog-before-publish-models'))
    const draft = fixtureRows(apiFixture('catalog-draft-models'))
    expect(draft).toEqual(before)
    const modelsFixture = apiFixture('new-media--v1-models'), pricingFixture = apiFixture('new-media--api-pricing')
    const models = fixtureRows(modelsFixture), prices = fixtureRows(pricingFixture)
    const revision = readModelConfigRevision(object(modelsFixture.body))
    expect(revision).toMatch(/^[a-f0-9]{64}$/u)
    expect(readModelConfigRevision(object(pricingFixture.body))).toMatch(/^[a-f0-9]{64}$/u)
    const added = models.filter(row => !before.some(previous => previous.id === row.id))
    expect(added.length).toBeGreaterThanOrEqual(3)
    for (const row of added) {
      const price = prices.find(value => value.model_name === row.id)
      if (price === undefined) throw new Error('New authorized model has no matching published pricing row')
      expect(readModelConfigVersion(row)).toBe(readModelConfigVersion(price))
      expect(readModelConfigVersion(row)).toMatch(/^[a-f0-9]{64}$/u)
    }
  })

  it('B: actual text capacities remain a complete same-version pair and malformed new declarations cannot downgrade to legacy', () => {
    const models = fixtureRows(apiFixture('new-text-directory'))
    const prices = fixtureRows(apiFixture('new-text-pricing'))
    const row = models.find(value => value.kind === 'text' || value.kind === 'chat')
    if (row === undefined) throw new Error('Actual published text model fixture is required')
    const price = prices.find(value => value.model_name === row.id)
    if (price === undefined) throw new Error('Actual text pricing pair is required')
    expect(readProductModelLimits(row)).toEqual(readProductModelLimits(price))
    const capacities = readProductModelLimits(row)
    expect(capacities.contextWindow).toBeGreaterThan(0)
    expect(capacities.maxTokens).toBeGreaterThan(0)
    expect(capacities.maxTokens!).toBeLessThanOrEqual(capacities.contextWindow!)
    for (const patch of [{ context_window: undefined }, { max_output_tokens: 0 },
      { max_output_tokens: Number(row.context_window) + 1 }, { model_config_version: 'A'.repeat(64) }]) {
      expect(() => readProductModelLimits({ ...row, ...patch })).toThrow()
    }
  })

  it('C: actual image/video complete combinations survive catalog projection and reject a value outside their exact menu', () => {
    const catalog = catalogFromPricing(fixtureRows(apiFixture('new-media--api-pricing')), 'default')
    const before = new Set(fixtureRows(apiFixture('catalog-before-publish-models')).map(row => row.id))
    const published = fixtureRows(apiFixture('new-media--v1-models'))
    for (const kind of ['image', 'video'] as const) {
      const added = published.find(row => row.kind === kind && !before.has(row.id))
      const capability = catalog.find(value => value.id === added?.id && value.kind === kind && 'specifications' in value.params
        && (value.params.specifications?.length ?? 0) > 0)
      if (capability === undefined) throw new Error(`Actual ${kind} complete specifications are required`)
      expect(capability.modelConfigVersion).toMatch(/^[a-f0-9]{64}$/u)
      const specifications = (capability.params as VideoParams).specifications!
      for (const specification of specifications) expect(resolveMediaSpecification(specifications, specification))
        .toEqual({ ok: true, specification })
      expect(resolveMediaSpecification(specifications, { ...specifications[0], resolution: 'not-a-published-tier' }))
        .toMatchObject({ ok: false, code: 'SPECIFICATION_NOT_SUPPORTED' })
    }
  })

  it('D: consumes the complete actual stale-video refusal through real same-origin HTTP', async () => {
    const fixture = apiFixture('stale-video'), server = await fixtureServer(() => fixture)
    const response = await server.fetchReply('/v1/videos')
    const body: unknown = await response.json()
    const binding: MediaModelConfigBinding = { url: server.origin + '/v1/videos', method: 'POST', model: request.model, accountId: '7' }
    const rejected = mediaModelConfigRejection(response, body, binding)
    expect(rejected).toMatchObject({ accepted: false, charged: false, reserved: false, retryable: false, resubmittable: false,
      submissionState: 'not_submitted', requestId: fixtureHeader(fixture, 'X-Oneapi-Request-Id') })
    expect(rejected?.binding).toEqual(binding)
    expect(mediaModelConfigRejection(response, body, { ...binding, url: server.origin + '/wrong-endpoint' })).toBeUndefined()
    for (const field of ['accepted', 'charged', 'reserved', 'retryable', 'resubmittable', 'submission_state']) {
      const incomplete = Object.fromEntries(Object.entries(object(body)).filter(([key]) => key !== field))
      expect(mediaModelConfigRejection(response, incomplete, binding)).toBeUndefined()
    }
    expect(server.calls).toHaveLength(1)
  })

  it('D: an actual invalid H3 parameter rejection retains its durable original task and is not a front-stale proof', async () => {
    const fixture = apiFixture('invalid-parameters'), server = await fixtureServer(() => fixture), body = object(fixture.body)
    const binding: MediaModelConfigBinding = { url: server.origin + '/v1/videos', method: 'POST', model: request.model, accountId: '7' }
    expect(fixtureHeader(fixture, 'X-Yunshu-Model-Config-Result')).toBeUndefined()
    const submit = vi.fn(async () => {
      const response = await server.fetchReply('/v1/videos')
      expect(mediaModelConfigRejection(response, await response.clone().json(), binding)).toBeUndefined()
      return response
    })
    const read = vi.fn(async () => { throw new Error('This verified terminal rejection cannot need another generation') })
    const save: VideoTaskOptions['save'] = vi.fn(async () => { throw new Error('No video exists') })
    const result = await executeVideoTask({ model: request.model, route: '/v1/videos', modelConfigBinding: binding,
      backendFingerprint: fingerprint, signal: signal(), submitTimeoutMs: 1000, taskTimeoutMs: 1000,
      queryTimeoutMs: 1000, pollIntervalMs: 1, queryRetryLimit: 1, submit, read, save })
    expect(result).toMatchObject({ submissionState: 'failed', code: 'model_parameters_invalid', taskId: body.task_id,
      videoReceipt: { taskId: body.task_id } })
    expect(result).not.toHaveProperty('balanceRejection')
    expect(submit).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled()
    expect(fixture.observations).toMatchObject({ provider_post_count: 0, consume_count: 0, task_count: 1 })
  })

  it('D: actual text refusal remains separate from media proofs and never becomes model-reselection permission', async () => {
    const fixture = apiFixture('stale-text'), row = publishedText()
    const server = await fixtureServer(() => fixture), version = readModelConfigVersion(row)
    if (version === undefined) throw new Error('Actual versioned text row is required')
    const capacities = readProductModelLimits(row), observer = vi.fn()
    const transport = harnessFetch(server.origin + '/v1', observer, { model: text(row.id), managedScope: 'fixture-account-7' }, {
      baseURL: server.origin + '/v1', model: text(row.id), scope: 'fixture-account-7', modelConfigVersion: version,
      contextWindow: capacities.contextWindow!, maxTokens: capacities.maxTokens!,
    }, async () => true)
    if (transport === undefined) throw new Error('Managed loopback text transport is required')
    await expect(transport(server.origin + '/v1/chat/completions', { method: 'POST',
      headers: { authorization: 'Bearer synthetic-contract-relay', 'content-type': 'application/json' },
      body: JSON.stringify({ model: row.id, messages: [{ role: 'user', content: 'hello' }], max_tokens: row.max_output_tokens }) }))
      .rejects.toMatchObject({ code: 'MODEL_CONFIG_CHANGED', failure: { status: 400,
        requestId: fixtureHeader(fixture, 'X-Oneapi-Request-Id') } })
    expect(observer).toHaveBeenCalledOnce()
    expect(observer.mock.calls[0]?.[1]).toBeUndefined()
    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]?.version).toBe(version)
  })

  it('E: actual accepted text echo is consumed once with its complete authorized version and capacity pair', async () => {
    const row = publishedText(), fixture = apiFixture('accepted-text')
    const server = await fixtureServer(() => fixture), version = readModelConfigVersion(row)
    if (version === undefined) throw new Error('Actual versioned text row is required')
    const limits = readProductModelLimits(row)
    const transport = harnessFetch(server.origin + '/v1', undefined, undefined, { baseURL: server.origin + '/v1',
      model: text(row.id), scope: 'fixture-account-7', modelConfigVersion: version,
      contextWindow: limits.contextWindow!, maxTokens: limits.maxTokens! }, async () => true)
    if (transport === undefined) throw new Error('Managed transport is required')
    const response = await transport(server.origin + '/v1/chat/completions', { method: 'POST',
      headers: { authorization: 'Bearer synthetic-contract-relay', 'content-type': 'application/json' },
      body: JSON.stringify({ model: row.id, max_tokens: row.max_output_tokens, messages: [{ role: 'user', content: 'hello' }] }) })
    expect(await response.json()).toEqual(fixture.body)
    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]?.body).toMatchObject({ model: row.id, max_tokens: row.max_output_tokens })
    expect(server.calls[0]?.version).toBe(version)
  })

  it('D: actual supplier-forged configuration text is an ordinary failed response without safe resubmission authority', async () => {
    const fixture = apiFixture('provider-forged-config-proof'), row = publishedText(), version = readModelConfigVersion(row)
    if (version === undefined) throw new Error('Actual authorized text version is required')
    expect(fixtureHeader(fixture, 'X-Yunshu-Model-Config-Result')).toBeUndefined()
    const server = await fixtureServer(() => fixture), limits = readProductModelLimits(row), observer = vi.fn()
    const transport = harnessFetch(server.origin + '/v1', observer, { model: text(row.id), managedScope: 'fixture-account-7' }, {
      baseURL: server.origin + '/v1', model: text(row.id), scope: 'fixture-account-7', modelConfigVersion: version,
      contextWindow: limits.contextWindow!, maxTokens: limits.maxTokens!,
    }, async () => true)
    if (transport === undefined) throw new Error('Managed transport is required')
    const response = await transport(server.origin + '/v1/chat/completions', { method: 'POST',
      headers: { authorization: 'Bearer synthetic-contract-relay', 'content-type': 'application/json' },
      body: JSON.stringify({ model: row.id, max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] }) })
    expect(response.status).toBe(400); expect(await response.json()).toEqual(fixture.body)
    expect(observer).toHaveBeenCalledOnce(); expect(observer.mock.calls[0]?.[1]).toBeUndefined()
    expect(server.calls).toHaveLength(1)
  })

  it('E: actual Go text ledger separates accepted managed and legacy calls from a sent supplier refusal', () => {
    const baseline = apiFixture('new-text-directory').observations, stale = apiFixture('stale-text').observations
    const accepted = apiFixture('accepted-text').observations, legacy = apiFixture('legacy-text-no-header').observations
    const forged = apiFixture('provider-forged-config-proof').observations
    if (baseline === undefined || stale === undefined || accepted === undefined || legacy === undefined || forged === undefined) {
      throw new Error('Actual Go text ledger observations are required')
    }
    expect(stale).toEqual(baseline)
    expect(accepted.provider_post_count - stale.provider_post_count).toBe(1)
    expect(accepted.consume_count - stale.consume_count).toBe(1)
    const managedCharge = stale.user_quota - accepted.user_quota
    expect(managedCharge).toBeGreaterThan(0); expect(stale.token_quota - accepted.token_quota).toBe(managedCharge)
    expect(legacy.provider_post_count - accepted.provider_post_count).toBe(1)
    expect(legacy.consume_count - accepted.consume_count).toBe(1)
    const legacyCharge = accepted.user_quota - legacy.user_quota
    expect(legacyCharge).toBeGreaterThan(0); expect(accepted.token_quota - legacy.token_quota).toBe(legacyCharge)
    expect(forged).toEqual({ ...legacy, provider_post_count: legacy.provider_post_count + 1 })
  })

  it.each(['image', 'video'] as const)('D: %s executor preserves actual stale-version proof without retrying or saving', async (kind) => {
    const fixture = apiFixture(kind === 'image' ? 'stale-image' : 'stale-video'), server = await fixtureServer(() => fixture)
    const model = kind === 'image' ? text(object(apiFixture('accepted-image').body).model) : request.model
    const route = kind === 'image' ? '/v1/images/generations' : '/v1/videos'
    const binding: MediaModelConfigBinding = { url: server.origin + route, method: 'POST', model, accountId: '7' }
    const submit = vi.fn(() => server.fetchReply(route, 'POST', { ...request, model }))
    const read = vi.fn(() => { throw new Error('Rejected work cannot be polled') })
    const common = { model, route, backendFingerprint: fingerprint,
      modelConfigBinding: binding, signal: signal(), submitTimeoutMs: 1000, taskTimeoutMs: 1000, queryTimeoutMs: 1000,
      pollIntervalMs: 1, queryRetryLimit: 1, submit, read }
    const imageSave: ImageTaskOptions['save'] = vi.fn(async () => { throw new Error('Rejected image cannot be saved') })
    const videoSave: VideoTaskOptions['save'] = vi.fn(async () => { throw new Error('Rejected video cannot be saved') })
    const outcome = kind === 'image' ? await executeImageTask({ ...common, save: imageSave })
      : await executeVideoTask({ ...common, save: videoSave })
    expect(outcome).toMatchObject({ ok: false, submissionState: 'not-submitted', code: 'MODEL_CONFIG_CHANGED' })
    expect(submit).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled()
    expect(imageSave).not.toHaveBeenCalled(); expect(videoSave).not.toHaveBeenCalled()
    expect(outcome).not.toHaveProperty('balanceRejection')
    expect(server.calls).toHaveLength(1)
  })

  it('D: an actual front-stale image has no durable task while an already-prepared refusal retains its original receipt', async () => {
    const front = apiFixture('stale-image'), durable = apiFixture('changed-during-image-preparation')
    expect(fixtureHeader(front, 'X-New-Api-Task-Id')).toBeUndefined()
    expect(fixtureHeader(durable, 'X-Yunshu-Model-Config-Result')).toBeUndefined()
    const durableBody = object(durable.body), model = text(durableBody.model), id = text(durableBody.task_id)
    expect(fixtureHeader(durable, 'X-New-Api-Task-Id')).toBe(id)
    const server = await fixtureServer(() => durable)
    const binding: MediaModelConfigBinding = { url: server.origin + '/v1/images/generations', method: 'POST', model, accountId: '7' }
    const response = await server.fetchReply('/v1/images/generations', 'POST', { model })
    expect(mediaModelConfigRejection(response, await response.json(), binding)).toBeUndefined()
    const received: Parameters<NonNullable<ImageTaskOptions['received']>>[0][] = []
    const submit = vi.fn(() => server.fetchReply('/v1/images/generations', 'POST', { model }))
    const read = vi.fn(async () => { throw new Error('This terminal durable refusal needs no provider query') })
    const save: ImageTaskOptions['save'] = vi.fn(async () => { throw new Error('No image was generated') })
    const result = await executeImageTask({ model, route: '/v1/images/generations', modelConfigBinding: binding,
      backendFingerprint: fingerprint, signal: signal(), submitTimeoutMs: 1000, taskTimeoutMs: 1000,
      queryTimeoutMs: 1000, pollIntervalMs: 1, queryRetryLimit: 1, serverResultRecovery: true,
      received: async (receipt) => { received.push(structuredClone(receipt)) }, submit, read, save })
    expect(result).toMatchObject({ submissionState: 'failed', taskId: id, serverTaskId: id,
      imageReceipt: { taskId: id, serverTaskId: id, phase: 'accepted' } })
    expect(result).not.toHaveProperty('balanceRejection')
    expect(received.some(receipt => receipt.serverTaskId === id && receipt.phase === 'accepted')).toBe(true)
    expect(submit).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled()
    // This first guard-only POST and the executor POST are local consumers, not additional Go provider creations.
    expect(server.calls).toHaveLength(2)
  })

  it('E: actual Go image observations prove one acceptance and zero additional billing during either configuration conflict', () => {
    const initial = apiFixture('invalid-image-parameters').observations
    const accepted = apiFixture('accepted-image').observations
    const durable = apiFixture('changed-during-image-preparation').observations
    const front = apiFixture('stale-image').observations
    if (initial === undefined || accepted === undefined || durable === undefined || front === undefined) {
      throw new Error('Actual local Go ledger observations are required; Node transport counts cannot substitute for them')
    }
    expect(accepted.provider_post_count - initial.provider_post_count).toBe(1)
    expect(accepted.consume_count - initial.consume_count).toBe(1)
    const charged = initial.user_quota - accepted.user_quota
    expect(charged).toBeGreaterThan(0); expect(initial.token_quota - accepted.token_quota).toBe(charged)
    expect(durable).toEqual({ ...accepted, task_count: accepted.task_count + 1 })
    expect(front).toEqual(durable)
  })

  it('E: actual combined-Go generic acceptances bill once while quotes, original reads and directory updates create no work', () => {
    const quote = apiFixture('new-video-quote'), video = apiFixture('new-video-created')
    const read = apiFixture('new-video-canonical-task-read'), references = apiFixture('new-video-generic-reference-grammar')
    const image = apiFixture('new-image-created')
    if (quote.observations === undefined || video.observations === undefined || read.observations === undefined
      || references.observations === undefined || image.observations === undefined) throw new Error('Actual combined Go observations are required')
    expect(quote.observations).toEqual(apiFixture('new-media--v1-models').observations)
    expect(video.observations.provider_post_count - quote.observations.provider_post_count).toBe(1)
    expect(video.observations.consume_count - quote.observations.consume_count).toBe(1)
    expect(video.observations.task_count - quote.observations.task_count).toBe(1)
    expect(quote.observations.user_quota - video.observations.user_quota).toBe(object(quote.body).one_work_quota)
    expect(quote.observations.token_quota - video.observations.token_quota).toBe(object(quote.body).one_work_quota)
    expect(read.observations).toEqual(video.observations)
    expect(image.observations.provider_post_count - references.observations.provider_post_count).toBe(1)
    expect(image.observations.consume_count - references.observations.consume_count).toBe(1)
    expect(image.observations.task_count - references.observations.task_count).toBe(1)
    const imageCharge = references.observations.user_quota - image.observations.user_quota
    expect(imageCharge).toBeGreaterThan(0)
    expect(references.observations.token_quota - image.observations.token_quota).toBe(imageCharge)
    for (const name of ['new-image-completed-canonical-task', 'new-image-artifacts', 'new-image-artifact-content',
      'combined-after-update--v1-models', 'combined-after-update--api-pricing', 'combined-after-update--api-status',
      'combined-after-price-update--v1-models', 'combined-after-price-update--api-pricing', 'new-video-quote-after-price-update']) {
      expect(apiFixture(name).observations).toEqual(image.observations)
    }
    expect(JSON.stringify(video.native_request)).not.toContain('model_config_version')
    expect(JSON.stringify(image.native_request)).not.toContain('model_config_version')
  })

  it('D: the actual Go quote pins preparation and a later model row cannot create a paid request', async () => {
    const fixture = apiFixture('managed-video-quote'), body = object(fixture.body)
    const version = readModelConfigVersion(body)
    if (version === undefined) throw new Error('Actual managed quotation is required')
    const server = await fixtureServer(() => fixture)
    const quoteRequest = { model: text(body.model), works_count: 1,
      segments: [{ id: 'one', parameters: { resolution: '768P', seconds: 5 }, reference_counts: { images: 0, videos: 0, audios: 0 } }] }
    const quote = await readVideoModelQuote({ candidate: { model: text(body.model), modelConfigVersion: version,
      resolution: '768P', durations: [5] }, request: quoteRequest, accountId: '7', signal: signal(),
    binding: { url: server.origin + '/v1/video/quote', method: 'POST', model: text(body.model), accountId: '7', modelConfigVersion: version },
    now: () => Number(body.created_at) * 1000,
    transport: (value, life, selected) => fetch(server.origin + '/v1/video/quote', { method: 'POST',
      headers: { authorization: 'Bearer synthetic-contract-relay', 'content-type': 'application/json',
        'X-Yunshu-Model-Config-Version': text(selected) }, body: JSON.stringify(value), signal: life }) })
    expect(quote?.modelConfigVersion).toBe(version)
    const root = await mkdtemp(join(tmpdir(), 'dsh-unified-quote-prepare-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const workspace = join(root, 'workspace'); await mkdir(workspace)
    const changed = readModelConfigVersion({ model_config_version: version === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64) })
    if (changed === undefined) throw new Error('Synthetic changed row version is required')
    const submit = vi.fn(async () => { throw new Error('Changed configuration must not submit') })
    const build = vi.fn(async () => { throw new Error('Changed quote must stop before building paid requests') })
    const provider: VideoProjectProvider = { identity: { accountId: '7', sessionFingerprint: 'same-synthetic-login' },
      async assertCurrent() {}, async model() { return { id: text(body.model), durations: [5], modelConfigVersion: changed } },
      build, submit, async check() { throw new Error('No task exists') }, async download() { throw new Error('No task exists') } }
    const editor: VideoEditor = { async preflight() {}, async probe() { throw new Error('No output exists') },
      async compose() { throw new Error('No output exists') } }
    const options: VideoProjectOptions = { stateDirectory: join(root, 'state'), outputDirectory: 'renders',
      maxTotalSeconds: 30, maxSegments: 4, pollIntervalMs: 1, taskTimeoutMs: 1000,
      editor: () => editor, acquireProvider: async () => provider }
    await expect(prepareVideoProject(options, { model: text(body.model), prompt: 'Original quoted work', totalDurationSeconds: 5,
      modelConfigSnapshot: { model: text(body.model), modelConfigVersion: version } }, 'quote-session', workspace, provider, editor, signal()))
      .rejects.toMatchObject({ code: 'MODEL_CONFIG_CHANGED' })
    expect(build).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled()
    expect(server.calls.map(call => call.path)).toEqual(['/harness/v1/video/quote'])
  })

  it.each(['image', 'video'] as const)('E: %s wrong-echo receipt remains retained and resumes only its original ID', async (kind) => {
    const actual = apiFixture(kind === 'image' ? 'accepted-image' : 'accepted-before-update')
    const body = object(actual.body), model = text(body.model)
    const version = readModelConfigVersion({ model_config_version: fixtureHeader(actual, 'X-Yunshu-Model-Config-Version') })
    if (version === undefined) throw new Error('Actual accepted response version is required')
    const modified: ApiHttpFixture = { ...actual, headers: { ...actual.headers,
      'X-Yunshu-Model-Config-Version': [version === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64)] } }
    const server = await fixtureServer(() => modified)
    const route = kind === 'image' ? '/v1/images/generations' : '/v1/video/generations'
    const binding: MediaModelConfigBinding = { url: server.origin + route, method: 'POST', model, accountId: '7', modelConfigVersion: version }
    const submit = vi.fn(() => server.fetchReply(route, 'POST', { ...request, model }, version))
    const read = vi.fn(async () => Response.json({ status: 'UNKNOWN' }))
    const common = { model, route, modelConfigBinding: binding, backendFingerprint: fingerprint,
      signal: signal(), submitTimeoutMs: 1000, taskTimeoutMs: 1000, queryTimeoutMs: 1000, pollIntervalMs: 1,
      queryRetryLimit: 1, submit, read }
    const imageSave: ImageTaskOptions['save'] = vi.fn(async () => { throw new Error('A mismatched acknowledgement must not save') })
    const videoSave: VideoTaskOptions['save'] = vi.fn(async () => { throw new Error('A mismatched acknowledgement must not save') })
    if (kind === 'image') {
      const first = await executeImageTask({ ...common, save: imageSave })
      expect(first).toMatchObject({ submissionState: 'pending', code: 'MODEL_CONFIG_CONFIRMATION_UNAVAILABLE', taskId: body.id })
      expect(read).not.toHaveBeenCalled()
      if (first.imageReceipt === undefined) throw new Error('Original image receipt is required')
      expect(await executeImageTask({ ...common, resumeReceipt: first.imageReceipt, save: imageSave }))
        .toMatchObject({ submissionState: 'pending', taskId: body.id })
    } else {
      const first = await executeVideoTask({ ...common, save: videoSave })
      expect(first).toMatchObject({ submissionState: 'pending', code: 'MODEL_CONFIG_CONFIRMATION_UNAVAILABLE', taskId: body.id })
      expect(read).not.toHaveBeenCalled()
      if (first.videoReceipt === undefined) throw new Error('Original video receipt is required')
      expect(await executeVideoTask({ ...common, resumeReceipt: first.videoReceipt, save: videoSave }))
        .toMatchObject({ submissionState: 'pending', taskId: body.id })
    }
    expect(submit).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledExactlyOnceWith(body.id, expect.any(AbortSignal), true)
    expect(server.calls).toHaveLength(1)
  })

  it('E: accepted actual task remains queryable after publication without a second provider POST', async () => {
    const accepted = apiFixture('accepted-before-update'), original = apiFixture('original-task-readable')
    const version = readModelConfigVersion({ model_config_version: fixtureHeader(accepted, 'X-Yunshu-Model-Config-Version') })
    if (version === undefined) throw new Error('Actual accepted version is required')
    const server = await fixtureServer(method => method === 'POST' ? accepted : original)
    const root = await mkdtemp(join(tmpdir(), 'dsh-unified-contract-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const relay = createVideoProjectRelay({ origin: server.origin, accountId: '7', timeoutMs: 1000, maxDownloadBytes: 4096,
      cacheRoot: root, key: async () => 'synthetic-contract-relay' })
    const submitted = await relay.submit(request, '/v1/video/generations', signal(), version)
    expect(submitted.taskId).toBe(object(accepted.body).id)
    expect(await relay.check(submitted.taskId, '/v1/video/generations', signal(), request.model)).toMatchObject({ status: 'queued' })
    expect(server.calls.map(call => [call.method, call.path])).toEqual([
      ['POST', '/harness/v1/video/generations'], ['GET', `/harness/v1/tasks/${submitted.taskId}`],
    ])
    expect(server.calls[0]?.version).toBe(version)
    expect(server.calls[0]?.body).toEqual(request)
  })

  it('E: actual existing-operation acknowledgement retains its original strict queue identity', async () => {
    const acknowledgement = apiFixture('existing-operation-replay'), data = object(object(acknowledgement.body).data)
    expect(fixtureHeader(acknowledgement, 'X-Yunshu-Model-Config-Version')).toBe(data.model_config_version)
    const server = await fixtureServer(() => acknowledgement)
    const queue = bindVideoServerQueueRecovery({ origin: server.origin, timeoutMs: 1000, key: async () => 'synthetic-contract-relay' })
    expect(await queue.read(text(data.id), request, signal())).toMatchObject({ queueId: data.id, operationId: data.operation_id,
      gatewayTaskId: data.task_id, model: request.model })
    expect(server.calls.map(call => call.method)).toEqual(['GET'])
  })

  it('F: a legacy manifest without a version recovers its original task without creating work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-unified-legacy-manifest-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const workspace = join(root, 'workspace'); await mkdir(workspace)
    const submit = vi.fn(async () => { throw new Error('An existing task must never be submitted again') })
    const check = vi.fn(async () => ({ status: 'succeeded' as const }))
    const provider: VideoProjectProvider = { identity: { accountId: '7', sessionFingerprint: 'synthetic-v1-login' },
      async assertCurrent() {}, async model() { return { id: request.model, durations: [5] } },
      async build() { return request }, submit, check, async download(_id, _request, path) {
        await mkdir(dirname(path), { recursive: true }); await writeFile(path, '5')
      } }
    const editor: VideoEditor = { async preflight() {}, async probe() { return { durationSeconds: 5 } },
      async compose(input) { await mkdir(dirname(input.outputPath), { recursive: true }); await writeFile(input.outputPath, '5')
        return { path: input.outputPath, durationSeconds: 5 } } }
    const options: VideoProjectOptions = { stateDirectory: join(root, 'state'), outputDirectory: 'renders', maxTotalSeconds: 30,
      maxSegments: 4, pollIntervalMs: 1, taskTimeoutMs: 1000, editor: () => editor, acquireProvider: async () => provider }
    expect(capturedV1.capture.writerSha256).toBe('af95db4bcf10f58b40f15dc62ceb1c939b0fa54db391429a3cf87548a857176d')
    expect(capturedV1.manifest.version).toBe(1)
    const manifest = object(JSON.parse(JSON.stringify(capturedV1.manifest).split('{{fixtureRoot}}').join(root)))
    const segments = manifest.segments
    if (!Array.isArray(segments) || segments.length !== 1) throw new Error('The captured legacy manifest must retain exactly one original clip')
    const id = text(manifest.id), first = object(segments[0])
    expect(first.taskId).toBe('task_original_local_v1_fixture')
    const path = join(options.stateDirectory, id, 'manifest.json')
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(manifest))
    expect(JSON.stringify(manifest)).not.toContain('modelConfigSnapshot')
    const restored = await readVideoProject(options, id, text(manifest.ownerSessionId), workspace, provider.identity)
    const job: JobHandle = { id: JobId('legacy-config-job'), append: () => {}, updateProgress: () => {} }
    const result = await runVideoProject(options, restored, provider, editor, job, signal())
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'completed' })
    expect(submit).not.toHaveBeenCalled()
    expect(check).toHaveBeenCalledExactlyOnceWith(first.taskId, first.request, expect.any(AbortSignal))
    const persisted = object(JSON.parse(await readFile(path, 'utf8')))
    expect(persisted.version).toBe(1)
    expect(persisted).not.toHaveProperty('modelConfigSnapshot')
  })

  it('F: legacy servers without version metadata keep omission semantics', () => {
    expect(readModelConfigVersion({})).toBeUndefined()
    expect(readModelConfigRevision({ data: [] })).toBeUndefined()
    expect(apiFixtureSet().sha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('F: a legacy text caller without the new header consumes the actual compatible Go reply', async () => {
    const server = await fixtureServer(() => apiFixture('legacy-text-no-header'))
    const row = publishedText()
    const response = await fetch(server.origin + '/v1/chat/completions', { method: 'POST',
      headers: { authorization: 'Bearer synthetic-contract-relay', 'content-type': 'application/json' },
      body: JSON.stringify({ model: row.id, messages: [{ role: 'user', content: 'hello' }], max_tokens: 32 }) })
    expect(await response.json()).toEqual(apiFixture('legacy-text-no-header').body)
    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]?.version).toBeUndefined()
  })
})
