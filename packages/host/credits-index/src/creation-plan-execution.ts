/** Resolve saved directing requirements into fixed video inputs without another model call. @module */
import { CreativeError, creativePlanRevision, type CreativeOwner } from './creative-store.ts'
import type { CreativeCharacter, CreativeShotPlan } from './creative-types.ts'
import type { VideoProjectInput, VideoProjectOptions } from './video-project-types.ts'

function characterDescription(character: CreativeCharacter): string {
  return [
    `人物 ${character.id}：${character.name}`,
    ...[['外貌', character.appearance], ['服装', character.clothing], ['性格', character.personality], ['声线', character.voice]]
      .filter(([, value]) => value !== '').map(([label, value]) => `${label}：${value}`),
  ].join('\n')
}

function shotDescription(shot: CreativeShotPlan, characters: readonly CreativeCharacter[]): string {
  return [
    `镜头 ${shot.id}：${shot.title}`,
    ...[['场景', shot.scene], ['景别与运镜', shot.camera], ['人物动作', shot.action], ['生成要求', shot.prompt],
      ['逐字台词与时序', shot.dialogue], ['字幕原文与时序', shot.subtitles]]
      .filter(([, value]) => value !== '').map(([label, value]) => `${label}：${value}`),
    ...characters.filter(character => shot.characterIds.includes(character.id)).map(characterDescription),
  ].join('\n')
}

/**
 * Apply only the selected plan shots, exact timing and shot-bound reference media to a native video workflow.
 * @param options - Existing planning store and owned generated-image reference resolver.
 * @param owner - Captured account, conversation and workspace.
 * @param input - Explicit video request; supplied shot prompts and durations retain their meaning.
 * @param planId - Exact creation plan; omission retains the ordinary minimum-clip workflow.
 * @param shotIds - Exact selected shots in their saved timeline order.
 * @returns Native input and the exact plan revision to check at invocation admission; nothing is generated or billed.
 */
export async function resolveCreationVideoInput(
  options: VideoProjectOptions, owner: CreativeOwner, input: VideoProjectInput, planId?: string, shotIds?: readonly string[],
): Promise<{ input: VideoProjectInput; planRevision?: string }> {
  if (planId === undefined) {
    if (shotIds !== undefined) throw new CreativeError('CREATIVE_PLAN_REQUIRED', 400, '指定镜头时必须同时指定创作计划。')
    return { input }
  }
  const store = options.creative
  if (store === undefined) throw new CreativeError('CREATIVE_UNAVAILABLE', 503, '创作计划服务尚未准备好，尚未提交生成。')
  const plan = await store.plan(owner, planId)
  const planRevision = creativePlanRevision(plan)
  if (plan.kind !== 'video' || shotIds === undefined || shotIds.length === 0 || new Set(shotIds).size !== shotIds.length) {
    throw new CreativeError('CREATIVE_SHOT_MISMATCH', 400, '请明确指定视频计划中的镜头及时间轴顺序，尚未提交生成。')
  }
  const positions = shotIds.map(id => plan.shots.findIndex(shot => shot.id === id))
  if (positions.some((position, index) => {
    const previous = positions[index - 1]
    return position < 0 || previous !== undefined && position <= previous
  })) {
    throw new CreativeError('CREATIVE_SHOT_MISMATCH', 400, '镜头必须属于该计划并按已保存的时间轴顺序生成，请刷新计划后重试。')
  }
  const shots = plan.shots.filter(shot => shotIds.includes(shot.id))
  if (input.shotPrompts !== undefined && input.shotPrompts.length !== shots.length
    || input.shotDurations !== undefined && input.shotDurations.length !== shots.length) {
    throw new CreativeError('CREATIVE_SHOT_MISMATCH', 400, '镜头、提示词和分镜时长必须一一对应，尚未提交生成。')
  }
  let durations = input.shotDurations
  if (durations === undefined) {
    const specified = shots.flatMap(shot => shot.durationSeconds === undefined ? [] : [shot.durationSeconds])
    if (specified.length > 0 && specified.length !== shots.length) {
      throw new CreativeError('CREATIVE_SHOT_DURATION_REQUIRED', 400, '时间轴中只有部分镜头设置了时长，请补齐所有镜头时长或清空后使用自动分段；尚未提交生成。')
    }
    if (specified.length > 0) durations = specified
  }
  const usedImages = shots.map(shot => new Set([
    ...shot.assetIds,
    ...plan.characters.filter(character => shot.characterIds.includes(character.id)).flatMap(character => character.referenceAssetIds),
  ]))
  const assets = new Map(plan.assets.map(asset => [asset.id, asset]))
  const mediaReferences = (kind: 'video' | 'audio', supplied: readonly (readonly string[])[] | undefined) => shots.map((shot, index) => {
    const references = [...supplied?.[index] ?? []]
    for (const id of shot.assetIds) {
      const asset = assets.get(id)
      if (asset === undefined) throw new CreativeError('CREATIVE_REFERENCE_INVALID', 400,
        '所选镜头引用的素材不存在，请补齐原素材后再生成；尚未提交生成。')
      if (asset.kind !== kind) continue
      const source = asset.sourcePathOrAssetId.trim()
      if (source === '') throw new CreativeError('CREATIVE_REFERENCE_INVALID', 400,
        '所选镜头的视频或音频素材尚无可读取来源，请添加实际素材后再生成；尚未提交生成。')
      references.push(source)
    }
    return [...new Set(references)]
  })
  const shotReferenceVideos = mediaReferences('video', input.shotReferenceVideos)
  const shotReferenceAudios = mediaReferences('audio', input.shotReferenceAudios)
  const imageAssets = plan.assets.filter(asset => asset.kind === 'image' && usedImages.some(ids => ids.has(asset.id)))
  const project = imageAssets.length === 0 ? undefined : (await store.projects(owner)).find(project => project.id === planId)
  const references = new Map<string, string>()
  for (const asset of imageAssets) {
    const generated = project?.assets.find(item => item.id === asset.id)?.outputs?.filter(output => output.kind === 'image').at(-1)
    const original = asset.sourcePathOrAssetId.trim()
    if (generated === undefined && original === '') continue
    if (generated !== undefined) {
      const resolved = await options.creativeImageReference?.(owner, planId, generated.id)
      if (resolved === undefined) throw new CreativeError('CREATIVE_REFERENCE_INVALID', 400, '已生成的分镜素材暂时无法读取，请检查原产物后重试；尚未提交生成。')
      references.set(asset.id, resolved)
    } else references.set(asset.id, original)
  }
  const shotReferenceImages = usedImages.map((assets, index) => [...new Set([
    ...input.shotReferenceImages?.[index] ?? [],
    ...[...assets].flatMap((id) => {
      const reference = references.get(id)
      return reference === undefined ? [] : [reference]
    }),
  ])])
  return { planRevision, input: {
    ...input, title: plan.title, shotTitles: shots.map(shot => shot.title),
    shotPrompts: input.shotPrompts ?? shots.map(shot => shotDescription(shot, plan.characters)),
    ...durations === undefined ? {} : { shotDurations: durations },
    ...shotReferenceImages.every(references => references.length === 0) ? {} : { shotReferenceImages },
    ...shotReferenceVideos.every(references => references.length === 0) ? {} : { shotReferenceVideos },
    ...shotReferenceAudios.every(references => references.length === 0) ? {} : { shotReferenceAudios },
  } }
}
