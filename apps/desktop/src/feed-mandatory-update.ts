/** A confirmed newer release requires updating, including after restarting offline. */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gt, valid } from 'semver'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { DesktopUpdateState } from './ipc.ts'
import type { DesktopPolicyState } from './mandatory-update-policy.ts'

/** Installed application facts; neither a renderer nor feed supplies these fields. */
export interface FeedMandatoryUpdateIdentity {
  readonly authority: string
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly version: string
}

/** Remembers only versions the coordinator accepted from the trusted target feed. */
export class DesktopFeedMandatoryUpdate {
  private required: string | undefined
  private readonly key: string
  private readonly path: string
  private writing = Promise.resolve()
  private disposed = false

  /**
   * @param userData - Electron-owned data directory retained by application updates.
   * @param identity - Packaged authority, target and actual installed application version.
   * @param report - Reports local cache errors without clearing an established requirement.
   */
  constructor(userData: string, private readonly identity: FeedMandatoryUpdateIdentity,
    private readonly report: (error: unknown) => void) {
    if (valid(identity.version) === null) throw new Error('desktop update: invalid installed version')
    this.key = createHash('sha256').update(JSON.stringify([identity.authority.replace(/\/$/u, ''), identity.platform, identity.arch])).digest('hex')
    this.path = join(userData, 'desktop', `required-update-${this.key}.json`)
    try {
      if (statSync(this.path).size > 4096) throw new Error('desktop update: oversized required-version record')
      const value: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (typeof value !== 'object' || value === null || !('schemaVersion' in value) || value.schemaVersion !== 1
        || !('authorityTarget' in value) || value.authorityTarget !== this.key
        || !('version' in value) || typeof value.version !== 'string' || valid(value.version) === null) {
        throw new Error('desktop update: invalid required-version record')
      }
      if (gt(value.version, identity.version)) this.required = value.version
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report(error)
    }
  }

  /** Highest confirmed version newer than this installation, retained through check and download failures. */
  get version(): string | undefined { return this.required }

  /** Existing mandatory presentation receives no executable URL or remote message. */
  get state(): DesktopPolicyState { return { blocking: this.required !== undefined, checking: false } }

  /**
   * Retain a newer available target; every other coordinator state leaves the requirement unchanged.
   * @param state - Main-process coordinator output after feed and installed-version validation.
   */
  observe(state: DesktopUpdateState): void {
    if (this.disposed || state.phase !== 'available' || state.version === undefined || !gt(state.version, this.identity.version)
      || (this.required !== undefined && !gt(state.version, this.required))) return
    this.required = state.version
    const record = JSON.stringify({ schemaVersion: 1, authorityTarget: this.key, version: state.version }) + '\n'
    this.writing = this.writing.then(() => writeFileAtomic(this.path, record, { mode: 0o600, dirMode: 0o700 }))
      .catch(this.report)
  }

  /** Await confirmed-version persistence before handing off an installer. */
  async flush(): Promise<void> { await this.writing }

  /** Stop accepting late coordinator events and await owned cache writes during shutdown. */
  async dispose(): Promise<void> { this.disposed = true; await this.writing }
}
