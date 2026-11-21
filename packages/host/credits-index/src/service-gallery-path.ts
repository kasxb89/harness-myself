/** Local service media paths are derived only from verified gallery identities. */

/**
 * Bind an already-validated service asset to the current product login without exposing its signed URL.
 * @param profileId - Verified published service identity.
 * @param attachmentId - Verified gallery asset identity.
 * @param account - Captured account identity and non-secret local login scope.
 * @param disposition - Inline viewing or explicit attachment download.
 * @returns A local Host URL whose authorization is checked again on every read.
 */
export function serviceGalleryContentPath(profileId: string, attachmentId: string,
  account: { readonly id: string; readonly owner: string }, disposition = 'inline'): string {
  return `/credits/api/demand-service-media/${encodeURIComponent(profileId)}/${encodeURIComponent(attachmentId)}/content?${new URLSearchParams({
    account_id: account.id, account_owner: account.owner, disposition,
  })}`
}
