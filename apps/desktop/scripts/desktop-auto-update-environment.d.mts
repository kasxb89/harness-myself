/** Environment variable that selects the Desktop update deployment. */
export const DESKTOP_AUTO_UPDATE_ENV: 'DSH_DESKTOP_AUTO_UPDATE_ENV'

/** Environment variable that selects the Desktop artifact upload provider. */
export const DESKTOP_UPLOAD_PROVIDER_ENV: 'DSH_DESKTOP_UPLOAD_PROVIDER'

/** Supported Desktop artifact upload provider. */
export type DesktopUploadProvider = 'cos' | 'oss'

/** Supported Desktop update deployment. */
export type DesktopAutoUpdateEnvironment = 'test' | 'production'

/** Directory name of one supported Desktop release target. */
export type DesktopAutoUpdateTarget = 'mac-arm64' | 'mac-x64' | 'win-x64'

/** Public updater URL and object prefixes for one release target. */
export interface DesktopAutoUpdateConfig {
  readonly environment: DesktopAutoUpdateEnvironment
  readonly target: DesktopAutoUpdateTarget
  readonly origin: string
  readonly publicUrl: string
  readonly keyPrefix: string
  readonly binaryKeyPrefix: string
}

/** Public updater URL and private COS destination for one upload target. */
export interface DesktopUploadConfig extends DesktopAutoUpdateConfig {
  readonly bucket: string
  readonly secretIdEnvName: string
  readonly secretKeyEnvName: string
}

/** Public updater URL and explicit OSS destination for one upload target. */
export interface DesktopOssUploadConfig extends DesktopAutoUpdateConfig {
  readonly provider: 'oss'
  readonly namespace: string
  readonly bucket: string
  readonly region: string
  readonly ossutilBin: string
  readonly ossutilConfigFile: string
}

/**
 * Select an upload provider without changing existing COS release configurations.
 * @param env - Packaging or upload environment.
 * @returns Selected object-storage provider.
 */
export function resolveDesktopUploadProvider(env: NodeJS.ProcessEnv): DesktopUploadProvider

/**
 * Resolve the update deployment, defaulting local release work to test.
 * @param env - Packaging or upload environment.
 * @returns Validated deployment name.
 */
export function resolveDesktopAutoUpdateEnvironment(
  env: NodeJS.ProcessEnv,
): DesktopAutoUpdateEnvironment

/**
 * Resolve one supported platform and architecture to its update directory.
 * @param platform - Target Node.js platform.
 * @param arch - Target Node.js architecture.
 * @returns Update target directory.
 */
export function resolveDesktopAutoUpdateTarget(
  platform: NodeJS.Platform,
  arch: string,
): DesktopAutoUpdateTarget

/**
 * Return the local completion record filename for one packaged target.
 * @param target - Supported release target.
 * @returns Filename stored beside electron-builder artifacts.
 */
export function desktopBuildRecordFilename(target: DesktopAutoUpdateTarget): string

/**
 * Return the electron-builder channel metadata filename for an application version.
 * @param version - Desktop semantic version.
 * @param platform - Target platform.
 * @returns Channel metadata filename emitted for the target.
 */
export function desktopUpdateMetadataFilename(
  version: string,
  platform: NodeJS.Platform,
): string

/**
 * Resolve the public updater URL and object prefixes for one release target.
 * @param env - Packaging or upload environment.
 * @param platform - Target Node.js platform.
 * @param arch - Target Node.js architecture.
 * @returns Resolved updater configuration.
 * @throws When the selected origin or namespace is invalid, or test deployment lacks its release ID.
 */
export function resolveDesktopAutoUpdateConfig(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  arch: string,
): DesktopAutoUpdateConfig

/**
 * Resolve the public updater URL and private COS destination for one upload target.
 * @param env - Upload environment.
 * @param platform - Target Node.js platform.
 * @param arch - Target Node.js architecture.
 * @returns Resolved upload configuration.
 * @throws When OSS is selected or the COS deployment lacks a bucket or valid updater configuration.
 */
export function resolveDesktopUploadConfig(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  arch: string,
): DesktopUploadConfig

/**
 * Resolve an OSS upload destination without reading credentials or invoking ossutil.
 * @param env - File-owned OSS release settings.
 * @param platform - Target Node.js platform.
 * @param arch - Target Node.js architecture.
 * @returns Resolved OSS upload configuration.
 * @throws When OSS is not selected or its explicit destination and tool settings are incomplete.
 */
export function resolveDesktopOssUploadConfig(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  arch: string,
): DesktopOssUploadConfig
