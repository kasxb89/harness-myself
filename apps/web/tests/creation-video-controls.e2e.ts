/** Video browsing stays interactive while original-task admission prevents paid submission. */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { catalogFromPricing } from '../../../packages/host/credits-index/src/media.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

const ACCOUNT = 'video-controls-qa'
const MODEL_ID = 'lec-mj-seedance-2-5-cd-720p'
const MODEL_LABEL = 'Seedance 2.5 · 720p · 30秒（线路1）'
const TEMPLATE_TITLE = '手冲咖啡时刻'
const TEMPLATE_PROMPT = '中文镜头脚本：保持杯具与人物一致，缓慢推进至咖啡表面。'
const imageMode = {
  title: { zh: '' }, description: { zh: '' }, promptPlaceholder: { zh: '' }, categories: [], presets: [],
  templates: [{ id: 'poster', categoryId: null, title: { zh: '商品海报' }, description: { zh: '图片创作草稿' },
    prompt: { zh: '保持主体的中文海报提示词' }, coverAssetId: null, demoVideoAssetId: null, sortOrder: 0, status: 'published' }],
}
const templateMode = {
  title: { zh: '你想做什么？' }, description: { zh: '从镜头脚本开始' }, promptPlaceholder: { zh: '' },
  categories: [], presets: [], templates: [{ id: 'coffee', categoryId: null, title: { zh: TEMPLATE_TITLE },
    description: { zh: '以连续镜头呈现手冲咖啡' }, prompt: { zh: TEMPLATE_PROMPT }, coverAssetId: null,
    demoVideoAssetId: null, sortOrder: 0, status: 'published' }],
}

it.each(['no-session', 'unknown', 'pending', 'read-failed'] as const)(
  'opens model, parameter and script previews with %s admission while keeping generation paused', async (admission) => {
    const scaffold = await launchWebScaffold({})
    try {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, colorScheme: 'dark',
          viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
        page.setDefaultTimeout(10_000)
        const tripwire = watchConsole(page)
        const directory = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
        await mkdir(directory, { recursive: true })
        const evidence = await mkdtemp(join(directory, `creation-video-controls-${admission}-`))
        const paidRequests: string[] = [], unexpectedReads: string[] = [], projectReads: string[] = [], uploadedMaterials: string[] = []
        let catalogFailure: 'network' | 'service' | 'invalid' | null = null
        let recordReadBlocked = admission === 'read-failed'
        let recordCheckReleased = false
        const submitGeometry: object[] = []
        const failureScreens: string[] = []
        let controlState: object | null = null
        await page.route('**/artifacts/api/list', route => route.fulfill({ status: 200, json: { items: [] } }))
        await page.route('**/credits/api/**', async (route) => {
          const request = route.request(), url = new URL(request.url())
          const json = async (payload: object): Promise<void> => route.fulfill({ status: 200, json: { ok: true, payload } })
          if (url.pathname === '/credits/api/session') {
            await json({ signedIn: true, creditsPerYuan: 1000, account: { id: ACCOUNT } })
          } else if (url.pathname === '/credits/api/summary') await json({ balance_points: 10000 })
          else if (url.pathname === '/credits/api/media/catalog') {
            if (catalogFailure === 'network') { await route.abort('internetdisconnected'); return }
            if (catalogFailure === 'service') { await route.fulfill({ status: 503, body: 'private upstream diagnostic' }); return }
            if (catalogFailure === 'invalid') { await route.fulfill({ status: 200, contentType: 'application/json', body: '{' }); return }
            const catalog = catalogFromPricing([{ model_name: 'yunshu-internal-gpt-image-2', display_name: '图片模型',
              supported_endpoint_types: ['image-generation'] }, { model_name: MODEL_ID, display_name: MODEL_LABEL,
              supported_endpoint_types: ['openai-video'] }, { model_name: 'MiniMax-H3', display_name: 'MiniMax-H3',
              supported_endpoint_types: ['openai-video'] }], 'product')
            await json({ image: catalog.filter(model => model.kind === 'image'), video: catalog.filter(model => model.kind === 'video') })
          } else if (url.pathname === '/credits/api/creation/content') {
            await json({ schemaVersion: 1, revision: 'video-controls-qa', image: imageMode, video: templateMode })
          } else if (url.pathname === '/credits/api/creative/projects') {
            const sessionId = url.searchParams.get('session_id')
            if (sessionId !== null) projectReads.push(sessionId)
            if (recordReadBlocked && sessionId !== null) {
              await route.fulfill({ status: 503, json: { ok: false, code: 'SERVER_BUSY' } })
            } else {
              await json({ accountId: ACCOUNT, projects: sessionId === null || admission === 'read-failed' ? [] : [{ id: 'cp_original', sessionId, kind: 'video',
                tasks: [{ id: 'op_original', status: admission === 'pending' ? 'running' : 'unknown', canQuery: admission === 'pending',
                  ...admission === 'pending' ? { videoReceipt: { taskId: 'original-video-task', model: MODEL_ID,
                    route: '/v1/videos', phase: 'accepted', backendFingerprint: 'a'.repeat(64) } } : {} }] }] })
            }
          } else if (url.pathname === '/credits/api/chat-usage') {
            await json({ scope: 'chat-model', status: 'unavailable', settledRequests: 0, totalRequests: 0, accountId: ACCOUNT })
          } else if (url.pathname === '/credits/api/usage') {
            await json({ rows: [], asOf: new Date().toISOString(), delayMinutes: 0 })
          } else if (url.pathname === '/credits/api/assets' && request.method() === 'POST') {
            uploadedMaterials.push(decodeURIComponent(request.headers()['x-file-name'] ?? ''))
            await route.fulfill({ status: 200, json: { ok: true, asset: {
              assetId: 'ma_videocontrolsreference', sizeBytes: request.postDataBuffer()?.length ?? 0,
            } } })
          } else if (request.method() !== 'GET' && request.method() !== 'HEAD') {
            paidRequests.push(`${request.method()} ${url.pathname}`)
            await route.abort('blockedbyclient')
          } else {
            unexpectedReads.push(url.pathname)
            await route.fulfill({ status: 404, json: { ok: false, code: 'UNEXPECTED_FIXTURE_READ' } })
          }
        })
        try {
          await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          if (admission !== 'no-session') await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
          await page.getByRole('button', { name: 'AI 创作', exact: true }).click()
          const images = page.locator('#imagegen')
          await expect.poll(() => images.getByRole('combobox', { name: '模型', exact: true }).innerText()).toContain('图片模型')
          await page.screenshot({ path: join(evidence, 'image-initial-controls.png'), animations: 'disabled' })
          if (admission === 'no-session') {
            const imageModel = images.getByRole('combobox', { name: '模型', exact: true })
            await expect.poll(() => imageModel.innerText()).toContain('图片模型')
            expect(await imageModel.isEnabled()).toBe(true)
            const imageParameters = images.getByRole('group', { name: '图片规格', exact: true })
            await imageParameters.getByRole('combobox', { name: '分辨率', exact: true }).selectOption('2k')
            await images.getByRole('button', { name: /^商品海报/ }).click()
            expect(await images.getByRole('textbox', { name: '画面描述', exact: true }).inputValue()).toBe('保持主体的中文海报提示词')
            expect(await images.getByRole('button', { name: '生成图片', exact: true }).isDisabled()).toBe(true)
            await page.screenshot({ path: join(evidence, 'image-no-session-draft-controls.png'), animations: 'disabled' })
          }
          await images.getByRole('tab', { name: '视频', exact: true }).click()
          const videos = page.locator('#videogen')
          const model = videos.getByRole('button', { name: '模型', exact: true })
          await expect.poll(() => model.innerText()).toContain(MODEL_LABEL)
          await page.screenshot({ path: join(evidence, 'video-initial-controls.png'), animations: 'disabled' })
          await videos.getByRole('button', { name: `预览 ${TEMPLATE_TITLE}`, exact: true }).waitFor()
          if (admission === 'read-failed') await videos.getByText(/^暂时无法核对原任务，生成保持暂停/).waitFor()
          else if (admission === 'pending') {
            await videos.getByText('生成中，任务已受理。请查询原任务，不要再次提交生成', { exact: true }).waitFor()
          }
          else if (admission !== 'no-session') {
            await videos.getByText('提交结果待确认，尚无可查询的任务编号。请保留原记录并核对任务与计费，不要再次提交生成', { exact: true }).waitFor()
          }
          if (admission === 'no-session') expect(projectReads).toEqual([])
          else expect(projectReads.length).toBeGreaterThan(0)
          const parameters = videos.getByLabel('视频参数：画面尺寸 1280x720，时长 30 秒', { exact: true })
          const template = videos.getByRole('button', { name: `预览 ${TEMPLATE_TITLE}`, exact: true })
          const parameterGroup = videos.getByRole('group', { name: '视频参数', exact: true })
          controlState = { modelEnabled: await model.isEnabled(), parametersVisible: await parameterGroup.isVisible(),
            templateEnabled: await template.isEnabled() }
          expect(controlState).toEqual({ modelEnabled: true, parametersVisible: true, templateEnabled: true })
          await model.click()
          await page.getByRole('menuitem', { name: MODEL_LABEL, exact: true }).waitFor()
          await page.screenshot({ path: join(evidence, 'model-menu.png'), animations: 'disabled' })
          await page.keyboard.press('Escape')
          await parameters.waitFor()
          await parameterGroup.getByRole('button', { name: '1280x720', exact: true }).waitFor()
          await parameterGroup.getByRole('button', { name: '30 秒', exact: true }).waitFor()
          await page.screenshot({ path: join(evidence, 'video-parameters.png'), animations: 'disabled' })
          await videos.getByRole('button', { name: `预览 ${TEMPLATE_TITLE}`, exact: true }).click()
          const preview = page.getByRole('dialog', { name: TEMPLATE_TITLE, exact: true })
          await preview.getByText(TEMPLATE_PROMPT, { exact: true }).waitFor()
          await page.screenshot({ path: join(evidence, 'template-script.png'), animations: 'disabled' })
          await preview.getByRole('button', { name: '关闭预览', exact: true }).click()
          const prompt = videos.getByRole('textbox', { name: '画面描述', exact: true })
          await prompt.fill('手冲咖啡，保持连续镜头。')
          const composer = videos.getByRole('region', { name: '视频创作输入', exact: true })
          const submit = composer.getByRole('button', { name: '生成视频', exact: true })
          expect(await submit.isDisabled()).toBe(true)
          const hintId = await submit.getAttribute('aria-describedby')
          if (hintId === null) throw new Error('A disabled filled video composer must identify its visible reason')
          const hint = composer.locator(`[id="${hintId}"]`)
          expect(await hint.textContent()).toBe(admission === 'no-session'
            ? '请先在聊天中选择或新建会话，生成的项目和产物会关联到该会话'
            : admission === 'read-failed' ? '请先核对原任务记录' : '原任务尚未确认，暂不能再次生成')
          if (admission === 'read-failed') expect(await composer.getByRole('button', { name: '核对本机任务记录', exact: true }).isEnabled()).toBe(true)
          if (admission === 'pending') expect(await composer.getByRole('button', { name: '查询原任务', exact: true }).isEnabled()).toBe(true)
          for (const [theme, width] of [['dark', 1440], ['light', 900]] as const) {
            await page.emulateMedia({ colorScheme: theme })
            await page.setViewportSize({ width, height: 1000 })
            await composer.scrollIntoViewIfNeeded()
            const boxes = await Promise.all([composer.boundingBox(), submit.boundingBox(), hint.boundingBox(),
              composer.locator('[aria-live="polite"]').boundingBox()])
            const [composerBox, submitBox, hintBox, feedbackBox] = boxes
            if (composerBox === null || submitBox === null || hintBox === null || feedbackBox === null) {
              throw new Error('Video composer feedback geometry must be available')
            }
            expect(await hint.isVisible()).toBe(true)
            expect(hintBox.x + hintBox.width).toBeLessThanOrEqual(submitBox.x)
            expect(feedbackBox.y).toBeGreaterThanOrEqual(submitBox.y + submitBox.height)
            expect(feedbackBox.y + feedbackBox.height).toBeLessThanOrEqual(composerBox.y + composerBox.height)
            expect(composerBox.x + composerBox.width).toBeLessThanOrEqual(width)
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
            submitGeometry.push({ theme, viewportWidth: width, composer: composerBox,
              submit: submitBox, hint: hintBox, feedback: feedbackBox })
            await page.screenshot({ path: join(evidence, `send-hint-${theme}-${String(width)}.png`), animations: 'disabled' })
          }
          if (admission === 'read-failed') {
            recordReadBlocked = false
            await composer.getByRole('button', { name: '核对本机任务记录', exact: true }).click()
            await expect.poll(() => submit.isEnabled()).toBe(true)
            expect(await submit.getAttribute('aria-describedby')).toBeNull()
            expect(await prompt.inputValue()).toBe('手冲咖啡，保持连续镜头。')
            expect(paidRequests).toEqual([])
            recordCheckReleased = true
            await page.screenshot({ path: join(evidence, 'record-check-released.png'), animations: 'disabled' })
          }
          if (admission === 'no-session') {
            await model.click()
            await page.getByRole('menuitem', { name: 'MiniMax-H3', exact: true }).click()
            await videos.getByText(/^可上传 MP4\/MOV 参考视频/).waitFor()
            const input = videos.getByLabel('添加素材', { exact: true })
            expect(await input.getAttribute('accept')).toContain('video/mp4')
            await videos.getByRole('button', { name: '参考素材', exact: true }).click()
            const buffer = await readFile(fileURLToPath(new URL('./fixtures/sidebar-media/preview.mp4', import.meta.url)))
            await input.setInputFiles({ name: '参考视频.mp4', mimeType: 'video/mp4', buffer })
            await videos.getByLabel('预览参考视频 参考视频.mp4', { exact: true }).waitFor()
            expect(uploadedMaterials).toEqual(['参考视频.mp4'])
            expect(await videos.getByRole('button', { name: '生成视频', exact: true }).isDisabled()).toBe(true)
            await page.screenshot({ path: join(evidence, 'reference-video-controls.png'), animations: 'disabled' })
            for (const [fault, imageText, videoText] of [
              ['network', /模型列表暂时不可用：网络连接未完成/u, /暂时无法读取视频模型：连接未完成/u],
              ['service', /模型列表暂时不可用：服务暂时不可用/u, /暂时无法读取视频模型：服务暂时无法处理请求/u],
              ['invalid', /模型列表暂时不可用：操作未完成，原因尚未确认/u, /暂时无法读取视频模型：操作未完成，原因暂时无法确认/u],
            ] as const) {
              catalogFailure = fault
              await page.reload({ waitUntil: 'load' })
              await page.getByRole('button', { name: 'AI 创作', exact: true }).click()
              await page.getByRole('tab', { name: '图片', exact: true }).click()
              await images.getByText(imageText).waitFor()
              expect(await images.innerText()).not.toContain('服务器繁忙')
              expect(await images.innerText()).not.toContain('private upstream diagnostic')
              await page.screenshot({ path: join(evidence, `image-${fault}-failure.png`), animations: 'disabled' })
              await images.getByRole('tab', { name: '视频', exact: true }).click()
              await videos.getByText(videoText).waitFor()
              expect(await videos.innerText()).not.toContain('服务器繁忙')
              expect(await videos.innerText()).not.toContain('private upstream diagnostic')
              await page.screenshot({ path: join(evidence, `video-${fault}-failure.png`), animations: 'disabled' })
              failureScreens.push(fault)
            }
          }
          expect(paidRequests).toEqual([])
          expect(unexpectedReads).toEqual([])
          expect(tripwire.pageErrors).toEqual([])
          await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, admission, projectReads,
            paidRequests, uploadedMaterials, unexpectedReads, pageErrors: tripwire.pageErrors, controlState,
            modelId: MODEL_ID, modelLabel: MODEL_LABEL, failureScreens,
            modelMenuOpened: true, parametersOpened: true, templateScriptPreviewed: true, paidSubmissionPaused: !recordCheckReleased,
            submitGeometry, recordCheckReleased, disabledReasonConnected: true, promptRetained: true,
            imageNoSessionDraftControlsChecked: admission === 'no-session',
            referenceVideoUploadChecked: admission === 'no-session',
            runtime: 'real built shipped Web composition' }, null, 2) + '\n')
          console.log(`Video controls browser evidence: ${evidence}`)
        } catch (error) {
          await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined)
          await writeFile(join(evidence, 'failure.json'), JSON.stringify({ admission, error: String(error), projectReads,
            paidRequests, unexpectedReads, pageErrors: tripwire.pageErrors, controlState }, null, 2) + '\n')
          throw error
        }
      } finally { await browser.close() }
    } finally { await scaffold.close() }
  },
)
