/** Built chat creation sidebar, independent generation pages and real chat/navigation state. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, errors, type Locator, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  CreativeOutput, CreativeOutputId, CreativeProjectId, CreativeProjectView,
} from '@deepseek-ai/dsh-credits-index/creative-types'
import { parseCreativePlan, parseCreativePlanChange } from '../../../packages/host/credits-index/src/creative-store.ts'
import { normalizeReferenceImage, ReferenceImageError } from '../../../packages/host/credits-index/src/reference-image.ts'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, connectFreshWorkspaceZh } from './support.ts'

const runtimeRoot = process.env.DSH_VIDEO_TEST_RUNTIME_ROOT
const ffmpeg = runtimeRoot === undefined ? undefined : join(runtimeRoot, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const available = ffmpeg !== undefined && existsSync(ffmpeg)
const accountId = 'creative-browser-qa'

/** Real encoded QA color bars and extracted frames, never a substituted user screenshot. */
async function fixtureMedia(directory: string): Promise<{ video: Buffer; png: Buffer; secondPng: Buffer }> {
  if (ffmpeg === undefined) throw new Error('Set DSH_VIDEO_TEST_RUNTIME_ROOT to an already prepared Desktop video runtime')
  const video = join(directory, '测试色卡视频.mp4')
  const png = join(directory, '分镜参考.png')
  const secondPng = join(directory, '分镜后帧.png')
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi',
    '-i', 'testsrc2=s=384x216:r=12:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-shortest', video], { timeout: 30_000 })
  for (const [position, target] of [[0.25, png], [0.75, secondPng]] as const) {
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-ss', String(position),
      '-i', video, '-frames:v', '1', target], { timeout: 30_000 })
  }
  return { video: await readFile(video), png: await readFile(png), secondPng: await readFile(secondPng) }
}

/** Controlled business record backed by the real QA media returned by the route below. */
function projectFixture(sessionId: string, source: string, completed: boolean): CreativeProjectView {
  const id = brandString<CreativeProjectId>(`cp_qa_${sessionId}`)
  const url = (outputId: string, frame?: string): string => `/credits/api/creative/media?${new URLSearchParams({
    session_id: sessionId, project_id: id, output_id: outputId, ...frame === undefined ? {} : { frame },
  })}`
  const imageId = brandString<CreativeOutputId>('co_qa_image')
  const videoId = brandString<CreativeOutputId>('co_qa_video')
  const image: CreativeOutput = { id: imageId, kind: 'image', name: '分镜参考.png', url: url(imageId) }
  const video: CreativeOutput = {
    id: videoId, kind: 'video', name: '测试色卡视频.mp4', url: url(videoId),
    posterUrl: url(videoId, '0'), frames: [{ url: url(videoId, '0'), timeSeconds: 0.25 }, { url: url(videoId, '1'), timeSeconds: 0.75 }],
  }
  const project: CreativeProjectView = {
    id, sessionId, planRevision: 'initial', completedShots: completed ? 2 : 1, totalShots: 2,
    kind: 'video', title: '站台重逢', brief: '两段分镜，保留人物身份、红围巾和明确对白。',
    style: '动漫风格；浏览器验证采用本机编码测试色卡', status: completed ? 'completed' : 'running', updatedAt: new Date().toISOString(),
    characters: [{ id: 'S1', name: '小雨', appearance: '黑色长发，固定人物外形', clothing: '红围巾与深蓝外套',
      personality: '沉静而好奇', voice: '普通话，轻柔女声', referenceAssetIds: ['reference-1'] }],
    assets: [{ id: 'reference-1', name: '人物参考图', kind: 'image', role: '人物身份与配色参考',
      description: '从本机测试视频实际提取的图片', sourcePathOrAssetId: source, status: 'completed', outputs: [image] }],
    shots: [
      { id: 'shot-1', order: 1, title: '站台远景', durationSeconds: 5, camera: '远景，缓慢推近',
        scene: '黄昏车站站台', action: '小雨转向进站列车', prompt: '保持红围巾与人物身份。',
        dialogue: '小雨，普通话，1–3 秒：你终于来了。', subtitles: '1–3 秒：你终于来了。',
        characterIds: ['S1'], assetIds: ['reference-1'], status: 'completed', outputs: [image] },
      { id: 'shot-2', order: 2, title: '微笑回应', durationSeconds: 10, camera: '近景，固定机位',
        scene: '列车旁的站台', action: '小雨微笑', prompt: '保持人物形象和光照。',
        dialogue: '小雨，普通话，2–4 秒：我们回家吧。', subtitles: '2–4 秒：我们回家吧。',
        characterIds: ['S1'], assetIds: ['reference-1'], status: completed ? 'completed' : 'running', outputs: completed ? [video] : [] },
    ],
    outputs: completed ? [video, image] : [image],
    tasks: [
      { id: 'op_qa_failed', status: 'failed', shotIds: ['shot-2'], outputs: [], errorCode: 'GENERATION_FAILED', completedShots: 0, totalShots: 1 },
      { id: 'op_qa_material', status: 'completed', shotIds: [], assetId: 'reference-1', model: 'gpt-image-2', outputs: [image], completedShots: 0, totalShots: 0 },
      { id: 'op_qa_video', status: completed ? 'completed' : 'running', shotIds: ['shot-1', 'shot-2'], model: 'MiniMax-H3',
        outputs: completed ? [video] : [], completedShots: completed ? 2 : 1, totalShots: 2 },
    ],
  }
  return { ...project, planRevision: revisionOf(project) }
}

/** Hash normalized editable fields, matching the server’s progress-independent CAS behavior. */
function revisionOf(project: CreativeProjectView): string {
  return createHash('sha256').update(JSON.stringify(parseCreativePlan(project))).digest('hex')
}

/** Count committed user messages without using the deprecated synchronous Session reader. */
async function userMessages(scaffold: WebScaffold, agent: Agent): Promise<number> {
  using observation = await scaffold.ctx.sessionQuery.observeSession(agent.session.id, { projectionMode: 'none' })
  return observation.events.filter(event => event.type === 'user/message').length
}

/** Seed a small settled chat through the actual Session append and persistence mechanisms. */
async function settleChat(scaffold: WebScaffold, agent: Agent, title: string): Promise<void> {
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `查看这份浏览器测试创作记录：${title}。` }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  agent.session.append('step/start', { turn: 1, step: 1 })
  agent.session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: title }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' } }),
  }, { surfaceOp: 'append' })
  agent.session.append('step/end', { turn: 1, step: 1 })
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await scaffold.ctx.sessions.flush(agent.session)
  await scaffold.ctx.sessionController.rename({ sessionId: agent.session.id, title })
}

/** Wait for actual decoded bytes rather than treating an img tag as a loaded thumbnail. */
async function loadedImages(root: Locator): Promise<number> {
  const images = root.locator('img:visible')
  await expect.poll(() => images.evaluateAll(elements => elements.length > 0 && elements.every(element =>
    element instanceof HTMLImageElement && element.complete && element.naturalWidth === 384)), { timeout: 10_000 }).toBe(true)
  return images.count()
}

/** Restore the official tab from its ordinary guide after the user closes it. */
async function openCreation(page: Page, title: string, sessionId: string): Promise<void> {
  const body = page.locator(`[data-creative-session="${sessionId}"]`)
  if (await body.isVisible()) return
  const expand = page.locator('[data-sidebar-right-expand]')
  if (await expand.isVisible()) {
    try { await expand.click({ timeout: 1000 }) }
    catch (error) {
      // Session restoration can open the target while its expand button is being clicked.
      if (!(error instanceof errors.TimeoutError) || !await body.isVisible()) throw error
      return
    }
  }
  const tab = page.locator('[data-dockkit-tab]').filter({ hasText: title })
  if (await tab.count() > 0) await tab.first().click()
  else {
    const guide = page.locator('[data-sidebar-right-guide]')
    if (!await guide.isVisible()) await page.locator('[data-dockkit-add-tab]').first().click()
    await page.locator('[data-sidebar-right-guide-entry="creative"]').click()
  }
  await body.waitFor({ state: 'visible' })
}

describe('web e2e: direct creation uploads and accepted task recovery', () => {
  it('keeps successful character images, saves real material bindings and queries the accepted task without regenerating', async () => {
    const scaffold = await launchWebScaffold({})
    try {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 },
          colorScheme: 'dark', reducedMotion: 'reduce' })
        page.setDefaultTimeout(15_000)
        const tripwire = watchConsole(page)
        const evidenceRoot = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
        await mkdir(evidenceRoot, { recursive: true })
        const evidence = await mkdtemp(join(evidenceRoot, 'creative-direct-upload-'))
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
        const uploads: { name: string; assetId?: string; code?: string }[] = []
        const normalized = new Map<string, Awaited<ReturnType<typeof normalizeReferenceImage>>>()
        const projects = new Map<string, CreativeProjectView[]>()
        const saves: ReturnType<typeof parseCreativePlanChange>[] = []
        const queries: { sessionId: string; projectId: string; operationId: string }[] = []
        const paidRequests: string[] = []
        const unexpectedReads: string[] = []
        const previewReads: string[] = []
        const reply = { route: '/v1/videos', model: 'video-qa', phase: 'accepted' as const,
          taskId: 'original-video-task', requestId: 'original-video-request', backendFingerprint: createHash('sha256').update('qa-backend').digest('hex') }
        await page.route('**/credits/api/**', async (route) => {
          const request = route.request()
          const url = new URL(request.url())
          const json = async (payload: unknown): Promise<void> => route.fulfill({ status: 200, json: { ok: true, payload } })
          if (url.pathname === '/credits/api/session') {
            await json({ signedIn: true, creditsPerYuan: 1000, account: { id: accountId } })
          } else if (url.pathname === '/credits/api/summary') {
            await json({ balance_points: 20000, as_of: new Date().toISOString() })
          } else if (url.pathname === '/credits/api/chat-usage' && request.method() === 'GET') {
            await json({ scope: 'chat-model', status: 'unavailable', settledRequests: 0, totalRequests: 0, accountId })
          } else if (url.pathname === '/credits/api/media/catalog') {
            await json({ image: [], video: [] })
          } else if (url.pathname === '/credits/api/creation/content') {
            const mode = { title: { zh: '', en: '' }, description: { zh: '', en: '' },
              promptPlaceholder: { zh: '', en: '' }, categories: [], templates: [], presets: [] }
            await json({ schemaVersion: 1, revision: 'direct-upload-qa', image: mode, video: mode })
          } else if (url.pathname === '/credits/api/creative/projects') {
            await json({ accountId, projects: projects.get(url.searchParams.get('session_id') ?? '') ?? [] })
          } else if (url.pathname === '/credits/api/assets' && request.method() === 'POST') {
            const name = decodeURIComponent(request.headers()['x-file-name'] ?? '')
            const upload: typeof uploads[number] = { name }
            uploads.push(upload)
            try {
              const image = await normalizeReferenceImage(request.postDataBuffer() ?? Buffer.alloc(0), name)
              const assetId = `ma_direct${String(uploads.length)}`
              normalized.set(assetId, image)
              upload.assetId = assetId
              await route.fulfill({ status: 200, json: { ok: true, asset: { assetId, kind: 'reference_image',
                contentType: image.mediaType, sizeBytes: image.bytes.length, converted: image.converted,
                firstFrameOnly: image.firstFrameOnly, previewUrl: `/credits/api/assets/preview?asset_id=${assetId}` } } })
            } catch (error) {
              if (!(error instanceof ReferenceImageError)) throw error
              upload.code = error.code
              await route.fulfill({ status: 400, json: { ok: false, code: error.code } })
            }
          } else if (url.pathname === '/credits/api/creative/plan' && request.method() === 'POST') {
            const value: unknown = request.postDataJSON()
            if (value === null || typeof value !== 'object' || !('session_id' in value) || typeof value.session_id !== 'string'
              || !('project_id' in value) || typeof value.project_id !== 'string'
              || !('expected_revision' in value) || typeof value.expected_revision !== 'string' || !('change' in value)) {
              await route.fulfill({ status: 400, json: { ok: false, code: 'CREATIVE_INVALID' } }); return
            }
            const current = projects.get(value.session_id)?.find(project => project.id === value.project_id)
            if (current === undefined) { await route.fulfill({ status: 404 }); return }
            if (current.planRevision !== value.expected_revision) {
              await route.fulfill({ status: 409, json: { ok: false, code: 'CREATIVE_PLAN_STALE' } }); return
            }
            const change = parseCreativePlanChange(value.change)
            saves.push(change)
            let characters = current.characters
            let assets = current.assets
            if (change.kind === 'character') {
              characters = current.characters.some(character => character.id === change.value.id)
                ? current.characters.map(character => character.id === change.value.id ? change.value : character)
                : [...current.characters, change.value]
              assets = [...assets, ...change.assets ?? []]
            } else if (change.kind === 'asset') {
              assets = current.assets.some(asset => asset.id === change.value.id)
                ? current.assets.map(asset => asset.id === change.value.id ? change.value : asset) : [...current.assets, change.value]
            } else throw new Error('Unexpected direct-upload fixture mutation')
            const plan = parseCreativePlan({ ...current, characters, assets })
            const updated: CreativeProjectView = { ...current, characters: plan.characters,
              assets: plan.assets.map(asset => ({ ...asset, referenceUrl: '/credits/api/creative/reference?' + new URLSearchParams({
                session_id: current.sessionId, project_id: current.id, asset_id: asset.id,
              }).toString() })), updatedAt: new Date().toISOString() }
            const next = { ...updated, planRevision: revisionOf(updated) }
            projects.set(current.sessionId, [next])
            await json({ accountId, projects: [next] })
          } else if (url.pathname === '/credits/api/assets/preview' || url.pathname === '/credits/api/creative/reference') {
            const assetId = url.pathname === '/credits/api/assets/preview' ? url.searchParams.get('asset_id')
              : projects.get(url.searchParams.get('session_id') ?? '')?.find(project => project.id === url.searchParams.get('project_id'))
                ?.assets.find(asset => asset.id === url.searchParams.get('asset_id'))?.sourcePathOrAssetId
            const image = normalized.get(assetId ?? '')
            if (image === undefined) { await route.fulfill({ status: 404 }); return }
            previewReads.push(assetId ?? '')
            await route.fulfill({ status: 200, contentType: image.mediaType, body: image.bytes })
          } else if (url.pathname === '/credits/api/creative/video/recover' && request.method() === 'POST') {
            const value: unknown = request.postDataJSON()
            if (value === null || typeof value !== 'object' || !('session_id' in value) || typeof value.session_id !== 'string'
              || !('project_id' in value) || typeof value.project_id !== 'string'
              || !('operation_id' in value) || value.operation_id !== 'op_pending') {
              await route.fulfill({ status: 400, json: { ok: false, code: 'CREATIVE_INVALID' } }); return
            }
            const current = projects.get(value.session_id)?.find(project => project.id === value.project_id)
            if (current === undefined) { await route.fulfill({ status: 404 }); return }
            queries.push({ sessionId: value.session_id, projectId: value.project_id, operationId: value.operation_id })
            const next = { ...current, tasks: current.tasks.map(task => task.id === 'op_pending' ? { ...task, canQuery: false } : task) }
            projects.set(current.sessionId, [next])
            await route.fulfill({ status: 202, json: { ok: true, payload: { accountId, projects: [next] } } })
          } else if (url.pathname === '/credits/api/usage') {
            await json({ rows: [], start: Number(url.searchParams.get('start')), end: Number(url.searchParams.get('end')),
              asOf: new Date().toISOString(), delayMinutes: 0 })
          } else if (request.method() !== 'GET' && request.method() !== 'HEAD') {
            paidRequests.push(`${request.method()} ${url.pathname}`)
            await route.abort('blockedbyclient')
          } else {
            unexpectedReads.push(`${request.method()} ${url.pathname}`)
            await route.fulfill({ status: 404, json: { ok: false, code: 'UNEXPECTED_FIXTURE_READ' } })
          }
        })
        try {
          await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          await page.waitForSelector('[class*="frame"]')
          await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
          const agent = scaffold.ctx.agents.list()[0]
          if (agent === undefined) throw new Error('The real workspace did not create its chat Agent')
          const sessionId = String(agent.session.id)
          const base = projectFixture(sessionId, '', false)
          const project: CreativeProjectView = { ...base, title: '人物素材上传验证', completedShots: 0,
            characters: base.characters.map(character => ({ ...character, referenceAssetIds: [] })), assets: [], outputs: [],
            shots: base.shots.map((shot, index) => ({ ...shot, status: index === 1 ? 'running' : 'planned', outputs: [], assetIds: [],
              characterIds: index === 1 ? [] : ['S1'] })),
            tasks: [{ id: 'op_pending', status: 'running', shotIds: ['shot-2'], outputs: [], completedShots: 0, totalShots: 1,
              model: reply.model, videoReceipt: reply, canQuery: true, errorCode: 'VIDEO_QUERY_UNAVAILABLE' }],
          }
          projects.set(sessionId, [{ ...project, planRevision: revisionOf(project) }])
          await settleChat(scaffold, agent, '直接上传验证会话')
          await openCreation(page, '创作', sessionId)
          const body = page.locator(`[data-creative-session="${sessionId}"]`)
          await body.getByText('人物素材上传验证', { exact: true }).waitFor()
          const beforeMessages = await userMessages(scaffold, agent)
          await body.getByRole('tab', { name: '人物', exact: true }).click()
          await body.getByRole('button', { name: '上传人物参考图', exact: true }).click()
          const editor = page.getByRole('dialog', { name: '编辑设定', exact: true })
          const characterUpload = editor.getByLabel('上传人物参考图', { exact: true })
          expect(await characterUpload.getAttribute('multiple')).not.toBeNull()
          await characterUpload.setInputFiles([
            { name: '小雨正面.png', mimeType: 'image/png', buffer: png },
            { name: '损坏参考.png', mimeType: 'image/png', buffer: png.subarray(0, 36) },
            { name: '小雨侧面.jfif', mimeType: 'application/octet-stream', buffer: png },
          ])
          await editor.getByRole('checkbox', { name: '小雨侧面.jfif', exact: true }).waitFor()
          expect(await editor.getByRole('checkbox', { name: '小雨正面.png', exact: true }).isChecked()).toBe(true)
          expect(await editor.getByRole('checkbox', { name: '小雨侧面.jfif', exact: true }).isChecked()).toBe(true)
          await editor.getByRole('alert').filter({ hasText: '「损坏参考.png」上传失败' }).waitFor()
          expect(await editor.getByRole('alert').innerText()).toContain('图片损坏或无法解码')
          await expect.poll(() => editor.locator('img').evaluateAll(elements => elements.length === 2 && elements.every(element =>
            element instanceof HTMLImageElement && element.complete && element.naturalWidth === 1))).toBe(true)
          await editor.getByRole('alert').scrollIntoViewIfNeeded()
          await page.screenshot({ path: join(evidence, 'character-batch-retains-successes.png'), animations: 'disabled' })
          await editor.getByRole('button', { name: '保存设定', exact: true }).click()
          await editor.waitFor({ state: 'hidden' })
          const characterChange = saves[0]
          if (characterChange?.kind !== 'character') throw new Error('Expected one atomic character/material change')
          expect(characterChange.assets?.map(asset => asset.sourcePathOrAssetId)).toEqual(['ma_direct1', 'ma_direct3'])
          expect(characterChange.value.referenceAssetIds).toEqual(characterChange.assets?.map(asset => asset.id))
          expect(uploads).toEqual([
            { name: '小雨正面.png', assetId: 'ma_direct1' }, { name: '损坏参考.png', code: 'IMAGE_DECODE_FAILED' },
            { name: '小雨侧面.jfif', assetId: 'ma_direct3' },
          ])
          await body.getByRole('tab', { name: '素材', exact: true }).click()
          for (const name of ['场景参考.png', '道具参考.png']) {
            await body.getByRole('button', { name: '添加素材', exact: true }).click()
            const material = page.getByRole('dialog', { name: '添加素材', exact: true })
            await material.getByLabel('上传素材', { exact: true }).setInputFiles({ name, mimeType: 'image/png', buffer: png })
            await expect.poll(() => material.getByRole('textbox', { name: '素材引用', exact: true }).inputValue()).toMatch(/^ma_direct\d+$/u)
            await material.getByRole('button', { name: '保存设定', exact: true }).click()
            await material.waitFor({ state: 'hidden' })
            await body.getByRole('heading', { name, exact: true }).waitFor()
          }
          const savedProject = projects.get(sessionId)?.[0]
          expect(savedProject?.assets.map(asset => asset.sourcePathOrAssetId)).toEqual(['ma_direct1', 'ma_direct3', 'ma_direct4', 'ma_direct5'])
          expect(savedProject?.characters[0]?.referenceAssetIds).toHaveLength(2)
          expect(saves).toHaveLength(3)
          await body.getByText('参考人物：小雨', { exact: true }).first().waitFor()
          await page.screenshot({ path: join(evidence, 'saved-materials-and-character-bindings.png'), animations: 'disabled' })
          await body.getByRole('tab', { name: '任务与产物', exact: true }).click()
          const pending = body.locator('[data-creative-task="op_pending"]')
          await pending.getByText('生成中', { exact: true }).waitFor()
          expect(await pending.getByText('生成失败', { exact: true }).count()).toBe(0)
          expect(await pending.innerText()).not.toContain('VIDEO_QUERY_UNAVAILABLE')
          await page.screenshot({ path: join(evidence, 'accepted-task-before-query.png'), animations: 'disabled' })
          await pending.getByRole('button', { name: '查询原任务', exact: true }).click()
          await expect.poll(() => queries.length).toBe(1)
          expect(queries).toEqual([{ sessionId, projectId: savedProject?.id, operationId: 'op_pending' }])
          await pending.getByText('生成中', { exact: true }).waitFor()
          await expect.poll(() => pending.getByRole('button', { name: '查询原任务', exact: true }).count()).toBe(0)
          expect(await pending.getByText('生成失败', { exact: true }).count()).toBe(0)
          await page.screenshot({ path: join(evidence, 'accepted-task-query-without-regeneration.png'), animations: 'disabled' })
          expect(await userMessages(scaffold, agent)).toBe(beforeMessages)
          expect(paidRequests).toEqual([])
          expect(unexpectedReads).toEqual([])
          expect(previewReads).toContain('ma_direct1')
          expect(previewReads).toContain('ma_direct3')
          expect(tripwire.pageErrors).toEqual([])
          expect(tripwire.warnings).toEqual([])
          await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, sessionId, uploads, saves, queries,
            paidRequests, previewReads, ffmpegRequired: false, imageNormalization: 'real host decoder', upstreamGeneration: false,
          }, null, 2) + '\n')
          console.log(`Direct creation upload and task recovery evidence: ${evidence}`)
        } catch (error) {
          await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined)
          await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), uploads, saves, queries,
            paidRequests, unexpectedReads, previewReads, pageErrors: tripwire.pageErrors }, null, 2) + '\n')
          throw error
        }
      } finally { await browser.close() }
    } finally { await scaffold.close() }
  })
})

describe.skipIf(!available)('web e2e: chat creation and independent generation pages', () => {
  it.each(['zh-CN', 'en-US'])('retains the chat project when visiting image and video generation in %s', async (locale) => {
    const scaffold = await launchWebScaffold({})
    try {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale, colorScheme: 'dark', reducedMotion: 'reduce' })
        page.setDefaultTimeout(15_000)
        const tripwire = watchConsole(page)
        const evidenceRoot = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
        await mkdir(evidenceRoot, { recursive: true })
        const evidence = await mkdtemp(join(evidenceRoot, `creative-sidebar-${locale}-`))
        const media = await fixtureMedia(evidence)
        const projects = new Map<string, CreativeProjectView[]>()
        const reads: string[] = []
        const mediaReads: string[] = []
        const unexpectedReads: string[] = []
        const paidRequests: string[] = []
        const planSaves: { sessionId: string; revision: string; change: unknown; accepted: boolean }[] = []
        let signedIn = true
        let logoutCalls = 0
        const zh = locale === 'zh-CN'
        const labels = zh
          ? { title: '创作', characters: '人物', assets: '素材', shots: '分镜', outputs: '任务与产物', refresh: '刷新创作进度',
            generating: '生成中', complete: '文件已完成', redo: '重做镜头', balance: '余额', logout: '退出登录',
            signedOut: '登录后查看当前聊天的创作项目', edit: '编辑设定', duration: '计划时长（秒）', save: '保存设定',
            cancel: '取消', timeline: '分镜时间轴', selectShot: '选择镜头：站台远景', selectSecondShot: '选择镜头：微笑回应', moveLater: '将 站台远景 后移',
            taskStatus: '任务状态', fileType: '文件类型', details: '查看细节', preview: '预览图片', close: '关闭',
            create: 'AI 创作', chat: '聊天', image: '图片', video: '视频',
            rework: '重构素材', reworkInput: '希望怎样调整这份素材？', draft: '写入聊天草稿',
            stale: '计划已被更新，本次内容已保留。请关闭编辑、刷新后核对最新设定，再重新修改' }
          : { title: 'Creation', characters: 'Cast', assets: 'Assets', shots: 'Shots', outputs: 'Tasks and outputs', refresh: 'Refresh creation progress',
            generating: 'Generating', complete: 'File completed', redo: 'Redo shot', balance: 'Balance', logout: 'Sign out',
            signedOut: 'Sign in to view this chat’s creation projects', edit: 'Edit directions', duration: 'Planned duration (seconds)', save: 'Save directions',
            cancel: 'Cancel', timeline: 'Storyboard timeline', selectShot: 'Select shot: 站台远景', selectSecondShot: 'Select shot: 微笑回应', moveLater: 'Move 站台远景 later',
            taskStatus: 'Task status', fileType: 'File type', details: 'View details', preview: 'Preview image', close: 'Close',
            create: 'Create', chat: 'Chat', image: 'Images', video: 'Videos',
            rework: 'Rework asset', reworkInput: 'How should this material change?', draft: 'Add to chat draft',
            stale: 'The plan changed. Your edits are retained. Close this editor, refresh and review the latest directions before editing again.' }
        await page.route('**/credits/api/**', async (route) => {
          const request = route.request()
          const url = new URL(request.url())
          const json = async (payload: unknown): Promise<void> => route.fulfill({ status: 200, json: { ok: true, payload } })
          if (url.pathname === '/credits/api/session' && request.method() === 'GET') {
            await json({ signedIn, creditsPerYuan: 1000, ...signedIn ? { account: { id: accountId, phone: '+8613800000000' } } : {} })
          } else if (url.pathname === '/credits/api/summary') {
            await json({ balance_points: 20000, as_of: new Date().toISOString() })
          } else if (url.pathname === '/credits/api/media/catalog') {
            await json({ image: [{ id: 'gpt-image-2', displayName: '图片测试模型', params: {
              sizes: ['1024x1024'], maxCount: 1, maxEdits: 1, qualities: ['auto'], backgrounds: ['auto'], formats: ['png'], moderations: ['auto'], seed: false,
            } }], video: [] })
          } else if (url.pathname === '/credits/api/creation/content') {
            const mode = { title: { zh: '', en: '' }, description: { zh: '', en: '' },
              promptPlaceholder: { zh: '', en: '' }, categories: [], templates: [], presets: [] }
            await json({ schemaVersion: 1, revision: 'creative-browser-fixture', image: mode, video: mode })
          } else if (url.pathname === '/credits/api/creative/projects') {
            const sessionId = url.searchParams.get('session_id') ?? ''
            reads.push(sessionId)
            await json({ accountId, projects: projects.get(sessionId) ?? [] })
          } else if (url.pathname === '/credits/api/creative/plan' && request.method() === 'POST') {
            const value: unknown = request.postDataJSON()
            if (value === null || typeof value !== 'object' || !('session_id' in value) || typeof value.session_id !== 'string'
              || !('project_id' in value) || typeof value.project_id !== 'string'
              || !('expected_revision' in value) || typeof value.expected_revision !== 'string' || !('change' in value)) {
              await route.fulfill({ status: 400, json: { ok: false, code: 'CREATIVE_INVALID' } }); return
            }
            const current = projects.get(value.session_id)?.find(project => project.id === value.project_id)
            if (current === undefined) { await route.fulfill({ status: 404 }); return }
            const change = parseCreativePlanChange(value.change)
            const save = { sessionId: value.session_id, revision: value.expected_revision, change, accepted: false }
            planSaves.push(save)
            if (current.planRevision !== value.expected_revision) {
              await route.fulfill({ status: 409, json: { ok: false, code: 'CREATIVE_PLAN_STALE' } }); return
            }
            let shots = current.shots
            if (change.kind === 'shot') shots = current.shots.map(shot => shot.id === change.id ? { ...shot, ...change.patch } : shot)
            else if (change.kind === 'reorder') shots = change.shotIds.map((id, index) => {
              const shot = current.shots.find(item => item.id === id)
              if (shot === undefined) throw new Error('Unexpected fixture shot')
              return { ...shot, order: index + 1 }
            })
            else throw new Error('Unexpected fixture plan edit')
            const updated = { ...current, shots, updatedAt: new Date().toISOString() }
            const next = { ...updated, planRevision: revisionOf(updated) }
            projects.set(value.session_id, [next])
            save.accepted = true
            await json({ accountId, projects: [next] })
          } else if (url.pathname === '/credits/api/creative/media' || url.pathname === '/credits/api/creative/reference') {
            mediaReads.push(url.search)
            const video = url.searchParams.get('output_id') === 'co_qa_video' && !url.searchParams.has('frame')
            const body = video ? media.video : url.searchParams.get('frame') === '1' ? media.secondPng : media.png
            await route.fulfill({ status: 200, contentType: video ? 'video/mp4' : 'image/png', body })
          } else if (url.pathname === '/credits/api/session/logout' && request.method() === 'POST') {
            signedIn = false; logoutCalls += 1
            await json({ signedOut: true })
          } else if (url.pathname === '/credits/api/usage') {
            await json({ rows: [], start: Number(url.searchParams.get('start')), end: Number(url.searchParams.get('end')),
              asOf: new Date().toISOString(), delayMinutes: 0 })
          } else if (request.method() !== 'GET' && request.method() !== 'HEAD') {
            paidRequests.push(`${request.method()} ${url.pathname}`)
            await route.abort('blockedbyclient')
          } else {
            unexpectedReads.push(`${request.method()} ${url.pathname}`)
            await route.fulfill({ status: 404, json: { ok: false, code: 'UNEXPECTED_FIXTURE_READ' } })
          }
        })
        try {
          await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          await page.waitForSelector('[class*="frame"]')
          if (zh) await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
          else await connectFreshWorkspace(page, scaffold.workspaceCwd)
          const agent = scaffold.ctx.agents.list()[0]
          if (agent === undefined) throw new Error('The real workspace did not create its chat Agent')
          const sessionId = String(agent.session.id)
          projects.set(sessionId, [projectFixture(sessionId, join(evidence, '分镜参考.png'), false)])
          await settleChat(scaffold, agent, '创作验证会话')
          const body = page.locator(`[data-creative-session="${sessionId}"]`)
          await body.waitFor({ state: 'visible' })
          await body.getByText('站台重逢', { exact: true }).waitFor()
          await body.getByText(labels.generating, { exact: true }).first().waitFor()
          expect(await loadedImages(body.locator('[data-creative-shot="shot-1"]'))).toBe(1)
          await page.screenshot({ path: join(evidence, 'running-dark-wide.png') })

          await body.getByRole('tab', { name: labels.characters, exact: true }).click()
          await body.getByText('小雨', { exact: true }).waitFor()
          const characterCard = body.getByRole('tabpanel').locator('article').filter({ has: page.getByRole('heading', { name: '小雨', exact: true }) })
          await characterCard.locator('details').locator('summary').click()
          await body.getByText('红围巾与深蓝外套', { exact: true }).waitFor()
          await body.getByText('普通话，轻柔女声', { exact: true }).waitFor()
          expect(await loadedImages(body)).toBe(1)
          await page.screenshot({ path: join(evidence, 'characters.png') })
          await body.getByRole('tab', { name: labels.assets, exact: true }).click()
          await body.getByText('人物参考图', { exact: true }).waitFor()
          const assetCard = body.getByRole('tabpanel').locator('article').filter({ has: page.getByRole('heading', { name: '人物参考图', exact: true }) })
          await assetCard.locator('details').first().locator('summary').click()
          await body.getByText(join(evidence, '分镜参考.png'), { exact: true }).waitFor()
          expect(await loadedImages(body)).toBe(1)
          await page.screenshot({ path: join(evidence, 'assets.png') })
          const beforeDraft = await userMessages(scaffold, agent)
          await body.getByRole('button', { name: labels.rework, exact: true }).click()
          const assetDialog = page.getByRole('dialog', { name: `${labels.rework} · 人物参考图`, exact: true })
          await assetDialog.getByRole('textbox', { name: labels.reworkInput, exact: true }).fill('保留红围巾，整体改为温暖色调。')
          await assetDialog.getByRole('button', { name: labels.draft, exact: true }).click()
          const composer = page.locator('[data-composer-input][contenteditable="true"]')
          await expect.poll(() => composer.innerText()).toContain('asset_id=reference-1')
          expect(await composer.innerText()).toContain(`plan_id=cp_qa_${sessionId}`)
          expect(await userMessages(scaffold, agent)).toBe(beforeDraft)
          expect(paidRequests).toEqual([])
          expect(unexpectedReads).toEqual([])

          projects.set(sessionId, [projectFixture(sessionId, join(evidence, '分镜参考.png'), true)])
          await body.getByRole('button', { name: labels.refresh, exact: true }).click()
          await body.getByRole('tab', { name: labels.shots, exact: true }).click()
          await body.getByRole('button', { name: labels.selectShot, exact: true }).waitFor()
          await expect.poll(() => body.getByRole('button', { name: labels.moveLater, exact: true }).isEnabled()).toBe(true)
          await body.getByRole('button', { name: labels.moveLater, exact: true }).click()
          const timeline = body.getByRole('list', { name: labels.timeline, exact: true })
          await expect.poll(() => timeline.getByRole('listitem').first().innerText()).toContain('微笑回应')
          expect(planSaves[0]).toMatchObject({ accepted: true, change: { kind: 'reorder', shotIds: ['shot-2', 'shot-1'] } })
          await body.getByRole('button', { name: labels.selectShot, exact: true }).click()
          const firstShot = body.locator('[data-creative-shot="shot-1"]')
          await firstShot.getByRole('button', { name: labels.edit, exact: true }).click()
          let editor = page.getByRole('dialog', { name: labels.edit, exact: true })
          await editor.getByRole('spinbutton', { name: labels.duration, exact: true }).fill('8')
          const current = projects.get(sessionId)?.[0]
          if (current === undefined) throw new Error('Fixture project disappeared')
          const external = { ...current, shots: current.shots.map(shot => shot.id === 'shot-1' ? { ...shot, action: '远端已更新人物动作' } : shot) }
          projects.set(sessionId, [{ ...external, planRevision: revisionOf(external) }])
          await editor.getByRole('button', { name: labels.save, exact: true }).click()
          await editor.getByText(labels.stale, { exact: true }).waitFor()
          expect(await editor.getByRole('spinbutton', { name: labels.duration, exact: true }).inputValue()).toBe('8')
          expect(planSaves.filter(save => !save.accepted)).toHaveLength(1)
          await page.screenshot({ path: join(evidence, 'revision-conflict-retains-edit.png') })
          await editor.getByRole('button', { name: labels.cancel, exact: true }).click()
          await body.getByRole('button', { name: labels.refresh, exact: true }).click()
          await expect.poll(() => body.getByRole('button', { name: labels.refresh, exact: true }).isEnabled()).toBe(true)
          await firstShot.getByRole('button', { name: labels.edit, exact: true }).click()
          editor = page.getByRole('dialog', { name: labels.edit, exact: true })
          await expect.poll(() => editor.locator('textarea').nth(2).inputValue()).toBe('远端已更新人物动作')
          await editor.getByRole('spinbutton', { name: labels.duration, exact: true }).fill('8')
          await editor.getByRole('button', { name: labels.save, exact: true }).click()
          await editor.waitFor({ state: 'hidden' })
          await firstShot.getByText(zh ? '8 秒' : '8s', { exact: true }).waitFor()
          await page.screenshot({ path: join(evidence, 'timeline-saved.png') })

          await body.getByRole('button', { name: labels.selectSecondShot, exact: true }).click()
          await page.getByRole('button', { name: labels.create, exact: true }).click()
          const imagePage = page.locator('#imagegen')
          const videoPage = page.locator('#videogen')
          for (const [panel, active, destination, name] of [
            [imagePage, labels.image, labels.video, 'image'], [videoPage, labels.video, labels.image, 'video'],
          ] as const) {
            await panel.waitFor({ state: 'visible' })
            expect(await panel.getByRole('tab').count()).toBe(2)
            expect(await panel.getByRole('tab', { name: active, exact: true }).getAttribute('aria-selected')).toBe('true')
            expect(await panel.locator('[data-creative-session]').count()).toBe(0)
            expect(await panel.getByRole('list', { name: labels.timeline, exact: true }).count()).toBe(0)
            for (const section of [labels.shots, labels.characters, labels.assets, labels.outputs]) {
              expect(await panel.getByRole('tab', { name: section, exact: true }).count()).toBe(0)
            }
            await page.screenshot({ path: join(evidence, `ai-creation-${name}-independent.png`) })
            await panel.getByRole('tab', { name: destination, exact: true }).click()
          }
          await imagePage.waitFor({ state: 'visible' })
          await page.getByRole('button', { name: labels.chat, exact: true }).click()
          await openCreation(page, labels.title, sessionId)
          await body.getByRole('tab', { name: labels.shots, exact: true }).click()
          await expect.poll(() => body.getByRole('button', { name: labels.selectSecondShot, exact: true }).getAttribute('aria-pressed')).toBe('true')
          await body.getByRole('button', { name: labels.selectShot, exact: true }).click()
          await body.locator('[data-creative-shot="shot-1"]').getByText(zh ? '8 秒' : '8s', { exact: true }).waitFor()
          await page.screenshot({ path: join(evidence, 'chat-project-retained-after-ai-creation.png') })
          expect(await userMessages(scaffold, agent)).toBe(beforeDraft)
          expect(paidRequests).toEqual([])

          await body.getByRole('tab', { name: labels.outputs, exact: true }).click()
          await body.getByRole('combobox', { name: labels.taskStatus, exact: true }).selectOption('failed')
          expect(await body.locator('[data-creative-task]').count()).toBe(1)
          await body.locator('[data-creative-task="op_qa_failed"]').getByText(labels.details, { exact: true }).click()
          await body.getByText('GENERATION_FAILED', { exact: true }).waitFor()
          await body.getByRole('combobox', { name: labels.taskStatus, exact: true }).selectOption('completed')
          expect(await body.locator('[data-creative-task]').count()).toBe(2)
          await body.getByRole('combobox', { name: labels.fileType, exact: true }).selectOption('image')
          expect(await body.locator('video').count()).toBe(0)
          await body.getByRole('button', { name: labels.preview, exact: true }).click()
          const lightbox = page.getByRole('dialog', { name: labels.preview, exact: true })
          await loadedImages(lightbox)
          await page.screenshot({ path: join(evidence, 'image-lightbox.png') })
          await lightbox.getByRole('button', { name: labels.close, exact: true }).click()
          await body.getByRole('combobox', { name: labels.fileType, exact: true }).selectOption('video')
          const finalVideo = body.locator('video')
          await expect.poll(() => finalVideo.evaluate(element => element instanceof HTMLVideoElement
            ? element.duration : 0)).toBeCloseTo(1, 1)
          const decodedFrames = await loadedImages(body.locator('[data-creative-output="video"]'))
          expect(decodedFrames).toBe(2)
          await finalVideo.evaluate(async (element) => {
            if (!(element instanceof HTMLVideoElement)) throw new Error('Expected the real video element')
            element.muted = true; await element.play()
          })
          await expect.poll(() => finalVideo.evaluate(element => element instanceof HTMLVideoElement
            ? element.currentTime : 0)).toBeGreaterThan(0)
          await finalVideo.evaluate((element) => { if (element instanceof HTMLVideoElement) element.pause() })
          await body.getByText(zh ? '人声、口型与字幕同步：待核验' : 'Speech, lip sync and subtitle timing: unverified', { exact: true }).waitFor()
          for (const theme of ['dark', 'light'] as const) {
            await page.emulateMedia({ colorScheme: theme })
            await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(theme === 'dark')
            for (const width of [1440, 760]) {
              await page.setViewportSize({ width, height: 1000 })
              await expect.poll(() => body.evaluate((element) => {
                const rect = element.getBoundingClientRect()
                return rect.left >= 0 && rect.right <= window.innerWidth + 1 && rect.width > 200
                  && element.scrollWidth <= element.clientWidth + 1
              })).toBe(true)
              await page.screenshot({ path: join(evidence, `outputs-${theme}-${width}.png`) })
            }
          }
          await page.setViewportSize({ width: 1440, height: 1000 })
          await body.getByRole('tab', { name: labels.shots, exact: true }).click()
          await body.getByRole('button', { name: labels.selectShot, exact: true }).click()
          await body.locator('[data-creative-shot="shot-1"]').getByRole('button', { name: labels.redo, exact: true }).click()
          await expect.poll(() => composer.innerText()).toContain('shot_id=shot-1')
          expect(await composer.innerText()).toContain(`plan_id=cp_qa_${sessionId}`)
          expect(await userMessages(scaffold, agent)).toBe(beforeDraft)

          const workspace = scaffold.ctx.workspaceRegistry.list()[0]
          if (workspace === undefined) throw new Error('Workspace registry lost the connected workspace')
          const second = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id })
          const secondAgent = scaffold.ctx.agents.get(second.sessionId)
          if (secondAgent === undefined) throw new Error('Second chat did not create an Agent')
          await settleChat(scaffold, secondAgent, '空白验证会话')
          await page.locator(`[data-row-key="session:${second.sessionId}"]`).click()
          await openCreation(page, labels.title, second.sessionId)
          const empty = page.locator(`[data-creative-session="${second.sessionId}"]`)
          await empty.getByText(zh ? '创作过程会在这里展开' : 'Your creation takes shape here', { exact: true }).waitFor()
          expect(await empty.getByText('站台重逢', { exact: true }).count()).toBe(0)
          await page.screenshot({ path: join(evidence, 'other-chat-isolated.png') })
          await page.locator(`[data-row-key="session:${sessionId}"]`).click()
          await openCreation(page, labels.title, sessionId)
          await body.getByText('站台重逢', { exact: true }).waitFor()
          await page.getByRole('button', { name: labels.balance, exact: true }).click()
          await page.getByRole('button', { name: labels.logout, exact: true }).click()
          await expect.poll(() => logoutCalls).toBe(1)
          await page.getByRole('button', { name: labels.chat, exact: true }).click()
          await openCreation(page, labels.title, sessionId)
          await body.getByText(labels.signedOut, { exact: true }).waitFor()
          expect(await body.locator('[data-creative-output]').count()).toBe(0)
          expect(paidRequests).toEqual([])
          expect(unexpectedReads).toEqual([])
          expect(planSaves.filter(save => save.accepted)).toHaveLength(2)
          expect(tripwire.pageErrors).toEqual([])
          expect(tripwire.warnings).toEqual([])
          await writeFile(join(evidence, 'result.json'), JSON.stringify({
            passed: true, locale, themes: ['dark', 'light'], widths: [1440, 760], sessionId, secondSessionId: second.sessionId,
            projectsRead: reads, mediaReads, unexpectedReads, planSaves, paidRequests, logoutCalls, decodedFrames,
            videoMetadata: true, videoPlayback: true,
            characterReferencePreview: true, assetPreview: true, freeCasEdit: true, staleEditRetained: true,
            timelineReordered: true,
            independentImageVideoPages: true, chatProjectAndSelectionRetained: true, tasksAndOutputFilters: true, redoOnlyDraft: true,
            chatIsolation: true, signedOutCleared: true,
            host: 'real shipped built Web composition', substituted: 'account and creative HTTP responses; real local QA color-bar media',
            upstreamGeneration: false, speechLipSyncSubtitlesVerified: false,
            fixtureSha256: Object.fromEntries(Object.entries(media).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])),
          }, null, 2) + '\n')
          console.log(`Chat creation and independent generation evidence: ${evidence}`)
        } catch (error) {
          await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined)
          await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), reads, mediaReads, unexpectedReads, planSaves, paidRequests,
            pageErrors: tripwire.pageErrors, warnings: tripwire.warnings }, null, 2) + '\n')
          throw error
        }
      } finally { await browser.close() }
    } finally { await scaffold.close() }
  })
})
