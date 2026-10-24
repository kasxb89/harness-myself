/** Session Controller dependency for preset composition fixtures that do not send peer messages. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'

type PeerController = Pick<SessionController,
  'peerToolCallSeq' | 'listPeerSessions' | 'readPeerSession' | 'confirmPeerSession' | 'sendPeerMessage'>

/**
 * Register the peer-method dependency without granting a relay submission or faking delivery.
 * @param ctx - Fixture Host that owns the mock service registration.
 */
export function provideSessionRelayFixture(ctx: Context): void {
  const unexpected = (): never => { throw new Error('This preset fixture does not execute peer-session operations') }
  const controller: PeerController = {
    peerToolCallSeq: () => undefined,
    listPeerSessions: unexpected,
    readPeerSession: unexpected,
    confirmPeerSession: unexpected,
    sendPeerMessage: unexpected,
  }
  ctx.provide('sessionController', controller)
}
