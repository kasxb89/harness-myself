/** Durable bodies and reselected upload slices protect unknown mutations across reloads. */
import { describe, expect, it } from 'vitest'
import { createDemandJournal, matchesUpload, parsePending, sliceDigest, type DemandStorage, type PendingOperation } from '../src/client/pending.ts'
import { object } from '../src/client/wire.ts'

const owner = { id: '1', owner: 'a'.repeat(64) }
const operationId = '00000000-0000-4000-8000-000000000001'
function storage(): DemandStorage {
  const values = new Map<string, string>()
  return { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) }, removeItem: (key) => { values.delete(key) } }
}
function operation(): PendingOperation {
  return { version: 1, operationId, scopeKey: 'example-draft', kind: 'create', path: '', createdAt: 100,
    body: JSON.stringify({ client_request_id: operationId, engineer_id: 'example-engineer', text: 'Example request',
      attachment_ids: [], title: '', budget: '', expected_date: '' }) }
}

describe('demand pending journal', () => {
  it('recovers the identical body and UUID after reload and isolates every account owner', () => {
    const backing = storage(), first = createDemandJournal(backing)
    first.put(owner, operation())
    const reloaded = createDemandJournal(backing)
    expect(reloaded.read(owner)).toEqual([operation()])
    expect(reloaded.read({ id: owner.id, owner: 'b'.repeat(64) })).toEqual([])
    expect(reloaded.read({ id: '2', owner: owner.owner })).toEqual([])
    reloaded.remove(owner, operationId)
    expect(first.read(owner)).toEqual([])
  })

  it('refuses to replace a frozen operation body or silently discard corrupt stored data', () => {
    const backing = storage(), journal = createDemandJournal(backing)
    journal.put(owner, operation())
    expect(() =>{  journal.put(owner, { ...operation(), body: operation().body.replace('Example request', 'Changed request') }) }).toThrow()
    expect(journal.read(owner)[0]?.body).toBe(operation().body)
    backing.setItem(`yunshu.demands.pending.v1:${JSON.stringify([owner.id, owner.owner])}`, '{invalid')
    expect(() => journal.read(owner)).toThrow()
    expect(() => parsePending({ ...operation(), operationId: 'not-a-uuid' })).toThrow()
  })

  it('verifies metadata and every attempted slice without invoking the whole-file reader', async () => {
    const file = new File(['abcdefgh'], 'example.png', { type: 'image/png', lastModified: 100 })
    const hash = await sliceDigest(file, 0, 4)
    const upload = { engineerId: 'example-engineer', requestId: null, file: { name: file.name, size: file.size, type: file.type,
      lastModified: file.lastModified }, parts: [{ offset: 0, size: 4, sha256: hash }], uploadId: 'example-upload', ready: false }
    file.arrayBuffer = () => { throw new Error('Whole-file reads are forbidden') }
    expect(await matchesUpload(file, upload)).toBe(true)
    expect(await matchesUpload(new File(['xbcdxxxx'], file.name, { type: file.type, lastModified: 100 }), upload)).toBe(false)
    expect(await matchesUpload(new File(['abcdefgh'], file.name, { type: file.type, lastModified: 101 }), upload)).toBe(false)
    const abort = new AbortController(); abort.abort()
    expect(await matchesUpload(file, upload, abort.signal)).toBe(false)
  })
})

describe('service journal namespace compatibility', () => {
  it('keeps the old reader v1 bytes intact while service operations are added, reloaded and removed from v2', () => {
    const backing = storage(), journal = createDemandJournal(backing), old = operation()
    journal.put(owner, old)
    const v1 = `yunshu.demands.pending.v1:${JSON.stringify([owner.id, owner.owner])}`
    const v2 = `yunshu.demands.pending.v2:${JSON.stringify([owner.id, owner.owner])}`
    const originalBytes = backing.getItem(v1)
    const newId = '00000000-0000-4000-8000-000000000002'
    const service: PendingOperation = { ...old, version: 2, operationId: newId, scopeKey: 'service-draft',
      serviceProfileId: 'service-web', serviceProfileName: 'Original service',
      body: JSON.stringify({ client_request_id: newId, service_profile_id: 'service-web', text: 'Service request',
        attachment_ids: [], title: '', budget: '', expected_date: '' }) }
    journal.put(owner, service)
    expect(backing.getItem(v1)).toBe(originalBytes)
    const legacyStored: unknown = JSON.parse(backing.getItem(v1) ?? '{}')
    const serviceStored: unknown = JSON.parse(backing.getItem(v2) ?? '{}')
    expect(object(legacyStored).operations).toEqual([old])
    expect(object(serviceStored).operations).toEqual([service])
    expect(createDemandJournal(backing).read(owner)).toEqual([old, service])
    expect(() => { journal.put(owner, { ...service, version: 1 }) }).toThrow()
    journal.remove(owner, newId)
    expect(backing.getItem(v1)).toBe(originalBytes)
    expect(backing.getItem(v2)).toBeNull()
    expect(journal.read(owner)).toEqual([old])
  })

  it('restores a service upload target and rejects changing its frozen routing identity', () => {
    const old = operation(), newId = '00000000-0000-4000-8000-000000000003'
    const upload: PendingOperation = { version: 2, operationId: newId, scopeKey: old.scopeKey, kind: 'upload', path: '/uploads',
      serviceProfileId: 'service-web', serviceProfileName: 'Original service', createdAt: 100,
      body: JSON.stringify({ client_upload_id: newId, name: 'example.png', mime_type: 'image/png', size_bytes: 4 }),
      upload: { engineerId: '', serviceProfileId: 'service-web', requestId: null, file: { name: 'example.png', size: 4,
        type: 'image/png', lastModified: 100 }, parts: [], uploadId: null, ready: false } }
    const journal = createDemandJournal(storage()); journal.put(owner, upload)
    expect(journal.read(owner)).toEqual([upload])
    expect(() => { journal.put(owner, { ...upload, serviceProfileId: 'another-service' }) }).toThrow()
    expect(() => parsePending({ ...upload, version: 1 })).toThrow()
  })
})
