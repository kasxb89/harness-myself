// @vitest-environment jsdom
/** The real Loader, shell selection and HTTP listing discover independently produced files. */
import { act, screen } from '@testing-library/react'
import { afterEach, describe, expect, vi } from 'vitest'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { PANEL_ID } from '../src/client/index.ts'
import type { ArtifactEntry } from '../src/client/ArtifactsPage.tsx'
import { en } from '../src/client/locales.ts'

const SELF = '@deepseek-ai/dsh-client-ui-artifacts'
const it = createClientTest({ roster: webApp.closure([SELF]) }, { mount: true })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('artifact library real Loader composition', () => {
  it('refreshes the selected library without changing the chat, then stops when the main panel is closed', async ({ start, remote }) => {
    remote.session.canOpenWorkspacePath.mockResolvedValue({ ok: true, value: false })
    let items: readonly ArtifactEntry[] = []
    let listingReads = 0
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      expect(init?.method ?? 'GET').toBe('GET')
      if (url === '/artifacts/api/list') {
        listingReads++
        return Response.json({ items, roots: ['/output'], truncated: false })
      }
      if (url === '/artifacts/api/storage') return Response.json({
        directory: '/output', defaultDirectory: '/output', roots: ['/output'], revision: 0,
      })
      if (url === '/artifacts/api/trash') return Response.json({ items: [] })
      throw new Error(`Unexpected fixture request: ${url}`)
    })
    vi.stubGlobal('fetch', fetcher)
    const client = await start()
    const selectedChat = client.ctx.uiSession.adapter.current.getSnapshot().key
    vi.useFakeTimers()
    await act(async () => { client.ctx.layout.selectPanel(PANEL_ID) })
    await client.flush()
    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
    expect(listingReads).toBe(1)
    items = [{ path: '/output/generated.png', name: 'generated.png', kind: 'image', size: 128, mtimeMs: 1 }]
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(screen.getByRole('button', { name: /^generated\.png/u })).toBeTruthy()
    expect(listingReads).toBe(2)
    expect(client.ctx.uiSession.adapter.current.getSnapshot().key).toBe(selectedChat)
    await act(async () => { client.ctx.layout.selectPanel(null) })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(listingReads).toBe(2)
    await act(async () => { await client.unload(SELF) })
    expect(client.ctx.slots.entries('main').some(entry => entry.options.key === PANEL_ID)).toBe(false)
  }, 60_000)
})
