import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  desktopBuildDateSegment,
  suggestDesktopBuildVersion,
} from '../scripts/desktop-build-version-discovery.ts'

const { getBucket } = vi.hoisted(() => ({ getBucket: vi.fn<(
  options: { Prefix: string; Marker?: string },
  callback: (error: null, page: { Contents: { Key: string }[]; IsTruncated: 'true' | 'false'; NextMarker?: string }) => void,
) => void>() }))
vi.mock('../scripts/desktop-cos.ts', () => ({ createDesktopCos: () => ({ getBucket }), DESKTOP_COS_REGION: 'ap-beijing' }))

const PRERELEASE = '0.1.6-alpha.2'
const STABLE = '0.1.6'
const DATE = '20260921'
const directories: string[] = []

async function artifactsWith(names: readonly string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-discovery-'))
  directories.push(directory)
  for (const name of names) await writeFile(join(directory, name), '')
  return directory
}

afterEach(async () => {
  getBucket.mockReset()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('desktop build version discovery', () => {
  it('formats the date segment in the build host time zone', () => {
    expect(desktopBuildDateSegment(new Date(2026, 8, 21))).toBe('20260921')
    expect(desktopBuildDateSegment(new Date(2026, 0, 5))).toBe('20260105')
  })

  it('starts at one when nothing is taken', async () => {
    const artifactsRoot = await artifactsWith([])
    await expect(suggestDesktopBuildVersion({ productVersion: PRERELEASE, target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRERELEASE}.${DATE}.1`)
  })

  it('numbers a stable product version under the documented test prerelease', async () => {
    const artifactsRoot = await artifactsWith([`yunshu-${STABLE}-test.${DATE}.4-win-x64.exe`])
    await expect(suggestDesktopBuildVersion({ productVersion: STABLE, target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${STABLE}-test.${DATE}.5`)
  })

  it('numbers after the highest local artifact for the same date', async () => {
    const artifactsRoot = await artifactsWith([
      `yunshu-${PRERELEASE}.${DATE}.1-win-x64.exe`,
      `yunshu-${PRERELEASE}.${DATE}.2-win-x64.exe`,
      `yunshu-${PRERELEASE}.${DATE}.10-win-x64.exe`,
    ])
    await expect(suggestDesktopBuildVersion({ productVersion: PRERELEASE, target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRERELEASE}.${DATE}.11`)
  })

  it('continues numbering after earlier DeepSeek-named artifacts alongside Yunshu builds', async () => {
    const artifactsRoot = await artifactsWith([
      `deepseek-harness-${PRERELEASE}.${DATE}.8-win-x64.exe`,
      `yunshu-${PRERELEASE}.${DATE}.7-win-x64.exe`,
    ])
    await expect(suggestDesktopBuildVersion({ productVersion: PRERELEASE, target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRERELEASE}.${DATE}.9`)
  })

  it('ignores artifacts from another date or product version', async () => {
    const artifactsRoot = await artifactsWith([
      `yunshu-${PRERELEASE}.20260920.7-win-x64.exe`,
      `yunshu-0.1.5-alpha.1.${DATE}.9-win-x64.exe`,
      `yunshu-${PRERELEASE}-win-x64.exe`,
      'unrelated.exe',
    ])
    await expect(suggestDesktopBuildVersion({ productVersion: PRERELEASE, target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRERELEASE}.${DATE}.1`)
  })

  it('reads macOS artifact names too', async () => {
    const artifactsRoot = await artifactsWith([
      `yunshu-${PRERELEASE}.${DATE}.3-mac-arm64.dmg`,
      `yunshu-${PRERELEASE}.${DATE}.3-mac-arm64.zip`,
    ])
    await expect(suggestDesktopBuildVersion({ productVersion: PRERELEASE, target: 'mac-arm64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRERELEASE}.${DATE}.4`)
  })

  it('counts unsigned Windows artifacts written under their own suffix', async () => {
    const artifactsRoot = await artifactsWith([
      `yunshu-${PRERELEASE}.${DATE}.2-win-x64-unsigned.exe`,
      `yunshu-${PRERELEASE}.${DATE}.5-win-x64-unsigned.exe.blockmap`,
    ])
    await expect(suggestDesktopBuildVersion({ productVersion: PRERELEASE, target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRERELEASE}.${DATE}.3`)
  })

  it('scans both product filename prefixes across all bucket pages before numbering', async () => {
    const first = `dsh-desk/bin/win-x64/deepseek-harness-${PRERELEASE}.${DATE}.8-win-x64.exe`
    const second = `dsh-desk/bin/win-x64/yunshu-${PRERELEASE}.${DATE}.9-win-x64.exe`
    getBucket.mockImplementationOnce((_options, callback) => {
      callback(null, { Contents: [{ Key: first }], IsTruncated: 'true', NextMarker: first })
    }).mockImplementationOnce((_options, callback) => {
      callback(null, { Contents: [{ Key: second }], IsTruncated: 'false' })
    })
    const artifactsRoot = await artifactsWith([])
    await expect(suggestDesktopBuildVersion({ productVersion: PRERELEASE, target: 'win-x64', date: DATE, artifactsRoot,
      environment: { DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', DOWNLOAD_PROD_COS_BUCKET: 'test-bucket',
        DOWNLOAD_PROD_COS_SECRET_ID: 'test-id', DOWNLOAD_PROD_COS_SECRET_KEY: 'test-key' },
    })).resolves.toBe(`${PRERELEASE}.${DATE}.10`)
    expect(getBucket).toHaveBeenNthCalledWith(1, expect.objectContaining({ Prefix: 'dsh-desk/bin/win-x64/' }), expect.any(Function))
    expect(getBucket).toHaveBeenNthCalledWith(2, expect.objectContaining({ Prefix: 'dsh-desk/bin/win-x64/', Marker: first }), expect.any(Function))
  })

  it('requires an explicit OSS build version before attempting COS discovery or local numbering', async () => {
    await expect(suggestDesktopBuildVersion({ productVersion: PRERELEASE, target: 'win-x64',
      environment: { DSH_DESKTOP_UPLOAD_PROVIDER: 'oss' }, date: DATE, artifactsRoot: '/not-read',
    })).rejects.toThrow(/automatic build numbering is unavailable for OSS.*explicit --build-version/u)
  })
})
