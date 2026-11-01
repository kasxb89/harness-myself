/** Detach bounded JSON prompt hints before asynchronous Host admission listeners run. */
import { Buffer } from 'node:buffer'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionPromptInputContext } from './types.ts'

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function invalid(): never {
  throw new RemoteError('gateway/bad-request',
    'inputContext must be a namespaced JSON object within 16 KiB, depth 8, and 1,024 values', {})
}

/**
 * Validate and freeze a detached input-context snapshot; accessors are never invoked.
 * @param value - Untrusted optional Remote input.
 * @returns Immutable JSON hints, or undefined when omitted.
 * @throws A bad-request error for non-JSON values, unsafe keys, or exceeded limits.
 */
export function admitPromptInputContext(value: unknown): SessionPromptInputContext | undefined {
  if (value === undefined) return undefined
  let nodes = 0
  const ancestors = new Set<object>()
  const visit = (current: unknown, depth: number): JsonValue => {
    if (++nodes > 1024 || depth > 8) return invalid()
    if (current === null || typeof current === 'boolean' || typeof current === 'string') return current
    if (typeof current === 'number' && Number.isFinite(current) && !Object.is(current, -0)) return current
    if (typeof current !== 'object' || ancestors.has(current)) return invalid()
    const array = Array.isArray(current)
    const prototype: unknown = Object.getPrototypeOf(current)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid()
    const keys = Reflect.ownKeys(current)
    if (array && keys.length !== current.length + 1) return invalid()
    ancestors.add(current)
    let result: JsonValue
    if (array) {
      const items: JsonValue[] = []
      for (let index = 0; index < current.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return invalid()
        items.push(visit(descriptor.value, depth + 1))
      }
      result = items
    } else {
      const record: Record<string, JsonValue> = {}
      for (const key of keys) {
        if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)
          || depth === 0 && !/^[a-z][a-z0-9_./-]{0,63}$/.test(key)) return invalid()
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return invalid()
        record[key] = visit(descriptor.value, depth + 1)
      }
      result = record
    }
    ancestors.delete(current)
    Object.freeze(result)
    return result
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
  const detached = visit(value, 0) as SessionPromptInputContext
  if (Buffer.byteLength(JSON.stringify(detached), 'utf8') > 16 * 1024) return invalid()
  return detached
}
