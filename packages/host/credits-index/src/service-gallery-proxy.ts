/** Service galleries share the account-owned media transport while keeping their signing namespace separate. */
import { createDemandTransport, type DemandProxyOptions, type DemandTransportRoute } from './demand-proxy.ts'
import { demandQuery, demandRequest, DemandProtocolError } from './demand-protocol.ts'
import { serviceGalleryContentPath } from './service-gallery-path.ts'

const localBase = '/credits/api/demand-service-media'
const upstreamBase = '/api/product/demands/service-profiles'
const remoteCodes = new Set(['DEMAND_AUTH_REQUIRED', 'DEMAND_PERMISSION_DENIED', 'DEMAND_NOT_FOUND',
  'DEMAND_ATTACHMENT_NOT_FOUND', 'DEMAND_PROFILE_UNAVAILABLE', 'DEMAND_DISABLED', 'DEMAND_STORAGE_UNAVAILABLE'])

function selectRoute(path: string, method: string): DemandTransportRoute | undefined {
  const match = /^\/([A-Za-z0-9_-]{1,40})\/([A-Za-z0-9_-]{1,128})\/content$/u.exec(path)
  if (match === null || !['GET', 'HEAD'].includes(method)) return undefined
  return { kind: 'content', suffix: path, method, resourceId: match[1] ?? '', attachmentId: match[2] ?? '' }
}

/**
 * Relay only exact service-gallery content reads through normal account capture and profile-bound signing.
 * @param options - Existing product login ownership and bounded transport configuration.
 * @returns A disposable read-only handler; it cannot upload, create or edit any record.
 */
export function createServiceGalleryProxy(options: DemandProxyOptions): ReturnType<typeof createDemandTransport> {
  return createDemandTransport({ ...options, upstreamBasePath: upstreamBase }, {
    localBasePath: localBase, selectRoute, request: demandRequest, query: demandQuery,
    response: () => { throw new DemandProtocolError() }, remoteCodes, mapCode: code => code,
    contentPath: (id, account, disposition, route) => serviceGalleryContentPath(route.resourceId ?? '', id, account, disposition),
    contentLinkPath: route => `${upstreamBase}/${route.resourceId}/media/${route.attachmentId}/link`,
    contentAssetPath: route => `/api/product/demand-service-media/${route.resourceId}/${route.attachmentId}/content`,
  })
}
