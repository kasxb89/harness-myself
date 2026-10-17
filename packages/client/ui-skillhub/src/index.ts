/** Authenticated local routes for the product's SkillHub community store. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import { isAbsolute } from 'node:path'
import { SkillHubClient, SkillHubFailure, isSkillHubSlug, type SkillHubExecutionConfig } from './skillhub-cli.ts'
import { SKILLHUB_INSTALL_PATH, SKILLHUB_INSTALLED_PATH, SKILLHUB_RECOMMENDATIONS_PATH, SKILLHUB_SEARCH_PATH } from './paths.ts'

/** Cordis plugin identity. */
export const name = 'client-ui-skillhub'
/** Host capabilities used by the product store. */
export const inject = ['connection', 'subprocess']

/** Product-private official CLI execution settings. */
export interface Config extends SkillHubExecutionConfig {
  /** Absolute directory receiving product-managed user skills; supplied by the product bundle. */
  readonly skillsDirectory: string
  /** Absolute product-private directory for the official CLI and its state; supplied by the product bundle. */
  readonly cacheDirectory: string
}

/** Validate deployment-varying execution budgets at activation. */
export const Config: Schema<Config> = Schema.object({
  skillsDirectory: Schema.string().min(1).required(),
  cacheDirectory: Schema.string().min(1).required(),
  pythonExecutable: Schema.string().min(1).default('python3'),
  timeoutMs: Schema.number().step(1).min(1).max(2_147_483_647).default(120_000),
  terminationGraceMs: Schema.number().step(1).min(1).max(2_147_483_647).default(1_000),
  maxOutputBytes: Schema.number().step(1).min(1).default(1_048_576),
  maxDownloadBytes: Schema.number().step(1).min(1).default(1_048_576),
  searchLimit: Schema.number().step(1).min(1).max(100).default(20),
  searchTimeoutMs: Schema.number().step(1).min(1).max(2_147_483_647).default(15_000),
})

/**
 * Mount the authenticated store; unloading removes routes and joins live CLI requests.
 * @param ctx - Host plugin context with Connection and subprocess capabilities.
 * @param config - Loader-resolved execution settings.
 */
export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.skillsDirectory) || !isAbsolute(config.cacheDirectory)) {
    throw new Error('skillhub: skillsDirectory and cacheDirectory must be absolute paths')
  }
  const client = new SkillHubClient(ctx, config, config.cacheDirectory, config.skillsDirectory)
  ctx.effect(() => () => client.dispose(), 'skillhub: cancel and join requests')
  const handle = (action: (request: Request, signal: AbortSignal) => Promise<object>) => async (request: Request): Promise<Response> => {
    try {
      return Response.json(await client.run(request.signal, signal => action(request, signal)))
    } catch (error) {
      const code = error instanceof SkillHubFailure ? error.code : 'unexpected'
      const status = code === 'invalid-request' ? 400 : code === 'already-installed' || code === 'busy' ? 409
        : code === 'cancelled' ? 499 : code === 'timeout' ? 504 : 502
      return Response.json({ ok: false, code }, { status })
    }
  }
  ctx.connection.fetch.register({ path: SKILLHUB_SEARCH_PATH, methods: ['GET'], requestBody: 'buffered', fetch: handle(async (request, signal) => {
    const query = new URL(request.url).searchParams.get('q')?.trim()
    if (query === undefined || query.length === 0 || query.length > 200 || query.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(query)) {
      throw new SkillHubFailure('invalid-request')
    }
    return { ok: true, skills: await client.search(query, signal) }
  }) })
  ctx.connection.fetch.register({ path: SKILLHUB_INSTALLED_PATH, methods: ['GET'], requestBody: 'buffered', fetch: handle(async () => (
    { ok: true, skills: await client.installed() }
  )) })
  ctx.connection.fetch.register({
    path: SKILLHUB_RECOMMENDATIONS_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: handle(async (_request, signal) => ({ ok: true, skills: await client.recommendations(signal) })),
  })
  ctx.connection.fetch.register({ path: SKILLHUB_INSTALL_PATH, methods: ['POST'], requestBody: 'buffered', fetch: handle(async (request, signal) => {
    let value: unknown
    try { value = await request.json() } catch (error) { throw new SkillHubFailure('invalid-request', { cause: error }) }
    if (typeof value !== 'object' || value === null || !('slug' in value) || !isSkillHubSlug(value.slug)) throw new SkillHubFailure('invalid-request')
    return { ok: true, skill: await client.install(value.slug, signal) }
  }) })
}
