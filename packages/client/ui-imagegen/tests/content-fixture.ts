import { bindSnapshotSelector } from '../../ui-renderer/src/client/bind.ts'
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import type { CreationContent, CreationContentSnapshot, ModeContent } from '@deepseek-ai/dsh-client-creation-content/client'

/** Mutable observable owned only by the component test. */
function observable<T>(initial: T) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (value: T) => { snapshot = value; for (const listener of listeners) listener() },
  }
}

/** Administrator-authored fixtures, independent of product dictionaries. */
export function contentFixture() {
  const empty: ModeContent = { title: { zh: '' }, description: { zh: '' }, promptPlaceholder: { zh: '' }, categories: [], templates: [], presets: [] }
  const template = (id: string, categoryId: string, title: string, description: string, prompt: string) => ({
    id, categoryId, title: { zh: title }, description: { zh: description }, prompt: { zh: prompt },
    coverAssetId: null, demoVideoAssetId: null, sortOrder: 0, status: 'published' as const,
  })
  const content: CreationContent = {
    schemaVersion: 1, revision: 'publication-1',
    image: { ...empty, categories: [{ id: 'commerce', label: { zh: '电商营销' }, sortOrder: 1, enabled: true }, { id: 'design', label: { zh: '视觉设计' }, sortOrder: 2, enabled: true }],
      templates: [template('recreate', 'commerce', '深度复刻', '后台参考模板', '后台复刻提示词'), template('poster', 'design', '海报', '促销版式', '后台海报提示词')],
      presets: [{ id: 'photo', label: { zh: '后台摄影' }, promptSuffix: { zh: '，后台摄影风格' }, sortOrder: 0, status: 'published' }] },
    video: { ...empty, categories: [{ id: 'commerce', label: { zh: '电商带货' }, sortOrder: 1, enabled: true }, { id: 'cinematic', label: { zh: '电影运镜' }, sortOrder: 2, enabled: true }],
      templates: [template('product', 'commerce', '商品出场短片', '后台商品描述', '后台商品脚本'), template('orbit', 'cinematic', '电影感环绕', '后台环绕描述', '后台环绕脚本')], presets: [] },
  }
  const publication = observable<CreationContentSnapshot>({ status: 'ready', content })
  const locale = observable<LocaleSnapshot>({ active: 'zh', locales: [], revision: 0 })
  const useCreationContent = bindSnapshotSelector(publication)
  const useLocale = bindSnapshotSelector(locale)
  return { publication, locale, content, useCreationContent, useLocale }
}
