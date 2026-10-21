import { afterEach, expect, it, vi } from 'vitest'
import { requestPrompt, verifyAccount } from '../src/client/request.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('keeps account verification and prompt assistance beneath the document public mount', async () => {
  vi.stubGlobal('document', { baseURI: 'https://host.invalid/mount/' })
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ ok: true, payload: { signedIn: true, account: { id: 'account-a' } } }))
    .mockResolvedValueOnce(Response.json({ ok: true, payload: { prompt: 'A synthetic cup' } }))
  vi.stubGlobal('fetch', fetcher)
  const signal = new AbortController().signal
  await verifyAccount('account-a', signal)
  expect(await requestPrompt({ accountId: 'account-a', sessionId: 'session-a', expectedSelection: null,
    kind: 'image', prompt: 'A cup', instruction: 'Keep the cup', references: [], generation: { model: 'fixture-model' } }, signal)).toBe('A synthetic cup')
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/mount/credits/api/session', '/mount/credits/api/prompt/assist'])
})
