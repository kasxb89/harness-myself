/** Actual API handler snapshots pass through the production Host customer-support reader. */
import { expect, it } from 'vitest'
import { parseCustomerSupport } from '../../../packages/host/credits-index/src/customer-support.ts'
import captures from './fixtures/customer-support-api-status.json' with { type: 'json' }

it.each(captures.samples)('accepts actual $database API status sample $ordinal through the Host', (sample) => {
  const host = parseCustomerSupport(sample.response, 'https://api.example.invalid/harness')
  expect(host.ok).toBe(true)
  if (!host.ok) throw new Error('Actual API status was rejected by the Host reader')
  if (host.payload.enabled) {
    expect(host.payload.qrCodeUrl).toMatch(/^https:\/\/api\.example\.invalid\/harness\/api\/creation\/assets\/cc_[a-f0-9]{64}$/u)
  } else expect(host.payload).toEqual({ enabled: false, qrCodeUrl: '', title: '', description: '' })
})
