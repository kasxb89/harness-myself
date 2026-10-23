import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { CreativeOperation, CreativeOperationId } from '../src/creative-store.ts'
import type { CreativeProjectId } from '../src/creative-types.ts'
import type { CreationActivityOutcome, CreationActivityStage, VideoProjectActivity } from '../src/creation-activity.ts'
import type { GenerationActivityLease, GenerationActivityReporter, GenerationActivityTask } from '../src/generation-activity.ts'
import { GenerationActivityCreation, type GenerationCreationAccount } from '../src/generation-activity-creation.ts'

const uuid = (index: number): string => `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
const projectId = `cp_${uuid(90)}` as CreativeProjectId
const videoId = `vp_${uuid(80)}`
const account: GenerationCreationAccount = { epoch: 'epoch-a', accountId: 'account-a', sessionFingerprint: 'fingerprint-a' }
function operation(index = 1, identity = account, sessionId = 'child-chat'): CreativeOperation {
  return { projectId, operationId: `op_${uuid(index)}` as CreativeOperationId,
    owner: { accountId: identity.accountId, sessionFingerprint: identity.sessionFingerprint, sessionId,
      workspaceRoot: '/private/customer/workspace' } }
}
function projectStage(source: CreativeOperation, stage: CreationActivityStage, shotId?: string, attemptId?: string): VideoProjectActivity {
  return { type: 'stage', stage, projectId: videoId, ownerSessionId: source.owner.sessionId,
    accountId: source.owner.accountId, sessionFingerprint: source.owner.sessionFingerprint,
    ...shotId === undefined ? {} : { shotId }, ...attemptId === undefined ? {} : { attemptId } }
}
function projectEnd(source: CreativeOperation, stage: CreationActivityStage, outcome: CreationActivityOutcome,
  shotId?: string, attemptId?: string): VideoProjectActivity {
  return { ...projectStage(source, stage, shotId, attemptId), type: 'end', outcome }
}

interface RecordedTask {
  readonly epoch: string
  readonly input: GenerationActivityTask
  readonly phases: CreationActivityStage[]
  readonly outcomes: (CreationActivityOutcome | undefined)[]
  ended: boolean
}
function fixture() {
  let current: GenerationCreationAccount | undefined = account
  let lookupThrows = false
  let rootThrows = false
  const tasks: RecordedTask[] = []
  const untracked: { epoch: string; outcomes: CreationActivityOutcome[] }[] = []
  const unavailable = vi.fn()
  const observeTask = vi.fn((epoch: string, input: GenerationActivityTask): GenerationActivityLease => {
    const row: RecordedTask = { epoch, input, phases: [input.stage], outcomes: [], ended: false }
    tasks.push(row)
    return { update: stage => row.phases.push(stage), end: (outcome) => {
      row.outcomes.push(outcome)
      row.ended = true
    } }
  })
  const observeUntrackedMedia = vi.fn((epoch: string) => {
    const row = { epoch, outcomes: [] as CreationActivityOutcome[] }
    untracked.push(row)
    return (outcome: CreationActivityOutcome): void => { row.outcomes.push(outcome) }
  })
  const reporter: Pick<GenerationActivityReporter, 'observeTask' | 'observeUntrackedMedia'> = { observeTask, observeUntrackedMedia }
  const bridge = new GenerationActivityCreation({ reporter, unavailable,
    current: () => { if (lookupThrows) throw new Error('Private account lookup error'); return current },
    rootSession: (raw) => {
      if (rootThrows) throw new Error('Private root lookup error')
      return raw === 'unresolved-chat' ? undefined : SessionId('root-chat')
    } })
  const activate = (source: CreativeOperation, kind: 'image' | 'video' = 'video', project?: string): void => {
    bridge.operation({ operation: source, kind, active: true, ...project === undefined ? {} : { videoProjectId: project } })
  }
  const release = (source: CreativeOperation, kind: 'image' | 'video' = 'video'): void => {
    bridge.operation({ operation: source, kind, active: false })
  }
  return { bridge, tasks, untracked, observeTask, observeUntrackedMedia, unavailable, activate, release,
    setCurrent(value: GenerationCreationAccount | undefined) { current = value; bridge.refresh() },
    failLookup(value: boolean) { lookupThrows = value }, failRoot(value: boolean) { rootThrows = value } }
}

describe('Creation activity project and attempt attribution', () => {
  it('keeps one actual chat and project across eight distinct durable clip attempts and local editing', () => {
    const f = fixture()
    const source = operation()
    f.activate(source, 'video', videoId)
    f.activate(source, 'video', videoId)
    f.bridge.project(projectStage(source, 'preparing'))
    for (let index = 1; index <= 8; index += 1) {
      for (const stage of ['preparing', 'accepted', 'queued', 'generating', 'saving'] as const) {
        f.bridge.project(projectStage(source, stage, String(index), uuid(index)))
      }
      f.bridge.project(projectEnd(source, 'saving', 'completed', String(index), uuid(index)))
    }
    f.bridge.project(projectStage(source, 'editing'))
    const attempts = f.tasks.filter(row => row.input.attemptId !== undefined)
    const parents = f.tasks.filter(row => row.input.attemptId === undefined)
    expect(attempts).toHaveLength(8)
    expect(parents).toHaveLength(1)
    expect(new Set(f.tasks.map(row => row.input.projectId))).toEqual(new Set([projectId]))
    expect(new Set(f.tasks.map(row => row.input.sessionId))).toEqual(new Set([SessionId('root-chat')]))
    expect(new Set(attempts.map(row => row.input.attemptId)).size).toBe(8)
    for (const row of attempts) {
      expect(row.phases).toEqual(['preparing', 'accepted', 'queued', 'generating', 'saving'])
      expect(row.outcomes).toEqual(['completed'])
    }
    expect(parents[0]?.phases).toEqual(['preparing', 'editing'])
    expect(parents[0]?.ended).toBe(false)
    f.bridge.project(projectEnd(source, 'editing', 'completed'))
    f.release(source)
    expect(parents[0]?.outcomes).toEqual(['completed'])
    expect(JSON.stringify(f.tasks.map(row => row.input))).not.toContain('/private/customer')
    f.bridge.dispose()
    expect(f.tasks.every(row => row.outcomes.length === 1)).toBe(true)
  })

  it.each(['image', 'video'] as const)('retains one %s attempt across explicit same-account recovery and preserves unknown outcomes', (kind) => {
    const f = fixture()
    const source = operation()
    f.activate(source, kind)
    const original = f.bridge.task(source, kind)
    original({ type: 'stage', stage: 'accepted' })
    original({ type: 'end', stage: 'unknown', outcome: 'unknown' })
    f.release(source, kind)
    const recovered = { ...source, owner: { ...source.owner } }
    f.activate(recovered, kind)
    const resumed = f.bridge.task(recovered, kind)
    resumed({ type: 'stage', stage: 'accepted' })
    original({ type: 'stage', stage: 'generating' })
    f.release(source, kind)
    resumed({ type: 'stage', stage: 'saving' })
    resumed({ type: 'end', stage: 'saving', outcome: 'completed' })
    f.release(recovered, kind)
    const attempts = f.tasks.filter(row => row.input.attemptId !== undefined)
    expect(attempts).toHaveLength(2)
    expect(attempts.map(row => row.input.attemptId)).toEqual([uuid(1), uuid(1)])
    expect(attempts.map(row => row.outcomes)).toEqual([['unknown'], ['completed']])
    expect(attempts[0]?.phases).toEqual(['accepted', 'unknown'])
    expect(attempts[1]?.phases).toEqual(['accepted', 'saving'])
    expect(f.tasks.every(row => row.input.projectId === source.projectId)).toBe(true)
    expect(f.tasks.every(row => row.ended)).toBe(true)
    f.bridge.dispose()
  })

  it('keeps the same clip attempt and true creation project across local project resume', () => {
    const f = fixture()
    const source = operation()
    f.activate(source, 'video', videoId)
    f.bridge.project(projectStage(source, 'generating', '1', uuid(10)))
    f.bridge.project(projectEnd(source, 'unknown', 'unknown', '1', uuid(10)))
    f.bridge.project(projectEnd(source, 'unknown', 'unknown'))
    const resumed = { ...source, owner: { ...source.owner } }
    f.activate(resumed, 'video', videoId)
    f.bridge.project(projectStage(resumed, 'accepted', '1', uuid(10)))
    f.bridge.project(projectEnd(resumed, 'saving', 'completed', '1', uuid(10)))
    f.bridge.project(projectEnd(resumed, 'editing', 'completed'))
    expect(f.tasks.filter(row => row.input.attemptId !== undefined).map(row => row.input.attemptId))
      .toEqual([uuid(10), uuid(10)])
    expect(f.tasks.every(row => row.input.projectId === projectId)).toBe(true)
    expect(f.tasks.every(row => row.ended)).toBe(true)
    f.bridge.dispose()
  })

  it('omits a chat association when no true runtime root exists', () => {
    const f = fixture()
    const source = operation(1, account, 'unresolved-chat')
    f.activate(source, 'image')
    const observe = f.bridge.task(source, 'image')
    observe({ type: 'stage', stage: 'generating' })
    expect(f.tasks).toHaveLength(2)
    expect(f.tasks.every(row => !Object.hasOwn(row.input, 'sessionId'))).toBe(true)
    observe({ type: 'end', stage: 'saving', outcome: 'completed' })
    f.release(source, 'image')
    f.bridge.dispose()
  })

  it('does not invent a project or attempt for independent media and forwards an unknown untracked end', () => {
    const f = fixture()
    const observe = f.bridge.task(undefined, 'image')
    observe({ type: 'stage', stage: 'submitting' })
    observe({ type: 'end', stage: 'unknown', outcome: 'unknown' })
    observe({ type: 'stage', stage: 'generating' })
    expect(f.tasks).toEqual([])
    expect(f.untracked).toEqual([{ epoch: account.epoch, outcomes: ['unknown'] }])
    f.bridge.dispose()
  })

  it('marks a missing clip attempt and old non-UUID operation as untracked without adding a fake parent task', () => {
    const f = fixture()
    const source = operation()
    f.activate(source, 'video', videoId)
    f.bridge.project(projectStage(source, 'accepted', '1'))
    f.bridge.project(projectEnd(source, 'unknown', 'unknown', '1'))
    f.bridge.project(projectEnd(source, 'unknown', 'unknown'))
    const legacy = { ...operation(2), operationId: 'op_old_identifier' as CreativeOperationId }
    f.activate(legacy, 'image')
    const observe = f.bridge.task(legacy, 'image')
    observe({ type: 'stage', stage: 'accepted' })
    observe({ type: 'end', stage: 'saving', outcome: 'completed' })
    f.release(legacy, 'image')
    expect(f.tasks).toHaveLength(2)
    expect(f.tasks.every(row => row.input.attemptId === undefined && row.input.projectId === projectId)).toBe(true)
    expect(f.untracked.map(row => row.outcomes)).toEqual([['unknown'], ['completed']])
    expect(f.unavailable).toHaveBeenCalledOnce()
    f.bridge.dispose()
  })
})

describe('Creation activity ownership and disposal', () => {
  it('ignores old-account and closed-operation callbacks while a new login resumes the same original operation', () => {
    const f = fixture()
    const source = operation()
    f.activate(source, 'video', videoId)
    const observe = f.bridge.task(source, 'video')
    observe({ type: 'stage', stage: 'accepted' })
    const next = { ...account, epoch: 'epoch-b', sessionFingerprint: 'fingerprint-b' }
    f.setCurrent(next)
    const count = f.tasks.length
    observe({ type: 'stage', stage: 'generating' })
    f.activate(source, 'video', videoId)
    f.bridge.project(projectStage(source, 'generating', '1', uuid(10)))
    expect(f.tasks).toHaveLength(count)
    const recovered = operation(1, next)
    f.activate(recovered, 'video', videoId)
    f.release(source)
    f.bridge.project(projectStage(recovered, 'generating', '1', uuid(10)))
    expect(f.tasks.at(-1)).toMatchObject({ epoch: 'epoch-b', ended: false, input: { attemptId: uuid(10) } })
    f.bridge.dispose()
    expect(f.tasks.every(row => row.ended)).toBe(true)
  })

  it('fences a changed epoch even when account and login fingerprint are unchanged', () => {
    const f = fixture()
    const source = operation()
    f.activate(source, 'video', videoId)
    f.setCurrent({ ...account, epoch: 'new-runtime-epoch' })
    f.activate(source, 'video', videoId)
    f.bridge.project(projectStage(source, 'preparing'))
    expect(f.tasks).toHaveLength(1)
    expect(f.tasks[0]?.ended).toBe(true)
    f.bridge.dispose()
  })

  it('ends every observer once on disposal and never reopens a late task or project', () => {
    const f = fixture()
    const source = operation()
    f.activate(source, 'video', videoId)
    const observe = f.bridge.task(undefined, 'image')
    observe({ type: 'stage', stage: 'submitting' })
    f.bridge.project(projectStage(source, 'generating', '1', uuid(10)))
    f.bridge.dispose()
    f.bridge.dispose()
    observe({ type: 'end', stage: 'saving', outcome: 'completed' })
    f.bridge.project(projectStage(source, 'generating', '2', uuid(11)))
    f.activate(operation(2), 'video', videoId)
    f.bridge.task(operation(2), 'video')({ type: 'stage', stage: 'generating' })
    expect(f.tasks).toHaveLength(2)
    expect(f.tasks.map(row => row.outcomes)).toEqual([['stopped'], ['unknown']])
    expect(f.untracked).toEqual([{ epoch: account.epoch, outcomes: ['unknown'] }])
  })

  it('contains account, root and reporter errors without losing existing ownership', () => {
    const f = fixture()
    const source = operation()
    f.activate(source, 'image')
    f.failLookup(true)
    expect(() => { f.bridge.refresh() }).not.toThrow()
    expect(f.tasks[0]?.ended).toBe(false)
    expect(() => { f.bridge.task(source, 'image')({ type: 'stage', stage: 'generating' }) }).not.toThrow()
    f.failLookup(false)
    f.failRoot(true)
    expect(() => { f.activate(operation(2), 'image') }).not.toThrow()
    f.failRoot(false)
    f.observeTask.mockImplementationOnce(() => { throw new Error('private observer detail') })
    expect(() => { f.activate(operation(3), 'image') }).not.toThrow()
    expect(f.unavailable).toHaveBeenCalledOnce()
    f.release(source, 'image')
    expect(f.tasks[0]?.ended).toBe(true)
    f.bridge.dispose()
  })

  it('does not attribute signed-out media to a new account', () => {
    const f = fixture()
    f.setCurrent(undefined)
    f.activate(operation(), 'image')
    f.bridge.task(undefined, 'image')({ type: 'stage', stage: 'generating' })
    f.bridge.project(projectStage(operation(), 'generating', '1', uuid(10)))
    expect(f.tasks).toEqual([])
    expect(f.untracked).toEqual([])
    f.bridge.dispose()
  })
})
