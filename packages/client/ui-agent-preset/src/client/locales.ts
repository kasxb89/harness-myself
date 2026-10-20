/** Locale bundles for the agent-preset hero chip, header label, and management section. */

import { guideEn, guideZh, type PresetGuideKey } from './guide-locales.ts'

/** Locale keys these surfaces render. */
export type AgentPresetSettingsKey =
  | PresetGuideKey
  | 'builtInGroup'
  | 'customGroup'
  | 'seatHint'
  | 'headerHint'
  | 'nav'
  | 'sectionIntro'
  | 'setDefault'
  | 'view'
  | 'presetStandardName'
  | 'presetStandardDescription'
  | 'presetPtcName'
  | 'presetPtcDescription'
  | 'presetMinimalName'
  | 'presetMinimalDescription'
  | 'presetCordisName'
  | 'presetCordisDescription'
  | 'inUse'
  | 'noDescription'
  | 'brokenBadge'
  | 'switchRefused'
  | 'standardUnavailable'
  | 'close'
  | 'creatorDraft'
  | 'createPlugin'
  | 'createPluginDescription'
  | 'createPluginChecking'
  | 'createPluginUnavailable'
  | 'createPluginMissing'
  | 'employeesTitle'
  | 'employeesIntro'
  | 'employeesCapabilities'
  | 'employeesSearch'
  | 'employeesList'
  | 'employeesLoading'
  | 'employeesLoadFailed'
  | 'employeesRetry'
  | 'employeesStart'
  | 'employeesStartNamed'
  | 'employeesEmpty'
  | 'employeesEmptyHint'
  | 'employeesNoResults'
  | 'employeesNoResultsHint'
  | 'employeesBuiltIn'
  | 'employeesMine'
  | 'employeesCustomize'

/** English copy. */
export const en: Record<AgentPresetSettingsKey, string> = {
  ...guideEn,
  builtInGroup: 'Built-in', customGroup: 'Custom',
  sectionIntro: 'Choose the agent’s tools and how it works. Use Standard mode for everyday tasks, or Creator mode to add capabilities to Yunshu.',

  seatHint: 'Choose the agent preset for your new task',
  headerHint: 'The agent preset chosen when this task started',
  nav: 'Agent presets',

  setDefault: 'Set as new task default',
  view: 'View configuration',

  presetStandardName: 'Standard mode',
  presetStandardDescription:
    'Work with code, files, and information. Suitable for most tasks, with search, editing, terminal commands, and other tools available as needed.',
  presetPtcName: 'PTC mode',
  presetPtcDescription:
    'Includes all Standard mode capabilities. Better suited to tasks that call tools in batches and then filter, organize, deduplicate, count, or summarize the results.',
  presetMinimalName: 'Minimal mode',
  presetMinimalDescription:
    'The agent works using only a terminal tool. Useful for testing and comparing its basic performance.',
  presetCordisName: 'Creator mode',
  presetCordisDescription:
    'Customize Yunshu through conversation. Let the agent write plugins that add features or UI, or combine tools and prompts to create your own mode.',

  inUse: 'New task default',

  noDescription: 'No description.',
  brokenBadge: 'Failed to load',

  switchRefused: 'Could not switch to {name}: {reason}',
  standardUnavailable: 'Standard mode is unavailable. Restore it or choose another available mode.',

  close: 'Close',

  creatorDraft: 'Let the agent help me create a preset',
  createPlugin: 'Let the agent create a plugin',
  createPluginDescription: 'Enter Creator mode and make your own Yunshu plugin',
  createPluginChecking: 'Checking whether Creator mode is available',
  createPluginUnavailable: 'Temporarily unavailable. Reopen this menu to retry',
  createPluginMissing: 'Creator mode is not included in this configuration',

  employeesTitle: 'Digital employees',
  employeesIntro: 'Choose a role and start a conversation about your task.',
  employeesCapabilities: 'Use your current workspace model and account credits. Image and video tasks use Yunshu’s existing creation tools.',
  employeesSearch: 'Search employee names or responsibilities',
  employeesList: 'Available employees',
  employeesLoading: 'Loading employees',
  employeesLoadFailed: 'Employees could not be loaded. Please try again shortly.',
  employeesRetry: 'Retry',
  employeesStart: 'Start conversation',
  employeesStartNamed: 'Start conversation with {name}',
  employeesEmpty: 'No employees available',
  employeesEmptyHint: 'This configuration does not include any available employee roles.',
  employeesNoResults: 'No matching employees',
  employeesNoResultsHint: 'Try another name or responsibility.',
  employeesBuiltIn: 'Built-in roles',
  employeesMine: 'My employees',
  employeesCustomize: 'Customize employee',

}

/** Simplified Chinese copy. */
export const zh: Record<AgentPresetSettingsKey, string> = {
  ...guideZh,
  builtInGroup: '内置', customGroup: '自定义',
  sectionIntro: '选择 Agent 的工具和工作方式。日常任务用「标准模式」，扩展 云枢 的能力用「创造模式」。',

  seatHint: '选择新任务使用的 Agent 预设',
  headerHint: '本任务的 Agent 预设，在任务开始时确定',
  nav: 'Agent 预设',

  setDefault: '设为新任务默认',
  view: '查看配置',

  presetStandardName: '标准模式',
  presetStandardDescription: '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。',
  presetPtcName: 'PTC 模式',
  presetPtcDescription: '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。',
  presetMinimalName: '极简模式',
  presetMinimalDescription: 'Agent 仅使用终端工具完成任务，适合测试和对比其基础表现。',
  presetCordisName: '创造模式',
  presetCordisDescription: '用对话定制 云枢：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。',

  inUse: '新任务默认',

  noDescription: '暂无描述。',
  brokenBadge: '加载失败',

  switchRefused: '无法切换到「{name}」：{reason}',
  standardUnavailable: '标准模式不可用，请恢复该模式或选择其他可用模式。',

  close: '关闭',

  creatorDraft: '让 Agent 帮我创建预设模式',
  createPlugin: '让 Agent 创建插件',
  createPluginDescription: '进入创造模式，制作属于你的 云枢 插件',
  createPluginChecking: '正在确认创造模式是否可用',
  createPluginUnavailable: '暂时不可用，请重新打开菜单重试',
  createPluginMissing: '当前配置未提供创造模式',

  employeesTitle: '数字员工',
  employeesIntro: '选择适合的岗位，开始对话并交代你的任务',
  employeesCapabilities: '沿用当前工作区的模型和账户积分，图片、视频任务使用云枢现有创作工具',
  employeesSearch: '搜索员工名称或职责',
  employeesList: '可用员工',
  employeesLoading: '正在加载员工',
  employeesLoadFailed: '暂时无法读取员工，请稍后重试',
  employeesRetry: '重试',
  employeesStart: '开始对话',
  employeesStartNamed: '与{name}开始对话',
  employeesEmpty: '暂无可用员工',
  employeesEmptyHint: '当前配置还没有可用的员工岗位',
  employeesNoResults: '没有找到相关员工',
  employeesNoResultsHint: '试试其他岗位名称或工作内容',
  employeesBuiltIn: '内置岗位',
  employeesMine: '我的员工',
  employeesCustomize: '自定义员工',

}

// The resolution itself is the shared fold in `dsh-agent-preset-registry/display`,
// re-exported here so every surface in this plugin reads one path; the
// Settings plugin list inlines the same fold over this plugin's dictionaries.
export { isBuiltInPreset, presetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'
export type { PresetDisplaySource, PresetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'
