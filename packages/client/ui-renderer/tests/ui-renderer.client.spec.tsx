// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '../src/client/registry.ts'
import type { SlotScopeAdapter, StandardSourceBinding } from '../src/client/index.ts'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-ui-renderer'
import * as UiRenderer from '../src/client/index.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'renderer.mount.child': { kind: 'single'; scope: 'root' }
  }
}

const mounted: (() => void)[] = []

afterEach(() => {
  act(() => { for (const unmount of mounted.splice(0)) unmount() })
  vi.restoreAllMocks()
  cleanup()
  document.body.innerHTML = ''
})

const stabilize = async (fn: () => void | Promise<void>): Promise<void> => {
  await act(async () => { await fn() })
}

async function bench() {
  const ctx = new Context()
  const fiber = ctx.plugin({ inject: [...UiRenderer.inject], apply: UiRenderer.apply })
  await fiber.await()
  const slots = ctx.get('slots') as SlotRegistry
  const absentBinding: StandardSourceBinding = {
    key: undefined,
    hooks: {},
    keyedHooks: {},
    props: {},
  }
  const current = {
    getSnapshot: () => absentBinding,
    subscribe: () => () => {},
  }
  const adapter: SlotScopeAdapter = {
    current,
    bindingSource: () => current,
  }
  slots.installScope('session', adapter)
  return { ctx, slots, fiber }
}

function container(): HTMLElement {
  const el = document.createElement('div')
  document.body.append(el)
  return el
}

describe('UI renderer plugin', () => {
  it('provides no host-side behavior', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('installs the renderer and mounts the assembled application', async () => {
    const { ctx, slots } = await bench()
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const renderer = ctx.get('uiRenderer')
    expect(renderer).toBeDefined()
    const el = container()
    act(() => { mounted.push(renderer!.mount(el)) })
    expect(el.querySelector('[data-testid="root-probe"]')).toBeTruthy()
  })

  it('hydrates the boot page before switching to the assembled application', async () => {
    const { ctx, slots } = await bench()
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const el = container()
    el.innerHTML = '<div class="boot" data-dsh-boot=""><div><div class="spinner" data-dsh-boot-spinner="" style="--dsh-boot-arc: 180deg"></div><div>Loading plugins…</div></div></div>'
    const boot = el.firstElementChild
    const observer = new MutationObserver(() => {})
    observer.observe(el, { childList: true, subtree: true })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    act(() => { mounted.push(ctx.get('uiRenderer')!.mount(el)) })

    const records = observer.takeRecords()
    observer.disconnect()
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
    expect(el.querySelector('[data-testid="root-probe"]')).toBeTruthy()
    expect(records.some(record => record.target === boot)).toBe(false)
  })

  it('returns an unmount disposer', async () => {
    const { ctx, slots } = await bench()
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const el = container()
    let unmount: () => void = () => {}
    act(() => { unmount = ctx.get('uiRenderer')!.mount(el) })
    act(() => { unmount() })
    expect(el.querySelector('[data-testid="root-probe"]')).toBeNull()
  })

  it('rejects a missing initial root without retaining the container', async () => {
    const { ctx, slots } = await bench()
    const el = container()
    expect(() => ctx.get('uiRenderer')!.mount(el)).toThrow("'root' has no registration")
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    act(() => { mounted.push(ctx.get('uiRenderer')!.mount(el)) })
    expect(el.querySelector('[data-testid="root-probe"]')).toBeTruthy()
    expect(error).not.toHaveBeenCalled()
  })

  it('suspends across root unloads and mounts the replacement after its children register', async () => {
    const { ctx, slots } = await bench()
    const children = { 'renderer.mount.child': { kind: 'single', scope: 'root' } } as const
    slots.inject('renderer.mount.child', () => slots.register(
      { name: 'renderer.mount.child' }, () => <span data-testid="child-probe" />,
    ))
    const register = async (label: string) => {
      const frame = ctx.plugin({
        inject: ['slots'],
        apply: (scope) => {
          scope.slots.register({ name: 'root', children }, ({ renderSlot }) => (
            <main aria-label={label}>{renderSlot('renderer.mount.child', {})}</main>
          ))
        },
      })
      await frame.await()
      return frame
    }
    const original = await register('original frame')
    const el = container()
    act(() => { mounted.push(ctx.get('uiRenderer')!.mount(el)) })
    expect(el.querySelector('main')?.getAttribute('aria-label')).toBe('original frame')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await stabilize(async () => {
      await original.dispose()
      await Promise.resolve()
      expect(el.childElementCount).toBe(0)
    })
    await stabilize(async () => { await register('replacement frame') })

    expect(el.querySelector('main')?.getAttribute('aria-label')).toBe('replacement frame')
    expect(el.querySelector('[data-testid="child-probe"]')).toBeTruthy()
    expect(error).not.toHaveBeenCalled()
  })

  it('does not remount a suspended application after its mount is disposed', async () => {
    const { ctx, slots } = await bench()
    const remove = slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const el = container()
    let unmount: () => void = () => {}
    act(() => { unmount = ctx.get('uiRenderer')!.mount(el) })
    await stabilize(() => {
      remove()
      slots.register({ name: 'root' }, () => <div data-testid="replacement" />)
      unmount()
      unmount()
    })
    expect(el.childElementCount).toBe(0)
  })

  it('retracts the service and renderer with its fiber', async () => {
    const { ctx, slots, fiber } = await bench()
    await stabilize(() => fiber.dispose())
    expect(ctx.get('uiRenderer')).toBeUndefined()
    expect(() => slots.renderSlot('root', {})).toThrow('not installed')
  })
})
