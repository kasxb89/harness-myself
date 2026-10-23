import { expect, it } from 'vitest'
import { sessionBodyFailure, sessionHttpFailure, sessionTransportFailure } from '../src/session-failure.ts'

it.each([[408, 'timeout'], [504, 'timeout'], [429, 'rate_limited'], [503, 'upstream_unavailable'],
  [401, 'upstream_rejected'], [403, 'upstream_rejected']] as const)('classifies actual HTTP%i safely', (status, reason) => {
  expect(sessionHttpFailure(status, 'account-read')).toEqual({ reason, stage: 'account-read', status })
})

it('distinguishes transport timeouts from malformed JSON without returning exception details', () => {
  expect(sessionTransportFailure(new TypeError('private URL or token'), 'renewal')).toEqual({ reason: 'network', stage: 'renewal' })
  expect(sessionTransportFailure(new DOMException('private', 'TimeoutError'), 'renewal')).toEqual({ reason: 'timeout', stage: 'renewal' })
  expect(sessionTransportFailure(new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT', private: 'hidden' } }), 'account-read'))
    .toEqual({ reason: 'timeout', stage: 'account-read' })
  expect(sessionBodyFailure(new SyntaxError('private response text'), 'account-read', 200))
    .toEqual({ reason: 'protocol', stage: 'account-read', status: 200 })
  expect(sessionBodyFailure(new TypeError('stream terminated'), 'account-read', 200))
    .toEqual({ reason: 'network', stage: 'account-read', status: 200 })
})
