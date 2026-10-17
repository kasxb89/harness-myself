import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesktopUploadPlan, type DesktopUploadPlan } from '../scripts/desktop-upload-plan.ts'
import { loadDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { tagDesktopRelease } from '../scripts/desktop-release-tag.ts'
import { createDesktopCos } from '../scripts/desktop-cos.ts'
import { createDesktopOss } from '../scripts/desktop-oss.ts'
import { uploadDesktopOssRelease, uploadDesktopRelease } from '../scripts/desktop-upload-run.ts'
import { uploadDesktopTarget } from '../scripts/upload-target.ts'

vi.mock('../scripts/desktop-package-environment.mjs', () => ({ loadDesktopPackageEnvironment: vi.fn() }))
vi.mock('../scripts/desktop-upload-plan.ts', () => ({ createDesktopUploadPlan: vi.fn() }))
vi.mock('../scripts/desktop-cos.ts', () => ({ createDesktopCos: vi.fn() }))
vi.mock('../scripts/desktop-oss.ts', () => ({ createDesktopOss: vi.fn() }))
vi.mock('../scripts/desktop-upload-run.ts', () => ({ uploadDesktopRelease: vi.fn(), uploadDesktopOssRelease: vi.fn() }))
vi.mock('../scripts/desktop-release-tag.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../scripts/desktop-release-tag.ts')>(),
  tagDesktopRelease: vi.fn(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('desktop upload command', () => {
  it('requires explicit unsigned selection and never tags an unsigned production upload', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const settings = { executable: '/tools/ossutil', configFile: '/private/ossutil.ini', region: 'cn-beijing', namespace: 'yunshu-harnes' }
    const plan: DesktopUploadPlan = {
      unsigned: true, provider: 'oss', oss: settings, environment: 'production', target: 'win-x64', version: '1.2.3', bucket: 'yunshu666',
      publicUrl: 'https://alioss.denuoxuankeji.com/yunshu-harnes/feeds/win-x64/', secretIdEnvName: '', secretKeyEnvName: '', artifacts: [],
      commit: '0'.repeat(40), dirty: false,
    }
    const environment = { DSH_DESKTOP_UPLOAD_PROVIDER: 'oss' }
    vi.mocked(loadDesktopPackageEnvironment).mockReturnValue(environment)
    vi.mocked(createDesktopUploadPlan).mockResolvedValue(plan)
    await uploadDesktopTarget(['win-x64', '--unsigned'])
    expect(createDesktopUploadPlan).toHaveBeenCalledWith('win-x64', { environment, latest: false, unsigned: true })
    expect(uploadDesktopOssRelease).toHaveBeenCalledOnce()
    expect(tagDesktopRelease).not.toHaveBeenCalled()
  })

  it('selects the OSS publisher without looking up COS credentials', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const settings = { executable: '/tools/ossutil', configFile: '/private/ossutil.ini', region: 'cn-beijing', namespace: 'yunshu-harnes' }
    const plan: DesktopUploadPlan = {
      provider: 'oss', oss: settings, environment: 'test', target: 'mac-arm64', version: '1.2.3', bucket: 'yunshu666',
      publicUrl: 'https://alioss.denuoxuankeji.com/yunshu-harnes/feeds/mac-arm64/', secretIdEnvName: '', secretKeyEnvName: '', artifacts: [],
    }
    vi.mocked(loadDesktopPackageEnvironment).mockReturnValue({})
    vi.mocked(createDesktopUploadPlan).mockResolvedValue(plan)
    await uploadDesktopTarget(['mac-arm64'])
    expect(createDesktopOss).toHaveBeenCalledWith(settings)
    expect(uploadDesktopOssRelease).toHaveBeenCalledOnce()
    expect(uploadDesktopRelease).not.toHaveBeenCalled()
    expect(createDesktopCos).not.toHaveBeenCalled()
  })

  it.each([
    { environment: 'production', latest: true, tagged: false },
    { environment: 'production', latest: false, tagged: true },
    { environment: 'test', latest: true, tagged: false },
    { environment: 'test', latest: false, tagged: false },
  ] as const)('uploads $environment latest=$latest with tagged=$tagged', async ({ environment, latest, tagged }) => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const credentials = { DOWNLOAD_TEST_COS_SECRET_ID: 'fixture-id', DOWNLOAD_TEST_COS_SECRET_KEY: 'fixture-key' }
    const plan: DesktopUploadPlan = {
      environment, target: 'win-x64', version: '1.2.3-alpha.4',
      publicUrl: 'https://desktop-updates.example.com/desktop/dsh-latest-windows-x64.exe',
      bucket: 'fixture-bucket', secretIdEnvName: 'DOWNLOAD_TEST_COS_SECRET_ID',
      secretKeyEnvName: 'DOWNLOAD_TEST_COS_SECRET_KEY', artifacts: [], commit: '0'.repeat(40), dirty: false,
    }
    vi.mocked(loadDesktopPackageEnvironment).mockReturnValue(credentials)
    vi.mocked(createDesktopUploadPlan).mockResolvedValue(plan)
    vi.mocked(uploadDesktopRelease).mockResolvedValue('fixture-records')
    vi.mocked(tagDesktopRelease).mockReturnValue({ status: 'created', tag: 'desktop-v1.2.3-alpha.4' })

    await uploadDesktopTarget(['win-x64', ...latest ? ['--latest'] : []])

    expect(createDesktopUploadPlan).toHaveBeenCalledWith('win-x64', { environment: credentials, latest })
    expect(uploadDesktopRelease).toHaveBeenCalledOnce()
    expect(vi.mocked(uploadDesktopRelease).mock.calls[0]![0]).toBe(plan)
    if (tagged) {
      expect(tagDesktopRelease).toHaveBeenCalledWith(expect.objectContaining({ version: plan.version, commit: plan.commit }))
      expect(vi.mocked(tagDesktopRelease).mock.invocationCallOrder[0])
        .toBeGreaterThan(vi.mocked(uploadDesktopRelease).mock.invocationCallOrder[0]!)
    }
    else {
      expect(tagDesktopRelease).not.toHaveBeenCalled()
    }
  })
})
