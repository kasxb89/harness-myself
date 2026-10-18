import { expect, it } from 'vitest'
import { MINIMAX_H3_PROMPT_GUIDANCE, videoPromptFormatGuidance } from '../src/video-prompt-format.ts'

it('selects H3 notation only for the exact generation model without guessing from another model name', () => {
  expect(videoPromptFormatGuidance('MiniMax-H3')).toBe(MINIMAX_H3_PROMPT_GUIDANCE)
  for (const model of [undefined, '', 'deepseek-flash', 'MiniMax-Hailuo-2.3', 'minimax-h3', 'MiniMax-H3-other']) {
    expect(videoPromptFormatGuidance(model)).toBe('')
  }
})

it('keeps clip formatting local and compact while separating exact dialogue from background music', () => {
  expect(Buffer.byteLength(MINIMAX_H3_PROMPT_GUIDANCE)).toBeLessThanOrEqual(4000)
  expect(MINIMAX_H3_PROMPT_GUIDANCE).toContain('<d>[Chinese]我在这里等你。</d>')
  expect(MINIMAX_H3_PROMPT_GUIDANCE).toContain('integrated_multimodal_description, overall_soundscape, non_diegetic_music')
  expect(MINIMAX_H3_PROMPT_GUIDANCE).toContain('not proof that the resulting speech, lips or subtitles match')
  expect(MINIMAX_H3_PROMPT_GUIDANCE).toContain('Default to Simplified Chinese')
  expect(MINIMAX_H3_PROMPT_GUIDANCE).toContain('Keep protocol field names and tags unchanged')
  expect(MINIMAX_H3_PROMPT_GUIDANCE).not.toContain('descriptions in English')
  expect(MINIMAX_H3_PROMPT_GUIDANCE).not.toMatch(/https?:|curl|\bfetch\b|ffmpeg|\b(?:4K|8K|30 seconds)\b/u)
})
