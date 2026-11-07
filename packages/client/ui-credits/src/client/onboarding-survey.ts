/** Server-owned registration eligibility and versioned, configurable questionnaire data. @module */
export const SURVEY_ID = 'product-use-v1'
/** Fixed option identifiers accepted by schema version 1. */
export const LEGACY_SURVEY_OPTIONS = ['daily_qa', 'office_writing', 'coding', 'study_research', 'image_design',
  'video_creation', 'ecommerce_marketing', 'automation', 'other'] as const
/** Stable option identifier with Chinese and English display labels. */
export interface SurveyChoice { readonly id: string; readonly label: string; readonly label_en: string }
interface SurveyFields {
  readonly survey_id: typeof SURVEY_ID
  readonly eligible: boolean
  readonly status: 'not_eligible' | 'pending' | 'deferred' | 'submitted'
  readonly options: readonly SurveyChoice[]
  readonly max_selections: number
  readonly max_notes_length: number
  readonly selected_option_ids: readonly string[]
  readonly notes: string
  readonly registered_at: number
  readonly submitted_at: number
  readonly deferred_at: number
}
/** Supported survey data; configurable schema version 2 also identifies its configuration revision. */
export type SurveyData = SurveyFields & ({ readonly schema_version: 1 } | {
  readonly schema_version: 2
  readonly config_revision: string
})
/**
 * Count Unicode code points in a survey note.
 * @param text - User-entered note.
 * @returns Code point count used by the survey note limit.
 */
export function surveyNoteLength(text: string): number { return Array.from(text).length }
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function text(value: unknown, configurable: boolean, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && (configurable ? surveyNoteLength(value) <= max : value.length <= 256)
    && !(configurable ? /[\u0000-\u001f\u007f-\u009f]/u : /[\u0000-\u001f\u007f]/u).test(value)
}
/**
 * Validate Host survey data and retain supported public fields.
 * @param value - Untrusted Host payload.
 * @returns A supported survey, or undefined for invalid data.
 */
export function parseSurvey(value: unknown): SurveyData | undefined {
  const body = record(value)
  if (body === undefined || body.schema_version !== 1 && body.schema_version !== 2) return undefined
  const configurable = body.schema_version === 2
  const maxOptions = configurable ? 64 : LEGACY_SURVEY_OPTIONS.length
  if (body.survey_id !== SURVEY_ID || typeof body.eligible !== 'boolean'
    || !['not_eligible', 'pending', 'deferred', 'submitted'].includes(String(body.status))
    || body.eligible === (body.status === 'not_eligible') || !Array.isArray(body.options) || body.options.length > maxOptions
    || !Number.isSafeInteger(body.max_selections) || Number(body.max_selections) < 1 || Number(body.max_selections) > maxOptions
    || configurable && (body.options.length === 0 || body.max_selections !== body.options.length
      || typeof body.config_revision !== 'string' || !/^[a-f0-9]{64}$/u.test(body.config_revision))
    || !configurable && (body.options.length !== maxOptions || body.max_selections !== maxOptions)
    || body.max_notes_length !== 1000 || typeof body.notes !== 'string' || surveyNoteLength(body.notes) > 1000
    || /[\u0000\u000b\u000c]/u.test(body.notes)
    || !Array.isArray(body.selected_option_ids) || body.selected_option_ids.length > Number(body.max_selections)
    || ['registered_at', 'submitted_at', 'deferred_at'].some(key => !Number.isSafeInteger(body[key]) || Number(body[key]) < 0)
    || body.status !== 'submitted'
      && (body.selected_option_ids.length !== 0 || body.notes !== '' || body.submitted_at !== 0)) return undefined
  const options = body.options.flatMap((value: unknown) => {
    const option = record(value)
    if (typeof option?.id !== 'string' || !(configurable ? /^[a-z][a-z0-9_]{0,47}$/u.test(option.id)
      : LEGACY_SURVEY_OPTIONS.some(id => id === option.id)) || !text(option.label, configurable, 80)
      || !text(option.label_en, configurable, 160)) return []
    return [{ id: option.id, label: option.label, label_en: option.label_en }]
  })
  const ids = new Set(options.map(option => option.id))
  if (options.length !== body.options.length || ids.size !== options.length || body.eligible && options.length === 0
    || body.selected_option_ids.some(id => typeof id !== 'string' || !ids.has(id))
    || new Set(body.selected_option_ids).size !== body.selected_option_ids.length
    || body.eligible && body.registered_at === 0 || !body.eligible && body.registered_at !== 0
    || body.status === 'deferred' && body.deferred_at === 0
    || (body.status === 'pending' || body.status === 'not_eligible') && body.deferred_at !== 0
    || body.status === 'submitted' && (body.selected_option_ids.length === 0 || Number(body.submitted_at) <= 0)) return undefined
  const fields: SurveyFields = { survey_id: SURVEY_ID, eligible: body.eligible, status: body.status as SurveyData['status'], options,
    max_selections: Number(body.max_selections), max_notes_length: 1000,
    selected_option_ids: body.selected_option_ids as string[], notes: body.notes,
    registered_at: Number(body.registered_at), submitted_at: Number(body.submitted_at), deferred_at: Number(body.deferred_at) }
  return body.schema_version === 2 ? { ...fields, schema_version: 2, config_revision: String(body.config_revision) }
    : { ...fields, schema_version: 1 }
}
