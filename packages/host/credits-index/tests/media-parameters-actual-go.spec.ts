import { describe, expect, it } from 'vitest'
import { catalogFromPricing, type ImageParams } from '../src/media.ts'
import { imageGenerationModes } from '../src/image-generation-mode.ts'
import { imageSpecifications, resolveMediaSpecification } from '../src/media-request-specification.ts'
import fixture from './fixtures/media-parameters-actual-go-20261119.json' with { type: 'json' }

const halfKRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1']
const oneKRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9']
const twoKRatios = ['1:1', '3:4', '4:3', '9:16', '16:9']
const fourKRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']

function capability(caseId: string) {
  const input = fixture.cases.find(value => value.case_id === caseId)
  if (input === undefined) throw new Error(`Missing actual-Go parameter case ${caseId}`)
  const [model] = catalogFromPricing([input], null)
  if (model?.kind !== 'image') throw new Error(`Expected one parsed image model for ${caseId}`)
  return { input, model, params: model.params as ImageParams }
}

describe('actual Go image parameter publications consumed by the Client Host', () => {
  it('keeps all declared generation tiers while excluding the unsupported half-K reference tier', () => {
    const { model, params } = capability('live-unmodified')
    const edits = [
      ...oneKRatios.map(size => ({ size, resolution: '1K' })),
      ...twoKRatios.map(size => ({ size, resolution: '2K' })),
      ...fourKRatios.map(size => ({ size, resolution: '4K' })),
    ]
    expect(params.specifications).toEqual([
      ...halfKRatios.map(size => ({ size, resolution: '0.5K' })), ...edits,
    ])
    expect(params.maxCount).toBe(1)
    expect(params.maxEdits).toBe(1)
    expect(imageSpecifications(params, true)).toEqual(edits)
    expect(imageGenerationModes(model)).toEqual(['text-to-image', 'image-to-image'])
    expect(resolveMediaSpecification(imageSpecifications(params, true), { size: '1:1', resolution: '0.5K' }))
      .toMatchObject({ ok: false, code: 'SPECIFICATION_NOT_SUPPORTED' })
  })

  it('narrows both generation and reference output combinations to the configured 4K tier', () => {
    const { model, params } = capability('4K-only')
    const expected = fourKRatios.map(size => ({ size, resolution: '4K' }))
    expect(params.resolutions).toEqual(['4K'])
    expect(params.specifications).toEqual(expected)
    expect(params.editSpecifications).toEqual(expected)
    expect(imageSpecifications(params, true)).toEqual(expected)
    expect(imageGenerationModes(model)).toEqual(['text-to-image', 'image-to-image'])
    expect(resolveMediaSpecification(imageSpecifications(params, true), { size: '1:1', resolution: '1K' }))
      .toMatchObject({ ok: false, code: 'SPECIFICATION_NOT_SUPPORTED' })
  })

  it('removes reference editing when the configured output tier has no adapter-supported edit specification', () => {
    const { input, model, params } = capability('0.5K-generation-only')
    expect(params.specifications).toEqual(halfKRatios.map(size => ({ size, resolution: '0.5K' })))
    expect(params.maxEdits).toBe(0)
    expect(params.editSpecifications).toBeUndefined()
    expect(input.parameters).not.toHaveProperty('x-image-edit')
    expect(imageGenerationModes(model)).toEqual(['text-to-image'])
    expect(resolveMediaSpecification(imageSpecifications(params, false), { size: '1:1' }))
      .toEqual({ ok: true, specification: { size: '1:1', resolution: '0.5K' } })
  })

  it('removes the edit declaration when references are explicitly disabled without removing text generation tiers', () => {
    const { input, model, params } = capability('references-disabled')
    expect(input.controls).toEqual({ properties: { reference_images: false } })
    expect(input.parameters).not.toHaveProperty('x-image-edit')
    expect(params.maxEdits).toBe(0)
    expect(params.editSpecifications).toBeUndefined()
    expect(params.specifications).toHaveLength(36)
    expect(params.resolutions).toEqual(['0.5K', '1K', '2K', '4K'])
    expect(imageGenerationModes(model)).toEqual(['text-to-image'])
  })

  it('keeps the actual one-reference adapter ceiling despite an administrator requesting three', () => {
    const { input, model, params } = capability('overstated-reference-ceiling')
    expect(input.controls).toEqual({ properties: { reference_images: { type: 'array', items: { type: 'string' }, maxItems: 3 } } })
    expect(params.maxEdits).toBe(1)
    expect(params.referenceMaxBytes).toBe(5 * 1024 * 1024)
    expect(imageSpecifications(params, true)).toHaveLength(22)
    expect(imageGenerationModes(model)).toEqual(['text-to-image', 'image-to-image'])
  })

  it('uses the explicit complete 4K-square restriction instead of broadening to the parent field menus', () => {
    const { model, params } = capability('explicit-4K-square')
    const expected = [{ size: '1:1', resolution: '4K' }]
    expect(params.sizes).toEqual(['1:1'])
    expect(params.resolutions).toEqual(['4K'])
    expect(params.specifications).toEqual(expected)
    expect(params.editSpecifications).toEqual(expected)
    expect(imageSpecifications(params, true)).toEqual(expected)
    expect(resolveMediaSpecification(imageSpecifications(params, true), {}))
      .toEqual({ ok: true, specification: expected[0] })
    for (const unsupported of [{ size: '16:9', resolution: '4K' }, { size: '1:1', resolution: '1K' }]) {
      expect(resolveMediaSpecification(imageSpecifications(params, true), unsupported))
        .toMatchObject({ ok: false, code: 'SPECIFICATION_NOT_SUPPORTED' })
    }
    expect(imageGenerationModes(model)).toEqual(['text-to-image', 'image-to-image'])
  })
})
