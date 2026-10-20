/** Gateway metadata cannot persist credentials embedded in configurable endpoints. */
import { describe, expect, it } from 'vitest'
import { gatewayReceipt } from '../src/gateway-receipt.ts'

describe('optional gateway receipt metadata', () => {
  it('preserves the complete safe gateway prefix', () => {
    expect(gatewayReceipt('https://gateway.example/harness/v1', new Headers({ 'x-oneapi-request-id': 'request-1' })))
      .toEqual({ kind: 'oneapi', version: 1, apiBaseUrl: 'https://gateway.example/harness/v1', requestId: 'request-1' })
  })
  it.each([
    'https://gateway.example/v1?api_key=secret', 'https://user:secret@gateway.example/v1',
    'https://gateway.example/v1#secret', 'file:///private/secret', 'malformed',
    'http://public-gateway.example/v1', 'https://gateway.example/v1?',
    `https://gateway.example/${'a'.repeat(2048)}`,
  ])('omits a receipt for an unsafe endpoint without retaining its text: %s', (endpoint) => {
    expect(gatewayReceipt(endpoint, new Headers({ 'x-oneapi-request-id': 'request-1' }))).toBeUndefined()
  })
  it.each(['', 'a'.repeat(65), 'two ids'])('omits missing or malformed header identities: %s', (requestId) => {
    expect(gatewayReceipt('https://gateway.example/v1', new Headers({ 'x-oneapi-request-id': requestId }))).toBeUndefined()
  })
})
