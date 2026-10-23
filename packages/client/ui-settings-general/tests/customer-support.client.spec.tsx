// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { CustomerSupport, type CustomerSupportProps } from '../src/client/CustomerSupport.tsx'
import { readCustomerSupport, type CustomerSupportRead } from '../src/client/customer-support-reader.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const unused = (() => { throw new Error('unused standard hook') }) as never
const kit = { useSessions: unused, useSessionStatus: unused, usePanelInfo: unused, useSessionRetainInfo: unused,
  useResource: unused as GlobalStandardProps['useResource'], useWorkspaces: unused }
const details = { enabled: true, qrCodeUrl: 'https://support.example.com/qr.png', title: '<b>Support</b>', description: '<script>window.fixture=1</script>' }
const success: CustomerSupportRead = { ok: true, payload: details }
const empty: CustomerSupportRead = { ok: true, payload: { enabled: false, qrCodeUrl: '', title: '', description: '' } }

function mount(read: CustomerSupportProps['readCustomerSupport'], wide = true, chinese = false) {
  const props: CustomerSupportProps = { ...kit, wide, t: makeTranslate(chinese ? zh : en), readCustomerSupport: read }
  return { view: render(<CustomerSupport {...props} />), props }
}

it('reads on demand from the rail, presents remote HTML as text and restores focus after Escape', async () => {
  const read = vi.fn(async () => success)
  mount(read, false)
  expect(read).not.toHaveBeenCalled()
  const trigger = screen.getByRole('button', { name: 'Support' })
  trigger.focus()
  fireEvent.focus(trigger)
  expect(await screen.findByRole('tooltip')).toBeTruthy()
  fireEvent.click(trigger)
  const dialog = await screen.findByRole('dialog', { name: details.title })
  expect(screen.getByText(details.description)).toBeTruthy()
  expect(dialog.querySelector('b,script,a')).toBeNull()
  const image = screen.getByAltText('Support QR code')
  expect(image.getAttribute('src')).toBe(details.qrCodeUrl)
  expect(image.getAttribute('referrerpolicy')).toBe('no-referrer')
  expect(screen.getByRole('status').getAttribute('aria-label')).toBe(en['customerSupport.imageLoading'])
  fireEvent.load(image)
  expect(screen.queryByRole('status')).toBeNull()
  expect(read).toHaveBeenCalledOnce()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('aborts closed reads, reads again on reopening and ignores a late answer owned by the closed dialog', async () => {
  const old = Promise.withResolvers<CustomerSupportRead>()
  const read = vi.fn<CustomerSupportProps['readCustomerSupport']>().mockReturnValueOnce(old.promise).mockResolvedValueOnce(empty)
  mount(read)
  fireEvent.click(screen.getByRole('button', { name: 'Support' }))
  expect(screen.getByRole('status').getAttribute('aria-label')).toBe(en['customerSupport.loading'])
  expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(read.mock.calls[0]?.[0].aborted).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Support' }))
  await screen.findByText(en['customerSupport.unconfigured'])
  await act(async () => { old.resolve(success) })
  expect(screen.queryByAltText('Support QR code')).toBeNull()
  expect(read).toHaveBeenCalledTimes(2)
})

it('discards a previously displayed QR during refresh and applies disabled settings without showing it', async () => {
  const pending = Promise.withResolvers<CustomerSupportRead>()
  const read = vi.fn<CustomerSupportProps['readCustomerSupport']>().mockResolvedValueOnce(success).mockReturnValueOnce(pending.promise)
  mount(read)
  fireEvent.click(screen.getByRole('button', { name: 'Support' }))
  await screen.findByAltText('Support QR code')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(screen.queryByAltText('Support QR code')).toBeNull()
  expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(true)
  await act(async () => { pending.resolve(empty) })
  expect(screen.getByText(en['customerSupport.unconfigured'])).toBeTruthy()
  expect(screen.queryByAltText('Support QR code')).toBeNull()
})

it('re-reads settings when an image fails, removing the failed image and using the replacement QR', async () => {
  const read = vi.fn<CustomerSupportProps['readCustomerSupport']>().mockResolvedValueOnce(success)
    .mockResolvedValueOnce({ ok: true, payload: { ...details, qrCodeUrl: 'https://support.example.com/new-qr.png' } })
  mount(read)
  fireEvent.click(screen.getByRole('button', { name: 'Support' }))
  fireEvent.error(await screen.findByAltText('Support QR code'))
  expect(screen.getByRole('alert').textContent).toBe(en['customerSupport.imageFailed'])
  expect(screen.queryByAltText('Support QR code')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  const image = await screen.findByAltText('Support QR code')
  expect(image.getAttribute('src')).toBe('https://support.example.com/new-qr.png')
  fireEvent.load(image)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(read).toHaveBeenCalledTimes(2)
})

it.each(['network', 'timeout', 'unavailable', 'invalid', 'authorization', 'account-changed'] as const)(
  'shows localized %s guidance and retries without retaining an earlier QR', async (reason) => {
    const read = vi.fn<CustomerSupportProps['readCustomerSupport']>().mockResolvedValueOnce(success)
      .mockResolvedValueOnce({ ok: false, reason }).mockResolvedValueOnce(empty)
    mount(read)
    fireEvent.click(screen.getByRole('button', { name: 'Support' }))
    await screen.findByAltText('Support QR code')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByAltText('Support QR code')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(en['customerSupport.unconfigured'])).toBeTruthy()
  },
)

it('treats an unsupported service as unconfigured and closes through the modal mask', async () => {
  mount(async () => ({ ok: false, reason: 'unsupported' }))
  fireEvent.click(screen.getByRole('button', { name: 'Support' }))
  await screen.findByText(en['customerSupport.unconfigured'])
  expect(screen.queryByRole('alert')).toBeNull()
  const mask = screen.getByRole('dialog').parentElement?.querySelector('[aria-hidden="true"]')
  if (mask === null || mask === undefined) throw new Error('expected modal mask')
  fireEvent.click(mask)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps the close action alongside an unbroken configured title and scopes its wrapping to this dialog', async () => {
  const title = 'W'.repeat(64)
  mount(async () => ({ ok: true, payload: { ...details, title } }))
  fireEvent.click(screen.getByRole('button', { name: 'Support' }))
  const dialog = await screen.findByRole('dialog', { name: title })
  expect(dialog.querySelector('h2')?.textContent).toBe(title)
  const stylesheet = readFileSync(resolve(import.meta.dirname, '../src/client/CustomerSupport.module.css'), 'utf8')
  expect(stylesheet).toMatch(/\.dialog h2\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/u)
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each([false, true])('records locale-owned default support content (Chinese: %s)', async (chinese) => {
  const dictionary = chinese ? zh : en
  const read = vi.fn<CustomerSupportProps['readCustomerSupport']>().mockResolvedValueOnce({ ok: true, payload: { ...details, title: '', description: '' } })
    .mockResolvedValueOnce(empty)
  mount(read, true, chinese)
  fireEvent.click(screen.getByRole('button', { name: dictionary['customerSupport.title'] }))
  await screen.findByAltText(dictionary['customerSupport.qrAlt'])
  const visible = { title: screen.getByRole('dialog').getAttribute('aria-label'), description: screen.getByText(dictionary['customerSupport.description']).textContent,
    imageLoading: screen.getByRole('status').getAttribute('aria-label'), alt: screen.getByAltText(dictionary['customerSupport.qrAlt']).getAttribute('alt') }
  fireEvent.error(screen.getByAltText(dictionary['customerSupport.qrAlt']))
  const imageFailed = screen.getByRole('alert').textContent
  fireEvent.click(screen.getByRole('button', { name: dictionary['customerSupport.retry'] }))
  await screen.findByText(dictionary['customerSupport.unconfigured'])
  expect({ ...visible, imageFailed, unconfigured: screen.getByText(dictionary['customerSupport.unconfigured']).textContent }).toMatchSnapshot()
})

it('reads only the local Host route with safe classifications and no raw diagnostic messages', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(success))
  vi.stubGlobal('fetch', fetcher)
  const signal = new AbortController().signal
  expect(await readCustomerSupport(signal)).toEqual(success)
  expect(fetcher).toHaveBeenCalledWith('/credits/api/customer-support', expect.objectContaining({ cache: 'no-store', headers: { accept: 'application/json' } }))
  for (const [status, reason] of [[404, 'unsupported'], [401, 'authorization'], [403, 'authorization'], [408, 'timeout'], [504, 'timeout'], [503, 'unavailable']] as const) {
    fetcher.mockResolvedValueOnce(new Response('private diagnostic', { status }))
    expect(await readCustomerSupport(signal)).toEqual({ ok: false, reason })
  }
  for (const [code, reason] of [['CUSTOMER_SUPPORT_UNSUPPORTED', 'unsupported'], ['CUSTOMER_SUPPORT_NETWORK', 'network'], ['CUSTOMER_SUPPORT_TIMEOUT', 'timeout'],
    ['CUSTOMER_SUPPORT_UNAVAILABLE', 'unavailable'], ['CUSTOMER_SUPPORT_INVALID', 'invalid'], ['ACCOUNT_CHANGED', 'account-changed'], ['NEW_PRIVATE_CODE', 'unavailable']] as const) {
    fetcher.mockResolvedValueOnce(Response.json({ ok: false, code, message: 'private diagnostic' }))
    expect(await readCustomerSupport(signal)).toEqual({ ok: false, reason })
  }
  fetcher.mockRejectedValueOnce(new TypeError('private diagnostic'))
  expect(await readCustomerSupport(signal)).toEqual({ ok: false, reason: 'network' })
  fetcher.mockRejectedValueOnce(new DOMException('private diagnostic', 'TimeoutError'))
  expect(await readCustomerSupport(signal)).toEqual({ ok: false, reason: 'timeout' })
  fetcher.mockResolvedValueOnce(new Response('bad-json'))
  expect(await readCustomerSupport(signal)).toEqual({ ok: false, reason: 'invalid' })
  fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('private diagnostic')) } })))
  expect(await readCustomerSupport(signal)).toEqual({ ok: false, reason: 'network' })
})

it('propagates dialog cancellation to the active Host request', async () => {
  const started = Promise.withResolvers<AbortSignal>()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal
    if (signal === undefined || signal === null) throw new Error('expected request signal')
    signal.addEventListener('abort', () => { reject(new DOMException('Cancelled', 'AbortError')) }, { once: true })
    started.resolve(signal)
  })))
  const dialog = new AbortController()
  const reading = readCustomerSupport(dialog.signal)
  const signal = await started.promise
  dialog.abort()
  expect(signal.aborted).toBe(true)
  expect(await reading).toEqual({ ok: false, reason: 'network' })
})

it('bounds a stalled Host read and classifies its deadline separately from network failures', async () => {
  const deadline = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal)
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { reject(new DOMException('Timed out', 'TimeoutError')) }, { once: true })
  })))
  const reading = readCustomerSupport(new AbortController().signal)
  deadline.abort(new DOMException('private diagnostic', 'TimeoutError'))
  expect(await reading).toEqual({ ok: false, reason: 'timeout' })
  expect(timeout).toHaveBeenCalledExactlyOnceWith(15_000)
})

it.each(['127.0.0.1:3001', 'localhost:3001', '[::1]:3001'])('accepts the Host resolved local API asset on %s', async (host) => {
  const payload = { ...details, qrCodeUrl: `http://${host}/harness/api/creation/assets/cc_${'a'.repeat(64)}` }
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, payload })))
  expect(await readCustomerSupport(new AbortController().signal)).toEqual({ ok: true, payload })
})

it.each([
  null, [], { ok: true }, { ok: true, payload: [] }, { ok: 'true', payload: details },
  ...[undefined, 'yes'].map(enabled => ({ ok: true, payload: { ...details, enabled } })),
  ...['http://support.example.com/qr', 'javascript:alert(1)', 'data:image/png;base64,fixture', '/relative/qr',
    'https://user:secret@support.example.com/qr', 'https://support.example.com/qr\n', 'https://support.example.com/qr image',
    'http://localhost/private', `http://192.0.2.1/api/creation/assets/cc_${'a'.repeat(64)}`,
    `http://127.0.0.1/api/creation/assets/cc_${'a'.repeat(64)}?token=x`, `http://localhost/api/creation/assets/cc_${'a'.repeat(64)}#fragment`,
    `http://localhost/%2f/api/creation/assets/cc_${'a'.repeat(64)}`, `http://localhost/a/../api/creation/assets/cc_${'a'.repeat(64)}`,
    `http://localhost/a%5cb/api/creation/assets/cc_${'a'.repeat(64)}`, `http://localhost/api/creation/assets/cc_${'A'.repeat(64)}`,
    `http://localhost/api/creation/assets/cc_${'a'.repeat(64)}/extra`].map(qrCodeUrl => ({ ok: true, payload: { ...details, qrCodeUrl } })),
  { ok: true, payload: { ...details, title: 'x'.repeat(65) } }, { ok: true, payload: { ...details, description: 'x'.repeat(257) } },
  { ok: true, payload: { ...details, title: null } }, { ok: true, payload: { ...details, qrCodeUrl: '' } },
  { ok: true, payload: { ...details, enabled: false } },
])('rejects malformed or unsafe support fields without rendering an image (%j)', async (body) => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)))
  expect(await readCustomerSupport(new AbortController().signal)).toEqual({ ok: false, reason: 'invalid' })
})
