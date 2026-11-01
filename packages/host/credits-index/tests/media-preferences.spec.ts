import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { MediaPreferencesStore, mediaPreferencesScope, validateMediaPreference } from '../src/media-preferences.ts'
import type { MediaPreferenceSelection } from '../src/media-preferences-types.ts'
import type { ModelCapability } from '../src/media.ts'
import { preferenceModels } from './media-preferences.fixture.ts'



const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-media-preferences-'))
  roots.push(directory)
  const store = new MediaPreferencesStore(join(directory, 'preferences'))
  const scope = mediaPreferencesScope('https://example.test/harness/', '7')
  const owner = 'a'.repeat(64)
  const save = async (image: MediaPreferenceSelection | null, video: MediaPreferenceSelection | null,
    models: readonly ModelCapability[] = preferenceModels) => {
    const previous = await store.read(scope)
    return store.save(scope, owner, { schema_version: 1, expected_account_owner: owner,
      expected_revision: previous.revision, image, video }, models, async () => {})
  }
  return { directory, store, scope, owner, save }
}

describe('stable private media choices', () => {
  it('isolates backend prefixes and accounts while retaining choices across token renewal', async () => {
    const { directory, store, scope, save } = await fixture()
    const selected = await save({ model: 'image-a', parameters: { resolution: '2k', size: '16:9' } }, null)
    expect(selected.scope).toBe(scope)
    expect(mediaPreferencesScope('https://example.test/harness', '7')).toBe(scope)
    for (const other of [mediaPreferencesScope('https://example.test/other', '7'), mediaPreferencesScope('https://example.test/harness', '8')]) {
      expect((await store.read(other)).image).toBeNull()
    }
    const reopened = new MediaPreferencesStore(join(directory, 'preferences'))
    expect(await reopened.read(scope)).toEqual(selected)
    const file = join(directory, 'preferences', `${scope}.json`)
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await readFile(file, 'utf8')).not.toMatch(/token|password|prompt|reference/iu)
  })

  it('CAS prevents a stale window from replacing newer preferences and rechecks the login', async () => {
    const { store, scope, owner, save } = await fixture()
    const initial = await store.read(scope)
    const next = await save({ model: 'image-b', parameters: {} }, null)
    await expect(store.save(scope, owner, { schema_version: 1, expected_account_owner: owner,
      expected_revision: initial.revision, image: null, video: null }, preferenceModels, async () => {}))
      .rejects.toMatchObject({ code: 'MEDIA_PREFERENCES_CONFLICT' })
    await expect(store.save(scope, owner, { schema_version: 1, expected_account_owner: 'b'.repeat(64),
      expected_revision: next.revision, image: null, video: null }, preferenceModels, async () => {}))
      .rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' })
    await expect(store.save(scope, owner, { schema_version: 1, expected_account_owner: owner,
      expected_revision: next.revision, image: null, video: null }, preferenceModels, async () => { throw new Error('new login') }))
      .rejects.toThrow('new login')
    expect(await store.read(scope)).toEqual(next)
  })

  it('permits model-only and matching partial specifications, rejects Cartesian products and hidden values', async () => {
    const { save } = await fixture()
    await expect(save({ model: 'image-a', parameters: {} }, { model: 'video-b', parameters: { resolution: '1080P' } })).resolves.toBeDefined()
    for (const image of [{ model: 'image-a', parameters: { size: '1:1', resolution: '2k' } },
      { model: 'image-a', parameters: { prompt: 'never persist this' } },
      { model: 'image-a', parameters: { reference_images: '/private/user/image.png' } },
      { model: 'image-a', parameters: { count: 900 } }, { model: 'missing', parameters: {} }]) {
      await expect(save(image, null)).rejects.toHaveProperty('code')
    }
    expect(() =>{  validateMediaPreference('video', { model: 'video-b', parameters: { seconds: 5, resolution: '1080P' } }, preferenceModels) })
      .toThrow(expect.objectContaining({ code: 'MEDIA_PARAMETERS_INVALID' }))
    expect(() =>{  validateMediaPreference('image', { model: 'MiniMax-H3', parameters: {} }, preferenceModels) })
      .toThrow(expect.objectContaining({ code: 'MEDIA_MODEL_UNAVAILABLE' }))
  })

  it('keeps a removed preference visible but prevents saving it as an available model', async () => {
    const { store, scope, save } = await fixture()
    const saved = await save({ model: 'image-b', parameters: {} }, null)
    expect(await store.read(scope)).toEqual(saved)
    await expect(save({ model: 'image-b', parameters: { size: '1:1' } }, null, preferenceModels.filter(model => model.id !== 'image-b')))
      .rejects.toMatchObject({ code: 'MEDIA_MODEL_UNAVAILABLE' })
    expect((await save(null, null)).image).toBeNull()
  })

  it('lets each kind reset independently after both saved models are removed', async () => {
    const { store, scope, owner, save } = await fixture()
    const saved = await save({ model: 'image-b', parameters: {} }, { model: 'video-b', parameters: {} })
    const imageReset = await store.save(scope, owner, { schema_version: 1, expected_account_owner: owner,
      expected_revision: saved.revision, image: null, video: saved.video }, [], async () => {})
    expect(imageReset).toMatchObject({ image: null, video: saved.video })
    const cleared = await store.save(scope, owner, { schema_version: 1, expected_account_owner: owner,
      expected_revision: imageReset.revision, image: null, video: null }, [], async () => {})
    expect(cleared).toMatchObject({ image: null, video: null })
  })

  it('returns a contained local failure for malformed and oversized files', async () => {
    const { directory, store, scope, save } = await fixture()
    await save(null, null)
    const file = join(directory, 'preferences', `${scope}.json`)
    for (const value of ['{broken', 'x'.repeat(16_385), JSON.stringify({ schema_version: 1, scope: 'b'.repeat(64), image: null, video: null })]) {
      await writeFile(file, value)
      await expect(store.read(scope)).rejects.toMatchObject({ code: 'MEDIA_PREFERENCES_UNAVAILABLE' })
    }
  })
})
