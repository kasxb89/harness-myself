import { describe, expect, it } from 'vitest'
import { ModelConfigVersionError, modelConfigVersionHeaders, readModelConfigRevision, readModelConfigVersion } from '../src/model-config-version.ts'

const malformedDigests = [undefined, null, '', [], {}, 1, 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64),
  'g'.repeat(64), ' ' + 'a'.repeat(64), 'a'.repeat(64) + '\n']

describe('published model configuration versions', () => {
  it('reads only the explicit model row field and preserves a legacy omission', () => {
    expect(readModelConfigVersion({})).toBeUndefined()
    expect(readModelConfigVersion({ version: 'a'.repeat(64), parameters: { model_config_version: 'b'.repeat(64) } })).toBeUndefined()
    const version = '0123456789abcdef'.repeat(4)
    expect(readModelConfigVersion({ model_config_version: version })).toBe(version)
  })

  it.each(malformedDigests)('rejects a malformed present version %#', (value) => {
    expect(() => readModelConfigVersion({ model_config_version: value })).toThrow(ModelConfigVersionError)
    expect(() => readModelConfigVersion({ model_config_version: value })).toThrow(
      expect.objectContaining({ code: 'MODEL_CONFIG_VERSION_INVALID', message: 'Published model configuration version is invalid' }))
  })

  it('reads a revision only from the outer directory envelope', () => {
    expect(readModelConfigRevision({})).toBeUndefined()
    expect(readModelConfigRevision({ revision: 'a'.repeat(64), data: [{ model_config_revision: 'b'.repeat(64) }] })).toBeUndefined()
    expect(readModelConfigRevision({ model_config_revision: 'c'.repeat(64) })).toBe('c'.repeat(64))
  })

  it.each(malformedDigests)('rejects a malformed present outer revision %#', (value) => {
    expect(() => readModelConfigRevision({ model_config_revision: value })).toThrow(ModelConfigVersionError)
    expect(() => readModelConfigRevision({ model_config_revision: value })).toThrow(
      expect.objectContaining({ code: 'MODEL_CONFIG_VERSION_INVALID' }))
  })

  it('never serializes an outer revision as the model request header', () => {
    const envelope = { model_config_revision: 'a'.repeat(64), data: [{ model_config_version: 'b'.repeat(64) }] }
    expect(readModelConfigRevision(envelope)).toBe('a'.repeat(64))
    expect(modelConfigVersionHeaders(readModelConfigVersion(envelope))).toEqual({})
    expect(modelConfigVersionHeaders(readModelConfigVersion(envelope.data[0]!)))
      .toEqual({ 'X-Yunshu-Model-Config-Version': 'b'.repeat(64) })
  })

  it('serializes the captured version without adding other protocol or authority fields', () => {
    expect(modelConfigVersionHeaders(undefined)).toEqual({})
    const version = readModelConfigVersion({ model_config_version: 'f'.repeat(64) })
    expect(modelConfigVersionHeaders(version)).toEqual({ 'X-Yunshu-Model-Config-Version': 'f'.repeat(64) })
  })
})
