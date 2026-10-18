/** Retained plan fixture: directions and real outputs remain independently observable. */
import type { CreativeProjectId, CreativeProjectView } from '@deepseek-ai/dsh-credits-index/src/creative-types.ts'

/** @param overrides - test-owned project changes. @returns a complete wire-safe project. */
export function project(overrides: Partial<CreativeProjectView> = {}): CreativeProjectView {
  return {
    sessionId: 'session-a', planRevision: 'revision-1', tasks: [], completedShots: 0, totalShots: 1,
    id: 'cp_rain' as CreativeProjectId, kind: 'video', title: '雨夜重逢', brief: '两位角色在雨夜车站重逢',
    style: '手绘动漫', status: 'running', updatedAt: '2026-10-17T00:00:00Z',
    characters: [{ id: 'girl', name: '小雨', appearance: '黑发少女', clothing: '红色围巾', personality: '坚定',
      voice: '年轻女声', referenceAssetIds: ['station'] }],
    assets: [{ id: 'station', name: '车站参考', kind: 'image', role: '背景', description: '雨夜的车站',
      sourcePathOrAssetId: '/private/local/reference.png' }],
    shots: [{ id: 's1', order: 1, title: '车站对白', durationSeconds: 15, camera: '侧面近景', scene: '车站门口',
      action: '小雨转身微笑', prompt: '动漫少女转身说话', dialogue: '你终于来了。', subtitles: '你终于来了。',
      characterIds: ['girl'], assetIds: ['station'], status: 'running', outputs: [] }],
    outputs: [], ...overrides,
  }
}

/** @param projectId - owning project. @param outputId - saved output. @returns the controlled media route. */
export function mediaUrl(projectId = 'cp_rain', outputId = 'out1'): string {
  return `/credits/api/creative/media?session_id=session-a&project_id=${projectId}&output_id=${outputId}`
}
