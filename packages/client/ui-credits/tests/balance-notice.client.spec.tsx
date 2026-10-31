// @vitest-environment jsdom
/** The product funding notice uses the existing recharge action and stops on identity changes. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { BalanceNotice } from '../src/client/BalanceNotice.tsx'
import type { CreditsSnapshot } from '../src/client/session-store.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const account = (id = '7', epoch = 1): CreditsSnapshot => ({ accountEpoch: epoch,
  session: { signedIn: true, account: { id, phone: 'test' }, creditsPerYuan: 1000 },
  balance: null, loaded: true, failure: null,
})

describe('product balance notice', () => {
  it.each(['zh', 'en'] as const)('shows safe localized copy and opens the existing recharge entry (%s)', (locale) => {
    const identity = createSnapshotStore(account())
    const dismiss = vi.fn(), openRecharge = vi.fn()
    const copy = locale === 'zh' ? zh : en
    const props = { matched: { code: 'INSUFFICIENT_BALANCE', message: 'private upstream', dismiss, keepOpen: () => () => {} },
      openRecharge, useCreditsSession: bindSnapshotSelector(identity), t: makeTranslate(copy),
    } as Parameters<typeof BalanceNotice>[0]
    const view = render(<BalanceNotice {...props} />)
    expect(view.getByRole('dialog').textContent).toContain(copy.balanceInsufficient)
    expect(view.container.textContent).not.toContain('private upstream')
    fireEvent.click(view.getByRole('button', { name: copy.goRecharge }))
    expect(dismiss).toHaveBeenCalledOnce()
    expect(openRecharge).toHaveBeenCalledOnce()
  })

  it('dismisses on logout or identity replacement without navigating another account', () => {
    const identity = createSnapshotStore(account())
    const dismiss = vi.fn(), openRecharge = vi.fn()
    const props = { matched: { code: 'INSUFFICIENT_BALANCE', message: 'safe', dismiss, keepOpen: () => () => {} },
      openRecharge, useCreditsSession: bindSnapshotSelector(identity), t: makeTranslate(zh),
    } as Parameters<typeof BalanceNotice>[0]
    const view = render(<BalanceNotice {...props} />)
    act(() => { identity.set(account('8', 2)) })
    expect(view.queryByRole('dialog')).toBeNull()
    expect(dismiss).toHaveBeenCalledOnce()
    expect(openRecharge).not.toHaveBeenCalled()
  })
})


function unusedStandard(): never { throw new Error('Unexpected global hook in balance leaf fixture') }

it('does not offer another login scope a recharge action, even for the same account id', () => {
  const identity = createSnapshotStore({ ...account(), session: { ...account().session!, accountOwner: 'new-login' } })
  const dismiss = vi.fn(), openRecharge = vi.fn()
  const matched = { code: 'INSUFFICIENT_BALANCE' as const, scope: 'old-login',
    message: 'safe', dismiss, keepOpen: () => () => {} }
  const view = render(<BalanceNotice {...matched} matched={matched} openRecharge={openRecharge}
    useCreditsSession={bindSnapshotSelector(identity)} t={makeTranslate(zh)} usePanelInfo={unusedStandard}
    useSessions={unusedStandard} useSessionStatus={unusedStandard} useSessionRetainInfo={unusedStandard}
    useWorkspaces={unusedStandard} useResource={unusedStandard} />)
  expect(view.queryByRole('dialog')).toBeNull()
  expect(dismiss).toHaveBeenCalledOnce()
  expect(openRecharge).not.toHaveBeenCalled()
})
