/** Artifact focus resolves only inside the explicitly recorded generating Turn. */
import { expect, it } from 'vitest'
import type { StartedToolCall } from '../src/client/contract/snapshot.ts'
import { artifactFocus, artifactFocusNode } from '../src/client/chat/artifact-focus.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'

it('selects the exact generating tool and refuses another Turn or missing tool', () => {
  const call = (callId: string, turn: number): StartedToolCall => ({ phase: 'start', args: PartialArguments.fromText('{}'),
    callId, name: 'generate_image', argsRaw: '{}', turn, step: 1, time: 1, subCalls: [] })
  const snapshot = chatSnapshotFixture({ runningCalls: [call('first', 1), call('source', 2)] })
  const focus = artifactFocus('artifact:{"turn":2,"toolCallId":"source"}')!
  const node = artifactFocusNode(focus, snapshot)
  expect(node?.kind).toBe('tool-call')
  if (node?.kind !== 'tool-call') throw new Error('Expected generating tool card')
  expect(node.data.root.callId).toBe('source')
  expect(artifactFocusNode({ turn: 1, toolCallId: 'source' }, snapshot)).toBeUndefined()
  expect(artifactFocusNode({ turn: 2, toolCallId: 'missing' }, snapshot)).toBeUndefined()
})

it('refuses malformed and unrelated View focus requests', () => {
  for (const focus of ['source', 'artifact:broken', 'artifact:null', 'artifact:{"turn":-1}',
    'artifact:{"turn":1,"eventSeq":1.5}', 'artifact:{"turn":1,"toolCallId":""}']) expect(artifactFocus(focus)).toBeUndefined()
  expect(artifactFocus('artifact:{"turn":2,"eventSeq":12}')).toEqual({ turn: 2, eventSeq: 12 })
})
