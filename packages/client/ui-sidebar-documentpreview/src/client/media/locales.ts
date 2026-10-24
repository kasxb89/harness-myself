/** Locale-owned media controls and playback failures. */
export const zh = {
  'playback.seek': '播放进度',
  'playback.waiting': '读取视频时长后可拖动播放',
  'playback.failed': '暂时无法跳转播放位置，请等待视频加载后重试',
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
  'playback.seek': 'Playback position',
  'playback.waiting': 'Seeking is available after the video duration loads',
  'playback.failed': 'This position could not be reached. Wait for the video to load and retry.',
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
