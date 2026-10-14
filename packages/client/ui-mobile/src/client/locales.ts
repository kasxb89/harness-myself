/** Dictionaries for the sidebar Mobile page. */

/** Locale namespace owned by this plugin. */
export const NS = 'mobile'

export const zh = {
  'panel': '手机',
  'title': '手机',
  'subtitle': '用微信扫码绑定机器人，之后在微信里直接和这台电脑上的智能体对话。',
  'missing': '还没有检测到 IM 桥接插件。安装并启用「IM 机器人 (dsh-im)」后，这里会显示微信绑定二维码。',
} as const

export const en: Record<keyof typeof zh, string> = {
  'panel': 'Mobile',
  'title': 'Mobile',
  'subtitle': 'Bind the bot with WeChat, then talk to the agent on this computer from WeChat.',
  'missing': 'No IM bridge plugin was detected. Install and enable “IM 机器人 (dsh-im)” and the WeChat binding QR appears here.',
}

export type MobileKey = keyof typeof zh
