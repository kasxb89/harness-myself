// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { ArtifactsPage, type ArtifactEntry, type ArtifactsInjected } from '../src/client/ArtifactsPage.tsx'
import type { ArtifactListing, ArtifactResult, ArtifactStorage, TrashedArtifact } from '../src/client/api.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const image: ArtifactEntry = { path: '/old/动漫.png', name: '动漫.png', kind: 'image', size: 128, mtimeMs: new Date(2026, 9, 17, 12, 0).getTime() }
const video: ArtifactEntry = { ...image, path: '/old/story.mp4', name: 'story.mp4', kind: 'video' }
const destination: ArtifactStorage = { directory: '/new/产物', defaultDirectory: '/initial/产物', revision: 3, roots: ['/old', '/new/产物'] }
const deleted: TrashedArtifact = { id: 'deleted-1', name: 'deleted.png', originalPath: '/old/deleted.png', deletedAt: '2026-10-17T04:00:00Z' }

/** Deferred settlement places refresh and mutation races at a deterministic boundary. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** Product-owned copy and narrow operations, without Host filesystem or credentials. */
function props(overrides: Partial<ArtifactsInjected> = {}): ArtifactsInjected {
  return {
    t: (key, values) => {
      const copy: Record<string, string> = zh
      return (copy[key] ?? key).replace(/\{(\w+)\}/gu, (_match, name: string) => values?.[name] ?? '')
    },
    readListing: vi.fn<ArtifactsInjected['readListing']>(async () => ({ ok: true, value: { items: [image, video], roots: ['/old'], truncated: false } })),
    readStorage: vi.fn<ArtifactsInjected['readStorage']>(async () => ({ ok: true, value: destination })),
    readTrash: vi.fn<ArtifactsInjected['readTrash']>(async () => ({ ok: true, value: [] })),
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
