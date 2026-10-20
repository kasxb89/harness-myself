// @vitest-environment jsdom
/** Native employee browsing, retained query failures and bounded card presentation. */
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { EmployeePage, type EmployeePageProps } from '../src/client/EmployeePage.tsx'
import type { AgentPresetSettingsState } from '../src/client/settings-store.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const translations: ReadonlyMap<string, string> = new Map(Object.entries(zh))

function unusedHook(): never { throw new Error('The employee page reads only its injected roster') }

function page(partial: Partial<AgentPresetSettingsState> = {}, openCustomEmployee?: () => void) {
  const store = createSnapshotStore<AgentPresetSettingsState>({ status: 'ready', error: null, options: [
    { id: 'standard' },
    { id: 'employee-video-director', name: '短视频编导', description: '编写中文分镜、组织参考素材并生成视频' },
    { id: 'employee-administrative-assistant', name: '行政文秘', description: '整理会议记录与工作文档' },
  ], ...partial })
  const customEmployeeAvailable = createSnapshotStore(openCustomEmployee !== undefined)
  const actions = { load: vi.fn(async () => {}), startEmployeeDraft: vi.fn() }
  const props: EmployeePageProps = {
    ...actions,
    openCustomEmployee: openCustomEmployee ?? vi.fn(),
    usePanelInfo: unusedHook, useSessions: unusedHook, useSessionStatus: unusedHook, useSessionRetainInfo: unusedHook,
    useWorkspaces: unusedHook, useResource: unusedHook, useAgentPresets: bindSnapshotSelector(store),
    useCustomEmployeeAvailable: bindSnapshotSelector(customEmployeeAvailable),
    t: (key, params) => (translations.get(key) ?? key).replace(/\{(\w+)\}/gu, (placeholder: string, name: string) =>
      params !== undefined && name in params ? String(params[name]) : placeholder),
  }
  render(<EmployeePage {...props} />)
  return { ...actions, store, customEmployeeAvailable }
}

describe('native employee page', () => {
  it('shows employee roles only and starts the chosen ordinary chat draft', () => {
    const actions = page()
    const list = screen.getByRole('group', { name: zh.employeesList })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByText('标准模式')).toBeNull()
    expect(actions.load).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '与短视频编导开始对话' }))
    expect(actions.startEmployeeDraft).toHaveBeenCalledExactlyOnceWith('employee-video-director')
    expect({
      title: screen.getByRole('heading', { level: 1 }).textContent,
      roles: within(list).getAllByRole('heading', { level: 3 }).map(row => row.textContent),
      description: screen.getByText(zh.employeesCapabilities).textContent,
    }).toMatchInlineSnapshot(`
      {
        "description": "沿用当前工作区的模型和账户积分，图片、视频任务使用云枢现有创作工具",
        "roles": [
          "短视频编导",
          "行政文秘",
        ],
        "title": "数字员工",
      }
    `)
  })

  it('separates native roles and authored presets, including arbitrary ids and named built-in overrides', () => {
    const open = vi.fn()
    const actions = page({ options: [
      { id: 'standard' }, { id: 'minimal' }, { id: 'cordis' },
      { id: 'employee-video-director', name: '短视频编导' },
      { id: 'custom', name: '电商助手' }, { id: 'custom-2', name: '客服助理' },
      { id: 'my-studio', name: '我的工作室' }, { id: 'ptc', name: '团队助手' },
    ] }, open)
    expect(within(screen.getByRole('list', { name: zh.employeesBuiltIn })).getAllByRole('listitem')).toHaveLength(1)
    expect(within(screen.getByRole('list', { name: zh.employeesMine })).getAllByRole('listitem')).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: '与我的工作室开始对话' }))
    expect(actions.startEmployeeDraft).toHaveBeenCalledExactlyOnceWith('my-studio')
    fireEvent.click(screen.getByRole('button', { name: zh.employeesCustomize }))
    expect(open).toHaveBeenCalledOnce()
    expect(actions.startEmployeeDraft).toHaveBeenCalledTimes(1)
    act(() => { actions.customEmployeeAvailable.set(false) })
    expect(screen.queryByRole('button', { name: zh.employeesCustomize })).toBeNull()
    act(() => { actions.customEmployeeAvailable.set(true) })
    expect(screen.getByRole('button', { name: zh.employeesCustomize })).toBeTruthy()
  })

  it('searches names and responsibilities, clears search, and follows roster changes', () => {
    const actions = page()
    const input = screen.getByRole('searchbox', { name: zh.employeesSearch })
    fireEvent.change(input, { target: { value: '会议记录' } })
    expect(screen.queryByText('短视频编导')).toBeNull()
    expect(screen.getByText('行政文秘')).toBeTruthy()
    fireEvent.change(input, { target: { value: '不存在的岗位' } })
    expect(screen.getByText(zh.employeesNoResults)).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
    fireEvent.change(input, { target: { value: '  英语  ' } })
    act(() => { actions.store.set({ status: 'ready', error: null, options: [
      { id: 'employee-language', name: '英语助手', description: '商务翻译' },
    ] }) })
    expect(screen.getByText('英语助手')).toBeTruthy()
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.queryByText(zh.employeesNoResults)).toBeNull()
    expect(actions.startEmployeeDraft).not.toHaveBeenCalled()
  })

  it('offers Retry without clearing cards after a roster read fails', () => {
    const actions = page({ status: 'error', error: 'private transport details' })
    expect(screen.getByRole('alert').textContent).toContain(zh.employeesLoadFailed)
    expect(screen.queryByText('private transport details')).toBeNull()
    expect(screen.getByText('短视频编导')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.employeesRetry }))
    expect(actions.load).toHaveBeenCalledTimes(2)
    expect(actions.startEmployeeDraft).not.toHaveBeenCalled()
    act(() => { actions.store.set({ status: 'ready', error: null, options: [] }) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(zh.employeesEmpty)).toBeTruthy()
  })

  it('keeps the initial loading state distinct from an empty roster', () => {
    const actions = page({ status: 'loading', options: [] })
    expect(screen.getByRole('status', { name: zh.employeesLoading })).toBeTruthy()
    expect(screen.queryByText(zh.employeesEmpty)).toBeNull()
    act(() => { actions.store.set({ status: 'unavailable', error: null, options: [] }) })
    expect(screen.queryByRole('status', { name: zh.employeesLoading })).toBeNull()
    expect(screen.getByText(zh.employeesEmpty)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('bounds long card text and uses scoped Mac clearance and theme colors', () => {
    const description = '长岗位职责'.repeat(100)
    page({ options: [{ id: 'employee-long', name: '很长的岗位名称'.repeat(30), description }] })
    expect(screen.getByText(description).getAttribute('title')).toBe(description)
    const css = readFileSync('packages/client/ui-agent-preset/src/client/EmployeePage.module.css', 'utf8')
    expect(css).toContain("[data-platform='darwin']")
    expect(css).toContain('calc(var(--dsh-frame-top-clearance) + 16px)')
    expect(css).toContain('-webkit-line-clamp: 3')
    expect(css).toContain('-webkit-line-clamp: 2')
    expect(css).toContain('minmax(min(100%, 260px), 1fr)')
    expect(css).toContain('var(--dsw-alias-label-secondary)')
    expect(css).toContain('prefers-reduced-motion')
    expect(css).not.toMatch(/font-weight:\s*[6-9]00/u)
  })
})
