/** Private durable request identities for SMS dispatch and phone-session redemption. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writePrivateState } from './private-state-file.ts'

/** Provider acceptance observed for one SMS request. */
export type PhoneDeliveryStatus = 'sending' | 'unknown' | 'accepted' | 'not_sent'

interface Challenge {
  readonly phone: string
  readonly key: string
  readonly createdAt: number
  readonly challengeId?: string
  readonly deliveryStatus: PhoneDeliveryStatus
  readonly expiresAt?: string
  readonly resendAt?: number
}

interface Exchange {
  readonly phone: string
  readonly challengeId: string
  readonly key: string
  readonly fingerprint: string
  readonly createdAt: number
  readonly challengeExpiresAt?: string
  readonly completed?: boolean
  readonly retryAt?: number
  readonly securityPending?: boolean
}

interface State {
  readonly schema: 1
  readonly backendBaseUrl: string
  challenges: Challenge[]
  exchanges: Exchange[]
}

/** Non-secret fields needed to resume the latest manual login attempt. */
export interface PhoneRecovery {
  readonly phone: string
  readonly challengeKey: string | null
  readonly challengeId: string | null
  readonly deliveryStatus: PhoneDeliveryStatus
  readonly expiresAt: string | null
  readonly resendAt: number
  readonly exchangeKey: string | null
  readonly verifyRetryAt: number
  readonly securityUnconfirmed: boolean
}

/** A failed local reservation never authorizes an upstream request. */
export type PhoneReservation = 'reserved' | 'conflict' | 'unavailable'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function delivery(value: unknown): value is PhoneDeliveryStatus {
  return value === 'sending' || value === 'unknown' || value === 'accepted' || value === 'not_sent'
}

function challenge(value: unknown): value is Challenge {
  const item = record(value)
  return item !== null && typeof item.phone === 'string' && typeof item.key === 'string'
    && typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) && delivery(item.deliveryStatus)
    && (item.challengeId === undefined || typeof item.challengeId === 'string')
    && (item.expiresAt === undefined || typeof item.expiresAt === 'string')
    && (item.resendAt === undefined || typeof item.resendAt === 'number' && Number.isFinite(item.resendAt))
}

function exchange(value: unknown): value is Exchange {
  const item = record(value)
  return item !== null && typeof item.phone === 'string' && typeof item.challengeId === 'string'
    && typeof item.key === 'string' && typeof item.fingerprint === 'string'
    && typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)
    && (item.challengeExpiresAt === undefined || typeof item.challengeExpiresAt === 'string')
    && (item.completed === undefined || typeof item.completed === 'boolean')
    && (item.securityPending === undefined || typeof item.securityPending === 'boolean')
    && (item.retryAt === undefined || typeof item.retryAt === 'number' && Number.isFinite(item.retryAt))
}

/**
 * Serialize and atomically persist phone request keys before upstream dispatch.
 * Codes, cookies, access tokens and relay credentials never enter this file.
 */
export class PhoneAuthState {
  private pending: Promise<unknown> = Promise.resolve()

  /**
   * @param file - Private recovery file.
   * @param backendBaseUrl - Bound authentication service.
   */
  constructor(private readonly file: string, private readonly backendBaseUrl: string) {}

  private async read(): Promise<State> {
    let text: string
    try { text = await readFile(this.file, 'utf8') } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return { schema: 1, backendBaseUrl: this.backendBaseUrl, challenges: [], exchanges: [] }
      }
      throw error
    }
    const parsed: unknown = JSON.parse(text)
    const state = record(parsed)
    if (state?.schema !== 1 || state.backendBaseUrl !== this.backendBaseUrl || !Array.isArray(state.challenges)
      || !state.challenges.every(challenge) || !Array.isArray(state.exchanges) || !state.exchanges.every(exchange)) {
      throw new Error('phone recovery unavailable')
    }
    const storedChallenges = state.challenges
    const storedExchanges = state.exchanges
    const challenges = storedChallenges.filter(item => item.expiresAt === undefined || !Number.isFinite(Date.parse(item.expiresAt))
      || Date.parse(item.expiresAt) > Date.now())
    const expiredIds = new Set(storedChallenges.filter(item => !challenges.includes(item)).map(item => item.challengeId))
    return { schema: 1, backendBaseUrl: this.backendBaseUrl, challenges,
      // OTP expiry cannot settle an exchange whose successful response may have been lost.
      // Keep its original key and phone binding until completion is confirmed; the API owns replay expiry.
      exchanges: storedExchanges.filter(item => !expiredIds.has(item.challengeId) || item.completed !== true).map((item) => {
        const expiresAt = item.challengeExpiresAt ?? storedChallenges.find(value => value.challengeId === item.challengeId
          && value.phone === item.phone)?.expiresAt
        return expiresAt === undefined ? item : { ...item, challengeExpiresAt: expiresAt }
      }) }
  }

  private async write(state: State): Promise<void> {
    await writePrivateState(this.file, JSON.stringify(state) + '\n')
  }

  private async serial<T>(operation: (state: State) => T | Promise<T>): Promise<T> {
    const result = this.pending.then(async () => await operation(await this.read()))
    this.pending = result.catch(() => undefined)
    return await result
  }

  /**
   * Persist one dispatch identity before its first request; retries retain that identity.
   * @param phone - Verified-format phone supplied to the API.
   * @param key - Client-generated random request key.
   * @returns whether dispatch may proceed, or why it must stop.
   */
  async reserveChallenge(phone: string, key: string): Promise<PhoneReservation> {
    try {
      return await this.serial(async (state) => {
        if (state.exchanges.some(item => item.key === key)) return 'conflict'
        const previous = state.challenges.find(item => item.key === key)
        if (previous !== undefined) return previous.phone === phone ? 'reserved' : 'conflict'
        state.challenges.push({ phone, key, createdAt: Date.now(), deliveryStatus: 'sending' })
        await this.write(state)
        return 'reserved'
      })
    } catch (_unavailableRecovery: unknown) { return 'unavailable' }
  }

  /**
   * Retain the latest provider status without repeating dispatch.
   * @param key - Existing dispatch key.
   * @param update - Non-secret API delivery fields.
   * @returns whether the status was persisted.
   */
  async updateChallenge(key: string, update: {
    challengeId?: string
    deliveryStatus: PhoneDeliveryStatus
    expiresAt?: string
    resendAt?: number
  }): Promise<boolean> {
    try {
      return await this.serial(async (state) => {
        state.challenges = state.challenges.map(item => item.key === key ? { ...item, ...update } : item)
        await this.write(state)
        return true
      })
    } catch (_unavailableRecovery: unknown) { return false }
  }

  /**
   * Resolve an opaque challenge through its dispatch or an unconfirmed exchange after OTP expiry.
   * @param challengeId - Identifier returned by the API.
   * @returns its phone, or null when neither durable record binds it.
   */
  async phone(challengeId: string): Promise<string | null> {
    return await this.serial(state => state.challenges.find(item => item.challengeId === challengeId)?.phone
      ?? state.exchanges.findLast(item => item.challengeId === challengeId && item.completed !== true)?.phone ?? null)
  }

  /**
   * Persist the redemption identity and bind it to the exact entered code without storing the code.
   * @param phone - Phone bound to the challenge.
   * @param challengeId - API challenge identifier.
   * @param code - Code used only for a parameter fingerprint.
   * @param key - Independent random redemption key.
   * @returns whether redemption may proceed, or why it must stop.
   */
  async reserveExchange(phone: string, challengeId: string, code: string, key: string): Promise<PhoneReservation> {
    const fingerprint = createHash('sha256').update(JSON.stringify([phone, challengeId, code])).digest('hex')
    try {
      return await this.serial(async (state) => {
        if (state.challenges.some(item => item.key === key)) return 'conflict'
        const previous = state.exchanges.find(item => item.key === key)
        if (previous !== undefined) return previous.fingerprint === fingerprint ? 'reserved' : 'conflict'
        const challengeExpiresAt = state.challenges.find(item => item.phone === phone && item.challengeId === challengeId)?.expiresAt
        state.exchanges.push({ phone, challengeId, key, fingerprint, createdAt: Date.now(),
          ...challengeExpiresAt === undefined ? {} : { challengeExpiresAt } })
        await this.write(state)
        return 'reserved'
      })
    } catch (_unavailableRecovery: unknown) { return 'unavailable' }
  }

  /**
   * Persist an exchange cooldown so remounting cannot shorten it.
   * @param key - Existing redemption key.
   * @param retryAt - Earliest retry time in Unix milliseconds.
   * @returns whether the delay was persisted.
   */
  async delayExchange(key: string, retryAt: number): Promise<boolean> {
    try {
      return await this.serial(async (state) => {
        state.exchanges = state.exchanges.map(item => item.key === key ? { ...item, retryAt } : item)
        await this.write(state)
        return true
      })
    } catch (_unavailableRecovery: unknown) { return false }
  }

  /**
   * Read whether a security submission may already have committed.
   * @param key - Redemption key owning the security flow.
   * @returns whether replay must stop until fresh phone authentication.
   */
  async securityPending(key: string): Promise<boolean> {
    return await this.serial(state => state.exchanges.find(item => item.key === key)?.securityPending === true)
  }

  /**
   * Persist uncertainty before a non-idempotent security request and clear only after definite rejection.
   * @param key - Redemption key owning the security flow.
   * @param pending - Whether acceptance remains possible.
   * @returns whether the state was persisted.
   */
  async markSecurity(key: string, pending: boolean): Promise<boolean> {
    try {
      return await this.serial(async (state) => {
        state.exchanges = state.exchanges.map(item => item.key === key ? { ...item, securityPending: pending } : item)
        await this.write(state)
        return true
      })
    } catch (_unavailableRecovery: unknown) { return false }
  }

  /**
   * Mark an exchange completed only after the complete local session is saved.
   * @param key - Successfully redeemed request key.
   * @returns whether completion was persisted.
   */
  async complete(key: string): Promise<boolean> {
    try {
      return await this.serial(async (state) => {
        state.exchanges = state.exchanges.map(item => item.key === key ? { ...item, completed: true, securityPending: false } : item)
        await this.write(state)
        return true
      })
    } catch (_unavailableRecovery: unknown) { return false }
  }

  /**
   * Read the newest manual attempt for a form remount, without dispatching a request.
   * Unconfirmed exchanges retain their original submission time and key independently of OTP expiry,
   * including the API's five-minute successful-exchange replay period. Retention does not extend OTP validity.
   * @returns fields needed for manual recovery, or null after a completed exchange.
   */
  async recovery(): Promise<PhoneRecovery | null> {
    return await this.serial((state) => {
      const latest = state.challenges.at(-1)
      const redemption = state.exchanges.at(-1)
      if (redemption?.completed === true && (latest === undefined || redemption.createdAt >= latest.createdAt)) return null
      if (latest === undefined) return redemption === undefined ? null : {
        phone: redemption.phone, challengeKey: null, challengeId: redemption.challengeId,
        deliveryStatus: 'unknown', expiresAt: redemption.challengeExpiresAt ?? null, resendAt: 0, exchangeKey: redemption.key, verifyRetryAt: redemption.retryAt ?? 0, securityUnconfirmed: redemption.securityPending === true,
      }
      const matching = state.exchanges.findLast(item => item.phone === latest.phone && item.challengeId === latest.challengeId)
      return { phone: latest.phone, challengeKey: latest.deliveryStatus === 'accepted' || latest.deliveryStatus === 'not_sent' ? null : latest.key, challengeId: latest.challengeId ?? null,
        deliveryStatus: latest.deliveryStatus, expiresAt: latest.expiresAt ?? null,
        resendAt: latest.resendAt ?? 0, exchangeKey: matching?.completed === true ? null : matching?.key ?? null,
        verifyRetryAt: matching?.retryAt ?? 0, securityUnconfirmed: matching?.securityPending === true }
    })
  }
}
