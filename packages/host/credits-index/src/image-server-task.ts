/** Server-issued image result identities admitted at HTTP and private-record reads. @module */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CreativeImageServerTaskId } from './creative-types.ts'

/**
 * Read a credential-free canonical task identifier without accepting a path or URL.
 * @param value - Untrusted response header or private receipt field.
 * @returns The admitted server identity, otherwise undefined.
 */
export function imageServerTaskId(value: unknown): CreativeImageServerTaskId | undefined {
  return typeof value === 'string' && /^task_[A-Za-z0-9][A-Za-z0-9._:-]{0,250}$/u.test(value)
    ? brandString<CreativeImageServerTaskId>(value) : undefined
}
