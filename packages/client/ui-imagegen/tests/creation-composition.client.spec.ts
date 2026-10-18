// @vitest-environment jsdom
/** Creation pages consume the same Session adapter and project factory in the shipped Loader roster. */
import { afterEach, describe, expect, vi } from 'vitest'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ImagePage } from '../src/client/ImagePage.tsx'
import { VideoPage } from '../../ui-videogen/src/client/VideoPage.tsx'

const IMAGE = '@deepseek-ai/dsh-client-ui-imagegen'
const VIDEO = '@deepseek-ai/dsh-client-ui-videogen'
const it = createClientTest({ roster: webApp })
afterEach(() => { vi.unstubAllGlobals() })

describe('AI creation real Loader composition', () => {
  it('shares the current Chat scope, localized feedback and project factory, then releases page registrations', async ({ start }) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url !== '/credits/api/session') throw new Error(`Unexpected fixture fetch: ${url}`)
      return Response.json({ ok: true, payload: { signedIn: false, creditsPerYuan: 1000 } })
    }))
    const c = await start()
    const image = c.ctx.slots.entries('main').find(entry => entry.component === ImagePage)
    const video = c.ctx.slots.entries('main').find(entry => entry.component === VideoPage)
    expect(image).toBeDefined()
    expect(video).toBeDefined()
    for (const entry of [image!, video!]) {
      const hooks = entry.inject!().hooks
      if (typeof hooks !== 'object' || hooks === null || !('creationSession' in hooks)) {
        throw new Error('AI creation injection must provide the current conversation source')
      }
      expect(hooks.creationSession).toBe(c.ctx.uiSession.adapter.current)
    }
    expect(c.ctx.slots.snapshot('factory:creation.projects')[0]?.scope).toBe('session-maybe')
    const output = {
      image: c.ctx.locale.bind('imagegen')('sessionRequired'),
      video: c.ctx.locale.bind('videogen')('sessionRequired'),
    }
    expect(output).toMatchInlineSnapshot(`
      {
        "image": "Select or create a conversation in Chat first. Projects and outputs will be linked to it.",
        "video": "Select or create a conversation in Chat first. Projects and outputs will be linked to it.",
      }
    `)
    await c.unload(IMAGE)
    await c.unload(VIDEO)
    await c.flush()
    expect(c.ctx.slots.entries('main').some(entry => entry.component === ImagePage || entry.component === VideoPage)).toBe(false)
    expect(c.ctx.slots.snapshot('factory:creation.projects')).toHaveLength(1)
  }, 60_000)
})
