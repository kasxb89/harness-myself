// @vitest-environment jsdom
/** Case previews render supplied public material without creating demand or generation operations. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaseShowcase } from '../src/client/CaseShowcase.tsx'
import type { CaseShowcaseItem } from '../src/client/case-showcase-types.ts'
import type { ShowcaseState } from '../src/client/showcase-types.ts'
import type { DemandTranslate } from '../src/client/DemandUI.tsx'
import { zh } from '../src/client/locales.ts'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void { /* Real layout belongs to the built browser check. */ }
    unobserve(): void { /* No retained jsdom observation. */ }
    disconnect(): void { /* No retained browser resource. */ }
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const translations: ReadonlyMap<string, string> = new Map(Object.entries(zh))
const translate: DemandTranslate = (key, values) => (translations.get(key) ?? key).replace(/\{(\w+)\}/gu, (match: string, name: string) =>
  values !== undefined && name in values ? String(values[name]) : match)

function item(patch: Partial<CaseShowcaseItem> = {}): CaseShowcaseItem {
  return { id: 'web-case', title: '业务看板', description: '组件和报表的公开参考素材', category: 'web',
    coverUrl: '/case-media/dashboard.png', media: [{ kind: 'image', url: '/case-media/dashboard.png' }],
    sourceName: 'Original project', sourceUrl: 'https://example.com/project', attribution: 'MIT · Original contributors', ...patch }
}

const previewName = (title: string): string => zh.showcasePreviewNamed.replace('{title}', title)

describe('public case showcase', () => {
  it('shows backend loading/error honestly instead of rendering configured fallback records', () => {
    const state: ShowcaseState = { source: 'checking', status: 'loading', items: [], category: null, categories: [], total: 0,
      hasMore: false, loadingMore: false, error: null }
    const commands = { refreshShowcases: vi.fn(), loadMoreShowcases: vi.fn(), setShowcaseCategory: vi.fn() }
    const view = render(<CaseShowcase items={[item()]} state={state} commands={commands} t={translate} />)
    expect(screen.queryByRole('button', { name: previewName('业务看板') })).toBeNull()
    expect(screen.queryByRole('heading', { name: zh.showcaseEmpty })).toBeNull()
    view.rerender(<CaseShowcase items={[item()]} state={{ ...state, status: 'error', error: 'SHOWCASE_UNAUTHORIZED' }} commands={commands} t={translate} />)
    expect(screen.getByRole('alert').textContent).toContain(zh.showcaseLoadFailed)
    expect(screen.queryByText(zh.showcaseLoading)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(commands.refreshShowcases).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: previewName('业务看板') })).toBeNull()
  })

  it('uses server total and controlled filters/pagination without filtering only the first page', () => {
    const state: ShowcaseState = { source: 'backend', status: 'ready', items: [item()], category: null, categories: ['web', 'video'],
      total: 120, hasMore: true, loadingMore: false, error: null }
    const commands = { refreshShowcases: vi.fn(), loadMoreShowcases: vi.fn(), setShowcaseCategory: vi.fn() }
    render(<CaseShowcase items={[]} state={state} commands={commands} t={translate} />)
    expect(screen.getByText(zh.showcaseCount.replace('{count}', '120'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.showcaseCategoryVideo }))
    expect(commands.setShowcaseCategory).toHaveBeenCalledExactlyOnceWith('video')
    fireEvent.click(screen.getByRole('button', { name: zh.showcaseLoadMore }))
    expect(commands.loadMoreShowcases).toHaveBeenCalledTimes(1)
  })
  it('renders only provided cases and filters categories without adding a request or invented entries', () => {
    render(<CaseShowcase items={[item(), item({ id: 'film', title: '产品视频', category: 'video',
      media: [{ kind: 'video', url: '/case-media/product.mp4' }] })]} t={translate} />)
    expect(within(screen.getByRole('list', { name: zh.showcaseTab })).getAllByRole('listitem')).toHaveLength(2)
    const filters = screen.getByRole('group', { name: zh.showcaseCategories })
    expect(within(filters).queryByRole('button', { name: zh.showcaseCategoryGame })).toBeNull()
    fireEvent.click(within(filters).getByRole('button', { name: zh.showcaseCategoryVideo }))
    expect(screen.getByRole('button', { name: previewName('产品视频') })).toBeTruthy()
    expect(screen.queryByRole('button', { name: previewName('业务看板') })).toBeNull()
    fireEvent.click(within(filters).getByRole('button', { name: zh.showcaseAll }))
    expect(screen.getByRole('button', { name: previewName('业务看板') })).toBeTruthy()
  })

  it('opens the correct same-title case and uses native video controls without autoplay', () => {
    const same = '同名作品'
    render(<CaseShowcase items={[item({ title: same }), item({ id: 'video-case', title: same,
      category: 'video', coverUrl: '/case-media/video-cover.png', media: [
        { kind: 'video', url: '/case-media/clip.mp4', posterUrl: '/case-media/video-cover.png' },
        { kind: 'image', url: '/case-media/still.png' },
      ] })]} t={translate} />)
    const trigger = screen.getAllByRole('button', { name: previewName(same) })[1]
    if (trigger === undefined) throw new Error('Both independently supplied cases are visible')
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: same })
    const video = dialog.querySelector('video')
    expect(video?.getAttribute('src')).toBe('/case-media/clip.mp4')
    expect(video?.hasAttribute('controls')).toBe(true)
    expect(video?.hasAttribute('autoplay')).toBe(false)
    expect(video?.getAttribute('preload')).toBe('metadata')
    fireEvent.click(within(dialog).getByRole('button', { name: zh.showcaseMediaIndex.replace('{index}', '2') }))
    expect(within(dialog).getByRole('img', { name: same }).getAttribute('src')).toBe('/case-media/still.png')
    expect(dialog.querySelector('video')).toBeNull()
    const source = within(dialog).getByRole('link', { name: zh.showcaseSource })
    expect(source.getAttribute('href')).toBe('https://example.com/project')
    expect(source.getAttribute('rel')).toContain('noopener')
    expect(within(dialog).getByText('MIT · Original contributors')).toBeTruthy()
    fireEvent.click(within(dialog).getAllByRole('button', { name: zh.close })[0]!)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('shows an honest empty catalogue and removes an opened case when its supplied record disappears', () => {
    const view = render(<CaseShowcase items={[]} t={translate} />)
    expect(screen.getByRole('heading', { name: zh.showcaseEmpty })).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
    view.rerender(<CaseShowcase items={[item()]} t={translate} />)
    fireEvent.click(screen.getByRole('button', { name: previewName('业务看板') }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    view.rerender(<CaseShowcase items={[]} t={translate} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('heading', { name: zh.showcaseEmpty })).toBeTruthy()
  })

  it('never puts executable or private filesystem URLs into media or source links', () => {
    render(<CaseShowcase items={[item({ coverUrl: 'file:///private/image.png', sourceUrl: 'javascript:alert(1)',
      media: [{ kind: 'image', url: 'data:text/html,<script>1</script>' }] })]} t={translate} />)
    expect(screen.queryByRole('img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: previewName('业务看板') }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: zh.showcaseUnavailable })).toBeTruthy()
    expect(within(dialog).queryByRole('link')).toBeNull()
    expect(dialog.querySelector('[src]')).toBeNull()
  })
})
