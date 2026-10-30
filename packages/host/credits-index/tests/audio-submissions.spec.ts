import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { audioRequestFingerprint, type AudioQuote, type AudioRequest } from '../src/audio-generation.ts'
import { AudioSubmissions, type AudioOwner } from '../src/audio-submissions.ts'

const owner: AudioOwner = { accountId: 'account-a', sessionId: 'chat-a', backend: 'https://gateway.invalid/harness' }
const request: AudioRequest = { model: 'speech-fixture', input: '这是独立的音频请求', voice: 'voice-a', response_format: 'wav' }
function quote(value: AudioRequest = request): AudioQuote {
  const now = Math.floor(Date.now() / 1000)
  return { object: 'audio.quote', schema_version: 1, quote_id: 'quote-a', account_binding: 'binding-a', model: value.model,
    request_fingerprint: audioRequestFingerprint(value), total_quota: 100, estimated_total: '0.10', currency: 'CNY',
    pricing_revision: 'revision-a', created_at: now, expires_at: now + 60,
    estimate_only: true, charged: false, submitted: false, reserved: false }
}
function scope(directory: string, account = owner): string {
  return join(directory, createHash('sha256').update(JSON.stringify([account.backend, account.accountId])).digest('hex'))
}
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-audio-submissions-'))
  directories.push(directory)
  return { directory, store: new AudioSubmissions(directory), id: randomUUID() }
}

describe('private original speech attempts', () => {
  it('persists an unknown attempt before dispatch and preserves it across restarts and new estimates', async () => {
    const { directory, store, id } = await fixture()
    const claimed = await store.claim(owner, id, request, quote())
    expect(claimed.created).toBe(true)
    expect(claimed.record).toMatchObject({ status: 'unknown', fingerprint: audioRequestFingerprint(request), quoteId: 'quote-a' })
    const restarted = new AudioSubmissions(directory)
    expect(await restarted.read(owner, id)).toEqual(claimed.record)
    expect(await restarted.claim(owner, id, request, { ...quote(), quote_id: 'quote-new' })).toEqual({ created: false, record: claimed.record })
    expect(await readdir(scope(directory))).toEqual([`${id}.json`])
    if (process.platform !== 'win32') {
      expect((await stat(scope(directory))).mode & 0o777).toBe(0o700)
      expect((await stat(join(scope(directory), `${id}.json`))).mode & 0o777).toBe(0o600)
    }
  })

  it('claims one dispatch under concurrent retries and returns the same original record', async () => {
    const { store, id } = await fixture()
    const large = { ...request, input: '独立请求'.repeat(40_000) }
    const results = await Promise.all(Array.from({ length: 8 }, () => store.claim(owner, id, large, quote(large))))
    expect(results.filter(value => value.created)).toHaveLength(1)
    expect(results.every(value => value.record.fingerprint === audioRequestFingerprint(large) && value.record.status === 'unknown')).toBe(true)
  })

  it('never replaces the parameters of an existing submission identity', async () => {
    const { store, id } = await fixture()
    const original = await store.claim(owner, id, request, quote())
    const changed = { ...request, voice: 'voice-b' }
    await expect(store.claim(owner, id, changed, quote(changed))).rejects.toThrow('another request')
    expect(await store.read(owner, id)).toEqual(original.record)
  })

  it('separates accounts, backends and chats while preserving independent requests in one chat', async () => {
    const { store, id } = await fixture()
    await store.claim(owner, id, request, quote())
    for (const other of [{ ...owner, accountId: 'account-b' }, { ...owner, backend: 'https://other.invalid/harness' }, { ...owner, sessionId: 'chat-b' }]) {
      expect(await store.read(other, id)).toBeUndefined()
      expect(await store.list(other)).toEqual([])
    }
    const anotherChat = { ...owner, sessionId: 'chat-b' }
    await expect(store.claim(anotherChat, id, request, quote())).rejects.toThrow('another request')
    const second = await store.claim(owner, randomUUID(), request, quote())
    expect(second.created).toBe(true)
    expect(await store.list(owner)).toHaveLength(2)
    const otherAccount = { ...owner, accountId: 'account-b' }
    expect((await store.claim(otherAccount, id, request, quote())).created).toBe(true)
    expect(await store.list(otherAccount)).toHaveLength(1)
  })

  it('rejects path-like identities before accessing any file', async () => {
    const { store } = await fixture()
    await expect(store.read(owner, '../outside')).rejects.toThrow('Invalid audio submission identity')
    await expect(store.claim(owner, '../../outside', request, quote())).rejects.toThrow('Invalid audio submission identity')
  })

  it('does not recover a stored request whose fingerprint no longer matches its parameters', async () => {
    const { directory, store, id } = await fixture()
    const { record } = await store.claim(owner, id, request, quote())
    await writeFile(join(scope(directory), `${id}.json`), JSON.stringify({ ...record, request: { ...request, input: '不同内容' } }))
    expect(await store.read(owner, id)).toBeUndefined()
  })

  it('retains only original safe state after an accepted upstream task is recovered', async () => {
    const { directory, store, id } = await fixture()
    const { record } = await store.claim(owner, id, request, quote())
    await store.update({ ...record, status: 'pending', taskId: 'audio-task-a', requestId: 'request-a' })
    const replay = await new AudioSubmissions(directory).claim(owner, id, request, quote())
    expect(replay.created).toBe(false)
    expect(replay.record).toMatchObject({ status: 'pending', taskId: 'audio-task-a', requestId: 'request-a' })
  })
})

describe('original audio result files', () => {
  const bytes = Buffer.from('RIFF0000WAVEoriginal-audio')

  it('saves by fixed identity regardless of display filename and reuses only the same bytes', async () => {
    const { directory, store, id } = await fixture()
    const { record } = await store.claim(owner, id, request, quote())
    expect(await store.content(record)).toBeUndefined()
    const completed = await store.save(record, bytes, '../../outside.wav')
    expect((await readdir(scope(directory))).sort()).toEqual([`${id}.json`, `${id}.wav`].sort())
    expect(await readdir(directory)).toHaveLength(1)
    expect(await readFile(join(scope(directory), `${id}.wav`))).toEqual(bytes)
    expect(await store.content(completed)).toEqual(bytes)
    const repeated = await store.save(completed, bytes, 'readable-name.wav')
    expect(repeated.resultHash).toBe(completed.resultHash)
    await expect(store.save(completed, Buffer.from('RIFF0000WAVEchanged-audio'), 'changed.wav')).rejects.toThrow('Original audio result changed')
    expect(await store.read(owner, id)).toEqual(repeated)
    expect(await store.content(repeated)).toEqual(bytes)
  })

  it('does not serve bytes after the original output has changed on disk', async () => {
    const { directory, store, id } = await fixture()
    const { record } = await store.claim(owner, id, request, quote())
    const completed = await store.save(record, bytes, 'readable.wav')
    await writeFile(join(scope(directory), `${id}.wav`), 'not-the-original')
    expect(await store.content(completed)).toBeUndefined()
  })

  it('keeps the exact original response format in its fixed local path', async () => {
    const { directory, store, id } = await fixture()
    const mp3 = { ...request, response_format: 'mp3' as const }
    const { record } = await store.claim(owner, id, mp3, quote(mp3))
    await store.save(record, Buffer.from('ID3original'), 'display.wav')
    expect(await readdir(scope(directory))).toEqual(expect.arrayContaining([`${id}.mp3`, `${id}.json`]))
    expect(await readdir(scope(directory))).not.toContain(`${id}.wav`)
  })
})
