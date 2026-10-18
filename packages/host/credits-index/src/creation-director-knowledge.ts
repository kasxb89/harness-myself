/** Compact MIT-licensed community directing guidance; source pins and full notices ship beside the package. */

/** Reviewed source identities for the excerpts and adaptations below; not part of the model prompt. */
export const COMMUNITY_VIDEO_DIRECTION_SOURCES = [
  {
    name: 'cinematic-director',
    version: '2.1.0',
    repository: 'https://github.com/wuwangzhang1216/DirectorSKILL',
    revision: 'c65ae0d14457053efb1e354c7e7f7e120d97fad1',
    sourceFile: 'SKILL.md',
    sourceSha256: '543be6ece626beaa7dbc36b8225dcdc0b763d8044563189e842b306bb5cfd792',
    license: 'MIT',
    copyright: 'Copyright (c) 2026 wangzhang-wu',
    licenseFile: 'cinematic-director.LICENSE.txt',
    licenseSha256: 'df731ea2e1ffd3b8890ad246da3df96ceba3301c16fb4970c16811df4c728b56',
  },
  {
    name: 'video-storyboard-gen',
    repository: 'https://github.com/anyhui/video-storyboard-gen-skill',
    revision: '60cfaf4f9b4db5d8dcc36cc59495977df2eb9c8b',
    sourceFile: 'SKILL.md',
    sourceSha256: '2bd6db4c12c92fe906720fc49ba9b38b2286522de326a47deac0906d0ca67820',
    license: 'MIT',
    copyright: 'Copyright (c) 2026 anyhui',
    licenseFile: 'video-storyboard-gen.LICENSE.txt',
    licenseSha256: '29fb6ca7f502d80acf19b33c65acfd1e301b896fdcc524f575fb700775e404b1',
  },
] as const

/**
 * Shared, bounded excerpts and adaptations for video planning and AI writing.
 * Community rules guide the brief; the product's native tools still own generation and assembly.
 */
export const COMMUNITY_VIDEO_DIRECTION = [
  '## Community directing practice',
  'Story function first. A shot with no story function is deleted, not improved. For a narrative, identify the literal event, dramatic question, conflict, subtext and emotional movement; for a product or other non-narrative brief, use the claim and its visible proof instead.',
  'Blocking before framing. Decide what bodies do in space, then place the camera. For each needed shot, establish start position, movement, interaction with space and props, camera relationship, end position and eyeline.',
  'Within each continuous shot, use one dominant camera move and one primary action; a locked camera is valid. Every action has an end state. Describe visible behavior instead of an abstract emotion. For a supported multi-shot clip, assign the distinct actions to explicit time windows rather than stacking incompatible moves.',
  'Continuity is engineered. Name the invariants — identity, wardrobe, light direction, era, geography — and repeat them verbatim across every prompt in a scene. Keep props, eyelines and screen direction consistent. In a multi-shot prompt, put shared invariants in the overall block and each shot’s changes in its timed line.',
  'For image-to-video, the supplied image already fixes appearance, composition and setting: describe motion, camera, timing and the end state, preserving recognizable features. For first/last frames, describe the continuous bridge. Only request a new reference or keyframe when the user’s change or actual continuity risk needs it; reuse suitable material.',
  'Answer the size of the question. A prompt request gets a prompt. Never expand a small ask into a production package. Run only the planning steps the request needs; do not add alternate drafts or extra paid shots just to fill a template.',
  '剧情/短片采用“建置 → 对抗 → 解决”；每个镜头必须推动信息、动作或情绪；删掉仅重复前镜的镜头。先分配段落，再分配镜头。',
  '时间码连续、不重叠、无空档，末镜结束时间等于总时长。人物外观、服装、道具位置和空间方向连续。分镜按需包含镜号、时间码、时长、景别/角度、画面与动作、运镜、台词/声音、转场；不为简单请求输出整套表格。',
  '台词能在镜头时长内自然说完；声音至少区分台词/旁白、环境音/音效、音乐。指定说话者、逐字台词及起止时间；按需区分底噪、环境声、拟音、点状音效和配乐。字幕沿用逐字台词与说话时间，保留原生人声，不因统一配乐而静音所有原片。',
  '素材引用使用用户实际界面中的名称；不要虚构已上传资源。每段提示词保持主体与场景锚点一致。平台能力会变化，不把时长、输入数量、帧率等写成永久规格；以当前工具支持为准。不要把 AI 生成稳定性当承诺；将约束词视为意图，而非结果保证。',
].join('\n')
