/** Resolve one complete published media specification before quoting or submitting. @module */
import { videoDurations, type MediaSpecification, type VideoParams } from './media.ts'

/** Fields with shared spelling in the public catalog and prepared native request. */
const specificationFields = ['size', 'resolution', 'seconds', 'ratio', 'quality', 'mode'] as const

/** An unsupported or ambiguous combination cannot select a paid variant implicitly. */
export type MediaSpecificationResolution = { readonly ok: true; readonly specification: MediaSpecification }
  | { readonly ok: false; readonly code: 'SPECIFICATION_NOT_SUPPORTED' | 'SPECIFICATION_REQUIRED'; readonly message: string }

/**
 * Fill omitted dimensions only when the public menu identifies exactly one complete specification.
 * Legacy models without a complete menu retain their existing independent parameter validation.
 * @param menu - Complete public combinations; an explicitly empty menu permits no submission.
 * @param selected - Explicit caller dimensions, after primitive validation.
 * @returns The unique published specification, or a safe pre-submission error.
 */
export function resolveMediaSpecification(
  menu: readonly MediaSpecification[] | undefined, selected: MediaSpecification,
): MediaSpecificationResolution {
  if (menu === undefined) return { ok: true, specification: selected }
  const candidates = menu.filter(specification => specificationFields.every(field =>
    selected[field] === undefined || selected[field] === specification[field]))
  const [candidate] = candidates
  if (candidate === undefined) return { ok: false, code: 'SPECIFICATION_NOT_SUPPORTED',
    message: '所选参数不属于当前模型的完整规格，请重新选择规格；尚未提交生成。' }
  if (candidates.length !== 1) return { ok: false, code: 'SPECIFICATION_REQUIRED',
    message: '当前参数对应多个规格，请明确选择完整规格和质量档位；尚未提交生成。' }
  return { ok: true, specification: candidate }
}

/**
 * Read native clip durations for the selected quality and mode before planning paid segments.
 * @param params - Current public video capability.
 * @param selected - Requested output tier, quality, vendor mode, ratio and native size.
 * @returns Only durations offered by matching complete specifications; legacy menus retain their existing rules.
 */
export function videoSpecificationDurations(
  params: VideoParams, selected: Pick<MediaSpecification, 'resolution' | 'quality' | 'mode' | 'ratio' | 'size'>,
): readonly number[] {
  if (params.specifications === undefined) return videoDurations(params, selected.resolution ?? null)
  const dimensions = ['resolution', 'quality', 'mode', 'ratio', 'size'] as const
  return [...new Set(params.specifications.filter(specification => dimensions.every(field =>
    selected[field] === undefined || selected[field] === specification[field]))
    .flatMap(specification => specification.seconds === undefined ? [] : [specification.seconds]))]
    .sort((left, right) => left - right)
}
