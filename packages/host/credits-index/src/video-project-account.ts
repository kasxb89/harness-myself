/** Bind video billing to one live product login without exposing its credentials. @module */
import { createHash } from 'node:crypto'
import { VideoProjectError } from './video-project.ts'
import type { VideoProjectIdentity } from './video-project-types.ts'

/** Host-only live session projection; never written into a project record. */
export interface LiveVideoAccount {
  accountId: string
  token: string
  key: string
}

/** Captured login identity with an ephemeral, freshly checked relay credential. */
export interface VideoAccountBinding {
  readonly identity: VideoProjectIdentity
  /** @returns Current relay key, after checking the original account and login. */
  key(): Promise<string>
}

/**
 * Capture one valid product login and recheck it immediately before each relay operation.
 * @param read - Returns only an unexpired, signed-in product account with its own relay key.
 * @returns Non-secret identity and an ephemeral current-key resolver.
 */
export async function bindVideoAccount(read: () => Promise<LiveVideoAccount | undefined>): Promise<VideoAccountBinding> {
  const initial = await read()
  if (initial === undefined || initial.token === '' || initial.key === '') {
    throw new VideoProjectError('VIDEO_ACCOUNT_REQUIRED', '请先在余额页完成手机号登录，再创建视频')
  }
  const fingerprint = (token: string): string => createHash('sha256').update(token).digest('hex')
  const identity = { accountId: initial.accountId, sessionFingerprint: fingerprint(initial.token) }
  return {
    identity,
    async key(): Promise<string> {
      const current = await read()
      if (current === undefined || current.key === '' || current.accountId !== identity.accountId
        || fingerprint(current.token) !== identity.sessionFingerprint) {
        throw new VideoProjectError('VIDEO_ACCOUNT_CHANGED', '登录状态已变化，已停止后续生成；请在原账户登录后查看项目并决定是否继续')
      }
      return current.key
    },
  }
}
