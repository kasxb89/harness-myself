import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Arch } from 'electron-builder'
import { Packager } from 'app-builder-lib'
import { AppInfo } from 'app-builder-lib/out/appInfo.js'
import { MacPackager } from 'app-builder-lib/out/macPackager.js'
import { WinPackager } from 'app-builder-lib/out/winPackager.js'
import { getAppUpdatePublishConfiguration } from 'app-builder-lib/out/publish/PublishManager.js'
import { createUpdateInfoTasks, writeUpdateInfoFiles } from 'app-builder-lib/out/publish/updateInfoBuilder.js'
import { ArchiveTarget } from 'app-builder-lib/out/targets/ArchiveTarget.js'
import { createBlockmap } from 'app-builder-lib/out/targets/differentialUpdateInfoBuilder.js'
import { load } from 'js-yaml'
import { expect, it, vi } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

it.each([
  ['darwin', 'arm64', Arch.arm64, 'nightly-mac.yml', 'dmg'],
  ['darwin', 'x64', Arch.x64, 'nightly-mac.yml', 'dmg'],
  ['win32', 'x64', Arch.x64, 'nightly.yml', 'exe'],
] as const)('emits unsigned %s %s generic updater metadata with the installed builder', async (platform, arch, builderArch, filename, extension) => {
  const root = await mkdtemp(join(tmpdir(), 'yunshu-unsigned-update-'))
  try {
    const config = createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.example.yunshu', DSH_DESKTOP_UNSIGNED: '1' }, platform, arch)
    const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string
      version: string
      description: string
      dependencies: Record<string, string>
    }
    const packager = new Packager({ projectDir: root })
    Object.defineProperties(packager, {
      config: { value: config }, metadata: { value: metadata }, devMetadata: { value: metadata },
    })
    Object.defineProperty(packager, 'appInfo', { value: new AppInfo(packager, null) })
    const targetPackager = platform === 'win32' ? new WinPackager(packager) : new MacPackager(packager)
    vi.spyOn(targetPackager, 'getResource').mockResolvedValue(null)
    const updater = await getAppUpdatePublishConfiguration(targetPackager, null, builderArch, false)
    expect(updater).toMatchObject({ provider: 'generic', channel: 'nightly', url: config.publish?.[0]?.url })
    expect(updater).not.toHaveProperty('publisherName')
    if (targetPackager instanceof WinPackager) expect(targetPackager.isForceCodeSigningVerification).toBe(false)
    const artifactName = `yunshu-${metadata.version}-${platform === 'win32' ? 'win' : 'mac'}-${arch}-unsigned.${extension}`
    const bytes = Buffer.from('unsigned artifact metadata fixture')
    const file = join(root, artifactName)
    await writeFile(file, bytes)
    const target = new ArchiveTarget(extension, root, targetPackager)
    const updateInfo = await createBlockmap(file, target, targetPackager, artifactName)
    const publish = { provider: 'generic' as const, channel: 'nightly', url: config.publish![0].url }
    const tasks = await createUpdateInfoTasks({ file, target, arch: builderArch, packager: targetPackager, updateInfo },
      [publish])
    const emitted = vi.spyOn(packager, 'emitArtifactCreated').mockResolvedValue(undefined)
    await writeUpdateInfoFiles(tasks, packager)
    expect(load(await readFile(join(root, filename), 'utf8'))).toMatchObject({
      version: metadata.version, path: artifactName,
      files: [{ url: artifactName, size: bytes.byteLength, sha512: createHash('sha512').update(bytes).digest('base64') }],
    })
    expect(emitted).toHaveBeenCalledOnce()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
