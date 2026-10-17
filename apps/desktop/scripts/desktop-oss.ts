/** Single-attempt ossutil v2 operations using an explicit local credential file. */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const METADATA_LIMIT = 512 * 1024
const TRANSFER_DEADLINE_MS = 900_000
const SAFE_ENVIRONMENT = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR'])

/** Nonsecret local settings for the OSS release command. */
export interface DesktopOssSettings {
  readonly region: string
  readonly executable: string
  readonly configFile: string
}

/** One file-backed PUT; replacing a channel manifest requires explicit permission. */
export interface DesktopOssPut {
  readonly bucket: string
  readonly key: string
  readonly path: string
  readonly contentType: string
  readonly overwrite: boolean
  readonly cacheControl?: string
}

/** Authenticated OSS operations; responses and raw CLI errors never enter release records. */
export interface DesktopOss {
  /**
   * Reject bucket versioning, which disables OSS's per-request overwrite protection.
   * @param bucket Release bucket.
   * @returns Resolves when the bucket has never enabled versioning.
   */
  assertUnversioned(bucket: string): Promise<void>
  /**
   * Reject an existing package before the release starts writing objects.
   * @param bucket Release bucket.
   * @param key Immutable package key.
   * @returns Resolves only after an explicit NoSuchKey response.
   */
  assertObjectAbsent(bucket: string, key: string): Promise<void>
  /**
   * Read small channel metadata; only an explicit NoSuchKey response means absent.
   * @param bucket Release bucket.
   * @param key Channel metadata or publication-lock key.
   * @returns Exact UTF-8 bytes, or undefined when the object is absent.
   */
  readMetadata(bucket: string, key: string): Promise<string | undefined>
  /**
   * Upload once, prohibiting replacement unless explicitly requested for a manifest.
   * @param object File-backed object and write policy.
   * @returns Resolves after the single PUT succeeds.
   */
  putObject(object: DesktopOssPut): Promise<void>
  /**
   * Delete the caller-owned publication lock after its nonce has been checked.
   * @param bucket Release bucket.
   * @param key Verified caller-owned lock key.
   * @returns Resolves after the single DELETE succeeds.
   */
  deleteObject(bucket: string, key: string): Promise<void>
}

function commandEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => SAFE_ENVIRONMENT.has(name.toUpperCase())))
}

function missingObject(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'stderr' in error && typeof error.stderr === 'string'
    && /^Error Code: NoSuchKey\.\s*$/mu.test(error.stderr)
}

/**
 * Create a single-attempt OSS transport without reading credential values into Node.
 * @param settings Local ossutil v2 executable, region, and credential-file path.
 * @returns An authenticated transport with suppressed raw CLI diagnostics.
 */
export function createDesktopOss(settings: DesktopOssSettings): DesktopOss {
  async function run(args: readonly string[], allowMissing = false): Promise<string | undefined> {
    try {
      const result = await runFile(settings.executable, [...args,
        '--config-file', settings.configFile, '--region', settings.region,
        '--endpoint', `https://oss-${settings.region}.aliyuncs.com`, '--mode', 'AK', '--ignore-env-var',
        '--retry-times', '0', '--connect-timeout', '15', '--read-timeout', '900',
        '--loglevel', 'off', '--quiet', '--language', 'en'], {
        env: commandEnvironment(), encoding: 'utf8', maxBuffer: METADATA_LIMIT,
        timeout: TRANSFER_DEADLINE_MS, killSignal: 'SIGKILL', windowsHide: true,
      })
      return result.stdout
    }
    catch (error) {
      if (allowMissing && missingObject(error)) return undefined
      throw new Error('desktop upload: ossutil failed; retain the release record and reconcile remote state before retrying')
    }
  }
  return {
    async assertUnversioned(bucket) {
      const output = await run(['api', 'get-bucket-versioning', '--bucket', bucket, '--output-format', 'json'])
      let value: unknown
      try { value = JSON.parse(output!) }
      catch (error) { throw new Error('desktop upload: cannot read OSS bucket versioning status', { cause: error }) }
      if (typeof value !== 'object' || value === null || Array.isArray(value)
        || Object.keys(value).some(name => name !== 'Status' && name !== '+@xmlns')
        || ('+@xmlns' in value && value['+@xmlns'] !== 'http://doc.oss-cn-hangzhou.aliyuncs.com')
        || ('Status' in value && value.Status !== '' && value.Status !== undefined)) {
        throw new Error('desktop upload: OSS release uploads require a bucket that has never enabled versioning')
      }
    },
    async readMetadata(bucket, key) {
      return run(['cat', `oss://${bucket}/${key}`], true)
    },
    async assertObjectAbsent(bucket, key) {
      if (await run(['api', 'head-object', '--bucket', bucket, '--key', key, '--output-format', 'json'], true) !== undefined) {
        throw new Error('desktop upload: OSS package already exists; use a greater release version')
      }
    },
    async putObject(object) {
      await run(['api', 'put-object', '--bucket', object.bucket, '--key', object.key,
        '--body', `file://${object.path}`, '--content-type', object.contentType,
        `--forbid-overwrite=${String(!object.overwrite)}`,
        ...object.cacheControl === undefined ? [] : ['--cache-control', object.cacheControl]])
    },
    async deleteObject(bucket, key) {
      await run(['api', 'delete-object', '--bucket', bucket, '--key', key])
    },
  }
}

/**
 * Verify every public byte, refusing redirects, cacheable manifests, and size or SHA-512 mismatches.
 * @param url Public custom-domain object URL.
 * @param expected Locally computed object size and SHA-512, with manifest cache policy when applicable.
 * @returns Resolves only after the complete response matches the local object.
 */
export async function verifyDesktopOssPublicObject(
  url: string, expected: { size: number; sha512: string; noStore?: boolean },
): Promise<void> {
  const response = await fetch(url, { redirect: 'error', cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(TRANSFER_DEADLINE_MS) })
  try {
    if (response.status !== 200 || response.body === null) throw new Error('desktop upload: public OSS object is unavailable')
    if (expected.noStore === true && !/(?:^|,)\s*no-store\s*(?:,|$)/iu.test(response.headers.get('cache-control') ?? '')) {
      throw new Error('desktop upload: public OSS manifest is missing Cache-Control: no-store')
    }
    const hash = createHash('sha512')
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > expected.size) throw new Error('desktop upload: public OSS object exceeds the expected size')
      hash.update(chunk)
    }
    if (size !== expected.size || hash.digest('base64') !== expected.sha512) {
      throw new Error('desktop upload: public OSS object size or SHA-512 differs from the local artifact')
    }
  }
  finally {
    if (response.body !== null && !response.body.locked) await response.body.cancel()
  }
}
