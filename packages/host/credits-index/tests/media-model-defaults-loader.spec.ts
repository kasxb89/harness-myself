/** Effective per-request model choices through the production Loader and tool registry. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import LocalFS from '@deepseek-ai/dsh-fs-local'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import * as Credits from '../src/index.ts'
import { catalogFromPricing } from '../src/media.ts'
import { MediaPreferencesStore, mediaPreferencesScope } from '../src/media-preferences.ts'

const video = 'ycapi-seedance-2-0-official'
const pricing = [
  { model_name: 'MiniMax-H3', display_name: 'mt-MiniMax-H3', supported_endpoint_types: ['openai-video'] },
  { model_name: video, display_name: 'Seedance 2.0', supported_endpoint_types: ['openai-video'], parameters: {
    oneOf: [5, 10].map(seconds => ({ properties: { quality: { enum: ['standard'] }, ratio: { enum: ['16:9'] },
      resolution: { enum: ['1080p'] }, seconds: { enum: [seconds] } } })),
  } },
  { model_name: 'ycapi-minimax-h3', supported_endpoint_types: ['openai-video'], parameters: {
    oneOf: ['768p', '2k'].flatMap(resolution => [5, 10].map(seconds => ({ properties: {
      ratio: { enum: ['16:9'] }, resolution: { enum: [resolution] }, seconds: { enum: [seconds] } } }))),
  } },
  { model_name: 'image-a', supported_endpoint_types: ['image-generation'], parameters: {
    size: { enum: ['1:1', '16:9'] }, resolution: { enum: ['1k', '2k'] },
    oneOf: [{ size: { const: '1:1' }, resolution: { const: '1k' } },
      { size: { const: '16:9' }, resolution: { const: '2k' } }],
  } },
]
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllGlobals()
})

async function fixture(savedPreferences = true) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-model-defaults-loader-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const stateDir = join(directory, 'credits')
  await mkdir(stateDir)
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({ token: 'fixture-product-token',
    expiresAt: '9999-01-01T00:00:00.000Z', account: { id: '7', phone: 'fixture' },
    upstream: { token: 'fixture-access', expiresAt: '9999-01-01T00:00:00.000Z' },
    relay: { key: 'fixture-relay' } }))
  const base = 'http://127.0.0.1:32127/harness'
  const preferences = new MediaPreferencesStore(join(stateDir, 'media-preferences'))
  const scope = mediaPreferencesScope(base, '7')
  const initial = await preferences.read(scope)
  if (savedPreferences) await preferences.save(scope, 'a'.repeat(64), { schema_version: 1, expected_account_owner: 'a'.repeat(64),
    expected_revision: initial.revision, image: { model: 'image-a', parameters: {} },
    video: { model: video, parameters: {} } }, catalogFromPricing(pricing, null), async () => {})
  let visible = pricing.map(row => row.model_name)
  const posts: string[] = []
  const submissions: unknown[] = []
  const quotes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== 'http://127.0.0.1:32127') throw new Error('Only the fixture relay is permitted')
    if (init?.method === 'POST') posts.push(url.pathname)
    if (url.pathname === '/harness/v1/video/quote') {
      if (typeof init?.body !== 'string') throw new Error('Expected fixture JSON quote')
      const quote: unknown = JSON.parse(init.body)
      quotes.push(quote)
    }
    if (url.pathname === '/harness/v1/video/generations') {
      if (typeof init?.body !== 'string') throw new Error('Expected fixture JSON generation')
      const submission: unknown = JSON.parse(init.body)
      submissions.push(submission)
      return Response.json({ error: { code: 'FIXTURE_REJECTED', message: 'Synthetic rejection' } }, { status: 400 })
    }
    if (url.pathname === '/harness/api/status') return Response.json({ success: true, data: {
      client_media_defaults: { schema_version: 1, default_image_model: '', default_video_model: '' },
    } })
    if (url.pathname === '/harness/api/user/self') return Response.json({ success: true,
      data: { id: 7, group: 'default', quota: 500000 } })
    if (url.pathname === '/harness/api/pricing') return Response.json({ success: true, data: pricing })
    if (url.pathname === '/harness/v1/models') return Response.json({ data: pricing.filter(row => visible.includes(row.model_name))
      .map(row => ({ id: row.model_name, supported_endpoint_types: row.supported_endpoint_types })) })
    return Response.json({ success: false }, { status: 404 })
  }))
  const config = join(directory, 'cordis.yml')
  await writeFile(config, [
    '- name: system-prompt', '- name: tools', '- name: agents', '- name: session-projections', '- name: jobs', '- name: fs', '- name: user-questions',
    '- name: webserver', '  config:', "    host: '127.0.0.1'", '    port: 0',
    '- name: credits', '  config:', `    stateDir: '${stateDir}'`, `    newApiBaseUrl: '${base}'`,
    '    timeoutMs: 1000', '    accountReadMinIntervalMs: 0', '',
  ].join('\n'))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['system-prompt', SystemPrompt], ['tools', Tools], ['agents', AgentRegistry],
    ['session-projections', SessionProjections], ['jobs', LocalJobs], ['fs', LocalFS], ['user-questions', UserQuestions], ['webserver', WebServer], ['credits', Credits]])
  ctx.loader.internal = { version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
    if (!modules.has(specifier)) throw new Error(`Unexpected fixture module ${specifier}`)
    return modules.get(specifier)
  } } as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const id = SessionId('model-defaults')
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd: directory })
  const unsupported = (): never => { throw new Error('Fixture inbox is immutable') }
  const agent: Agent = { id, session, ctx, options: {}, status: 'running',
    inbox: { nextTurn: [], nextStep: [], clear: unsupported, append: unsupported, prepend: unsupported,
      replace: unsupported, remove: unsupported, splice: unsupported },
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal) }
  await ctx.agents.register(agent)
  let turn = 0
  let step = 0
  const human = async (text: string) => {
    if (turn > 0) session.append('turn/end', { turn, reason: { kind: 'completed' } })
    turn += 1
    const requestId = brandString<SessionRequestId>(`request-${String(turn)}`)
    const message = createUserMessage({ source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text }] })
    await ctx.waterfall('session/prompt-admission', { agent, requestId, message }, async () => {})
    session.append('turn/start', { turn })
    session.append('user/message', message, { surfaceOp: 'append' })
  }
  const call = async (name: string, args: Record<string, unknown>) => {
    const callId = ToolCallId(`model-call-${String(++step)}`)
    const event = session.append('tool/call', { turn, step, callId, name, arguments: JSON.stringify(args) })
    const result = await ctx.tools.execute({ name, callId, arguments: args, agent, signal: new AbortController().signal })
    session.append('tool/result', { turn, step, message: createToolResultMessage({ callId, content: result.content,
      isError: result.isError }) }, { surfaceOp: 'append', sourceEventSeqs: [event.seq] })
    expect(result.isError).toBe(false)
    if (result.value === null || typeof result.value !== 'object' || Array.isArray(result.value)) throw new Error('Expected tool object')
    return result.value as Record<string, unknown>
  }
  return { ctx, agent, human, call, posts, submissions, quotes, hideSavedModel: () => { visible = visible.filter(id => id !== video) } }
}

it('keeps model-only saved choices visible, then corrects the unsubmitted request using that same model', async () => {
  const f = await fixture()
  await f.human('生成一分钟视频')
  const videoList = await f.call('list_video_models', {})
  expect(videoList).toMatchObject({ status: 'listed', default_model_id: video, default_configured: true,
    default_available: true, default_source: 'personal', selected_parameters: {}, default_error_code: 'SPECIFICATION_REQUIRED' })
  const imageList = await f.call('list_image_models', {})
  expect(imageList).toMatchObject({ status: 'listed', default_model_id: 'image-a', default_available: true,
    default_source: 'personal', selected_parameters: {}, default_error_code: 'SPECIFICATION_REQUIRED' })
  const mismatched = await f.call('generate_video_project', { prompt: '自然纪录短片', model: 'MiniMax-H3',
    resolution: '768P', ratio: '9:16', total_duration_seconds: 60 })
  expect(mismatched).toMatchObject({ status: 'failed', code: 'MEDIA_MODEL_MISMATCH' })
  const corrected = await f.call('generate_video_project', { prompt: '自然纪录短片', model: video,
    quality: 'standard', resolution: '1080p', ratio: '16:9',
    shot_prompts: Array.from({ length: 6 }, (_, index) => `镜头${String(index + 1)}`),
    shot_durations_seconds: [10, 10, 10, 10, 10, 10], total_duration_seconds: 60 })
  // The corrected selection reaches the next, intentionally unprovided local editor capability.
  expect(corrected).toMatchObject({ status: 'failed', code: 'VIDEO_EDIT_SERVICE_UNAVAILABLE' })
  expect(f.posts).toEqual([])
  expect(f.ctx.jobs.list(f.agent.id)).toEqual([])
  const defaults = (listed: Record<string, unknown>) => Object.fromEntries(Object.entries(listed)
    .filter(([key]) => key.startsWith('default_') || key === 'selected_parameters'))
  await expect(JSON.stringify({ video: defaults(videoList), image: defaults(imageList),
    conflict: { status: mismatched.status, code: mismatched.code } }, null, 2) + '\n')
    .toMatchFileSnapshot('./expected/media-model-defaults.json')
})

it.each(['用H3生成15秒视频，768P', '用mt-MiniMax-H3生成15秒视频，768P'])(
  'reports the human model choice for %s rather than the saved personal model', async (text) => {
    const f = await fixture()
    await f.human(text)
    expect(await f.call('list_video_models', {})).toMatchObject({ status: 'listed', default_model_id: 'MiniMax-H3',
      default_available: true, default_source: 'human', selected_parameters: { resolution: '768P', seconds: 15 } })
    expect(f.posts).toEqual([])
  })

it('retains a removed saved model identity while marking it unavailable', async () => {
  const f = await fixture()
  f.hideSavedModel()
  await f.human('生成一分钟视频')
  expect(await f.call('list_video_models', {})).toMatchObject({ status: 'listed', default_model_id: video,
    default_available: false, default_source: 'personal', default_error_code: 'MEDIA_MODEL_UNAVAILABLE' })
  expect(f.posts).toEqual([])
})


it.each([
  ['生成5秒视频', 5, undefined, '768P'],
  ['用mt-MiniMax-H3生成15秒视频', 15, '768p', '768P'],
  ['用mt-MiniMax-H3生成15秒2K视频', 15, '2K', '2K'],
] as const)(
  'normalizes the exact direct-H3 alias through the real no-preference entry for %s', async (text, seconds, resolution, expected) => {
    const f = await fixture(false)
    await f.human(text)
    const result = await f.call('generate_video', { prompt: '自然纪录短片', model: 'mt-MiniMax-H3',
      ...resolution === undefined ? {} : { resolution }, ratio: '16:9', duration_seconds: seconds })
    expect(f.posts).toContain('/harness/v1/video/generations')
    expect(f.submissions).toHaveLength(1)
    expect(f.submissions).toMatchObject([{ model: 'MiniMax-H3', metadata: { resolution: expected } }])
    expect(result).toMatchObject({ status: 'unknown', code: 'VIDEO_SUBMISSION_UNKNOWN', model: 'MiniMax-H3' })
  })


it.each([[video, '1080P', '1080p'], ['ycapi-minimax-h3', '768p', '768p']] as const)(
  'quotes the exact %s route using its declared resolution for %s with no personal preference', async (model, requested, resolution) => {
    const f = await fixture(false)
    await f.human('生成5秒视频')
    const result = await f.call('generate_video', { prompt: '自然纪录短片', model, resolution: requested,
      ratio: '16:9', duration_seconds: 5, ...model === video ? { quality: 'standard' } : {} })
    expect(result).toMatchObject({ status: 'failed', code: 'CREATIVE_VIDEO_QUOTE_UNAVAILABLE' })
    const quote = f.quotes.find(value => typeof value === 'object' && value !== null && 'model' in value && value.model === model)
    expect(quote).toMatchObject({ model, segments: [{ parameters: { resolution } }] })
    expect(f.submissions).toEqual([])
  },
)

it('does not reinterpret an undeclared YC 768k tier as its 768p paid specification', async () => {
  const f = await fixture(false)
  await f.human('生成5秒视频')
  const result = await f.call('generate_video', { prompt: '自然纪录短片', model: 'ycapi-minimax-h3',
    resolution: '768k', ratio: '16:9', duration_seconds: 5 })
  expect(result).toMatchObject({ status: 'failed', code: 'SPECIFICATION_NOT_SUPPORTED' })
  expect(f.quotes).toEqual([])
  expect(f.submissions).toEqual([])
})

it('preserves the unsupported tier from a real human YC request before any quote', async () => {
  const f = await fixture(false)
  await f.human('用ycapi-minimax-h3生成5秒768k视频')
  const result = await f.call('generate_video', { prompt: '自然纪录短片', model: 'ycapi-minimax-h3',
    resolution: '768k', ratio: '16:9', duration_seconds: 5 })
  expect(result).toMatchObject({ status: 'failed', code: 'SPECIFICATION_NOT_SUPPORTED' })
  expect(f.quotes).toEqual([])
  expect(f.submissions).toEqual([])
})
