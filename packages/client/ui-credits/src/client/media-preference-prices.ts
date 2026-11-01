/** Public per-unit point estimates use only currently legal model specifications. */
import { creditUnitRange, type CreditUnitRange } from './price-comparisons.ts'
import { validPreferenceSelection, type MediaSelection, type PreferenceModel } from './media-preferences.ts'

/** Missing, partial, or fully covered default public prices for the current selection. */
export type MediaPreferencePrice = { readonly kind: 'unknown' }
  | { readonly kind: 'exact' | 'range' | 'from'; readonly points: CreditUnitRange }

const inputModes: Readonly<Record<string, 'text' | 'reference'>> = {
  'text-to-image': 'text', 'text-to-video': 'text', t2i: 'text', t2v: 'text', txt2img: 'text', text2video: 'text',
  'image-to-image': 'reference', 'image-to-video': 'reference', 'reference-to-image': 'reference',
  'reference-to-video': 'reference', i2i: 'reference', i2v: 'reference', img2img: 'reference',
}

/**
 * Filter public unit prices against the actual selected model and complete legal combinations.
 * @param model - Current account's authorized model or absence.
 * @param parameters - Explicit static draft or saved choices; references remain request-specific.
 * @returns A default reference estimate, never a task quote, request total or balance decision.
 */
export function mediaPreferencePrice(model: PreferenceModel | undefined,
  parameters: MediaSelection['parameters'] = {}): MediaPreferencePrice {
  if (model === undefined || !validPreferenceSelection(model, { model: model.id, parameters })) return { kind: 'unknown' }
  const pricing = model.pricing
  if (pricing?.status !== 'available' || pricing.coverage === 'none'
    || pricing.unit !== (model.kind === 'image' ? 'points/image' : 'points/second')) return { kind: 'unknown' }
  const legalRows = pricing.rows.filter((row) => {
    const staticParameters = model.kind === 'video' && row.parameters.count === 1
      ? Object.fromEntries(Object.entries(row.parameters).filter(([key]) => key !== 'count')) : row.parameters
    return validPreferenceSelection(model, { model: model.id, parameters: staticParameters })
  })
  const input = typeof parameters.mode === 'string' ? inputModes[parameters.mode.toLowerCase().replaceAll('_', '-')] : undefined
  const rows = legalRows.filter(row => (input === undefined || row.input === 'unspecified' || row.input === input)
    && Object.entries(row.parameters).every(([key, value]) => parameters[key] === undefined || parameters[key] === value))
  const points = creditUnitRange(rows.map(row => row.points))
  if (points === undefined) return { kind: 'unknown' }
  const unknownInput = input === undefined && rows.some(row => row.input !== 'unspecified')
  const unpricedSelection = Object.keys(parameters).some(key => key !== 'seed' && !(key === 'mode' && input !== undefined)
    && rows.some(row => row.parameters[key] === undefined))
  if (pricing.coverage === 'partial' || legalRows.length !== pricing.rows.length || unknownInput || unpricedSelection) {
    return { kind: 'from', points }
  }
  return { kind: points.minimum === points.maximum ? 'exact' : 'range', points }
}
