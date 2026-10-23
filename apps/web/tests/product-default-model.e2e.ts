/** First phone sign-in refreshes the actual composer from the deployment's authorized model catalog. */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh } from './support.ts'

it.each(['deepseek-flash', 'deepseek-v4-pro', 'yunshu-flash', 'yunshu-flash-configured'])(
  'selects the deployment default %s after first sign-in without opening the model menu', async (scenario) => {
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
        if (path === '/harness/api/status') {
          answer({ quota_per_unit: 500_000, usd_exchange_rate: 7.3,
            client_model_config: { schema_version: 1, default_chat_model: preferred,
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
          response.end(JSON.stringify({ data: ['deepseek-v4-flash', 'deepseek-flash', 'yunshu-flash', 'deepseek-v4-pro', 'catalog-unknown'].map(id =>
            ({ id, object: 'model', supported_endpoint_types: ['openai'] })) })); return
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
      await expect.poll(() => trigger.textContent(), { timeout: 10_000 }).toBe(preferred)
      const elapsedMs = performance.now() - started
      // No menu-opening gesture or 60-second sync is allowed to repair the first display.
      expect(elapsedMs).toBeLessThan(10_000)
      expect(await page.getByRole('menu', { name: '模型', exact: true }).count()).toBe(0)
      await trigger.click()
      await page.getByRole('menuitem', { name: /^模型/u }).click()
      const modelMenu = page.getByRole('group', { name: '模型与推理等级', exact: true })
      await modelMenu.getByRole('menuitemradio', { name: preferred, exact: true }).waitFor()
      expect(await modelMenu.getByRole('menuitemradio', { name: preferred, exact: true }).getAttribute('aria-checked')).toBe('true')
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
      const settled = scaffold.whenTurnSettled()
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
      expect(wire['tools']).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function' })]))
      for (const field of ['store', 'max_completion_tokens', 'temperature', 'top_p', 'thinking', 'reasoning_effort', 'enable_thinking']) {
        expect(wire).not.toHaveProperty(field)
      }
      expect(wire).not.toHaveProperty('tool_choice')
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
          forbiddenFieldsAbsent: true, toolsPresent: true },
        historicalReasoningReplayChecked: preferred === 'yunshu-flash',
        requestHeader: session?.requestHeader()?.config,
        realSMS: 0, realUpstreamCalls: 0, guidanceChecked: preferred === 'yunshu-flash', pageErrors: tripwire.pageErrors, errors }, null, 2) + '\n')
    } catch (error) {
      await page.screenshot({ path: join(evidence, 'failure.png'), animations: 'disabled' })
      await writeFile(join(evidence, 'failure.json'), JSON.stringify({ errors, requests,
        pageErrors: tripwire.pageErrors, visible: await page.locator('body').innerText() }, null, 2) + '\n')
      throw error
    }
  },
)
