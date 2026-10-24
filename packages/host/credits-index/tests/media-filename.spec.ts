import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_MEDIA_FILENAME_BYTES, mediaFilename } from '../src/media-filename.ts'

const uuid = /[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/u

describe('generated media filenames', () => {
  it('keeps named workflow materials and their output purpose readable', () => {
    const values = (['image', 'reference-image', 'shot-image', 'video', 'shot', 'final', 'edited-video'] as const)
      .map(role => mediaFilename({ title: '四季流转', prompt: 'Unused full prompt', role, extension: '.mp4', index: 2 }).replace(uuid, '<uuid>'))
    expect(values).toMatchInlineSnapshot(`
      [
        "四季流转-成图-02-<uuid>.mp4",
        "四季流转-参考图-02-<uuid>.mp4",
        "四季流转-分镜图-02-<uuid>.mp4",
        "四季流转-视频-02-<uuid>.mp4",
        "四季流转-分镜-02-<uuid>.mp4",
        "四季流转-成片-02-<uuid>.mp4",
        "四季流转-剪辑视频-02-<uuid>.mp4",
      ]
    `)
  })

  it('uses a short first-clause summary and a purpose fallback without copying the full brief', () => {
    const brief = '晨光中的雪山，镜头逐渐拉远，然后显示小狐狸。' + 'Private detailed prompt '.repeat(100)
    const named = mediaFilename({ prompt: brief, role: 'video', extension: 'mp4' })
    expect(named.replace(uuid, '<uuid>')).toBe('晨光中的雪山-视频-<uuid>.mp4')
    expect(named).not.toContain('Private')
    expect(mediaFilename({ title: ' / : * ', prompt: '\n', role: 'reference-image', extension: 'png' }).replace(uuid, '<uuid>'))
      .toBe('参考图-参考图-<uuid>.png')
    const long = mediaFilename({ prompt: '山'.repeat(1000), role: 'image', extension: 'png' })
    expect(long.split('-成图-')[0]).toBe('山'.repeat(20))
  })

  it.each(['../../站台:春?*\u0000.png. ', 'C:\\Users\\guest\\图片<>|. ', 'CON', 'aux.png', 'LPT9',
    'COM¹.png', 'COM².png', 'COM³.png', 'LPT¹.png', 'LPT².png', 'LPT³.png', 'CON .png', '\u202e倒序\u2066文本'])
  ('stays one safe Windows and POSIX filename for %j', (title) => {
    const name = mediaFilename({ title, role: 'image', extension: 'png' })
    expect(name).toBe(basename(name))
    expect(name).toBe(win32.basename(name))
    expect(name).not.toMatch(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u)
    expect(name).not.toMatch(/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:[. ]|$)/iu)
    expect(name).not.toMatch(/[. ]$/u)
    expect(name).toMatch(uuid)
  })

  it('repairs malformed Unicode before saving and encoding the same filename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'media-unicode-name-'))
    try {
      const name = mediaFilename({ title: JSON.parse('"雪山\\ud800参考\\udfff图"') as string, role: 'image', extension: 'png' })
      const encoded = encodeURIComponent(name)
      expect(decodeURIComponent(encoded)).toBe(name)
      expect(Buffer.from(name).toString('utf8')).toBe(name)
      await writeFile(join(root, name), 'actual media', { flag: 'wx', mode: 0o600 })
      expect(await readdir(root)).toEqual([name])
      expect(await readFile(join(root, decodeURIComponent(encoded)), 'utf8')).toBe('actual media')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('bounds the complete UTF-8 name without truncating Unicode code points or its UUID', () => {
    const name = mediaFilename({ title: '雪山🦊'.repeat(500), role: 'edited-video', extension: 'mp4', index: 123 })
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(MAX_MEDIA_FILENAME_BYTES)
    expect(Buffer.byteLength(name)).toBeGreaterThan(MAX_MEDIA_FILENAME_BYTES - 5)
    expect(name).not.toContain('\ufffd')
    expect(Buffer.from(name).toString('utf8')).toBe(name)
    expect(name).toMatch(/-剪辑视频-123-[a-f0-9-]{36}\.mp4$/u)
  })

  it('saves concurrent outputs with the same title exclusively and keeps every original file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'media-readable-names-'))
    try {
      const names = await Promise.all(Array.from({ length: 24 }, async (_, index) => {
        const name = mediaFilename({ title: '重复标题', role: 'image', extension: 'png' })
        await writeFile(join(root, name), String(index), { flag: 'wx', mode: 0o600 })
        return name
      }))
      expect(new Set(names).size).toBe(24)
      expect(await readdir(root)).toHaveLength(24)
      await Promise.all(names.map(async (name, index) => { expect(await readFile(join(root, name), 'utf8')).toBe(String(index)) }))
      await expect(writeFile(join(root, names[0]!), 'overwritten', { flag: 'wx' })).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await readFile(join(root, names[0]!), 'utf8')).toBe('0')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
