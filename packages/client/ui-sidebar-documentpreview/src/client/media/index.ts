/** Builtin streamed media renderers; Chromium owns decoding and range requests. */
import type { Context } from '@deepseek-ai/cordis'
import type { DocumentPreviewDefinition } from '../index.ts'
import { MediaBody } from './MediaBody.tsx'
import { en, zh } from './locales.ts'

/** Browser-supported containers still report codec failures through the media body. */
export const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'ogv'] as const
/** Common native audio containers; unsupported codecs retain external opening controls. */
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus'] as const
/** Shared implementation identity for the keyed document body. */
export const MEDIA_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/media'

/**
 * Describe native media independently from the keyed body registration.
 * @param title - Locale-owned renderer label.
 * @returns Renderer-owned streamed media metadata with no plain-text alternative.
 */
export function mediaBodyDefinition(title: () => string): DocumentPreviewDefinition {
  const extensions = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]
  return { id: MEDIA_BODY_ID, extensions, binaryExtensions: extensions, priority: 'builtin', title, loading: 'renderer', wrap: false }
}

/**
 * Register media copy, metadata, and the native player for the plugin lifetime.
 * @param ctx - Owning document renderer and slot context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('sidebarMedia')
  ctx.effect(() => ctx.locale.register('sidebarMedia', { zh, en }), 'document-media: dictionaries')
  ctx.effect(() => ctx.documentPreviews.register(mediaBodyDefinition(() => t('title'))), 'document-media: metadata')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document', key: MEDIA_BODY_ID, locale: 'sidebarMedia',
  }, MediaBody)), 'document-media: body')
}
