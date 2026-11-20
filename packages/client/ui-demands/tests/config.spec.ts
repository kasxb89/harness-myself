/** Host page bootstrap explicitly projects the feature's public settings. */
import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import * as host from '../src/index.ts'
import { DEMANDS_CONFIG_GLOBAL, publicDemandConfig } from '../src/config.ts'

describe('demand public bootstrap', () => {
  it('projects explicit case metadata and withdraws the page injection with its Host owner', async () => {
    const root = new Context()
    const catalogue = [{ id: 'reference', title: 'Reference material', description: 'A configured case', category: 'web' as const,
      coverUrl: '/case-media/cover.png', media: [{ kind: 'image' as const, url: '/case-media/original.png' }],
      sourceName: 'Original contributor', sourceUrl: 'https://example.com/project', attribution: 'MIT' }]
    const plugin = root.plugin(host, { enabled: false, requestTimeoutMs: 5000, showcaseItems: catalogue })
    try {
      await plugin.await()
      const rows: IndexInjection[] = []
      root.emit('webserver/index-inject', rows)
      expect(rows).toEqual([{ kind: 'global', name: DEMANDS_CONFIG_GLOBAL,
        value: { enabled: false, requestTimeoutMs: 5000, uploadTimeoutMs: 120000, foregroundPollMs: 3000,
          backgroundPollMs: 15000, listPollMs: 15000, showcaseItems: [{ ...catalogue[0],
            media: [{ ...catalogue[0]?.media[0], posterUrl: '' }] }] } }])
      await plugin.dispose()
      const after: IndexInjection[] = []
      root.emit('webserver/index-inject', after)
      expect(after).toEqual([])
    } finally { await root.fiber.dispose() }
  })

  it('keeps the catalogue empty by default and rejects malformed public metadata', () => {
    expect(publicDemandConfig({}).showcaseItems).toEqual([])
    expect(() => publicDemandConfig({ showcaseItems: 'wrong' })).toThrow()
    expect(() => publicDemandConfig({ showcaseItems: [{ id: 'bad', title: 'Broken record' }] })).toThrow()
  })
})
