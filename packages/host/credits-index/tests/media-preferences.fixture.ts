import { catalogFromPricing } from '../src/media.ts'

export const preferenceModels = catalogFromPricing([
  { model_name: 'image-a', supported_endpoint_types: ['image-generation'], parameters: {
    seed: { type: 'integer' }, size: { enum: ['1:1', '16:9'] }, resolution: { enum: ['1k', '2k'] }, n: { minimum: 1, maximum: 3 },
    oneOf: [{ size: { const: '1:1' }, resolution: { const: '1k' } }, { size: { const: '16:9' }, resolution: { const: '2k' } }],
  } },
  { model_name: 'image-b', supported_endpoint_types: ['image-generation'], parameters: { size: { enum: ['1:1'] } } },
  { model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] },
  { model_name: 'video-b', supported_endpoint_types: ['openai-video'], parameters: {
    generate_audio: { type: 'boolean' }, watermark: { type: 'boolean' }, seed: { type: 'integer' }, duration: { enum: [5, 10] }, resolution: { enum: ['720P', '1080P'] }, ratio: { enum: ['16:9'] },
    oneOf: [{ duration: { const: 5 }, resolution: { const: '720P' }, ratio: { const: '16:9' } },
      { duration: { const: 10 }, resolution: { const: '1080P' }, ratio: { const: '16:9' } }],
  } },
], null)
