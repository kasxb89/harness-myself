import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { expandAssistantStream, type LlmFailure } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { openTurnClosers } from '../../../core/session/src/repair.ts'
import { isSessionFormatJsonObject, type SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '../src/index.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/text-reselection-v4.json', import.meta.url), 'utf8')) as {
  header: { type: 'session'; version: number; id: string; createdAt: number; isSeeded: false; delegationDepth: number }
  legacy: SessionFormatEvent[]
  zeroSend: SessionFormatEvent[]
}

afterEach(() => { vi.unstubAllGlobals() })

describe('optional text-reselection metadata in V4 failure records', () => {
  it.each(['legacy', 'zeroSend'] as const)('restores %s records without truncation, message changes, synthetic retry, or network I/O', (kind) => {
    const network = vi.fn(() => { throw new Error('Restoration must not dispatch a request') })
    vi.stubGlobal('fetch', network)
    const events = fixture[kind]
    const reader = sessionFormatCatalog.createRestore(fixture.header, { recovery: 'strict', validation: 'current' })
    for (const event of events) reader.decodeRow(JSON.parse(JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(event))))
    const artifact = reader.finish()
    expect(artifact.events).toEqual(events)
    expect(artifact.inheritedEventCount).toBe(0)
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: SessionId(artifact.header.id),
      createdAt: artifact.header.createdAt,
      isSeeded: false,
      delegationDepth: 0,
    }
    const session = Session.fromRestore(header.id, artifact.events as SessionEvent[], header, SessionLogOffset(0), 'detached')
    const restored = session.snapshotEvents()
    expect(restored.slice(0, events.length)).toEqual(events)
    expect(restored[events.length]?.time).toEqual(expect.any(Number))
    expect(restored.slice(events.length).map(({ time: _time, ...event }) => event)).toEqual([
      { type: 'session/end-seed', seq: events.length, data: {} },
    ])
    expect(session.deriveMessages().map(message => ({ role: message.role, content: message.content }))).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'A synthetic restoration-only request.' }] },
    ])
    expect(openTurnClosers(session.snapshotEvents(), { kind: 'interrupted' })).toEqual([])
    const failures = artifact.events.flatMap<Pick<LlmFailure, 'code' | 'message'> & { textReselection?: unknown }>((event) => {
      if (event.type === 'assistant/attempt' || event.type === 'assistant/message') {
        const typed = event as SessionEvent<'assistant/attempt' | 'assistant/message'>
        return expandAssistantStream(typed.data.stream).flatMap(({ chunk }) => chunk.type === 'finish'
          && chunk.reason.kind === 'error' ? [chunk.reason.failure] : [])
      }
      if (event.type === 'llm/retry') {
        const failure = isSessionFormatJsonObject(event.data) ? event.data['failure'] : undefined
        if (!isSessionFormatJsonObject(failure) || typeof failure['code'] !== 'string' || typeof failure['message'] !== 'string') {
          throw new Error('Expected persisted retry failure code and message')
        }
        return [{ ...failure, code: failure['code'], message: failure['message'] }]
      }
      if (event.type === 'turn/end') return [(event as SessionEvent<'turn/end'>).data.reason]
        .flatMap(reason => reason.kind === 'error' ? [reason.error] : [])
      return []
    })
    expect(failures).toHaveLength(4)
    for (const failure of failures) {
      expect(failure).toMatchObject({ code: 'MODEL_ROUTE_UNAVAILABLE', message: 'Selected text model is temporarily unavailable.' })
      if (kind === 'zeroSend') expect(failure.textReselection).toMatchObject({ submissionState: 'not_submitted', upstreamSubmitted: false, billingReserved: false })
      else expect(failure).not.toHaveProperty('textReselection')
    }
    expect(network).not.toHaveBeenCalled()
  })
})
