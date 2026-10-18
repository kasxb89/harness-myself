/** Locale-owned media controls and playback failures. */
export const zh = {
  title: '媒体',
  preview: '媒体预览：{name}',
  loading: '正在加载媒体...',
  unavailable: '无法读取媒体文件，请重试或使用系统应用打开',
  failed: '当前播放器无法播放此文件，请重试或使用系统应用打开',
  retry: '重试',
} satisfies Record<string, string>

/** Media renderer dictionary keys. */
export type MediaPreviewKey = keyof typeof zh

/** English labels share the Chinese dictionary keys. */
export const en = {
  title: 'Media',
  preview: 'Media preview: {name}',
  loading: 'Loading media...',
  unavailable: 'This media file could not be read. Retry or open it in a system app.',
  failed: 'This player cannot play the file. Retry or open it in a system app.',
  retry: 'Retry',
} satisfies Record<MediaPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Native media playback labels and local, actionable failures. */
    sidebarMedia: MediaPreviewKey
  }
}
