/** Product IM copy from the installed patched client, including its real settings render. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, onTestFinished } from 'vitest'

const productRequire = createRequire(new URL('../../../packages/bundle/web-app/package.json', import.meta.url))
const packageRoot = dirname(productRequire.resolve('@xmanrui/dsh-im/package.json'))
const reactRequire = createRequire(import.meta.url)
type Dictionary = Record<string, string>
type InstalledPlugin = { apply: (context: Record<string, unknown>) => void }
type ImTranslations = {
  zh: Dictionary
  localizeText: (value: string) => string
  setImTranslator: (translate: (key: string) => string) => void
}

function isInstalledPlugin(value: unknown): value is InstalledPlugin {
  return typeof value === 'object' && value !== null && 'apply' in value && typeof value.apply === 'function'
}

function isImTranslations(value: unknown): value is ImTranslations {
  return typeof value === 'object' && value !== null
    && 'zh' in value && typeof value.zh === 'object' && value.zh !== null
    && 'localizeText' in value && typeof value.localizeText === 'function'
    && 'setImTranslator' in value && typeof value.setImTranslator === 'function'
}

function installedClient(language: 'zh' | 'en') {
  let client: unknown
  runInNewContext(readFileSync(join(packageRoot, 'lib/client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load: (entry: { id: string; factory: (require: NodeJS.Require) => unknown }) => {
      expect(entry.id).toBe('@xmanrui/dsh-im')
      client = entry.factory(reactRequire)
    } } },
    AbortController, URL, setTimeout, clearTimeout,
  })
  if (!isInstalledPlugin(client)) {
    throw new Error('The installed IM client has no plugin apply function')
  }
  let dictionaries: Record<'zh' | 'en', Dictionary> | undefined
  let panel: (() => ReactElement) | undefined
  const disposers: Array<() => void> = []
  onTestFinished(() => { for (const dispose of disposers.reverse()) dispose() })
  client.apply({
    effect: (effect: () => (() => void) | undefined) => {
      const dispose = effect()
      if (dispose !== undefined) disposers.push(dispose)
    },
    locale: {
      register: (_namespace: string, value: Record<'zh' | 'en', Dictionary>) => {
        dictionaries = value
        return () => {}
      },
      bind: () => (key: string) => dictionaries?.[language][key] ?? key,
      getLocale: () => ({ active: language }),
    },
    connection: { rpc: { call: async () => ({ ok: true }) } },
    on: () => () => {},
    slots: {
      inject: (_name: string, register: () => () => void) => register(),
      register: (_definition: object, component: () => ReactElement) => {
        panel = component
        return () => { panel = undefined }
      },
    },
  })
  if (panel === undefined || dictionaries === undefined) throw new Error('The installed IM settings did not register')
  return { html: renderToStaticMarkup(panel()), dictionaries }
}

it.each([
  { language: 'zh' as const, heading: '云枢 IM', description: '让云枢触手可及', brand: '云枢' },
  { language: 'en' as const, heading: 'Yunshu IM', description: 'Connecting Yunshu', brand: 'Yunshu' },
])('renders Yunshu branding from the installed $language IM client', ({ language, heading, description, brand }) => {
  const { html, dictionaries } = installedClient(language)
  expect(html).toContain(heading)
  expect(html.replaceAll(' ', '')).toContain(description.replaceAll(' ', ''))
  expect(html).not.toContain('DeepSeek Harness')
  expect(html).not.toContain('DSH-IM')
  expect(dictionaries[language]['DSH 版本']).toContain(brand)
  expect(dictionaries[language]['新版本已安装，请在方便时手动重启当前 Harness 或 Desktop。']).toContain(brand)
  expect(dictionaries[language]['插件无法连接当前 Harness，请检查宿主是否已就绪。']).toContain(brand)
  expect(dictionaries[language]['账号配置无法写入本机。请检查 DSH_HOME 目录权限。']).toContain('DSH_HOME')
  const locale = JSON.parse(readFileSync(join(packageRoot, `locale/${language}.json`), 'utf8')) as {
    meta: { title: string; description: string }
  }
  expect(locale.meta.title).toContain(brand)
  expect(locale.meta.description).toContain(brand)
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    name: string
    author: string
    license: string
    bin: Record<string, string>
  }
  expect(manifest.name).toBe('@xmanrui/dsh-im')
  expect(manifest.author).toContain('xmanrui')
  expect(manifest.license).toBe('MIT')
  expect(manifest.bin['dsh-im']).toBe('bin/dsh-im.mjs')
})

it('brands dynamic Chinese configuration diagnostics without rewriting names, paths, or protocol markers', async () => {
  const source: unknown = await import(pathToFileURL(join(packageRoot, 'plugin-src/client/i18n.js')).href)
  if (!isImTranslations(source)) throw new Error('The installed IM source has no localization API')
  source.setImTranslator(key => source.zh[key] ?? key)
  for (const file of ['config.json', 'workspaces.json']) {
    expect(source.localizeText(`微信配置格式错误：${file}。请查看诊断详情，修复后重启 DSH。`))
      .toBe(`微信配置格式错误：${file}。请查看诊断详情，修复后重启云枢。`)
    const hint = `请检查微信渠道数据目录中的 ${file}，修复后重启 DSH；“重新读取”不会重新加载配置。`
    expect(source.localizeText(hint)).toBe(hint.replace('重启 DSH；', '重启云枢；'))
    const details = `DSH test: ${hint} 字段位置中的序号从 0 开始，按文件中的条目顺序计数，不包含真实账号标识。`
    expect(source.localizeText(details)).toBe(details.replace('重启 DSH；', '重启云枢；'))
  }
  for (const value of ['DSH support team', '/tmp/DSH/config.json', '🤖 DSH', 'DSH_HOME']) {
    expect(source.localizeText(value)).toBe(value)
  }
})
