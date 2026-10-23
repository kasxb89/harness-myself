/** Native session checks have a finite deadline without forwarding private transport failures. */
import { afterEach, expect, it, vi } from 'vitest'
import { fetchDesktopWelcome, WELCOME_REQUEST_TIMEOUT_MS } from '../src/welcome-session.ts'

afterEach(() => { vi.restoreAllMocks() })

it('aborts one stalled local request at its owned deadline and returns only the safe timeout category', async () => {
  const deadline = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  const pending = Promise.withResolvers<Response>()
  const send = vi.fn(async (_input: string, init?: RequestInit) => {
    init!.signal!.addEventListener('abort', () => { pending.reject(init!.signal!.reason) }, { once: true })
    return pending.promise
  })
  const request = fetchDesktopWelcome(send, 'http://127.0.0.1/credits/api/session', { credentials: 'include' })
  expect(timeout).toHaveBeenCalledExactlyOnceWith(WELCOME_REQUEST_TIMEOUT_MS)
  deadline.abort(new DOMException('private upstream timeout detail', 'TimeoutError'))
  await expect(request).rejects.toMatchObject({ name: 'DesktopWelcomeUnavailableError', reason: 'timeout', message: 'desktop welcome: session check unavailable' })
  expect(send).toHaveBeenCalledOnce()
})

it('keeps an immediate network failure separate from timeout without retaining its message or cause', async () => {
  const request = fetchDesktopWelcome(async () => { throw new TypeError('private endpoint and credential diagnostic') },
    'http://127.0.0.1/credits/api/session', {})
  await expect(request).rejects.toMatchObject({ name: 'DesktopWelcomeUnavailableError', reason: 'network', message: 'desktop welcome: session check unavailable' })
  await expect(request).rejects.not.toHaveProperty('cause')
})
