/** Host-only receipt projection; message text and credentials are never retained. */
import z from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProviderRequestId } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { deriveChatUsageRequests, type ChatUsageRequest, type ChatUsageSelection } from './chat-usage.ts'

interface TurnReceipts {
  readonly requests: readonly ChatUsageRequest[]
  readonly complete: boolean
  readonly attempts: number
  readonly started: boolean
  readonly closed: boolean
}

/** Durable-cache state derived exclusively from committed turn and assistant events. */
export interface ChatReceiptState {
  readonly turns: Readonly<Record<string, TurnReceipts>>
}

const receiptSchema: z.ZodType<ChatUsageRequest> = z.object({
  requestId: z.string().regex(/^[A-Za-z\d_.-]{1,64}$/u).transform(brandString<ProviderRequestId>),
  apiBaseUrl: z.string().max(2048),
}).strict()
const turnSchema: z.ZodType<TurnReceipts> = z.object({
  requests: z.array(receiptSchema), complete: z.boolean(), attempts: z.number().int().nonnegative(),
  started: z.boolean(), closed: z.boolean(),
}).strict()
const stateSchema: z.ZodType<ChatReceiptState> = z.object({ turns: z.record(z.string().regex(/^[1-9]\d*$/u), turnSchema) }).strict()

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    chatReceipts: ChatReceiptState
  }
}

/** Receipt completeness and turn state; no client projection or additional Session event. */
export const chatReceiptProjection: ProjectionDefinition<'chatReceipts', ChatReceiptState> = {
  key: 'chatReceipts', stateVersion: 1, stateSchema,
  init: () => ({ turns: {} }),
  apply(state, event) {
    if (event.type !== 'turn/start' && event.type !== 'turn/end' && event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
    const key = String(event.data.turn)
    const previous = state.turns[key] ?? { requests: [], complete: true, attempts: 0, started: false, closed: false }
    let next: TurnReceipts
    if (event.type === 'turn/start') next = { ...previous, started: true, closed: false }
    else if (event.type === 'turn/end') next = { ...previous, closed: true }
    else {
      const selection = deriveChatUsageRequests([event])
      const requests = new Map([...previous.requests, ...selection.requests].map(request => [JSON.stringify(request), request]))
      next = { ...previous, requests: [...requests.values()], complete: previous.complete && selection.complete,
        attempts: previous.attempts + 1 }
    }
    return { turns: { ...state.turns, [key]: next } }
  },
}

/**
 * Select current projected receipts without synchronously reading historical Session events.
 * @param state - Complete Host projection for one attached Session.
 * @param turn - Optional positive turn number; absence selects the whole Session.
 * @returns Exact receipt selection and whether selected work is still open.
 */
export function selectChatReceipts(state: ChatReceiptState, turn?: number): { selection: ChatUsageSelection; ongoing: boolean } {
  const turns = turn === undefined ? Object.values(state.turns) : [state.turns[String(turn)]].filter(value => value !== undefined)
  const attempted = turns.filter(value => value.attempts > 0)
  const requests = new Map<string, ChatUsageRequest>()
  for (const value of attempted) for (const request of value.requests) requests.set(JSON.stringify(request), request)
  return {
    selection: { requests: [...requests.values()], complete: attempted.length > 0 && attempted.every(value => value.complete) },
    ongoing: turns.some(value => value.started && !value.closed),
  }
}
