/** Keyless demand envelopes for exercising the assembled browser controller, never a replacement Go server. */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Page, Route } from 'playwright'

type Json = Record<string, unknown>
interface Attachment extends Json {
  id: string
  name: string
  mime_type: string
  kind: string
  size_bytes: number
  uploaded_bytes: number
  status: string
}
interface Message extends Json {
  id: string
  demand_id: string
  seq: number
  author: string
  text: string
  kind: string
  attachments: Attachment[]
  created_at: number
  client_message_id: string
  read: boolean
}
interface Demand extends Json {
  id: string
  number: string
  engineer_id: string
  status: string
  revision: number
  last_seq: number
  last_read_seq: number
  unread_count: number
  preview: string
  delivery_id?: string
}
const owner = 'a'.repeat(64), now = (): number => Math.floor(Date.now() / 1000)
const engineer = { id: 'synthetic-engineer', display_name: '测试工程师林', category_ids: ['software'],
  introduction: '测试资料：软件开发、表单与文件处理', presence: 'online', accepting: true, can_start: true,
  capacity: 20, service_hours: '测试资料', avatar_attachment_id: '' }
const engineers = [engineer,
  { ...engineer, id: 'synthetic-busy', display_name: '测试工程师陈', presence: 'busy', can_start: false,
    introduction: '测试资料：业务系统集成、办公自动化与多语言网站。当前忙碌，展示接单状态。' },
  { ...engineer, id: 'synthetic-offline', display_name: '测试工程师周', presence: 'offline', can_start: false, accepting: false,
    introduction: '测试资料：数据整理与报表开发。当前离线，稍后开放接单。' },
  { ...engineer, id: 'synthetic-long-name', display_name: '测试工程师欧阳明远·企业系统与数据工作流顾问',
    introduction: '测试资料：帮助团队梳理复杂业务流程，开发表单、数据看板和文件处理工具；从需求确认、方案沟通到交付验收提供清晰的进度记录。'.repeat(3) },
]

/** Test-only control over confirmed records and raw upload receipt counters. */
export interface DemandFixture {
  readonly createBodies: string[]
  readonly records: Map<string, Demand>
  readonly chunks: Map<string, number>
  /** Serve the same uploaded synthetic bytes to native browser downloads, which bypass Playwright routing. */
  serveMedia(request: IncomingMessage, response: ServerResponse): void
  deliver(id: string): void
}

/**
 * Route local Host envelopes while retaining the real shipped UI, controller, journal and media elements.
 * @param page - Isolated browser page whose network is owned by this test.
 * @returns Fixture counters and a synthetic engineer delivery command.
 */
export async function installDemandFixture(page: Page): Promise<DemandFixture> {
  const records = new Map<string, Demand>(), messages = new Map<string, Message[]>(), createBodies: string[] = []
  const receipts = new Map<string, Json>(), uploads = new Map<string, { attachment: Attachment; bytes: Buffer; client: string }>()
  const chunks = new Map<string, number>()
  let firstUnknown = true, uploadUnknown = true
  const answer = (route: Route, payload: unknown, extra: Json = {}) => route.fulfill({ json: {
    ok: true, payload, account: { id: '7' }, accountOwner: owner, httpStatus: 200, ...extra,
  } })
  const append = (row: Demand, text: string, author: string, key: string, attachments: Attachment[] = [], kind = 'message'): Message => {
    const message: Message = { id: randomUUID(), demand_id: row.id, seq: ++row.last_seq, author, text, kind, attachments,
      created_at: now(), client_message_id: key, read: false, sender_id: author === 'user' ? 7 : 8 }
    row.preview = text; row.revision += 1
    messages.set(row.id, [...messages.get(row.id) ?? [], message])
    return message
  }
  const media = (url: URL, rangeHeader: string | undefined) => {
    const id = /\/attachments\/([^/]+)\/content$/u.exec(url.pathname)?.[1]
    const upload = id === undefined ? undefined : uploads.get(id)
    if (upload === undefined || url.searchParams.get('account_id') !== '7' || url.searchParams.get('account_owner') !== owner) {
      throw new Error('Synthetic attachment or owner is missing')
    }
    const range = /^bytes=(\d+)-(\d*)$/u.exec(rangeHeader ?? '')
    const start = range === null ? 0 : Number(range[1])
    const end = range?.[2] ? Math.min(Number(range[2]), upload.bytes.length - 1) : upload.bytes.length - 1
    return { status: range === null ? 200 : 206, body: upload.bytes.subarray(start, end + 1), headers: {
      'content-type': upload.attachment.mime_type, 'accept-ranges': 'bytes', 'content-length': String(end - start + 1),
      ...range === null ? {} : { 'content-range': `bytes ${start}-${end}/${upload.bytes.length}` },
      ...url.searchParams.get('disposition') === 'attachment' ? {
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(upload.attachment.name)}`,
      } : {},
    } }
  }
  await page.context().route('**/credits/api/**', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method()
    if (path === '/credits/api/session') {
      await route.fulfill({ json: { ok: true, payload: { signedIn: true, creditsPerYuan: 1000,
        account: { id: '7', phone: '+8613800000000' }, accountOwner: owner, expiresAt: '2099-01-01T00:00:00Z' } } }); return
    }
    if (path === '/credits/api/summary') { await answer(route, { balance_points: 1000 }); return }
    if (!path.startsWith('/credits/api/demands')) { await route.fulfill({ json: { ok: false, code: 'UNSUPPORTED' } }); return }
    const content = /\/attachments\/([^/]+)\/content$/u.exec(path)
    if (content !== null) { await route.fulfill(media(url, request.headers().range)); return }
    if (request.headers()['x-yunshu-account-owner'] !== owner || request.headers()['x-yunshu-account-id'] !== '7') throw new Error('Missing fixture owner guard')
    const suffix = path.slice('/credits/api/demands'.length)
    if (suffix === '/config') {
      await answer(route, { config: { enabled: true, categories: [{ id: 'software', name: '软件开发', enabled: true }], upload_rules: {
        max_image_bytes: 20_971_520, max_video_bytes: 536_870_912, max_attachments: 8, chunk_bytes: 4_194_304,
        allowed_mime_types: ['image/png', 'video/mp4'], upload_ttl_seconds: 86400,
      } }, server_time: now(), capabilities: { resumable_upload: true, polling: true } }); return
    }
    if (suffix === '/engineers') { await answer(route, { items: engineers, server_time: now() }); return }
    if (suffix === '/unread') { await answer(route, { unread_count: 0, unread_demands: 0, server_time: now() }); return }
    if (suffix === '' && method === 'GET') { await answer(route, { items: [...records.values()].reverse(), has_more: false, next_before_id: '' }); return }
    if (suffix === '/uploads' && method === 'POST') {
      const body = request.postDataJSON() as Json
      const client = String(body.client_upload_id)
      let upload = [...uploads.values()].find(item => item.client === client)
      if (upload === undefined) {
        const attachment: Attachment = { id: randomUUID(), name: String(body.name), mime_type: String(body.mime_type),
          kind: String(body.mime_type).startsWith('video/') ? 'video' : 'image', size_bytes: Number(body.size_bytes),
          uploaded_bytes: 0, status: 'uploading' }
        upload = { attachment, bytes: Buffer.alloc(0), client }; uploads.set(attachment.id, upload)
      }
      await answer(route, { attachment: upload.attachment, offset: upload.bytes.length,
        chunk_bytes: 4_194_304, expires_at: now() + 3600 }); return
    }
    const uploadPath = /^\/uploads\/([^/]+)(?:\/(chunks|complete))?$/u.exec(suffix)
    if (uploadPath !== null) {
      const upload = uploads.get(uploadPath[1] ?? '')
      if (upload === undefined) throw new Error('Unknown fixture upload')
      if (uploadPath[2] === 'chunks') {
        if (Number(request.headers()['upload-offset']) !== upload.bytes.length) throw new Error('Fixture offset was repeated')
        upload.bytes = Buffer.concat([upload.bytes, request.postDataBuffer() ?? Buffer.alloc(0)])
        upload.attachment.uploaded_bytes = upload.bytes.length
        chunks.set(upload.attachment.id, (chunks.get(upload.attachment.id) ?? 0) + 1)
        if (uploadUnknown) {
          uploadUnknown = false; await route.fulfill({ json: { ok: false, code: 'DEMAND_NETWORK', outcome: 'unknown' } }); return
        }
        await answer(route, { attachment: upload.attachment, offset: upload.bytes.length }); return
      }
      if (uploadPath[2] === 'complete') { upload.attachment.status = 'ready'; await answer(route, { attachment: upload.attachment }); return }
      await answer(route, { attachment: upload.attachment, offset: upload.bytes.length,
        chunk_bytes: 4_194_304, expires_at: now() + 3600 }); return
    }
    if (suffix === '' && method === 'POST' || /\/[A-Za-z0-9_-]+\/messages$/u.test(suffix) && method === 'POST') {
      const body = request.postDataJSON() as Json, create = suffix === ''
      const key = String(body[create ? 'client_request_id' : 'client_message_id'])
      if (create) createBodies.push(request.postData() ?? '')
      let receipt = receipts.get(key)
      if (receipt === undefined) {
        const row = create ? { id: randomUUID(), number: `SYNTHETIC-${records.size + 1}`, engineer_id: engineer.id, engineer,
          user_id: 7, status: 'pending', priority: 'normal', revision: 1, last_seq: 0, last_read_seq: 0, unread_count: 0, preview: '',
          title: typeof body.title === 'string' ? body.title : '', budget: '', expected_date: '', created_at: now(), updated_at: now() }
          : records.get(suffix.split('/')[1] ?? '')
        if (row === undefined) throw new Error('Fixture request is missing')
        records.set(row.id, row)
        const attachments = (body.attachment_ids as string[]).map((id) => {
          const upload = uploads.get(id)
          if (upload === undefined) throw new Error('Fixture upload receipt is missing')
          return { ...upload.attachment, demand_id: row.id }
        })
        const message = append(row, String(body.text), 'user', key, attachments)
        receipt = { demand: row, message, replayed: false }; receipts.set(key, receipt)
      } else receipt = { ...receipt, replayed: true }
      if (create && firstUnknown) { firstUnknown = false; await route.fulfill({ json: { ok: false, code: 'DEMAND_TIMEOUT', outcome: 'unknown' } }); return }
      await answer(route, receipt); return
    }
    const detail = /^\/([A-Za-z0-9_-]+)(?:\/(messages|read|actions))?$/u.exec(suffix)
    if (detail !== null) {
      const row = records.get(detail[1] ?? '')
      if (row === undefined) throw new Error('Fixture request not found')
      if (detail[2] === 'messages') {
        const after = Number(url.searchParams.get('after_seq') ?? 0)
        await answer(route, { items: (messages.get(row.id) ?? []).filter(item => item.seq > after),
          next_after_seq: row.last_seq, last_seq: row.last_seq, has_more: false, demand: row }); return
      }
      if (detail[2] === 'read') {
        const body = request.postDataJSON() as Json
        row.last_read_seq = Math.max(row.last_read_seq, Number(body.last_read_seq)); row.unread_count = 0
        await answer(route, { last_read_seq: row.last_read_seq, unread_count: 0 }); return
      }
      if (detail[2] === 'actions') { row.status = 'completed'; row.revision += 1; await answer(route, { demand: row, replayed: false }); return }
      await answer(route, { demand: row }); return
    }
    throw new Error(`Unexpected demand fixture route: ${method} ${suffix}`)
  })
  return { records, createBodies, chunks, serveMedia(request, response) {
    const result = media(new URL(request.url ?? '/', 'http://synthetic.invalid'), request.headers.range)
    response.writeHead(result.status, result.headers); response.end(result.body)
  }, deliver(id) {
    const row = records.get(id)
    if (row === undefined) throw new Error('Fixture delivery target is missing')
    for (let index = 0; index < 18; index++) {
      const progress = append(row, `测试工程师进度 ${index + 1}：${'本段用于验证独立消息滚动。'.repeat(3)}`, 'engineer', randomUUID())
      if (index === 0) progress.author_name = engineer.display_name
    }
    const delivery = append(row, '测试交付：已完成，请验收。', 'engineer', randomUUID(), [], 'delivery')
    delivery.author_name = engineer.display_name
    row.status = 'awaiting_acceptance'; row.delivery_id = delivery.id
  } }
}
