/** Public demand-page options shared by Host bootstrap and browser composition. */
import z from '@deepseek-ai/schemastery'
import type { CaseShowcaseItem, CaseShowcaseMedia } from './client/case-showcase-types.ts'

/** Client transport deadlines and refresh cadence; service publication is owned by the backend. */
export interface Config {
  /** Local transport availability, independent of the backend's new-demand switch. */
  enabled?: boolean
  /** Complete deadline for one metadata request or bounded upload chunk. */
  requestTimeoutMs?: number
  /** Complete deadline for one resumable binary upload slice on slower connections. */
  uploadTimeoutMs?: number
  /** Delay between message reads while this panel is in the foreground. */
  foregroundPollMs?: number
  /** Delay between background message reads; background views never mark messages read. */
  backgroundPollMs?: number
  /** Delay between demand-list refreshes. */
  listPollMs?: number
  /** Explicitly configured public reference materials, separate from user demand records. */
  showcaseItems?: (Omit<CaseShowcaseItem, 'media'> & {
    /** Ordered public media entries included in the case. */
    media: CaseShowcaseMedia[]
  })[]
}

/** Validate the local carrier settings before account reads or timers start. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  requestTimeoutMs: z.natural().min(1000).max(300_000).default(20_000),
  uploadTimeoutMs: z.natural().min(1000).max(3_600_000).default(120_000),
  foregroundPollMs: z.natural().min(1000).max(300_000).default(3000),
  backgroundPollMs: z.natural().min(1000).max(300_000).default(15_000),
  listPollMs: z.natural().min(1000).max(300_000).default(15_000),
  showcaseItems: z.array(z.object({
    id: z.string().required(), title: z.string().required(), description: z.string().required(),
    category: z.union(['pc', 'web', 'miniapp', 'exe', 'game', 'image', 'video']).required(),
    coverUrl: z.string().required(),
    media: z.array(z.object({ kind: z.union(['image', 'video']).required(), url: z.string().required(),
      posterUrl: z.string().default('') })).max(30).required(),
    sourceName: z.string().default(''), sourceUrl: z.string().default(''), attribution: z.string().default(''),
  })).max(200).default([]),
})

/** Page-global key carrying explicitly public demand-page settings only. */
export const DEMANDS_CONFIG_GLOBAL = '__DSH_DEMANDS_CONFIG__'

/**
 * Project validated public settings without retaining unrelated caller-owned fields.
 * @param input - Loader options or a browser-bootstrap payload.
 * @returns Only the feature's declared public fields and case metadata.
 */
export function publicDemandConfig(input: unknown): Required<Config> {
  // Resolve accepts untrusted bootstrap values and validates every declared field.
  const [config] = z.resolve(input, Config, {}) as [Required<Config>]
  return {
    enabled: config.enabled, requestTimeoutMs: config.requestTimeoutMs, uploadTimeoutMs: config.uploadTimeoutMs,
    foregroundPollMs: config.foregroundPollMs, backgroundPollMs: config.backgroundPollMs, listPollMs: config.listPollMs,
    showcaseItems: config.showcaseItems.map(item => ({
      id: item.id, title: item.title, description: item.description, category: item.category, coverUrl: item.coverUrl,
      media: item.media.map(file => ({ kind: file.kind, url: file.url, posterUrl: file.posterUrl ?? '' })),
      sourceName: item.sourceName ?? '', sourceUrl: item.sourceUrl ?? '', attribution: item.attribution ?? '',
    })),
  }
}
