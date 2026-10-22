/**
 * `model` namespace dictionaries.
 *
 * `trigger.selectAria` intentionally matches `trigger.fallback` but remains a
 * separate key: the visible fallback label and the accessible name of
 * an unset trigger are free to diverge per locale, and folding it into
 * `trigger.aria` would announce the degenerate "Select model, current Select
 * model".
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'provider.account': '官方账号',
  'command.label': '模型',
  'command.description': '选择本会话使用的模型',
  'option.loadError': '模型列表暂时无法读取，请重试',
  'trigger.fallback': '请选择模型',
  'trigger.loading': '正在加载模型…',
  'trigger.selectAria': '请选择模型',
  'trigger.aria': '选择模型，当前 {model}',
  'trigger.ariaEffort': '选择模型，当前 {model}，推理等级 {effort}',
  'menu.aria': '模型与推理等级',
  'menu.model': '模型',
  'menu.effort': '推理等级',
  'effort.providerDefault': 'Default',
  'status.loading': '正在刷新模型列表…',
  'error.action': '模型操作未完成，请重试',
  'error.sessionInUse': '当前会话已被占用，可能是其他正在运行的云枢客户端导致的（如网页端、桌面端），请退出其他正在运行的客户端后重试。',
  'action.reload': '重新加载',
  'warning.groupLoad': '{name} 的模型列表暂时无法读取，请重试',
  'guidance.flagship': '旗舰模型',
  'guidance.yunshuFlash': '云枢主力模型，适合日常问答、内容写作与编程',
  'guidance.general': '适合日常问答、内容写作与编程',
  'guidance.reasoning': '适合复杂编程、知识问答与多步推理',
  'guidance.unspecified': '用途与能力以提供方说明为准',
  'guidance.latency': '响应速度会随任务、推理等级与网络状况变化',
  'guidance.effort': '简单问题可降低推理等级；复杂分析可提高等级，通常需要更多等待',
  'search.placeholder': '搜索模型…',
  'search.clear': '清除搜索',
  'search.empty': '没有匹配的模型。',
  'empty.models': '暂无可用模型',
  'empty.efforts': '当前模型未提供推理等级。',
} satisfies Record<string, string>

/** The model namespace key union. */
export type ModelKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'provider.account': 'Official account',
  'command.label': 'Model',
  'command.description': 'Select the model for this conversation',
  'option.loadError': 'The model list could not be loaded. Try again.',
  'trigger.fallback': 'Select model',
  'trigger.loading': 'Loading models…',
  'trigger.selectAria': 'Select model',
  'trigger.aria': 'Select model, current {model}',
  'trigger.ariaEffort': 'Select model, current {model}, reasoning effort {effort}',
  'menu.aria': 'Model and reasoning effort',
  'menu.model': 'Model',
  'menu.effort': 'Effort',
  'effort.providerDefault': 'Default',
  'status.loading': 'Refreshing model list…',
  'error.action': 'The model operation did not finish. Try again.',
  'error.sessionInUse': 'This session is already in use, possibly by another running Yunshu instance (such as the web or desktop app). Quit other running instances and try again.',
  'action.reload': 'Reload',
  'warning.groupLoad': 'The model list for {name} could not be loaded. Try again.',
  'guidance.flagship': 'Flagship model',
  'guidance.yunshuFlash': 'Yunshu’s main model for everyday questions, writing, and coding',
  'guidance.general': 'For everyday questions, writing, and coding',
  'guidance.reasoning': 'For complex coding, knowledge questions, and multi-step reasoning',
  'guidance.unspecified': 'See the provider’s description for uses and capabilities',
  'guidance.latency': 'Response speed varies with the task, reasoning effort, and network conditions',
  'guidance.effort': 'Use lower reasoning effort for simple questions; higher effort can help complex analysis and usually takes longer',
  'search.placeholder': 'Search models…',
  'search.clear': 'Clear search',
  'search.empty': 'No matching models.',
  'empty.models': 'No models available.',
  'empty.efforts': 'This model provides no reasoning effort levels.',
} satisfies Record<ModelKey, string>
