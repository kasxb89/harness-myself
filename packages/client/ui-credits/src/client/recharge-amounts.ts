/**
 * The preset top-up ladder: what the operator actually buys, offered by both
 * the sidebar entry and the page's own amount row, so the two never disagree
 * about which amounts are one click away.
 */

/** Preset top-up amounts in yuan, cheapest first. */
export const QUICK_AMOUNTS_YUAN: readonly number[] = [30, 50, 100, 300, 500, 1000]
