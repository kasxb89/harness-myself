// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/client/index.ts'
import type { ArtifactsInjected } from '../src/client/ArtifactsPage.tsx'
import type { ArtifactsMainInjected } from '../src/client/ArtifactsMain.tsx'
import type { ArtifactNoticeInjected } from '../src/client/OperationToast.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** Capture this feature's registrations without mounting unrelated shell and conversation features. */
function assemble() {
  type Registration = { name: string; inject?: () => unknown; children?: Readonly<Record<string, { kind: string; scope: string }>> }
  const registrations: Registration[] = []
  const cleanup: (() => void)[] = []
  const current = { getSnapshot: () => ({ key: 'session-one' }), subscribe: () => () => {} }
  const canOpen = vi.fn(async () => ({ ok: true, value: true }))
  const open = vi.fn(async () => ({ ok: true, value: null }))
  const loadThrough = vi.fn(async () => {})
  let entries: readonly object[] = [{ event: { type: 'tool/call', seq: 12, data: { turn: 2, callId: 'generate-call' } } }]
  const binding = { session: { loadThrough, projections: { faceOf: () => ({ getSnapshot: () => [{ turn: 2, seq: 8 }] }) } },
    eventSource: { getSnapshot: () => ({ entries }) } }
  const using = vi.fn(async (_id: string, _options: object, operation: (reference: object) => Promise<unknown>) => operation({ binding }))
  const openView = vi.fn(() => true)
  const openSession = vi.fn()
  apply({
    uiSession: { adapter: { current } },
    remote: { session: { canOpenWorkspacePath: canOpen, openWorkspacePath: open } },
    layout: { beginNavigation: () => new AbortController().signal },
    sessions: { using },
    conversationViews: { open: openView },
    uiWorkspace: { openSession },
    locale: {
      bind: () => (key: keyof typeof zh) => zh[key],
      register: () => () => {},
    },
    effect: (effect: () => (() => void) | undefined) => {
      const dispose = effect()
      if (dispose !== undefined) cleanup.push(dispose)
    },
    slots: {
      inject: (_name: string, register: () => void) => { register() },
      register: (options: Registration) => { registrations.push(options) },
    },
  } as never, Config({}))
  const page = registrations.find(row => row.name === 'main')!.inject!() as ArtifactsInjected
  const toast = registrations.find(row => row.name === 'shell.overlay')!.inject!() as ArtifactNoticeInjected
  return { page, toast, registrations, current, canOpen, open, using, loadThrough, openView, openSession,
    removeSource: () => { entries = [] }, dispose: () => { for (const close of cleanup.reverse()) close() } }
}

describe('artifact operation ownership', () => {
  it('loads and verifies the exact recorded generating tool before selecting its chat and View request', async () => {
    const origin = { sessionId: 'source-chat', turn: 2, toolCallId: 'generate-call' }
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ origin }))
    vi.stubGlobal('fetch', fetch)
    const runtime = assemble()
    const item = { path: '/files/renamed.mp4', name: 'renamed.mp4', kind: 'video' as const, size: 10, mtimeMs: 15 }
    try {
      expect(await runtime.page.returnToChat(item)).toEqual({ ok: true, value: null })
      expect(runtime.using).toHaveBeenCalledWith('source-chat', expect.objectContaining({ source: 'artifactNavigation' }), expect.any(Function))
      expect(runtime.loadThrough).toHaveBeenCalledWith(8)
      expect(runtime.openView).toHaveBeenCalledWith('source-chat', 'chat', `artifact:${JSON.stringify(origin)}`)
      expect(runtime.openSession).toHaveBeenCalledWith('source-chat')
      runtime.openView.mockClear()
      runtime.openSession.mockClear()
      runtime.removeSource()
      expect(await runtime.page.returnToChat(item)).toEqual({ ok: false, code: 'ARTIFACT_ORIGIN_UNAVAILABLE' })
      expect(runtime.openView).not.toHaveBeenCalled()
      expect(runtime.openSession).not.toHaveBeenCalled()
      fetch.mockResolvedValueOnce(Response.json({ origin: null }))
      expect(await runtime.page.returnToChat(item)).toEqual({ ok: false, code: 'ARTIFACT_ORIGIN_UNAVAILABLE' })
      expect(runtime.openSession).not.toHaveBeenCalled()
    } finally { runtime.dispose() }
  })
  it('accepts a configured visible-page cadence and rejects an unbounded or invalid cadence', () => {
    expect(Config({})).toEqual({ pollIntervalMs: 5000 })
    expect(Config({ pollIntervalMs: 1234 })).toEqual({ pollIntervalMs: 1234 })
    for (const pollIntervalMs of [0, 999, 60_001, 1.5, NaN]) expect(() => Config({ pollIntervalMs })).toThrow()
  })

  it('authorizes the root PDF reader as a keyed child of the artifacts main panel', () => {
    const runtime = assemble()
    try {
      expect(runtime.registrations.find(row => row.name === 'main')?.children)
        .toEqual({ 'artifacts.preview.pdf': { kind: 'keyed', scope: 'root' } })
    } finally { runtime.dispose() }
  })

  it('injects the retained current-session source and reports native reveal through the shell notice', async () => {
    const runtime = assemble()
    try {
      const injected = runtime.registrations.find(row => row.name === 'main')!.inject!() as ArtifactsMainInjected
      expect(injected.hooks.artifactSession).toBe(runtime.current)
      expect(await runtime.page.readDesktop()).toBe(true)
      expect(await runtime.page.reveal('/project/new.png')).toEqual({ ok: true, value: null })
      expect(runtime.open).toHaveBeenCalledWith({ path: '/project/new.png', action: 'reveal' }, expect.any(AbortSignal))
      expect(runtime.toast.hooks.notice.getSnapshot()).toEqual({ seq: 1, text: zh['notice.revealed'], success: true })
      runtime.open.mockRejectedValueOnce(new Error('private Host opener error'))
      expect(await runtime.page.reveal('/project/new.png')).toEqual({ ok: false, code: 'ARTIFACT_OPEN_FAILED' })
      expect(runtime.toast.hooks.notice.getSnapshot()).toEqual({ seq: 2, text: zh['error.ARTIFACT_OPEN_FAILED'], success: false })
    } finally { runtime.dispose() }
  })

  it('retains the same operation lock and shell notice outside a page occurrence', async () => {
    let settle!: (value: Response) => void
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise((resolve) => { settle = resolve }))
    vi.stubGlobal('fetch', fetch)
    const runtime = assemble()
    const item = { path: '/files/a.png', name: 'a.png', kind: 'image' as const, size: 128, mtimeMs: 1234 }
    try {
      const pending = runtime.page.rename(item, 'b.png')
      const otherOccurrence = runtime.registrations.find(row => row.name === 'main')!.inject!() as ArtifactsInjected
      expect(await otherOccurrence.trash(item)).toEqual({ ok: false, code: 'ARTIFACT_OPERATION_UNKNOWN' })
      expect(fetch).toHaveBeenCalledOnce()
      settle(Response.json({ item: { ...item, path: '/files/b.png', name: 'b.png' } }))
      expect(await pending).toEqual({ ok: true, value: { ...item, path: '/files/b.png', name: 'b.png' } })
      expect(runtime.toast.hooks.notice.getSnapshot()).toEqual({ seq: 1, text: zh['notice.renamed'], success: true })
      runtime.toast.dismiss()
      expect(runtime.toast.hooks.notice.getSnapshot()).toBeNull()
    } finally { runtime.dispose() }
  })

  it('injects the existing desktop chooser only when available and owns cancellation at plugin disposal', async () => {
    const pick = vi.fn(async () => '/chosen')
    vi.stubGlobal('__DSH_DIRECTORY_PICKER__', { pick })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ trashId: 't1' }))
    vi.stubGlobal('fetch', fetch)
    const runtime = assemble()
    try {
      expect(await runtime.page.pickDirectory?.()).toBe('/chosen')
      expect(pick).toHaveBeenCalledOnce()
      await runtime.page.trash({ path: '/files/a.png', name: 'a.png', kind: 'image', size: 1, mtimeMs: 2 })
      const signal = fetch.mock.calls[0]![1]!.signal as AbortSignal
      expect(signal.aborted).toBe(false)
      runtime.dispose()
      expect(signal.aborted).toBe(true)
    } finally { runtime.dispose() }
  })
})
