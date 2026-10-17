import { zoomEn, zoomZh } from '../zoom/locales.ts'

/** Copy owned by the PDF renderer. */
export const zh = {
  ...zoomZh,
  title: 'PDF',
  pageImage: 'PDF 第 {page} 页',
  loading: '文档渲染中...',
  rendering: '正在绘制页面…',
  failed: '无法显示 PDF：{message}',
  password: '此 PDF 需要密码，暂不支持预览',
  workerFailed: 'PDF 渲染进程无法继续，请重试',
  unsupported: 'PDF 预览需要完整文件内容',
  retry: '重试',
  sourceFailed: '无法读取 PDF，请重试或下载原文件',
  tooLarge: '此 PDF 超出预览大小限制，请下载后查看',
} satisfies Record<string, string>

/** PDF translation keys shared by both dictionaries. */
export type PdfLocaleKey = keyof typeof zh

/** English PDF-renderer dictionary. */
export const en = {
  ...zoomEn,
  title: 'PDF',
  pageImage: 'PDF page {page}',
  loading: 'Rendering document...',
  rendering: 'Rendering page…',
  failed: 'Cannot display PDF: {message}',
  password: 'This PDF requires a password; password-protected previews are not supported.',
  workerFailed: 'The PDF rendering process could not continue. Please retry.',
  unsupported: 'PDF preview requires the complete file contents.',
  retry: 'Retry',
  sourceFailed: 'Could not read the PDF. Retry or download the original file.',
  tooLarge: 'This PDF exceeds the preview size limit. Download it to view it.',
} satisfies Record<PdfLocaleKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** PDF page, loading, and failure messages. */
    sidebarPdf: PdfLocaleKey
  }
}
