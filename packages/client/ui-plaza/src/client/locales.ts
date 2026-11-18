/** Dictionaries for the sidebar Plaza page. */

/** Locale namespace owned by this plugin. */
export const NS = 'plaza'

/** Simplified Chinese copy for the plugin market panel. */
export const zh = {
  'panel': '广场',
  'missingTitle': '广场暂不可用',
  'missing': '当前配置未提供可用的插件市场',
} as const

/** English copy for every plugin market panel translation key. */
export const en: Record<keyof typeof zh, string> = {
  'panel': 'Plaza',
  'missingTitle': 'Plaza unavailable',
  'missing': 'The plugin market is not available in this configuration.',
}

/** Translation keys owned by the plugin market panel. */
export type PlazaKey = keyof typeof zh
