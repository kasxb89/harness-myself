// @vitest-environment jsdom
/** The board preserves parent-owned collection, row identity and loading behavior without transport. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {} from '../src/client/index.ts'
import { CommunityDemandBoard } from '../src/client/CommunityDemandBoard.tsx'
import type { CommunityBoardRow } from '../src/client/community-view.ts'
import type { DemandTranslate } from '../src/client/DemandUI.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const translations: ReadonlyMap<string, string> = new Map(Object.entries(zh))
const t: DemandTranslate = (key, params) => (translations.get(key) ?? key).replace(/\{(\w+)\}/gu,
  (placeholder: string, name: string) => params !== undefined && name in params ? String(params[name]) : placeholder)

function boardProps(): ComponentProps<typeof CommunityDemandBoard> {
  return {
    view: 'mine', search: '', rows: [], loading: false, error: null, hasMore: false, loadingMore: false, t,
    onViewChange: vi.fn(), onSearch: vi.fn(), onCreate: vi.fn(), onOpen: vi.fn(), onRetry: vi.fn(), onLoadMore: vi.fn(),
  }
}

function row(patch: Partial<Omit<CommunityBoardRow, 'origin' | 'feedback'>> & { origin?: 'legacy' | 'community' } = {}): CommunityBoardRow {
  return { key: 'example-key', title: '示例需求', serviceName: '示例服务', updatedAt: '2026-11-19T02:00:00Z',
    action: 'communicate', ...patch }
}

describe('controlled community demand board', () => {
  it('delegates all three collections, search and creation without selecting its own data', () => {
    const props = boardProps()
    const view = render(<CommunityDemandBoard {...props} />)
    const group = screen.getByRole('group', { name: zh.communityBoardCollections })
    expect(within(group).getAllByRole('button')).toHaveLength(3)
    expect(within(group).getByRole('button', { name: zh.communityBoardMine }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(group).getByRole('button', { name: zh.communityBoardPublic }))
    expect(props.onViewChange).toHaveBeenLastCalledWith('public')
    expect(within(group).getByRole('button', { name: zh.communityBoardPublic }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(within(group).getByRole('button', { name: zh.communityBoardAccepted }))
    expect(props.onViewChange).toHaveBeenLastCalledWith('accepted')
    fireEvent.click(within(group).getByRole('button', { name: zh.communityBoardMine }))
    expect(props.onViewChange).toHaveBeenLastCalledWith('mine')
    fireEvent.change(screen.getByRole('searchbox', { name: zh.searchRequests }), { target: { value: '页面' } })
    expect(props.onSearch).toHaveBeenCalledExactlyOnceWith('页面')
    expect(screen.getByRole('searchbox', { name: zh.searchRequests })).toHaveProperty('value', '')
    fireEvent.click(screen.getByRole('button', { name: zh.communityPublishRequest }))
    expect(props.onCreate).toHaveBeenCalledOnce()
    view.rerender(<CommunityDemandBoard {...props} view="public" />)
    expect(screen.queryByRole('group', { name: zh.communityBoardCollections })).toBeNull()
    expect(screen.queryByRole('searchbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.communityBoardMine }))
    expect(props.onViewChange).toHaveBeenLastCalledWith('mine')
    fireEvent.click(screen.getByRole('button', { name: zh.searchRequests }))
    expect(screen.getByRole('searchbox', { name: zh.searchRequests })).toBeTruthy()
  })

  it('keeps normal cards minimal and opens identical titles by their exact independent keys', () => {
    const props = boardProps()
    const first = row({ key: 'legacy:original', origin: 'legacy' })
    const second = row({ key: 'community:original', origin: 'community' })
    render(<CommunityDemandBoard {...props} rows={[first, second]} />)
    const list = screen.getByRole('list', { name: zh.communityBoardMine })
    const cards = within(list).getAllByRole('listitem')
    expect(cards).toHaveLength(2)
    for (const card of cards) {
      expect(within(card).getByRole('heading', { name: first.title })).toBeTruthy()
      expect(within(card).getByText(first.serviceName)).toBeTruthy()
      expect(card.querySelectorAll('p')).toHaveLength(1)
      expect(card.querySelector('time')?.getAttribute('dateTime')).toBe(first.updatedAt)
      expect(card.querySelector('strong')).toBeNull()
      expect(within(card).queryByText(zh.waitingAssignment)).toBeNull()
      expect(within(card).queryByText(zh.budgetLabel)).toBeNull()
      expect(within(card).getAllByRole('button')).toHaveLength(2)
    }
    expect(screen.getByText('当前显示 2 项')).toBeTruthy()
    cards.forEach((card, index) => {
      fireEvent.click(within(card).getByRole('button', { name: '沟通：示例需求' }))
      expect(props.onOpen).toHaveBeenNthCalledWith(index + 1, index === 0 ? first.key : second.key)
    })
  })

  it('presents parent-normalized actions and keeps only necessary draft feedback', () => {
    const props = boardProps()
    const rows: readonly CommunityBoardRow[] = [
      row({ key: 'public-a', title: '查看公开项', action: 'view-demand' }),
      row({ key: 'closed-a', title: '查看历史项', action: 'view' }),
      { key: 'draft-a', origin: 'draft', title: '编辑草稿项', serviceName: '示例服务', updatedAt: '', action: 'continue-draft' },
      { key: 'draft-b', origin: 'draft', title: '核对原提交', serviceName: '示例服务', updatedAt: '',
        action: 'check-submission', feedback: zh.resultUnknown },
    ]
    render(<CommunityDemandBoard {...props} view="public" rows={rows} />)
    const list = screen.getByRole('list', { name: zh.communityBoardPublic })
    expect(within(list).getByRole('status').textContent).toBe(zh.resultUnknown)
    for (const [name, key] of [[`${zh.communityViewDemand}：查看公开项`, 'public-a'], ['查看：查看历史项', 'closed-a'],
      ['继续编辑：编辑草稿项', 'draft-a'], ['核对发布结果：核对原提交', 'draft-b']] as const) {
      fireEvent.click(within(list).getByRole('button', { name }))
      expect(props.onOpen).toHaveBeenLastCalledWith(key)
    }
  })

  it('retains rows through read errors and independently disables row and paging actions', () => {
    const props = boardProps()
    const rows = [row({ key: 'disabled-a', title: '受限需求', disabled: true }), row({ key: 'busy-b', title: '原操作处理中', busy: true })]
    const view = render(<CommunityDemandBoard {...props} rows={rows} error="读取失败，已保留现有需求" hasMore />)
    expect(screen.getByRole('alert').textContent).toContain('读取失败，已保留现有需求')
    expect(screen.getByRole('heading', { name: '受限需求' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '沟通：受限需求' }))
    fireEvent.click(screen.getByRole('button', { name: '沟通：原操作处理中' }))
    expect(props.onOpen).not.toHaveBeenCalled()
    expect(screen.getByText(zh.communityBoardWorking)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(props.onRetry).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: zh.loadMoreRequests }))
    expect(props.onLoadMore).toHaveBeenCalledOnce()
    view.rerender(<CommunityDemandBoard {...props} rows={rows} error="读取失败，已保留现有需求" hasMore loading loadingMore />)
    expect(screen.getByRole('heading', { name: '受限需求' })).toBeTruthy()
    expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    fireEvent.click(screen.getByRole('button', { name: zh.loadingMoreRequests }))
    expect(props.onRetry).toHaveBeenCalledOnce()
    expect(props.onLoadMore).toHaveBeenCalledOnce()
  })

  it('distinguishes initial loading, a genuinely empty collection and a search with no matches', () => {
    const props = boardProps()
    const view = render(<CommunityDemandBoard {...props} view="accepted" loading />)
    expect(screen.getByRole('status', { name: zh.loading })).toBeTruthy()
    expect(screen.queryByText(zh.communityBoardAcceptedEmpty)).toBeNull()
    view.rerender(<CommunityDemandBoard {...props} view="accepted" />)
    expect(screen.getByText(zh.communityBoardAcceptedEmpty)).toBeTruthy()
    view.rerender(<CommunityDemandBoard {...props} view="accepted" search="不存在的项目" />)
    expect(screen.getByText(zh.noMatchingRequests)).toBeTruthy()
    expect(screen.getByText('当前显示 0 项')).toBeTruthy()
  })

  it('shows supplied public material and terms while cover, title and detail actions retain the original key', () => {
    const props = boardProps()
    const item = row({ key: 'community-listing:original', action: 'view-demand', brief: '只展示公开的需求说明',
      publicBudget: '预算约 3000 元，可沟通', expectedDeliveryDate: '2026-12-08', authorDisplayName: '真实发布名',
      attachments: [{ id: 'image-a', name: '公开图片', kind: 'image', sizeBytes: 90, previewUrl: '/authorized/image-a' }] })
    const view = render(<CommunityDemandBoard {...props} view="public" rows={[item]} />)
    const card = screen.getByRole('list', { name: zh.communityBoardPublic }).querySelector('li')
    if (card === null) throw new Error('Expected the original public request card')
    const image = card.querySelector('img')
    expect(image?.getAttribute('src')).toBe('/authorized/image-a')
    expect(within(card).getByText(item.publicBudget ?? '')).toBeTruthy()
    expect(within(card).getByText(item.authorDisplayName ?? '')).toBeTruthy()
    expect(card.querySelector('time')?.getAttribute('dateTime')).toBe('2026-12-08')
    fireEvent.click(screen.getByRole('button', { name: item.title }))
    expect(props.onOpen).toHaveBeenLastCalledWith(item.key)
    fireEvent.click(screen.getByRole('button', { name: `${zh.communityViewDemand}：${item.title}` }))
    expect(props.onOpen).toHaveBeenLastCalledWith(item.key)
    if (image === null) throw new Error('Expected the authorized image before its failure')
    fireEvent.error(image)
    expect(card.querySelector('img')).toBeNull()
    expect(within(card).getByRole('heading', { name: item.title })).toBeTruthy()
    view.rerender(<CommunityDemandBoard {...props} view="public" rows={[{ ...item,
      attachments: [{ id: 'image-a', name: '公开图片', kind: 'image', sizeBytes: 90, previewUrl: '/authorized/renewed-image-a' }] }]} />)
    expect(card.querySelector('img')?.getAttribute('src')).toBe('/authorized/renewed-image-a')
  })

  it('uses a text card for absent authorization and never invents a budget, date or approval', () => {
    const props = boardProps()
    const item = row({ action: 'view-demand', attachments: [{ id: 'not-authorized', name: '资料', kind: 'image', sizeBytes: 10 }] })
    render(<CommunityDemandBoard {...props} view="public" rows={[item]} />)
    const list = screen.getByRole('list', { name: zh.communityBoardPublic })
    expect(list.querySelector('img,video')).toBeNull()
    expect(list.querySelector('time')).toBeNull()
    expect(within(list).queryByText(zh.communityExpectedDelivery)).toBeNull()
    expect(screen.queryByText(zh.communityApprovedListings)).toBeNull()
    expect(list.textContent).not.toContain('0元')
    expect(list.textContent).not.toContain('¥')
  })

  it('does not autoplay a public video cover and opens its request instead of a second playback control', () => {
    const props = boardProps()
    const item = row({ action: 'view-demand', attachments: [{ id: 'video-a', name: '公开视频', kind: 'video',
      sizeBytes: 100, previewUrl: '/authorized/video-a' }] })
    render(<CommunityDemandBoard {...props} view="public" rows={[item]} />)
    const video = screen.getByRole('list', { name: zh.communityBoardPublic }).querySelector('video')
    expect(video?.getAttribute('src')).toBe('/authorized/video-a')
    expect(video?.getAttribute('preload')).toBe('metadata')
    expect(video).toHaveProperty('muted', true)
    expect(video).toHaveProperty('autoplay', false)
    expect(video).toHaveProperty('controls', false)
    fireEvent.click(screen.getByRole('button', { name: item.title }))
    expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(item.key)
  })

  it('labels the approved public scope only when supplied and keeps a rejection reason in the owner collection', () => {
    const props = boardProps()
    const item = row({ approvalStatus: 'rejected', approvalReason: '请补充交付范围' })
    const view = render(<CommunityDemandBoard {...props} rows={[item]} />)
    expect(screen.getByText(zh.communityApprovalRejected)).toBeTruthy()
    expect(screen.getByText('请补充交付范围')).toBeTruthy()
    view.rerender(<CommunityDemandBoard {...props} view="public" rows={[item]} approvedPublic />)
    expect(screen.getByText(zh.communityApprovedListings)).toBeTruthy()
    expect(screen.queryByText(zh.communityApprovalRejected)).toBeNull()
    expect(screen.queryByText('请补充交付范围')).toBeNull()
  })
})
