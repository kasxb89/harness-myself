// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactFinder } from '../src/client/ArtifactFinder.tsx'
import type { ArtifactEntry, ArtifactsInjected } from '../src/client/ArtifactsPage.tsx'
import type { ArtifactResult, RootDirectoryListing } from '../src/client/api.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const image: ArtifactEntry = { path: '/output/deep/image.png', name: 'image.png', kind: 'image', size: 2, mtimeMs: 1 }
const rootPage: RootDirectoryListing = { root: '/output', directory: '', absoluteDirectory: '/output', parentDirectory: null,
  directories: [], items: [], truncated: false, offset: 0, nextOffset: null }

function props() {
  return {
    roots: ['/output'], workspaces: [{ id: 'workspace-one', title: '挂载项目', path: 'D:\\项目' }],
    readRootDirectory: vi.fn<ArtifactsInjected['readRootDirectory']>(async () => ({ ok: true, value: rootPage })),
    readWorkspace: vi.fn<ArtifactsInjected['readWorkspace']>(async () => ({ ok: true, value: {
      ...rootPage, workspace: { id: 'workspace-one', title: '挂载项目', path: 'D:\\项目' }, items: [{ ...image, workspaceId: 'workspace-one' }],
    } })),
    select: vi.fn<(entry: ArtifactEntry, root?: string) => void>(), close: vi.fn<() => void>(),
    t: (key: string, values?: Record<string, string>) => {
      const copy: Record<string, string> = zh
      return (copy[key] ?? key).replace(/\{(\w+)\}/gu, (_match, name: string) => values?.[name] ?? '')
    },
  }
}

describe('on-demand artifact finder', () => {
  it('appends pages of at most two directory rows and resets the offset when entering a folder', async () => {
    const face = props()
    face.readRootDirectory.mockImplementation(async (root, directory, _signal, offset) => ({ ok: true, value: {
      ...rootPage, root, directory, absoluteDirectory: root + (directory ? '/' + directory : ''),
      parentDirectory: directory === '' ? null : '',
      directories: directory === '' && offset === 0 ? [{ name: 'deep', directory: 'deep' }] : [],
      items: directory !== '' ? [image] : offset === 0 ? [{ ...image, name: 'first.png', path: '/output/first.png' }]
        : [{ ...image, name: 'second.png', path: '/output/second.png' }, { ...image, name: 'third.png', path: '/output/third.png' }],
      offset: offset ?? 0, nextOffset: directory === '' && offset === 0 ? 2 : null,
      truncated: directory === '' && offset === 0,
    } }))
    render(<ArtifactFinder {...face} />)
    await screen.findByRole('button', { name: 'first.png' })
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    await screen.findByRole('button', { name: 'third.png' })
    expect(screen.getByRole('button', { name: 'first.png' })).toBeTruthy()
    expect(face.readRootDirectory).toHaveBeenLastCalledWith('/output', '', expect.any(AbortSignal), 2)
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开文件夹 deep' }))
    await screen.findByRole('button', { name: 'image.png' })
    expect(face.readRootDirectory).toHaveBeenLastCalledWith('/output', 'deep', expect.any(AbortSignal), 0)
    expect(screen.queryByRole('button', { name: 'first.png' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'image.png' }))
    expect(face.select).toHaveBeenCalledExactlyOnceWith(image, '/output')
    expect(screen.queryByText('/output/deep')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '上一级' }))
    await screen.findByRole('button', { name: 'first.png' })
  })

  it('aborts an old directory read on source changes and passes workspace authorization when selecting a file', async () => {
    let settle!: (value: ArtifactResult<RootDirectoryListing>) => void
    const older = new Promise<ArtifactResult<RootDirectoryListing>>((resolve) => { settle = resolve })
    const face = props()
    face.readRootDirectory.mockImplementation(() => older)
    render(<ArtifactFinder {...face} />)
    const signal = face.readRootDirectory.mock.calls[0]![2]
    fireEvent.change(screen.getByRole('combobox', { name: '文件来源' }), { target: { value: 'workspace:workspace-one' } })
    await screen.findByRole('button', { name: 'image.png' })
    expect(signal.aborted).toBe(true)
    await act(async () => { settle({ ok: true, value: { ...rootPage, items: [{ ...image, name: 'stale.png' }] } }) })
    expect(screen.queryByRole('button', { name: 'stale.png' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'image.png' }))
    expect(face.select).toHaveBeenCalledExactlyOnceWith({ ...image, workspaceId: 'workspace-one' }, undefined)
  })

  it('keeps loaded files after a failed next-page read and lets the user retry without replaying selection', async () => {
    const face = props()
    face.readRootDirectory.mockResolvedValueOnce({ ok: true, value: { ...rootPage, items: [image], truncated: true, nextOffset: 2 } })
      .mockResolvedValueOnce({ ok: false, code: 'ARTIFACT_PERMISSION_DENIED' })
      .mockResolvedValueOnce({ ok: true, value: { ...rootPage, offset: 2, items: [] } })
    render(<ArtifactFinder {...face} />)
    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(zh['error.ARTIFACT_PERMISSION_DENIED'])
    expect(screen.getByRole('button', { name: 'image.png' })).toBeTruthy()
    fireEvent.click(within(alert).getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(face.readRootDirectory).toHaveBeenCalledTimes(3) })
    expect(face.select).not.toHaveBeenCalled()
  })
})
