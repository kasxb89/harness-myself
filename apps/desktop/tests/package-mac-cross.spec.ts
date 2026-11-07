import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyMacCrossPayload, crossBuildOptions, linkMacCrossRuntimeSupport,
  macCrossBundleVersion, macCrossConveyorVersion, macCrossLocalEnvironment,
  privateMacCrossEnvironment } from '../scripts/package-mac-cross.ts'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

describe('private Windows macOS packaging entry', () => {
  it('keeps CLI support within the app through a relative alias and rejects unexpected existing paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'cross-cli-support-'))
    try {
      mkdirSync(join(root, 'app'))
      mkdirSync(join(root, 'runtime/primary-runtime'), { recursive: true })
      writeFileSync(join(root, 'runtime/primary-runtime/runtime.json'), '{}')
      linkMacCrossRuntimeSupport(root)
      linkMacCrossRuntimeSupport(root)
      expect(readlinkSync(join(root, 'app/runtime')).replaceAll('\\', '/')).toBe('../runtime')
      expect(readFileSync(join(root, 'app/runtime/primary-runtime/runtime.json'), 'utf8')).toBe('{}')
      rmSync(join(root, 'app/runtime'))
      mkdirSync(join(root, 'app/runtime'))
      expect(() => { linkMacCrossRuntimeSupport(root) }).toThrow('unexpected CLI support path')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('checks native inputs before adding data and preserves the resulting signed bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'cross-payload-'))
    try {
      const source = join(root, 'source'), output = join(root, 'output')
      mkdirSync(join(source, 'lib'), { recursive: true })
      const binary = Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from('original')])
      writeFileSync(join(source, 'lib/native.node'), binary)
      writeFileSync(join(source, 'launch'), '#!/bin/sh\nexit 0\n')
      writeFileSync(join(source, 'lib/data.json'), '{"value":1}\n')
      const bundle = 'Office.app/Contents'
      mkdirSync(join(source, bundle, '_CodeSignature'), { recursive: true })
      writeFileSync(join(source, bundle, 'Info.plist'), '<plist/>')
      writeFileSync(join(source, bundle, 'asset.txt'), 'bundled data')
      writeFileSync(join(source, bundle, '_CodeSignature/CodeResources'), 'old seal')
      expect(copyMacCrossPayload(source, output, 'native')).toBe(5)
      expect(readFileSync(join(output, bundle, 'asset.txt'), 'utf8')).toBe('bundled data')
      const signed = Buffer.concat([binary, Buffer.from('signature')])
      writeFileSync(join(output, 'lib/native.node'), signed)
      writeFileSync(join(output, bundle, '_CodeSignature/CodeResources'), 'new seal')
      expect(copyMacCrossPayload(source, output, 'data')).toBe(1)
      expect(readFileSync(join(output, 'lib/native.node'))).toEqual(signed)
      expect(readFileSync(join(output, bundle, '_CodeSignature/CodeResources'), 'utf8')).toBe('new seal')
      expect(readFileSync(join(output, 'lib/data.json'), 'utf8')).toBe('{"value":1}\n')
      writeFileSync(join(source, 'new.node'), binary)
      expect(() => copyMacCrossPayload(source, output, 'data')).toThrow('omitted from Conveyor checks')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('normalizes only the internal Conveyor version for prerelease products', () => {
    expect(macCrossConveyorVersion('0.2.1-alpha.2.20261029.1')).toBe('0.2.1~alpha.2.20261029.1')
    expect(macCrossConveyorVersion('1.0.0')).toBe('1.0.0')
    expect(macCrossBundleVersion('0.2.1-alpha.2.20261029.1')).toBe('0.2.1')
    expect(() => macCrossBundleVersion('invalid')).toThrow('bundle version')
  })
  it('selects the canonical local identity before producing real package metadata', () => {
    const environment = macCrossLocalEnvironment({ DSH_DESKTOP_APP_ID: 'ambient.wrong', APPLE_ID: 'private', OSS_ACCESS_KEY_ID: 'private' })
    const configuration = createElectronBuilderConfig({ ...environment, DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
      DSH_DESKTOP_TARGET_ARCH: 'arm64', DSH_DESKTOP_BUILD_VERSION: '0.2.1-alpha.2.20261029.1' }, 'win32', 'x64')
    expect(configuration.appId).toBe('com.deepseek.harness')
    expect(configuration.extraMetadata).toMatchObject({ dshDesktopUnsigned: true, version: '0.2.1-alpha.2.20261029.1',
      dshDesktopAppId: 'com.deepseek.harness', dshDesktopUpdateConfigOrigin: 'https://8.133.202.230/harness' })
    expect(environment.APPLE_ID).toBeUndefined()
    expect(environment.OSS_ACCESS_KEY_ID).toBeUndefined()
  })

  it('requires a fixed Mac architecture and complete version before creating an application', () => {
    for (const arch of ['arm64', 'x64']) {
      expect(crossBuildOptions(['--root', 'D:\\YunshuBuild', '--arch', arch, '--build-version', '0.2.1-alpha.2.20261029.1'], 'win32', 'x64'))
        .toMatchObject({ root: 'D:\\YunshuBuild', arch, version: '0.2.1-alpha.2.20261029.1', prepareOnly: false })
    }
    expect(() => crossBuildOptions(['--root', 'D:\\YunshuBuild', '--arch', 'arm64'], 'win32', 'x64')).toThrow('user-confirmed')
    expect(crossBuildOptions(['--root', 'D:\\YunshuBuild', '--arch', 'arm64', '--prepare-only'], 'win32', 'x64').prepareOnly).toBe(true)
  })

  it('rejects the wrong host, drive, root directory, architecture, and publication flags', () => {
    const args = ['--root', 'D:\\YunshuBuild', '--arch', 'x64', '--prepare-only']
    expect(() => crossBuildOptions(args, 'darwin', 'arm64')).toThrow('Windows x64')
    for (const root of ['C:\\YunshuBuild', 'D:\\', 'D:relative', 'D:\\build\\..\\other']) {
      expect(() => crossBuildOptions(['--root', root, '--arch', 'x64', '--prepare-only'], 'win32', 'x64')).toThrow('D-drive')
    }
    expect(() => crossBuildOptions([...args, '--publish'], 'win32', 'x64')).toThrow()
    expect(() => crossBuildOptions(['--root', 'D:\\build', '--arch', 'ia32', '--prepare-only'], 'win32', 'x64')).toThrow('--arch')
  })

  it('removes inherited upload and Apple credentials while retaining the private download proxy', () => {
    expect(privateMacCrossEnvironment({ APPLE_ID: 'secret', APPLE_APP_SPECIFIC_PASSWORD: 'secret', OSS_ACCESS_KEY_ID: 'secret',
      DOWNLOAD_PROD_COS_SECRET_KEY: 'secret', CSC_LINK: 'secret', DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'secret',
      ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require=unexpected', HTTPS_PROXY: 'http://127.0.0.1:7897', PATH: 'tools' }))
      .toEqual({ HTTPS_PROXY: 'http://127.0.0.1:7897', PATH: 'tools' })
  })
})
