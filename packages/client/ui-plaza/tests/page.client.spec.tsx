// @vitest-environment jsdom
/** The frame presents the current opaque market face without owning its controls. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type {} from '../src/client/index.ts'
import { PlazaPage, type MarketControl, type PlazaPageProps } from '../src/client/PlazaPage.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const translations: ReadonlyMap<string, string> = new Map(Object.entries(zh))

function unusedHook(): never { throw new Error('The Plaza reads only its injected market face') }

function page(control: MarketControl | null = null) {
  const store = createSnapshotStore(control)
  const props: PlazaPageProps = {
    usePanelInfo: unusedHook, useSessions: unusedHook, useSessionStatus: unusedHook, useSessionRetainInfo: unusedHook,
    useWorkspaces: unusedHook, useResource: unusedHook,
    useMarketControl: bindSnapshotSelector(store), t: (key: string) => translations.get(key) ?? key,
  }
  render(<PlazaPage {...props} />)
  return store
}

describe('Plaza page', () => {
  it('shows a localized unavailable state without an ineffective retry or install action', () => {
    page()
    expect(screen.getByRole('region', { name: zh.panel })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain(zh.missingTitle)
    expect(screen.getByText(zh.missing)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('retains provider controls and replaces them when the supplied face changes', () => {
    const action = vi.fn()
    const market: MarketControl = { version: 1, render: () => <div>
      <input aria-label="Provider search" />
      <button type="button" onClick={action}>Provider action</button>
    </div> }
    const store = page(market)
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider search' }), { target: { value: 'office' } })
    expect(screen.getByRole('textbox')).toHaveProperty('value', 'office')
    fireEvent.click(screen.getByRole('button', { name: 'Provider action' }))
    expect(action).toHaveBeenCalledOnce()
    act(() => { store.set(null) })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText(zh.missingTitle)).toBeTruthy()
    act(() => { store.set({ version: 1, render: () => <p>Replacement market</p> }) })
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('Replacement market')).toBeTruthy()
  })
})
