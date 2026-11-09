/** Strict parsing and header serialization for published model configuration versions. @module */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Opaque version of one published model configuration, independent of account authority. */
export type ModelConfigVersion = Branded<'ModelConfigVersion'>

/** Opaque directory-wide publication revision; never a per-model generation version. */
export type ModelConfigRevision = Branded<'ModelConfigRevision'>

/** Malformed explicit version metadata cannot silently become an unversioned request. */
export class ModelConfigVersionError extends Error {
  /** Malformed explicit metadata; never permission to send without the version. */
  readonly code = 'MODEL_CONFIG_VERSION_INVALID'

  constructor() {
    super('Published model configuration version is invalid')
    this.name = 'ModelConfigVersionError'
  }
}

function configDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new ModelConfigVersionError()
  return value
}

/**
 * Parse only the model row's explicit wire field; omission preserves legacy compatibility.
 * @param row - Parsed model or pricing row from the configured gateway.
 * @returns The validated lowercase SHA-256 version, or undefined when absent.
 * @throws {ModelConfigVersionError} When the field is present but malformed.
 */
export function readModelConfigVersion(row: Readonly<Record<string, unknown>>): ModelConfigVersion | undefined {
  if (!Object.hasOwn(row, 'model_config_version')) return undefined
  return brandString<ModelConfigVersion>(configDigest(row.model_config_version))
}

/**
 * Parse a directory envelope's publication revision without treating it as a model version.
 * @param envelope - Parsed outer model-list or pricing response.
 * @returns The validated directory revision, or undefined for a legacy envelope.
 * @throws {ModelConfigVersionError} When the revision field is present but malformed.
 */
export function readModelConfigRevision(envelope: Readonly<Record<string, unknown>>): ModelConfigRevision | undefined {
  if (!Object.hasOwn(envelope, 'model_config_revision')) return undefined
  return brandString<ModelConfigRevision>(configDigest(envelope.model_config_revision))
}

/**
 * Serialize a captured version without granting routing, credential or retry authority.
 * @param version - Version already bound by its caller to the selected managed model.
 * @returns The single version header, or no header for an unversioned legacy operation.
 */
export function modelConfigVersionHeaders(version: ModelConfigVersion | undefined): Readonly<Record<string, string>> {
  return version === undefined ? {} : { 'X-Yunshu-Model-Config-Version': version }
}
