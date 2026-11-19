/** Fixed ordinary-user forum route family with private login-owned one-shot transport. */
import { DemandProtocolError } from './demand-protocol.ts'
import { createDemandTransport, type DemandProxyOptions, type DemandTransportRoute } from './demand-proxy.ts'
import { FORUM_ERRORS, forumId, forumQuery, forumRequest, forumResponse } from './forum-protocol.ts'

/** The only upstream authority family reachable through this public-forum handler. */
export const FORUM_UPSTREAM_BASE_PATH = '/api/product/forum'
/** Renderer forum requests remain on the owner-guarded local Host origin. */
export const FORUM_LOCAL_BASE_PATH = '/credits/api/forum'
/** Existing credential ownership and configured JSON ceilings are supplied by Host composition. */
export type ForumProxyOptions = Omit<DemandProxyOptions, 'upstreamBasePath'>

function selectRoute(path: string, method: string): DemandTransportRoute | undefined {
  const exact: Record<string, Readonly<Record<string, string>>> = {
    '/config': { GET: 'config' }, '/posts': { GET: 'posts', POST: 'create-post' },
  }
  const kind = exact[path]?.[method]
  if (kind !== undefined) return { kind, suffix: path, method }
  const match = /^\/posts\/([^/]+)(?:\/(comments|like))?$/u.exec(path)
  if (match === null) return undefined
  let id: string
  try { id = forumId(match[1]) } catch (_invalidId: unknown) { return undefined }
  const action = match[2]
  const selected = action === undefined && method === 'GET' ? 'post'
    : action === 'comments' ? method === 'GET' ? 'comments' : method === 'POST' ? 'create-comment' : undefined
      : action === 'like' && method === 'PUT' ? 'like' : undefined
  return selected === undefined ? undefined : { kind: selected, suffix: path, method, resourceId: id }
}
function mapCode(code: string): string {
  if (code === 'DEMAND_PERMISSION_DENIED') return 'FORUM_FORBIDDEN'
  if (code === 'DEMAND_CONFLICT') return 'FORUM_REQUEST_CONFLICT'
  return code.startsWith('DEMAND_') ? 'FORUM_' + code.slice('DEMAND_'.length) : code
}

/**
 * Build a credential-free forum facade without exposing admin or media routes.
 * @param options - Existing account/Connection ownership and bounded transport configuration.
 * @returns A one-shot handler and quiescent disposal, without implicit publication or retries.
 */
export function createForumProxy(options: ForumProxyOptions): ReturnType<typeof createDemandTransport> {
  return createDemandTransport({ ...options, upstreamBasePath: FORUM_UPSTREAM_BASE_PATH,
    limits: () => ({ maxJsonRequestBytes: 131_072, maxJsonResponseBytes: 8_388_608, ...options.limits() }),
  }, {
    localBasePath: FORUM_LOCAL_BASE_PATH, selectRoute, request: forumRequest, query: forumQuery, response: forumResponse,
    remoteCodes: FORUM_ERRORS, mapCode, httpErrorFallback: true,
    contentPath: () => { throw new DemandProtocolError() },
  })
}
