/** Keep the private Linux Host's native libraries separate from the desktop system. */
import { join } from 'node:path'
import { isPrivateKylinPackage } from './update-source.ts'

/**
 * Select the isolated Host executable only for the installed private Kylin manifest.
 * @param executable - Ordinary Electron executable.
 * @param resources - Installed application resource directory.
 * @param manifest - Trusted local packaged manifest.
 * @param platform - Current operating system.
 * @param arch - Current processor architecture.
 * @returns Private Host executable or the unchanged ordinary executable.
 */
export function privateKylinHostExecutable(
  executable: string, resources: string, manifest: unknown, platform: NodeJS.Platform, arch: string,
): string {
  return isPrivateKylinPackage(true, manifest, platform, arch)
    ? join(resources, 'runtime', 'kylin-compat', 'bin', 'node') : executable
}
