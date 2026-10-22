/** Built creation composers share one material area above prompts and one upload input. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { catalogFromPricing } from '../../../packages/host/credits-index/src/media.ts'
import { normalizeReferenceImage } from '../../../packages/host/credits-index/src/reference-image.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

it('sends live image ratio and tier from the real creation page through Host HTTP while older catalogs hide ratios', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-ratio-ui-'))
  const cleanup: { browser?: () => Promise<void>; scaffold?: () => Promise<void>; upstream?: () => Promise<void> } = {}
  onTestFinished(async () => {
    try { await cleanup.browser?.() } finally {
      try { await cleanup.scaffold?.() } finally {
        try { await cleanup.upstream?.() } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  })
  const sizes = ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '2:1', '1:2', '21:9', '9:21']
  const model = 'yunshu-internal-gpt-image-2'
  const referenceUrl = 'https://files.toapis.cn/uploads/ui-ratio-reference.jpg'
  const requests: string[] = [], errors: string[] = [], blockedBrowserRequests: string[] = []
  const generations: Record<string, unknown>[] = [], hostSubmissions: Record<string, unknown>[] = []
  const uploads: { type: string; bytes: number }[] = []
  let publishRatios = false, pricingReads = 0
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      requests.push(`${request.method ?? 'GET'} ${path}`)
      response.setHeader('content-type', 'application/json')
      const answer = (data: unknown): void => { response.end(JSON.stringify({ success: true, data })) }
      if (path === '/harness/api/status') { answer({ quota_per_unit: 500_000, usd_exchange_rate: 7.3 }); return }
      if (path === '/harness/api/user/phone/challenge') {
        answer({ challenge_id: 'synthetic-image-challenge', delivery_status: 'accepted', expires_at: Math.floor(Date.now() / 1000) + 300,
          resend_after_seconds: 60, expires_in_minutes: 5 }); return
      }
      if (path === '/harness/api/user/phone/login') {
        response.setHeader('set-cookie', 'new_api_refresh=synthetic-image-refresh; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: 'synthetic-image-access', access_expires_at: Math.floor(Date.now() / 1000) + 900,
          relay_key: 'sk-synthetic-image-relay', relay_key_id: 9, user: { id: 7, username: 'image-ui-fixture', group: 'product', quota: 500_000 } }); return
      }
      if (path === '/harness/api/user/self') {
        answer({ id: 7, username: 'image-ui-fixture', group: 'product', quota: 500_000, used_quota: 0 }); return
      }
      if (path === '/harness/v1/models') {
        response.end(JSON.stringify({ data: [{ id: 'deepseek-v4-flash', supported_endpoint_types: ['openai'] },
          { id: model, supported_endpoint_types: ['image-generation'] }] })); return
      }
      if (path === '/harness/api/pricing') {
        pricingReads += 1
        answer([{ model_name: model, display_name: '本地图片模型', supported_endpoint_types: ['image-generation'], enable_groups: ['product'],
          billing_usage_schema: { resolution: { enum: ['1k', '2k', '4k'] } },
          ...publishRatios ? { parameters: { type: 'object', properties: {
            size: { type: 'string', enum: sizes, default: '1:1' }, resolution: { type: 'string', enum: ['1k', '2k', '4k'], default: '1k' },
          } } } : {},
        }]); return
      }
      if (path === '/harness/api/creation/content') {
        const mode = { title: { zh: '', en: '' }, description: { zh: '', en: '' }, promptPlaceholder: { zh: '', en: '' },
          categories: [], templates: [], presets: [] }
        answer({ schemaVersion: 1, revision: 'image-ratio-ui', image: mode, video: mode }); return
      }
      if (path === '/harness/v1/uploads/images') {
        expect(request.headers.authorization).toBe('Bearer sk-synthetic-image-relay')
        const form = await new Response(bytes, { headers: { 'content-type': request.headers['content-type'] ?? '' } }).formData()
        const file = form.get('file')
        if (file === null || typeof file === 'string') throw new Error('Expected actual uploaded reference bytes')
        uploads.push({ type: file.type, bytes: file.size })
        answer({ id: 'ui-ratio-upload', url: referenceUrl, mime_type: file.type, size: file.size }); return
      }
      if (path === '/harness/toapis/v1/images/generations') {
        expect(request.headers.authorization).toBe('Bearer sk-synthetic-image-relay')
        const body: unknown = JSON.parse(bytes.toString('utf8'))
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected image generation JSON')
        generations.push(body as Record<string, unknown>)
        response.end(JSON.stringify({ id: 'ui-ratio-task' })); return
      }
      if (path === '/harness/toapis/v1/images/generations/ui-ratio-task') {
        response.end(JSON.stringify({ status: 'succeeded', result: { data: [{ b64_json: png.toString('base64') }] } })); return
      }
      if (path === '/harness/api/client-activity/heartbeat') {
        answer({ server_time: Math.floor(Date.now() / 1000), heartbeat_interval_seconds: 60 }); return
      }
      if (path === '/harness/api/log/self') { answer({ page: 1, page_size: 100, total: 0, items: [] }); return }
      if (path === '/harness/api/user/auth/logout') { answer(null); return }
      errors.push(path); response.writeHead(404); response.end('{}')
    })().catch((error: unknown) => { errors.push(String(error)); response.destroy() })
  })
  cleanup.upstream = () => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    server.closeAllConnections()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Image fixture must bind loopback')
  const baseURL = `http://127.0.0.1:${String(address.port)}/harness`
  const overlay = join(root, 'image-ratio.patch.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'credits-index', config: { newApiBaseUrl: baseURL, stateDir: join(root, 'credits') } },
    { id: 'llm-pi-ai', config: { providers: { 'yunshu-local': {
      displayName: '云枢', api: 'openai-completions', baseURL: `${baseURL}/v1`, apiKeyEnv: 'YUNSHU_RELAY_TOKEN', models: [{ id: 'deepseek-v4-flash' }],
    } } } },
    { id: 'agent-default-model', config: { provider: 'yunshu-local', model: 'deepseek-v4-flash', followPolicy: true } },
    ...['dsh-market', 'dsh-skin-market'].map(id => ({ id, disabled: true })),
  ]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
  cleanup.scaffold = () => scaffold.close()
  const hostPost = (path: string, body: object) => scaffold.hostFetch(path, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(scaffold.baseUrl).origin }, body: JSON.stringify(body) })
  expect(await (await hostPost('/credits/api/session/challenge', { phone: '+8613800000000', idempotencyKey: 'ui-ratio-challenge' })).json())
    .toMatchObject({ ok: true })
  expect(await (await hostPost('/credits/api/session/verify', { phone: '+8613800000000', challengeId: 'synthetic-image-challenge',
    code: '123456', idempotencyKey: 'ui-ratio-login' })).json()).toMatchObject({ ok: true })
  const browser = await chromium.launch()
  cleanup.browser = () => browser.close()
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 },
    colorScheme: 'dark', reducedMotion: 'reduce' })
  page.setDefaultTimeout(15_000)
  const tripwire = watchConsole(page)
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin === new URL(scaffold.baseUrl).origin || ['data:', 'blob:'].includes(url.protocol)) await route.continue()
    else { blockedBrowserRequests.push(url.origin); await route.abort('blockedbyclient') }
  })
  page.on('request', (request) => {
    if (new URL(request.url()).pathname !== '/credits/api/image/generate' || request.method() !== 'POST') return
    const body: unknown = request.postDataJSON()
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) hostSubmissions.push(body as Record<string, unknown>)
  })
  const evidenceRoot = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
  await mkdir(evidenceRoot, { recursive: true })
  const evidence = await mkdtemp(join(evidenceRoot, 'image-ratio-host-ui-'))
  try {
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, '图片规格', false)
    await page.getByRole('button', { name: 'AI 创作', exact: true }).click()
    const panel = page.locator('#imagegen')
    await panel.getByRole('option', { name: '本地图片模型', exact: true }).waitFor({ state: 'attached' })
    await panel.getByRole('combobox', { name: '分辨率', exact: true }).waitFor()
    expect(await panel.getByRole('combobox', { name: '比例与尺寸', exact: true }).count()).toBe(0)
    await page.screenshot({ path: join(evidence, 'old-api-no-ratio.png'), animations: 'disabled' })
    const oldReads = pricingReads
    publishRatios = true
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
    await expect.poll(() => pricingReads).toBeGreaterThan(oldReads)
    const ratio = panel.getByRole('combobox', { name: '比例与尺寸', exact: true })
    await ratio.waitFor()
    expect(await ratio.locator('option').allTextContents()).toEqual(sizes)
    await ratio.selectOption('16:9')
    await panel.getByRole('combobox', { name: '分辨率', exact: true }).selectOption('4k')
    await panel.locator('input[type=file]').setInputFiles({ name: '参考.png', mimeType: 'image/png', buffer: png })
    await panel.getByText('1/6', { exact: true }).waitFor()
    await panel.getByRole('textbox', { name: '画面描述', exact: true }).fill('保持参考图主体，使用所选画面比例')
    const geometry: { width: number; documentWidth: number; right: number }[] = []
    for (const [theme, width] of [['dark', 1440], ['light', 900]] as const) {
      await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height: 1000 })
      await page.evaluate(async () => { await document.fonts.ready })
      const region = panel.getByRole('group', { name: '图片规格', exact: true })
      const box = await region.boundingBox()
      if (box === null) throw new Error('Image specifications must remain visible')
      const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth)
      expect(documentWidth).toBeLessThanOrEqual(width)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
      geometry.push({ width, documentWidth, right: box.x + box.width })
      await page.screenshot({ path: join(evidence, `image-ratio-${theme}-${String(width)}.png`), animations: 'disabled' })
    }
    await panel.getByRole('button', { name: '生成图片', exact: true }).click()
    await panel.getByText('生成完成，已保存到产物。', { exact: true }).waitFor()
    expect(hostSubmissions).toHaveLength(1)
    expect(hostSubmissions[0]).toMatchObject({ model, size: '16:9', resolution: '4k', count: 1 })
    expect(hostSubmissions[0]?.['references']).toHaveLength(1)
    expect(generations).toEqual([{ model, prompt: '保持参考图主体，使用所选画面比例', n: 1, size: '16:9', resolution: '4k', reference_images: [referenceUrl] }])
    expect(uploads).toHaveLength(1)
    expect(requests.filter(path => path.startsWith('POST ') && path.includes('/toapis/'))).toHaveLength(1)
    expect(errors).toEqual([]); expect(blockedBrowserRequests).toEqual([]); expect(tripwire.pageErrors).toEqual([])
    await page.screenshot({ path: join(evidence, 'image-ratio-generated.png'), animations: 'disabled' })
    await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, oldApiRatioHidden: true, sizes, geometry,
      hostSubmissions, generations, uploads, requests, errors, blockedBrowserRequests, pageErrors: tripwire.pageErrors,
      runtime: 'real built Web composition and real Host; only supplier/account HTTP is a private loopback fixture',
      upstreamGeneration: false, productionAccess: false }, null, 2) + '\n')
    console.log(`Image ratio Host UI evidence: ${evidence}`)
  } catch (error) {
    await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined)
    await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), hostSubmissions, generations,
      uploads, requests, errors, blockedBrowserRequests, pageErrors: tripwire.pageErrors }, null, 2) + '\n')
    throw error
  }
})

const videoLabels = {
  'lec-mj-seedance-2-5-cd-720p': 'Seedance 2.5 · 720p · 30秒（线路1）',
  'sd-25-900-2': 'Seedance 2.5 · 720p · 30秒（线路2）',
  'k2-sd2.5-720p': 'Seedance 2.5 满参版 · 720p · 30秒',
  'lec-sz-sd2-full-480p': 'Seedance 2.5 · 480p · 30秒',
  'video-sd25-480p': 'Seedance 2.5 · 480p · 15–30秒',
  'model_5': 'Seedance 2.5 完整版 · 480p · 15–30秒',
  'sd2.5-720p-x2': 'Seedance 2.5 完整版 · 720p · 15–30秒',
  'sd2-th-2.0-720p': 'Seedance 2.0 Fast · 720p · 15秒（线路1）',
  'bt-seedance-2.0': 'Seedance 2.0 · 720p · 10/15秒',
  'lec-rs-seedance-2-0-fast': 'Seedance 2.0 Fast · 720p · 15秒（线路2）',
  'sd20-933-720p': 'Seedance 2.0 Fast · 720p · 15秒（线路3）',
  'sd2-hn2-480-pro': 'Seedance 2.0 完整版 · 480p · 15秒',
  'v3-sd2.0-933-720p': 'Seedance 2.0 完整版 · 720p · 15秒（线路1）',
  'sd-20-9/3/3-1': 'Seedance 2.0 完整版 · 720p · 15秒（线路2）',
  'sd-20-903': 'Seedance 2.0 Fast · 480p · 15秒',
} as const

/** Compare rendered coordinates after the browser has decoded every uploaded image. */
async function materialsAbovePrompt(panel: Locator): Promise<{ promptTop: number; materialBottom: number }> {
  const images = panel.locator('img')
  await expect.poll(() => images.evaluateAll(items => items.length === 3 && items.every(item =>
    item instanceof HTMLImageElement && item.complete && item.naturalWidth > 0))).toBe(true)
  const prompt = await panel.getByRole('textbox', { name: '画面描述', exact: true }).boundingBox()
  const materialBottom = await images.evaluateAll(items => Math.max(...items.map(item => item.getBoundingClientRect().bottom)))
  if (prompt === null) throw new Error('Creation prompt must be visible')
  expect(materialBottom).toBeLessThanOrEqual(prompt.y)
  return { promptTop: prompt.y, materialBottom }
}

it('keeps all images above long prompts and maps video frame roles without duplicate uploaders', async () => {
  const scaffold = await launchWebScaffold({})
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
      page.setDefaultTimeout(15_000)
      const tripwire = watchConsole(page)
      const directory = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
      await mkdir(directory, { recursive: true })
      const evidence = await mkdtemp(join(directory, 'creation-composer-layout-'))
      const image = await normalizeReferenceImage(png, '参考.png')
      const uploads: string[] = [], paidRequests: string[] = [], unexpectedReads: string[] = []
      let friendlyLabels = false, catalogReads = 0
      const geometry: Record<string, Awaited<ReturnType<typeof materialsAbovePrompt>>> = {}
      await page.route('**/artifacts/api/list', route => route.fulfill({ status: 200, json: { items: [] } }))
      await page.route('**/credits/api/**', async (route) => {
        const request = route.request(), url = new URL(request.url())
        const json = async (payload: object): Promise<void> => route.fulfill({ status: 200, json: { ok: true, payload } })
        if (url.pathname === '/credits/api/session') {
          await json({ signedIn: true, creditsPerYuan: 1000, account: { id: 'creation-layout-qa' } })
        } else if (url.pathname === '/credits/api/summary') await json({ balance_points: 10000 })
        else if (url.pathname === '/credits/api/creative/projects') await json({ accountId: 'creation-layout-qa', projects: [] })
        else if (url.pathname === '/credits/api/media/catalog') {
          catalogReads += 1
          const catalog = catalogFromPricing([
            { model_name: 'yunshu-internal-gpt-image-2', supported_endpoint_types: ['image-generation'], display_name: '图片模型' },
            { model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] },
            ...Object.entries(videoLabels).map(([id, label]) => ({ model_name: id, supported_endpoint_types: ['openai-video'],
              display_name: friendlyLabels ? label : id })),
          ], 'product')
          await json({ image: catalog.filter(model => model.kind === 'image'), video: catalog.filter(model => model.kind === 'video') })
        }
        else if (url.pathname === '/credits/api/creation/content') {
          const mode = { title: { zh: '' }, description: { zh: '' }, promptPlaceholder: { zh: '' }, categories: [], templates: [], presets: [] }
          await json({ schemaVersion: 1, revision: 'layout-qa', image: mode, video: mode })
        } else if (url.pathname === '/credits/api/assets' && request.method() === 'POST') {
          const name = decodeURIComponent(request.headers()['x-file-name'] ?? '')
          uploads.push(name)
          const assetId = `ma_layout${String(uploads.length)}`
          await route.fulfill({ status: 200, json: { ok: true, asset: { assetId, sizeBytes: image.bytes.length,
            contentType: image.mediaType, previewUrl: `/credits/api/assets/preview?asset_id=${assetId}` } } })
        } else if (url.pathname === '/credits/api/assets/preview') {
          await route.fulfill({ status: 200, contentType: image.mediaType, body: image.bytes })
        } else if (url.pathname === '/credits/api/usage') await json({ rows: [], asOf: new Date().toISOString(), delayMinutes: 0 })
        else if (request.method() !== 'GET' && request.method() !== 'HEAD') {
          paidRequests.push(`${request.method()} ${url.pathname}`); await route.abort('blockedbyclient')
        } else {
          unexpectedReads.push(url.pathname); await route.fulfill({ status: 404, json: { ok: false } })
        }
      })
      try {
        await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
        await page.getByRole('button', { name: 'AI 创作', exact: true }).click()
        const images = page.locator('#imagegen'), videos = page.locator('#videogen')
        await expect.poll(() => images.locator('input[type=file]').isEnabled()).toBe(true)
        await images.locator('input[type=file]').setInputFiles(['人物.png', '场景.png', '商品.png'].map(name => ({ name, mimeType: 'image/png', buffer: png })))
        await images.getByText('3/6', { exact: true }).waitFor()
        await images.getByRole('textbox', { name: '画面描述', exact: true }).fill('保持三张参考素材的视觉设定。\n'.repeat(45))
        for (const [theme, width] of [['dark', 1440], ['light', 900]] as const) {
          await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height: 1000 })
          geometry[`image-${theme}`] = await materialsAbovePrompt(images)
          await page.screenshot({ path: join(evidence, `image-${theme}.png`), animations: 'disabled' })
        }
        await images.getByRole('tab', { name: '视频', exact: true }).click()
        await expect.poll(() => videos.locator('input[type=file]').isEnabled()).toBe(true)
        await videos.getByRole('button', { name: '首尾帧', exact: true }).click()
        await videos.locator('input[type=file]').setInputFiles(['首.png', '尾.png', '候选.png'].map(name => ({ name, mimeType: 'image/png', buffer: png })))
        await videos.getByRole('combobox', { name: '首帧图', exact: true }).selectOption({ label: '首.png' })
        await videos.getByRole('combobox', { name: '尾帧图', exact: true }).selectOption({ label: '尾.png' })
        await videos.getByRole('textbox', { name: '画面描述', exact: true }).fill('从开场到收尾保持人物与构图连续。\n'.repeat(45))
        expect(await videos.locator('input[type=file]').count()).toBe(1)
        expect(await videos.getByRole('combobox', { name: '首帧图', exact: true }).count()).toBe(1)
        expect(await videos.getByRole('combobox', { name: '尾帧图', exact: true }).count()).toBe(1)
        for (const [theme, width] of [['dark', 1440], ['light', 900]] as const) {
          await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height: 1000 })
          geometry[`video-${theme}`] = await materialsAbovePrompt(videos)
          await page.screenshot({ path: join(evidence, `video-${theme}.png`), animations: 'disabled' })
        }
        await videos.getByRole('button', { name: '模型', exact: true }).click()
        await page.getByRole('menuitem', { name: 'lec-mj-seedance-2-5-cd-720p', exact: true }).click()
        expect(await videos.getByRole('button', { name: '首尾帧', exact: true }).count()).toBe(0)
        expect(await videos.getByRole('button', { name: '图生视频', exact: true }).count()).toBe(0)
        expect(await videos.getByRole('combobox', { name: '首帧图', exact: true }).count()).toBe(0)
        await videos.getByRole('button', { name: '参考素材', exact: true }).click()
        await videos.getByLabel('视频参数：画面尺寸 1280x720，时长 30 秒', { exact: true }).waitFor()
        const readsBeforeRename = catalogReads
        friendlyLabels = true
        await page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
        await expect.poll(() => catalogReads).toBeGreaterThan(readsBeforeRename)
        await expect.poll(() => videos.getByRole('button', { name: '模型', exact: true }).innerText()).toContain(videoLabels['lec-mj-seedance-2-5-cd-720p'])
        await videos.getByLabel('视频参数：画面尺寸 1280x720，时长 30 秒', { exact: true }).waitFor()
        await videos.getByRole('button', { name: '模型', exact: true }).click()
        for (const label of Object.values(videoLabels)) await page.getByRole('menuitem', { name: label, exact: true }).waitFor()
        const selected = page.getByRole('menuitem', { name: videoLabels['lec-mj-seedance-2-5-cd-720p'], exact: true })
        expect(await selected.locator('svg[class*="check"]').count()).toBe(1)
        await page.screenshot({ path: join(evidence, 'video-friendly-model-menu-first.png'), animations: 'disabled' })
        await page.getByRole('menuitem', { name: videoLabels['sd-20-903'], exact: true }).scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(evidence, 'video-friendly-model-menu-last.png'), animations: 'disabled' })
        await page.keyboard.press('Escape')
        await page.screenshot({ path: join(evidence, 'video-reference-only-pixel-size.png'), animations: 'disabled' })
        expect(uploads).toHaveLength(6)
        expect(paidRequests).toEqual([])
        expect(unexpectedReads).toEqual([])
        expect(tripwire.pageErrors).toEqual([])
        await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, geometry, uploads, paidRequests,
          unexpectedReads, pageErrors: tripwire.pageErrors, runtime: 'real built shipped Web composition',
          imageResolutionTiers: ['1k', '2k', '4k'], singleVideoUploadInput: true, blackrxDefaultDuration: 30, friendlyVideoLabels: videoLabels,
          labelOnlyRefreshPreservesSelectedId: 'lec-mj-seedance-2-5-cd-720p', catalogReads }, null, 2) + '\n')
        console.log(`Creation composer layout evidence: ${evidence}`)
      } catch (error) {
        await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined)
        await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), uploads, geometry,
          paidRequests, unexpectedReads, pageErrors: tripwire.pageErrors }, null, 2) + '\n')
        throw error
      }
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})
