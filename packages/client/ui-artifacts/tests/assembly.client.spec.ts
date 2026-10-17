// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import type { ArtifactsInjected } from '../src/client/ArtifactsPage.tsx'
import type { ArtifactNoticeInjected } from '../src/client/OperationToast.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** Capture this feature's registrations without mounting unrelated shell and conversation features. */
function assemble() {
  const registrations: { name: string; inject?: () => unknown }[] = []
  const cleanup: (() => void)[] = []
  apply({
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
      register: (options: { name: string; inject?: () => unknown }) => { registrations.push(options) },
    },
  } as never)
  const page = registrations.find(row => row.name === 'main')!.inject!() as ArtifactsInjected
  const toast = registrations.find(row => row.name === 'shell.overlay')!.inject!() as ArtifactNoticeInjected
  return { page, toast, registrations, dispose: () => { for (const close of cleanup.reverse()) close() } }
}

describe('artifact operation ownership', () => {
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
