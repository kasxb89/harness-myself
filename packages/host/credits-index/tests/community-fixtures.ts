/** Synthetic values for offline community protocol and HTTP transport qualification. */
export const communityIds = { order: '11111111-1111-4111-8111-111111111111', other: '22222222-2222-4222-8222-222222222222',
  asset: '33333333-3333-4333-8333-333333333333', message: '44444444-4444-4444-8444-444444444444',
  key: '55555555-5555-4555-8555-555555555555' }

/**
 * Build one synthetic ready community asset.
 * @param overrides - Fields changed by a protocol edge case.
 * @returns A ready listing-scoped image without real account information.
 */
export function communityAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: communityIds.asset, name: '示例截图.png', kind: 'image', mime_type: 'image/png', size_bytes: 4,
    status: 'ready', sha256: 'a'.repeat(64), scope: 'listing', ...overrides }
}
/**
 * Build one explicit public listing owned by a synthetic user.
 * @param overrides - Fields changed by a protocol edge case.
 * @returns A schema-one public projection.
 */
export function communityListingFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema_version: 1, id: communityIds.order, number: 'SYNTHETIC-1', title: '整理资料', public_summary: '整理已公开的示例资料',
    public_budget: '预算协商', service_profile_id: '', service_profile_name: '', publisher: { id: 42, display_name: '示例发布用户' },
    status: 'open', public_attachments: [], created_at: 1, updated_at: 2, can_accept: false, ...overrides }
}
/**
 * Build a participant-only order independently of official-demand DTOs.
 * @param overrides - Fields changed by a protocol edge case.
 * @returns One accepted order seen by its publisher.
 */
export function communityOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema_version: 1, id: communityIds.order, number: 'SYNTHETIC-1', title: '整理资料', status: 'accepted', revision: 2,
    publisher: { id: 42, display_name: '示例发布用户' }, acceptor: { id: 43, display_name: '示例接单用户' }, my_role: 'publisher',
    listing: communityListingFixture({ status: 'accepted' }), private_text: '仅参与者可见的示例说明', last_seq: 1,
    last_read_seq: 0, unread_count: 1, delivery_message_id: '', created_at: 1, updated_at: 2, accepted_at: 2, closed_at: 0,
    can_send: true, can_deliver: false, can_accept_delivery: false, can_cancel: false, can_reopen: false, ...overrides }
}
/**
 * Build one peer message whose sender keeps their own ordinary-user identity.
 * @param overrides - Fields changed by a protocol edge case.
 * @returns An acceptor message in the synthetic private conversation.
 */
export function communityMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: communityIds.message, order_id: communityIds.order, seq: 1, sender_id: 43, author_kind: 'acceptor',
    author_name: '示例接单用户', kind: 'message', text: '资料已经收到', attachments: [], created_at: 2,
    client_message_id: communityIds.key, read: false, ...overrides }
}
/**
 * Build a recoverable upload receipt with no storage path.
 * @param overrides - Fields changed by a protocol edge case.
 * @returns The revision-one seven-field upload DTO.
 */
export function communityUpload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: communityIds.asset, attachment_id: communityIds.asset, offset: 4, chunk_bytes: 1024,
    status: 'uploading', expires_at: 100, attachment: null, ...overrides }
}
/**
 * Build the exact direct config data returned by GetCommunityConfig.
 * @param enabled - Whether new discovery and publication are enabled.
 * @returns Schema and transport capabilities, without private configuration fields.
 */
export function communityConfiguration(enabled = true): Record<string, unknown> {
  return { schema_version: 1, enabled, capabilities: { community_orders_v1: true, explicit_publication: true,
    single_acceptor: true, resumable_upload: true, private_participant_messages: true }, upload_rules: {
    max_image_bytes: 1024, max_video_bytes: 4096, max_attachments: 8, chunk_bytes: 1024,
    allowed_mime_types: ['image/png', 'video/mp4'], upload_ttl_seconds: 3600,
  } }
}
