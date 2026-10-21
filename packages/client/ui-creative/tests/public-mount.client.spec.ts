import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { readCreativeProjects, recoverCreativeImage, saveCreativePlan, uploadCreativeAsset } from '../src/client/api.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('keeps project reads, edits, recovery and uploads beneath the document public mount', async () => {
  vi.stubGlobal('document', { baseURI: 'https://host.invalid/mount/' })
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: false }, { status: 401 }))
  vi.stubGlobal('fetch', fetcher)
  const signal = new AbortController().signal
  const sessionId = SessionId('session-a')
  await readCreativeProjects(sessionId, signal)
  await saveCreativePlan({ sessionId, projectId: 'cp_original', expectedRevision: 'retained', change: { kind: 'reorder', shotIds: ['s1'] } }, signal)
  await recoverCreativeImage({ sessionId, projectId: 'cp_original', operationId: 'op_original' }, signal)
  await recoverCreativeImage({ sessionId, projectId: 'cp_original', operationId: 'op_original', kind: 'video' }, signal)
  await uploadCreativeAsset(new File(['fixture'], 'fixture.png', { type: 'image/png' }), signal)
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    '/mount/credits/api/creative/projects?session_id=session-a', '/mount/credits/api/creative/plan',
    '/mount/credits/api/creative/image/recover', '/mount/credits/api/creative/video/recover', '/mount/credits/api/assets',
  ])
})
