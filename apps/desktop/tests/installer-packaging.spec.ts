import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { AppInfo } from 'app-builder-lib/out/appInfo.js'
import { Arch, Platform } from 'electron-builder'
import { Packager } from 'app-builder-lib'
import { describe, expect, it, vi } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn(async () => undefined) }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) }
})

describe('installer preparation preserves application dependencies', () => {
  it.each(['win32', 'darwin'] as const)('retains unsigned %s backend updates while omitting mandatory policy and release destinations', async (platform) => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.example.installer', DSH_DESKTOP_UNSIGNED: '1',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'invalid',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'not-an-origin',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: 'invalid-json',
      DSH_DESKTOP_UPDATE_CONFIG_ORIGIN: 'https://yunshu.example.com/harness/',
    }, platform, 'x64')
    expect(config.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
    expect(config.extraMetadata).toMatchObject({ dshDesktopUpdateConfigOrigin: 'https://yunshu.example.com/harness', dshDesktopUnsigned: true })
    expect(config.publish).toEqual([{ provider: 'generic', channel: 'nightly',
      url: `https://yunshu.example.com/harness/desktop-updates/${platform === 'win32' ? 'win' : 'mac'}-x64/` }])
    expect(config.win.forceCodeSigning).toBe(false)
  })

  it.each(['win32', 'darwin'] as const)('rejects a missing production policy before signing on %s', async (platform) => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    expect(() => createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://test.example.com',
    }, platform, 'x64')).toThrow('DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN')
  })
  it.each(['win32', 'darwin'] as const)('keeps electron-builder responsible for node_modules on %s', async (platform) => {
    execute.mockClear()
    const env = {
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
      DSH_DESKTOP_TARGET_PLATFORM: platform,
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: platform === 'win32' ? '1' : '0',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
      DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
      APPLE_KEYCHAIN_PROFILE: 'installer-test',
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com', DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
    }
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    try {
      const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
      const config = createElectronBuilderConfig(env, platform, 'x64')
      expect(config.productName).toBe('云枢')
      expect(config.appId).toBe('com.example.installer')
      expect(config.artifactName).toBe(`yunshu-\${version}-\${os}-\${arch}${platform === 'win32' ? '-unsigned' : ''}.\${ext}`)
      expect(config.win.executableName).toBe('Yunshu')
      expect(config.protocols).toEqual([{ name: '云枢', schemes: ['dsh'] }])
      expect(config.extraMetadata).not.toHaveProperty('name')
      expect(config.extraMetadata).not.toHaveProperty('productName')
      expect(config.mac.icon).toMatch(/icon-macos\.png$/u)
      expect(config.win.icon).toMatch(/icon-windows\.png$/u)
      expect(config.linux.icon).toMatch(/resources[/\\]icon\.png$/u)
      const aboutIcon = config.extraResources.find(resource => resource.to === 'icon.png')
      expect(aboutIcon).toBeDefined()
      expect(readFileSync(aboutIcon!.from)).toEqual(readFileSync(new URL('../resources/icon-windows.png', import.meta.url)))
      // Only the Windows package carries the tray bitmaps; macOS keeps the Dock.
      const trayIcon = config.extraResources.find(resource => resource.to === 'tray.ico')
      if (platform === 'win32') {
        expect(readFileSync(trayIcon!.from)).toEqual(readFileSync(new URL('../resources/tray-windows.ico', import.meta.url)))
      } else {
        expect(trayIcon).toBeUndefined()
      }
      const packager = new Packager({ projectDir: tmpdir() })
      // A foreign source-build target avoids rebuilding modules; the real dependency ownership decision still runs.
      Object.defineProperties(packager, {
        config: { value: { beforeBuild: config.beforeBuild, buildDependenciesFromSource: true } },
        framework: { value: { isNpmRebuildRequired: true, version: '42.0.0' } },
        appInfo: { value: { type: 'module' } },
      })
      vi.spyOn(packager, 'getWorkspaceRoot').mockResolvedValue(tmpdir())
      await packager.installAppDependencies(process.platform === 'win32' ? Platform.LINUX : Platform.WINDOWS, Arch.x64)
      expect(packager.areNodeModulesHandledExternally).toBe(false)
      expect(execute).toHaveBeenCalledTimes(platform === 'win32' ? 1 : 0)
    } finally {
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
    }
  })

  it('uses Yunshu in actual builder version fields while retaining the internal package identity', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.example.installer', DSH_DESKTOP_UNSIGNED: '1' }, 'win32', 'x64')
    const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string
      version: string
      description: string
    }
    const packager = new Packager({ projectDir: tmpdir() })
    Object.defineProperties(packager, {
      config: { value: config }, metadata: { value: metadata }, devMetadata: { value: metadata },
    })
    const appInfo = new AppInfo(packager, null, { executableName: config.win.executableName })
    expect(appInfo.name).toBe('@deepseek-ai/dsh-desktop')
    expect(appInfo.id).toBe('com.example.installer')
    expect(appInfo.productFilename).toBe('Yunshu')
    expect(appInfo.productName).toBe('云枢')
    expect(appInfo.companyName).toBeNull()
    expect(appInfo.copyright).toMatch(/^Copyright © \d{4} 云枢$/u)
    const { NsisTarget } = createRequire(import.meta.url)('app-builder-lib/out/targets/nsis/NsisTarget.js') as {
      NsisTarget: { prototype: { computeVersionKey: (this: {
        options: { language?: string }
        packager: { appInfo: AppInfo; platformSpecificBuildOptions: { legalTrademarks?: string } }
      }) => string[] } }
    }
    const versionFields = NsisTarget.prototype.computeVersionKey.call({ options: {},
      packager: { appInfo, platformSpecificBuildOptions: {} } })
    expect(versionFields).toContain('/LANG=1033 ProductName "云枢"')
    expect(versionFields).toContain('/LANG=1033 FileDescription "云枢智能工作台"')
    expect(versionFields.some(field => /deepseek|electron desktop shell/iu.test(field))).toBe(false)
  })

  it('names unsigned Windows artifacts so they cannot pass for release builds', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: '1',
    }, 'win32', 'x64')
    expect(config.artifactName).toBe('yunshu-${version}-${os}-${arch}-unsigned.${ext}')
  })

  it('packages every preload entry point the shell loads', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const sourceDirectory = new URL('../src/', import.meta.url)
    const referenced = new Set<string>()
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      for (const match of readFileSync(new URL(entry.name, sourceDirectory), 'utf8').matchAll(/preload-[a-z-]+\.cjs/gu)) referenced.add(match[0])
    }
    expect(referenced.size).toBeGreaterThan(0)
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://harness-test.deepseek.com',
      DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
      DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
      APPLE_KEYCHAIN_PROFILE: 'installer-test',
    }, 'darwin', 'arm64')
    const packaged = new Set(config.files.filter((entry): entry is string => typeof entry === 'string'))
    for (const name of referenced) expect(packaged.has(`lib/${name}`)).toBe(true)
  })
})


it('embeds explicitly configured backend authorities in signed and unsigned packages', async () => {
  const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
  const env = {
    DSH_DESKTOP_APP_ID: 'com.example.installer', DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
    DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://policy.example.com',
    DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)', DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
    APPLE_KEYCHAIN_PROFILE: 'installer-test', DSH_DESKTOP_UPDATE_CONFIG_ORIGIN: 'https://8.133.202.230/harness/',
  }
  expect(createElectronBuilderConfig(env, 'darwin', 'arm64').extraMetadata)
    .toMatchObject({ dshDesktopUpdateConfigOrigin: 'https://8.133.202.230/harness' })
  expect(createElectronBuilderConfig({ ...env, DSH_DESKTOP_UPDATE_CONFIG_ORIGIN: '' }, 'darwin', 'arm64').extraMetadata)
    .not.toHaveProperty('dshDesktopUpdateConfigOrigin')
  expect(createElectronBuilderConfig({ ...env, DSH_DESKTOP_UNSIGNED: '1' }, 'darwin', 'arm64').extraMetadata)
    .toMatchObject({ dshDesktopUpdateConfigOrigin: 'https://8.133.202.230/harness', dshDesktopUnsigned: true })
  expect(createElectronBuilderConfig(env, 'darwin', 'arm64').extraMetadata).not.toHaveProperty('dshDesktopUnsigned')
  expect(createElectronBuilderConfig(env, 'darwin', 'arm64').win).not.toHaveProperty('verifyUpdateCodeSignature')
})

it.each(['win32', 'darwin'] as const)('rejects malformed unsigned %s update authorities', async (platform) => {
  const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
  for (const authority of ['not-an-origin', 'https://8.133.202.230', 'https://user:secret@yunshu.example.com', 'https://yunshu.example.com?token=secret']) {
    expect(() => createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.example.installer', DSH_DESKTOP_UNSIGNED: '1',
      DSH_DESKTOP_UPDATE_CONFIG_ORIGIN: authority }, platform, 'x64')).toThrow(/HTTPS backend base/u)
  }
})

it('keeps signed OSS ordinary updates when the separate mandatory service is explicitly disabled', async () => {
  const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
  const config = createElectronBuilderConfig({
    DSH_DESKTOP_APP_ID: 'com.example.installer', DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', DSH_DESKTOP_UPLOAD_PROVIDER: 'oss',
    DSH_DESKTOP_UPDATE_PREFIX: 'yunshu-harnes', DOWNLOAD_PROD_ORIGIN: 'https://alioss.denuoxuankeji.com',
    DSH_DESKTOP_MANDATORY_UPDATE_ENABLED: 'false', DSH_DESKTOP_UPDATE_CONFIG_ORIGIN: 'https://8.133.202.230/harness',
    DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)', DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
    APPLE_KEYCHAIN_PROFILE: 'installer-test',
  }, 'darwin', 'arm64')
  expect(config.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
  expect(config.extraMetadata).toHaveProperty('dshDesktopUpdateConfigOrigin', 'https://8.133.202.230/harness')
  expect(config.publish).toEqual([{ provider: 'generic', channel: 'nightly',
    url: 'https://alioss.denuoxuankeji.com/yunshu-harnes/feeds/mac-arm64/' }])
  expect(config.mac.forceCodeSigning).toBe(true)
  expect(config.mac.notarize).toBe(true)
  expect(() => createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.example.installer',
    DSH_DESKTOP_UPLOAD_PROVIDER: 'oss', DSH_DESKTOP_MANDATORY_UPDATE_ENABLED: 'false',
  }, 'win32', 'x64')).toThrow('DSH_DESKTOP_UPDATE_CONFIG_ORIGIN')
})
