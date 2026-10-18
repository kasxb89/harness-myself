import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { afterEach, expect, it } from 'vitest'
import { registerCreationWorkflows, VIDEO_DIRECTOR_PROMPT } from '../src/creation-workflows.ts'

let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose() })

it('publishes the directing skill with native fast paths and removes it with its owner', async () => {
  ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const fiber = ctx.plugin((owner) => { registerCreationWorkflows(owner) })
  await fiber.await()
  const summary = (await ctx.skills.snapshot()).skills.find(skill => skill.name === 'yunshu-video-director')
  expect(summary).toMatchObject({ source: 'bundled', invocation: { modelInvocable: true, userInvocable: true } })
  const skill = await ctx.skills.get('yunshu-video-director')
  expect(skill?.content).toContain(VIDEO_DIRECTOR_PROMPT)
  await expect(`${skill?.content}\n`).toMatchFileSnapshot('./expected/video-director-skill.md')
  await fiber.dispose()
  expect(await ctx.skills.get('yunshu-video-director')).toBeUndefined()
})

it('registers when the shared skill registry becomes available after the credits workflow', async () => {
  ctx = new Context()
  const fiber = ctx.plugin((owner) => { registerCreationWorkflows(owner) })
  await ctx.plugin(SkillRegistry)
  await fiber.await()
  expect((await ctx.skills.snapshot()).skills.map(skill => skill.name)).toContain('yunshu-video-director')
})
