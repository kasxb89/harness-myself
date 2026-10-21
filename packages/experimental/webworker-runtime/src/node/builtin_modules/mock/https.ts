/** Native TLS listeners are unavailable in a browser worker's HTTP tunnel. */
import { notAvailableError } from '../../notImplementedFail.ts'

/**
 * Reject native TLS instead of serving plaintext for an HTTPS configuration.
 * @returns Never; a browser worker cannot bind a TLS socket.
 */
export function createServer(): never {
  throw notAvailableError('node:https', 'createServer')
}

/** TLS agent constructor required by transport modules; native transport remains unavailable. */
export class Agent {
  constructor() {
    throw notAvailableError('node:https', 'Agent')
  }
}

/** CommonJS interop marker for the worker module loader. */
export const __esModule = true

/** CommonJS exports for the worker's explicit TLS-listener refusal. */
export default { Agent, createServer } satisfies Partial<Omit<typeof import('node:https'), 'Agent'>>
  & Record<'Agent', unknown>
