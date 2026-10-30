// @vitest-environment jsdom
/** Speech navigation and account/chat injections use the shipped Loader roster. */
import { afterEach, describe, expect, vi } from 'vitest'
import { act, screen } from '@testing-library/react'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { en } from '../src/client/locales.ts'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { AudioPage } from '../src/client/AudioPage.tsx'
import { ImagePage } from '../../ui-imagegen/src/client/ImagePage.tsx'
import { VideoPage } from '../../ui-videogen/src/client/VideoPage.tsx'

function callback(value: unknown): value is () => void { return typeof value === 'function' }

const SELF = '@deepseek-ai/dsh-client-ui-creative'
const IMAGE = '@deepseek-ai/dsh-client-ui-imagegen'
const VIDEO = '@deepseek-ai/dsh-client-ui-videogen'
const it = createClientTest({ roster: webApp.closure([SELF, IMAGE, VIDEO]) })
const mountedIt = createClientTest({ roster: webApp.closure([SELF, IMAGE, VIDEO]) }, { mount: true })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('speech creation real Loader composition', () => {
  mountedIt('renders account recovery in the registered main panel without making a generation request', async ({ start }) => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url !== '/credits/api/session') throw new Error(`Unexpected fixture fetch: ${url}`)
      return Response.json({ ok: true, payload: { signedIn: false, creditsPerYuan: 1000 } })
    })
    vi.stubGlobal('fetch', fetcher)
    const client = await start()
    const selectedChat = client.ctx.uiSession.adapter.current.getSnapshot().key
    await act(async () => { client.ctx.layout.selectPanel('audiogen' as MainPanelId) })
    await client.flush()
    expect(screen.getByRole('heading', { name: en['audio.creationTitle'] })).toBeTruthy()
    expect(screen.getByText(en.signedOut)).toBeTruthy()
    expect(fetcher.mock.calls.every(([input, init]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return !url.includes('/audio/') && (init?.method === undefined || init.method === 'GET')
    })).toBe(true)
    expect(client.ctx.uiSession.adapter.current.getSnapshot().key).toBe(selectedChat)
    await act(async () => { await client.unload(SELF) })
    await client.flush()
    expect(screen.queryByRole('heading', { name: en['audio.creationTitle'] })).toBeNull()
    expect(client.ctx.slots.entries('main').some(entry => entry.component === AudioPage)).toBe(false)
  }, 60_000)

  it('registers the audio main panel with authoritative account and chat sources and releases it on unload', async ({ start }) => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url !== '/credits/api/session') throw new Error(`Unexpected fixture fetch: ${url}`)
      return Response.json({ ok: true, payload: { signedIn: false, creditsPerYuan: 1000 } })
    })
    vi.stubGlobal('fetch', fetcher)
    const client = await start()
    const audio = client.ctx.slots.entries('main').find(entry => entry.component === AudioPage)
    expect(audio?.options.key).toBe('audiogen')
    const injected = audio!.inject!()
    const hooks = injected.hooks
    if (hooks === null || typeof hooks !== 'object' || !('creationSession' in hooks) || !('creditsSession' in hooks)) {
      throw new Error('Audio main panel must inject the authoritative account and chat sources')
    }
    expect(hooks.creationSession).toBe(client.ctx.uiSession.adapter.current)
    expect(hooks.creditsSession).toBe(client.ctx.creditsSession)
    const selectedChat = client.ctx.uiSession.adapter.current.getSnapshot().key
    const image = client.ctx.slots.entries('main').find(entry => entry.component === ImagePage)
    const video = client.ctx.slots.entries('main').find(entry => entry.component === VideoPage)
    for (const entry of [image!, video!]) {
      const face = entry.inject!()
      if (!callback(face.openAudio)) throw new Error('Creation mode must navigate to the audio main panel')
      face.openAudio()
      expect(client.ctx.layout.panelInfo.getSnapshot().activePanelId).toBe('audiogen')
    }
    if (!callback(injected.openImage) || !callback(injected.openVideo)) {
      throw new Error('Audio main panel must navigate to both sibling creation modes')
    }
    injected.openImage()
    expect(client.ctx.layout.panelInfo.getSnapshot().activePanelId).toBe('imagegen')
    injected.openVideo()
    expect(client.ctx.layout.panelInfo.getSnapshot().activePanelId).toBe('videogen')
    expect(client.ctx.uiSession.adapter.current.getSnapshot().key).toBe(selectedChat)
    expect(fetcher.mock.calls.every(([, init]) => init?.method === undefined || init.method === 'GET')).toBe(true)
    expect({ audio: client.ctx.locale.bind('creative')('audio.creationTitle'),
      image: client.ctx.locale.bind('imagegen')('tab.audio'), video: client.ctx.locale.bind('videogen')('tab.audio'),
    }).toMatchInlineSnapshot(`
      {
        "audio": "AI creation",
        "image": "Audio",
        "video": "Audio",
      }
    `)
    await client.unload(SELF)
    await client.flush()
    expect(client.ctx.slots.entries('main').some(entry => entry.component === AudioPage)).toBe(false)
    expect(client.ctx.slots.entries('main').some(entry => entry.component === ImagePage)).toBe(true)
    expect(client.ctx.slots.entries('main').some(entry => entry.component === VideoPage)).toBe(true)
    const previousPanel = client.ctx.layout.panelInfo.getSnapshot().activePanelId
    expect(() => {
      const face = image!.inject!()
      if (callback(face.openAudio)) face.openAudio()
    }).toThrow(/not registered/u)
    expect(client.ctx.layout.panelInfo.getSnapshot().activePanelId).toBe(previousPanel)
  }, 60_000)
})
