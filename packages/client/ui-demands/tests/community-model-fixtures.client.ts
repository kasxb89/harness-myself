/** Model-only synthetic DTOs, separate from the pure view fixture adapter. */
import type { CommunityAttachment, CommunityConfig, CommunityListing, CommunityMessage, CommunityOrder } from '../src/client/community-types.ts'
import type { CommunityStorage } from '../src/client/community-pending.ts'

/**
 * Example verified ready image.
 * @param patch - Explicit field changes.
 * @returns Attachment DTO.
 */
export function exampleCommunityAttachment(patch: Partial<CommunityAttachment> = {}): CommunityAttachment {
  return { id: 'community-image', name: 'example.png', kind: 'image', mime_type: 'image/png', size_bytes: 4,
    status: 'ready', sha256: 'a'.repeat(64), scope: 'conversation', ...patch }
}
/**
 * Example public listing without private fields.
 * @param patch - Field changes.
 * @returns Listing DTO.
 */
export function exampleCommunityListing(patch: Partial<CommunityListing> = {}): CommunityListing {
  return { schema_version: 1, id: 'community-order', number: 'COMMUNITY-EXAMPLE', title: 'Example public need',
    public_summary: 'Public work description', public_budget: 'Negotiable', service_profile_id: '', service_profile_name: '',
    expected_delivery_date: '', approval_status: 'approved',
    publisher: { id: 1, display_name: 'Example publisher' }, status: 'open', public_attachments: [], created_at: 100,
    updated_at: 100, can_accept: false, ...patch }
}
/**
 * Example participant order.
 * @param patch - Field changes.
 * @returns Order DTO.
 */
export function exampleCommunityOrder(patch: Partial<CommunityOrder> = {}): CommunityOrder {
  return { schema_version: 1, id: 'community-order', number: 'COMMUNITY-EXAMPLE', title: 'Example public need', status: 'accepted',
    revision: 2, publisher: { id: 1, display_name: 'Example publisher' }, acceptor: { id: 2, display_name: 'Example acceptor' },
    my_role: 'publisher', listing: exampleCommunityListing({ status: 'accepted' }), private_text: 'Private original context',
    last_seq: 1, last_read_seq: 0, unread_count: 1, delivery_message_id: '', created_at: 100, updated_at: 101,
    accepted_at: 101, closed_at: 0, can_send: true, can_deliver: false, can_accept_delivery: false,
    can_cancel: false, can_reopen: false, ...patch }
}
/**
 * Example actual sender message.
 * @param patch - Field changes.
 * @returns Message DTO.
 */
export function exampleCommunityMessage(patch: Partial<CommunityMessage> = {}): CommunityMessage {
  return { id: 'community-message', order_id: 'community-order', seq: 1, sender_id: 2, author_kind: 'acceptor',
    author_name: 'Actual historical acceptor', kind: 'message', text: 'Example response', attachments: [], created_at: 101,
    client_message_id: '00000000-0000-4000-8000-000000000001', read: false, ...patch }
}
/**
 * Synthetic dynamic config DTO.
 * @param enabled - New-entry switch.
 * @returns Config DTO.
 */
export function exampleCommunityConfig(enabled = true): CommunityConfig {
  return { schema_version: 1, enabled, capabilities: { community_orders_v1: true, explicit_publication: true,
    single_acceptor: true, resumable_upload: true, private_participant_messages: true, community_approval_v1: true },
  publication_policy: 'approval_required', upload_rules: {
    max_image_bytes: 20_971_520, max_video_bytes: 536_870_912, max_attachments: 8, chunk_bytes: 4,
    allowed_mime_types: ['image/png', 'video/mp4'], upload_ttl_seconds: 86400 } }
}
/** Isolated storage with an inspectable backing map. @returns Test-local persistence. */
export function communityMemory(): CommunityStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) }, removeItem: (key) => { data.delete(key) } }
}
