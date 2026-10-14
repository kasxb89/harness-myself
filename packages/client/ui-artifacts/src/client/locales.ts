/** Dictionaries for the sidebar Artifacts page. */

/** Locale namespace owned by this plugin. */
export const NS = 'artifacts'

export const zh = {
  'panel': '产物',
  'title': '产物',
  'refresh': '刷新',
  'loading': '正在读取…',
  'empty': '暂无产物 — 代理生成的图片、视频、文档会出现在这里。',
  'emptyRoots': '还没有配置产物目录。在 profile 的组合配置里给 artifacts-index 指定 roots。',
  'count': '{count} 项',
  'truncated': '已达上限，仅显示前 {count} 项',
  'error': '读取失败：{message}',
  'preview': '预览',
  'previewHint': '选择左侧的产物查看内容',
  'unsupported': '这类文件不在此处预览，右键或用系统应用打开。',
  'kind.all': '全部',
  'kind.image': '图片',
  'kind.video': '视频',
  'kind.audio': '音频',
  'kind.document': '文档',
  'kind.sheet': '表格',
  'kind.slides': '演示',
  'kind.archive': '压缩包',
  'kind.code': '代码',
  'kind.text': '文本',
  'kind.other': '其他',
} as const

export const en: Record<keyof typeof zh, string> = {
  'panel': 'Artifacts',
  'title': 'Artifacts',
  'refresh': 'Refresh',
  'loading': 'Reading…',
  'empty': 'No artifacts yet — images, videos, and documents the agent produces land here.',
  'emptyRoots': 'No artifact directory is configured. Set `roots` for artifacts-index in the profile bundle config.',
  'count': '{count} items',
  'truncated': 'Showing the first {count} items',
  'error': 'Read failed: {message}',
  'preview': 'Preview',
  'previewHint': 'Pick an artifact on the left',
  'unsupported': 'This file type has no preview here; open it with a system application.',
  'kind.all': 'All',
  'kind.image': 'Images',
  'kind.video': 'Videos',
  'kind.audio': 'Audio',
  'kind.document': 'Documents',
  'kind.sheet': 'Sheets',
  'kind.slides': 'Slides',
  'kind.archive': 'Archives',
  'kind.code': 'Code',
  'kind.text': 'Text',
  'kind.other': 'Other',
}

export type ArtifactsKey = keyof typeof zh
