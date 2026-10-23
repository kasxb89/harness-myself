/** Dedicated support fields remain live, bounded and separate from login QR settings. */
import { expect, it } from 'vitest'
import { parseCustomerSupport, readCustomerSupport } from '../src/customer-support.ts'

const base = 'https://support.invalid/harness'
const qr = 'https://images.invalid/support.png'
const config = { schema_version: 1, enabled: true, qr_code_url: qr, title: '联系客服', description: '请扫码咨询。' }
const status = (value: unknown) => ({ success: true, data: { customer_service: value, wechat_qrcode: 'must-not-be-used' } })
const empty = { ok: true, payload: { enabled: false, qrCodeUrl: '', title: '', description: '' } }

it('retains only current plain text and the configured QR without reading image resources', () => {
  expect(parseCustomerSupport(status({ ...config, title: '<script>not executable</script>', unrelated: 'secret' }), base))
    .toEqual({ ok: true, payload: { enabled: true, qrCodeUrl: qr, title: '<script>not executable</script>', description: '请扫码咨询。' } })
  expect(parseCustomerSupport(status({ ...config, enabled: false, qr_code_url: 'data:invalid' }), base)).toEqual(empty)
  expect(parseCustomerSupport(status({ ...config, qr_code_url: '' }), base)).toEqual(empty)
  expect(parseCustomerSupport({ success: true, data: { wechat_qrcode: qr } }, base))
    .toEqual({ ok: false, code: 'CUSTOMER_SUPPORT_UNSUPPORTED' })
})

it.each([
  null, {}, { success: false, data: {} }, status(null), status({ ...config, schema_version: 2 }),
  status({ ...config, enabled: 'true' }), status({ ...config, title: 'x'.repeat(65) }),
  status({ ...config, description: 'x'.repeat(257) }), status({ ...config, title: null }),
  status({ ...config, description: undefined }), status({ ...config, qr_code_url: undefined }),
  status({ ...config, title: '客服\n' }), status({ ...config, description: 'one\ttwo' }),
])('rejects invalid enabled support declarations %#', (value) => {
  expect(parseCustomerSupport(value, base)).toEqual({ ok: false, code: 'CUSTOMER_SUPPORT_INVALID' })
})

it('enforces UTF-16 text limits while retaining exact boundary values', () => {
  const title = '😀'.repeat(32)
  const description = '😀'.repeat(128)
  expect(parseCustomerSupport(status({ ...config, title, description }), base))
    .toEqual({ ok: true, payload: { enabled: true, qrCodeUrl: qr, title, description } })
  expect(parseCustomerSupport(status({ ...config, title: title + 'x' }), base)).toEqual({ ok: false, code: 'CUSTOMER_SUPPORT_INVALID' })
})

it.each([
  '//images.invalid/qr.png', '/other/qr.png', './qr.png', 'https://user:password@images.invalid/qr.png',
  'https://@images.invalid/qr.png', 'http://images.invalid/qr.png', 'data:image/png;base64,AAAA',
  'file:///qr.png', 'javascript:alert(1)', ' https://images.invalid/qr.png', 'https://images.invalid/qr.png ',
  'https://images.invalid\\@other.invalid/qr.png', 'https://images.invalid/qr\n.png',
  'https://images.invalid/support.svg', 'https://images.invalid/support.%73vg?raw=1',
  'https://images.invalid/qr%0a.png', 'https://images.invalid/qr%5c.png', 'https://images.invalid/qr%ZZ.png',
  '/api/creation/assets/cc_' + 'a'.repeat(63), '/api/creation/assets/cc_' + 'a'.repeat(64) + '?other=1',
])('rejects an unsafe display URL %s', (qr_code_url) => {
  expect(parseCustomerSupport(status({ ...config, qr_code_url }), base)).toEqual({ ok: false, code: 'CUSTOMER_SUPPORT_INVALID' })
})

it('resolves only dedicated asset paths below the complete deployment prefix', () => {
  const path = '/api/creation/assets/cc_' + 'a'.repeat(64)
  for (const root of [base, 'http://127.0.0.1:12345/harness']) {
    expect(parseCustomerSupport(status({ ...config, qr_code_url: path }), root))
      .toEqual({ ok: true, payload: { enabled: true, qrCodeUrl: root + path, title: config.title, description: config.description } })
  }
})

it('counts URL length in UTF-8 bytes', () => {
  const prefix = 'https://images.invalid/'
  const exact = prefix + 'a'.repeat(2048 - Buffer.byteLength(prefix))
  expect(parseCustomerSupport(status({ ...config, qr_code_url: exact }), base).ok).toBe(true)
  expect(parseCustomerSupport(status({ ...config, qr_code_url: exact.slice(0, -1) + '中' }), base))
    .toEqual({ ok: false, code: 'CUSTOMER_SUPPORT_INVALID' })
})

it.each([[404, 'CUSTOMER_SUPPORT_UNSUPPORTED'], [408, 'CUSTOMER_SUPPORT_UNAVAILABLE'],
  [429, 'CUSTOMER_SUPPORT_UNAVAILABLE'], [503, 'CUSTOMER_SUPPORT_UNAVAILABLE']] as const)(
  'keeps observed HTTP %s separate from an unconfigured QR', async (httpStatus, code) => {
    expect(await readCustomerSupport(async () => new Response('private body', { status: httpStatus }), new AbortController().signal, base))
      .toEqual({ ok: false, code })
  },
)

it('contains transport and body failures without retaining old configuration', async () => {
  const signal = new AbortController().signal
  const read = (response: Response) => readCustomerSupport(async () => response, signal, base)
  expect(await read(Response.json(status(config)))).toMatchObject({ ok: true, payload: { qrCodeUrl: qr } })
  expect(await read(Response.json(status({ ...config, enabled: false })))).toEqual(empty)
  expect(await read(new Response('{broken'))).toEqual({ ok: false, code: 'CUSTOMER_SUPPORT_INVALID' })
  expect(await read(new Response('x'.repeat(1_048_577)))).toEqual({ ok: false, code: 'CUSTOMER_SUPPORT_INVALID' })
  expect(await read(new Response(null))).toEqual({ ok: false, code: 'CUSTOMER_SUPPORT_INVALID' })
  expect(await readCustomerSupport(async () => { throw new TypeError('private network detail') }, signal, base))
    .toEqual({ ok: false, code: 'CUSTOMER_SUPPORT_NETWORK' })
  expect(await read(new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('private body detail')) } }))))
    .toEqual({ ok: false, code: 'CUSTOMER_SUPPORT_NETWORK' })
})

it('classifies deadline expiration during fetch and body reads as timeout', async () => {
  const expired = AbortSignal.abort(new DOMException('deadline', 'TimeoutError'))
  expect(await readCustomerSupport(async () => { throw new Error('must not fetch') }, expired, base))
    .toEqual({ ok: false, code: 'CUSTOMER_SUPPORT_TIMEOUT' })
  const controller = new AbortController()
  const started = Promise.withResolvers<undefined>()
  const reading = readCustomerSupport(async () => new Response(new ReadableStream({
    pull() { started.resolve(undefined) },
  })), controller.signal, base)
  await started.promise
  controller.abort(new DOMException('deadline', 'TimeoutError'))
  expect(await reading).toEqual({ ok: false, code: 'CUSTOMER_SUPPORT_TIMEOUT' })
})
