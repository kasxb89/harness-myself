import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { createQuotaNotices, toolBackgroundJob, toolBalanceNotice } from '../src/client/quota-notices.ts'

it('requires the current login owner, deduplicates submissions and releases its guard', () => {
  const publish = vi.fn(() => true)
  const notices = createQuotaNotices(publish)
  expect(notices.publishBalance({ scope: 'a', key: 'work' })).toBe(false)
  let current = 'a'
  const release = notices.registerBalanceScope(scope => scope === current)
  expect(notices.publishBalance({ scope: '', key: 'work' })).toBe(false)
  expect(notices.publishBalance({ scope: 'a', key: '' })).toBe(false)
  expect(notices.publishBalance({ scope: 'a', key: 'work' })).toBe(true)
  expect(notices.publishBalance({ scope: 'a', key: 'work' })).toBe(false)
  current = 'b'
  expect(notices.publishBalance({ scope: 'a', key: 'other' })).toBe(false)
  expect(notices.publishBalance({ scope: 'b', key: 'work' })).toBe(true)
  release()
  expect(notices.publishBalance({ scope: 'b', key: 'other' })).toBe(false)
  expect(publish.mock.calls).toEqual([['a'], ['b']])
})

function result(text: string): SessionEvent<'tool/result'> {
  return { type: 'tool/result', seq: SessionSeq(1), time: 1, surfaceOp: 'append', data: { turn: 1, step: 1,
    message: createToolResultMessage({ callId: ToolCallId('call'), isError: false, content: [{ type: 'text', text }] }),
  } }
}

it.each(['job_id', 'work_id', 'work_request_id', 'operation_id', 'submission_id', 'request_id'])(
  'uses the stable %s identity in a named producer result', (field) => {
    const event = result(JSON.stringify({ [field]: 'stable', actionRequired: { code: 'INSUFFICIENT_BALANCE', scope: 'a' } }))
    expect(toolBalanceNotice(event, 'generate_video', 'session')).toEqual({ scope: 'a',
      key: `${field === 'job_id' ? 'job' : 'submission'}:stable` })
  },
)

it('uses the call identity only when no stable work identity exists', () => {
  const event = result(JSON.stringify({ work_id: '', actionRequired: { code: 'INSUFFICIENT_BALANCE', scope: 'a' } }))
  expect(toolBalanceNotice(event, 'generate_image', 'session')).toEqual({ scope: 'a', key: 'tool:session:call' })
})

it.each(['not JSON', 'null', '[]', '{}', '{"code":"INSUFFICIENT_BALANCE"}',
  '{"actionRequired":{"code":"NETWORK","scope":"a"}}', '{"actionRequired":{"code":"INSUFFICIENT_BALANCE"}}'])(
  'does not turn malformed, unscoped or unrelated data into a balance action: %s', (text) => {
    expect(toolBalanceNotice(result(text), 'generate_video', 'session')).toBeUndefined()
  },
)

it('rejects same-shaped JSON from an unrelated tool or an unnamed result', () => {
  const event = result('{"actionRequired":{"code":"INSUFFICIENT_BALANCE","scope":"a"}}')
  expect(toolBalanceNotice(event, 'run_code', 'session')).toBeUndefined()
  expect(toolBalanceNotice(event, undefined, 'session')).toBeUndefined()
})


it('correlates only explicit named media background acknowledgements', () => {
  const started = result('{"status":"background","job_id":"video-project-1"}')
  expect(toolBackgroundJob(started, 'generate_video_project')).toBe('video-project-1')
  expect(toolBackgroundJob(started, 'resume_video_project')).toBe('video-project-1')
  expect(toolBackgroundJob(started, 'run_code')).toBeUndefined()
  expect(toolBackgroundJob(result('not JSON'), 'generate_video_project')).toBeUndefined()
  expect(toolBackgroundJob(result('{"status":"failed","job_id":"old"}'), 'generate_video_project')).toBeUndefined()
})


it('recognizes a nested PTC background acknowledgement from its own name and content', () => {
  const event: SessionEvent<'tool/ptc-dispatch'> = { type: 'tool/ptc-dispatch', seq: SessionSeq(1), time: 1,
    data: { rootCallId: ToolCallId('outer'), parentCallId: ToolCallId('outer'), subCallId: ToolCallId('inner'),
      name: 'generate_video_project', arguments: {}, isError: false, content: [{ type: 'text',
        text: '{"status":"background","job_id":"video-project-1"}' }] } }
  expect(toolBackgroundJob(event, 'run_code')).toBe('video-project-1')
})
