import { describe, expect, it } from 'vitest'
import { collectVideoWorkIdentities } from './video-work-identities.ts'

const firstHash = 'a'.repeat(64), secondHash = 'b'.repeat(64)
const request = `vr_${firstHash}`, firstWork = `vw_${firstHash}_1`, secondWork = `vw_${firstHash}_2`

describe('declared video work identity normalization', () => {
  it('preserves repeated request/work relationships and existing creation token order', () => {
    const identities = new Map([['cp_12345678-1234-1234-1234-123456789abc', '{{id:1001}}'],
      ['op_12345678-1234-1234-1234-123456789abc', '{{id:1002}}']])
    const video = collectVideoWorkIdentities([
      { work_request_id: request, work_id: firstWork, pending_work_ids: [secondWork] },
      { work_request_id: request, work_id: firstWork, works: [{ work_id: firstWork }, { work_id: secondWork }] },
      { work_request_id: `vr_${secondHash}`, work_id: `vw_${secondHash}_1` },
    ])
    for (const [id, token] of video) identities.set(id, token)
    expect([...identities.values()]).toEqual(['{{id:1001}}', '{{id:1002}}',
      '{{videoRequest:1}}', '{{videoRequest:2}}', '{{videoWork:1}}', '{{videoWork:2}}', '{{videoWork:3}}'])
    let raw = JSON.stringify({ result: { work_request_id: request, work_id: firstWork },
      continuation: { work_id: firstWork, pending_work_ids: [secondWork] }, model_config_version: firstHash })
    for (const [id, token] of identities) raw = raw.split(id).join(token)
    expect(JSON.parse(raw)).toEqual({ result: { work_request_id: '{{videoRequest:1}}', work_id: '{{videoWork:1}}' },
      continuation: { work_id: '{{videoWork:1}}', pending_work_ids: ['{{videoWork:2}}'] }, model_config_version: firstHash })
  })

  it.each([
    { work_id: `vw_${secondHash}_1` },
    { pending_work_ids: [`vw_${secondHash}_1`] },
    { works: [{ work_id: `vw_${secondHash}_1` }] },
  ])('rejects a work from another request hash: %j', (fields) => {
    expect(() => collectVideoWorkIdentities([{ work_request_id: request, ...fields }])).toThrow('Invalid work_id binding')
  })

  it.each([
    { work_id: firstWork },
    { work_request_id: `vr_${firstHash.slice(1)}`, work_id: firstWork },
    { work_request_id: request, work_id: `vw_${firstHash}_0` },
    { work_request_id: request, pending_work_ids: firstWork },
    { work_request_id: request, works: [{}] },
  ])('rejects malformed or incomplete declared identities: %j', (result) => {
    expect(() => collectVideoWorkIdentities([result])).toThrow(/Invalid /u)
  })

  it('leaves unrelated hashes, model versions and identity-shaped prose untouched', () => {
    const value = { model_config_version: firstHash, prompt: `Keep ${request} and ${firstWork} verbatim`,
      message: `An unrelated value ${secondHash}`, metadata: { work_request_id: request, work_id: firstWork } }
    const raw = JSON.stringify(value)
    const identities = collectVideoWorkIdentities([value, { status: 'cancelled', code: 'USER_CANCELLED' }])
    expect([...identities]).toEqual([])
    let normalized = raw
    for (const [id, token] of identities) normalized = normalized.split(id).join(token)
    expect(normalized).toBe(raw)
  })
})
