import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import sources from '../third-party-notices/sources.json' with { type: 'json' }
import { COMMUNITY_VIDEO_DIRECTION, COMMUNITY_VIDEO_DIRECTION_SOURCES } from '../src/creation-director-knowledge.ts'

it('keeps community directing guidance compact and limited to the requested production work', () => {
  expect(Buffer.byteLength(COMMUNITY_VIDEO_DIRECTION, 'utf8')).toBeLessThanOrEqual(4500)
  expect(COMMUNITY_VIDEO_DIRECTION).toContain('Story function first.')
  expect(COMMUNITY_VIDEO_DIRECTION).toContain('Blocking before framing.')
  expect(COMMUNITY_VIDEO_DIRECTION).toContain('one dominant camera move and one primary action')
  expect(COMMUNITY_VIDEO_DIRECTION).toContain('Every action has an end state.')
  expect(COMMUNITY_VIDEO_DIRECTION).toContain('identity, wardrobe, light direction, era, geography')
  expect(COMMUNITY_VIDEO_DIRECTION).toContain('explicit time windows')
  expect(COMMUNITY_VIDEO_DIRECTION).toContain('不要虚构已上传资源')
  expect(COMMUNITY_VIDEO_DIRECTION).toContain('台词能在镜头时长内自然说完')
  expect(COMMUNITY_VIDEO_DIRECTION).toContain('字幕沿用逐字台词与说话时间，保留原生人声')
  expect(COMMUNITY_VIDEO_DIRECTION).toContain('do not add alternate drafts or extra paid shots')
  expect(COMMUNITY_VIDEO_DIRECTION).toContain('reuse suitable material')
  expect(COMMUNITY_VIDEO_DIRECTION).not.toMatch(/\b(?:python|ffmpeg|curl|pip|npm|4K|8K)\b/iu)
  expect(COMMUNITY_VIDEO_DIRECTION).not.toContain('http')
})

it('pins the adapted prompt and both community sources alongside their complete MIT notices', () => {
  expect(sources.sources).toEqual(COMMUNITY_VIDEO_DIRECTION_SOURCES)
  expect(createHash('sha256').update(COMMUNITY_VIDEO_DIRECTION).digest('hex')).toBe(sources.adaptedPromptSha256)
  for (const source of COMMUNITY_VIDEO_DIRECTION_SOURCES) {
    expect(source.revision).toMatch(/^[a-f0-9]{40}$/u)
    expect(source.sourceSha256).toMatch(/^[a-f0-9]{64}$/u)
    const license = readFileSync(new URL(`../third-party-notices/${source.licenseFile}`, import.meta.url))
    expect(createHash('sha256').update(license).digest('hex')).toBe(source.licenseSha256)
    expect(license.toString('utf8')).toContain(source.copyright)
    expect(license.toString('utf8')).toContain('The above copyright notice and this permission notice')
    expect(license.toString('utf8')).toContain('THE SOFTWARE IS PROVIDED "AS IS"')
  }
})
