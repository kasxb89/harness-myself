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
  expect(content).toContain('For explicit timing or complex plans, call list_video_models once')
  expect(content).toContain('For every new chat video request, use generate_video_project by default, including a single short clip')
  expect(content).toContain('generate_video remains compatible with previously verified single-clip calls; it is not the default for a new chat request.')
  expect(content).toContain('Do not add character-sheet generation, extra reference images or a separate planning round')
  expect(content).toContain('generate_video_project handles readable workspace references even for a single short clip.')
  expect(content).toContain('For a finished video longer than one supported model clip, use generate_video_project.')
  expect(content).toContain('Do not inspect application source code, install a video SDK, '
    + 'write Python/JavaScript/curl download or polling scripts, or invoke FFmpeg yourself')
  expect(content).toContain('It does not supply independent TTS, forced speech alignment, lip repair, subtitle burning or complex transitions.')
  expect(content).toContain('state that limit and preserve the existing result; do not write an improvised script')
  expect(content).toContain('When the actual generation model is MiniMax-H3, load yunshu-minimax-h3 only if its prompt notation is needed.')
  expect(content).toContain('Do not fetch online guides at generation time.')
  expect(content).toContain('One paid clip may contain several visual cuts.')
  expect(content).toContain('do not try one 30-second H3 clip')
  expect(content).toContain('60-second finished video is four 15-second clips')
  expect(content).toContain('instead of silently switching models')
  expect(content).toContain('A missing toggle does not mean a silent model')
  expect(content).toContain('a busy submission without a task id is an unknown outcome, not a confirmed queue position')
  expect(content).toContain('If the user stops, use job_kill')
})

it('gives narrative briefs explicit material responsibilities, executable timing and user-owned exclusions', () => {
  expect(VIDEO_DIRECTOR_PROMPT).toContain('剧情概述 → 素材与职责 → 主体与全片设定 → 镜头 / 时间轴 → 始终保持 → 始终禁止')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('实际收到的 @图片1、@图片2 等顺序与原文件名')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('采用什么、排除什么、可改变什么')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('每个需要素材的镜头明确引用对应编号')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('角色外貌、服装、人物关系与情绪变化')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('起始位置、主动作与结束状态')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('说话者、逐字台词、语气、说话起止时间')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('用户逐字指定的台词不得擅删、改写、加速或挪出总时长')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('确认前不提交矛盾的生成任务')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('不得套用默认字幕或促销模板')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('简单单镜头或一句提示词请求只补足必要细节')
})

it('keeps platform failure narration safe while preserving diagnostic tasks and unknown paid outcomes', () => {
  expect(VIDEO_DIRECTOR_PROMPT).toContain('面向用户的回复和进度只给安全的简体中文摘要')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('服务器繁忙，请稍后重试')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('原始 HTTP 状态或响应正文、JSON 错误对象、英文错误码、堆栈、请求标识、内部文件路径、密钥或令牌')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('真实工具结果与诊断记录保留原样')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('工具参数及协议字段仍按工具要求填写')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('产品登录过期、用户积分不足、文件格式/大小/素材校验失败和用户取消')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('不要把上游渠道欠费说成用户积分不足')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('先查询已有任务并检查产物')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('不建议立即重试或重新生成，不自动重提收费请求')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('不限制用户明确要求的软件或代码诊断')
  expect(VIDEO_DIRECTOR_PROMPT).toContain('不要为隐藏报错而删除、改写真实工具结果或编造成功')
})
