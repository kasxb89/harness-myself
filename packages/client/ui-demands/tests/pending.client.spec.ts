/** Durable bodies and reselected upload slices protect unknown mutations across reloads. */
import { describe, expect, it } from 'vitest'
import { createDemandJournal, matchesUpload, parsePending, sliceDigest, type DemandStorage, type PendingOperation } from '../src/client/pending.ts'

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
