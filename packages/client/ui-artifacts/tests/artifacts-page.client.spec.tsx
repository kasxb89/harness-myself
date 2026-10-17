// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { ArtifactsMain } from '../src/client/ArtifactsMain.tsx'
import { ArtifactsPage, type ArtifactEntry, type ArtifactsInjected, type ArtifactsPageProps } from '../src/client/ArtifactsPage.tsx'
import type { ArtifactListing, ArtifactResult, ArtifactStorage, TrashedArtifact, WorkspaceListing } from '../src/client/api.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const image: ArtifactEntry = { path: '/old/动漫.png', name: '动漫.png', kind: 'image', size: 128, mtimeMs: new Date(2026, 9, 17, 12, 0).getTime() }
const video: ArtifactEntry = { ...image, path: '/old/story.mp4', name: 'story.mp4', kind: 'video' }
const destination: ArtifactStorage = { directory: '/new/产物', defaultDirectory: '/initial/产物', revision: 3, roots: ['/old', '/new/产物'] }
const deleted: TrashedArtifact = { id: 'deleted-1', name: 'deleted.png', originalPath: '/old/deleted.png', deletedAt: '2026-10-17T04:00:00Z' }
const workspaceOne = { id: 'workspace-one', title: '动漫项目', path: 'D:\\动漫项目' }
const workspaceTwo = { id: 'workspace-two', title: '网站项目', path: '/projects/site' }

/** Directory responses use Host-native absolute paths and portable relative navigation. */
function workspaceListing(id = workspaceOne.id, directory = ''): WorkspaceListing {
  const workspace = id === workspaceTwo.id ? workspaceTwo : { ...workspaceOne, id }
  return { workspace, directory, absoluteDirectory: `${workspace.path}${directory ? '/' + directory : ''}`,
    parentDirectory: directory === '' ? null : directory.split('/').slice(0, -1).join('/'),
    directories: directory === '' ? [{ name: '输出', directory: '输出' }] : [],
    items: [{ ...image, path: `${workspace.path}/${directory ? directory + '/' : ''}${image.name}`, workspaceId: id }], truncated: false }
}

/** Registered workspace choices remain distinct from the global generated-output destination. */
function workspaceProps(overrides: Partial<ArtifactsPageProps> = {}): ArtifactsPageProps {
  return props({ workspaces: { items: [workspaceOne, workspaceTwo], currentWorkspaceId: workspaceOne.id,
    currentSessionKey: 'session-one', ready: true },
  readWorkspace: vi.fn<ArtifactsInjected['readWorkspace']>(async (id, directory) => ({ ok: true, value: workspaceListing(id, directory) })), ...overrides })
}

/** Deferred settlement places refresh and mutation races at a deterministic boundary. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** Product-owned copy and narrow operations, without Host filesystem or credentials. */
function props(overrides: Partial<ArtifactsPageProps> = {}): ArtifactsPageProps {
  return {
    t: (key, values) => {
      const copy: Record<string, string> = zh
      return (copy[key] ?? key).replace(/\{(\w+)\}/gu, (_match, name: string) => values?.[name] ?? '')
    },
    readListing: vi.fn<ArtifactsInjected['readListing']>(async () => ({ ok: true, value: { items: [image, video], roots: ['/old'], truncated: false } })),
    readStorage: vi.fn<ArtifactsInjected['readStorage']>(async () => ({ ok: true, value: destination })),
    readTrash: vi.fn<ArtifactsInjected['readTrash']>(async () => ({ ok: true, value: [] })),
    readWorkspace: vi.fn<ArtifactsInjected['readWorkspace']>(async () => ({ ok: false, code: 'ARTIFACT_WORKSPACE_UNAVAILABLE' })),
    readDesktop: vi.fn(async () => false),
    reveal: vi.fn(async () => ({ ok: true as const, value: null })),
    workspaces: { items: [], currentWorkspaceId: null, currentSessionKey: null, ready: true },
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

describe('Artifacts page file management', () => {
  it('shows the actual future-save directory, retained files, and recoverable deletions', async () => {
    render(<ArtifactsPage {...props({ readTrash: async () => ({ ok: true, value: [deleted] }) })} />)
    await screen.findByText(destination.directory)
    const snapshot = [screen.getByRole('heading').textContent, screen.getByRole('region', { name: '保存目录' }).textContent,
      screen.getByRole('searchbox').getAttribute('placeholder'), screen.getByRole('navigation').textContent,
      ...screen.getAllByRole('listitem').map(node => node.textContent)].join('\n') + '\n'
    await expect(snapshot).toMatchFileSnapshot('./expected/artifacts-page.txt')
    expect(screen.getByText('回收区（1 项）')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /永久/u })).toBeNull()
  })

  it('combines case-insensitive name or path search with the selected file type and has a no-match state', async () => {
    render(<ArtifactsPage {...props()} />)
    await screen.findByText(destination.directory)
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
    fireEvent.click(await screen.findByRole('button', { name: '更改目录' }))
    const dialog = screen.getByRole('dialog', { name: '更改目录' })
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
    fireEvent.click(await screen.findByRole('button', { name: '更改目录' }))
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
    fireEvent.click(await screen.findByRole('button', { name: '更改目录' }))
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
    fireEvent.click(await screen.findByRole('button', { name: '更改目录' }))
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
    await screen.findByText(destination.directory)
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

describe('workspace file scopes', () => {
  it('keeps generated output separate, offers the empty-library entry, and waits for an explicit workspace view', async () => {
    const face = workspaceProps({ readListing: async () => ({ ok: true, value: { items: [], roots: [], truncated: false } }) })
    render(<ArtifactsPage {...face} />)
    await screen.findByText(zh.empty)
    expect(face.readWorkspace).not.toHaveBeenCalled()
    expect(screen.getByText(zh['scope.hint'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看工作区文件' }))
    await screen.findByRole('button', { name: /^动漫\.png/u })
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '工作区' }).value).toBe(workspaceOne.id)
    expect(screen.getAllByText(workspaceOne.path).length).toBeGreaterThan(0)
    expect(screen.getByText(destination.directory)).toBeTruthy()
    expect(face.readWorkspace).toHaveBeenCalledWith(workspaceOne.id, '', expect.any(AbortSignal))
    const snapshot = [screen.getByRole('tab', { selected: true }).textContent,
      screen.getByRole('region', { name: '工作区浏览范围' }).textContent,
      screen.getByRole('searchbox').getAttribute('placeholder'), screen.getByRole('tabpanel').textContent].join('\n') + '\n'
    await expect(snapshot).toMatchFileSnapshot('./expected/workspace-files.txt')
  })

  it('does not silently choose the first workspace when the current session has no registered workspace', async () => {
    const face = workspaceProps({ workspaces: { items: [workspaceOne, workspaceTwo], currentWorkspaceId: null,
      currentSessionKey: null, ready: true } })
    render(<ArtifactsPage {...face} />)
    await screen.findByText(destination.directory)
    fireEvent.click(screen.getByRole('tab', { name: '工作区文件' }))
    await screen.findByText(zh['workspace.selectFirst'])
    expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('')
    expect(face.readWorkspace).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: workspaceTwo.id } })
    await screen.findByRole('button', { name: /^动漫\.png/u })
    expect(face.readWorkspace).toHaveBeenCalledWith(workspaceTwo.id, '', expect.any(AbortSignal))
  })

  it('loads only the opened directory, navigates portable breadcrumbs, and searches the current directory', async () => {
    const face = workspaceProps()
    render(<ArtifactsPage {...face} />)
    await screen.findByText(destination.directory)
    fireEvent.click(screen.getByRole('tab', { name: '工作区文件' }))
    fireEvent.click(await screen.findByRole('button', { name: '打开文件夹 输出' }))
    await waitFor(() => { expect(face.readWorkspace).toHaveBeenLastCalledWith(workspaceOne.id, '输出', expect.any(AbortSignal)) })
    await screen.findByRole('button', { name: /^动漫\.png/u })
    expect(screen.getByText(`${workspaceOne.path}/输出`)).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索当前目录的名称或路径' }), { target: { value: 'no-match' } })
    expect(screen.getByText(zh.noResults)).toBeTruthy()
    expect(face.readWorkspace).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: '上一级' }))
    await screen.findByRole('button', { name: '打开文件夹 输出' })
    expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('')
    expect(face.readWorkspace).toHaveBeenLastCalledWith(workspaceOne.id, '', expect.any(AbortSignal))
  })

  it('clears scope-bound selection and dialogs, aborts stale reads, and ignores their late response', async () => {
    const old = deferred<ArtifactResult<WorkspaceListing>>()
    const readWorkspace = vi.fn<ArtifactsInjected['readWorkspace']>()
      .mockResolvedValueOnce({ ok: true, value: workspaceListing() })
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValue({ ok: true, value: workspaceListing(workspaceTwo.id) })
    const face = workspaceProps({ readWorkspace })
    render(<ArtifactsPage {...face} />)
    await screen.findByText(destination.directory)
    fireEvent.click(screen.getByRole('tab', { name: '工作区文件' }))
    fireEvent.click(within(await selectImage()).getByRole('button', { name: '重命名' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: workspaceTwo.id } })
    await screen.findByText(workspaceTwo.path)
    await waitFor(() => { expect(readWorkspace.mock.calls[1]![2].aborted).toBe(true) })
    await act(async () => { old.resolve({ ok: true, value: workspaceListing() }) })
    expect(screen.getByText(zh.previewHint)).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: /^动漫\.png/u }).getAttribute('title')).toBe(`${workspaceTwo.path}/${image.name}`)
    fireEvent.click(within(await selectImage()).getByRole('button', { name: '重命名' }))
    fireEvent.click(screen.getByRole('tab', { name: '产物库' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(face.rename).not.toHaveBeenCalled()
  })

  it('binds preview, rename, and deletion to the selected workspace file', async () => {
    const face = workspaceProps({ rename: vi.fn(async () => ({ ok: false as const, code: 'ARTIFACT_CONFLICT' as const })) })
    render(<ArtifactsPage {...face} />)
    await screen.findByText(destination.directory)
    fireEvent.click(screen.getByRole('tab', { name: '工作区文件' }))
    const preview = await selectImage()
    expect(within(preview).getByRole('img').getAttribute('src')).toContain('&workspaceId=workspace-one')
    fireEvent.click(within(preview).getByRole('button', { name: '重命名' }))
    fireEvent.change(screen.getByRole('textbox', { name: '文件名' }), { target: { value: '新图.png' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '重命名' }))
    await screen.findByText(zh['error.ARTIFACT_CONFLICT'])
    expect(face.rename).toHaveBeenCalledExactlyOnceWith(workspaceListing().items[0], '新图.png')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    fireEvent.click(within(preview).getByRole('button', { name: '删除' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }))
    await waitFor(() => { expect(face.trash).toHaveBeenCalledExactlyOnceWith(workspaceListing().items[0]) })
  })

  it('follows a newly current conversation and clears a removed manual workspace instead of guessing', async () => {
    const face = workspaceProps()
    const page = render(<ArtifactsPage {...face} />)
    await screen.findByText(destination.directory)
    fireEvent.click(screen.getByRole('tab', { name: '工作区文件' }))
    await screen.findByRole('button', { name: /^动漫\.png/u })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: workspaceTwo.id } })
    await waitFor(() => { expect(face.readWorkspace).toHaveBeenLastCalledWith(workspaceTwo.id, '', expect.any(AbortSignal)) })
    page.rerender(<ArtifactsPage {...face} workspaces={{ ...face.workspaces, currentSessionKey: 'another-session' }} />)
    await waitFor(() => { expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe(workspaceOne.id) })
    page.rerender(<ArtifactsPage {...face} workspaces={{ ...face.workspaces, currentSessionKey: 'another-session', items: [workspaceTwo], currentWorkspaceId: null }} />)
    await screen.findByText(zh['workspace.selectFirst'])
    expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('')
    expect(screen.queryByRole('button', { name: /^动漫\.png/u })).toBeNull()
  })

  it('rebinds a lost receipt to a re-registered directory and requires explicit inspection before unlocking', async () => {
    const receipt = deferred<ArtifactResult<string>>()
    const face = workspaceProps({ trash: vi.fn(() => receipt.promise) })
    const page = render(<ArtifactsPage {...face} />)
    await screen.findByText(destination.directory)
    fireEvent.click(screen.getByRole('tab', { name: '工作区文件' }))
    fireEvent.click(within(await selectImage()).getByRole('button', { name: '删除' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }))
    const replacement = { ...workspaceOne, id: 'workspace-readded' }
    page.rerender(<ArtifactsPage {...face} workspaces={{ ...face.workspaces, items: [replacement], currentWorkspaceId: null }} />)
    await act(async () => { receipt.resolve({ ok: false, code: 'ARTIFACT_OPERATION_UNKNOWN' }) })
    fireEvent.click(await screen.findByRole('button', { name: '查看待确认位置' }))
    await waitFor(() => { expect(face.readWorkspace).toHaveBeenLastCalledWith(replacement.id, '', expect.any(AbortSignal)) })
    await waitFor(() => { expect(screen.getByRole('button', { name: '更改目录' }).hasAttribute('disabled')).toBe(true) })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '更改目录' }).hasAttribute('disabled')).toBe(false) })
    expect(face.trash).toHaveBeenCalledOnce()
  })

  it('keeps an unavailable workspace recovery visible and only offers native reveal when supported', async () => {
    const face = workspaceProps({ readDesktop: async () => true,
      readTrash: async () => ({ ok: true, value: [{ ...deleted, workspaceRoot: workspaceOne.path }] }),
      restore: vi.fn(async () => ({ ok: false as const, code: 'ARTIFACT_WORKSPACE_UNAVAILABLE' as const })) })
    const page = render(<ArtifactsPage {...face} />)
    fireEvent.click(within(await selectImage()).getByRole('button', { name: '打开所在目录' }))
    await waitFor(() => { expect(face.reveal).toHaveBeenCalledExactlyOnceWith(image.path) })
    fireEvent.click(screen.getByText('回收区（1 项）'))
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    await screen.findByText(zh['error.ARTIFACT_WORKSPACE_UNAVAILABLE'])
    expect(screen.getByText(deleted.name)).toBeTruthy()
    page.rerender(<ArtifactsPage {...face} workspaces={{ ...face.workspaces, items: [], currentWorkspaceId: null }} />)
    fireEvent.click(screen.getByRole('tab', { name: '工作区文件' }))
    await screen.findByText(zh['workspace.selectFirst'])
    expect(screen.queryByRole('button', { name: '打开所在目录' })).toBeNull()
  })

  it('bridges the existing current-session and workspace snapshot hooks without an extra selection service', async () => {
    const face = props()
    const binding = createSnapshotStore<StandardSourceBinding>({ key: 'session-one', props: {}, hooks: {}, keyedHooks: {} })
    const snapshot = { phase: 'ready', state: 'idle', error: null, archivedSessionIds: [], pinnedSessionIds: [],
      items: [workspaceOne, workspaceTwo].map((item, index) => ({ workspaceId: item.id, title: item.title, path: item.path,
        sessionIds: [index === 0 ? 'session-one' : 'session-two'], createdAt: '', updatedAt: '' })) } as WorkspaceSnapshot
    const workspaces = createSnapshotStore(snapshot)
    const readWorkspace = vi.fn<ArtifactsInjected['readWorkspace']>(async (id, directory) => ({ ok: true, value: workspaceListing(id, directory) }))
    render(<ArtifactsMain {...face} readWorkspace={readWorkspace}
      useArtifactSession={bindSnapshotSelector(binding)} useWorkspaces={bindSnapshotSelector(workspaces)} />)
    await screen.findByText(destination.directory)
    fireEvent.click(screen.getByRole('tab', { name: '工作区文件' }))
    await waitFor(() => { expect(readWorkspace).toHaveBeenLastCalledWith(workspaceOne.id, '', expect.any(AbortSignal)) })
    act(() => { binding.set({ ...binding.getSnapshot(), key: 'session-two' }) })
    await waitFor(() => { expect(readWorkspace).toHaveBeenLastCalledWith(workspaceTwo.id, '', expect.any(AbortSignal)) })
    act(() => { workspaces.set({ ...snapshot, items: [] }) })
    await screen.findByText(zh['workspace.selectFirst'])
    expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('')
  })
})
