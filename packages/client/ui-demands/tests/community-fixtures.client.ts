/** Synthetic community snapshots for component integration; never used by runtime. */
import type { CommunityConfig, CommunityListing, CommunityOrder, CommunityState } from '../src/client/community-types.ts'

/** Explicit synthetic capability response with bounded image/video upload rules. */
export function communityConfig(): CommunityConfig {
  return { schema_version: 1, enabled: true, capabilities: { community_orders_v1: true, explicit_publication: true,
    single_acceptor: true, resumable_upload: true, private_participant_messages: true },
  upload_rules: { max_image_bytes: 20_000_000, max_video_bytes: 512_000_000, max_attachments: 8,
    chunk_bytes: 1024 * 1024, allowed_mime_types: ['image/png', 'video/mp4'], upload_ttl_seconds: 3600 } }
}

/** Public data only; private conversation text is deliberately absent. */
export function communityListing(patch: Partial<CommunityListing> = {}): CommunityListing {
  return { schema_version: 1, id: '11111111-1111-4111-8111-111111111111', number: 'COMMUNITY-TEST-1',
    title: '公开网页需求', public_summary: '整理活动页', public_budget: '', service_profile_id: '', service_profile_name: '网页设计',
    publisher: { id: 2, display_name: '测试发布人' }, status: 'open', public_attachments: [],
    created_at: 1795000000, updated_at: 1795000000, can_accept: true, ...patch }
}

/** Authorized acceptor order with its own immutable public listing. */
export function communityOrder(patch: Partial<CommunityOrder> = {}): CommunityOrder {
  const listing = communityListing({ status: 'accepted', can_accept: false })
  return { schema_version: 1, id: listing.id, number: listing.number, title: listing.title, status: 'accepted', revision: 2,
    publisher: listing.publisher, acceptor: { id: 1, display_name: '测试接单人' }, my_role: 'acceptor', listing,
    private_text: '仅参与人可见', last_seq: 0, last_read_seq: 0, unread_count: 0, delivery_message_id: '',
    created_at: listing.created_at, updated_at: listing.updated_at, accepted_at: listing.updated_at, closed_at: 0,
    can_send: true, can_deliver: true, can_accept_delivery: false, can_cancel: false, can_reopen: false, ...patch }
}

/** Unavailable by default to cover released servers without community capability. */
export function communityState(patch: Partial<CommunityState> = {}): CommunityState {
  const page = <T>(items: readonly T[]) => ({ items, status: 'ready' as const, hasMore: false, loadingMore: false, error: null })
  return { availability: 'unavailable', accountId: '1', config: null, error: null,
    listingQuery: '', listingServiceProfileId: '', listings: page<CommunityListing>([]),
    orders: { published: page<CommunityOrder>([]), accepted: page<CommunityOrder>([]), all: page<CommunityOrder>([]) },
    selectedListing: null, selectedListingStatus: 'ready', selectedListingError: null, claimingListingIds: [], selectedOrderId: null,
    selectedOrderStatus: 'ready', selectedOrderError: null,
    conversation: null, activePublicationScope: null, publications: [], uploads: [], pending: [], ...patch }
}
