/** Fixed ordinary-user forum route family with private login-owned one-shot transport. */
import { createDemandTransport, type DemandAccount, type DemandProxyOptions, type DemandTransportRoute } from './demand-proxy.ts'
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
    '/uploads': { POST: 'upload-init' }, '/profile': { GET: 'profile', PATCH: 'profile-update' },
    '/me/posts': { GET: 'my-posts' }, '/me/comments': { GET: 'my-comments' }, '/receipts': { GET: 'receipt' },
    '/notifications': { GET: 'notifications' }, '/notifications/unread': { GET: 'notifications-unread' },
    '/notifications/read': { POST: 'notifications-read' },
  }
  const kind = exact[path]?.[method]
  if (kind !== undefined) return { kind, suffix: path, method }
  const match = /^\/(posts|uploads|attachments)\/([^/]+)(?:\/(comments|like|chunks|complete|link|content))?(?:\/([^/]+))?$/u.exec(path)
  if (match === null) return undefined
  let id: string, secondaryId: string | undefined
  try { id = forumId(match[2]); secondaryId = match[4] === undefined ? undefined : forumId(match[4]) }
  catch (_invalidId: unknown) { return undefined }
  const family = match[1], action = match[3]
  if (secondaryId !== undefined) return family === 'posts' && action === 'comments' && method === 'GET'
    ? { kind: 'comment', suffix: path, method, resourceId: id, secondaryId } : undefined
  const selected = family === 'posts' ? action === undefined && method === 'GET' ? 'post'
    : action === 'comments' ? method === 'GET' ? 'comments' : method === 'POST' ? 'create-comment' : undefined
      : action === 'like' && method === 'PUT' ? 'like' : undefined
    : family === 'uploads' ? action === undefined && method === 'GET' ? 'upload-status'
      : action === 'chunks' && method === 'PUT' ? 'upload-chunk' : action === 'complete' && method === 'POST' ? 'upload-complete' : undefined
      : family === 'attachments' ? action === 'link' && method === 'POST' ? 'link'
        : action === 'content' && (method === 'GET' || method === 'HEAD') ? 'content' : undefined : undefined
  return selected === undefined ? undefined : { kind: selected, suffix: path, method, resourceId: id,
    ...family === 'uploads' ? { uploadId: id } : {}, ...family === 'attachments' ? { attachmentId: id } : {} }
}
function mapCode(code: string): string {
  if (code === 'DEMAND_PERMISSION_DENIED') return 'FORUM_FORBIDDEN'
  if (code === 'DEMAND_CONFLICT') return 'FORUM_REQUEST_CONFLICT'
  return code.startsWith('DEMAND_') ? 'FORUM_' + code.slice('DEMAND_'.length) : code
}

/**
 * Build an account-guarded forum attachment URL without exposing a signed capability.
 * @param id - Validated forum attachment UUID.
 * @param account - Captured ordinary account and opaque login owner.
 * @param disposition - Inline preview or original-file download intent.
 * @returns The fixed local content path, never an arbitrary upstream URL.
 */
export function forumContentPath(id: string, account: Pick<DemandAccount, 'id' | 'owner'>, disposition: string): string {
  return `${FORUM_LOCAL_BASE_PATH}/attachments/${forumId(id)}/content?${new URLSearchParams({
    account_id: account.id, account_owner: account.owner, disposition,
  })}`
}

/**
 * Build a credential-free forum facade without exposing administration or other media families.
 * @param options - Existing account/Connection ownership and bounded transport configuration.
 * @returns A one-shot handler and quiescent disposal, without implicit publication or retries.
 */
export function createForumProxy(options: ForumProxyOptions): ReturnType<typeof createDemandTransport> {
  return createDemandTransport({ ...options, upstreamBasePath: FORUM_UPSTREAM_BASE_PATH,
    limits: () => ({ maxJsonRequestBytes: 131_072, maxJsonResponseBytes: 8_388_608, ...options.limits() }),
  }, {
    localBasePath: FORUM_LOCAL_BASE_PATH, selectRoute, request: forumRequest, query: forumQuery, response: forumResponse,
    remoteCodes: FORUM_ERRORS, mapCode, httpErrorFallback: true,
    contentPath: forumContentPath,
  })
}
