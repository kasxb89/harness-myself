/** Phone failure decoding keeps transport diagnostics out of product errors. */
import { expect, it } from 'vitest'
import { phoneFailure, phoneRetryAfter, readPhoneBody } from '../src/phone-auth.ts'

it('keeps empty and malformed 429 responses rate limited with the longest supplied delay', async () => {
  const empty = new Response('', { status: 429, headers: { 'retry-after': '17' } })
  expect(phoneFailure(empty, await readPhoneBody(empty), 'challenge')).toMatchObject({
    ok: false, code: 'PHONE_RATE_LIMITED', retryAfterSeconds: 17,
  })
  const malformed = new Response('<private diagnostic>', { status: 429 })
  expect(phoneFailure(malformed, await readPhoneBody(malformed), 'login')).toMatchObject({
    code: 'PHONE_RATE_LIMITED', retryAfterSeconds: 60,
  })
  const response = new Response('', { headers: { 'retry-after': '17' } })
  expect(phoneRetryAfter(response, { retry_after_seconds: 19.2 })).toBe(20)
})

it('supports HTTP-date Retry-After without shortening the delay', () => {
  const now = Date.UTC(2026, 9, 21, 10, 0, 0, 500)
  const response = new Response('', { headers: { 'retry-after': 'Wed, 21 Oct 2026 10:00:04 GMT' } })
  expect(phoneRetryAfter(response, {}, now)).toBe(4)
  expect(phoneRetryAfter(null, { retry_after_seconds: -1 }, now)).toBeNull()
  expect(phoneRetryAfter(new Response('', { headers: { 'retry-after': 'invalid' } }), {}, now)).toBeNull()
})

it.each(['', 'null', '[]', '<private provider exception>', '{"message":"secret","success":false}'])(
  'never reports a service failure as an invalid code for body %s', async (text) => {
    const response = new Response(text, { status: 503 })
    const result = phoneFailure(response, await readPhoneBody(response), 'login')
    expect(result.code).toBe('PHONE_LOGIN_UNAVAILABLE')
    expect(result.message).not.toMatch(/secret|provider|验证码错误|过期/)
  },
)

it('contains transport and response-body read failures', async () => {
  expect(await readPhoneBody(null)).toEqual({})
  const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('private network path')) } }))
  expect(await readPhoneBody(response)).toEqual({})
  expect(phoneFailure(null, {}, 'challenge')).toMatchObject({ code: 'PHONE_DELIVERY_UNKNOWN' })
})

it('requires delivery evidence before reporting an unavailable challenge as not sent', () => {
  const response = new Response('', { status: 503 })
  for (const data of [undefined, { delivery_status: 'unknown' }]) {
    const body = { code: 'PHONE_CHALLENGE_UNAVAILABLE', ...data === undefined ? {} : { data } }
    const result = phoneFailure(response, body, 'challenge')
    expect(result.code).toBe('PHONE_CHALLENGE_UNAVAILABLE')
    expect(result.message).toContain('发送结果尚未确认')
    expect(result.message).not.toContain('未发送')
  }
  expect(phoneFailure(response, { code: 'PHONE_CHALLENGE_UNAVAILABLE', data: { delivery_status: 'not_sent' } }, 'challenge')
    .message).toContain('本次未发送')
  expect(phoneFailure(response, { code: 'PHONE_CHALLENGE_CONSUMED' }, 'login').message)
    .toBe('此登录已失效，请重新获取验证码。')
})
