/** Private snapshots never leak into gateway video requests. */
import { describe, expect, it } from 'vitest'
import { videoSubmission } from '../src/video-submission.ts'

const fields = { model: 'model_5', prompt: 'A moving cup', seconds: 30, size: '1280x720', gen_type: 'text_to_video', n: 1 }

describe('BlackRxAI video body serialization', () => {
  it('sends exactly the gateway whitelist when no reference is present', () => {
    const submission = videoSubmission({ ...fields, _blackrxReferences: [] })
    expect(submission.headers).toEqual({ 'content-type': 'application/json' })
    if (typeof submission.body !== 'string') throw new Error('Expected a JSON submission')
    expect(JSON.parse(submission.body)).toEqual(fields)
  })

  it('sends every image, video and audio as repeated file parts with immutable bytes', async () => {
    const assets = [
      { kind: 'image', mediaType: 'image/png', filename: 'first.png', base64: Buffer.from('first').toString('base64') },
      { kind: 'image', mediaType: 'image/jpeg', filename: 'second.jpg', base64: Buffer.from('second').toString('base64') },
      { kind: 'video', mediaType: 'video/mp4', filename: 'clip.mp4', base64: Buffer.from('clip').toString('base64') },
      { kind: 'audio', mediaType: 'audio/wav', filename: 'voice.wav', base64: Buffer.from('voice').toString('base64') },
    ]
    const submission = videoSubmission({ ...fields, gen_type: 'reference_to_video', _blackrxReferences: assets })
    expect(submission.headers).toEqual({})
    if (!(submission.body instanceof FormData)) throw new Error('Expected a multipart submission')
    expect([...submission.body.keys()]).toEqual([...Object.keys(fields), 'images', 'images', 'videos', 'audios'])
    expect(submission.body.get('seconds')).toBe('30')
    const files = [...submission.body.values()].filter((value): value is File => value instanceof File)
    expect(files.map(file => [file.name, file.type])).toEqual(assets.map(asset => [asset.filename, asset.mediaType]))
    expect(await Promise.all(files.map(file => file.text()))).toEqual(['first', 'second', 'clip', 'voice'])
    expect(submission.body.has('_blackrxReferences')).toBe(false)
    expect(submission.body.has('metadata')).toBe(false)
  })

  it.each(['metadata', 'resolution', 'ratio', 'duration', 'seed', 'authorization'])('refuses a forbidden prepared BlackRxAI field (%s)', (field) => {
    expect(() => videoSubmission({ ...fields, [field]: 'must-not-leak', _blackrxReferences: [] })).toThrow()
  })

  it('keeps existing video adapter bodies unchanged', () => {
    const request = { model: 'MiniMax-H3', duration: 5, metadata: { reference_audio: ['data:audio/wav;base64,AA=='] } }
    const submission = videoSubmission(request)
    if (typeof submission.body !== 'string') throw new Error('Expected a JSON submission')
    expect(JSON.parse(submission.body)).toEqual(request)
  })
})
