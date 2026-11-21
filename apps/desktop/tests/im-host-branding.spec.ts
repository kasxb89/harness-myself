/** Exercise installed IM message templates, reply delivery and self-chat loop protection. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

const productRequire = createRequire(new URL('../../../packages/bundle/web-app/package.json', import.meta.url))
const packageRoot = dirname(productRequire.resolve('@xmanrui/dsh-im/package.json'))
const load = async (path: string): Promise<unknown> => {
  const value: unknown = await import(pathToFileURL(join(packageRoot, path)).href)
  return value
}
type HostI18n = {
  t: (text: string, params?: Record<string, string>) => string
  setImHostLanguage: (language: string) => void
}
type IMessageApi = {
  IMESSAGE_BOT_REPLY_PREFIX: string
  normalizeIMessage: (message: object) => unknown
  MacOSMessagesApi: new (options: { osascriptImpl: (script: string) => Promise<void> }) => {
    sendText: (message: { chatGuid: string; address: string; text: string }) => Promise<void>
  }
}
type MirrorTarget = { channel: string; botId: string; targetId: string }
type SessionSync = {
  createSessionSyncCoordinator: (options: { deliveryService: {
    listSessionSyncTargets: () => Promise<MirrorTarget[]>
    sendSessionSyncText: (bot: string, target: string, session: string, text: string) => Promise<void>
  } }) => {
    enqueue: (id: string, event: { type: string; data: object; surfaceOp: string }, origin: string) => Promise<void>
    whenIdle: () => Promise<void>
    close: () => void
  }
}

it.each(['zh', 'en'])('brands Host templates in %s without rewriting supplied names or paths', async (language) => {
  const { t, setImHostLanguage } = await load('src/channels/shared/i18n.mjs') as HostI18n
  const { EN } = await load('src/channels/shared/i18n-en.mjs') as { EN: Record<string, string> }
  setImHostLanguage(language)
  try {
    const brand = language === 'en' ? 'Yunshu' : '云枢'
    expect(t('✅ DeepSeek Harness 连接测试成功')).toContain(brand)
    expect(t('{label}机器人已连接 DeepSeek Harness。', { label: 'DSH Support' }))
      .toContain('DSH Support')
    expect(t('{label}机器人已连接 DeepSeek Harness。', { label: 'DSH Support' }))
      .toContain(brand)
    expect(t('DSH_HOME')).toBe('DSH_HOME')
    expect(t('/tmp/DSH/config.json')).toBe('/tmp/DSH/config.json')
    for (const key of Object.keys(EN).filter(key => /DeepSeek Harness|\bDSH\b(?![_-])/.test(key))) {
      expect(t(key)).not.toMatch(/DeepSeek Harness|\bDSH\b(?![_-])/)
    }
    // Exercise the shipped compiled translator as well as its distributed source.
    const built = readFileSync(join(packageRoot, 'lib/index.js'), 'utf8')
    const body = /function S\(n,A\)\{[\s\S]*?\}(?=var jR=)/.exec(built)?.[0]
    if (!body) throw new Error('The pinned IM Host translator could not be located')
    const compiled: unknown = runInNewContext(`(${body})`, { P4: EN, md: language })
    if (typeof compiled !== 'function') throw new Error('The compiled translator is not callable')
    const translate = compiled as HostI18n['t']
    expect(translate('✅ DeepSeek Harness 连接测试成功')).toBe(t('✅ DeepSeek Harness 连接测试成功'))
    expect(translate('{label}机器人已连接 DeepSeek Harness。', { label: 'DSH Support' }))
      .toBe(t('{label}机器人已连接 DeepSeek Harness。', { label: 'DSH Support' }))
  } finally {
    setImHostLanguage('zh')
  }
})

it('sends the Yunshu iMessage marker and ignores both current and historic bot echoes', async () => {
  const { MacOSMessagesApi, IMESSAGE_BOT_REPLY_PREFIX, normalizeIMessage } = await load('src/channels/imessage/imessage-api.mjs') as IMessageApi
  const scripts: string[] = []
  const api = new MacOSMessagesApi({ osascriptImpl: async (script: string) => { scripts.push(script) } })
  await api.sendText({ chatGuid: 'iMessage;-;fixture', address: 'fixture@example.test', text: 'Hello' })
  expect(IMESSAGE_BOT_REPLY_PREFIX).toBe('🤖 Yunshu Assistant\n')
  expect(scripts).toHaveLength(1)
  expect(scripts[0]).toContain(JSON.stringify(`${IMESSAGE_BOT_REPLY_PREFIX}Hello`))
  const message = { guid: 'fixture-message', chatGuid: 'fixture-chat', sender: 'fixture-sender', isFromMe: 0 }
  for (const prefix of [IMESSAGE_BOT_REPLY_PREFIX, '🤖 DSH\n']) {
    expect(normalizeIMessage({ ...message, text: `${prefix}Hello` })).toBeNull()
  }
  expect(normalizeIMessage({ ...message, text: 'Explain DSH_HOME' })).toMatchObject({ content: 'Explain DSH_HOME' })
})

it('mirrors original user content and the final reply with Yunshu signatures', async () => {
  const { createSessionSyncCoordinator } = await load('plugin-src/host/session-sync-coordinator.mjs') as SessionSync
  const sent: string[] = []
  const target = { channel: 'telegram', botId: 'fixture-bot', targetId: 'fixture-chat' }
  const coordinator = createSessionSyncCoordinator({ deliveryService: {
    listSessionSyncTargets: async () => [target],
    sendSessionSyncText: async (_bot: string, _target: string, _session: string, text: string) => { sent.push(text) },
  } })
  try {
    const enqueue = (type: string, data: object) => coordinator.enqueue('fixture-session', { type, data, surfaceOp: 'append' }, 'dsh')
    await enqueue('turn/start', { turn: 1 })
    await enqueue('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Explain DSH_HOME' }] })
    await enqueue('assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'DSH_HOME is a configuration variable.' }] } })
    await enqueue('turn/end', { turn: 1, reason: 'completed' })
    await coordinator.whenIdle()
    expect(sent).toEqual([
      '[来自云枢]\nExplain DSH_HOME',
      '[云枢助手]\n\nDSH_HOME is a configuration variable.',
    ])
  } finally {
    coordinator.close()
  }
})

it('offers Yunshu as the default name for newly created Slack bots', async () => {
  const { SLACK_APP_MANIFEST_YAML } = await load('src/channels/slack/manifest.mjs') as { SLACK_APP_MANIFEST_YAML: string }
  expect(SLACK_APP_MANIFEST_YAML).toContain('name: Yunshu Assistant')
  expect(SLACK_APP_MANIFEST_YAML).toContain('display_name: Yunshu Assistant')
  expect(SLACK_APP_MANIFEST_YAML).not.toContain('DeepSeek Harness')
})
