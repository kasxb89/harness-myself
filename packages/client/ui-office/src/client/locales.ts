/** Dictionaries for the sidebar Office page. */

/** Locale namespace owned by this plugin. */
export const NS = 'office'

export const zh = {
  'panel': 'Office',
  'title': 'Office',
  'hint': '文档 / 表格 / 幻灯片工作区',
} as const

export const en: Record<keyof typeof zh, string> = {
  'panel': 'Office',
  'title': 'Office',
  'hint': 'Documents, spreadsheets and slides',
}

export type OfficeKey = keyof typeof zh
