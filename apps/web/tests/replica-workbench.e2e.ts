/** Real built creation-to-chat draft handoff; no message or supplier generation is submitted. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const ACCOUNT = 'synthetic-replica-browser-owner'
const ACCOUNT_OWNER = createHash('sha256').update('synthetic-replica-browser-login').digest('hex')
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', 'base64')

it.each(['image', 'video'] as const)('hands %s reference roles and real files into one unsent normal chat draft', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-replica-browser-'))
  const evidenceRoot = process.env.DSH_REPLICA_BROWSER_EVIDENCE ?? join(process.cwd(), '.artifacts')
  await mkdir(evidenceRoot, { recursive: true })
  const evidence = await mkdtemp(join(evidenceRoot, `replica-${kind}-`))
  const cleanup: { scaffold?: WebScaffold; browser?: Browser; page?: Page } = {}
  const sentinelCalls: string[] = [], forbidden: string[] = [], external: string[] = [], submittedEvents: string[] = []
  let sessionReads = 0
  const sentinel = createServer((request, response) => {
    sentinelCalls.push(`${request.method ?? 'GET'} ${request.url ?? ''}`)
    response.setHeader('content-type', 'application/json')
    if (request.method !== 'GET') { response.statusCode = 405; response.end('{"success":false}'); return }
    if (request.url === '/harness/api/status') { response.end('{"success":true,"data":{}}'); return }
    if (request.url === '/harness/v1/models') { response.end('{"object":"list","data":[]}'); return }
    if (request.url === '/harness/api/pricing') { response.end('{"success":true,"data":[]}'); return }
    response.statusCode = 404; response.end('{"success":false}')
  })
  onTestFinished(async ({ task }) => {
    try {
      if (task.result?.state === 'fail' && cleanup.page !== undefined && !cleanup.page.isClosed()) {
        await cleanup.page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true, animations: 'disabled' })
        await writeFile(join(evidence, 'failure-aria.txt'), await cleanup.page.locator('body').ariaSnapshot())
      }
      await writeFile(join(evidence, 'final-observed.json'), JSON.stringify({ kind, forbidden, external, submittedEvents, sessionReads, sentinelCalls }, null, 2) + '\n')
    } finally {
      try { await cleanup.browser?.close() } finally {
        try { await cleanup.scaffold?.close() } finally {
          try {
            if (sentinel.listening) await new Promise<void>((resolve, reject) => {
              sentinel.close((error) => { if (error === undefined) resolve(); else reject(error) }); sentinel.closeAllConnections()
            })
          } finally { await rm(root, { recursive: true, force: true }) }
        }
      }
    }
  })
  await new Promise<void>((resolve, reject) => { sentinel.once('error', reject); sentinel.listen(0, '127.0.0.1', resolve) })
  const address = sentinel.address()
  if (address === null || typeof address === 'string') throw new Error('Expected owned loopback sentinel')
  const overlay = join(root, 'replica.patch.yml')
  await writeFile(overlay, JSON.stringify([{ id: 'credits-index', config: {
    newApiBaseUrl: `http://127.0.0.1:${address.port}/harness`, baseUrl: '', bridgeBaseUrl: '', stateDir: join(root, 'credits'),
  } }]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay }); cleanup.scaffold = scaffold
  scaffold.ctx.on('session/event', (_session, event) => {
    if (event.type === 'user/message' || event.type === 'turn/start') submittedEvents.push(event.type)
  })
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath }); cleanup.browser = browser
  const page = await newEnglishPage(browser); cleanup.page = page
  page.setDefaultTimeout(15_000)
  const tripwire = watchConsole(page)
  const origin = new URL(scaffold.baseUrl).origin
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin) {
      external.push(url.origin); await route.abort('blockedbyclient'); return
    }
    await route.continue()
  })
  await page.route('**/artifacts/api/list', route => route.fulfill({ status: 200, json: { items: [] } }))
  await page.route('**/credits/api/**', async (route) => {
    const incoming = route.request(), path = new URL(incoming.url()).pathname
    const reply = async (payload: unknown): Promise<void> => route.fulfill({ status: 200,
      json: { ok: true, payload, account: { id: ACCOUNT }, accountOwner: ACCOUNT_OWNER } })
    if (incoming.method() !== 'GET') forbidden.push(`${incoming.method()} ${path}`)
    if (path === '/credits/api/session') { sessionReads += 1; await reply({ signedIn: true, creditsPerYuan: 1000, accountOwner: ACCOUNT_OWNER, account: { id: ACCOUNT, phone: '' } }); return }
    if (path === '/credits/api/summary') { await reply({ balance_points: 10000 }); return }
    if (path === '/credits/api/media/catalog') { await reply({ image: [], video: [], audio: [] }); return }
    if (path === '/credits/api/creation/content') {
      const mode = { title: { en: '', zh: '' }, description: { en: '', zh: '' }, promptPlaceholder: { en: '', zh: '' }, categories: [], templates: [], presets: [] }
      await reply({ schemaVersion: 1, revision: 'synthetic-replica-only', image: mode, video: mode }); return
    }
    if (path === '/credits/api/media/preferences') { await reply({ schema_version: 1, scope: ACCOUNT_OWNER, revision: 'e'.repeat(64), image: null, video: null }); return }
    if (path === '/credits/api/creative/projects') { await reply({ accountId: ACCOUNT, projects: [] }); return }
    if (path === '/credits/api/announcement-banner') { await reply({ enabled: false, scope: '0'.repeat(64), revision: '1'.repeat(64), announcements: [] }); return }
    if (path === '/credits/api/chat-usage') { await reply({ scope: 'chat-model', status: 'unavailable', settledRequests: 0, totalRequests: 0, accountId: ACCOUNT }); return }
    if (path === '/credits/api/usage') { await reply({ rows: [], asOf: new Date().toISOString(), delayMinutes: 0 }); return }
    await route.fulfill({ status: 404, json: { ok: false, code: 'SYNTHETIC_ROUTE_UNAVAILABLE' } })
  })
  let source = image
  if (kind === 'video') {
    const runtime = process.env.DSH_VIDEO_TEST_RUNTIME_ROOT
    if (runtime === undefined) throw new Error('DSH_VIDEO_TEST_RUNTIME_ROOT is required for real browser video media')
    const path = join(root, 'reference.mp4')
    execFileSync(join(runtime, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10:d=1',
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path,
    ], { timeout: 20_000 })
    source = await readFile(path)
  }
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  if (kind === 'video') await page.getByRole('tab', { name: 'Videos', exact: true }).click()
  await page.locator(kind === 'image' ? '#imagegen' : '#videogen').getByText('Balance 10,000 credits (about ¥10.00)', { exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Reference remix', exact: true }).click()
  const workbench = page.getByRole('region', { name: 'Reference remix', exact: true })
  await workbench.getByLabel('Choose reference media', { exact: true }).setInputFiles({ name: kind === 'image' ? 'reference.png' : 'reference.mp4', mimeType: kind === 'image' ? 'image/png' : 'video/mp4', buffer: source })
  await workbench.getByLabel('Add subject images', { exact: true }).setInputFiles([{ name: 'product.png', mimeType: 'image/png', buffer: image }])
  await workbench.getByRole('textbox', { name: 'What to keep', exact: true }).fill('Preserve lighting and composition')
  await workbench.getByRole('textbox', { name: 'What to change', exact: true }).fill('Replace the subject with my product')
  expect(await workbench.getByRole('textbox', { name: /^Output count/ }).inputValue()).toBe('1')
  await expect.poll(() => workbench.locator('img').evaluateAll(elements => elements.every(element => element instanceof HTMLImageElement && element.naturalWidth > 0)), { timeout: 15_000 }).toBe(true)
  let videoPreview: { currentTime: number; readyState: number; width: number; height: number; paused: boolean } | null = null
  if (kind === 'video') {
    const video = workbench.locator('video')
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement
      && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && element.videoWidth > 0 && element.videoHeight > 0),
    { timeout: 15_000 }).toBe(true)
    await video.evaluate(async (element) => {
      if (!(element instanceof HTMLVideoElement)) throw new Error('Expected the real native video preview')
      await element.play()
    })
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement ? element.currentTime : 0),
      { timeout: 15_000 }).toBeGreaterThan(0)
    videoPreview = await video.evaluate((element) => {
      if (!(element instanceof HTMLVideoElement)) throw new Error('Expected the real native video preview')
      element.pause()
      return { currentTime: element.currentTime, readyState: element.readyState,
        width: element.videoWidth, height: element.videoHeight, paused: element.paused }
    })
    expect(videoPreview.currentTime).toBeGreaterThan(0)
    expect(videoPreview.readyState).toBeGreaterThanOrEqual(2)
    expect(videoPreview.width).toBeGreaterThan(0)
    expect(videoPreview.height).toBeGreaterThan(0)
    expect(videoPreview.paused).toBe(true)
  }
  const screenshots: string[] = []
  for (const [theme, width] of [['light', 1440], ['dark', 780], ['dark', 375]] as const) {
    await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height: 1100 })
    await workbench.getByRole('heading', { name: 'Reference remix', exact: true }).scrollIntoViewIfNeeded()
    const topPath = join(evidence, `${kind}-${theme}-${width}-top.png`)
    await page.screenshot({ path: topPath, fullPage: true, animations: 'disabled' }); screenshots.push(topPath)
    await workbench.getByRole('button', { name: 'Analyze in chat', exact: true }).scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    expect(await workbench.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    const path = join(evidence, `${kind}-${theme}-${width}.png`)
    await page.screenshot({ path, fullPage: true, animations: 'disabled' }); screenshots.push(path)
  }
  await page.setViewportSize({ width: 1440, height: 1100 })
  const readsBeforeHandoff = sessionReads
  await workbench.getByRole('button', { name: 'Analyze in chat', exact: true }).click()
  const input = page.locator('[data-composer-input][contenteditable="true"]')
  await expect.poll(() => input.innerText(), { timeout: 15_000 }).toContain('yunshu-reference-replica')
  await expect.poll(() => input.innerText(), { timeout: 15_000 }).toContain('Do not invoke image/video generation')
  await expect.poll(() => input.innerText(), { timeout: 15_000 }).toContain('Preserve lighting and composition')
  await expect.poll(() => input.innerText(), { timeout: 15_000 }).toContain('Output count: 1')
  await expect.poll(() => input.innerText(), { timeout: 15_000 }).toContain('product.png')
  await page.getByRole('img', { name: 'product.png', exact: true }).waitFor({ state: 'visible' })
  if (kind === 'image') await page.getByRole('img', { name: 'reference.png', exact: true }).waitFor({ state: 'visible' })
  else {
    await page.getByRole('button', { name: 'Remove file reference.mp4', exact: true }).waitFor({ state: 'visible' })
    await expect.poll(() => page.getByText('Uploading…', { exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Retry uploading reference.mp4', exact: true }).count()).toBe(0)
  }
  expect(sessionReads - readsBeforeHandoff).toBeGreaterThanOrEqual(2)
  await page.screenshot({ path: join(evidence, `${kind}-normal-chat-draft.png`), fullPage: true, animations: 'disabled' })
  expect(await page.getByRole('button', { name: /Stop/ }).count()).toBe(0)
  expect(forbidden).toEqual([])
  expect(external).toEqual([])
  expect(submittedEvents).toEqual([])
  expect(sentinelCalls.filter(call => !call.startsWith('GET '))).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ status: 'passed', kind,
    mode: 'real built creation entry -> ordinary unsent chat draft; no model or generation submission',
    source_sha256: createHash('sha256').update(source).digest('hex'), subject_sha256: createHash('sha256').update(image).digest('hex'),
    prompt: await input.innerText(), screenshots, accountOwner: ACCOUNT_OWNER, sessionReads,
    handoffSessionReads: sessionReads - readsBeforeHandoff,
    videoPreview, forbidden, external, submittedEvents, sentinelCalls, console: tripwire }, null, 2) + '\n')
})
