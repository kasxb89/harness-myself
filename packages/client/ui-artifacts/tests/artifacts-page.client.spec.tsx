// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { brandString } from '@deepseek-ai/dsh-brand'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PropsRenderSlots, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { ArtifactsMain } from '../src/client/ArtifactsMain.tsx'
import { ArtifactsPage, type ArtifactEntry, type ArtifactsInjected, type ArtifactsPageProps } from '../src/client/ArtifactsPage.tsx'
import type { ArtifactListing, ArtifactResult, ArtifactStorage, TrashedArtifact } from '../src/client/api.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})

it('shows usable files before delayed storage and recovery inventory finish', async () => {
  const storage = deferred<ArtifactResult<ArtifactStorage>>()
  const recovery = deferred<ArtifactResult<readonly TrashedArtifact[]>>()
  render(<ArtifactsPage {...props({ readStorage: () => storage.promise, readTrash: () => recovery.promise })} />)
  await selectImage()
  expect(screen.getByRole('region', { name: '预览' })).toBeTruthy()
  await act(async () => {
    storage.resolve({ ok: true, value: destination })
    recovery.resolve({ ok: true, value: [] })
  })
  expect(screen.getByRole('region', { name: '预览' })).toBeTruthy()
})

type PdfRenderer = PropsRenderSlots<'artifacts.preview.pdf'>['renderSlot']
/** The generic dispatcher narrows its concrete PDF owner before rendering the test view. */
function pdfView(owner: object) {
  if (!('url' in owner) || typeof owner.url !== 'string' || !('name' in owner) || typeof owner.name !== 'string') {
    throw new Error('PDF reader requires a name and URL')
  }
  return <section aria-label={owner.name} data-preview-url={owner.url} />
}

const renderPdf: PdfRenderer = (_key, owner) => pdfView(owner)

/** Record concrete dispatches behind an adapter that preserves the generic renderSlot signature. */
function recordedPdfRenderer() {
  const dispatch = vi.fn<(key: string, owner: object, options?: object) => void>()
  const renderSlot: PdfRenderer = (key, owner, options) => {
    dispatch(key, owner, options)
    return pdfView(owner)
  }
  return { dispatch, renderSlot }
}

const image: ArtifactEntry = { path: '/old/动漫.png', name: '动漫.png', kind: 'image', size: 128, mtimeMs: new Date(2026, 9, 17, 12, 0).getTime() }
const video: ArtifactEntry = { ...image, path: '/old/story.mp4', name: 'story.mp4', kind: 'video' }
const destination: ArtifactStorage = { directory: '/new/产物', defaultDirectory: '/initial/产物', revision: 3, roots: ['/old', '/new/产物'] }
const deleted: TrashedArtifact = { id: 'deleted-1', name: 'deleted.png', originalPath: '/old/deleted.png', deletedAt: '2026-10-17T04:00:00Z' }
const workspaceOne = { id: 'workspace-one', title: '动漫项目', path: 'D:\\动漫项目' }
const workspaceTwo = { id: 'workspace-two', title: '网站项目', path: '/projects/site' }

/** Deferred settlement places refresh and mutation races at a deterministic boundary. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** Product-owned copy and narrow operations, without Host filesystem or credentials. */
function props(overrides: Partial<ArtifactsPageProps> = {}): ArtifactsPageProps {
  return {
    active: true,
    pollIntervalMs: 5000,
    videoPosterTimeoutMs: 15_000,
    renderSlot: (_key, _owner, options) => options?.fallback ?? null,
    t: (key, values) => {
      const copy: Record<string, string> = zh
      return (copy[key] ?? key).replace(/\{(\w+)\}/gu, (_match, name: string) => values?.[name] ?? '')
    },
    readListing: vi.fn<ArtifactsInjected['readListing']>(async () => ({ ok: true, value: { items: [image, video], roots: ['/old'], truncated: false } })),
    readStorage: vi.fn<ArtifactsInjected['readStorage']>(async () => ({ ok: true, value: destination })),
    readTrash: vi.fn<ArtifactsInjected['readTrash']>(async () => ({ ok: true, value: [] })),
    readWorkspace: vi.fn<ArtifactsInjected['readWorkspace']>(async () => ({ ok: false, code: 'ARTIFACT_WORKSPACE_UNAVAILABLE' })),
    readRootDirectory: vi.fn<ArtifactsInjected['readRootDirectory']>(async () => ({ ok: false, code: 'ARTIFACT_PATH_FORBIDDEN' })),
    readDesktop: vi.fn(async () => false),
    readOrigin: vi.fn(async () => ({ ok: true as const, value: null })),
    returnToChat: vi.fn(async () => ({ ok: true as const, value: null })),
    reveal: vi.fn(async () => ({ ok: true as const, value: null })),
    refreshKey: '',
    workspaces: [workspaceOne, workspaceTwo],
    saveStorage: vi.fn<ArtifactsInjected['saveStorage']>(async directory => ({ ok: true, value: { ...destination, directory, revision: 4 } })),
    rename: vi.fn<ArtifactsInjected['rename']>(async (entry, name) => ({ ok: true, value: { ...entry, name, path: `/old/${name}` } })),
    trash: vi.fn<ArtifactsInjected['trash']>(async () => ({ ok: true, value: 'trash-1' })),
    restore: vi.fn<ArtifactsInjected['restore']>(async () => ({ ok: true, value: { ...image, name: deleted.name, path: deleted.originalPath } })),
    ...overrides,
  }
}

/** Wait for the initial listing and open one file's selected-preview actions. */
async function selectImage() {
  fireEvent.click(await screen.findByRole('button', { name: /^动漫\.png/u }))
  return screen.getByRole('region', { name: '预览' })
}

/** Wait for the save preference to load without exposing its path in the page. */
async function readyStorageButton() {
  const button = await screen.findByRole('button', { name: '保存目录' })
  await waitFor(() => { expect(button.hasAttribute('disabled')).toBe(false) })
  return button
}

describe('Artifacts page file management', () => {
  it.each([zh, en])('filters recorded finished and storyboard images without guessing filenames or widening workspace access', async (copy) => {
    const final: ArtifactEntry = { ...image, path: '/old/storyboard-001.png', name: 'storyboard-001.png', imageRole: 'final' }
    const shot: ArtifactEntry = { ...image, path: '/old/finished.png', name: 'finished.png', imageRole: 'storyboard' }
    const ordinary: ArtifactEntry = { ...image, path: '/old/storyboard-shot-final.png', name: 'storyboard-shot-final.png' }
    const revoked: ArtifactEntry = { ...shot, path: '/revoked/image.png', name: 'revoked.png', workspaceId: 'revoked' }
    render(<ArtifactsPage {...props({ t: key => copy[key as keyof typeof zh] ?? key,
      readListing: async () => ({ ok: true, value: { items: [video, final, shot, ordinary, revoked], roots: ['/old'], truncated: false } }),
    })} />)
    fireEvent.click(await screen.findByRole('button', { name: `${copy['kind.storyboard-image']}1` }))
    expect(screen.getByRole('button', { name: /^finished\.png/u })).toBeTruthy()
    for (const name of ['storyboard-001', 'storyboard-shot', 'revoked', '片段']) {
      expect(screen.queryByRole('button', { name: new RegExp(`^${name}`, 'u') })).toBeNull()
    }
    expect(screen.getByText(copy['imageRole.hint'])).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
    expect(screen.getByText(copy.noResults)).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: `${copy['kind.final-image']}1` }))
    expect(screen.getByRole('button', { name: /^storyboard-001/u })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^finished/u })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `${copy['kind.image']}3` }))
    for (const name of ['storyboard-001', 'storyboard-shot', 'finished']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${name}`, 'u') })).toBeTruthy()
    }
  })

  it.each([zh, en])('filters only recorded finished videos and storyboard clips while keeping search and all videos', async (copy) => {
    const final: ArtifactEntry = { ...video, path: '/old/clip-001.mp4', name: 'clip-001.mp4', videoRole: 'final' }
    const shot: ArtifactEntry = { ...video, path: '/old/finished.mp4', name: 'finished.mp4', videoRole: 'shot' }
    const ordinary: ArtifactEntry = { ...video, path: '/old/clip-002.mp4', name: 'clip-002.mp4' }
    const otherWorkspace: ArtifactEntry = { ...shot, path: '/revoked/video.mp4', name: 'revoked.mp4', workspaceId: 'revoked' }
    render(<ArtifactsPage {...props({ t: key => copy[key as keyof typeof zh] ?? key,
      readListing: async () => ({ ok: true, value: { items: [image, final, shot, ordinary, otherWorkspace], roots: ['/old'], truncated: false } }),
    })} />)
    fireEvent.click(await screen.findByRole('button', { name: `${copy['kind.storyboard']}1` }))
    expect(screen.getByRole('button', { name: /^finished\.mp4/u })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^clip-001/u })).toBeNull()
    expect(screen.queryByRole('button', { name: /^clip-002/u })).toBeNull()
    expect(screen.queryByRole('button', { name: /^revoked/u })).toBeNull()
    expect(screen.getByText(copy['videoRole.hint'])).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
    expect(screen.getByText(copy.noResults)).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: `${copy['kind.final-video']}1` }))
    expect(screen.getByRole('button', { name: /^clip-001/u })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^finished/u })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `${copy['kind.video']}3` }))
    for (const name of ['clip-001', 'clip-002', 'finished']) expect(screen.getByRole('button', { name: new RegExp(`^${name}`, 'u') })).toBeTruthy()
  })

  it('shows retained files and keeps the save path inside its on-demand dialog', async () => {
    render(<ArtifactsPage {...props({ readTrash: async () => ({ ok: true, value: [deleted] }) })} />)
    await readyStorageButton()
    expect(screen.queryByText(image.path)).toBeNull()
    expect(screen.getByRole('button', { name: /^动漫\.png/u }).getAttribute('title')).toBeNull()
    const snapshot = [screen.getByRole('heading').textContent, screen.getByRole('button', { name: '保存目录' }).textContent,
      screen.getByRole('searchbox').getAttribute('placeholder'), screen.getByRole('navigation').textContent,
      ...screen.getAllByRole('listitem').map(node => node.textContent)].join('\n') + '\n'
    await expect(snapshot).toMatchFileSnapshot('./expected/artifacts-page.txt')
    expect(screen.getByText('回收区（1 项）')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /永久/u })).toBeNull()
    expect(screen.queryByText(destination.directory)).toBeNull()
    const preview = await selectImage()
    const location = within(preview).getByText('文件位置')
    expect(location.closest('details')?.open).toBe(false)
    fireEvent.click(location)
    expect(location.closest('details')?.open).toBe(true)
    expect(within(preview).getByText(image.path)).toBeTruthy()
    fireEvent.click(location)
    expect(location.closest('details')?.open).toBe(false)
    fireEvent.click(location)
    fireEvent.click(screen.getByRole('button', { name: /^story\.mp4/u }))
    expect(within(preview).getByText('文件位置').closest('details')?.open).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '保存目录' }))
    const dialog = screen.getByRole('dialog', { name: '保存目录' })
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: '完整目录路径' }).value).toBe(destination.directory)
    expect(within(dialog).getByText(zh['storage.global'])).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText(destination.directory)).toBeNull()
  })

  it('combines case-insensitive name or path search with the selected file type and has a no-match state', async () => {
    render(<ArtifactsPage {...props()} />)
    await readyStorageButton()
    const search = screen.getByRole('searchbox', { name: '搜索名称或路径' })
    fireEvent.change(search, { target: { value: ' STORY ' } })
    expect(screen.queryByRole('button', { name: /^动漫\.png/u })).toBeNull()
    expect(screen.getByRole('button', { name: /^story\.mp4/u })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '图片1' }))
    expect(screen.getByText(zh.noResults)).toBeTruthy()
    fireEvent.change(search, { target: { value: '/OLD/' } })
    expect(screen.getByRole('button', { name: /^动漫\.png/u })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^story\.mp4/u })).toBeNull()
  })

  it('keeps listed files and their selected preview visible when refreshing fails', async () => {
    const readListing = vi.fn<ArtifactsInjected['readListing']>()
      .mockResolvedValueOnce({ ok: true, value: { items: [image], roots: ['/old'], truncated: false } })
      .mockResolvedValueOnce({ ok: false, code: 'ARTIFACT_OPERATION_FAILED' })
    render(<ArtifactsPage {...props({ readListing })} />)
    await selectImage()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await screen.findByText(zh['error.ARTIFACT_OPERATION_FAILED'])
    expect(screen.getByRole('button', { name: /^动漫\.png/u })).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '预览' })).getByText(image.name)).toBeTruthy()
  })

  it('clears a selection removed by a successful refresh', async () => {
    const readListing = vi.fn<ArtifactsInjected['readListing']>()
      .mockResolvedValueOnce({ ok: true, value: { items: [image], roots: ['/old'], truncated: false } })
      .mockResolvedValueOnce({ ok: true, value: { items: [], roots: ['/old'], truncated: false } })
    render(<ArtifactsPage {...props({ readListing })} />)
    await selectImage()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await screen.findByText(zh.empty)
    expect(screen.getByText(zh.previewHint)).toBeTruthy()
  })

  it('allows a browser user to enter a full save directory and submits the current revision only after Save', async () => {
    const face = props()
    render(<ArtifactsPage {...face} />)
    fireEvent.click(await screen.findByRole('button', { name: '保存目录' }))
    const dialog = screen.getByRole('dialog', { name: '保存目录' })
    expect(within(dialog).queryByRole('button', { name: '选择文件夹' })).toBeNull()
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'D:\\云枢产物' } })
    expect(face.saveStorage).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(face.saveStorage).toHaveBeenCalledExactlyOnceWith('D:\\云枢产物', 3) })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(face.rename).not.toHaveBeenCalled()
    expect(face.trash).not.toHaveBeenCalled()
  })

  it('leaves the entered directory intact when the native chooser is cancelled and never saves automatically', async () => {
    const pickDirectory = vi.fn(async () => null)
    const face = props({ pickDirectory })
    render(<ArtifactsPage {...face} />)
    fireEvent.click(await screen.findByRole('button', { name: '保存目录' }))
    const dialog = screen.getByRole('dialog')
    const field = within(dialog).getByRole<HTMLInputElement>('textbox')
    fireEvent.change(field, { target: { value: '/typed' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '选择文件夹' }))
    await waitFor(() => { expect(pickDirectory).toHaveBeenCalledOnce() })
    await waitFor(() => { expect(field.disabled).toBe(false) })
    expect(field.value).toBe('/typed')
    expect(face.saveStorage).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('uses the native choice as an editable draft and allows resetting to the initial directory', async () => {
    render(<ArtifactsPage {...props({ pickDirectory: async () => 'C:\\Users\\云枢' })} />)
    fireEvent.click(await screen.findByRole('button', { name: '保存目录' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '选择文件夹' }))
    await waitFor(() => { expect(within(dialog).getByRole<HTMLInputElement>('textbox').value).toBe('C:\\Users\\云枢') })
    fireEvent.click(within(dialog).getByRole('button', { name: '使用初始目录' }))
    expect(within(dialog).getByRole<HTMLInputElement>('textbox').value).toBe(destination.defaultDirectory)
  })

  it('keeps a directory draft after a stale preference and uses the refreshed revision when confirmed again', async () => {
    const saveStorage = vi.fn<ArtifactsInjected['saveStorage']>().mockResolvedValue({ ok: false, code: 'ARTIFACT_STALE' })
    const readStorage = vi.fn<ArtifactsInjected['readStorage']>()
      .mockResolvedValueOnce({ ok: true, value: destination })
      .mockResolvedValue({ ok: true, value: { ...destination, revision: 9 } })
    render(<ArtifactsPage {...props({ saveStorage, readStorage })} />)
    fireEvent.click(await screen.findByRole('button', { name: '保存目录' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '/draft' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await within(dialog).findByText(zh['error.ARTIFACT_STALE'])
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(readStorage).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(screen.getAllByRole('button', { name: '刷新' })[0]!.hasAttribute('disabled')).toBe(false) })
    expect(within(dialog).getByRole<HTMLInputElement>('textbox').value).toBe('/draft')
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(saveStorage).toHaveBeenLastCalledWith('/draft', 9) })
  })

  it('preserves a conflicting rename draft and original file until a later rename succeeds', async () => {
    const renamed = { ...image, name: '新剧情.png', path: '/old/新剧情.png' }
    const rename = vi.fn<ArtifactsInjected['rename']>()
      .mockResolvedValueOnce({ ok: false, code: 'ARTIFACT_CONFLICT' }).mockResolvedValueOnce({ ok: true, value: renamed })
    const readListing = vi.fn<ArtifactsInjected['readListing']>()
      .mockResolvedValueOnce({ ok: true, value: { items: [image], roots: ['/old'], truncated: false } })
      .mockResolvedValue({ ok: true, value: { items: [renamed], roots: ['/old'], truncated: false } })
    render(<ArtifactsPage {...props({ rename, readListing })} />)
    fireEvent.click(within(await selectImage()).getByRole('button', { name: '重命名' }))
    const dialog = screen.getByRole('dialog', { name: '重命名产物' })
    const field = within(dialog).getByRole<HTMLInputElement>('textbox', { name: '文件名' })
    fireEvent.change(field, { target: { value: '占用.png' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '重命名' }))
    await within(dialog).findByText(zh['error.ARTIFACT_CONFLICT'])
    expect(field.value).toBe('占用.png')
    expect(screen.getByRole('button', { name: /^动漫\.png/u })).toBeTruthy()
    fireEvent.change(field, { target: { value: renamed.name } })
    fireEvent.click(within(dialog).getByRole('button', { name: '重命名' }))
    await screen.findByRole('button', { name: /^新剧情\.png/u })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(within(screen.getByRole('region', { name: '预览' })).getByText(renamed.name)).toBeTruthy()
  })

  it('does not submit a filename when Enter commits IME composition', async () => {
    const face = props()
    render(<ArtifactsPage {...face} />)
    fireEvent.click(within(await selectImage()).getByRole('button', { name: '重命名' }))
    const field = screen.getByRole('textbox', { name: '文件名' })
    fireEvent.compositionStart(field)
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.compositionEnd(field)
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    expect(face.rename).not.toHaveBeenCalled()
  })

  it('requires deletion confirmation and serializes mutations while a confirmed deletion is pending', async () => {
    const receipt = deferred<ArtifactResult<string>>()
    const trash = vi.fn<ArtifactsInjected['trash']>(() => receipt.promise)
    const readListing = vi.fn<ArtifactsInjected['readListing']>()
      .mockResolvedValueOnce({ ok: true, value: { items: [image], roots: ['/old'], truncated: false } })
      .mockResolvedValue({ ok: true, value: { items: [], roots: ['/old'], truncated: false } })
    const face = props({ trash, readListing, readTrash: async () => ({ ok: true, value: [deleted] }) })
    render(<ArtifactsPage {...face} />)
    const preview = await selectImage()
    fireEvent.click(within(preview).getByRole('button', { name: '删除' }))
    expect(trash).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    expect(trash).not.toHaveBeenCalled()
    fireEvent.click(within(preview).getByRole('button', { name: '删除' }))
    const dialog = screen.getByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: '删除' })
    fireEvent.click(confirm); fireEvent.click(confirm)
    expect(trash).toHaveBeenCalledExactlyOnceWith(image)
    expect(within(dialog).getByRole('button', { name: '取消' }).hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => { receipt.resolve({ ok: true, value: 'trash-1' }) })
    await screen.findByText(zh.empty)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText(zh.previewHint)).toBeTruthy()
  })

  it('requires a successful refresh after an unconfirmed mutation and never retries it automatically', async () => {
    const trash = vi.fn<ArtifactsInjected['trash']>().mockResolvedValue({ ok: false, code: 'ARTIFACT_OPERATION_UNKNOWN' })
    render(<ArtifactsPage {...props({ trash })} />)
    fireEvent.click(within(await selectImage()).getByRole('button', { name: '删除' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    await within(dialog).findByText(zh['error.ARTIFACT_OPERATION_UNKNOWN'])
    expect(trash).toHaveBeenCalledOnce()
    expect(within(dialog).getByRole('button', { name: '删除' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(within(dialog).getByRole('button', { name: '删除' }).hasAttribute('disabled')).toBe(false) })
    expect(trash).toHaveBeenCalledOnce()
    expect(within(dialog).queryByText(zh['error.ARTIFACT_OPERATION_UNKNOWN'])).toBeNull()
  })

  it('keeps a recovery conflict visible and restores a persisted deletion only after an explicit click', async () => {
    const restore = vi.fn<ArtifactsInjected['restore']>()
      .mockResolvedValueOnce({ ok: false, code: 'ARTIFACT_CONFLICT' })
      .mockResolvedValueOnce({ ok: true, value: { ...image, name: deleted.name, path: deleted.originalPath } })
    const readTrash = vi.fn<ArtifactsInjected['readTrash']>()
      .mockResolvedValueOnce({ ok: true, value: [deleted] }).mockResolvedValue({ ok: true, value: [] })
    render(<ArtifactsPage {...props({ restore, readTrash })} />)
    await screen.findByText('回收区（1 项）')
    fireEvent.click(screen.getByText('回收区（1 项）'))
    expect(restore).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    await screen.findByText(zh['error.ARTIFACT_CONFLICT'])
    expect(screen.getByText(deleted.name)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    await screen.findByText('回收区（0 项）')
    expect(restore).toHaveBeenCalledTimes(2)
  })

  it('aborts page reads on unmount and ignores their late results after a new page mounts', async () => {
    const oldRead = deferred<ArtifactResult<ArtifactListing>>()
    const readListing = vi.fn<ArtifactsInjected['readListing']>(() => oldRead.promise)
    const old = render(<ArtifactsPage {...props({ readListing })} />)
    const signal = readListing.mock.calls[0]![0]
    old.unmount()
    expect(signal.aborted).toBe(true)
    render(<ArtifactsPage {...props()} />)
    await readyStorageButton()
    await act(async () => { oldRead.resolve({ ok: true, value: { items: [], roots: [], truncated: false } }) })
    expect(screen.getByRole('button', { name: /^动漫\.png/u })).toBeTruthy()
  })

  it('discards a refresh superseded by a successful file mutation', async () => {
    const stale = deferred<ArtifactResult<ArtifactListing>>()
    const renamed = { ...image, path: '/old/new.png', name: 'new.png' }
    const readListing = vi.fn<ArtifactsInjected['readListing']>()
      .mockResolvedValueOnce({ ok: true, value: { items: [image], roots: ['/old'], truncated: false } })
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValue({ ok: true, value: { items: [renamed], roots: ['/old'], truncated: false } })
    render(<ArtifactsPage {...props({ readListing, rename: async () => ({ ok: true, value: renamed }) })} />)
    const preview = await selectImage()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    fireEvent.click(within(preview).getByRole('button', { name: '重命名' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'new.png' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '重命名' }))
    await screen.findByRole('button', { name: /^new\.png/u })
    expect(readListing.mock.calls[1]![0].aborted).toBe(true)
    await act(async () => { stale.resolve({ ok: true, value: { items: [image], roots: ['/old'], truncated: false } }) })
    expect(screen.queryByRole('button', { name: /^动漫\.png/u })).toBeNull()
    expect(screen.getByRole('button', { name: /^new\.png/u })).toBeTruthy()
  })

  it.each(['html', 'svg'])('sandboxes %s preview content so generated documents cannot manage files', async (extension) => {
    const entry: ArtifactEntry = { ...image, name: `untrusted.${extension}`, path: `/old/untrusted.${extension}`, kind: extension === 'svg' ? 'image' : 'code' }
    render(<ArtifactsPage {...props({ readListing: async () => ({ ok: true, value: { items: [entry], roots: ['/old'], truncated: false } }) })} />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^untrusted\\.${extension}`, 'u') }))
    const frame = screen.getByTitle(entry.name)
    expect(frame.tagName).toBe('IFRAME')
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('src')).toBe(`/artifacts/api/raw?path=${encodeURIComponent(entry.path)}`)
  })

  it('keeps all product copy bilingual and scopes desktop clearance to the artifacts page', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    const css = readFileSync('packages/client/ui-artifacts/src/client/ArtifactsPage.module.css', 'utf8')
    expect(css).toContain(":global([data-platform='darwin']) .page")
    expect(css).toContain('padding-top: calc(var(--dsh-frame-top-clearance) + 16px)')
    expect(css).toContain('@media (max-width: 720px)')
  })
})

describe('selected document refresh', () => {
  let createDescriptor: PropertyDescriptor | undefined
  let revokeDescriptor: PropertyDescriptor | undefined
  const create = vi.fn<(blob: Blob) => string>()
  const revoke = vi.fn<(url: string) => void>()
  const document: ArtifactEntry = { ...image, name: 'report.docx', path: '/old/report.docx', kind: 'document' }

  beforeEach(() => {
    createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    create.mockReset().mockImplementation(() => `blob:https://preview.invalid/revision-${create.mock.calls.length}`)
    revoke.mockReset()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    if (createDescriptor === undefined) Reflect.deleteProperty(URL, 'createObjectURL')
    else Object.defineProperty(URL, 'createObjectURL', createDescriptor)
    if (revokeDescriptor === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL')
    else Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor)
  })

  it('retries a failed Office preview after an explicit refresh even when its metadata is unchanged', async () => {
    const readListing = vi.fn<ArtifactsInjected['readListing']>(async () => ({ ok: true, value: { items: [document], roots: ['/old'], truncated: false } }))
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'preview-unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('%PDF-1.7\n%%EOF\n', { headers: { 'content-type': 'application/pdf' } }))
    vi.stubGlobal('fetch', fetcher)
    render(<ArtifactsPage {...props({ readListing, renderSlot: renderPdf })} />)
    fireEvent.click(await screen.findByRole('button', { name: /^report\.docx/u }))
    await screen.findByText(zh['preview.unavailable'])
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    const reader = await screen.findByRole('region', { name: document.name })
    expect(reader.getAttribute('data-preview-url')).toBe('blob:https://preview.invalid/revision-1')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(readListing).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(zh['preview.unavailable'])).toBeNull()
    expect(within(screen.getByRole('region', { name: '预览' })).getByText(document.name)).toBeTruthy()
  })

  it.each(['size', 'mtimeMs'] as const)('retains selection and replaces the PDF when same-path %s changes during a background read', async (metadata) => {
    const face = props({ renderSlot: renderPdf, readListing: async () => ({ ok: true, value: { items: [document], roots: ['/old'], truncated: false } }) })
    const fetcher = vi.fn<typeof fetch>(async () => new Response('%PDF-1.7\n%%EOF\n', { headers: { 'content-type': 'application/pdf' } }))
    vi.stubGlobal('fetch', fetcher)
    const page = render(<ArtifactsPage {...face} />)
    fireEvent.click(await screen.findByRole('button', { name: /^report\.docx/u }))
    expect((await screen.findByRole('region', { name: document.name })).getAttribute('data-preview-url')).toBe('blob:https://preview.invalid/revision-1')
    const changed = { ...document, [metadata]: document[metadata] + 1024 }
    const readListing = vi.fn<ArtifactsInjected['readListing']>(async () => ({ ok: true, value: { items: [changed], roots: ['/old'], truncated: false } }))
    page.rerender(<ArtifactsPage {...face} readListing={readListing} />)
    await waitFor(() => { expect(screen.getByRole('region', { name: document.name }).getAttribute('data-preview-url')).toBe('blob:https://preview.invalid/revision-2') })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:https://preview.invalid/revision-1')
    expect(within(screen.getByRole('region', { name: '预览' })).getByText(document.name)).toBeTruthy()
    expect(screen.queryByText(zh.previewHint)).toBeNull()
  })
})

describe('unified artifact library', () => {
  it('keeps a deep finder-selected file through focus reads, but requires a fresh lookup after explicit refresh', async () => {
    const deep = { ...image, path: '/old/one/two/three/four/five/six/动漫.png' }
    const readRootDirectory = vi.fn<ArtifactsInjected['readRootDirectory']>(async (root, directory) => ({ ok: true, value: {
      root, directory, absoluteDirectory: root, parentDirectory: null, directories: [], items: [deep],
      truncated: false, offset: 0, nextOffset: null,
    } }))
    const readListing = vi.fn<ArtifactsInjected['readListing']>(async () => ({ ok: true,
      value: { items: [], roots: ['/old'], truncated: true } }))
    render(<ArtifactsPage {...props({ readListing, readRootDirectory })} />)
    fireEvent.click(await screen.findByRole('button', { name: '查找未列出的文件' }))
    const finder = screen.getByRole('dialog', { name: '查找未列出的文件' })
    fireEvent.click(await within(finder).findByRole('button', { name: deep.name }))
    expect(screen.queryByRole('dialog')).toBeNull()
    const preview = screen.getByRole('region', { name: '预览' })
    expect(within(preview).getByRole('img').getAttribute('src')).toContain(encodeURIComponent(deep.path))
    fireEvent(window, new Event('focus'))
    await waitFor(() => { expect(readListing).toHaveBeenCalledTimes(2) })
    expect(within(preview).getByRole('img')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await screen.findByText(zh['finder.refreshNotice'])
    expect(screen.queryByRole('button', { name: /^动漫\.png/u })).toBeNull()
    expect(screen.getByText(zh.previewHint)).toBeTruthy()
    readRootDirectory.mockResolvedValueOnce({ ok: true, value: {
      root: '/old', directory: '', absoluteDirectory: '/old', parentDirectory: null, directories: [],
      items: [{ ...deep, size: 999, mtimeMs: 2 }], truncated: false, offset: 0, nextOffset: null,
    } })
    fireEvent.click(screen.getByRole('button', { name: '查找未列出的文件' }))
    fireEvent.click(await within(screen.getByRole('dialog')).findByRole('button', { name: deep.name }))
    expect(screen.queryByText(zh['finder.refreshNotice'])).toBeNull()
    expect(within(preview).getByText(/999 B/u)).toBeTruthy()
  })

  it('waits for authorized refreshed coordinates before selecting a restored workspace image without trash workspace metadata', async () => {
    const next = deferred<ArtifactResult<ArtifactListing>>()
    const restored = { ...image, workspaceId: workspaceOne.id, path: workspaceOne.path + '\\deep\\restored.png', name: 'restored.png' }
    const readListing = vi.fn<ArtifactsInjected['readListing']>()
      .mockResolvedValueOnce({ ok: true, value: { items: [], roots: ['/old'], truncated: true } })
      .mockImplementationOnce(() => next.promise)
    const readTrash = vi.fn<ArtifactsInjected['readTrash']>()
      .mockResolvedValueOnce({ ok: true, value: [{ ...deleted, name: restored.name }] }).mockResolvedValue({ ok: true, value: [] })
    const face = props({ readListing, readTrash, restore: async () => ({ ok: true, value: restored }) })
    render(<ArtifactsPage {...face} />)
    fireEvent.click(await screen.findByText('回收区（1 项）'))
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() => { expect(readListing).toHaveBeenCalledTimes(2) })
    expect(screen.queryByRole('img', { name: restored.name })).toBeNull()
    await act(async () => { next.resolve({ ok: true, value: { items: [], roots: ['/old'], truncated: true } }) })
    const preview = screen.getByRole('region', { name: '预览' })
    await within(preview).findByRole('img', { name: restored.name })
    expect(within(preview).getByRole('img').getAttribute('src')).toContain('&workspaceId=workspace-one')
  })

  it('remounts a failed media preview when refreshed coordinates acquire workspace authorization', async () => {
    const face = props({ readListing: async () => ({ ok: true, value: { items: [image], roots: ['/old'], truncated: false } }) })
    const page = render(<ArtifactsPage {...face} />)
    const preview = await selectImage()
    fireEvent.error(within(preview).getByRole('img'))
    await within(preview).findByText(zh['preview.invalid'])
    const authorized = { ...image, workspaceId: workspaceOne.id }
    page.rerender(<ArtifactsPage {...face} readListing={async () => ({ ok: true,
      value: { items: [authorized], roots: ['/old'], truncated: false } })} />)
    await screen.findByRole('button', { name: /^动漫\.png/u })
    fireEvent.click(screen.getByRole('button', { name: /^动漫\.png/u }))
    expect(within(preview).getByRole('img').getAttribute('src')).toContain('&workspaceId=workspace-one')
    expect(within(preview).queryByText(zh['preview.invalid'])).toBeNull()
  })

  it('keeps one library without workspace tabs, selectors, or a second empty-state destination', async () => {
    const face = props({ readListing: async () => ({ ok: true, value: { items: [], roots: [], truncated: false } }) })
    render(<ArtifactsPage {...face} />)
    await screen.findByText(zh.empty)
    expect(screen.getByRole('heading', { name: '产物库' })).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByText(workspaceOne.path)).toBeNull()
    expect(screen.queryByText(destination.directory)).toBeNull()
    expect(screen.queryByRole('button', { name: '查看工作区文件' })).toBeNull()
  })

  it('keeps readable files and their previews beside localized partial-source and scan-limit warnings', async () => {
    const face = props({ readListing: async () => ({ ok: true, value: { items: [image], roots: ['/old'], truncated: true,
      issues: [{ workspaceId: 'unreadable-project', title: '共享项目', code: 'ARTIFACT_PERMISSION_DENIED' }] } }) })
    render(<ArtifactsPage {...face} />)
    const preview = await selectImage()
    const warning = screen.getByRole('status', { name: zh['source.issues'] })
    expect(warning.textContent).toContain('共享项目')
    expect(warning.textContent).toContain(zh['error.ARTIFACT_PERMISSION_DENIED'])
    expect(within(preview).getByRole('img').getAttribute('src')).toContain(encodeURIComponent(image.path))
    expect(screen.getByText(zh.truncated)).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('previews and manages indexed workspace output in the same library with its workspace authorization', async () => {
    const output: ArtifactEntry = { ...image, path: 'D:\\动漫项目\\输出\\动漫.png', workspaceId: workspaceOne.id }
    const face = props({ readListing: async () => ({ ok: true, value: { items: [output], roots: ['/old'], truncated: false } }),
      rename: vi.fn(async () => ({ ok: false as const, code: 'ARTIFACT_CONFLICT' as const })) })
    render(<ArtifactsPage {...face} />)
    const preview = await selectImage()
    expect(within(preview).getByRole('img').getAttribute('src')).toBe(`/artifacts/api/raw?path=${encodeURIComponent(output.path)}&workspaceId=workspace-one`)
    fireEvent.click(within(preview).getByRole('button', { name: '重命名' }))
    fireEvent.change(screen.getByRole('textbox', { name: '文件名' }), { target: { value: '新图.png' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '重命名' }))
    await screen.findByText(zh['error.ARTIFACT_CONFLICT'])
    expect(face.rename).toHaveBeenCalledExactlyOnceWith(output, '新图.png')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    fireEvent.click(within(preview).getByRole('button', { name: '删除' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }))
    await waitFor(() => { expect(face.trash).toHaveBeenCalledExactlyOnceWith(output) })
  })

  it('keeps native reveal and unavailable workspace recovery in the single library', async () => {
    const face = props({ readDesktop: async () => true,
      readTrash: async () => ({ ok: true, value: [{ ...deleted, workspaceRoot: workspaceOne.path }] }),
      restore: vi.fn(async () => ({ ok: false as const, code: 'ARTIFACT_WORKSPACE_UNAVAILABLE' as const })) })
    render(<ArtifactsPage {...face} />)
    fireEvent.click(within(await selectImage()).getByRole('button', { name: '打开所在目录' }))
    await waitFor(() => { expect(face.reveal).toHaveBeenCalledExactlyOnceWith(image.path) })
    fireEvent.click(screen.getByText('回收区（1 项）'))
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    await screen.findByText(zh['error.ARTIFACT_WORKSPACE_UNAVAILABLE'])
    expect(screen.getByText(deleted.name)).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('discovers an independent background output while the conversation and workspace revision stays unchanged', async () => {
    vi.useFakeTimers()
    const readListing = vi.fn<ArtifactsInjected['readListing']>()
      .mockResolvedValueOnce({ ok: true, value: { items: [image], roots: ['/old'], truncated: false } })
      .mockResolvedValue({ ok: true, value: { items: [image, video], roots: ['/old'], truncated: false } })
    render(<ArtifactsPage {...props({ readListing, refreshKey: 'session-one:running' })} />)
    await act(async () => {})
    expect(screen.queryByRole('button', { name: /^story\.mp4/u })).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(readListing).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: /^story\.mp4/u })).toBeTruthy()
  })

  it('coalesces timer and focus checks during a slow read and retains files, selection and the reported failure', async () => {
    vi.useFakeTimers()
    const next = deferred<ArtifactResult<ArtifactListing>>()
    const readListing = vi.fn<ArtifactsInjected['readListing']>()
      .mockResolvedValueOnce({ ok: true, value: { items: [image], roots: ['/old'], truncated: false } })
      .mockImplementationOnce(() => next.promise)
      .mockResolvedValue({ ok: true, value: { items: [image, video], roots: ['/old'], truncated: false } })
    render(<ArtifactsPage {...props({ readListing })} />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: /^动漫\.png/u }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    const signal = readListing.mock.calls[1]![0]
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    fireEvent(window, new Event('focus'))
    fireEvent(window, new Event('focus'))
    expect(readListing).toHaveBeenCalledTimes(2)
    expect(signal.aborted).toBe(false)
    await act(async () => { next.resolve({ ok: false, code: 'ARTIFACT_OPERATION_FAILED' }) })
    expect(screen.getByText(zh['error.ARTIFACT_OPERATION_FAILED'])).toBeTruthy()
    expect(screen.getByRole('button', { name: /^动漫\.png/u })).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '预览' })).getByText(image.name)).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(4999) })
    expect(screen.getByText(zh['error.ARTIFACT_OPERATION_FAILED'])).toBeTruthy()
    expect(readListing).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(readListing).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('button', { name: /^story\.mp4/u })).toBeTruthy()
  })

  it('stops library checks for another main panel or a hidden window and aborts pending work on unmount', async () => {
    vi.useFakeTimers()
    const next = deferred<ArtifactResult<ArtifactListing>>()
    const readListing = vi.fn<ArtifactsInjected['readListing']>()
      .mockResolvedValue({ ok: true, value: { items: [image], roots: ['/old'], truncated: false } })
    const face = props({ readListing })
    const page = render(<ArtifactsPage {...face} />)
    await act(async () => {})
    page.rerender(<ArtifactsPage {...face} active={false} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    fireEvent(window, new Event('focus'))
    expect(readListing).toHaveBeenCalledOnce()
    page.rerender(<ArtifactsPage {...face} active />)
    await act(async () => {})
    expect(readListing).toHaveBeenCalledTimes(2)
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(readListing).toHaveBeenCalledTimes(2)
    visibility.mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => {})
    expect(readListing).toHaveBeenCalledTimes(3)
    readListing.mockImplementationOnce(() => next.promise)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    const signal = readListing.mock.calls[3]![0]
    expect(signal.aborted).toBe(false)
    page.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => { next.resolve({ ok: true, value: { items: [video], roots: ['/old'], truncated: false } }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    fireEvent(window, new Event('focus'))
    fireEvent(document, new Event('visibilitychange'))
    expect(readListing).toHaveBeenCalledTimes(4)
  })

  it('aborts a hidden-window read and discards its late response before resuming in the foreground', async () => {
    vi.useFakeTimers()
    const next = deferred<ArtifactResult<ArtifactListing>>()
    const readListing = vi.fn<ArtifactsInjected['readListing']>()
      .mockResolvedValueOnce({ ok: true, value: { items: [image], roots: ['/old'], truncated: false } })
      .mockImplementationOnce(() => next.promise)
      .mockResolvedValue({ ok: true, value: { items: [image, video], roots: ['/old'], truncated: false } })
    render(<ArtifactsPage {...props({ readListing })} />)
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    fireEvent(document, new Event('visibilitychange'))
    expect(readListing.mock.calls[1]![0].aborted).toBe(true)
    await act(async () => { next.resolve({ ok: true, value: { items: [], roots: ['/old'], truncated: false } }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(screen.getByRole('button', { name: /^动漫\.png/u })).toBeTruthy()
    expect(readListing).toHaveBeenCalledTimes(2)
    visibility.mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => {})
    expect(readListing).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('button', { name: /^story\.mp4/u })).toBeTruthy()
  })

  it('refreshes when returning to the foreground, coalesces pending focus reads, and stops after unmount', async () => {
    const next = deferred<ArtifactResult<ArtifactListing>>()
    const readListing = vi.fn<ArtifactsInjected['readListing']>()
      .mockResolvedValueOnce({ ok: true, value: { items: [image], roots: ['/old'], truncated: false } })
      .mockImplementationOnce(() => next.promise)
      .mockResolvedValue({ ok: true, value: { items: [image, video], roots: ['/old'], truncated: false } })
    const page = render(<ArtifactsPage {...props({ readListing })} />)
    await selectImage()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    fireEvent(document, new Event('visibilitychange'))
    fireEvent(window, new Event('focus'))
    expect(readListing).toHaveBeenCalledOnce()
    visibility.mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    fireEvent(window, new Event('focus'))
    expect(readListing).toHaveBeenCalledTimes(2)
    await act(async () => { next.resolve({ ok: true, value: { items: [image, video], roots: ['/old'], truncated: false } }) })
    expect(screen.getByRole('button', { name: /^story\.mp4/u })).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '预览' })).getByText(image.name)).toBeTruthy()
    page.unmount()
    fireEvent(window, new Event('focus'))
    expect(readListing).toHaveBeenCalledTimes(2)
  })

  it('discards an older library read after conversation activity triggers a newer one', async () => {
    const older = deferred<ArtifactResult<ArtifactListing>>()
    const readListing = vi.fn<ArtifactsInjected['readListing']>()
      .mockResolvedValueOnce({ ok: true, value: { items: [image], roots: ['/old'], truncated: false } })
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValue({ ok: true, value: { items: [image, video], roots: ['/old'], truncated: false } })
    const face = props({ readListing })
    const page = render(<ArtifactsPage {...face} />)
    await selectImage()
    fireEvent(window, new Event('focus'))
    const pending = readListing.mock.calls[1]![0]
    page.rerender(<ArtifactsPage {...face} refreshKey="conversation-completed" />)
    await screen.findByRole('button', { name: /^story\.mp4/u })
    expect(pending.aborted).toBe(true)
    await act(async () => { older.resolve({ ok: true, value: { items: [], roots: ['/old'], truncated: false } }) })
    expect(screen.getByRole('button', { name: /^story\.mp4/u })).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '预览' })).getByText(image.name)).toBeTruthy()
  })

  it('does not clear an unconfirmed mutation lock on an automatic foreground refresh', async () => {
    const face = props({ trash: vi.fn(async () => ({ ok: false as const, code: 'ARTIFACT_OPERATION_UNKNOWN' as const })) })
    render(<ArtifactsPage {...face} />)
    fireEvent.click(within(await selectImage()).getByRole('button', { name: '删除' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }))
    await within(screen.getByRole('dialog')).findByText(zh['error.ARTIFACT_OPERATION_UNKNOWN'])
    fireEvent(window, new Event('focus'))
    await waitFor(() => { expect(face.readListing).toHaveBeenCalledTimes(2) })
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }).hasAttribute('disabled')).toBe(true)
    expect(face.trash).toHaveBeenCalledOnce()
  })

  it('passes the PDF renderer through Main and refreshes unified output after conversation completion or workspace changes', async () => {
    const document: ArtifactEntry = { ...image, name: '剧情.pdf', path: '/old/剧情.pdf', kind: 'document' }
    const { dispatch, renderSlot } = recordedPdfRenderer()
    const readListing = vi.fn<ArtifactsInjected['readListing']>(async () => ({ ok: true,
      value: { items: [document], roots: ['/old'], truncated: false } }))
    const face = props({ renderSlot, readListing })
    const binding = createSnapshotStore<StandardSourceBinding>({ key: 'session-one', props: {}, hooks: {}, keyedHooks: {} })
    const snapshot: WorkspaceSnapshot = { phase: 'ready', state: 'idle', error: null, archivedSessionIds: [], pinnedSessionIds: [],
      items: [workspaceOne, workspaceTwo].map((item, index) => ({
        workspaceId: brandString<WorkspaceSnapshot['items'][number]['workspaceId']>(item.id), title: item.title, path: item.path,
        sessionIds: [brandString<WorkspaceSnapshot['items'][number]['sessionIds'][number]>(index === 0 ? 'session-one' : 'session-two')],
        createdAt: '', updatedAt: '',
      })) }
    const workspaces = createSnapshotStore(snapshot)
    const sessionId = brandString<WorkspaceSnapshot['items'][number]['sessionIds'][number]>('session-one')
    const statuses = createSnapshotStore<SessionStatusSnapshot>(new Map([[sessionId, {
      running: true, pendingInteraction: undefined, completionUnread: false,
    }]]))
    render(<ArtifactsMain {...face} useArtifactSession={bindSnapshotSelector(binding)} useWorkspaces={bindSnapshotSelector(workspaces)}
      usePanelInfo={selector => selector({ activePanelId: brandString<MainPanelId>('artifacts') })}
      useSessionStatus={bindSnapshotSelector(statuses)} />)
    await readyStorageButton()
    fireEvent.click(await screen.findByRole('button', { name: /^剧情\.pdf/u }))
    expect(screen.getByRole('region', { name: document.name }).getAttribute('data-preview-url'))
      .toBe(`/artifacts/api/raw?path=${encodeURIComponent(document.path)}`)
    expect(dispatch).toHaveBeenCalledWith('artifacts.preview.pdf', {
      url: `/artifacts/api/raw?path=${encodeURIComponent(document.path)}`, name: document.name,
    }, expect.objectContaining({ entryKey: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/artifact-pdf' }))
    expect(readListing).toHaveBeenCalledOnce()
    act(() => { statuses.set(new Map([[sessionId, { running: false, pendingInteraction: undefined, completionUnread: true }]])) })
    await waitFor(() => { expect(readListing).toHaveBeenCalledTimes(2) })
    act(() => { binding.set({ ...binding.getSnapshot(), key: 'session-two' }) })
    await waitFor(() => { expect(readListing).toHaveBeenCalledTimes(3) })
    act(() => { workspaces.set({ ...snapshot, items: [] }) })
    await waitFor(() => { expect(readListing).toHaveBeenCalledTimes(4) })
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('tablist')).toBeNull()
  })
})
