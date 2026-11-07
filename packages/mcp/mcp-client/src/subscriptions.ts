/** Track update notifications in the connection generation that received them. */
import type { Client, McpSubscription, RequestOptions } from '@modelcontextprotocol/client'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

const MAX_SUBSCRIPTIONS = 128

export function resourceSubscriptions(client: Client) {
  interface Subscription {
    owners: Map<string, number>
    updates: number
    pending: boolean
    stream?: McpSubscription
  }
  const subscriptions = new Map<string, Subscription>()
  client.setNotificationHandler('notifications/resources/updated', ({ params }) => {
    const entry = subscriptions.get(params.uri)
    if (entry) entry.updates += 1
  })

  return {
    async request(
      method: 'resources/subscribe' | 'resources/unsubscribe' | 'resources/subscription/status',
      uri: string, exec: ToolExecution, options: RequestOptions,
    ) {
      const owner = exec.agent?.session.id
      if (owner === undefined) throw new Error('MCP subscriptions require a chat session')
      exec.signal.throwIfAborted()
      const entry = subscriptions.get(uri)
      const from = entry?.owners.get(owner)
      if (entry?.pending) throw new Error('This MCP subscription is changing; check its status again')
      if (method === 'resources/subscription/status') {
        return entry && from !== undefined
          ? { subscribed: true, updates: entry.updates - from }
          : { subscribed: false, updates: 0 }
      }
      if (method === 'resources/unsubscribe') {
        if (entry && from !== undefined) {
          if (entry.owners.size === 1) {
            entry.pending = true
            try {
              if (entry.stream) await entry.stream.close()
              else await client.unsubscribeResource({ uri }, options)
              subscriptions.delete(uri)
            } finally {
              entry.pending = false
            }
          } else {
            entry.owners.delete(owner)
          }
        }
        return { subscribed: false, updates: 0 }
      }
      if (client.getServerCapabilities()?.resources?.subscribe !== true) {
        throw new Error('The MCP server does not support resource subscriptions')
      }
      if (entry) {
        if (from !== undefined) return { subscribed: true, updates: entry.updates - from }
        if (entry.owners.size >= MAX_SUBSCRIPTIONS) throw new Error('This MCP resource has too many subscribers')
        entry.owners.set(owner, entry.updates)
        return { subscribed: true, updates: 0 }
      }
      if (subscriptions.size >= MAX_SUBSCRIPTIONS) throw new Error('This MCP server has too many subscriptions')
      const next: Subscription = { owners: new Map([[owner, 0]]), updates: 0, pending: true }
      subscriptions.set(uri, next)
      try {
        // The 2026-07-28 protocol delivers notifications on a dedicated stream.
        if ((client.getNegotiatedProtocolVersion() ?? '') >= '2026-07-28') {
          const opening = new AbortController()
          const abort = () => { opening.abort(exec.signal.reason) }
          exec.signal.addEventListener('abort', abort, { once: true })
          let stream: McpSubscription
          try {
            stream = await client.listen({ resourceSubscriptions: [uri] }, {
              signal: opening.signal, ...options.timeout === undefined ? {} : { timeout: options.timeout },
            })
          } finally {
            exec.signal.removeEventListener('abort', abort)
          }
          next.stream = stream
          void stream.closed.then(() => {
            if (subscriptions.get(uri) === next) subscriptions.delete(uri)
          })
          if (exec.signal.aborted) {
            await stream.close()
            exec.signal.throwIfAborted()
          }
        } else {
          await client.subscribeResource({ uri }, options)
        }
        next.pending = false
        return { subscribed: true, updates: next.updates }
      } catch (error) {
        subscriptions.delete(uri)
        throw error
      }
    },
  }
}
