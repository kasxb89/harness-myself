/** Decode the non-sensitive deployment preferences in the public status response. */
import type { ProductModelDisplay, ProductModelDisplayMap, ProductModelPresentation } from './model-presentation.ts'

/** Stable configuration failure which never contains the remote response. */
export class ClientModelConfigError extends Error {
  /** Stable diagnostic code for an invalid public model configuration. */
  readonly code = 'CLIENT_MODEL_CONFIG_INVALID'

  constructor() {
    super('Client model configuration is invalid')
    this.name = 'ClientModelConfigError'
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ClientModelConfigError()
  return value as Record<string, unknown>
}

function modelId(value: unknown, allowEmpty: boolean): string {
  if (typeof value !== 'string' || (!allowEmpty && value === '') || value.trim() !== value
    || /\p{Cc}/u.test(value) || Buffer.byteLength(value, 'utf8') > 255) throw new ClientModelConfigError()
  return value
}

/** Presentation uses the backend's Unicode White_Space edges; FEFF remains part of an exact id. */
function presentationModelId(value: string): void {
  if (value === '' || /^\p{White_Space}|\p{White_Space}$/u.test(value)
    || /\p{Cc}/u.test(value) || Buffer.byteLength(value, 'utf8') > 255) throw new ClientModelConfigError()
}

/**
 * Validate status metadata while tolerating an older server without this field.
 * @param body - parsed JSON from the configured backend's public status route.
 * @returns detached preferences, or undefined when the older server omits them.
 * @throws {ClientModelConfigError} when the response or a present configuration is invalid.
 */
export function parseClientModelConfigStatus(body: unknown): ProductModelPresentation | undefined {
  const status = object(body)
  if (status.success !== true) throw new ClientModelConfigError()
  const data = object(status.data)
  if (!Object.hasOwn(data, 'client_model_config')) return undefined
  const config = object(data.client_model_config)
  const fields = ['schema_version', 'default_chat_model', 'model_order']
  if (Object.keys(config).length !== fields.length || fields.some(field => !Object.hasOwn(config, field))
    || config.schema_version !== 1 || !Array.isArray(config.model_order) || config.model_order.length > 256) {
    throw new ClientModelConfigError()
  }
  const defaultChatModel = modelId(config.default_chat_model, true)
  const modelOrder = config.model_order.map(value => modelId(value, false))
  if (new Set(modelOrder).size !== modelOrder.length) throw new ClientModelConfigError()
  return { defaultChatModel: defaultChatModel === '' ? null : defaultChatModel, modelOrder }
}

/**
 * Decode display text independently of the older exact-three-field model preferences.
 * @param body - Parsed status JSON from the bound deployment.
 * @returns Detached exact-model entries, or undefined when an older server omits the sibling field.
 * @throws {ClientModelConfigError} when a present display document or any entry is invalid.
 */
export function parseClientModelPresentationStatus(body: unknown): ProductModelDisplayMap | undefined {
  const status = object(body)
  if (status.success !== true) throw new ClientModelConfigError()
  const data = object(status.data)
  if (!Object.hasOwn(data, 'client_model_presentation')) return undefined
  const config = object(data.client_model_presentation)
  if (config.schema_version !== 1 || Object.keys(config).length !== 2 || !Object.hasOwn(config, 'models')) {
    throw new ClientModelConfigError()
  }
  const models = object(config.models)
  const entries = Object.entries(models)
  if (entries.length > 256) throw new ClientModelConfigError()
  const output: [string, ProductModelDisplay][] = []
  for (const [id, raw] of entries) {
    presentationModelId(id)
    const display = object(raw)
    if (Object.keys(display).some(key => key !== 'description' && key !== 'badge')
      || (Object.hasOwn(display, 'description') && (typeof display.description !== 'string' || display.description.length > 500))
      || (Object.hasOwn(display, 'badge') && (typeof display.badge !== 'string' || display.badge.length > 32
        || /[\r\n\u0085\u2028\u2029]/u.test(display.badge)))) {
      throw new ClientModelConfigError()
    }
    output.push([id, {
      ...typeof display.description === 'string' ? { description: display.description } : {},
      ...typeof display.badge === 'string' ? { badge: display.badge } : {},
    }])
  }
  return Object.fromEntries<ProductModelDisplay>(output)
}
