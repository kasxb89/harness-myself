/** Opt-in directory navigation for files beyond the library's bounded initial scan. */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, FileTypeIcon, IconFolderOpenRegular, Modal, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ArtifactEntry, ArtifactsInjected } from './ArtifactsPage.tsx'
import type { ArtifactErrorCode, ArtifactWorkspace, WorkspaceListing } from './api.ts'
import css from './ArtifactsPage.module.css'

type DirectoryPage = Pick<WorkspaceListing, 'directory' | 'parentDirectory' | 'directories' | 'items' | 'truncated' | 'nextOffset'>
type Source = { key: string; label: string } & ({ kind: 'root'; root: string } | { kind: 'workspace'; workspaceId: string })

function directoryName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path
}

/**
 * Browse one explicitly selected directory without adding a second main-page file browser.
 * @param props - Current retained roots, registered workspaces, read operations, and file selection.
 * @returns A dismissable, bounded file-finder dialog with cancellable paged directory reads.
 */
export function ArtifactFinder({ roots, workspaces, readWorkspace, readRootDirectory, select, close, t }: {
  roots: readonly string[]
  workspaces: readonly ArtifactWorkspace[]
  readWorkspace: ArtifactsInjected['readWorkspace']
  readRootDirectory: ArtifactsInjected['readRootDirectory']
  select: (entry: ArtifactEntry, root?: string) => void
  close: () => void
  t: ArtifactsInjected['t']
}): ReactNode {
  const sources = useMemo<Source[]>(() => [
    ...roots.map(root => ({ key: `root:${root}`, kind: 'root' as const, root,
      label: t('finder.rootSource', { name: directoryName(root) }) })),
    ...workspaces.map(workspace => ({ key: `workspace:${workspace.id}`, kind: 'workspace' as const, workspaceId: workspace.id,
      label: t('finder.workspaceSource', { name: workspace.title || directoryName(workspace.path) }) })),
  ], [roots, workspaces, t])
  const [sourceKey, setSourceKey] = useState(sources[0]?.key ?? '')
  const [directory, setDirectory] = useState('')
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  const [listing, setListing] = useState<{ key: string; value: DirectoryPage } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ArtifactErrorCode | null>(null)
  const source = sources.find(item => item.key === sourceKey)
  const key = JSON.stringify([sourceKey, directory])
  const current = source !== undefined && listing?.key === key ? listing.value : null

  useEffect(() => {
    if (source === undefined) { setLoading(false); setError('ARTIFACT_WORKSPACE_UNAVAILABLE'); return }
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    const read = source.kind === 'workspace' ? readWorkspace(source.workspaceId, directory, controller.signal, offset)
      : readRootDirectory(source.root, directory, controller.signal, offset)
    void read.then((result) => {
      if (controller.signal.aborted) return
      if (result.ok) {
        setListing((previous) => {
          if (offset === 0 || previous?.key !== key) return { key, value: result.value }
          const files = new Map(previous.value.items.map(entry => [entry.path, entry]))
          const folders = new Map(previous.value.directories.map(folder => [folder.directory, folder]))
          for (const entry of result.value.items) files.set(entry.path, entry)
          for (const folder of result.value.directories) folders.set(folder.directory, folder)
          return { key, value: { ...result.value, items: [...files.values()], directories: [...folders.values()] } }
        })
      } else setError(result.code)
      setLoading(false)
    }).catch(() => {
      if (!controller.signal.aborted) { setError('ARTIFACT_OPERATION_FAILED'); setLoading(false) }
    })
    return () => { controller.abort() }
  }, [source, directory, offset, revision, key, readWorkspace, readRootDirectory])

  const navigate = (next: string): void => { setDirectory(next); setOffset(0) }
  return <Modal open title={t('finder.title')} description={t('finder.hint')} closeLabel={t('close')} onClose={close}>
    <div className={css.form}>
      <label className={css.finderSource}>
        <span>{t('finder.source')}</span>
        <select aria-label={t('finder.source')} value={source?.key ?? ''} onChange={(event) => {
          setSourceKey(event.currentTarget.value); setDirectory(''); setOffset(0)
        }}>
          <option value="">{t('finder.chooseSource')}</option>
          {sources.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
        </select>
      </label>
      <div className={css.finderNavigation}>
        {directory !== '' && <>
          <Button size="sm" variant="ghost" disabled={loading} onClick={() => { navigate(current?.parentDirectory ?? '') }}>{t('finder.parent')}</Button>
          <Button size="sm" variant="ghost" disabled={loading} onClick={() => { navigate('') }}>{t('finder.root')}</Button>
        </>}
        <span className={css.rowName}>{directory === '' ? t('finder.root') : directoryName(directory)}</span>
      </div>
      {error !== null && <div className={css.banner} data-tone="error" role="alert">
        {t(`error.${error}`)} <Button size="sm" disabled={loading} onClick={() => { setRevision(value => value + 1) }}>{t('refresh')}</Button>
      </div>}
      <div className={css.finderListing} aria-busy={loading}>
        {loading && current === null && <TextShimmer active className={css.hint}>{t('loading')}</TextShimmer>}
        {current !== null && <ul className={css.rows}>
          {current.directories.map(folder => <li key={`folder:${folder.directory}`}>
            <button type="button" className={css.row} disabled={loading} onClick={() => { navigate(folder.directory) }}
              aria-label={t('finder.openDirectory', { name: folder.name })}>
              <span className={css.thumb}><IconFolderOpenRegular size={18} /></span>
              <span className={css.rowText}><span className={css.rowName}>{folder.name}</span></span>
            </button>
          </li>)}
          {current.items.map(entry => <li key={entry.path}>
            <button type="button" className={css.row} disabled={loading || source === undefined}
              onClick={() => { select(entry, source?.kind === 'root' ? source.root : undefined) }}>
              <span className={css.thumb}><FileTypeIcon path={entry.name} size={18} /></span>
              <span className={css.rowText}><span className={css.rowName}>{entry.name}</span></span>
            </button>
          </li>)}
        </ul>}
        {current !== null && current.items.length === 0 && current.directories.length === 0 && !loading
          && <p className={css.hint}>{t('finder.empty')}</p>}
      </div>
      {current?.nextOffset !== undefined && current.nextOffset !== null && <Button variant="outline" size="sm" disabled={loading}
        onClick={() => { setOffset(current.nextOffset ?? 0) }}>{t('finder.more')}</Button>}
      {current?.truncated === true && current.nextOffset === undefined && <p className={css.hint}>{t('truncated')}</p>}
    </div>
  </Modal>
}
