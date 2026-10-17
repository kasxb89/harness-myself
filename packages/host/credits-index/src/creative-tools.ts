/** Logged structured planning tool for the chat creation panel. @module */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { CreativeError, parseCreativePlan, type CreativeOwner, type CreativeStore } from './creative-store.ts'
import type { VideoProjectIdentity } from './video-project-types.ts'

/**
 * Bind a logged media operation to its actual chat workspace.
 * @param exec - Real tool execution context.
 * @param identity - Captured current product login.
 * @returns Owner values retained without any credential.
 */
export function creativeOwner(exec: ToolRunContext, identity: VideoProjectIdentity): CreativeOwner {
  const session = exec.agent?.session
  const workspaceRoot = session?.header.cwd
  if (session === undefined || workspaceRoot === undefined || !isAbsolute(workspaceRoot)) throw new CreativeError('CREATIVE_WORKSPACE_REQUIRED', 400, '请先在工作区聊天中创建图片或视频。')
  return { ...identity, sessionId: session.id, workspaceRoot }
}

/**
 * Register the reversible, log-reconstructable planning contribution.
 * @param ctx - Owning credits plugin context.
 * @param store - Private account/chat planning records.
 * @param current - Current captured account identity, without credentials.
 */
export function registerCreativeTools(ctx: Context, store: CreativeStore, current: () => Promise<VideoProjectIdentity | undefined>): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'get_creation_plan',
    description: 'Read the complete structured plan owned by this account, chat and workspace before revising it. Returns the exact planning fields accepted by update_creation_plan, including stable character, asset and shot ids. Preserve all unrelated entries when updating. This read neither generates media, resumes tasks nor spends credits; it excludes provider requests and credentials.',
    parameters: { plan_id: { type: 'string', required: true, description: 'Explicit existing creation plan id.' } },
    output: {
      schema: { type: 'object', properties: {
        status: { type: 'string', required: true }, plan_id: { type: 'string' },
        plan: { type: 'object', properties: {}, additionalProperties: true },
        message: { type: 'string', required: true }, code: { type: 'string' },
      }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => ({ card: 'generic', title: '读取创作计划', kind: 'read', content: [{ type: 'text', text: args.plan_id }] }),
    async execute(args, exec) {
      try {
        const identity = await current()
        if (identity === undefined) throw new CreativeError('AUTH_REQUIRED', 401, '请先登录云枢，再读取创作计划。')
        exec.signal.throwIfAborted()
        const plan = await store.plan(creativeOwner(exec, identity), args.plan_id)
        return { status: 'succeeded', plan_id: args.plan_id, plan: {
          kind: plan.kind, title: plan.title, brief: plan.brief, style: plan.style,
          characters: plan.characters.map(item => ({ id: item.id, name: item.name, appearance: item.appearance,
            clothing: item.clothing, personality: item.personality, voice: item.voice, reference_asset_ids: [...item.referenceAssetIds] })),
          assets: plan.assets.map(item => ({ id: item.id, name: item.name, kind: item.kind, role: item.role,
            description: item.description, source_path_or_asset_id: item.sourcePathOrAssetId })),
          shots: plan.shots.map(item => ({ id: item.id, order: item.order, title: item.title,
            ...item.durationSeconds === undefined ? {} : { duration_seconds: item.durationSeconds }, camera: item.camera,
            scene: item.scene, action: item.action, prompt: item.prompt, dialogue: item.dialogue, subtitles: item.subtitles,
            character_ids: [...item.characterIds], asset_ids: [...item.assetIds] })),
        }, message: '已读取完整创作计划。修改目标条目时保留其他人物、素材和镜头，然后调用 update_creation_plan；本次读取没有生成或计费。' }
      } catch (error) {
        return error instanceof CreativeError ? { status: 'failed', code: error.code, message: error.message }
          : { status: 'failed', code: 'CREATIVE_READ_FAILED', message: '创作计划暂时无法读取，请检查项目编号和本机存储后重试；未启动生成。' }
      }
    },
  })), 'credits: creation plan reader')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'update_creation_plan',
    description: 'Create or explicitly revise the structured plan for a chat image or video: stable characters and their appearance, source materials, ordered shots, camera, actions, exact dialogue and subtitles. Use the returned plan_id and the exact shot ids in generate_image/generate_video or shot_ids in generate_video_project. Never associate a generation with a guessed latest project. Planning does not generate media or spend credits. Character/material descriptions and dialogue are requirements, not verified generation results. Preserve user wording and silent/nonverbal requests. Revisions supply the complete plan and cannot remove shots with existing generation records.',
    parameters: {
      plan_id: { type: 'string', description: 'Explicit existing plan id when revising; omit to create.' },
      kind: { type: 'string', enum: ['image', 'video'], required: true },
      title: { type: 'string', required: true }, brief: { type: 'string', required: true }, style: { type: 'string' },
      characters: { type: 'array', items: { type: 'object', properties: {
        id: { type: 'string', required: true }, name: { type: 'string', required: true }, appearance: { type: 'string' }, clothing: { type: 'string' }, personality: { type: 'string' }, voice: { type: 'string' },
        reference_asset_ids: { type: 'array', items: { type: 'string' } },
      }, additionalProperties: false } },
      assets: { type: 'array', items: { type: 'object', properties: {
        id: { type: 'string', required: true }, name: { type: 'string', required: true }, kind: { type: 'string', enum: ['image', 'video', 'audio', 'document', 'other'], required: true },
        role: { type: 'string' }, description: { type: 'string' }, source_path_or_asset_id: { type: 'string', required: true, description: 'Existing real path or uploaded asset id; use an empty string for an asset that has not been generated. Never invent a path.' },
      }, additionalProperties: false } },
      shots: { type: 'array', required: true, items: { type: 'object', properties: {
        id: { type: 'string', required: true }, order: { type: 'number', required: true }, title: { type: 'string', required: true }, duration_seconds: { type: 'number' },
        camera: { type: 'string' }, scene: { type: 'string' }, action: { type: 'string' }, prompt: { type: 'string', required: true }, dialogue: { type: 'string' }, subtitles: { type: 'string' },
        character_ids: { type: 'array', items: { type: 'string' } }, asset_ids: { type: 'array', items: { type: 'string' } },
      }, additionalProperties: false } },
    },
    output: { schema: { type: 'object', properties: { status: { type: 'string', required: true }, plan_id: { type: 'string' }, message: { type: 'string', required: true }, code: { type: 'string' } }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    presentCall: args => ({ card: 'generic', title: '创作计划', kind: 'edit', content: [{ type: 'text', text: args.title }] }),
    async execute(args, exec) {
      try {
        const identity = await current()
        if (identity === undefined) throw new CreativeError('AUTH_REQUIRED', 401, '请先登录云枢，再创建创作计划。')
        const plan = parseCreativePlan({
          kind: args.kind, title: args.title, brief: args.brief, style: args.style ?? '',
          characters: (args.characters ?? []).map(item => ({ id: item.id, name: item.name, appearance: item.appearance ?? '', clothing: item.clothing ?? '', personality: item.personality ?? '', voice: item.voice ?? '', referenceAssetIds: item.reference_asset_ids ?? [] })),
          assets: (args.assets ?? []).map(item => ({ id: item.id, name: item.name, kind: item.kind, role: item.role ?? '', description: item.description ?? '', sourcePathOrAssetId: item.source_path_or_asset_id })),
          shots: args.shots.map(item => ({ id: item.id, order: item.order, title: item.title, ...item.duration_seconds === undefined ? {} : { durationSeconds: item.duration_seconds }, camera: item.camera ?? '', scene: item.scene ?? '', action: item.action ?? '', prompt: item.prompt, dialogue: item.dialogue ?? '', subtitles: item.subtitles ?? '', characterIds: item.character_ids ?? [], assetIds: item.asset_ids ?? [] })),
        })
        exec.signal.throwIfAborted()
        const id = await store.updatePlan(creativeOwner(exec, identity), plan, args.plan_id)
        return { status: 'saved', plan_id: id, message: '创作计划已保存。生成时明确传入该 plan_id 和对应镜头 id；计划本身尚未生成或验证媒体。' }
      } catch (error) {
        return error instanceof CreativeError ? { status: 'failed', code: error.code, message: error.message } : { status: 'failed', code: 'CREATIVE_SAVE_FAILED', message: '创作计划未能保存，请检查工作区和本机存储后重试；尚未提交生成。' }
      }
    },
  })), 'credits: creation planning tool')
}
