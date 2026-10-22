// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillHubPage, type SkillHubPageProps } from '../src/client/SkillHubPage.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { InstalledSkill, SkillHubInstallResponse, SkillHubInstalledResponse, SkillHubSearchResponse, SkillHubSkill } from '../src/types.ts'

afterEach(cleanup)

const review: SkillHubSkill = { slug: '@community/review', name: '代码审查', description: '检查代码变更', version: '1.2.0', source: 'SkillHub 社区' }
const installed: InstalledSkill = { slug: review.slug, name: review.name, version: review.version }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail })
  return { promise, resolve, reject }
}

function props(overrides: Partial<SkillHubPageProps> = {}): SkillHubPageProps {
  return {
    t: (key, values) => {
      const copy: Record<string, string> = zh
      return (copy[key] ?? key).replace(/\{(\w+)\}/gu, (_match, name: string) => {
        const value = values?.[name]
        return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
      })
    },
    readRecommendations: vi.fn(async () => ({ ok: true as const, skills: [] })),
    search: vi.fn(async () => ({ ok: true as const, skills: [review] })),
    readInstalled: vi.fn(async () => ({ ok: true as const, skills: [] })),
    install: vi.fn(async () => ({ ok: true as const, skill: installed })),
    ...overrides,
  }
}

function search(query = '审查') {
  fireEvent.change(screen.getByRole('textbox', { name: '搜索 SkillHub 技能' }), { target: { value: query } })
  fireEvent.click(screen.getByRole('button', { name: '搜索' }))
}

describe('SkillHub page', () => {
  it('keeps the header, tabs and their panels in one content column and switches panels by keyboard', async () => {
    render(<SkillHubPage {...props()} />)
    await screen.findByRole('heading', { name: '暂时没有推荐技能' })
    const title = screen.getByRole('heading', { name: '技能商店' })
    const header = title.closest('header')!
    const tabs = screen.getByRole('tablist', { name: '技能目录' })
    const discoverPanel = screen.getByRole('tabpanel', { name: '发现技能' })
    const installedTab = screen.getByRole('tab', { name: '已安装' })
    const installedPanel = document.getElementById(installedTab.getAttribute('aria-controls')!)!
    const content = header.parentElement!

    expect(Array.from(content.children)).toEqual([header, tabs, discoverPanel, installedPanel])
    expect(content.parentElement).toBe(screen.getByRole('region', { name: '技能商店' }))
    expect(installedPanel.hidden).toBe(true)

    const discoverTab = screen.getByRole('tab', { name: '发现技能' })
    discoverTab.focus()
    fireEvent.keyDown(discoverTab, { key: 'ArrowRight' })

    expect(document.activeElement).toBe(installedTab)
    expect(installedTab.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel', { name: '已安装' })).toBe(installedPanel)
    expect(discoverPanel.hidden).toBe(true)
    expect(within(installedPanel).getByRole('heading', { name: '还没有安装 SkillHub 技能' })).toBeTruthy()
  })

  it('loads recommendations and inventory while reserving search and installation for user actions', async () => {
    const face = props()
    render(<SkillHubPage {...face} />)
    await waitFor(() => { expect(face.readInstalled).toHaveBeenCalledTimes(1) })
    await screen.findByText('暂时没有推荐技能')
    expect(screen.getByRole('heading', { name: '推荐技能' })).toBeTruthy()
    expect(face.readRecommendations).toHaveBeenCalledTimes(1)
    expect(screen.getByText('20万社区技能', { exact: false })).toBeTruthy()
    expect(screen.getByRole('link', { name: '访问 SkillHub' }).getAttribute('href')).toBe('https://skillhub.cn/')
    expect(screen.getByRole('button', { name: '搜索' }).hasAttribute('disabled')).toBe(true)
    expect(face.search).not.toHaveBeenCalled()
    expect(face.install).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: '已安装' }))
    await screen.findByRole('heading', { name: '还没有安装 SkillHub 技能' })
  })

  it('shows recommendation cards without manufacturing an unavailable version', async () => {
    const face = props({
      readRecommendations: vi.fn<SkillHubPageProps['readRecommendations']>(async () => ({
        ok: true, skills: [{ ...review, version: '' }],
      })),
    })
    render(<SkillHubPage {...face} />)
    await screen.findByRole('heading', { name: review.name })

    expect(face.search).not.toHaveBeenCalled()
    expect(face.install).not.toHaveBeenCalled()
    expect(screen.queryByText(/^版本/u)).toBeNull()
    const title = screen.getByRole('heading', { name: '推荐技能' }).textContent
    const card = Array.from(screen.getByRole('listitem').querySelectorAll('h3,p,code,button')).map(node => node.textContent)
    await expect([title, ...card].join('\n') + '\n').toMatchFileSnapshot('./expected/skillhub-recommendations.txt')
  })

  it('loads recommendations independently while the installed inventory is already available', async () => {
    const recommendations = deferred<SkillHubSearchResponse>()
    const readRecommendations = vi.fn<SkillHubPageProps['readRecommendations']>(() => recommendations.promise)
    const face = props({
      readRecommendations,
      readInstalled: vi.fn<SkillHubPageProps['readInstalled']>(async () => ({ ok: true, skills: [installed] })),
    })
    render(<SkillHubPage {...face} />)
    try {
      expect(screen.getByRole('status', { name: '正在加载推荐技能' })).toBeTruthy()
      fireEvent.click(screen.getByRole('tab', { name: '已安装' }))
      await screen.findByRole('heading', { name: review.name })
      expect(readRecommendations).toHaveBeenCalledTimes(1)
      expect(face.search).not.toHaveBeenCalled()
      expect(face.install).not.toHaveBeenCalled()
    } finally {
      await act(async () => { recommendations.resolve({ ok: true, skills: [] }) })
    }
  })

  it('shows a recommendation failure and retries recommendations without submitting a search', async () => {
    const readRecommendations = vi.fn<SkillHubPageProps['readRecommendations']>()
      .mockResolvedValueOnce({ ok: false, code: 'recommendations-failed' })
      .mockResolvedValueOnce({ ok: true, skills: [review] })
    const face = props({ readRecommendations })
    render(<SkillHubPage {...face} />)
    expect((await screen.findByRole('alert')).textContent).toContain('推荐技能加载失败，请重试')

    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '重试' }))

    await screen.findByRole('heading', { name: review.name })
    expect(readRecommendations).toHaveBeenCalledTimes(2)
    expect(face.search).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps an explicit search visible when the initial recommendations arrive later', async () => {
    const recommendations = deferred<SkillHubSearchResponse>()
    const result = { ...review, slug: 'search-result', name: '搜索结果' }
    const face = props({
      readRecommendations: () => recommendations.promise,
      search: vi.fn<SkillHubPageProps['search']>(async () => ({ ok: true, skills: [result] })),
    })
    render(<SkillHubPage {...face} />)
    try {
      search('明确搜索')
      await screen.findByRole('heading', { name: result.name })
      await act(async () => { recommendations.resolve({ ok: true, skills: [review] }) })

      expect(screen.getByRole('heading', { name: result.name })).toBeTruthy()
      expect(screen.queryByRole('heading', { name: review.name })).toBeNull()
      expect(face.search).toHaveBeenCalledExactlyOnceWith('明确搜索', expect.any(AbortSignal))
    } finally {
      await act(async () => { recommendations.resolve({ ok: true, skills: [review] }) })
    }
  })

  it('returns from explicit search to the loaded recommendations without searching again', async () => {
    const result = { ...review, slug: 'search-result', name: '搜索结果' }
    const face = props({
      readRecommendations: vi.fn<SkillHubPageProps['readRecommendations']>(async () => ({ ok: true, skills: [review] })),
      search: vi.fn<SkillHubPageProps['search']>(async () => ({ ok: true, skills: [result] })),
    })
    render(<SkillHubPage {...face} />)
    await screen.findByRole('heading', { name: review.name })
    search('明确搜索')
    await screen.findByRole('heading', { name: result.name })

    fireEvent.click(screen.getByRole('button', { name: '返回推荐' }))

    expect(screen.getByRole('heading', { name: '推荐技能' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: review.name })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: result.name })).toBeNull()
    expect(face.readRecommendations).toHaveBeenCalledTimes(1)
    expect(face.search).toHaveBeenCalledTimes(1)
  })

  it('aborts the recommendation request when its panel unmounts and ignores the late response', async () => {
    const recommendations = deferred<SkillHubSearchResponse>()
    const readRecommendations = vi.fn<SkillHubPageProps['readRecommendations']>(() => recommendations.promise)
    const view = render(<SkillHubPage {...props({ readRecommendations })} />)
    expect(readRecommendations).toHaveBeenCalledTimes(1)
    expect(readRecommendations.mock.calls[0]![0].aborted).toBe(false)

    view.unmount()

    expect(readRecommendations.mock.calls[0]![0].aborted).toBe(true)
    await act(async () => { recommendations.resolve({ ok: true, skills: [review] }) })
    expect(screen.queryByRole('heading', { name: review.name })).toBeNull()
  })

  it('installs a recommended skill only after a click and shares the receipt with the installed tab', async () => {
    const completion = deferred<SkillHubInstallResponse>()
    const install = vi.fn<SkillHubPageProps['install']>(() => completion.promise)
    const readInstalled = vi.fn<SkillHubPageProps['readInstalled']>()
      .mockResolvedValueOnce({ ok: true, skills: [] }).mockResolvedValue({ ok: true, skills: [installed] })
    const face = props({ readRecommendations: async () => ({ ok: true, skills: [review] }), install, readInstalled })
    render(<SkillHubPage {...face} />)
    try {
      const button = await screen.findByRole('button', { name: '安装' })
      expect(install).not.toHaveBeenCalled()
      act(() => { fireEvent.click(button); fireEvent.click(button) })
      expect(install).toHaveBeenCalledExactlyOnceWith(review.slug, expect.any(AbortSignal))
      expect(screen.getByRole('button', { name: '安装中…' }).hasAttribute('disabled')).toBe(true)
      await act(async () => { completion.resolve({ ok: true, skill: installed }) })
      await waitFor(() => { expect(readInstalled).toHaveBeenCalledTimes(2) })
      expect(screen.getByRole('button', { name: '已安装' }).hasAttribute('disabled')).toBe(true)
      fireEvent.click(screen.getByRole('tab', { name: '已安装' }))
      expect(screen.getByRole('heading', { name: review.name })).toBeTruthy()
      expect(face.search).not.toHaveBeenCalled()
    } finally {
      await act(async () => { completion.resolve({ ok: true, skill: installed }) })
    }
  })

  it('marks an already installed recommendation without offering a duplicate installation', async () => {
    const face = props({
      readRecommendations: async () => ({ ok: true, skills: [review] }),
      readInstalled: async () => ({ ok: true, skills: [installed] }),
    })
    render(<SkillHubPage {...face} />)

    const badge = await screen.findByRole('button', { name: '已安装' })

    expect(badge.hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: '安装' })).toBeNull()
    expect(face.install).not.toHaveBeenCalled()
  })

  it('shows search cards with name, description, version and community source', async () => {
    const face = props()
    render(<SkillHubPage {...face} />)
    search('  代码审查  ')
    await screen.findByRole('heading', { name: '代码审查' })
    expect(face.search).toHaveBeenCalledWith('代码审查', expect.any(AbortSignal))
    expect(screen.getByText('检查代码变更')).toBeTruthy()
    expect(screen.getByText('版本 1.2.0')).toBeTruthy()
    expect(screen.getByText('来源：SkillHub 社区')).toBeTruthy()
    expect(screen.getByText('@community/review')).toBeTruthy()
    expect(face.install).not.toHaveBeenCalled()
    await expect(Array.from(screen.getByRole('listitem').querySelectorAll('h3,p,code,button')).map(node => node.textContent).join('\n') + '\n')
      .toMatchFileSnapshot('./expected/skillhub-search.txt')
  })

  it('keeps long community descriptions and identifiers complete in a dismissible details dialog', async () => {
    const longSkill = {
      ...review,
      name: 'StoryboardAndLongVideoMaterialDirector'.repeat(12),
      slug: `@community/${'storyboard-and-materials-'.repeat(20)}`,
      description: '整理人物设定、镜头、运镜和字幕，并保留每一段的完整创作说明。\n'.repeat(80),
      source: 'SkillHub 社区'.repeat(30),
      version: '2026.10.18-'.repeat(12),
    }
    const face = props({ readRecommendations: async () => ({ ok: true, skills: [longSkill] }) })
    render(<SkillHubPage {...face} />)
    await screen.findByRole('heading', { name: longSkill.name })
    const card = screen.getByRole('listitem')
    expect(card.querySelector('svg')).not.toBeNull()
    const details = within(card).getByRole('button', { name: '查看详情' })
    details.focus()
    fireEvent.click(details)

    const dialog = screen.getByRole('dialog', { name: '技能详情' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(within(dialog).getByRole('heading', { name: longSkill.name }).textContent).toBe(longSkill.name)
    expect(within(dialog).getByText(longSkill.slug).textContent).toBe(longSkill.slug)
    expect(within(dialog).getByRole('heading', { name: '技能介绍' }).nextElementSibling?.textContent).toBe(longSkill.description)
    expect(within(dialog).getByText(`来源：${longSkill.source}`).textContent).toContain(longSkill.source)
    expect(within(dialog).getByText(`版本 ${longSkill.version}`).textContent).toContain(longSkill.version)
    expect(face.install).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(document.activeElement).toBe(details)
  })

  it('installs the selected skill from details and keeps the dialog state synchronized', async () => {
    const completion = deferred<SkillHubInstallResponse>()
    const face = props({ readRecommendations: async () => ({ ok: true, skills: [review] }), install: () => completion.promise })
    render(<SkillHubPage {...face} />)
    fireEvent.click(await screen.findByRole('button', { name: '查看详情' }))
    const dialog = screen.getByRole('dialog', { name: '技能详情' })
    fireEvent.click(within(dialog).getByRole('button', { name: '安装' }))
    expect(within(dialog).getByRole('button', { name: '安装中…' }).hasAttribute('disabled')).toBe(true)
    await act(async () => { completion.resolve({ ok: true, skill: installed }) })
    expect(within(dialog).getByRole('button', { name: '已安装' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭技能详情' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('pages large catalogs without another network request and resets pagination for a new search', async () => {
    const skills = Array.from({ length: 51 }, (_, index) => ({ ...review, name: `社区技能 ${index + 1}`, slug: `community-${index + 1}` }))
    const face = props({ readRecommendations: vi.fn(async () => ({ ok: true as const, skills })) })
    render(<SkillHubPage {...face} />)
    await screen.findByRole('heading', { name: '社区技能 1' })
    expect(screen.getAllByRole('listitem')).toHaveLength(24)
    expect(screen.queryByRole('heading', { name: '社区技能 25' })).toBeNull()
    expect(screen.getByText('当前列表 51 个技能')).toBeTruthy()
    expect(screen.getByRole('button', { name: '上一页' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getByRole('heading', { name: '社区技能 25' })).toBeTruthy()
    expect(screen.getByText('第 2 / 3 页')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByRole('button', { name: '下一页' }).hasAttribute('disabled')).toBe(true)
    expect(face.readRecommendations).toHaveBeenCalledTimes(1)
    search()
    await screen.findByRole('heading', { name: review.name })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.queryByRole('navigation', { name: '技能分页' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '返回推荐' }))
    expect(screen.getByRole('heading', { name: '社区技能 1' })).toBeTruthy()
  })

  it('pages installed skills independently and shows their full identity in details', async () => {
    const skills = Array.from({ length: 25 }, (_, index) => ({ ...installed, slug: `installed-${index}`, name: `已安装技能 ${index + 1}` }))
    const face = props({ readInstalled: vi.fn(async () => ({ ok: true as const, skills })) })
    render(<SkillHubPage {...face} />)
    fireEvent.click(screen.getByRole('tab', { name: '已安装' }))
    await screen.findByRole('heading', { name: '已安装技能 1' })
    expect(screen.getAllByRole('listitem')).toHaveLength(24)
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
    const dialog = screen.getByRole('dialog', { name: '技能详情' })
    expect(within(dialog).getByRole('heading', { name: '已安装技能 25' })).toBeTruthy()
    expect(within(dialog).getByText('installed-24')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: '安装' })).toBeNull()
    expect(face.readInstalled).toHaveBeenCalledTimes(1)
    expect(face.install).not.toHaveBeenCalled()
  })

  it('ignores a late superseded search and aborts its request', async () => {
    const first = deferred<SkillHubSearchResponse>()
    const next = { ...review, slug: 'new-skill', name: '新结果' }
    const searchOperation = vi.fn<SkillHubPageProps['search']>()
      .mockImplementationOnce(() => first.promise).mockResolvedValueOnce({ ok: true, skills: [next] })
    render(<SkillHubPage {...props({ search: searchOperation })} />)
    search('旧搜索')
    search('新搜索')
    await screen.findByRole('heading', { name: '新结果' })
    expect(searchOperation.mock.calls[0]![1].aborted).toBe(true)
    await act(async () => { first.resolve({ ok: true, skills: [review] }) })
    expect(screen.queryByRole('heading', { name: '代码审查' })).toBeNull()
    expect(screen.getByRole('heading', { name: '新结果' })).toBeTruthy()
  })

  it('keeps old results visible after a failed search and retries the same submitted query', async () => {
    const operation = vi.fn<SkillHubPageProps['search']>()
      .mockResolvedValueOnce({ ok: true, skills: [review] })
      .mockResolvedValueOnce({ ok: false, code: 'search-failed' })
      .mockResolvedValueOnce({ ok: true, skills: [] })
    render(<SkillHubPage {...props({ search: operation })} />)
    search()
    await screen.findByRole('heading', { name: review.name })
    search('新关键词')
    await screen.findByRole('alert')
    expect(screen.getByRole('heading', { name: review.name })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText('没有找到相关技能，试试其他关键词')
    expect(operation.mock.calls.map(([query]) => query)).toEqual(['审查', '新关键词', '新关键词'])
  })

  it('installs only after a click, merges the receipt, refreshes inventory and blocks duplicate clicks', async () => {
    const completion = deferred<SkillHubInstallResponse>()
    const install = vi.fn(() => completion.promise)
    const readInstalled = vi.fn<SkillHubPageProps['readInstalled']>()
      .mockResolvedValueOnce({ ok: true, skills: [] }).mockResolvedValue({ ok: true, skills: [installed] })
    render(<SkillHubPage {...props({ install, readInstalled })} />)
    search()
    const button = await screen.findByRole('button', { name: '安装' })
    act(() => { fireEvent.click(button); fireEvent.click(button) })
    expect(install).toHaveBeenCalledTimes(1)
    expect(install).toHaveBeenCalledWith('@community/review', expect.any(AbortSignal))
    expect(screen.getByRole('button', { name: '安装中…' }).hasAttribute('disabled')).toBe(true)
    await act(async () => { completion.resolve({ ok: true, skill: installed }) })
    await waitFor(() => { expect(readInstalled).toHaveBeenCalledTimes(2) })
    expect(screen.getByRole('button', { name: '已安装' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: '已安装' }))
    expect(screen.getByRole('heading', { name: review.name })).toBeTruthy()
    await expect(Array.from(screen.getByRole('tabpanel').querySelectorAll('h2,h3,p,code')).map(node => node.textContent).join('\n') + '\n')
      .toMatchFileSnapshot('./expected/skillhub-installed.txt')
  })

  it('keeps a failed installation actionable and allows a user retry', async () => {
    const install = vi.fn<SkillHubPageProps['install']>()
      .mockResolvedValueOnce({ ok: false, code: 'download-failed' }).mockResolvedValue({ ok: true, skill: installed })
    render(<SkillHubPage {...props({ install })} />)
    search()
    fireEvent.click(await screen.findByRole('button', { name: '安装' }))
    expect((await screen.findByRole('alert')).textContent).toBe('技能下载失败，请重试')
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    await screen.findByRole('button', { name: '已安装' })
    expect(install).toHaveBeenCalledTimes(2)
  })

  it('refreshes inventory after already-installed and preserves installed rows on refresh errors', async () => {
    const readInstalled = vi.fn<SkillHubPageProps['readInstalled']>()
      .mockResolvedValueOnce({ ok: true, skills: [] })
      .mockResolvedValueOnce({ ok: true, skills: [installed] })
      .mockResolvedValueOnce({ ok: false, code: 'installed-invalid' })
      .mockResolvedValueOnce({ ok: true, skills: [installed] })
    render(<SkillHubPage {...props({ readInstalled, install: async () => ({ ok: false, code: 'already-installed' }) })} />)
    search()
    fireEvent.click(await screen.findByRole('button', { name: '安装' }))
    await screen.findByRole('button', { name: '已安装' })
    fireEvent.click(screen.getByRole('tab', { name: '已安装' }))
    fireEvent.click(screen.getByRole('button', { name: '刷新已安装列表' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('heading', { name: review.name })).toBeTruthy()
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  })

  it('aborts search, inventory and installation lifetimes when the panel unmounts', async () => {
    const heldInstall = deferred<SkillHubInstallResponse>()
    const heldSearch = deferred<SkillHubSearchResponse>()
    const readInstalled = vi.fn<SkillHubPageProps['readInstalled']>(async () => ({ ok: true, skills: [] }))
    const operation = vi.fn<SkillHubPageProps['search']>()
      .mockResolvedValueOnce({ ok: true, skills: [review] }).mockImplementationOnce(() => heldSearch.promise)
    const install = vi.fn<SkillHubPageProps['install']>(() => heldInstall.promise)
    const view = render(<SkillHubPage {...props({ search: operation, readInstalled, install })} />)
    search()
    fireEvent.click(await screen.findByRole('button', { name: '安装' }))
    search('下一条')
    view.unmount()
    expect(readInstalled.mock.calls[0]![0].aborted).toBe(true)
    expect(operation.mock.calls[1]![1].aborted).toBe(true)
    expect(install.mock.calls[0]![1].aborted).toBe(true)
    await act(async () => {
      heldSearch.resolve({ ok: true, skills: [] })
      heldInstall.resolve({ ok: true, skill: installed })
    })
    expect(readInstalled).toHaveBeenCalledTimes(1)
  })

  it('contains unexpected operation exceptions and retries installed loading', async () => {
    const readInstalled = vi.fn<SkillHubPageProps['readInstalled']>()
      .mockRejectedValueOnce(new Error('private read failure')).mockResolvedValue({ ok: true, skills: [] })
    render(<SkillHubPage {...props({ readInstalled, search: async () => { throw new Error('private search failure') } })} />)
    fireEvent.click(screen.getByRole('tab', { name: '已安装' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByRole('heading', { name: '还没有安装 SkillHub 技能' })
    fireEvent.click(screen.getByRole('tab', { name: '发现技能' }))
    search()
    expect((await screen.findByRole('alert')).textContent).toContain('暂时无法完成操作，请重试')
    expect(screen.queryByText(/private/u)).toBeNull()
  })

  it('refuses an empty form submission without requesting the catalog', () => {
    const face = props()
    render(<SkillHubPage {...face} />)
    const form = screen.getByRole('textbox', { name: '搜索 SkillHub 技能' }).closest('form')
    if (form === null) throw new Error('Search form missing')
    fireEvent.submit(form)
    expect(screen.getByRole('alert').textContent).toBe('请检查搜索词或技能名称后重试')
    expect(face.search).not.toHaveBeenCalled()
  })

  it('does not let an older inventory overwrite an explicit refresh', async () => {
    const old = deferred<SkillHubInstalledResponse>()
    const readInstalled = vi.fn<SkillHubPageProps['readInstalled']>()
      .mockImplementationOnce(() => old.promise).mockResolvedValue({ ok: true, skills: [installed] })
    render(<SkillHubPage {...props({ readInstalled })} />)
    fireEvent.click(screen.getByRole('tab', { name: '已安装' }))
    expect(screen.getByRole('status', { name: '正在读取已安装的技能' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '刷新已安装列表' }))
    await screen.findByRole('heading', { name: review.name })
    expect(readInstalled.mock.calls[0]![0].aborted).toBe(true)
    await act(async () => { old.resolve({ ok: true, skills: [] }) })
    expect(screen.getByRole('heading', { name: review.name })).toBeTruthy()
  })

  it('contains an unexpected install failure and preserves other installed skills after retry', async () => {
    const other = { slug: 'other', name: '已有技能', version: '2.0' }
    const readInstalled = vi.fn<SkillHubPageProps['readInstalled']>()
      .mockResolvedValueOnce({ ok: true, skills: [other] }).mockResolvedValue({ ok: true, skills: [other, installed] })
    const install = vi.fn<SkillHubPageProps['install']>()
      .mockRejectedValueOnce(new Error('private install details')).mockResolvedValue({ ok: true, skill: installed })
    render(<SkillHubPage {...props({ readInstalled, install })} />)
    search()
    fireEvent.click(await screen.findByRole('button', { name: '安装' }))
    expect((await screen.findByRole('alert')).textContent).toBe('暂时无法完成操作，请重试')
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    await screen.findByRole('button', { name: '已安装' })
    fireEvent.click(screen.getByRole('tab', { name: '已安装' }))
    expect(screen.getByRole('heading', { name: '已有技能' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: review.name })).toBeTruthy()
  })

  it('suppresses late rejected searches and pending inventory or install failures after cancellation', async () => {
    const oldSearch = deferred<SkillHubSearchResponse>()
    const inventory = deferred<SkillHubInstalledResponse>()
    const completion = deferred<SkillHubInstallResponse>()
    const searchOperation = vi.fn<SkillHubPageProps['search']>()
      .mockImplementationOnce(() => oldSearch.promise).mockResolvedValue({ ok: true, skills: [review] })
    const face = props({ search: searchOperation, readInstalled: () => inventory.promise, install: () => completion.promise })
    const view = render(<SkillHubPage {...face} />)
    search('旧搜索')
    search('新搜索')
    await screen.findByRole('heading', { name: review.name })
    await act(async () => { oldSearch.reject(new Error('cancelled old request')) })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    view.unmount()
    await act(async () => {
      inventory.reject(new Error('cancelled inventory'))
      completion.reject(new Error('cancelled install'))
    })
  })

  it('has an English label for every Chinese dictionary key', () => {
    expect(Object.keys(en)).toEqual(Object.keys(zh))
    expect(Object.values(en).every(value => value.length > 0)).toBe(true)
  })
})
