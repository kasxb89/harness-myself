/** Published local-Go catalog bytes reach the built UI, native tools and actual text POSTs through the shipped Web CLI. */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  captureExpectedWorkspaceSnapshot, captureWorkspaceSnapshot, fixtureContext, formatSystemPromptSnapshot,
  formatToolSchemasSnapshot, latestPersistedSessionPaths, normalizeSessionSnapshots, normalizedSystemPrompts,
  normalizedToolSchemas, redactSessionSnapshotIds, scrubSessionSnapshot, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import { expect, it } from 'vitest'
import {
  apiFixture, apiFixtureSet, fixtureHeader, fixtureRows, object, text,
} from '../../../packages/host/credits-index/tests/fixtures/unified-model-config/http-fixtures.ts'
import { readModelConfigVersion } from '../../../packages/host/credits-index/src/model-config-version.ts'
import { readProductModelLimits } from '../../../packages/host/credits-index/src/model-limits.ts'
import { catalogFromPricing } from '../../../packages/host/credits-index/src/media.ts'
import { resolveMediaSpecification } from '../../../packages/host/credits-index/src/media-request-specification.ts'
import { imageServerArtifactUrl } from '../../../packages/host/credits-index/src/image-server-recovery.ts'
import disabledBannerFeed from '../../../packages/host/credits-index/tests/fixtures/announcement-banner-api/feed-banner-disabled.json' with { type: 'json' }
import noSurvey from '../../../packages/host/credits-index/tests/fixtures/onboarding-survey-api/not-eligible.json' with { type: 'json' }
import { startProfileWeb } from './profile-process.ts'
import { fixtureUserPrompts, normalizeWebSessionVolatiles, watchConsole, webSnapshotMode } from './scaffold.ts'
import { openSettings, REPO_ROOT, ZH_BROWSER_LOCALE } from './support.ts'

const DIRECTORY = fileURLToPath(new URL('../../../snapshots/web/unified-model-config', import.meta.url))
const FIXTURE = join(DIRECTORY, 'session.v4.jsonl')
const PROMPTS = ['列出我偏好中的图片和视频模型及其完整规格，只读取，不生成。',
  '后台配置已更新，再读取我偏好中的图片和视频目录，只读取，不生成。'] as const
type Row = Record<string, unknown>
type Phase = 'before-publish' | 'draft' | 'published' | 'updated' | 'repriced'
function directoryFixture(phase: Phase, kind: 'models' | 'pricing' | 'status'): string {
  if (phase === 'published') return `new-media--${kind === 'models' ? 'v1-models' : `api-${kind}`}`
  if (phase === 'updated') return `combined-after-update--${kind === 'models' ? 'v1-models' : `api-${kind}`}`
  if (phase === 'repriced') return kind === 'status' ? 'combined-after-update--api-status'
    : `combined-after-price-update--${kind === 'models' ? 'v1-models' : 'api-pricing'}`
  return kind === 'status' ? 'new-media--api-status' : `catalog-${phase}-${kind}`
}
function unitPoints(model: Row, specification: Row, kind: 'image' | 'video'): number[] {
  const pricing = object(model.pricing)
  expect(pricing).toMatchObject({ basis: 'default', source: 'public-retail', status: 'available', coverage: 'complete',
    credits_per_yuan: '1000', unit: kind === 'image' ? 'points/image' : 'points/second' })
  const prices = (pricing.rows as unknown[]).map(object).filter(row => (row.input === 'text' || row.input === 'unspecified')
    && Object.entries(specification).every(([field, value]) => object(row.parameters)[field] === value))
  expect(prices.length).toBeGreaterThan(0)
  return prices.map((row) => {
    const points = Number(row.points)
    expect(Number.isFinite(points) && points > 0).toBe(true)
    return points
  })
}
function renderedPoints(value: string): string[] { return value.replaceAll(',', '').match(/\d+(?:\.\d+)?/gu) ?? [] }

function rows(raw: string): Row[] { return raw.trimEnd().split('\n').map(line => object(JSON.parse(line))) }
function toolResults(raw: string): { name: string; value: Row }[] {
  const events = rows(raw)
  const calls = new Map(events.filter(row => row.type === 'tool/call').map(row => [object(row.data).callId, text(object(row.data).name)]))
  return events.filter(row => row.type === 'tool/result').map((row) => {
    const message = object(object(row.data).message)
    const content = (message.content as unknown[]).map(object).filter(block => block.type === 'text').map(block => text(block.text)).join('')
    return { name: calls.get(message.toolCallId) ?? '', value: object(JSON.parse(content)) }
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
function normalizePreferenceIdentity(events: Row[], preference: Row, requestIds: string[]): Row[] {
  expect(preference.scope).toMatch(/^[a-f0-9]{64}$/u); expect(preference.revision).toMatch(/^[a-f0-9]{64}$/u)
  const result = structuredClone(events), selections = result.filter(row => row.type === 'media/request-selection')
  expect(selections).toHaveLength(requestIds.length)
  expect(selections.map(row => object(row.data).requestId)).toEqual(requestIds)
  for (const row of selections) {
    const selection = object(row.data)
    expect(selection.scope).toBe(preference.scope); expect(selection.revision).toBe(preference.revision)
    expect(selection.image).toEqual(preference.image); expect(selection.video).toEqual(preference.video)
    selection.scope = '{{mediaPreferenceScope}}'; selection.revision = '{{mediaPreferenceRevision}}'
  }
  return result
}

it('records new published models and same-version capacities across settings, preferences, native lists and actual text requests', async (test) => {
  const mode = webSnapshotMode()
  if (mode === 'record') throw new Error('Capture this authored local fixture through official refresh')
  if (!existsSync(FIXTURE) && mode !== 'refresh') throw new Error('First capture requires DSH_SNAPSHOT=refresh')
  const script = mode === 'refresh' ? undefined : deriveReplayScript(parseSessionLog(await readFile(FIXTURE, 'utf8')))
  if (script !== undefined) expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual(PROMPTS)
  const before = fixtureRows(apiFixture('catalog-before-publish-models'))
  const published = fixtureRows(apiFixture(directoryFixture('published', 'models')))
  const added = published.filter(row => !before.some(previous => previous.id === row.id))
  const newText = added.find(row => row.kind === 'text' || row.kind === 'chat')
  const newImage = added.find(row => row.kind === 'image'), newVideo = added.find(row => row.kind === 'video')
  if (newText === undefined || newImage === undefined || newVideo === undefined) throw new Error('Actual Go publication must add text, image and video models')
  const baseline = before.find(row => row.kind === 'text' || row.kind === 'chat')?.id ?? 'legacy-fixture-chat'
  const updated = fixtureRows(apiFixture(directoryFixture('updated', 'models'))).find(row => row.id === newText.id)
  if (updated === undefined) throw new Error('Actual updated text declaration is required')
  const newTextLimits = readProductModelLimits(newText)
  expect(readModelConfigVersion(updated)).not.toBe(readModelConfigVersion(newText))
  const nativeReplies = (['image', 'video'] as const).map((kind) => {
    const created = apiFixture(`new-${kind}-created`)
    const readable = apiFixture(kind === 'image' ? 'new-image-completed-canonical-task' : 'new-video-canonical-task-read')
    const model = kind === 'image' ? newImage : newVideo, body = object(created.body)
    expect(body.model).toBe(model.id)
    expect(fixtureHeader(created, 'X-Yunshu-Model-Config-Version')).toBe(readModelConfigVersion(model))
    const supplier = object(created.native_request)
    const prompt = kind === 'image' ? text(object(supplier.params).prompt)
      : text((supplier.content as unknown[]).map(object).find(value => value.type === 'text')?.text)
    return { kind, model, created, readable, supplier, prompt, taskId: text(body.id ?? body.task_id) }
  })
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-unified-model-config-')))
  const workspace = join(root, 'workspace'), persistence = join(root, 'sessions'), credits = join(root, 'credits')
  await Promise.all([workspace, persistence].map(path => mkdir(path)))
  const cleanup: { host?: () => Promise<void>; browser?: () => Promise<void>; server?: () => Promise<void> } = {}
  test.onTestFinished(async () => {
    try { await cleanup.browser?.() }
    finally {
      try { await cleanup.host?.() }
      finally {
        try { await cleanup.server?.() }
        finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  })
  let phase: Phase = 'before-publish', lastRaw = '', activeSession: string | undefined
  const creates: string[] = [], errors: string[] = [], textPosts: { phase: Phase; body: Row; version: unknown }[] = []
  const nativePosts: { kind: 'image' | 'video'; path: string; body: Row; version: unknown }[] = []
  const nativeQueries: { kind: 'image' | 'video'; path: string }[] = []
  const panelResults: { kind: 'image' | 'video'; response: Row }[] = []
  const catalogReads: { phase: Phase; path: string }[] = [], discoveryResults: { phase: Phase; result: unknown }[] = []
  let lastCatalog: Row | undefined
  let readHostOutput = (): string => ''
  const outgoingHumans: { requestId: string; sessionId: string }[] = []
  const artifactManifest = apiFixture('new-image-artifacts'), imageContent = apiFixture('new-image-artifact-content')
  const imageReply = nativeReplies.find(reply => reply.kind === 'image')!
  const initialQuote = object(apiFixture('new-video-quote').body)
  const quoteParameters = object(object((initialQuote.segments as unknown[])[0]).parameters)
  const quotaPerUsd = Number(initialQuote.quota_per_usd), exchangeRate = Number(initialQuote.usd_exchange_rate)
  expect(initialQuote.model).toBe(newVideo.id)
  expect(Number.isFinite(quotaPerUsd) && quotaPerUsd > 0 && Number.isFinite(exchangeRate) && exchangeRate > 0).toBe(true)
  const beforeImage = apiFixture('new-video-generic-reference-grammar').observations, afterImage = imageReply.created.observations
  if (beforeImage === undefined || afterImage === undefined) throw new Error('Same-account original Go image accounting facts are required')
  const imageQuota = beforeImage.user_quota - afterImage.user_quota
  expect(imageQuota).toBe(beforeImage.token_quota - afterImage.token_quota)
  expect(object(imageReply.supplier.params).mode).toBe('text-to-image')
  const expectedUnitPoints = { image: imageQuota / quotaPerUsd * exchangeRate * 1000,
    video: Number(initialQuote.one_work_quota) / Number(quoteParameters.seconds) / quotaPerUsd * exchangeRate * 1000 }
  const artifacts = (object(artifactManifest.body).artifacts as unknown[]).map(object)
  expect(object(artifactManifest.body).task_id).toBe(imageReply.taskId)
  expect(artifacts).toHaveLength(1); expect(artifacts[0]?.key).toBe('image')
  const capturedImageUrl = text(artifacts[0]?.content_url)
  const capturedImagePath = `/v1/tasks/${imageReply.taskId}/artifacts/image/content`
  const capturedUrl = new URL(capturedImageUrl)
  expect(capturedUrl.origin).toBe('http://localhost:3000'); expect(capturedUrl.pathname).toBe(capturedImagePath)
  expect(capturedUrl.username).toBe(''); expect(capturedUrl.password).toBe(''); expect(capturedUrl.hash).toBe('')
  expect(imageContent.path).toBe(capturedImagePath)
  expect([...capturedUrl.searchParams.keys()]).toEqual(['access'])
  expect(capturedUrl.searchParams.getAll('access')).toHaveLength(1)
  expect(capturedUrl.searchParams.get('access')).not.toBe('')
  const capturedQuery = capturedImageUrl.slice(capturedImageUrl.indexOf('?'))
  const rebaseImageUrl = (value: string): string => value !== capturedImageUrl ? value
    : origin + capturedImagePath + capturedQuery
  const evidence = process.env.DSH_UNIFIED_CONFIG_EVIDENCE_DIRECTORY
  test.onTestFailed(async () => {
    if (evidence === undefined) return
    await mkdir(evidence, { recursive: true })
    await writeFile(join(evidence, 'failure.json'), JSON.stringify({ phase, creates, errors, textPosts, outgoingHumans,
      nativePosts, nativeQueries, panelResults, catalogReads, discoveryResults, lastCatalog }, null, 2) + '\n')
    await writeFile(join(evidence, 'host-output.log'), readHostOutput())
    if (lastRaw !== '') await writeFile(join(evidence, 'failure-session.jsonl'), lastRaw)
  })
  const server = createServer((incoming, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const path = new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname
      response.setHeader('content-type', 'application/json')
      const answer = (value: unknown): void => { response.end(JSON.stringify({ success: true, data: value })) }
      const recorded = (name: string): void => {
        const fixture = apiFixture(name)
        response.statusCode = fixture.status
        for (const [field, values] of Object.entries(fixture.headers)) {
          if (field.toLowerCase() !== 'content-length') response.setHeader(field, values)
        }
        let body = fixture.body
        if (name === artifactManifest.name) {
          const manifest = structuredClone(object(body)), entries = (manifest.artifacts as unknown[]).map(object)
          expect(entries[0]?.content_url).toBe(capturedImageUrl)
          entries[0]!.content_url = rebaseImageUrl(capturedImageUrl); manifest.artifacts = entries; body = manifest
        }
        const bytes = fixture.body_base64 === undefined ? Buffer.from(JSON.stringify(body)) : Buffer.from(fixture.body_base64, 'base64')
        response.setHeader('content-length', bytes.length); response.end(bytes)
      }
      if (path === '/harness/v1/models') {
        catalogReads.push({ phase, path })
        expect(incoming.headers.authorization).toBe('Bearer sk-synthetic-unified-relay')
        recorded(directoryFixture(phase, 'models')); return
      }
      if (path === '/harness/api/pricing') { catalogReads.push({ phase, path }); recorded(directoryFixture(phase, 'pricing')); return }
      if (path === '/harness/api/status') { catalogReads.push({ phase, path }); recorded(directoryFixture(phase, 'status')); return }
      if (path === '/harness/api/user/self') { answer({ id: 7, username: 'unified-config-fixture', group: 'default', quota: 500000 }); return }
      if (path === '/harness/api/user/phone/challenge') {
        answer({ challenge_id: 'unified-challenge', delivery_status: 'accepted', expires_at: Math.floor(Date.now() / 1000) + 300,
          resend_after_seconds: 60, expires_in_minutes: 5 }); return
      }
      if (path === '/harness/api/user/phone/login') {
        response.setHeader('set-cookie', 'new_api_refresh=unified-refresh; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: 'synthetic-unified-access', access_expires_at: Math.floor(Date.now() / 1000) + 3600,
          relay_key: 'sk-synthetic-unified-relay', relay_key_id: 7, session: { sid: 'unified-existing-login', current: true },
          user: { id: 7, username: 'unified-config-fixture', quota: 500000 } }); return
      }
      if (path === '/harness/api/client-activity/heartbeat') { answer({ heartbeat_interval_seconds: 60 }); return }
      if (path === '/harness/api/client-activity/workload-snapshot') { answer({ accepted: true }); return }
      if (path === '/harness/api/client-announcements') { response.end(JSON.stringify(disabledBannerFeed)); return }
      if (path === '/harness/api/user/onboarding-survey') { response.end(JSON.stringify(noSurvey)); return }
      if (path === '/harness/api/log/self') { answer({ page: 1, page_size: 100, total: 0, items: [] }); return }
      if (path === '/harness/api/creation/content') {
        answer({ schemaVersion: 1, revision: 'unified-keyless', image: { templates: [] }, video: { templates: [] }, guide: { title: '', body: '' } }); return
      }
      if (path === '/harness/v1/chat/completions') {
        expect(incoming.headers.authorization).toBe('Bearer sk-synthetic-unified-relay')
        const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        const row = phase === 'updated' ? updated : newText
        textPosts.push({ phase, body, version: incoming.headers['x-yunshu-model-config-version'] })
        expect(body.model).toBe(row.id)
        expect(incoming.headers['x-yunshu-model-config-version']).toBe(readModelConfigVersion(row))
        expect(body.max_tokens).toBe(readProductModelLimits(row).maxTokens)
        expect(body).not.toHaveProperty('model_config_version')
        const attempt = textPosts.length
        let calls: { id: string; name: string; args: Row }[] = []
        let prose = attempt === 2 ? '已读取当前偏好与目录。' : '已读取更新后的同一组配置。'
        if (script === undefined) {
          if (attempt === 1 || attempt === 3) calls = [
            { id: `unified-image-${String(attempt)}`, name: 'list_image_models', args: {} },
            { id: `unified-video-${String(attempt)}`, name: 'list_video_models', args: {} },
          ]
        } else {
          const entry = script[attempt - 1]
          if (entry?.kind !== 'chunks') throw new Error('Expected persisted native model step')
          calls = entry.chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'
            ? [{ id: chunk.block.id, name: chunk.block.name, args: object(JSON.parse(chunk.block.arguments)) }] : [])
          prose = entry.chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'text' ? [chunk.block.text] : []).join('')
        }
        if (attempt > 4) throw new Error('Unexpected extra text provider request')
        const delta = calls.length > 0 ? { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: call.id,
          type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : { role: 'assistant', content: prose }
        response.setHeader('content-type', 'text/event-stream')
        response.setHeader('X-Yunshu-Model-Config-Version', text(readModelConfigVersion(row)))
        response.end([`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 2 } })}`, 'data: [DONE]', ''].join('\n\n')); return
      }
      if (incoming.method === 'POST' && /^\/harness\/v1\/(images|videos|video)/u.test(path)) {
        creates.push(path)
        const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        const original = nativeReplies.find(reply => reply.model.id === body.model)
        if (original === undefined) throw new Error('Only the two actual published aliases may create native work')
        expect(incoming.headers.authorization).toBe('Bearer sk-synthetic-unified-relay')
        expect(incoming.headers['x-yunshu-model-config-version']).toBe(readModelConfigVersion(original.model))
        expect(body).not.toHaveProperty('model_config_version')
        expect(body).not.toHaveProperty('session_id'); expect(body).not.toHaveProperty('account_id')
        nativePosts.push({ kind: original.kind, path, body, version: incoming.headers['x-yunshu-model-config-version'] })
        recorded(original.created.name); return
      }
      const original = nativeReplies.find(reply => path === `/harness/v1/tasks/${reply.taskId}`)
      if (original !== undefined && incoming.method === 'GET') {
        expect(incoming.headers.authorization).toBe('Bearer sk-synthetic-unified-relay')
        expect(incoming.headers['x-yunshu-model-config-version']).toBeUndefined()
        nativeQueries.push({ kind: original.kind, path }); recorded(original.readable.name); return
      }
      if (incoming.method === 'GET' && path === '/harness' + text(artifactManifest.path)) {
        recorded(artifactManifest.name); return
      }
      if (incoming.method === 'GET' && path === '/harness' + text(imageContent.path)) {
        expect(new URL(incoming.url ?? '/', 'http://127.0.0.1').search).toBe(capturedQuery)
        recorded(imageContent.name); return
      }
      errors.push(path); response.statusCode = 404; response.end('{}')
    })().catch((error: unknown) => { errors.push(String(error)); response.destroy() })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.server = () => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) }); server.closeAllConnections()
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected isolated loopback catalog')
  const origin = `http://127.0.0.1:${String(address.port)}/harness`
  const rebasedUrl = rebaseImageUrl(capturedImageUrl)
  expect(imageServerArtifactUrl(origin, imageReply.taskId, 'image', rebasedUrl)).toBe(rebasedUrl)
  const untouchedUrls = ['https://foreign.invalid' + capturedImagePath + capturedQuery,
    'http://localhost:3000/v1/tasks/task_other/artifacts/image/content' + capturedQuery,
    'http://localhost:3000' + capturedImagePath + '?access=another-valid-signed-value']
  for (const value of untouchedUrls) {
    expect(rebaseImageUrl(value)).toBe(value)
    expect(imageServerArtifactUrl(origin, imageReply.taskId, 'image', value)).toBeUndefined()
  }
  if (evidence !== undefined) {
    await mkdir(evidence, { recursive: true })
    await writeFile(join(evidence, 'TRANSPORT-REBASE.json'), JSON.stringify({ original: capturedImageUrl, rebased: rebasedUrl,
      actualGoSignatureVerifiedAtRebasedAddress: false, scope: 'one captured artifact manifest field in this Node loopback adapter',
      untouchedUrls, negativeControlsPassed: true }, null, 2) + '\n')
  }
  const overlay = join(root, 'unified.patch.json')
  await writeFile(overlay, JSON.stringify([
    { id: 'credits-index', config: { newApiBaseUrl: origin, baseUrl: '', bridgeBaseUrl: '', stateDir: credits,
      mediaCatalogCacheTtlMs: 0, creditsPerYuan: 1000, imageTaskTimeoutMs: 3000, videoTaskTimeoutMs: 3000,
      imagePollIntervalMs: 1000, videoPollIntervalMs: 1000 } },
    { id: 'artifacts-index', config: { defaultOutputDirectory: join(root, 'generated'), stateDirectory: join(root, 'artifact-state') } },
    { id: 'agent-default-model', config: { provider: 'yunshu-local', model: text(baseline), followPolicy: true } },
    { id: 'llm-deepseek', disabled: true },
    { id: 'llm-pi-ai', disabled: false },
    { id: 'session-persistence-jsonl', config: { root: persistence, compression: 'none' } },
    { id: 'session-title-llm', disabled: true }, { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'product-extensions', disabled: true }, { id: 'agent-instructions', disabled: true },
    { id: 'computer-use', disabled: true }, { id: 'computer-use-cua-driver-native', disabled: true },
  ]))
  const host = await startProfileWeb(root, workspace, overlay, {}, [join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')])
  readHostOutput = () => host.output().replaceAll('sk-synthetic-unified-relay', 'sk-{{synthetic}}')
    .replaceAll('synthetic-unified-access', '{{synthetic-access}}').replace(/\?token=[A-Za-z0-9_-]+/gu, '?token={{ephemeral-web-token}}')
  cleanup.host = () => host.stop()
  const post = async (path: string, body: unknown): Promise<Row> => {
    const response = await fetch(new URL(path, host.webUrl), { method: 'POST', headers: { cookie: host.cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
    expect(response.ok).toBe(true)
    return object(await response.json())
  }
  expect(await post('/credits/api/session/challenge', { phone: '+8613800000000', idempotencyKey: 'unified-login' })).toMatchObject({ ok: true })
  const signedIn = await post('/credits/api/session/verify', { challengeId: 'unified-challenge', code: '123456', idempotencyKey: 'unified-verify' })
  expect(signedIn, JSON.stringify(signedIn)).toMatchObject({ ok: true })
  await host.remote('workspace/create', { request: { path: workspace } })
  const loginBytes = await readFile(join(credits, 'session.json'))
  const browser = await chromium.launch(); cleanup.browser = () => browser.close()
  const browserContext = await browser.newContext({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 } })
  const delimiter = host.cookie.indexOf('=')
  await browserContext.addCookies([{ name: host.cookie.slice(0, delimiter), value: host.cookie.slice(delimiter + 1), url: host.webUrl }])
  const page = await browserContext.newPage(), tripwire = watchConsole(page)
  page.on('request', (request) => {
    if (new URL(request.url()).pathname !== '/api/session/prompt') return
    const payload = object(object(object(request.postDataJSON()).payload).args)
    const prompt = object(payload.request)
    outgoingHumans.push({ requestId: text(prompt.requestId), sessionId: text(prompt.sessionId) })
    activeSession = text(prompt.sessionId)
  })
  try {
    await page.goto(host.webUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '继续', exact: true }).click()
    await page.locator('[data-composer-input]').last().waitFor()
    const refresh = async (): Promise<void> => {
      const result = await host.remote('llm/discoverModels', { settingsNs: 'llm-pi-ai', request: { provider: 'yunshu-local', baseURL: `${origin}/v1` } })
      discoveryResults.push({ phase, result })
    }
    const catalog = async (): Promise<Row> => {
      lastCatalog = object(await host.remote('session/modelCatalog', {}))
      if (evidence !== undefined) await writeFile(join(evidence, 'host-output.log'), readHostOutput())
      return lastCatalog
    }
    const captureSettings = async (name: string): Promise<void> => {
      if (evidence === undefined) return
      const description = object(await host.remote('settings/describe', {}))
      const namespaces = (description.namespaces as unknown[]).map(object).filter(row => row.ns === 'llm-pi-ai')
        .map(({ ns, revision, value }) => ({ ns, revision, value }))
      await writeFile(join(evidence, `${name}-settings.json`), JSON.stringify({ phase, namespaces, lastCatalog, catalogReads,
        discoveryResults }, null, 2) + '\n')
    }
    const ids = (value: Row): string[] => (value.groups as unknown[]).map(object).flatMap(group =>
      (group.models as unknown[]).map(model => text(object(model).id)))
    expect(ids(await catalog())).not.toContain(newText.id)
    phase = 'draft'; await refresh()
    expect(ids(await catalog())).not.toContain(newText.id)
    phase = 'published'; await refresh()
    await captureSettings('before-publication-wait')
    // Generic discovery only previews. The writable shipped profile is synchronized
    // by the real account-owned listing and periodic product catalog refresh.
    await expect.poll(async () => ids(await catalog()), { timeout: 75_000, interval: 1000 }).toContain(newText.id)
    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: '模型', exact: true }).click()
    await settings.getByText(text(newText.id), { exact: true }).waitFor()
    expect(await settings.innerText()).toContain(`窗口 ${String(newTextLimits.contextWindow)} · 输出 ${String(newTextLimits.maxTokens)}`)
    if (evidence !== undefined) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'published-settings.png') }) }
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    const preferences = page.getByRole('button', { name: '图片/视频默认偏好', exact: true })
    await preferences.click()
    const editor = page.getByRole('dialog', { name: '创作偏好', exact: true })
    const catalogResponse = await fetch(new URL('/credits/api/media/preferences/catalog', host.webUrl), { headers: { cookie: host.cookie } })
    expect(catalogResponse.ok).toBe(true)
    const media = object(object(object(await catalogResponse.json()).payload).catalog)
    const chosenSpecifications = new Map<string, Row>()
    for (const [kind, tab, id] of [['image', '图片', newImage.id], ['video', '视频', newVideo.id]] as const) {
      const candidate = (media[kind] as unknown[]).map(object).find(value => value.id === id)
      if (candidate === undefined) throw new Error('New model is absent from the actual preference catalog')
      expect(candidate.modelConfigVersion).toBe(readModelConfigVersion(kind === 'image' ? newImage : newVideo))
      await editor.getByRole('tab', { name: tab, exact: true }).click()
      await editor.getByRole('textbox', { name: '搜索型号', exact: true }).fill(text(id))
      await editor.getByRole('button', { name: `${text(candidate.displayName)} ${text(id)}`, exact: true }).click()
      const specs = object(candidate.params).specifications as unknown[]
      const spec = object(specs[0])
      chosenSpecifications.set(kind, spec)
      if (kind === 'video') expect(quoteParameters).toMatchObject(spec)
      for (const points of unitPoints(candidate, spec, kind)) expect(points).toBeCloseTo(expectedUnitPoints[kind], 10)
      for (const [field, label] of [['size', '尺寸'], ['resolution', '分辨率'], ['ratio', '画幅'],
        ['seconds', '默认视频时长'], ['quality', '质量'], ['mode', '模式']] as const) {
        const desired = spec[field]
        if (desired === undefined) continue
        if (typeof desired !== 'string' && typeof desired !== 'number') throw new Error('A published static specification must be scalar')
        const select = editor.getByRole('combobox', { name: label, exact: true })
        await expect.poll(() => select.count()).toBe(1)
        if (await select.isEnabled()) await select.selectOption(JSON.stringify(desired))
        else expect(await select.locator('option:checked').innerText()).toContain(String(desired))
      }
      const displayedPrice = await editor.getByRole('status').filter({ hasText: kind === 'image' ? '积分/张' : '积分/秒' }).innerText()
      expect(displayedPrice).not.toContain('待核价')
      expect(renderedPoints(displayedPrice)).toContain(String(expectedUnitPoints[kind]))
    }
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await editor.waitFor({ state: 'detached' })
    const preferenceResponse = await fetch(new URL('/credits/api/media/preferences', host.webUrl), { headers: { cookie: host.cookie } })
    const preference = object(object(await preferenceResponse.json()).payload)
    expect(object(preference.image).model).toBe(newImage.id); expect(object(preference.video).model).toBe(newVideo.id)
    const trigger = page.getByRole('button', { name: /^(?:请选择模型|选择模型)/u })
    await trigger.click(); await page.getByRole('menuitem', { name: /^模型/u }).click()
    const modelSearch = page.getByRole('searchbox', { name: '搜索模型…', exact: true })
    if (await modelSearch.count() > 0) await modelSearch.fill(text(newText.id))
    const catalogModels = (object(await catalog()).groups as unknown[]).map(object)
      .flatMap(group => (group.models as unknown[]).map(object))
    const selectedModel = catalogModels.find(model => model.id === newText.id)
    if (selectedModel === undefined) throw new Error('New model must be present in the public selector catalog')
    const selected = page.getByRole('group', { name: '模型与推理等级', exact: true })
      .getByRole('menuitemradio', { name: text(selectedModel.name), exact: true })
    await expect.poll(() => selected.count()).toBe(1); await selected.click()
    for (const [index, prompt] of PROMPTS.entries()) {
      if (index === 1) {
        phase = 'updated'; await refresh()
        await expect.poll(async () => {
          const models = (object(await catalog()).groups as unknown[]).map(object).flatMap(group => (group.models as unknown[]).map(object))
          const row = models.find(model => model.id === newText.id)
          return row === undefined ? undefined : { contextWindow: object(row.limits).contextWindow,
            maxOutputTokens: object(row.limits).maxOutputTokens }
        }, { timeout: 75_000, interval: 1000 })
          .toEqual({ contextWindow: updated.context_window, maxOutputTokens: updated.max_output_tokens })
      }
      const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
      await composer.fill(prompt); await composer.press('Enter')
      await expect.poll(async () => {
        if (activeSession === undefined) return 0
        const raw = await storedSession(persistence, activeSession)
        if (raw !== undefined) lastRaw = raw
        return raw === undefined ? 0 : rows(raw).filter(row => row.type === 'turn/end').length
      }, { timeout: 30000 }).toBe(index + 1)
    }
    expect(textPosts).toHaveLength(4)
    expect(textPosts.map(value => value.phase)).toEqual(['published', 'published', 'updated', 'updated'])
    expect(creates).toEqual([]); expect(errors).toEqual([]); expect(tripwire.pageErrors).toEqual([])
    expect(await readFile(join(credits, 'session.json'))).toEqual(loginBytes)
    const outputs = toolResults(lastRaw)
    expect(outputs.map(output => output.name)).toEqual(['list_image_models', 'list_video_models', 'list_image_models', 'list_video_models'])
    for (const [index, output] of outputs.entries()) {
      const kind = output.name === 'list_image_models' ? 'image' : 'video', id = kind === 'image' ? newImage.id : newVideo.id
      const expected = fixtureRows(apiFixture(directoryFixture(index < 2 ? 'published' : 'updated', 'models'))).find(row => row.id === id)
      if (expected === undefined) throw new Error('Expected exact model in matching directory snapshot')
      const model = (output.value.models as unknown[]).map(object).find(value => value.id === id)
      const projected = catalogFromPricing(fixtureRows(apiFixture(directoryFixture(index < 2 ? 'published' : 'updated', 'pricing'))), 'default')
        .find(value => value.id === id)
      if (projected === undefined || !('specifications' in projected.params) || projected.params.specifications === undefined) {
        throw new Error('Published native model must expose complete backend combinations')
      }
      expect(model).toBeDefined(); expect(model?.specifications).toEqual(projected.params.specifications)
      expect(readModelConfigVersion(expected)).toBe(projected.modelConfigVersion)
      expect(output.value).toMatchObject({ default_model_id: id, default_configured: true, default_available: true, default_source: 'personal' })
      const selectedParameters = object(output.value.selected_parameters)
      expect(selectedParameters).toMatchObject(chosenSpecifications.get(kind)!)
      expect(resolveMediaSpecification(projected.params.specifications, selectedParameters))
        .toEqual({ ok: true, specification: chosenSpecifications.get(kind) })
    }
    const events = rows(normalizeWebSessionVolatiles(lastRaw)), requestIds = outgoingHumans.map(row => row.requestId)
    expect(requestIds).toHaveLength(2)
    for (const field of ['scope', 'revision'] as const) {
      const invalid = structuredClone(events), selection = invalid.find(row => row.type === 'media/request-selection')
      if (selection === undefined) throw new Error('Expected captured preference selection for relationship negative control')
      object(selection.data)[field] = preference[field] === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64)
      expect(() => normalizePreferenceIdentity(invalid, preference, requestIds)).toThrow()
    }
    const captured = normalizePreferenceIdentity(events, preference, requestIds)
    if (activeSession === undefined) throw new Error('Expected actual Session owner for native public creation requests')
    for (const original of nativeReplies) {
      const spec = chosenSpecifications.get(original.kind)
      if (spec === undefined) throw new Error('Actual preference editor must select a complete specification')
      const { seconds, ...dimensions } = spec
      const body = { session_id: activeSession, account_id: '7', model: original.model.id,
        prompt: original.prompt, ...dimensions,
        ...original.kind === 'image' ? { count: 1 } : { durationSeconds: seconds } }
      const path = original.kind === 'image' ? '/credits/api/image/generate' : '/credits/api/video/tasks?source=newapi-generate'
      const response = await post(path, body)
      expect(response).toMatchObject({ ok: original.kind === 'image',
        submission_state: original.kind === 'image' ? 'completed' : 'pending', task_id: original.taskId })
      expect(response.plan_id).toMatch(/^cp_[a-f0-9-]{36}$/u)
      expect(response.operation_id).toMatch(/^op_[A-Za-z0-9_-]+$/u)
      panelResults.push({ kind: original.kind, response })
    }
    expect(nativePosts.map(value => value.kind)).toEqual(['image', 'video'])
    expect(creates).toHaveLength(2)
    for (const original of nativeReplies) {
      expect(nativeQueries.some(value => value.kind === original.kind && value.path.endsWith('/' + original.taskId))).toBe(true)
      const sent = nativePosts.find(value => value.kind === original.kind)
      const spec = chosenSpecifications.get(original.kind)!
      expect(sent?.body).toMatchObject({ model: original.model.id, prompt: original.prompt,
        ...original.kind === 'image' ? { n: 1 } : { seconds: spec.seconds, duration: spec.seconds } })
      for (const field of ['size', 'resolution', 'ratio', 'quality', 'mode'] as const) {
        if (spec[field] !== undefined) expect(sent?.body[field]).toBe(spec[field])
      }
      if (original.kind === 'image') {
        const supplied = object(original.supplier.params)
        expect(sent?.body).toMatchObject({ n: supplied.count, size: supplied.size, resolution: supplied.resolution })
      } else expect(sent?.body).toMatchObject({ seconds: original.supplier.duration,
        duration: original.supplier.duration, resolution: original.supplier.resolution, ratio: original.supplier.ratio })
      if (original.created.path !== undefined) expect(sent?.path).toBe('/harness' + original.created.path)
    }
    const projectsResponse = await fetch(new URL(`/credits/api/creative/projects?session_id=${activeSession}`, host.webUrl),
      { headers: { cookie: host.cookie } })
    expect(projectsResponse.ok).toBe(true)
    const projects = (object(object(await projectsResponse.json()).payload).projects as unknown[]).map(object)
    expect(projects).toHaveLength(2)
    for (const original of nativeReplies) {
      const project = projects.find(value => value.kind === original.kind)
      const tasks = (project?.tasks as unknown[]).map(object)
      expect(tasks).toHaveLength(1)
      expect(object(tasks[0]![original.kind === 'image' ? 'imageReceipt' : 'videoReceipt']).taskId).toBe(original.taskId)
    }
    phase = 'repriced'
    const repricedResponse = await fetch(new URL('/credits/api/media/preferences/catalog', host.webUrl), { headers: { cookie: host.cookie } })
    expect(repricedResponse.ok).toBe(true)
    const repriced = object(object(object(await repricedResponse.json()).payload).catalog)
    const repricedModels = fixtureRows(apiFixture(directoryFixture('repriced', 'models')))
    const repricedQuote = object(apiFixture('new-video-quote-after-price-update').body)
    expect(readModelConfigVersion(repricedQuote)).toBe(readModelConfigVersion(repricedModels.find(row => row.id === newVideo.id)!))
    expect(Number(repricedQuote.one_work_quota)).toBe(Number(initialQuote.one_work_quota) * 2)
    await preferences.click()
    const changedEditor = page.getByRole('dialog', { name: '创作偏好', exact: true })
    for (const original of nativeReplies) {
      const candidate = (repriced[original.kind] as unknown[]).map(object).find(row => row.id === original.model.id)
      if (candidate === undefined) throw new Error('Repriced aliases must remain available without creating another task')
      expect(candidate.modelConfigVersion).toBe(readModelConfigVersion(repricedModels.find(row => row.id === original.model.id)!))
      expect(candidate.modelConfigVersion).not.toBe(readModelConfigVersion(original.model))
      for (const points of unitPoints(candidate, chosenSpecifications.get(original.kind)!, original.kind)) {
        expect(points).toBeCloseTo(expectedUnitPoints[original.kind] * 2, 10)
      }
      await changedEditor.getByRole('tab', { name: original.kind === 'image' ? '图片' : '视频', exact: true }).click()
      await expect.poll(async () => renderedPoints(await changedEditor.getByRole('status')
        .filter({ hasText: original.kind === 'image' ? '积分/张' : '积分/秒' }).innerText()), { timeout: 5000 })
        .toContain(String(expectedUnitPoints[original.kind] * 2))
    }
    await changedEditor.getByRole('button', { name: '取消', exact: true }).click()
    expect(nativePosts).toHaveLength(2)
    const postPanel = await storedSession(persistence, activeSession)
    expect(postPanel).toBe(lastRaw)
    expect(textPosts).toHaveLength(4); expect(errors).toEqual([])
    expect(await readFile(join(credits, 'session.json'))).toEqual(loginBytes)
    await browser.close(); await host.stop()
    expect(await captureWorkspaceSnapshot(workspace)).toEqual(await captureExpectedWorkspaceSnapshot(join(DIRECTORY, 'workspace.expected')))
    const completedImage = panelResults.find(value => value.kind === 'image')
    if (completedImage === undefined || imageContent.body_base64 === undefined) throw new Error('Actual PNG original and completed image are required')
    const imagePayload = object(completedImage.response.payload), imagePath = text(imagePayload.path)
    expect(imagePayload.paths).toEqual([imagePath])
    const imageRelative = relative(join(root, 'generated'), imagePath)
    expect(imageRelative).not.toMatch(/^\.\.|^[/\\]/u)
    expect(await readFile(imagePath)).toEqual(Buffer.from(imageContent.body_base64, 'base64'))
    const generated = await captureWorkspaceSnapshot(join(root, 'generated'))
    const imageEntries = generated.filter(entry => entry.path === imageRelative.split('\\').join('/'))
    expect(imageEntries).toHaveLength(1)
    const normalizedGenerated = generated.map(entry => entry.path === imageRelative.split('\\').join('/')
      ? { ...entry, path: 'native-image.png' } : entry)
    expect(normalizedGenerated).toEqual(await captureExpectedWorkspaceSnapshot(join(DIRECTORY, 'generated.expected')))
    if (activeSession === undefined) throw new Error('Expected one actual persisted Session')
    const normalized = captured.map(row => JSON.stringify(row)).join('\n') + '\n'
    const context = { sessionIds: [activeSession], cwd: workspace }
    const prompts = normalizedSystemPrompts(normalized, context)
      .map(value => value.split(REPO_ROOT).join('{{sourceRoot}}').split(host.webUrl).join('{{webUrl}}'))
    const schemas = normalizedToolSchemas(normalized, context)
    const promptSidecar = formatSystemPromptSnapshot(prompts[0]!, prompts.slice(1))
    const schemaSidecar = formatToolSchemasSnapshot(schemas[0]!, schemas.slice(1))
    if (mode === 'refresh') {
      await writeFile(FIXTURE, redactSessionSnapshotIds([scrubSessionSnapshot(tokenizeSessionFixtureCwd(normalized))])[0]!)
      await writeFile(join(DIRECTORY, 'system-prompt.expected.md'), promptSidecar)
      await writeFile(join(DIRECTORY, 'tool-schemas.expected.json'), schemaSidecar)
    }
    const expected = await readFile(FIXTURE, 'utf8')
    expect(normalizeSessionSnapshots([normalized], context)[0]).toBe(normalizeSessionSnapshots([expected], fixtureContext(expected))[0])
    expect(promptSidecar).toBe(await readFile(join(DIRECTORY, 'system-prompt.expected.md'), 'utf8'))
    expect(schemaSidecar).toBe(await readFile(join(DIRECTORY, 'tool-schemas.expected.json'), 'utf8'))
    if (evidence !== undefined) await writeFile(join(evidence, 'result.json'), JSON.stringify({ mode, apiFixtureSha: apiFixtureSet().sha256,
      nativeLists: outputs, textRequests: textPosts.map(value => ({ phase: value.phase, model: value.body.model,
        maxTokens: value.body.max_tokens, version: value.version })), loginPreserved: true, mediaCreates: creates.length,
      nativePosts, nativeQueries, panelResults, expectedUnitPoints, repricedPointsFactor: 2,
      localObservationOnly: true, imageOriginalSha: createHash('sha256')
        .update(await readFile(imagePath)).digest('hex'), generatedImageFilename: basename(imagePath),
      sessionSha: createHash('sha256').update(expected).digest('hex'), actualGoLedgerReplayed: false, paidCalls: 0 }, null, 2) + '\n')
  } catch (error) {
    if (evidence !== undefined && !page.isClosed()) {
      await page.screenshot({ path: join(evidence, 'failure-page.png') })
      await writeFile(join(evidence, 'failure-page.txt'), await page.locator('body').innerText())
      const description = object(await host.remote('settings/describe', {}))
      const namespaces = (description.namespaces as unknown[]).map(object).filter(row => row.ns === 'llm-pi-ai')
        .map(({ ns, revision, value }) => ({ ns, revision, value }))
      await writeFile(join(evidence, 'failure-settings.json'), JSON.stringify({ namespaces, catalogReads, discoveryResults, lastCatalog }, null, 2) + '\n')
    }
    throw error
  }
})
