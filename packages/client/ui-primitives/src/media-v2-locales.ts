/** Simplified Chinese labels for media controls, prices, retained materials and original-task recovery. */
export const mediaV2Zh = {
  intentText: '文本生成', intentReference: '参考素材生成', intentFrames: '首尾帧生成', intentTransform: '素材处理',
  title: '模型与处理', back: '常规创作', model: '模型', intent: '使用方式', loading: '读取模型与原任务…', noModels: '当前账号暂无可用的此类模型与处理工具',
  configurationChanged: '模型配置已更新，请核对参数并显式重新报价，再确认生成。原操作编号和素材保持。',
  configurationRequoteUnsupported: '模型配置已更新，当前服务不支持同操作更新报价。请保留原记录，核对后明确继续编辑新草稿。',
  reload: '刷新模型', prompt: '描述', parameters: '参数', materials: '参考素材', add: '添加素材', remove: '移除', writing: '仅用于构思', generation: '提交给模型',
  retained: '保留的素材', retainedHint: '切换模型不会删除素材。请明确处理不兼容的素材后继续。', empty: '未选择', clear: '清除该参数',
  quote: '获取准确积分', quoting: '正在报价…', submit: '确认生成', submitting: '正在提交…', price: '本次费用', credits: '积分', yuan: '元', expires: '报价已过期，请重新报价',
  operations: '原任务', recover: '更新原任务', recoverAsset: '核对原上传', unknown: '结果尚未确认，请核对原记录，不要重复提交',
  queued: '等待处理', running: '处理中', succeeded: '已完成', failed: '未完成', quoted: '已报价，尚未生成', quoteRejected: '报价未通过，尚未生成', save: '保存全部产物', saved: '已保存',
  download: '下载原文件', results: '全部产物', requestFailure: '暂时无法完成请求，原记录已保留', unavailable: '当前组合不支持该选项，请修改或清除',
  required: '请补充必需的参数或素材', limit: '超出当前组合支持的范围，请调整', invalid: '参数或素材不符合当前模型要求',
  intentError: '使用方式与素材不匹配，请明确选择并保留所需素材', unknownAsset: '素材上传结果待确认，请核对原上传', binding: '素材属于原模型或已过期，请保留原记录并重新选择有效素材',
  uploadFailed: '上传结果尚未确认，仅可核对原上传', newDraft: '继续编辑新草稿', originalId: '操作编号', optional: '可选', noPrompt: '此处理工具无需画面描述',
}
/** Complete localized label set required by the shared media composer. */
export type MediaV2Labels = { readonly [K in keyof typeof mediaV2Zh]: string }
/** English labels with the same control and recovery coverage as the Chinese dictionary. */
export const mediaV2En: MediaV2Labels = {
  intentText: 'Text generation', intentReference: 'Reference generation', intentFrames: 'Frame generation', intentTransform: 'Media processing',
  title: 'Models and processing', back: 'Standard creation', model: 'Model', intent: 'Input workflow', loading: 'Reading models and original operations…', noModels: 'No available models or processors for this account',
  configurationChanged: 'Model configuration changed. Review the parameters and explicitly request a new quote before confirming. The original operation and materials stay unchanged.',
  configurationRequoteUnsupported: 'Model configuration changed. This service cannot update this operation quote. Keep the original record and explicitly edit a new draft after reviewing it.',
  reload: 'Refresh models', prompt: 'Description', parameters: 'Parameters', materials: 'Reference media', add: 'Add media', remove: 'Remove', writing: 'Writing only', generation: 'Send to model',
  retained: 'Retained media', retainedHint: 'Changing models preserves every asset. Resolve incompatible media explicitly before continuing.', empty: 'Not selected', clear: 'Clear this parameter',
  quote: 'Get exact credits', quoting: 'Getting price…', submit: 'Confirm generation', submitting: 'Submitting…', price: 'This request', credits: 'credits', yuan: 'CNY', expires: 'Quote expired. Request a fresh quote.',
  operations: 'Original operations', recover: 'Update original operation', recoverAsset: 'Check original upload', unknown: 'Outcome unconfirmed. Check the original record without submitting again.',
  queued: 'Queued', running: 'Processing', succeeded: 'Completed', failed: 'Failed', quoted: 'Quoted, not generated', quoteRejected: 'Quote rejected, not generated', save: 'Save every artifact', saved: 'Saved',
  download: 'Download original', results: 'All artifacts', requestFailure: 'Request unavailable. The original record is retained.', unavailable: 'This option is unavailable for the current combination. Change or clear it.',
  required: 'Complete the required parameter or media', limit: 'The current combination exceeds a published limit', invalid: 'The parameter or media does not match this model',
  intentError: 'The workflow and media do not match. Choose explicitly and keep the intended references.', unknownAsset: 'Upload outcome unconfirmed. Check the original upload.', binding: 'This asset belongs to the previous model or expired. Keep the original record and select valid media.',
  uploadFailed: 'Upload outcome unconfirmed. Only check the original upload.', newDraft: 'Edit a new draft', originalId: 'Operation ID', optional: 'Optional', noPrompt: 'This processor does not need a description',
}
