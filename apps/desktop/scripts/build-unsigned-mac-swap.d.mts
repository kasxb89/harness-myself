/**
 * Compile and ad-hoc sign the standalone atomic app exchange primitive before outer app signing.
 * @param resourcesDirectory - Assembled Contents/Resources directory.
 * @param architecture - Exact electron-builder target architecture.
 * @returns Verified native helper binary path.
 */
export function buildUnsignedMacSwap(resourcesDirectory: string, architecture: string): Promise<string>
