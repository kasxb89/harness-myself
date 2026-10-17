/** Read and cache limits shared by Host configuration and browser document previews. */
import z from '@deepseek-ai/schemastery'

/** PDF reads, transient Office reuse, and browser spreadsheet parser limits. */
export interface Config {
  /** Complete-file capacity for artifact PDF preview reads. */
  pdf: {
    /** Maximum actual source bytes, independently of Office cache capacity. */
    maxBytes: number
  }
  /** Retained PDF limits; pending conversions share cancellation by reader lifetime. */
  office: {
    /** Maximum retained completed PDFs. */
    maxCachedEntries: number
    /** Maximum retained PDF bytes, counted by each binary buffer's byteLength. */
    maxCachedBytes: number
    /** Maximum unsettled Host conversion RPCs, including cancellation teardown. */
    maxPending: number
    /** Maximum readers including source and renderer metadata lookups. */
    maxReaders: number
  }
  /** Browser spreadsheet parser and dense cell allocation limits. */
  excel: {
    /** Maximum source file bytes. */
    maxBytes: number
    /** Maximum combined rectangular cell area across worksheets. */
    maxCells: number
    /** Maximum parser Worker lifetime in milliseconds. */
    timeoutMs: number
  }
}

/** Deployment limits applied before document preview registration. */
export const Config: z<{ pdf?: Partial<Config['pdf']>; office?: Partial<Config['office']>; excel?: Partial<Config['excel']> }, Config> = z.object({
  pdf: z.object({ maxBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(100 * 1024 * 1024) }),
  office: z.object({
    maxCachedEntries: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(8),
    maxCachedBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(64 * 1024 * 1024),
    maxPending: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(8),
    maxReaders: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(32),
  }),
  excel: z.object({
    maxBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(16 * 1024 * 1024),
    maxCells: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(250_000),
    timeoutMs: z.natural().min(1).max(2_147_483_647).default(15_000),
  }),
})
