import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { afterEach, expect, it } from 'vitest'
import { CREATION_LANGUAGE_GUIDANCE, registerCreationWorkflows, VIDEO_DIRECTOR_PROMPT } from '../src/creation-workflows.ts'
import { COMMUNITY_VIDEO_DIRECTION } from '../src/creation-director-knowledge.ts'
import { MINIMAX_H3_PROMPT_GUIDANCE } from '../src/video-prompt-format.ts'

let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose() })

it('publishes shared community direction and an optional H3 skill and removes both with their owner', async () => {
  ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const fiber = ctx.plugin((owner) => { registerCreationWorkflows(owner) })
  await fiber.await()
  const summaries = (await ctx.skills.snapshot()).skills
  expect(summaries.map(skill => skill.name).toSorted()).toEqual(['yunshu-minimax-h3', 'yunshu-video-director'])
  for (const summary of summaries) {
    expect(summary).toMatchObject({ source: 'bundled', invocation: { modelInvocable: true, userInvocable: true } })
  }
  const skill = await ctx.skills.get('yunshu-video-director')
  expect(skill?.content).toContain(VIDEO_DIRECTOR_PROMPT)
  expect(skill?.content).toContain(CREATION_LANGUAGE_GUIDANCE)
  expect(skill?.content).toContain(COMMUNITY_VIDEO_DIRECTION)
  expect(skill?.content).not.toContain(MINIMAX_H3_PROMPT_GUIDANCE)
  await expect(`${skill?.content}\n`).toMatchFileSnapshot('./expected/video-director-skill.md')
  const h3 = await ctx.skills.get('yunshu-minimax-h3')
  expect(h3?.content).toBe(MINIMAX_H3_PROMPT_GUIDANCE)
  await expect(`${h3?.content}\n`).toMatchFileSnapshot('./expected/minimax-h3-skill.md')
  await fiber.dispose()
  expect(await ctx.skills.get('yunshu-video-director')).toBeUndefined()
  expect(await ctx.skills.get('yunshu-minimax-h3')).toBeUndefined()
  expect((await ctx.skills.snapshot()).skills).toEqual([])
})

it('registers when the shared skill registry becomes available after the credits workflow', async () => {
  ctx = new Context()
  const fiber = ctx.plugin((owner) => { registerCreationWorkflows(owner) })
  await ctx.plugin(SkillRegistry)
  await fiber.await()
  expect((await ctx.skills.snapshot()).skills.map(skill => skill.name).toSorted())
    .toEqual(['yunshu-minimax-h3', 'yunshu-video-director'])
})

it('keeps native execution fast paths and rejects script fallbacks beyond supported post-production', async () => {
  ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin((owner) => { registerCreationWorkflows(owner) })
  const content = (await ctx.skills.get('yunshu-video-director'))?.content
  expect(content).toContain('For a simple short clip or a user-supplied finished prompt, call generate_video directly.')
  expect(content).toContain('Do not add character-sheet generation, extra reference images or a separate planning round')
  expect(content).toContain('For an existing workspace image or a current-chat reference not accepted directly by generate_video, '
    + 'use generate_video_project even for a single short clip.')
  expect(content).toContain('For a finished video longer than one supported model clip, use generate_video_project.')
  expect(content).toContain('Do not inspect application source code, install a video SDK, '
    + 'write Python/JavaScript/curl download or polling scripts, or invoke FFmpeg yourself')
  expect(content).toContain('It does not supply independent TTS, forced speech alignment, lip repair, subtitle burning or complex transitions.')
  expect(content).toContain('state that limit and preserve the existing result; do not write an improvised script')
  expect(content).toContain('When the actual generation model is MiniMax-H3, load yunshu-minimax-h3 only if its prompt notation is needed.')
  expect(content).toContain('Do not fetch online guides at generation time.')
})
