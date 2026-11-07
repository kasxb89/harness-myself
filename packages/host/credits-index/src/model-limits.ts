/** Account-bound capacities disclosed by the product model endpoint. */
import { createHash } from 'node:crypto'
import { cloneTextCapabilities, type LlmTextCapabilities, type LlmReasoningControls, type LlmCapabilityVerification } from '@deepseek-ai/dsh-llm'

/** Current capacity and execution declarations for one exact public model id. */
export interface ProductModelLimits {
  /** Maximum combined request and response window. */
  contextWindow?: number
  /** Explicit execution declarations from this account’s current gateway directory. */
  textCapabilities?: LlmTextCapabilities
  /** Maximum generated output, including any reasoning counted in that output. */
  maxTokens?: number
}

/** Automatically managed capacities, separate from a user's model settings. */
export interface ManagedModelLimits extends ProductModelLimits {
  /** Non-secret fingerprint of the complete backend root and account id. */
  scope: string
  /** Product gateway capacities take precedence over model-level manual overrides. */
  authoritative?: boolean
}

/** A token capacity fits the gateway's positive signed 32-bit count. */
function tokenCapacity(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647
    ? value : undefined
}

/** Invalid gateway execution declarations make the directory update unusable. */
export class ProductModelCapabilitiesError extends Error {}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length <= 64 && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 256)
    ? [...(value as string[])] : undefined
}
function verification(value: unknown): value is LlmCapabilityVerification {
  return value === 'supported' || value === 'unsupported' || value === 'unverified'
}
function controls(value: unknown): LlmReasoningControls | undefined {
  const schema = object(value), properties = object(schema?.properties)
  if (schema?.type !== 'object' || schema.additionalProperties !== false || properties === undefined
    || Object.keys(schema).some(key => !['type', 'properties', 'additionalProperties'].includes(key))
    || Object.keys(properties).some(key => key !== 'reasoning_effort' && key !== 'enable_thinking')
    || Object.keys(properties).length > 1) return undefined
  const result: LlmReasoningControls = { type: 'object', properties: {}, additionalProperties: false }
  if (properties.reasoning_effort !== undefined) {
    const field = object(properties.reasoning_effort), values = strings(field?.enum)
    if (field?.type !== 'string' || values === undefined || values.length === 0
      || Object.keys(field).some(key => !['type', 'enum', 'default'].includes(key))
      || field.default !== undefined && (typeof field.default !== 'string' || !values.includes(field.default))) return undefined
    result.properties.reasoning_effort = { type: 'string', enum: values,
      ...typeof field.default === 'string' ? { default: field.default } : {} }
  }
  if (properties.enable_thinking !== undefined) {
    const field = object(properties.enable_thinking)
    if (field?.type !== 'boolean' || Object.keys(field).some(key => !['type', 'default'].includes(key))
      || field.default !== undefined && typeof field.default !== 'boolean') return undefined
    result.properties.enable_thinking = { type: 'boolean', ...typeof field.default === 'boolean' ? { default: field.default } : {} }
  }
  return result
}

/** Read a complete declaration without treating malformed or omitted booleans as support. */
function readTextCapabilities(record: Readonly<Record<string, unknown>>): LlmTextCapabilities | undefined {
  const parameters = record.parameters
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)
    || !('x-text-capabilities' in parameters)) return undefined
  const value: unknown = parameters['x-text-capabilities']
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !('tools' in value) || typeof value.tools !== 'boolean'
    || !('vision' in value) || typeof value.vision !== 'boolean'
    || !('reasoning' in value) || typeof value.reasoning !== 'boolean'
    || !('stream' in value) || typeof value.stream !== 'boolean'
    || !('max_input_tokens' in value) || tokenCapacity(value.max_input_tokens) === undefined) {
    throw new ProductModelCapabilitiesError('Invalid gateway text execution declaration')
  }
  const base: LlmTextCapabilities = { tools: value.tools, vision: value.vision, reasoning: value.reasoning, stream: value.stream,
    maxInputTokens: Number(value.max_input_tokens) }
  const raw = value as Record<string, unknown>
  if (raw.schema_version === undefined) return base
  if (raw.schema_version !== 2) throw new ProductModelCapabilitiesError('Unsupported gateway capability declaration version')
  const facts = object(raw.verification), tools = object(raw.tools_config), vision = object(raw.vision_config)
  const modalities = strings(raw.input_modalities), choices = strings(tools?.verified_tool_choices)
  const transports = strings(vision?.verified_transports), mimeTypes = strings(vision?.verified_mime_types)
  const reasoningControls = controls(raw.reasoning_controls)
  const mapping = raw.reasoning_control_mapping === undefined ? undefined : object(raw.reasoning_control_mapping)
  if (typeof raw.revision !== 'string' || raw.revision.length === 0 || raw.revision.length > 256
    || typeof raw.checked_at !== 'string' || !Number.isFinite(Date.parse(raw.checked_at))
    || !verification(facts?.tools) || !verification(facts.vision) || !verification(facts.reasoning)
    || modalities === undefined || !modalities.includes('text') || modalities.some(item => item !== 'text' && item !== 'image')
    || tools?.protocol !== 'openai-chat' || typeof tools.roundtrip_verified !== 'boolean' || choices === undefined || !verification(tools.parallel_calls)
    || transports === undefined || mimeTypes === undefined || typeof vision?.billing !== 'string'
    || !['configurable', 'always_on', 'automatic', 'unsupported', 'unknown'].includes(String(raw.reasoning_mode))
    || reasoningControls === undefined || raw.reasoning_omit_behavior !== 'provider_default'
    || vision.operational_status !== undefined && vision.operational_status !== 'temporarily_unavailable'
    || vision.operational_reason !== undefined && (typeof vision.operational_reason !== 'string' || vision.operational_reason.length > 512)
    || raw.reasoning_control_mapping !== undefined && (mapping === undefined || Object.keys(mapping).length > 0
      && (mapping.enable_thinking_with_effort !== true || typeof mapping.omit_effort_on_none !== 'boolean'
        || Object.keys(mapping).some(key => !['enable_thinking_with_effort', 'omit_effort_on_none'].includes(key))))
    || raw.operational_status !== 'available' && raw.operational_status !== 'fixed_lane_unavailable'
    || raw.operational_reason !== undefined && (typeof raw.operational_reason !== 'string' || raw.operational_reason.length > 512)) {
    throw new ProductModelCapabilitiesError('Invalid gateway version2 capability declaration')
  }
  return { ...base, schemaVersion: 2, revision: raw.revision, checkedAt: raw.checked_at,
    verification: { tools: facts.tools, vision: facts.vision, reasoning: facts.reasoning },
    inputModalities: modalities.map(item => item === 'image' ? 'image' : 'text'),
    toolsConfig: { protocol: 'openai-chat', roundtripVerified: tools.roundtrip_verified, verifiedToolChoices: choices, parallelCalls: tools.parallel_calls },
    visionConfig: { verifiedTransports: transports, verifiedMimeTypes: mimeTypes, billing: vision.billing,
      ...vision.operational_status === 'temporarily_unavailable' ? { operationalStatus: vision.operational_status } : {},
      ...typeof vision.operational_reason === 'string' ? { operationalReason: vision.operational_reason } : {} },
    reasoningMode: raw.reasoning_mode as NonNullable<LlmTextCapabilities['reasoningMode']>,
    reasoningControls, reasoningOmitBehavior: raw.reasoning_omit_behavior,
    ...mapping === undefined ? {} : { reasoningControlMapping: mapping.enable_thinking_with_effort === true
      ? { enableThinkingWithEffort: true as const, omitEffortOnNone: mapping.omit_effort_on_none as boolean } : {} },
    operationalStatus: raw.operational_status,
    ...typeof raw.operational_reason === 'string' ? { operationalReason: raw.operational_reason } : {} }
}

/**
 * Read the public endpoint's explicit capacity fields without inferring aliases.
 * @param record - one untrusted model-list entry.
 * @returns valid numeric capacities and any complete execution declaration.
 * @throws {ProductModelCapabilitiesError} When an explicit execution declaration is malformed.
 */
export function readProductModelLimits(record: Readonly<Record<string, unknown>>): ProductModelLimits {
  const textCapabilities = readTextCapabilities(record)
  const declared = textCapabilities === undefined ? {} : { textCapabilities }
  const contextWindow = tokenCapacity(record.context_window)
  const maxTokens = tokenCapacity(record.max_output_tokens)
  if (contextWindow !== undefined && maxTokens !== undefined && maxTokens > contextWindow) return declared
  return { ...declared, ...contextWindow === undefined ? {} : { contextWindow }, ...maxTokens === undefined ? {} : { maxTokens } }
}

/**
 * Bind retained capacities to the full deployment root and account without storing credentials.
 * @param baseUrl - normalized API root, including its deployment prefix.
 * @param accountId - the verified product account id.
 * @returns a stable, non-secret scope for this backend and account.
 */
export function productModelLimitsScope(baseUrl: string, accountId: string): string {
  return createHash('sha256').update(JSON.stringify(['product-model-limits-v1', baseUrl, accountId])).digest('hex')
}

/**
 * Refresh same-owner capacities and replace execution policy only after a successful listing.
 * @param previous - the model's previously persisted managed metadata.
 * @param incoming - successful fields; an empty object clears execution policy, while undefined retains it during a pending read.
 * @param scope - current backend and account binding.
 * @returns updated managed metadata, never capacities belonging to another scope.
 */
export function mergeProductModelLimits(
  previous: unknown,
  incoming: ProductModelLimits | undefined,
  scope: string,
): ManagedModelLimits | undefined {
  const record = previous !== null && typeof previous === 'object' && !Array.isArray(previous)
    ? previous as Record<string, unknown> : undefined
  const retained = record?.scope === scope ? record : undefined
  const contextWindow = incoming?.contextWindow ?? tokenCapacity(retained?.contextWindow)
  const maxTokens = incoming?.maxTokens ?? tokenCapacity(retained?.maxTokens)
  const retainedCapabilities = retained?.textCapabilities
  const textCapabilities = incoming === undefined && retainedCapabilities !== undefined
    ? readTextCapabilities({ parameters: { 'x-text-capabilities':
      retainedCapabilities !== null && typeof retainedCapabilities === 'object'
        ? { ...retainedCapabilities,
          max_input_tokens: 'maxInputTokens' in retainedCapabilities ? retainedCapabilities.maxInputTokens : undefined,
          ...'schemaVersion' in retainedCapabilities && retainedCapabilities.schemaVersion === 2 ? {
            schema_version: 2, checked_at: 'checkedAt' in retainedCapabilities ? retainedCapabilities.checkedAt : undefined,
            input_modalities: 'inputModalities' in retainedCapabilities ? retainedCapabilities.inputModalities : undefined,
            tools_config: 'toolsConfig' in retainedCapabilities && object(retainedCapabilities.toolsConfig) !== undefined ? {
              protocol: object(retainedCapabilities.toolsConfig)?.protocol,
              roundtrip_verified: object(retainedCapabilities.toolsConfig)?.roundtripVerified,
              verified_tool_choices: object(retainedCapabilities.toolsConfig)?.verifiedToolChoices,
              parallel_calls: object(retainedCapabilities.toolsConfig)?.parallelCalls } : undefined,
            vision_config: 'visionConfig' in retainedCapabilities && object(retainedCapabilities.visionConfig) !== undefined ? {
              verified_transports: object(retainedCapabilities.visionConfig)?.verifiedTransports,
              verified_mime_types: object(retainedCapabilities.visionConfig)?.verifiedMimeTypes,
              billing: object(retainedCapabilities.visionConfig)?.billing,
              operational_status: object(retainedCapabilities.visionConfig)?.operationalStatus,
              operational_reason: object(retainedCapabilities.visionConfig)?.operationalReason } : undefined,
            reasoning_mode: 'reasoningMode' in retainedCapabilities ? retainedCapabilities.reasoningMode : undefined,
            reasoning_controls: 'reasoningControls' in retainedCapabilities ? retainedCapabilities.reasoningControls : undefined,
            reasoning_control_mapping: 'reasoningControlMapping' in retainedCapabilities && object(retainedCapabilities.reasoningControlMapping) !== undefined ? {
              ...object(retainedCapabilities.reasoningControlMapping)?.enableThinkingWithEffort === true ? {
                enable_thinking_with_effort: true,
                omit_effort_on_none: object(retainedCapabilities.reasoningControlMapping)?.omitEffortOnNone } : {} } : undefined,
            reasoning_omit_behavior: 'reasoningOmitBehavior' in retainedCapabilities ? retainedCapabilities.reasoningOmitBehavior : undefined,
            operational_status: 'operationalStatus' in retainedCapabilities ? retainedCapabilities.operationalStatus : undefined,
            operational_reason: 'operationalReason' in retainedCapabilities ? retainedCapabilities.operationalReason : undefined,
          } : {} }
        : retainedCapabilities } })
    : incoming?.textCapabilities
  return contextWindow === undefined && maxTokens === undefined && textCapabilities === undefined ? undefined
    : { scope, ...contextWindow === undefined && maxTokens === undefined ? {} : { authoritative: true },
      ...textCapabilities === undefined ? {} : { textCapabilities: cloneTextCapabilities(textCapabilities) },
      ...contextWindow === undefined ? {} : { contextWindow }, ...maxTokens === undefined ? {} : { maxTokens } }
}
