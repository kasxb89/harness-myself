import { describe, expect, it } from 'vitest'
import { videoShotInput } from '../src/video-shot-references.ts'
import type { VideoProjectInput } from '../src/video-project-types.ts'

describe('shot-bound reference media', () => {
  it('retains the original input when the whole work explicitly shares its references', () => {
    const input: VideoProjectInput = { prompt: 'A scene', totalDurationSeconds: 15,
      referenceImages: ['shared-image'], referenceVideos: ['shared-video'], referenceAudios: ['shared-audio'] }
    expect(videoShotInput(input, 0)).toBe(input)
  })

  it('merges each kind in order without duplicating shared materials or taking another shot’s inputs', () => {
    const input: VideoProjectInput = { prompt: 'Two scenes', totalDurationSeconds: 30,
      referenceImages: ['shared-image'], referenceVideos: ['shared-video'], referenceAudios: ['shared-audio'],
      shotReferenceImages: [['first-image', 'shared-image'], ['second-image']],
      shotReferenceVideos: [['first-video', 'shared-video'], ['second-video']],
      shotReferenceAudios: [['first-audio', 'shared-audio'], ['second-audio']] }
    const original = structuredClone(input)
    expect(videoShotInput(input, 0)).toMatchObject({ referenceImages: ['shared-image', 'first-image'],
      referenceVideos: ['shared-video', 'first-video'], referenceAudios: ['shared-audio', 'first-audio'] })
    expect(videoShotInput(input, 1)).toMatchObject({ referenceImages: ['shared-image', 'second-image'],
      referenceVideos: ['shared-video', 'second-video'], referenceAudios: ['shared-audio', 'second-audio'] })
    expect(input).toEqual(original)
  })

  it('retains absent image controls when only video and audio are shot-bound', () => {
    const input: VideoProjectInput = { prompt: 'A scene', totalDurationSeconds: 15,
      shotReferenceVideos: [['video']], shotReferenceAudios: [['audio']] }
    const shot = videoShotInput(input, 0)
    expect(shot).toMatchObject({ referenceVideos: ['video'], referenceAudios: ['audio'] })
    expect(shot).not.toHaveProperty('referenceImages')
  })
})
