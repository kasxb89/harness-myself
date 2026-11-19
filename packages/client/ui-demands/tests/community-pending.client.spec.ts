/** Durable community keys and incremental hashing, without production storage or upstream calls. */
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createCommunityJournal, communityFileDigest, communitySliceDigest, matchesCommunityUpload,
  parseCommunityOperation, type CommunityOperation, type CommunityPendingUpload } from '../src/client/community-pending.ts'
import { communityMemory } from './community-model-fixtures.client.ts'
const owner = { id: '1', owner: 'a'.repeat(64) }, uuid = '00000000-0000-4000-8000-000000000001'
function publication(): CommunityOperation {
  return { version: 1, operationId: uuid, scopeKey: 'publication:example', orderId: null, kind: 'publication', path: '/orders', createdAt: 100,
    body: JSON.stringify({ client_request_id: uuid, publish_to_community: true, title: 'Example', public_summary: 'Public only',
      public_budget: '', private_text: '', public_attachment_ids: [], private_attachment_ids: [] }) }
}
function upload(file: File): CommunityPendingUpload {
  return { target: { kind: 'publication', scopeKey: 'publication:example' }, scope: 'listing',
    file: { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified },
    parts: [], uploadId: null, attachmentId: null, sha256: null, attachment: null, completeBody: null, ready: false }
}
describe('community pending journal', () => {
  it('persists an exact original body in a separate owner-bound namespace', () => {
    const store = communityMemory(), journal = createCommunityJournal(store), original = publication()
    journal.put(owner, original)
    expect([...store.data.keys()][0]).toContain('yunshu.community-demands.pending.v1:')
    expect(journal.read(owner)).toEqual([original])
    expect(journal.read({ ...owner, owner: 'b'.repeat(64) })).toEqual([])
    expect(() =>{  journal.put(owner, { ...original, body: original.body.replace('Example', 'Changed') }) }).toThrow('COMMUNITY_PENDING_BODY_CHANGED')
    journal.remove(owner, uuid); expect(journal.read(owner)).toEqual([])
  })
  it('refuses silent publication, old demand routing and corrupt storage', () => {
    const original = publication(), store = communityMemory(), journal = createCommunityJournal(store)
    expect(() => parseCommunityOperation({ ...original, body: original.body.replace('true', 'false') })).toThrow()
    expect(() => parseCommunityOperation({ ...original, path: '' })).toThrow()
    journal.put(owner, original)
    const key = [...store.data.keys()][0]
    if (key === undefined) throw new Error('Expected test journal key')
    store.data.set(key, '{corrupt')
    expect(() => journal.read(owner)).toThrow()
  })
  it('retains old and dated publication bytes without backfilling dates or normalizing the original body', () => {
    const original = publication(), journal = createCommunityJournal(communityMemory())
    const dated = { ...original, body: original.body.replace('"public_budget":""',
      '"public_budget":"", "expected_delivery_date":"2026-12-08"') }
    expect(parseCommunityOperation(original).body).toBe(original.body)
    expect(parseCommunityOperation(dated).body).toBe(dated.body)
    journal.put(owner, dated)
    expect(journal.read(owner)[0]?.body).toBe(dated.body)
    expect(() => parseCommunityOperation({ ...dated, body: dated.body.replace('2026-12-08', '2026-02-29') })).toThrow()
  })
  it('keeps upload scope, target, original metadata and slice identities immutable', async () => {
    const file = new File(['example'], 'example.png', { type: 'image/png', lastModified: 7 })
    const data = upload(file), original: CommunityOperation = { version: 1, operationId: uuid, scopeKey: 'publication:example', orderId: null,
      kind: 'upload', path: '/uploads', createdAt: 100, upload: data, body: JSON.stringify({ client_upload_id: uuid, scope: 'listing',
        name: file.name, mime_type: file.type, size_bytes: file.size }) }
    const journal = createCommunityJournal(communityMemory()); journal.put(owner, original)
    const part = { offset: 0, size: 4, sha256: await communitySliceDigest(file, 0, 4) }
    const advanced = { ...original, upload: { ...data, parts: [part], uploadId: 'same-upload', attachmentId: 'same-asset' } }
    journal.put(owner, advanced)
    expect(() =>{  journal.put(owner, { ...advanced, upload: { ...advanced.upload, scope: 'conversation' } }) }).toThrow()
    expect(() =>{  journal.put(owner, { ...advanced, upload: { ...advanced.upload, parts: [{ ...part, sha256: 'b'.repeat(64) }] } }) }).toThrow()
    expect(() =>{  journal.put(owner, { ...advanced, upload: { ...advanced.upload, uploadId: 'new-upload' } }) }).toThrow()
  })
  it('matches independent Node SHA256 with bounded slices and refuses replacement content', async () => {
    const bytes = new Uint8Array(4_194_304 + 73).fill(31)
    const file = new File([bytes], 'example.mp4', { type: 'video/mp4', lastModified: 7 })
    const direct = vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('Whole file reads forbidden'))
    const slice = vi.spyOn(file, 'slice'), digest = await communityFileDigest(file)
    expect(digest).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(slice).toHaveBeenCalledTimes(2); expect(direct).not.toHaveBeenCalled()
    const saved = { ...upload(file), sha256: digest }
    expect(await matchesCommunityUpload(file, saved)).toBe(true)
    const changed = new File([new Uint8Array(bytes.length).fill(32)], file.name, { type: file.type, lastModified: file.lastModified })
    expect(await matchesCommunityUpload(changed, saved)).toBe(false)
    const abort = new AbortController(); abort.abort()
    await expect(communityFileDigest(file, abort.signal)).rejects.toThrow('COMMUNITY_CANCELLED')
  })
  it('does not dispatch through a failed pre-send storage write', () => {
    const store = communityMemory(); store.setItem = () => { throw new Error('disk full') }
    expect(() =>{  createCommunityJournal(store).put(owner, publication()) }).toThrow('disk full')
  })
})
