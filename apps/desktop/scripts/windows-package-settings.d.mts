/**
 * Validate file-owned Windows tarball and signature-cache worker limits before packaging starts.
 * @param environment Windows packaging settings loaded from .env.windows.
 * @returns Worker limits from one to eight, each defaulting to four; invalid values throw.
 */
export function resolveWindowsPackageSettings(environment: NodeJS.ProcessEnv): { signatureCacheConcurrency: number; packConcurrency: number }
