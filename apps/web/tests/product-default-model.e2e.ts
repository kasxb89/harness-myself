/** First phone sign-in refreshes the actual composer from the deployment's authorized model catalog. */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createAssistantMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished } from 'vitest'
import disabledBannerFeed from '../../../packages/host/credits-index/tests/fixtures/announcement-banner-api/feed-banner-disabled.json' with { type: 'json' }
import notEligibleSurvey from '../../../packages/host/credits-index/tests/fixtures/onboarding-survey-api/not-eligible.json' with { type: 'json' }
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh } from './support.ts'

it.each(['deepseek-flash', 'deepseek-v4-pro', 'yunshu-flash', 'yunshu-flash-configured', 'ycapi-text-only', 'ycapi-capabilities-v2', 'ycapi-model-removed'])(
  'selects the deployment default %s after first sign-in without opening the model menu', async (scenario) => {
    const plainText = scenario === 'ycapi-text-only'
    const capabilityV2 = scenario === 'ycapi-capabilities-v2'
    const modelRemoval = scenario === 'ycapi-model-removed'
    let catalogReduced = false
    const v2Peers = ['capabilities-pending', 'capabilities-unavailable', 'capabilities-automatic', 'capabilities-image-unavailable', 'capabilities-always-on-effort']
    const v2Declaration = (id: string) => {
      const pending = id === 'capabilities-pending' || id === 'capabilities-unavailable'
      const automatic = id === 'capabilities-automatic'
      const partial = id === 'capabilities-image-unavailable'
      const alwaysEffort = id === 'capabilities-always-on-effort'
      const unavailable = id === 'capabilities-unavailable'
      return { schema_version: 2, revision: 'synthetic-capability-v2', checked_at: '2026-10-31T00:00:00Z',
        tools: !unavailable && !automatic, vision: !unavailable && !automatic && !partial, reasoning: !unavailable,
        stream: true, max_input_tokens: 32000,
        verification: { tools: pending ? 'unverified' : automatic ? 'unsupported' : 'supported',
          vision: pending || partial ? 'unverified' : automatic ? 'unsupported' : 'supported', reasoning: pending ? 'unverified' : 'supported' },
        input_modalities: automatic || partial || unavailable ? ['text'] : ['text', 'image'],
        tools_config: { protocol: 'openai-chat', roundtrip_verified: !pending && !automatic,
          verified_tool_choices: !pending && !automatic ? alwaysEffort ? ['named'] : ['auto'] : [], parallel_calls: 'unverified' },
        vision_config: { verified_transports: !pending && !automatic && !partial ? ['data_url'] : [],
          verified_mime_types: !pending && !automatic && !partial ? ['image/png', 'image/webp'] : [], billing: 'input_tokens',
          ...partial ? { operational_status: 'temporarily_unavailable', operational_reason: 'Synthetic image entry failure' } : {} },
        reasoning_mode: pending ? 'unknown' : automatic || alwaysEffort ? 'always_on' : 'configurable',
        reasoning_controls: { type: 'object', properties: pending || automatic ? {} : alwaysEffort ? { reasoning_effort: { type: 'string', enum: ['low', 'high'] } }
          : { enable_thinking: { type: 'boolean', default: false } }, additionalProperties: false },
        reasoning_omit_behavior: 'provider_default', reasoning_control_mapping: {}, operational_status: unavailable ? 'fixed_lane_unavailable' : 'available',
        ...unavailable ? { operational_reason: 'Synthetic fixed route is unavailable' } : {} }
    }
    const configured = scenario === 'yunshu-flash-configured'
    const preferred = configured ? 'yunshu-flash' : scenario
    const badge = configured ? '旗舰模型介绍由后台配置，适合内容创作和编程，可按任务选择使用'.padEnd(32, '。') : '旗舰模型'
    const description = configured ? '适合内容写作与编程。<b>后台介绍</b>'.padEnd(500, '界') : '云枢主力模型，适合日常问答、内容写作与编程'
    const root = await mkdtemp(join(tmpdir(), 'yunshu-first-login-model-'))
    const cleanup: { scaffold?: () => Promise<void>; browser?: () => Promise<void>; upstream?: () => Promise<void> } = {}
    onTestFinished(async () => {
      try { await cleanup.browser?.() }
      finally {
        try { await cleanup.scaffold?.() }
        finally {
          try { await cleanup.upstream?.() }
          finally { await rm(root, { recursive: true, force: true }) }
        }
      }
    })
    const requests: string[] = []
    const modelRequests: { authorization: string | undefined; body: Record<string, unknown> }[] = []
    const errors: string[] = []
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
        const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
        requests.push(path)
        response.setHeader('content-type', 'application/json')
        const answer = (data: object | null): void => { response.end(JSON.stringify({ success: true, data })) }
        if (path === '/harness/api/client-announcements' && request.method === 'GET') {
          response.end(JSON.stringify(disabledBannerFeed)); return
        }
        if (path === '/harness/api/user/onboarding-survey' && request.method === 'GET') {
          response.end(JSON.stringify(notEligibleSurvey)); return
        }
        if (path === '/harness/api/status') {
          answer({ quota_per_unit: 500_000, usd_exchange_rate: 7.3,
            client_model_config: { schema_version: 1, default_chat_model: catalogReduced ? 'capabilities-always-on-effort' : preferred,
              model_order: ['deepseek-flash', 'deepseek-v4-flash'] },
            ...configured ? { client_model_presentation: { schema_version: 1, models: {
              'yunshu-flash': { description, badge },
              'deepseek-flash': { description: '', badge: '' },
              'unauthorized-display-model': { description: '不得新增这个模型', badge: '不可用' },
            } } } : {} }); return
        }
        if (path === '/harness/api/user/phone/challenge') {
          answer({ challenge_id: 'synthetic-challenge', delivery_status: 'accepted',
            expires_at: Math.floor(Date.now() / 1000) + 300, resend_after_seconds: 60, expires_in_minutes: 5 }); return
        }
        if (path === '/harness/api/user/phone/login') {
          response.setHeader('set-cookie', 'new_api_refresh=synthetic-refresh; HttpOnly; Path=/harness/api/user/auth')
          answer({ access_token: 'synthetic-access', access_expires_at: Math.floor(Date.now() / 1000) + 900,
            relay_key: 'sk-synthetic-relay', relay_key_id: 9, user: { id: 7, username: 'synthetic-user', quota: 500_000 } }); return
        }
        if (path === '/harness/v1/models') {
          if (request.headers.authorization !== 'Bearer sk-synthetic-relay') {
            response.writeHead(403); response.end('{}'); return
          }
          const ids = modelRemoval ? [...catalogReduced ? [] : [preferred], 'capabilities-always-on-effort']
            : ['deepseek-v4-flash', 'deepseek-flash', 'yunshu-flash', 'deepseek-v4-pro', 'catalog-unknown', ...plainText ? [preferred] : [], ...capabilityV2 ? [preferred, ...v2Peers] : []]
          response.end(JSON.stringify({ data: ids.map(id =>
            ({ id, object: 'model', supported_endpoint_types: ['openai'], ...(capabilityV2 || modelRemoval) && (id === preferred || v2Peers.includes(id)) ? {
              kind: 'text', input_modalities: v2Declaration(id).input_modalities, context_window: 1000000, max_output_tokens: 8192,
              parameters: { 'x-text-capabilities': v2Declaration(id) },
            } : id !== 'ycapi-text-only' ? {} : {
              kind: 'text', input_modalities: ['text'], context_window: 32768, max_output_tokens: 8192, parameters: {
                'x-text-capabilities': { tools: false, vision: false, reasoning: false, stream: true, max_input_tokens: 32768 },
              },
            } })) })); return
        }
        if (path === '/harness/v1/chat/completions') {
          if (request.headers.authorization !== 'Bearer sk-synthetic-relay') {
            response.writeHead(403); response.end('{}'); return
          }
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected synthetic chat JSON object')
          modelRequests.push({ authorization: request.headers.authorization, body: body as Record<string, unknown> })
          response.setHeader('content-type', 'text/event-stream')
          response.end([
            ...preferred === 'yunshu-flash' && modelRequests.length === 1
              ? ['data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"Synthetic saved reasoning."},"index":0,"finish_reason":null}]}'] : [],
            `data: {"choices":[{"delta":{"role":"assistant","content":"CHAT_DIALECT_READY${modelRequests.length === 1 ? '' : '_FOLLOWUP'}"},"index":0,"finish_reason":null}]}`,
            'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
            'data: [DONE]', '',
          ].join('\n\n'))
          return
        }
        if (path === '/harness/api/pricing') { answer([]); return }
        if (path === '/harness/api/creation/content') {
          answer({ schemaVersion: 1, revision: 'synthetic', image: { templates: [] }, video: { templates: [] },
            guide: { title: '', body: '' } }); return
        }
        if (path === '/harness/api/log/self') { answer({ page: 1, page_size: 100, total: 0, items: [] }); return }
        if (path === '/harness/api/user/self') {
          answer({ id: 7, username: 'synthetic-user', group: 'product', quota: 500_000, used_quota: 0 }); return
        }
        if (path === '/harness/api/client-activity/heartbeat') {
          answer({ server_time: Math.floor(Date.now() / 1000), heartbeat_interval_seconds: 60 }); return
        }
        if (path === '/harness/api/user/auth/logout') { answer(null); return }
        errors.push(path)
        response.writeHead(404); response.end('{}')
      })().catch((error: unknown) => { errors.push(String(error)); response.destroy() })
    })
    cleanup.upstream = async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
        server.closeAllConnections()
      })
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Synthetic backend must bind a loopback port')
    const baseURL = `http://127.0.0.1:${String(address.port)}/harness`
    const overlay = join(root, 'product-model.patch.yml')
    await writeFile(overlay, JSON.stringify([
      { id: 'credits-index', config: { newApiBaseUrl: baseURL, stateDir: join(root, 'credits') } },
      { id: 'llm-pi-ai', config: { providers: { 'yunshu-local': {
        displayName: '云枢', api: 'openai-completions', baseURL: `${baseURL}/v1`, apiKeyEnv: 'YUNSHU_RELAY_TOKEN',
        models: [{ id: 'deepseek-v4-flash' }],
      } } } },
      { id: 'agent-default-model', config: { provider: 'yunshu-local', model: 'deepseek-v4-flash', followPolicy: true } },
      ...['ui-creative', 'dsh-market', 'dsh-skin-market'].map(id => ({ id, disabled: true })),
    ]))
    const scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    cleanup.scaffold = () => scaffold.close()
    const browser = await chromium.launch()
    cleanup.browser = () => browser.close()
    const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, colorScheme: 'dark', reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } })
    const tripwire = watchConsole(page)
    const promptResponses: unknown[] = []
    page.on('response', (response) => {
      if (new URL(response.url()).pathname !== '/api/session/prompt') return
      void response.json().then((value: unknown) => { promptResponses.push(value) },
        (error: unknown) => { promptResponses.push({ readError: String(error) }) })
    })
    const evidenceRoot = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
    await mkdir(evidenceRoot, { recursive: true })
    const evidence = await mkdtemp(join(evidenceRoot, 'product-default-model-'))
    try {
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, '首次登录', false)
      const trigger = page.getByRole('button', { name: /^(?:请选择模型|选择模型)/u })
      await trigger.waitFor()
      await page.getByRole('button', { name: '余额', exact: true }).click()
      await page.getByRole('region', { name: '手机号登录', exact: true }).waitFor()
      await page.getByRole('textbox', { name: '手机号', exact: true }).fill('13800000000')
      await page.getByRole('button', { name: '发送验证码', exact: true }).click()
      await page.getByRole('status').filter({ hasText: '验证码已发送' }).waitFor()
      await page.getByRole('textbox', { name: '验证码', exact: true }).fill('123456')
      const started = performance.now()
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await expect.poll(() => trigger.textContent(), { timeout: 10_000 }).toBe(capabilityV2 || modelRemoval ? `${preferred}自动（渠道默认）` : preferred)
      const elapsedMs = performance.now() - started
      // No menu-opening gesture or 60-second sync is allowed to repair the first display.
      expect(elapsedMs).toBeLessThan(10_000)
      expect(await page.getByRole('menu', { name: '模型', exact: true }).count()).toBe(0)
      await trigger.click()
      await page.getByRole('menuitem', { name: /^模型/u }).click()
      const modelMenu = page.getByRole('group', { name: '模型与推理等级', exact: true })
      await modelMenu.getByRole('menuitemradio', { name: preferred, exact: true }).waitFor()
      expect(await modelMenu.getByRole('menuitemradio', { name: preferred, exact: true }).getAttribute('aria-checked')).toBe('true')
      if (plainText) {
        const row = modelMenu.getByRole('menuitemradio', { name: preferred, exact: true })
        await expect.poll(() => row.textContent()).toContain('当前渠道为文本配置')
        expect(await row.textContent()).toContain('当前渠道未启用工具')
        expect(await row.textContent()).toContain('32,768')
        expect(await trigger.textContent()).not.toContain('High')
        for (const theme of ['dark', 'light'] as const) {
          await page.emulateMedia({ colorScheme: theme })
          await page.screenshot({ path: join(evidence, `text-capabilities-${theme}.png`), animations: 'disabled' })
        }
      }
      if (capabilityV2) {
        const supported = modelMenu.getByRole('menuitemradio', { name: preferred, exact: true })
        expect(await supported.textContent()).toContain('工具：已核实支持')
        expect(await supported.textContent()).toContain('识图：已核实支持')
        const pending = modelMenu.getByRole('menuitemradio', { name: 'capabilities-pending', exact: true })
        expect(await pending.textContent()).toContain('工具：待核实')
        expect(await pending.textContent()).not.toContain('不支持')
        expect(await modelMenu.getByRole('menuitemradio', { name: 'capabilities-unavailable', exact: true }).textContent()).toContain('当前渠道暂不可用')
        expect(await modelMenu.getByRole('menuitemradio', { name: 'capabilities-automatic', exact: true }).textContent()).toContain('始终推理（不可关闭）')
        const partial = modelMenu.getByRole('menuitemradio', { name: 'capabilities-image-unavailable', exact: true })
        expect(await partial.textContent()).toContain('图片输入暂不可用')
        expect(await partial.textContent()).toContain('识图：待核实')
        expect(await partial.textContent()).not.toContain('识图：当前渠道不支持')
        const always = modelMenu.getByRole('menuitemradio', { name: 'capabilities-always-on-effort', exact: true })
        expect(await always.textContent()).toContain('始终推理（不可关闭）')
        expect(await always.textContent()).toContain('指定工具：已核实')
        expect(await always.textContent()).toContain('工具自动选择：待核实')
        for (const theme of ['dark', 'light'] as const) {
          await page.emulateMedia({ colorScheme: theme })
          await page.screenshot({ path: join(evidence, `capabilities-v2-${theme}.png`), animations: 'disabled' })
        }
      }
      if (preferred === 'yunshu-flash') {
        const flagship = modelMenu.getByRole('menuitemradio', { name: 'yunshu-flash', exact: true })
        await flagship.getByText(badge, { exact: true }).waitFor()
        await flagship.getByText(description, { exact: true }).waitFor()
        if (configured) {
          expect(await flagship.locator('b').count()).toBe(0)
          expect(await modelMenu.getByRole('menuitemradio', { name: 'unauthorized-display-model', exact: true }).count()).toBe(0)
          const cleared = modelMenu.getByRole('menuitemradio', { name: 'deepseek-flash', exact: true })
          expect(await cleared.textContent()).toBe('deepseek-flash')
        }
        await modelMenu.getByText('响应速度会随任务、推理等级与网络状况变化', { exact: true }).waitFor()
        await page.getByRole('button', { name: 'AI 创作', exact: true }).waitFor()
        for (const [theme, width] of [['dark', 1440], ['light', 900]] as const) {
          await page.emulateMedia({ colorScheme: theme })
          await page.setViewportSize({ width, height: 1000 })
          await page.evaluate(async () => {
            await document.fonts.ready
            await new Promise<void>(resolve => requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) }))
          })
          const composer = await page.locator('[data-composer-card]').first().boundingBox()
          expect(composer).not.toBeNull()
          expect(composer!.x).toBeGreaterThanOrEqual(0)
          expect(composer!.x + composer!.width).toBeLessThanOrEqual(width)
          const box = await modelMenu.boundingBox()
          expect(box).not.toBeNull()
          expect(box!.x).toBeGreaterThanOrEqual(0)
          expect(box!.y).toBeGreaterThanOrEqual(0)
          expect(box!.x + box!.width).toBeLessThanOrEqual(width)
          expect(box!.y + box!.height).toBeLessThanOrEqual(1000)
          if (configured) {
            const badgeBox = await flagship.getByText(badge, { exact: true }).boundingBox()
            expect(badgeBox).not.toBeNull()
            expect(badgeBox!.x).toBeGreaterThanOrEqual(box!.x)
            expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(box!.x + box!.width)
          }
          await page.screenshot({ path: join(evidence, `model-guidance-${theme}.png`), animations: 'disabled' })
        }
        const search = page.getByRole('searchbox', { name: '搜索模型…', exact: true })
        await search.fill('yunshu-flash')
        await expect.poll(() => modelMenu.getByRole('menuitemradio').count()).toBe(1)
        await search.press('Enter')
        await modelMenu.waitFor({ state: 'detached' })
        await trigger.click()
        await page.getByRole('menuitem', { name: /^模型/u }).click()
      }
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      if (preferred === 'yunshu-flash') {
        await page.getByRole('button', { name: '添加文件或调用指令', exact: true }).click()
        await page.getByRole('option', { name: /^模型/u }).click()
        const commandMenu = page.locator('[aria-label="/model 选项"]')
        await commandMenu.getByText(badge, { exact: true }).waitFor()
        await commandMenu.getByText(description, { exact: true }).waitFor()
        const flagship = commandMenu.getByRole('option', { name: `yunshu-flash ${badge}`, exact: true })
        await expect.poll(() => flagship.getAttribute('aria-describedby')).not.toBeNull()
        expect(await flagship.evaluate(element => document.getElementById(element.getAttribute('aria-describedby')!)?.textContent))
          .toBe(description)
        if (configured) {
          const menuBox = await commandMenu.boundingBox()
          const badgeBox = await commandMenu.getByText(badge, { exact: true }).boundingBox()
          expect(menuBox).not.toBeNull()
          expect(badgeBox).not.toBeNull()
          expect(menuBox!.x).toBeGreaterThanOrEqual(0)
          expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(900)
          expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(menuBox!.x + menuBox!.width)
        }
        await page.screenshot({ path: join(evidence, 'model-command-guidance.png'), animations: 'disabled' })
        await page.keyboard.press('Escape')
      }
      const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
      if (plainText) {
        await page.getByRole('button', { name: '添加文件或调用指令', exact: true }).click()
        await page.getByRole('option', { name: /^模型/u }).click()
        const commandMenu = page.locator('[aria-label="/model 选项"]')
        await commandMenu.getByText(/当前渠道为文本配置/u).waitFor()
        expect(await commandMenu.innerText()).toContain('32,768')
        await page.keyboard.press('Escape')
        await composer.evaluate((element) => {
          const clipboardData = new DataTransfer()
          clipboardData.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'blocked.png', { type: 'image/png' }))
          clipboardData.setData('text/plain', '保留图片同时粘贴的文字')
          element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
        })
        await expect.poll(() => composer.innerText()).toContain('保留图片同时粘贴的文字')
        await page.getByText('当前渠道未开放所需的图片或文件能力，请移除附件或切换模型；文字草稿已保留', { exact: true }).waitFor()
        expect(modelRequests).toHaveLength(0)
      }
      if (capabilityV2) {
        await page.getByRole('button', { name: '添加文件或调用指令', exact: true }).click()
        await page.getByRole('option', { name: /^模型/u }).click()
        const commandMenu = page.locator('[aria-label="/model 选项"]')
        await commandMenu.getByRole('option').filter({ hasText: 'capabilities-pending' }).getByText(/工具：待核实/u).waitFor()
        expect(await commandMenu.innerText()).toContain('始终推理（不可关闭）')
        const partial = commandMenu.getByRole('option').filter({ hasText: 'capabilities-image-unavailable' })
        expect(await partial.innerText()).toContain('图片输入暂不可用')
        expect(await partial.innerText()).toContain('识图：待核实')
        const always = commandMenu.getByRole('option').filter({ hasText: 'capabilities-always-on-effort' })
        expect(await always.innerText()).toContain('指定工具：已核实')
        expect(await always.innerText()).toContain('工具自动选择：待核实')
        await page.keyboard.press('Escape')
      }
      const settled = scaffold.whenTurnSettled()
      if (modelRemoval) {
        const value = scaffold.ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai')?.value as {
          providers?: Record<string, { models?: readonly { id: string }[] }>
        } | undefined
        const models = value?.providers?.['yunshu-local']?.models
        if (models === undefined) throw new Error('Expected the real product provider models')
        const limits = await scaffold.ctx.llm.resolveModelInfo('yunshu-local', preferred)
        const scope = limits.limits?.managedScope
        if (scope === undefined) throw new Error('Expected the signed-in product capacity scope')
        await scaffold.ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'yunshu-local', 'modelLimitOverrides'],
          value: Object.fromEntries(models.map(model => [model.id, { scope, maxTokens: 123 }])) }])
      }
      await composer.fill('Synthetic chat parameter check')
      await composer.press('Enter')
      const sessionId = await settled
      await page.getByText('CHAT_DIALECT_READY', { exact: true }).waitFor()
      const session = scaffold.ctx.sessions.get(sessionId)
      expect(session?.requestHeader()?.config).toMatchObject({ provider: 'yunshu-local', model: preferred })
      expect(modelRequests).toHaveLength(1)
      const wire = modelRequests[0]!.body
      expect(modelRequests[0]?.authorization).toBe('Bearer sk-synthetic-relay')
      expect(wire).toMatchObject({ model: preferred, stream: true, stream_options: { include_usage: true } })
      expect(wire['max_tokens']).toEqual(expect.any(Number))
      expect(wire['max_tokens']).toBeGreaterThan(0)
      expect(wire['messages']).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user', content: 'Synthetic chat parameter check' }),
      ]))
      if (plainText) expect(wire).not.toHaveProperty('tools')
      else expect(wire['tools']).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function' })]))
      for (const field of ['store', 'max_completion_tokens', 'temperature', 'top_p', 'thinking', 'reasoning_effort', 'enable_thinking']) {
        expect(wire).not.toHaveProperty(field)
      }
      expect(wire).not.toHaveProperty('tool_choice')
      if (modelRemoval) {
        expect(wire['max_tokens']).toBe(123)
        const draft = 'Continue this request with its original PNG and file when the saved model is removed'
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
        await composer.fill(draft)
        await page.locator('input[type="file"]').setInputFiles([
          { name: 'retained.png', mimeType: 'image/png', buffer: png },
          { name: 'retained.txt', mimeType: 'text/plain', buffer: Buffer.from('retained original file bytes') },
        ])
        const image = page.getByRole('button', { name: '移除图片 retained.png', exact: true })
        await image.waitFor()
        await page.getByTitle('retained.txt', { exact: true }).waitFor()
        const rail = page.getByRole('group', { name: '待发送附件', exact: true })
        const send = page.getByRole('button', { name: '发送消息', exact: true })
        await expect.poll(() => send.isDisabled()).toBe(false)
        catalogReduced = true
        await scaffold.ctx.llm.listModels('yunshu-local')
        await expect(scaffold.ctx.llm.resolveModelInfo('yunshu-local', preferred)).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
        await expect.poll(() => trigger.textContent()).toBe('请选择模型')
        expect(session?.requestHeader()?.config.model).toBe(preferred)
        expect(modelRequests).toHaveLength(1)
        expect(await composer.innerText()).toBe(draft)
        expect(await image.count()).toBe(1)
        expect(await rail.locator(':scope > *').count()).toBe(2)
        await expect.poll(() => send.isDisabled()).toBe(false)
        await page.screenshot({ path: join(evidence, 'removed-model-before-send.png'), animations: 'disabled' })
        const fallbackSettled = scaffold.whenTurnSettled()
        await send.click()
        expect(await fallbackSettled).toBe(sessionId)
        expect(modelRequests).toHaveLength(2)
        expect(modelRequests[1]?.body).toMatchObject({ model: 'capabilities-always-on-effort', max_tokens: 123 })
        expect(session?.requestHeader()?.config.model).toBe('capabilities-always-on-effort')
        await expect.poll(() => trigger.textContent()).toContain('capabilities-always-on-effort')
        await expect.poll(() => composer.innerText()).toBe('')
        expect(await rail.count()).toBe(0)
        const accepted = session?.snapshotEvents().filter(event => event.type === 'user/message'
          && event.data.source.kind === 'user' && event.data.content.some(part => part.type === 'text' && part.text === draft))
        expect(accepted).toHaveLength(1)
        const acceptedMessage = accepted?.[0]
        if (acceptedMessage?.type !== 'user/message') throw new Error('Expected the original accepted human request')
        const acceptedSource = acceptedMessage.data.source
        const acceptedRequestId: unknown = 'rpcId' in acceptedSource ? acceptedSource.rpcId : undefined
        if (acceptedSource.kind !== 'user' || typeof acceptedRequestId !== 'string' || acceptedRequestId === '') {
          throw new Error('Expected the original human submission identity')
        }
        expect(acceptedMessage.data.content.filter(part => part.type === 'image')).toHaveLength(1)
        expect(acceptedMessage.data.content.filter(part => part.type === 'file')).toHaveLength(1)
        const fresh = await scaffold.ctx.sessionController.create({ cwd: scaffold.workspaceCwd })
        const freshSession = scaffold.ctx.sessions.get(fresh.sessionId)
        if (freshSession === undefined) throw new Error('Expected the new blank Session')
        const freshSelection = scaffold.ctx.sessionProjections.snapshot(freshSession).values.modelSelection?.next
          ?? scaffold.ctx.agentDefaultModel.currentSelection()
        expect(freshSelection).toMatchObject({ provider: 'yunshu-local', model: 'capabilities-always-on-effort' })
        await writeFile(join(evidence, 'removed-model-result.json'), JSON.stringify({ syntheticLoopbackOnly: true,
          removed: preferred, fallback: 'capabilities-always-on-effort', modelPostsBeforeRemoval: 1,
          modelPostsAfterSingleSend: 2, automaticFallback: true, acceptedHumanRequests: accepted?.length,
          originalPrompt: draft, retainedAttachments: ['retained.png', 'retained.txt'], manualMaxTokens: 123,
          freshSelection, modelRequests }, null, 2) + '\n')
        await page.screenshot({ path: join(evidence, 'removed-model-automatic-fallback.png'), animations: 'disabled' })
      }
      if (plainText) {
        if (session === undefined) throw new Error('Expected the real text-only Session')
        session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
          source: { provider: 'legacy-fixture', model: 'tool-capable' },
          content: [{ type: 'tool-call', id: ToolCallId('historical-tool'), name: 'historical-fixture', arguments: '{}' }],
        }) }, { surfaceOp: 'append' })
        await composer.fill('工具历史被拒绝后也要保留这段草稿')
        await composer.press('Enter')
        await page.getByText('当前渠道未开放此聊天所需的工具能力，请切换支持工具的模型，或新建纯文本聊天；草稿已保留', { exact: true }).waitFor()
        await expect.poll(() => composer.innerText()).toContain('工具历史被拒绝后也要保留这段草稿')
        expect(modelRequests).toHaveLength(1)
        await page.screenshot({ path: join(evidence, 'text-history-draft-preserved.png'), animations: 'disabled' })
      }
      if (capabilityV2) {
        const metadata = await scaffold.ctx.llm.resolveModelInfo('yunshu-local', preferred)
        const off = metadata.reasoning?.efforts.find(value => value.id === 'off')
        if (off === undefined) throw new Error('Expected exact boolean Off reasoning control')
        await composer.fill('Synthetic actual image with explicit thinking off')
        await composer.evaluate((element) => {
          const data = new DataTransfer()
          const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), value => value.charCodeAt(0))
          data.items.add(new File([png], 'capability.png', { type: 'image/png' }))
          element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
        })
        const retainedImage = page.getByRole('button', { name: '移除图片 capability.png', exact: true })
        await retainedImage.waitFor()
        await trigger.click()
        await page.getByRole('menuitem', { name: /^模型/u }).click()
        await page.getByRole('menuitemradio', { name: 'capabilities-image-unavailable', exact: true }).click()
        await expect.poll(() => trigger.textContent()).toBe('capabilities-image-unavailable自动（渠道默认）')
        await page.getByText('当前渠道图片输入暂不可用，请移除图片、稍后重试或切换模型；草稿及已有附件已保留', { exact: true }).waitFor()
        const send = page.getByRole('button', { name: '发送消息', exact: true })
        expect(await send.isDisabled()).toBe(true)
        await composer.press('Enter')
        expect(modelRequests).toHaveLength(1)
        expect(await composer.innerText()).toBe('Synthetic actual image with explicit thinking off')
        expect(await retainedImage.count()).toBe(1)
        await page.screenshot({ path: join(evidence, 'capabilities-v2-partial-image-draft.png'), animations: 'disabled' })
        await trigger.click()
        await page.getByRole('menuitem', { name: /^模型/u }).click()
        await page.getByRole('menuitemradio', { name: preferred, exact: true }).click()
        await expect.poll(() => trigger.textContent()).toBe(`${preferred}自动（渠道默认）`)
        await trigger.click()
        await page.getByRole('menuitem', { name: /^推理等级/u }).click()
        await page.getByRole('menuitemradio', { name: off.name, exact: true }).click()
        await expect.poll(() => trigger.textContent()).toContain(off.name)
        expect(await send.isDisabled()).toBe(false)
        const imageSettled = scaffold.whenTurnSettled()
        await composer.press('Enter')
        expect(await imageSettled).toBe(sessionId)
        await expect.poll(() => modelRequests.length).toBe(2)
        const imageWire = modelRequests[1]!.body
        await writeFile(join(evidence, 'capabilities-v2-wire-image.json'), JSON.stringify({ synthetic: true, modelRequests }, null, 2) + '\n')
        expect(imageWire['enable_thinking']).toBe(false)
        expect(imageWire).not.toHaveProperty('reasoning_effort')
        const messages = imageWire['messages']
        if (!Array.isArray(messages)) throw new Error('Expected actual image request messages')
        const imageUrls = messages.flatMap((message: { content?: unknown }) => !Array.isArray(message.content) ? []
          : message.content.flatMap((part: { type?: string; image_url?: { url?: string } }) => part.type === 'image_url'
            && typeof part.image_url?.url === 'string' ? [part.image_url.url] : []))
        expect(imageUrls).toHaveLength(1)
        const imageUrl = imageUrls[0]!
        expect(imageUrl).toMatch(/^data:image\/webp;base64,/u)
        const dimensions = await page.evaluate(async (url) => {
          const response = await fetch(url)
          const bitmap = await createImageBitmap(await response.blob())
          const result = { width: bitmap.width, height: bitmap.height }
          bitmap.close()
          return result
        }, imageUrl)
        expect(dimensions).toEqual({ width: 1, height: 1 })
        expect(session?.requestHeader()?.config.reasoningEffort).toBe('off')
        await trigger.click()
        await page.getByRole('menuitem', { name: /^推理等级/u }).click()
        await page.getByRole('menuitemradio', { name: '自动（渠道默认）', exact: true }).click()
        const autoSettled = scaffold.whenTurnSettled()
        await composer.fill('Synthetic explicit Auto must omit all reasoning fields')
        await composer.press('Enter')
        expect(await autoSettled).toBe(sessionId)
        await expect.poll(() => modelRequests.length).toBe(3)
        expect(modelRequests[2]!.body).not.toHaveProperty('enable_thinking')
        expect(modelRequests[2]!.body).not.toHaveProperty('reasoning_effort')
        expect(session?.requestHeader()?.config.reasoningEffort).toBeUndefined()
        await writeFile(join(evidence, 'capabilities-v2-wire-complete.json'), JSON.stringify({ synthetic: true, dimensions, modelRequests }, null, 2) + '\n')
        await page.screenshot({ path: join(evidence, 'capabilities-v2-image-and-auto.png'), animations: 'disabled' })

        const alwaysModel = 'capabilities-always-on-effort'
        const alwaysMetadata = await scaffold.ctx.llm.resolveModelInfo('yunshu-local', alwaysModel)
        const high = alwaysMetadata.reasoning?.efforts.find(value => value.id === 'high')
        if (high === undefined) throw new Error('Expected exact always-on effort enum')
        await trigger.click()
        await page.getByRole('menuitem', { name: /^模型/u }).click()
        await page.getByRole('menuitemradio', { name: alwaysModel, exact: true }).click()
        await expect.poll(() => trigger.textContent()).toBe(`${alwaysModel}自动（渠道默认）`)
        await trigger.click()
        await page.getByRole('menuitem', { name: /^推理等级/u }).click()
        const effortMenu = page.getByRole('menu', { name: '模型与推理等级', exact: true })
        expect(await effortMenu.getByRole('menuitemradio', { name: 'Off', exact: true }).count()).toBe(0)
        expect(await effortMenu.getByRole('menuitemradio', { name: 'none', exact: true }).count()).toBe(0)
        await page.screenshot({ path: join(evidence, 'capabilities-v2-always-on-strength.png'), animations: 'disabled' })
        await effortMenu.getByRole('menuitemradio', { name: high.name, exact: true }).click()
        const strengthSettled = scaffold.whenTurnSettled()
        await composer.fill('Synthetic always-on high strength with normal automatic tool choice')
        await composer.press('Enter')
        expect(await strengthSettled).toBe(sessionId)
        await expect.poll(() => modelRequests.length).toBe(4)
        expect(modelRequests[3]!.body).toMatchObject({ model: alwaysModel, reasoning_effort: 'high', max_tokens: 8192 })
        expect(modelRequests[3]!.body).not.toHaveProperty('enable_thinking')
        expect(modelRequests[3]!.body).not.toHaveProperty('tool_choice')
        expect(session?.requestHeader()?.config.reasoningEffort).toBe('high')
        await trigger.click()
        await page.getByRole('menuitem', { name: /^推理等级/u }).click()
        await page.getByRole('menuitemradio', { name: '自动（渠道默认）', exact: true }).click()
        const strengthAutoSettled = scaffold.whenTurnSettled()
        await composer.fill('Synthetic always-on Auto omits effort without turning reasoning off')
        await composer.press('Enter')
        expect(await strengthAutoSettled).toBe(sessionId)
        await expect.poll(() => modelRequests.length).toBe(5)
        expect(modelRequests[4]!.body).toMatchObject({ model: alwaysModel, max_tokens: 8192 })
        expect(modelRequests[4]!.body).not.toHaveProperty('reasoning_effort')
        expect(modelRequests[4]!.body).not.toHaveProperty('enable_thinking')
        expect(modelRequests[4]!.body).not.toHaveProperty('tool_choice')
        expect(session?.requestHeader()?.config.reasoningEffort).toBeUndefined()
        await writeFile(join(evidence, 'capabilities-v2-always-on-wire-complete.json'), JSON.stringify({ synthetic: true, dimensions, modelRequests }, null, 2) + '\n')
        await page.screenshot({ path: join(evidence, 'capabilities-v2-always-on-auto.png'), animations: 'disabled' })

      }
      if (preferred === 'yunshu-flash') {
        const followupSettled = scaffold.whenTurnSettled()
        await composer.fill('Synthetic follow-up parameter check')
        await composer.press('Enter')
        expect(await followupSettled).toBe(sessionId)
        await page.getByText('CHAT_DIALECT_READY_FOLLOWUP', { exact: true }).waitFor()
        expect(modelRequests).toHaveLength(2)
        const followup = modelRequests[1]!.body
        expect(followup).toMatchObject({ model: preferred, stream: true })
        expect(followup['tools']).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function' })]))
        expect(followup['messages']).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: 'assistant', content: 'CHAT_DIALECT_READY', reasoning_content: 'Synthetic saved reasoning.' }),
          expect.objectContaining({ role: 'user', content: 'Synthetic follow-up parameter check' }),
        ]))
        expect(followup).not.toHaveProperty('tool_choice')
      }
      expect(requests.filter(path => path.endsWith('/phone/challenge'))).toHaveLength(1)
      expect(requests.filter(path => path.endsWith('/phone/login'))).toHaveLength(1)
      expect(errors).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
      await page.screenshot({ path: join(evidence, 'first-login-selected-model.png'), animations: 'disabled' })
      await writeFile(join(evidence, 'result.json'), JSON.stringify({ preferred, configured, badge, description, elapsedMs, requests,
        modelCalls: modelRequests.length, modelRequest: { model: wire['model'], max_tokens: wire['max_tokens'],
          stream: wire['stream'], stream_options: wire['stream_options'],
          forbiddenFieldsAbsent: true, toolsPresent: !plainText },
        historicalReasoningReplayChecked: preferred === 'yunshu-flash',
        capabilityV2, v2BooleanOffAndAutoWireChecked: capabilityV2, actualImageDataURLChecked: capabilityV2,
        partialImageOutageDraftPreserved: capabilityV2, alwaysOnEffortAndAutoChecked: capabilityV2,
        namedOnlyToolEvidenceChecked: capabilityV2,
        requestHeader: session?.requestHeader()?.config,
        realSMS: 0, realUpstreamCalls: 0, guidanceChecked: preferred === 'yunshu-flash', pageErrors: tripwire.pageErrors, errors }, null, 2) + '\n')
    } catch (error) {
      await page.screenshot({ path: join(evidence, 'failure.png'), animations: 'disabled' })
      await writeFile(join(evidence, 'failure.json'), JSON.stringify({ errors, requests, promptResponses,
        failure: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
        pageErrors: tripwire.pageErrors, visible: await page.locator('body').innerText() }, null, 2) + '\n')
      throw error
    }
  },
)
