/** Validated publication polling configuration projected to the browser. */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'

/** Polling settings shared by the Host and Client registrations. */
export interface Config {
  /** Interval between publication reads while the application is visible. */
  refreshIntervalMs: number
  /** Deadline for one publication read. */
  timeoutMs: number
}

/** Publication polling and request deadlines. */
export const Config = z.object({
  refreshIntervalMs: z.number().step(1).min(1000).max(300_000).default(15_000),
  timeoutMs: z.number().step(1).min(1000).max(60_000).default(10_000),
})

/**
 * Validate configuration while the Client half provides published content.
 * @param _ctx Host plugin context.
 * @param _config Validated settings projected to the Client.
 */
export function apply(_ctx: Context, _config: Config): void {}
