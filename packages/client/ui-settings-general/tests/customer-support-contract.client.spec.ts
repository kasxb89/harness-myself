// @vitest-environment jsdom
/** Actual API settings projected by the Host remain readable by the isolated Client program. */
import { afterEach, expect, it, vi } from 'vitest'
import { readCustomerSupport } from '../src/client/customer-support-reader.ts'
import captures from './fixtures/customer-support-host-projection.json' with { type: 'json' }

afterEach(() => { vi.unstubAllGlobals() })

it.each(captures.samples)('accepts actual $database status sample $ordinal after Host projection', async (sample) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(sample.host)))
  expect(await readCustomerSupport(new AbortController().signal)).toEqual(sample.host)
})
