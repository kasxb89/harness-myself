import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { JobsSnapshot } from '@deepseek-ai/dsh-api-job-controller/client'
import type { JobView } from '@deepseek-ai/dsh-jobs/view'
import { JobId } from '@deepseek-ai/dsh-jobs/brand'
import { expect, it, vi } from 'vitest'
import { createQuotaNotices } from '@deepseek-ai/dsh-client-ui-chat/src/client/quota-notices.ts'
import { watchBalanceFailures } from '../src/client/balance-watch.ts'

function job(status: JobView['status'], actionRequired?: JobView['actionRequired']): JobView {
  return { id: JobId('video-project-1'), kind: 'video-project', label: 'video', status, startedAt: 1,
    output: { total: 0, earliest: 0 }, ...actionRequired === undefined ? {} : { actionRequired } }
}

it.each(['running', 'stopping'] as const)('announces a live %s balance job once without replaying failed history', (active) => {
  const action = { code: 'INSUFFICIENT_BALANCE', scope: 'owner-a' }
  const source = createSnapshotStore<JobsSnapshot>({ rows: { session: [job('failed', action)] }, observed: {} })
  const publish = vi.fn(() => true)
  const notices = createQuotaNotices(publish)
  notices.registerBalanceScope(scope => scope === 'owner-a')
  const release = watchBalanceFailures(source, notices)
  expect(publish).not.toHaveBeenCalled()
  source.set({ rows: { session: [job(active)] }, observed: {} })
  source.set({ rows: { session: [job('failed', action)] }, observed: {} })
  expect(publish).toHaveBeenCalledExactlyOnceWith('owner-a')
  source.set({ rows: { session: [job('failed', action)] }, observed: {} })
  expect(publish).toHaveBeenCalledOnce()
  release()
  source.set({ rows: { session: [job(active)] }, observed: {} })
  source.set({ rows: { session: [job('failed', action)] }, observed: {} })
  expect(publish).toHaveBeenCalledOnce()
})

it.each([undefined, { code: 'NETWORK', scope: 'owner-a' }, { code: 'INSUFFICIENT_BALANCE' }])(
  'does not turn unrelated or unscoped job failures into a product recharge notice: %j', (action) => {
    const source = createSnapshotStore<JobsSnapshot>({ rows: { session: [job('running')] }, observed: {} })
    const publish = vi.fn(() => true)
    const notices = createQuotaNotices(publish)
    notices.registerBalanceScope(scope => scope === 'owner-a')
    const release = watchBalanceFailures(source, notices)
    source.set({ rows: { session: [job('failed', action)] }, observed: {} })
    expect(publish).not.toHaveBeenCalled()
    release()
  },
)


it.each(['before-roster', 'after-roster'] as const)('announces a coalesced immediate failure when its live start arrives %s', (order) => {
  const source = createSnapshotStore<JobsSnapshot>({ rows: {}, observed: {} })
  const publish = vi.fn(() => true)
  const notices = createQuotaNotices(publish)
  notices.registerBalanceScope(scope => scope === 'owner-a')
  const release = watchBalanceFailures(source, notices)
  if (order === 'before-roster') notices.registerLiveJob('video-project-1')
  source.set({ rows: { session: [job('failed', { code: 'INSUFFICIENT_BALANCE', scope: 'owner-a' })] }, observed: {} })
  if (order === 'after-roster') {
    expect(publish).not.toHaveBeenCalled()
    notices.registerLiveJob('video-project-1')
  }
  expect(publish).toHaveBeenCalledExactlyOnceWith('owner-a')
  notices.publishBalance({ scope: 'owner-a', key: 'job:video-project-1' })
  expect(publish).toHaveBeenCalledOnce()
  release()
})

it('correlates a first-frame terminal result only after a live acknowledgement, while rejecting the old account', () => {
  const source = createSnapshotStore<JobsSnapshot>({ rows: { session: [
    job('failed', { code: 'INSUFFICIENT_BALANCE', scope: 'owner-a' }),
  ] }, observed: {} })
  const publish = vi.fn(() => true)
  const notices = createQuotaNotices(publish)
  let owner = 'owner-b'
  notices.registerBalanceScope(scope => scope === owner)
  const release = watchBalanceFailures(source, notices)
  expect(publish).not.toHaveBeenCalled()
  notices.registerLiveJob('video-project-1')
  expect(publish).not.toHaveBeenCalled()
  owner = 'owner-a'
  notices.registerLiveJob('video-project-1')
  expect(publish).toHaveBeenCalledExactlyOnceWith('owner-a')
  release()
})
