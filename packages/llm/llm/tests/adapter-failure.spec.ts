import { describe, expect, it } from 'vitest'
import { normalizeLlmFailure } from '../src/adapter-failure.ts'
import { LlmError } from '../src/index.ts'
import { ProviderRequestId } from '../src/brand.ts'

function zeroSendProof() {
  return {
    schemaVersion: 1 as const, model: 'unavailable-model', requestId: ProviderRequestId('gateway-request-1'),
    origin: 'https://8.133.202.230', managedScope: 'account-backend-scope',
    submissionState: 'not_submitted' as const, upstreamSubmitted: false as const,
    billingReserved: false as const, reason: 'model_unavailable' as const,
  }
}

describe('adapter failure normalization', () => {
  it('contains hostile non-Error coercion', () => {
    const thrown = { [Symbol.toPrimitive]: () => { throw new Error('coercion failed') } }
    expect(normalizeLlmFailure(thrown)).toEqual({ message: 'LLM adapter failed', code: 'UNKNOWN' })
  })

  it('normalizes empty primitive throws and data descriptors without values', () => {
    expect(normalizeLlmFailure('')).toEqual({ message: 'LLM adapter failed', code: 'UNKNOWN' })
    expect(normalizeLlmFailure(null)).toEqual({ message: 'null', code: 'UNKNOWN' })

    const error = new Error('provider failed')
    Object.defineProperty(error, 'failure', { get: () => ({ message: 'ignored', code: 'IGNORED' }) })
    Object.defineProperty(error, 'code', { get: () => 'IGNORED' })
    expect(normalizeLlmFailure(error)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })

    const accessorCode = Object.assign(new Error('provider failed'), {
      failure: { message: 'provider failed', code: 'FOREIGN' },
    })
    Object.defineProperty(accessorCode, 'code', { get: () => 'FOREIGN' })
    expect(normalizeLlmFailure(accessorCode)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })

    const primitiveFailure = Object.assign(new Error('provider failed'), {
      failure: null,
      code: 'FOREIGN',
    })
    expect(normalizeLlmFailure(primitiveFailure)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })
  })

  it('contains hostile Error property reflection', () => {
    const withFailure = new Error('provider failed') as Error & { failure: unknown; code: string }
    withFailure.failure = { message: 'provider failed', code: 'FOREIGN' }
    withFailure.code = 'FOREIGN'
    const hostileCode = new Proxy(withFailure, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'code') throw new Error('code descriptor failed')
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    expect(normalizeLlmFailure(hostileCode)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })

    const hostileFailure = new Proxy(new Error('provider failed'), {
      getOwnPropertyDescriptor() { throw new Error('failure descriptor failed') },
    })
    expect(normalizeLlmFailure(hostileFailure)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })
  })

  it('rejects malformed or accessor-backed failure snapshots', () => {
    const malformed = new Error('provider failed') as Error & { failure: unknown; code: string }
    malformed.failure = { message: 'provider failed', code: 'FOREIGN', requestId: '' }
    malformed.code = 'FOREIGN'
    expect(normalizeLlmFailure(malformed)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })

    const accessorBacked = new Error('provider failed') as Error & { failure: unknown }
    accessorBacked.failure = Object.defineProperty({}, 'message', {
      get() { throw new Error('failure getter failed') },
    })
    expect(normalizeLlmFailure(accessorBacked)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })
  })

  it('falls back when an Error message accessor throws', () => {
    const error = new Error('provider failed')
    Object.defineProperty(error, 'message', { get() { throw new Error('message getter failed') } })
    expect(normalizeLlmFailure(error)).toEqual({ message: 'LLM adapter failed', code: 'UNKNOWN' })
  })

  it('retains detached zero-send evidence through LlmError and a foreign adapter boundary', () => {
    const proof = zeroSendProof()
    const error = new LlmError('Model was not submitted', 'MODEL_UNAVAILABLE_NOT_SUBMITTED', {
      status: 503, requestId: proof.requestId, textReselection: proof,
    })
    proof.model = 'modified-after-construction'
    const foreign = Object.assign(new Error(error.message), { code: error.code, failure: error.failure })
    const normalized = normalizeLlmFailure(foreign)
    expect(normalized.textReselection).toEqual(zeroSendProof())
    expect(normalized.textReselection).not.toBe(error.failure.textReselection)
    expect(Object.isFrozen(normalized.textReselection)).toBe(true)
    expect(Object.isFrozen(normalized)).toBe(true)
  })

  it.each([
    { status: 408 }, { status: 401 }, { status: 402 }, { status: 429 },
    { code: 'SERVER' }, { requestId: ProviderRequestId('different-request') },
    { textReselection: { ...zeroSendProof(), schemaVersion: 2 } },
    { textReselection: { ...zeroSendProof(), upstreamSubmitted: true } },
    { textReselection: { ...zeroSendProof(), billingReserved: true } },
    { textReselection: { ...zeroSendProof(), upstreamSubmitted: 'false' } },
    { textReselection: { ...zeroSendProof(), origin: 'http://8.133.202.230' } },
    { textReselection: { ...zeroSendProof(), origin: 'https://8.133.202.230/harness' } },
    { textReselection: { ...zeroSendProof(), managedScope: '' } },
  ])('removes recovery permission from inconsistent failure evidence: %j', (change) => {
    const failure = {
      message: 'Provider failed', code: 'MODEL_UNAVAILABLE_NOT_SUBMITTED', status: 503,
      requestId: zeroSendProof().requestId, textReselection: zeroSendProof(), ...change,
    }
    const error = Object.assign(new Error(failure.message), { code: failure.code, failure })
    expect(normalizeLlmFailure(error)).not.toHaveProperty('textReselection')
    expect(normalizeLlmFailure(error).message).toBe('Provider failed')
  })

  it('does not execute accessors inside carried recovery evidence', () => {
    let reads = 0
    const proof = Object.defineProperty(zeroSendProof(), 'model', { get() { reads++; return 'unavailable-model' } })
    const error = Object.assign(new Error('Provider failed'), {
      code: 'MODEL_UNAVAILABLE_NOT_SUBMITTED', failure: {
        message: 'Provider failed', code: 'MODEL_UNAVAILABLE_NOT_SUBMITTED', status: 503,
        requestId: proof.requestId, textReselection: proof,
      },
    })
    expect(normalizeLlmFailure(error)).not.toHaveProperty('textReselection')
    expect(reads).toBe(0)
  })

  it('rejects constructing inconsistent typed evidence', () => {
    const proof = zeroSendProof()
    expect(() => new LlmError('Provider failed', 'MODEL_UNAVAILABLE_NOT_SUBMITTED', {
      status: 503, requestId: ProviderRequestId('another-request'), textReselection: proof,
    })).toThrow(/textReselection/u)
    expect(() => new LlmError('Provider failed', 'SERVER', {
      status: 503, requestId: proof.requestId, textReselection: proof,
    })).toThrow(/textReselection/u)
  })
})
