/** Private Kylin packages keep every ordinary release and update authority separate. */
import { expect, it } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { desktopTargetBuildPaths } from '../scripts/desktop-build-paths.mjs'
import { resolveDesktopPackageTarget } from '../scripts/package-target.ts'
import { isPrivateKylinPackage } from '../src/update-source.ts'
import { privateKylinHostExecutable } from '../src/kylin-runtime.ts'

const privateEnv = { DSH_DESKTOP_APP_ID: 'com.example.yunshu', DSH_DESKTOP_LINUX_PRIVATE: '1',
  DSH_DESKTOP_TARGET_PLATFORM: 'linux', DSH_DESKTOP_TARGET_ARCH: 'x64',
  DSH_DESKTOP_BUILD_VERSION: '0.2.1-alpha.2.20261110.1' }

it('isolates Kylin output and omits all ordinary update and policy metadata', () => {
  const config = createElectronBuilderConfig(privateEnv, 'linux', 'x64')
  expect(config.publish).toBeNull()
  expect(config.extraMetadata).toMatchObject({ dshDesktopPrivateDistribution: 'kylin-v10sp1-2503-x64' })
  expect(config.extraMetadata).not.toHaveProperty('dshDesktopUpdateConfigOrigin')
  expect(config.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
  expect(config.linux.target).toEqual(['deb', 'tar.gz'])
  expect(config.artifactName).toContain('-kylin-v10sp1-2503.')
  for (const target of ['mac-arm64', 'mac-x64', 'win-x64'] as const) {
    expect(config.directories.output).not.toBe(desktopTargetBuildPaths(target).artifacts)
  }
})

it('requires the dedicated Linux mode and refuses mismatched platform or architecture', () => {
  expect(() => createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.example.yunshu' }, 'linux', 'x64'))
    .toThrow(/dedicated private/u)
  expect(() => createElectronBuilderConfig({ ...privateEnv, DSH_DESKTOP_TARGET_ARCH: 'arm64' }, 'linux', 'arm64'))
    .toThrow(/linux-x64/u)
  expect(() => resolveDesktopPackageTarget('linux-x64', 'linux', 'x64')).toThrow(/unsupported target/u)
})

it('disables shared-feed polling only for the exact installed private Kylin manifest', () => {
  const manifest = { dshDesktopPrivateDistribution: 'kylin-v10sp1-2503-x64' }
  expect(isPrivateKylinPackage(true, manifest, 'linux', 'x64')).toBe(true)
  for (const platform of ['darwin', 'win32'] as const) expect(isPrivateKylinPackage(true, manifest, platform, 'x64')).toBe(false)
  expect(isPrivateKylinPackage(false, manifest, 'linux', 'x64')).toBe(false)
  expect(isPrivateKylinPackage(true, manifest, 'linux', 'arm64')).toBe(false)
  expect(isPrivateKylinPackage(true, {}, 'linux', 'x64')).toBe(false)
})

it('selects the isolated Host without replacing ordinary platform executables', () => {
  const manifest = { dshDesktopPrivateDistribution: 'kylin-v10sp1-2503-x64' }
  expect(privateKylinHostExecutable('/opt/app/yunshu', '/opt/app/resources', manifest, 'linux', 'x64'))
    .toBe('/opt/app/resources/runtime/kylin-compat/bin/node')
  for (const platform of ['darwin', 'win32'] as const) {
    expect(privateKylinHostExecutable('/ordinary/electron', '/ordinary/resources', manifest, platform, 'x64')).toBe('/ordinary/electron')
  }
  expect(privateKylinHostExecutable('/ordinary/electron', '/ordinary/resources', {}, 'linux', 'x64')).toBe('/ordinary/electron')
})
