/** Dictionaries for the sidebar Plaza page. */

/** Locale namespace owned by this plugin. */
export const NS = 'plaza'

export const zh = {
  'panel': '广场',
  'missing': '还没有检测到插件市场插件。安装并启用「插件市场 (dshmarket)」后，这里会显示市场页面。',
} as const

export const en: Record<keyof typeof zh, string> = {
  'panel': 'Plaza',
  'missing': 'No plugin market plugin was detected. Install and enable “dshmarket” and the market appears here.',
}

export type PlazaKey = keyof typeof zh
