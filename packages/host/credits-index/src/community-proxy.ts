/** Fixed community route family using the existing login-owned one-shot transport. */
import { communityId, communityQuery, communityRequest, communityResponse, COMMUNITY_ERRORS } from './community-protocol.ts'
import { createDemandTransport, type DemandAccount, type DemandProxyOptions, type DemandTransportRoute } from './demand-proxy.ts'

/** Only the frozen ordinary-user community API may be reached by this handler. */
export const COMMUNITY_UPSTREAM_BASE_PATH = '/api/product/community-demands'
/** Browser requests and media stay under this fixed local namespace. */
export const COMMUNITY_LOCAL_BASE_PATH = '/credits/api/community-demands'
/** Community mapping is fixed; caller composition supplies only existing login ownership and ceilings. */
export type CommunityProxyOptions = Omit<DemandProxyOptions, 'upstreamBasePath'>

function selectRoute(path: string, method: string): DemandTransportRoute | undefined {
  const exact: Record<string, Readonly<Record<string, string>>> = { '/config': { GET: 'config' },
    '/listings': { GET: 'listings' }, '/orders': { GET: 'orders', POST: 'create' }, '/uploads': { POST: 'upload-init' } }
  const kind = exact[path]?.[method]
  if (kind !== undefined) return { kind, suffix: path, method }
  const match = /^\/(listings|orders|uploads|attachments)\/([^/]+)(?:\/(messages|read|actions|accept|content|complete|link))?$/u.exec(path)
  if (match === null) return undefined
  let id: string
  try { id = communityId(match[2]) } catch (_invalidId: unknown) { return undefined }
  const family = match[1], action = match[3]
  const selected = family === 'listings' && action === undefined && method === 'GET' ? 'listing'
    : family === 'orders' ? action === undefined && method === 'GET' ? 'order'
      : action === 'messages' ? method === 'GET' ? 'messages' : method === 'POST' ? 'message' : undefined
        : method === 'POST' && (action === 'read' || action === 'actions' || action === 'accept') ? action === 'actions' ? 'action' : action : undefined
      : family === 'uploads' ? action === undefined && method === 'GET' ? 'upload-status'
        : action === 'content' && method === 'PUT' ? 'upload-chunk' : action === 'complete' && method === 'POST' ? 'upload-complete' : undefined
        : family === 'attachments' ? action === 'link' && method === 'POST' ? 'link'
          : action === 'content' && (method === 'GET' || method === 'HEAD') ? 'content' : undefined : undefined
  return selected === undefined ? undefined : { kind: selected, suffix: path, method, resourceId: id,
    ...family === 'uploads' ? { uploadId: id } : {}, ...family === 'attachments' ? { attachmentId: id } : {} }
}
function mapCode(code: string): string {
  if (code === 'DEMAND_PERMISSION_DENIED') return 'COMMUNITY_FORBIDDEN'
  if (code === 'DEMAND_CONFLICT') return 'COMMUNITY_STATE_CONFLICT'
  if (code === 'DEMAND_UPLOAD_INVALID') return 'COMMUNITY_INVALID_INPUT'
  return code.startsWith('DEMAND_') ? 'COMMUNITY_' + code.slice('DEMAND_'.length) : code
}

/**
 * Build owner-bound community media URLs without exposing upstream signed tokens.
 * @param id - A validated community attachment UUID.
 * @param account - Existing account and opaque login owner guard.
 * @param disposition - Inline preview or original-filename download intent.
 * @returns The fixed local attachment content path with only non-secret account guards.
 */
export function communityContentPath(id: string, account: Pick<DemandAccount, 'id' | 'owner'>, disposition: string): string {
  return `${COMMUNITY_LOCAL_BASE_PATH}/attachments/${communityId(id)}/content?${new URLSearchParams({
    account_id: account.id, account_owner: account.owner, disposition,
  })}`
}

/**
 * Create a disposable community proxy without changing official-demand DTOs or journaling.
 * @param options - Existing credential owner, local Connection guard and transport ceilings.
 * @returns One-shot community handling and quiescent disposal; no config gate blocks participant recovery.
 */
export function createCommunityProxy(options: CommunityProxyOptions): ReturnType<typeof createDemandTransport> {
  return createDemandTransport({ ...options, upstreamBasePath: COMMUNITY_UPSTREAM_BASE_PATH,
    limits: () => ({ maxJsonRequestBytes: 131_072, maxJsonResponseBytes: 8_388_608, ...options.limits() }),
  }, {
    localBasePath: COMMUNITY_LOCAL_BASE_PATH, selectRoute, request: communityRequest, query: communityQuery,
    response: communityResponse, remoteCodes: COMMUNITY_ERRORS, mapCode, contentPath: communityContentPath, httpErrorFallback: true,
  })
}
