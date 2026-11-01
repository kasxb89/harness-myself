/** Server-owned registration eligibility; local presentation never infers who is new. @module */
export const SURVEY_ID = 'product-use-v1'
export const SURVEY_OPTIONS = ['daily_qa', 'office_writing', 'coding', 'study_research', 'image_design',
  'video_creation', 'ecommerce_marketing', 'automation', 'other'] as const
export type SurveyOption = typeof SURVEY_OPTIONS[number]
export interface SurveyData {
  readonly survey_id: typeof SURVEY_ID
  readonly schema_version: 1
  readonly eligible: boolean
  readonly status: 'not_eligible' | 'pending' | 'deferred' | 'submitted'
  readonly options: readonly { id: SurveyOption; label: string; label_en: string }[]
  readonly max_selections: number
  readonly max_notes_length: number
  readonly selected_option_ids: readonly SurveyOption[]
  readonly notes: string
  readonly registered_at: number
  readonly submitted_at: number
  readonly deferred_at: number
}
/** @param text - User-entered note. @returns Unicode scalar count, including one per emoji. */
export function surveyNoteLength(text: string): number { return Array.from(text).length }
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/u.test(value)
}
/** @param value - Untrusted Host payload. @returns The complete versioned survey, otherwise no enrollment is inferred. */
export function parseSurvey(value: unknown): SurveyData | undefined {
  const body = record(value)
  if (body?.schema_version !== 1 || body.survey_id !== SURVEY_ID || typeof body.eligible !== 'boolean'
    || !['not_eligible', 'pending', 'deferred', 'submitted'].includes(String(body.status))
    || body.eligible === (body.status === 'not_eligible') || !Array.isArray(body.options) || body.options.length > SURVEY_OPTIONS.length
    || !Number.isSafeInteger(body.max_selections) || Number(body.max_selections) < 1 || Number(body.max_selections) > SURVEY_OPTIONS.length
    || body.max_notes_length !== 1000 || typeof body.notes !== 'string' || surveyNoteLength(body.notes) > 1000
    || !Array.isArray(body.selected_option_ids) || body.selected_option_ids.length > Number(body.max_selections)
    || ['registered_at', 'submitted_at', 'deferred_at'].some(key => !Number.isSafeInteger(body[key]) || Number(body[key]) < 0)) return undefined
  const options = body.options.flatMap((value: unknown) => {
    const option = record(value)
    if (!SURVEY_OPTIONS.includes(option?.id as SurveyOption) || !text(option?.label) || !text(option.label_en)) return []
    return [{ id: option.id as SurveyOption, label: option.label, label_en: option.label_en }]
  })
  const ids = new Set(options.map(option => option.id))
  if (options.length !== body.options.length || ids.size !== options.length || body.eligible && options.length === 0
    || body.selected_option_ids.some(id => !ids.has(id as SurveyOption))
    || new Set(body.selected_option_ids).size !== body.selected_option_ids.length
    || body.status === 'submitted' && (body.selected_option_ids.length === 0 || Number(body.submitted_at) <= 0)) return undefined
  return { schema_version: 1, survey_id: SURVEY_ID, eligible: body.eligible, status: body.status as SurveyData['status'], options,
    max_selections: Number(body.max_selections), max_notes_length: 1000,
    selected_option_ids: body.selected_option_ids as SurveyOption[],
    notes: body.notes, registered_at: Number(body.registered_at),
    submitted_at: Number(body.submitted_at), deferred_at: Number(body.deferred_at) }
}
