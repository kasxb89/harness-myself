import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryImageSubmission, readImageSubmission, submissionFromAnswer, type ImageSubmission } from '../src/client/image-submission.ts'

const owner = { accountId: 'account-a', sessionId: 'session-a' }
const retained: ImageSubmission = { ...owner, state: 'unknown', planId: 'cp_original', operationId: 'op_original',
  taskId: 'task_original', requestId: 'request_original', canQuery: true }
const signal = (): AbortSignal => new AbortController().signal
function listing(status = 'unknown', canQuery = true): object {
  return { ok: true, payload: { accountId: owner.accountId, projects: [{ id: 'cp_original', sessionId: owner.sessionId,
    kind: 'image', tasks: [{ id: 'op_original', status, canQuery,
      imageReceipt: { taskId: 'task_original', requestId: 'request_original' } }] }] } }
}
afterEach(() => { vi.unstubAllGlobals() })

describe('retained image submission', () => {
  it.each([{}, { path: '' }])('retains malformed successful replies until the original saved output is confirmed', (payload) => {
    expect(submissionFromAnswer({ ok: true, submission_state: 'completed', payload,
      plan_id: 'cp_original', operation_id: 'op_original' }, owner)).toEqual({ ...owner,
      state: 'unknown', canQuery: false, planId: 'cp_original', operationId: 'op_original' })
  })

  it.each(['pending', 'unknown'])('captures %s receipt coordinates without enabling an unadmitted query', (submission_state) => {
    expect(submissionFromAnswer({ submission_state, plan_id: 'cp_original', operation_id: 'op_original',
      task_id: 'task_original', request_id: 'request_original' }, owner)).toEqual({ ...retained, state: submission_state, canQuery: false })
  })
  it.each(['not-submitted', 'failed', 'completed'])('releases explicit %s outcomes', (submission_state) => {
    expect(submissionFromAnswer({ submission_state, code: 'TRANSPORT' }, owner)).toBeNull()
  })
  it('retains legacy ambiguous outcomes while excluding credential-shaped or malformed identifiers', () => {
    expect(submissionFromAnswer({ code: 'TRANSPORT', task_id: 'sk-private', request_id: 'line\nbreak' }, owner))
      .toEqual({ ...owner, state: 'unknown', canQuery: false })
  })
  it('restores the owned pending task from the Host after the view draft was lost', async () => {
    const fetch = vi.fn(async () => Response.json(listing()))
    vi.stubGlobal('fetch', fetch)
    const abort = signal()
    expect(await readImageSubmission(owner, null, abort)).toEqual({ ok: true, submission: retained, completed: false })
    expect(fetch).toHaveBeenCalledWith('/credits/api/creative/projects?session_id=session-a', expect.objectContaining({
      credentials: 'same-origin', cache: 'no-store', signal: abort,
    }))
  })
  it('preserves an original lock when its record is missing or not terminal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, payload: { accountId: owner.accountId, projects: [] } })))
    expect(await readImageSubmission(owner, retained, signal())).toEqual({ ok: true, submission: retained, completed: false })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(listing('planned', false))))
    expect(await readImageSubmission(owner, retained, signal())).toEqual({ ok: true, submission: retained, completed: false })
  })
  it('does not recover a paid-submission lock from an interrupted task without any submission receipt', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, payload: { accountId: owner.accountId, projects: [{
      id: 'cp_original', sessionId: owner.sessionId, kind: 'image', tasks: [{ id: 'op_original', status: 'interrupted' }],
    }] } })))
    expect(await readImageSubmission(owner, null, signal())).toEqual({ ok: true, submission: null, completed: false })
    expect(await readImageSubmission(owner, { ...owner, state: 'pending', planId: 'cp_original', operationId: 'op_original', canQuery: false }, signal()))
      .toEqual({ ok: true, submission: null, completed: false })
  })
  it('keeps an interrupted original task protected when its submission receipt exists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(listing('interrupted'))))
    expect(await readImageSubmission(owner, retained, signal())).toEqual({ ok: true, submission: retained, completed: false })
  })
  it.each(['completed', 'failed', 'cancelled'])('clears a matched original task only at %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(listing(status, false))))
    expect(await readImageSubmission(owner, retained, signal())).toEqual({ ok: true, submission: null, completed: status === 'completed' })
  })
  it('rejects another account or conversation rather than releasing the retained task', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(listing())))
    expect(await readImageSubmission({ ...owner, accountId: 'account-b' }, retained, signal())).toEqual({ ok: false })
    expect(await readImageSubmission({ ...owner, sessionId: 'session-b' }, retained, signal())).toEqual({ ok: false })
  })
  it('queries only the original three coordinates and follows the accepted active state', async () => {
    const fetch = vi.fn(async () => Response.json(listing('running', false), { status: 202 }))
    vi.stubGlobal('fetch', fetch)
    const abort = signal()
    expect(await queryImageSubmission(retained, abort)).toEqual({ ok: true,
      submission: { ...retained, state: 'pending', canQuery: false }, completed: false })
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/credits/api/creative/image/recover', expect.objectContaining({
      method: 'POST', signal: abort, body: JSON.stringify({ session_id: owner.sessionId, project_id: retained.planId, operation_id: retained.operationId }),
    }))
  })
  it('never queries an unadmitted or unidentifiable task, and never retries a rejected query', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 409 }))
    vi.stubGlobal('fetch', fetch)
    expect(await queryImageSubmission({ ...retained, canQuery: false }, signal())).toEqual({ ok: false })
    expect(fetch).not.toHaveBeenCalled()
    expect(await queryImageSubmission(retained, signal())).toEqual({ ok: false })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
