import { describe, expect, it } from 'vitest'
import { assertModelCatalogConsistent, modelCatalogVersions } from '../src/model-catalog-consistency.ts'
import { readProductModelLimits } from '../src/model-limits.ts'

const version = 'a'.repeat(64)
const model = { id: 'new-text', model_config_version: version, context_window: 131072, max_output_tokens: 8192 }
const price = { model_name: model.id, model_config_version: version, context_window: 131072, max_output_tokens: 8192 }
const visible = () => modelCatalogVersions([model], 'id')
const limits = () => new Map([[model.id, readProductModelLimits(model)]])

describe('account-authorized model and pricing publication consistency', () => {
  it('accepts a newly published exact ID with paired capacities and ignores unauthorized extra rows', () => {
    expect(() => { assertModelCatalogConsistent(visible(), [price, { ...price, model_name: 'another-account-model' }], limits()) }).not.toThrow()
  })
  it.each([
    { rows: [] }, { rows: [{ ...price, model_config_version: 'b'.repeat(64) }] }, { rows: [{ model_name: model.id }] },
    { rows: [{ ...price, max_output_tokens: 4096 }] }, { rows: [{ ...price, context_window: 262144 }] },
  ])('rejects crossed publications or capacity pairs before dispatch: %j', ({ rows }) => {
    expect(() => { assertModelCatalogConsistent(visible(), rows, limits()) }).toThrow()
  })
  it('rejects a legacy account row crossed with a modern pricing row', () => {
    expect(() => { assertModelCatalogConsistent(new Map([[model.id, undefined]]), [price], new Map()) }).toThrow()
  })
  it('keeps legacy missing prices and capacities compatible', () => {
    expect(() => { assertModelCatalogConsistent(new Map([[model.id, undefined]]), [], new Map()) }).not.toThrow()
  })
  it('does not accept conflicting duplicate versions or malformed explicit metadata', () => {
    expect(() => modelCatalogVersions([model, { ...model, model_config_version: 'b'.repeat(64) }], 'id')).toThrow()
    expect(() => modelCatalogVersions([{ ...model, model_config_version: null }], 'id')).toThrow()
  })
})
