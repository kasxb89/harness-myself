// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PaneId, TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { CreativeOutputId } from '@deepseek-ai/dsh-credits-index/src/creative-types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CreativeBody, type CreativeBodyProps } from '../src/client/CreativeBody.tsx'
import type { CreativeSnapshot } from '../src/client/controller.ts'
import { en, zh } from '../src/client/locales.ts'
import { mediaUrl, project } from './fixtures.ts'

afterEach(cleanup)

function fixture(initial: Partial<CreativeSnapshot> = {}, english = false) {
  const source = createSnapshotStore<CreativeSnapshot>({ phase: 'ready', projects: [project()], refreshing: false, failure: null, ...initial })
  const input = createSnapshotStore<InputState>({ draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [] })
  const abort = new AbortController()
  const released = vi.fn()
  const watch = vi.fn(() => released)
  const refresh = vi.fn()
  const reportDraft = vi.fn()
  const inputActions = {
    captureInsertion: vi.fn(() => ({ start: 0, end: 0, draftRev: 0 })),
    insertText: vi.fn<CreativeBodyProps['inputActions']['insertText']>(() => true),
    setDraft: vi.fn(), persistDraft: vi.fn(), addAttachments: vi.fn(() => true), removeAttachment: vi.fn(),
    pruneAttachments: vi.fn(), submit: vi.fn(),
  } satisfies CreativeBodyProps['inputActions']
  const useTabInfo: CreativeBodyProps['useTabInfo'] = () => ({
    sidebar: { expanded: true, fullscreen: false }, panel: { id: 'pane-1' as PaneId },
    tab: { id: 'tab-1' as TabId, kind: 'creative', title: '创作', contentId: 'sidebar://creative',
      visible: true, signal: abort.signal, navigation: { address: 'sidebar://creative', params: undefined, revision: 1 },
      actions: { bindCommands: () => () => {}, openResource: vi.fn(), openTab: vi.fn(), close: vi.fn() } },
  })
  const props = {
    sessionId: 'session-a' as SessionId, useTabInfo, useCreative: bindSnapshotSelector(source),
    useInput: bindSnapshotSelector(input), inputActions, watch, refresh, reportDraft, reportSaved: vi.fn(),
    selectProject: vi.fn((id: string) => {
      const before = source.getSnapshot()
      const selected = before.projects.find(item => item.id === id)
      if (selected !== undefined) {
        const { selectedShotId: _shot, ...rest } = before
        const first = selected.shots[0]
        source.set({ ...rest, selectedProjectId: selected.id, ...(first === undefined ? {} : { selectedShotId: first.id }) })
      }
    }),
    selectShot: vi.fn((id: string) => { source.set({ ...source.getSnapshot(), selectedShotId: id }) }),
    save: vi.fn<CreativeBodyProps['save']>(async () => ({ ok: true as const, payload: { accountId: 'account-a', projects: [project()] } })),
    upload: vi.fn<CreativeBodyProps['upload']>(async () => ({ ok: true as const, assetId: 'ma_test', kind: 'image' as const })), t: makeTranslate(english ? en : zh),
  }
  // The remaining framework seats are not read by this pure component.
  const view = render(<CreativeBody {...props as CreativeBodyProps} />)
  return { view, props, source, input, inputActions, watch, released, refresh, reportDraft, abort }
}

describe('chat creation sidebar', () => {
  it('shows saved shot, character and material directions without inventing output files', () => {
    const h = fixture()
    expect(screen.getByText('雨夜重逢')).toBeTruthy()
    expect(screen.getAllByText('生成中')).toHaveLength(2)
    expect(screen.getByText('尚未生成文件')).toBeTruthy()
    expect(h.view.container.querySelector('[data-creative-output]')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '人物' }))
    expect(screen.getByText('小雨')).toBeTruthy()
    expect(screen.getByText('黑发少女')).toBeTruthy()
    expect(screen.getByText('年轻女声')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '素材' }))
    expect(screen.getByText('/private/local/reference.png').closest('details')?.open).toBe(false)
    expect(h.watch).toHaveBeenCalledWith(true, h.abort.signal)
    h.view.unmount()
    expect(h.released).toHaveBeenCalledOnce()
  })

  it('renders only actual media frames with their timestamps and keeps synchronization unverified', () => {
    const output = { id: 'out1' as CreativeOutputId, kind: 'video' as const, name: 'scene.mp4', url: mediaUrl(),
      frames: [{ url: `${mediaUrl()}&frame=0`, timeSeconds: 15.633 }, { url: `${mediaUrl()}&frame=1`, timeSeconds: 17.5 }] }
    const h = fixture({ projects: [project({ status: 'completed', outputs: [output] })] })
    fireEvent.click(screen.getByRole('tab', { name: '任务与产物' }))
    expect(screen.getAllByText('文件已完成').some(item => item.tagName === 'SPAN')).toBe(true)
    expect(screen.getByText('人声、口型与字幕同步：待核验')).toBeTruthy()
    expect(screen.getByText('00:15.633')).toBeTruthy()
    expect(screen.getByText('00:17.500')).toBeTruthy()
    expect(h.view.container.querySelector('video')?.getAttribute('src')).toBe(mediaUrl())
    expect(h.view.container.querySelector('video')?.hasAttribute('autoplay')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'scene.mp4 · 00:15.633' }))
    expect(screen.getByRole('dialog', { name: '预览图片' }).querySelector('img')?.getAttribute('src')).toBe(`${mediaUrl()}&frame=0`)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('stages redo and edited directions in the current editable draft without submitting or replacing it', () => {
    const h = fixture()
    fireEvent.click(screen.getByRole('button', { name: '重做镜头' }))
    expect(h.inputActions.insertText).toHaveBeenCalledWith(expect.stringContaining('plan_id=cp_rain'), { start: 0, end: 0, draftRev: 0 })
    expect(h.inputActions.persistDraft).toHaveBeenCalledOnce()
    expect(h.inputActions.submit).not.toHaveBeenCalled()
    expect(h.inputActions.setDraft).not.toHaveBeenCalled()
    expect(h.reportDraft).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: '修改镜头' }))
    expect(screen.getByRole('dialog', { name: '修改 车站对白' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '写入聊天草稿' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: '想修改镜头的哪些内容？' }), { target: { value: '改成正面近景' } })
    fireEvent.click(screen.getByRole('button', { name: '写入聊天草稿' }))
    expect(h.inputActions.insertText).toHaveBeenLastCalledWith(expect.stringContaining('改成正面近景'), expect.any(Object))
    expect(h.inputActions.insertText).toHaveBeenLastCalledWith(expect.stringContaining('update_creation_plan'), expect.any(Object))
    expect(h.inputActions.submit).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('refuses draft conflicts and locks paid-operation staging during ordinary submission', () => {
    const h = fixture()
    vi.mocked(h.inputActions.insertText).mockReturnValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: '重做镜头' }))
    expect(h.reportDraft).toHaveBeenCalledWith(false)
    expect(h.inputActions.persistDraft).not.toHaveBeenCalled()
    act(() => { h.input.set({ ...h.input.getSnapshot(), phase: 'submitting' }) })
    expect(screen.getByRole('button', { name: '重做镜头' }).hasAttribute('disabled')).toBe(true)
  })

  it('keeps completed files usable when frame extraction or media preview fails', () => {
    const output = { id: 'out1' as CreativeOutputId, kind: 'video' as const, name: 'scene.mp4', url: mediaUrl(), previewUnavailable: true }
    const h = fixture({ projects: [project({ outputs: [output] })] })
    fireEvent.click(screen.getByRole('tab', { name: '任务与产物' }))
    expect(screen.getByText('视频已保存，预览帧暂不可用')).toBeTruthy()
    expect(h.view.container.querySelector('img')).toBeNull()
    fireEvent.error(h.view.container.querySelector('video')!)
    expect(screen.getByText('预览暂不可用，可下载原文件查看')).toBeTruthy()
    expect(screen.getByRole('link', { name: '下载原文件' }).getAttribute('href')).toBe(mediaUrl())
  })

  it('removes data and edit dialogs immediately when account-owned projects disappear', () => {
    const h = fixture()
    fireEvent.click(screen.getByRole('button', { name: '修改镜头' }))
    act(() => { h.source.set({ phase: 'signed-out', projects: [], refreshing: false, failure: null }) })
    expect(screen.getByText('登录后查看当前聊天的创作项目')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('雨夜重逢')).toBeNull()
  })

  it('localizes empty, failure and file-completion copy in English', () => {
    const h = fixture({ projects: [] }, true)
    expect(screen.getByText('Your creation takes shape here')).toBeTruthy()
    act(() => { h.source.set({ phase: 'failed', projects: [], refreshing: false, failure: 'invalid' }) })
    expect(screen.getByRole('alert').textContent).toBe('Creation data cannot be displayed. Refresh to try again.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(h.refresh).toHaveBeenCalledOnce()
  })

  it('stages character adjustments with the original project, character and reference identities', () => {
    const h = fixture()
    fireEvent.click(screen.getByRole('tab', { name: '人物' }))
    fireEvent.click(screen.getByRole('button', { name: '修改人物' }))
    expect(screen.getByRole('dialog', { name: '修改人物 · 小雨' })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: '想调整人物的哪些设定？' }), { target: { value: '保留黑发，换成蓝色围巾' } })
    fireEvent.click(screen.getByRole('button', { name: '写入聊天草稿' }))
    const text = h.inputActions.insertText.mock.calls[0]?.[0]
    expect(text).toContain('保留黑发，换成蓝色围巾')
    expect(text).toContain('plan_id 保持 cp_rain')
    expect(text).toContain('id=girl')
    expect(text).toContain('["station"]')
    expect(text).toContain('reference_images')
    expect(text).toContain('缺失时先向我询问')
    expect(h.inputActions.submit).not.toHaveBeenCalled()
    expect(h.inputActions.setDraft).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'image' as const, sourcePathOrAssetId: '/private/local/reference.png' },
    { kind: 'video' as const, sourcePathOrAssetId: '' },
  ])('stages material rework with its actual $kind source and checks support before generation', (asset) => {
    const data = project()
    const h = fixture({ projects: [{ ...data, assets: data.assets.map(item => ({ ...item, ...asset })) }] })
    fireEvent.click(screen.getByRole('tab', { name: '素材' }))
    fireEvent.click(screen.getByRole('button', { name: '重构素材' }))
    expect(screen.getByRole('dialog', { name: '重构素材 · 车站参考' })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: '希望怎样调整这份素材？' }), { target: { value: '将雨夜改成日落' } })
    fireEvent.click(screen.getByRole('button', { name: '写入聊天草稿' }))
    const text = h.inputActions.insertText.mock.calls[0]?.[0]
    expect(text).toContain('将雨夜改成日落')
    expect(text).toContain('plan_id 保持 cp_rain')
    expect(text).toContain('id=station')
    expect(text).toContain('asset_id=station')
    expect(text).toContain('不传 shot_id')
    expect(text).toContain(`kind=${asset.kind}`)
    expect(text).toContain(`sourcePathOrAssetId=${JSON.stringify(asset.sourcePathOrAssetId)}`)
    expect(text).toContain('仅在原素材确为图片且模型支持时')
    expect(text).toContain('先询问缺失输入或合适的处理方式')
    expect(h.inputActions.submit).not.toHaveBeenCalled()
  })

  it('links character reference previews to real material outputs without unrelated or invented images', () => {
    const data = project()
    const output = { id: 'out1' as CreativeOutputId, kind: 'image' as const, name: 'reference.png', url: mediaUrl() }
    const h = fixture({ projects: [{ ...data, assets: data.assets.map(asset => ({ ...asset,
      status: 'completed' as const, outputs: [output] })) }] })
    fireEvent.click(screen.getByRole('tab', { name: '人物' }))
    expect(screen.getByRole('img', { name: '车站参考' }).getAttribute('src')).toBe(mediaUrl())
    expect(h.view.container.querySelectorAll('img')).toHaveLength(1)
    fireEvent.click(screen.getByRole('tab', { name: '素材' }))
    expect(screen.getAllByText('文件已完成').some(item => item.tagName === 'SPAN')).toBe(true)
    expect(screen.getByRole('img', { name: '车站参考' }).getAttribute('src')).toBe(mediaUrl())
    act(() => { h.source.set({ ...h.source.getSnapshot(), projects: [data] }) })
    expect(h.view.container.querySelector('img')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '人物' }))
    expect(h.view.container.querySelector('img')).toBeNull()
  })

  it('preserves the newest saved image references in a material draft even when the original source is empty', () => {
    const data = project()
    const output = (id: string, kind: 'image' | 'audio') => ({ id: id as CreativeOutputId, kind,
      name: `${id}.png`, url: mediaUrl(data.id, id) })
    const h = fixture({ projects: [{ ...data, assets: [{ ...data.assets[0]!, sourcePathOrAssetId: '',
      outputs: [output('out_old', 'image'), output('out_audio', 'audio'), output('out_new', 'image')] }] }] })
    fireEvent.click(screen.getByRole('tab', { name: '素材' }))
    fireEvent.click(screen.getByRole('button', { name: '重构素材' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '保留原构图，换成晴天' } })
    fireEvent.click(screen.getByRole('button', { name: '写入聊天草稿' }))
    const text = h.inputActions.insertText.mock.calls[0]?.[0]
    expect(text).toContain('sourcePathOrAssetId=""')
    expect(text).toContain('["out_new","out_old"]')
    expect(text).not.toContain('out_audio')
    expect(text).not.toContain('/credits/api/creative/media')
    expect(text).toContain('只有 source 和已保存图片都没有时')
    expect(h.inputActions.submit).not.toHaveBeenCalled()
  })

  it.each([
    { section: '人物', action: '修改人物' }, { section: '素材', action: '重构素材' },
  ])('cancels and locks the $action dialog without touching the draft', ({ section, action }) => {
    const h = fixture()
    fireEvent.click(screen.getByRole('tab', { name: section }))
    fireEvent.click(screen.getByRole('button', { name: action }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '临时修改' } })
    act(() => { h.input.set({ ...h.input.getSnapshot(), phase: 'submitting' }) })
    expect(screen.getByRole('textbox').hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '写入聊天草稿' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: action }).hasAttribute('disabled')).toBe(true)
    expect(h.inputActions.insertText).not.toHaveBeenCalled()
    expect(h.inputActions.submit).not.toHaveBeenCalled()
  })

  it.each([{ english: false, label: '任务与作品' }, { english: true, label: 'Tasks and images' }])(
    'labels image-project outputs as $label instead of a finished video', ({ english, label }) => {
      fixture({ projects: [project({ kind: 'image' })] }, english)
      fireEvent.click(screen.getByRole('tab', { name: label }))
      expect(screen.queryByRole('tab', { name: '任务与产物' })).toBeNull()
      expect(screen.queryByText(english ? en['verify.pending'] : zh['verify.pending'])).toBeNull()
    },
  )
})


describe('shared project workbench', () => {
  it('requires visible generation directions before adding a shot with the original CAS revision', async () => {
    const h = fixture()
    fireEvent.click(screen.getByRole('button', { name: '添加镜头' }))
    const directions = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '生成要求（必填）' })
    expect(directions.required).toBe(true)
    expect(directions.closest('details')).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '站台告别' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '计划时长（秒）' }), { target: { value: '10' } })
    const save = screen.getByRole<HTMLButtonElement>('button', { name: '保存设定' })
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(h.props.save).not.toHaveBeenCalled()
    fireEvent.change(directions, { target: { value: '   ' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(directions, { target: { value: '手绘动漫，女孩在站台挥手告别，镜头缓慢拉远' } })
    expect(save.disabled).toBe(false)
    act(() => { h.source.set({ ...h.source.getSnapshot(), projects: [project({ planRevision: 'revision-2' })] }) })
    fireEvent.click(save)
    await waitFor(() => { expect(h.props.save).toHaveBeenCalledOnce() })
    expect(h.props.save.mock.calls[0]?.slice(0, 2)).toEqual(['cp_rain', 'revision-1'])
    const change = h.props.save.mock.calls[0]?.[2]
    if (change?.kind !== 'add-shot') throw new Error('Expected the saved change to add one shot')
    expect(change.value.id).toMatch(/^shot_[a-f0-9]+$/u)
    expect(change).toMatchObject({ kind: 'add-shot', value: {
      order: 2, title: '站台告别', durationSeconds: 10,
      prompt: '手绘动漫，女孩在站台挥手告别，镜头缓慢拉远', characterIds: [], assetIds: [],
    } })
    expect(h.inputActions.insertText).not.toHaveBeenCalled()
    expect(h.inputActions.submit).not.toHaveBeenCalled()
  })

  it('shows planned cumulative shot timing and saves keyboard-accessible ordering without a paid call', async () => {
    const initial = project()
    const second = { ...initial.shots[0]!, id: 's2', order: 2, title: '第二镜', durationSeconds: 10 }
    const h = fixture({ projects: [project({ shots: [...initial.shots, second] })] })
    expect(screen.getByText('00:00.000 — 00:15.000')).toBeTruthy()
    expect(screen.getByText('00:15.000 — 00:25.000')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '选择镜头：第二镜' }))
    expect(screen.getByRole('button', { name: '选择镜头：第二镜' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '将 第二镜 前移' }))
    await waitFor(() => { expect(h.props.save).toHaveBeenCalledWith('cp_rain', 'revision-1',
      { kind: 'reorder', shotIds: ['s2', 's1'] }, expect.any(AbortSignal)) })
    expect(h.inputActions.insertText).not.toHaveBeenCalled()
    expect(h.inputActions.submit).not.toHaveBeenCalled()
  })

  it('saves editable shot fields and exact character/material bindings through the free CAS operation', async () => {
    const h = fixture()
    fireEvent.click(screen.getByRole('button', { name: '编辑设定' }))
    fireEvent.change(screen.getByRole('textbox', { name: '场景' }), { target: { value: '日落的车站' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '小雨' }))
    fireEvent.click(screen.getByRole('button', { name: '保存设定' }))
    await waitFor(() => { expect(h.props.save).toHaveBeenCalledOnce() })
    expect(h.props.save.mock.calls[0]?.slice(0, 2)).toEqual(['cp_rain', 'revision-1'])
    expect(h.props.save.mock.calls[0]?.[2]).toMatchObject({ kind: 'shot', id: 's1',
      patch: { scene: '日落的车站', characterIds: [], assetIds: ['station'] } })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(h.inputActions.insertText).not.toHaveBeenCalled()
    expect(h.props.reportSaved).toHaveBeenCalledOnce()
  })

  it('retains unsaved fields on a conflicting revision instead of overwriting the new plan', async () => {
    const h = fixture()
    h.props.save.mockResolvedValueOnce({ ok: false, code: 'stale' })
    fireEvent.click(screen.getByRole('button', { name: '编辑设定' }))
    fireEvent.change(screen.getByRole('textbox', { name: '场景' }), { target: { value: '保留我的场景修改' } })
    act(() => { h.source.set({ ...h.source.getSnapshot(), projects: [project({ planRevision: 'revision-2' })] }) })
    fireEvent.click(screen.getByRole('button', { name: '保存设定' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('计划已被更新') })
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '场景' }).value).toBe('保留我的场景修改')
    expect(h.props.save.mock.calls[0]?.[1]).toBe('revision-1')
    expect(h.inputActions.submit).not.toHaveBeenCalled()
  })

  it('adds a real uploaded image material and binds registered thumbnail references', async () => {
    const h = fixture()
    fireEvent.click(screen.getByRole('tab', { name: '素材' }))
    fireEvent.click(screen.getByRole('button', { name: '添加素材' }))
    const file = new File(['actual image bytes'], '新人物.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('上传素材'), { target: { files: [file] } })
    await waitFor(() => { expect(screen.getByRole('textbox', { name: '素材引用' }).getAttribute('value')).toBe('ma_test') })
    expect(h.props.upload).toHaveBeenCalledWith(file, expect.any(AbortSignal))
    fireEvent.click(screen.getByRole('button', { name: '保存设定' }))
    await waitFor(() => { expect(h.props.save).toHaveBeenCalledOnce() })
    expect(h.props.save.mock.calls[0]?.slice(0, 2)).toEqual(['cp_rain', 'revision-1'])
    expect(h.props.save.mock.calls[0]?.[2]).toMatchObject({ kind: 'asset',
      value: { name: '新人物.png', sourcePathOrAssetId: 'ma_test', kind: 'image' } })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    const referenceUrl = '/credits/api/creative/reference?session_id=session-a&project_id=cp_rain&asset_id=station'
    const data = project()
    act(() => { h.source.set({ ...h.source.getSnapshot(),
      projects: [project({ assets: data.assets.map(item => ({ ...item, referenceUrl })) })] }) })
    fireEvent.click(screen.getByRole('tab', { name: '人物' }))
    fireEvent.click(screen.getByRole('button', { name: '编辑设定' }))
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '车站参考' }).checked).toBe(true)
    expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe(referenceUrl)
  })

  it('filters real task statuses and output kinds with actual completed-shot progress', () => {
    const video = { id: 'out1' as CreativeOutputId, kind: 'video' as const, name: 'completed.mp4', url: mediaUrl() }
    const h = fixture({ projects: [project({ completedShots: 1, totalShots: 2, outputs: [video], tasks: [
      { id: 'task_failed', status: 'failed', shotIds: ['s1'], completedShots: 0, totalShots: 1, outputs: [], errorCode: 'VIDEO_FAILED' },
      { id: 'task_done', status: 'completed', shotIds: ['s1'], completedShots: 1, totalShots: 1, outputs: [video] },
    ] })] })
    fireEvent.click(screen.getByRole('tab', { name: '任务与产物' }))
    expect(screen.getByText('已完成 1 / 2 个镜头')).toBeTruthy()
    expect(h.view.container.querySelectorAll('[data-creative-task]')).toHaveLength(2)
    expect(h.view.container.querySelectorAll('video')).toHaveLength(1)
    expect(h.view.container.querySelector('[data-creative-task] details')?.hasAttribute('open')).toBe(false)
    fireEvent.change(screen.getByRole('combobox', { name: '任务状态' }), { target: { value: 'failed' } })
    expect(h.view.container.querySelector('[data-creative-task="task_done"]')).toBeNull()
    expect(h.view.container.querySelector('[data-creative-task="task_failed"]')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: '文件类型' }), { target: { value: 'image' } })
    expect(h.view.container.querySelector('video')).toBeNull()
    expect(screen.getByText('人声、口型与字幕同步：待核验')).toBeTruthy()
  })

  it('reports actual material outputs without displaying an invented zero-shot completion', () => {
    const image = { id: 'out1' as CreativeOutputId, kind: 'image' as const, name: 'character.png', url: mediaUrl() }
    const h = fixture({ projects: [project({ kind: 'image', shots: [], completedShots: 0, totalShots: 0,
      outputs: [image], tasks: [{ id: 'task_asset', status: 'completed', assetId: 'station', shotIds: [],
        completedShots: 0, totalShots: 0, outputs: [image] }] })] })
    fireEvent.click(screen.getByRole('tab', { name: '任务与作品' }))
    expect(screen.getAllByText('1 个产物')).toHaveLength(2)
    expect(screen.queryByText('已完成 0 / 0 个镜头')).toBeNull()
    expect(h.view.container.querySelector('progress')).toBeNull()
    expect(h.view.container.querySelector('[data-creative-task="task_asset"]')?.textContent).toContain('车站参考')
  })
})
