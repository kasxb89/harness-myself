/** Bind ordinary AI creation requests to the exact retained chat, never a guessed latest project. @module */
import { isAbsolute } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-client-connection'
import { CreativeError, type CreativeOwner } from './creative-store.ts'
import type { VideoProjectIdentity } from './video-project-types.ts'

/**
 * Resolve a panel's explicitly selected live chat before any possible media charge.
 * @param ctx - Real Host connection and Session services.
 * @param request - Authenticated browser request.
 * @param body - Untrusted generation input; older clients may omit both association fields.
 * @param identity - Captured live product login.
 * @returns Exact owner, or undefined for the existing unassociated legacy contract.
 */
export function creativePanelOwner(
  ctx: Context, request: IncomingMessage, body: Record<string, unknown>, identity: VideoProjectIdentity,
): CreativeOwner | undefined {
  if (body.session_id === undefined && body.account_id === undefined) return undefined
  const rejected = ctx.get('connection')?.requestRejection(request)
  if (ctx.get('connection') === undefined || rejected !== undefined) throw new CreativeError('CREATIVE_HOST_AUTH_REQUIRED', rejected ?? 403, '请从已连接的云枢客户端开始创作。')
  if (body.account_id !== identity.accountId) throw new CreativeError('CREATIVE_ACCOUNT_CHANGED', 409, '登录已变化，请刷新当前账号后重试；尚未提交生成。')
  if (typeof body.session_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(body.session_id)) throw new CreativeError('CREATIVE_SESSION_INVALID', 400, '请先选择工作区聊天，再开始创作。')
  const session = ctx.get('sessions')?.get(SessionId(body.session_id))
  const workspaceRoot = session?.header.cwd
  if (workspaceRoot === undefined || !isAbsolute(workspaceRoot)) throw new CreativeError('CREATIVE_WORKSPACE_REQUIRED', 409, '所选聊天尚未连接工作区，请打开该聊天后重试；尚未提交生成。')
  return { ...identity, sessionId: body.session_id, workspaceRoot }
}
