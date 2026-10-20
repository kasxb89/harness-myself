// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type {
  AssistantMessageNode, ChatSnapshot, LegacyConversationSlice, ToolResultNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { ActivityPill, deriveStats, formatDuration, type StatPillProps } from '../src/client/chat/StatsPills.tsx'
import { en, zh } from '../src/client/locale.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

const t: StatPillProps['t'] = makeTranslate(zh, commonZh)
const tEn: StatPillProps['t'] = makeTranslate(en, commonEn)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const assistant = (seq: number, turn: number, usage?: unknown): AssistantMessageNode => ({
  kind: 'assistant', seq, time: seq * 1_000, turn, step: seq, blocks: [{ kind: 'text', text: `t${seq}` }],
  ...(usage === undefined ? {} : { usage }),
})

type ChatUpdate = Partial<LegacyConversationSlice>

function makeSource(init: ChatUpdate = {}) {
  let snap = chatSnapshotFixture(init)
  const subs = new Set<() => void>()
  return {
    set: (next: ChatUpdate) => {
      snap = chatSnapshotFixture({ ...snap.legacy, ...next }, snap)
      for (const fn of [...subs]) fn()
    },
    source: {
      getSnapshot: () => snap,
      subscribe: (fn: () => void) => {
        subs.add(fn)
        return () => subs.delete(fn)
      },
    },
  }
}

describe('deriveStats', () => {
  it('counts turns and steps and never folds node usage into accounting', () => {
    const stats = deriveStats([
      assistant(1, 1, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 }),
      assistant(2, 1, { inputTokens: 100, outputTokens: 50 }),
      assistant(3, 2),
    ])
    expect(stats.turns).toBe(2)
    expect(stats.steps).toBe(3)
    // The window fold's counts are only the fallback for assemblies without
    // the sessionStats projection; the paged window is not an accounting
    // source either, so the fold exposes no billing fields (billing rides the
    // tokenUsage projection); decodeTokens is a throughput input, not a
    // billed total.
    expect(Object.keys(stats).sort()).toEqual(
      ['decodeMs', 'decodeTokens', 'llmMs', 'steps', 'toolMs', 'ttftMs', 'ttftSteps', 'turns'],
    )
  })

  it('ignores tool results with no call time', () => {
    const tool: ToolResultNode = {
      kind: 'tool-result', seq: 5, time: 5_000, callId: 'c', call: null, callTime: null, content: [],
      name: '', args: PartialArguments.EMPTY,
      isError: false, subCalls: [],
    }
    const stats = deriveStats([tool, assistant(1, 1)])
    expect(stats.steps).toBe(1)
    expect(stats.toolMs).toBe(0)
  })

  it('sums LLM wall time from assistant timing and tool wall time from call/result pairs', () => {
    const timed: AssistantMessageNode = {
      ...assistant(1, 1),
      timing: { stepStartTime: 1_000, firstTokenTime: 1_200, completedTime: 3_500 },
    }
    const untimed: AssistantMessageNode = {
      ...assistant(2, 1),
      timing: { stepStartTime: null, firstTokenTime: null, completedTime: 9_000 },
    }
    const tool: ToolResultNode = {
      kind: 'tool-result', seq: 5, time: 7_000, callId: 'c', call: null, callTime: 4_000, content: [],
      name: '', args: PartialArguments.EMPTY,
      isError: false, subCalls: [],
    }
    const stats = deriveStats([timed, untimed, tool])
    expect(stats.llmMs).toBe(2_500)
    expect(stats.toolMs).toBe(3_000)
  })

  it('sums ttft per recorded step and decode throughput inputs per usage-carrying step', () => {
    const sampled: AssistantMessageNode = {
      ...assistant(1, 1, { outputTokens: 40 }),
      timing: { stepStartTime: 1_000, firstTokenTime: 1_800, completedTime: 4_800 },
    }
    const ttftOnly: AssistantMessageNode = {
      ...assistant(2, 1),
      timing: { stepStartTime: 5_000, firstTokenTime: 5_400, completedTime: 7_400 },
    }
    const stats = deriveStats([sampled, ttftOnly, assistant(3, 2)])
    expect(stats.ttftMs).toBe(1_200)
    expect(stats.ttftSteps).toBe(2)
    // The usage-less step contributes no decode share, keeping the ratio honest.
    expect(stats.decodeMs).toBe(3_000)
    expect(stats.decodeTokens).toBe(40)
  })
})

describe('formatters', () => {
  it('formats durations under and over a minute', () => {
    expect(formatDuration(45_230, tEn)).toBe('45.2s')
    expect(formatDuration(162_000, tEn)).toBe('2m42s')
  })
})

describe('composer activity presentation', () => {
  const timedStep = (): AssistantMessageNode => ({
    ...assistant(1, 1, { outputTokens: 60 }),
    timing: { stepStartTime: 1_000, firstTokenTime: 1_800, completedTime: 4_800 },
  })

  function props(source: { getSnapshot(): ChatSnapshot; subscribe(fn: () => void): () => void },
    values: Record<string, unknown> = {}, mode: 'compact' | 'detailed' = 'detailed'): StatPillProps {
    return { usePerformanceUsage: selector => selector(mode), useChat: bindSnapshotSelector(source),
      useProjection: (key: string) => values[key], t: tEn }
  }

  it.each(['compact', 'detailed'] as const)('retains counts without token figures in %s mode', (mode) => {
    const { source } = makeSource({ nodes: [timedStep()] })
    const view = render(<ActivityPill {...props(source, {
      tokenUsage: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 0 },
    }, mode)} />)
    expect(view.container.textContent).toBe('1 turns 1 steps')
    expect(view.container.textContent).not.toMatch(/tok|cache|credits/iu)
    expect(view.queryByRole('button') !== null).toBe(mode === 'detailed')
  })

  it('shows observed response and tool times without throughput or spending estimates', () => {
    const { source } = makeSource({ nodes: [timedStep()] })
    const view = render(<ActivityPill {...props(source, { sessionStats: {
      turns: 12, steps: 20, llmMs: 8_000, toolMs: 2_000, ttftMs: 1_600, ttftSteps: 2,
      decodeMs: 3_000, decodeTokens: 60,
    } })} />)
    fireEvent.click(view.getByRole('button', { name: '12 turns 20 steps' }))
    const dialog = view.getByRole('dialog')
    expect(dialog.textContent).toContain('LLM time8s')
    expect(dialog.textContent).toContain('Tool time2s')
    expect(dialog.textContent).toContain('Average first response0.8s')
    expect(dialog.textContent).not.toMatch(/tok|cache|credits|20 tok/iu)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('dialog')).toBeNull()
    fireEvent.click(view.getByRole('button'))
    fireEvent.pointerDown(document.body)
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('does not turn a zero-step or untimed session into an empty dialog', () => {
    const source = makeSource({ nodes: [] })
    const view = render(<ActivityPill {...props(source.source)} />)
    expect(view.container.textContent).toBe('')
    act(() => { source.set({ nodes: [assistant(1, 1)] }) })
    expect(view.container.textContent).toBe('1 turns 1 steps')
    expect(view.queryByRole('button')).toBeNull()
  })

  it('localizes first response and keeps the current dialog dismissible after mode changes', () => {
    const { source } = makeSource({ nodes: [timedStep()] })
    const detailed = { ...props(source), t }
    const view = render(<ActivityPill {...detailed} />)
    fireEvent.click(view.getByRole('button', { name: '1 轮 1 步' }))
    expect(view.getByRole('dialog').textContent).toContain('平均首次响应0.8秒')
    expect(view.getByRole('dialog').textContent).not.toMatch(/token|tok\/s|积分/u)
    view.rerender(<ActivityPill {...detailed} usePerformanceUsage={selector => selector('compact')} />)
    expect(view.queryByRole('dialog')).toBeNull()
    expect(view.container.textContent).toBe('1 轮 1 步')
  })
})
