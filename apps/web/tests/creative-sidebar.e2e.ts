/** Built creation sidebar with controlled account/media responses and real chat/navigation state. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  CreativeOutput, CreativeOutputId, CreativeProjectId, CreativeProjectView,
} from '@deepseek-ai/dsh-credits-index/creative-types'
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
  const video = join(directory, 'qa-colorbars.mp4')
  const png = join(directory, 'qa-frame-025.png')
  const secondPng = join(directory, 'qa-frame-075.png')
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
  const image: CreativeOutput = { id: imageId, kind: 'image', name: 'QA storyboard.png', url: url(imageId) }
  const video: CreativeOutput = {
    id: videoId, kind: 'video', name: 'QA colorbars.mp4', url: url(videoId),
    posterUrl: url(videoId, '0'), frames: [{ url: url(videoId, '0'), timeSeconds: 0.25 }, { url: url(videoId, '1'), timeSeconds: 0.75 }],
  }
  return {
    id, kind: 'video', title: 'QA · Station reunion', brief: 'Controlled browser fixture: two shots, explicit character and reference directions.',
    style: 'QA color bars stand in for upstream media', status: completed ? 'completed' : 'running', updatedAt: new Date().toISOString(),
    characters: [{ id: 'S1', name: 'QA · Lin', appearance: 'Black hair; stable character direction', clothing: 'Red scarf and navy coat',
      personality: 'Calm and curious', voice: 'Mandarin; gentle voice', referenceAssetIds: ['reference-1'] }],
    assets: [{ id: 'reference-1', name: 'QA · Reference frame', kind: 'image', role: 'Character and palette reference',
      description: 'Real PNG extracted from the local QA fixture', sourcePathOrAssetId: source, status: 'completed', outputs: [image] }],
    shots: [
      { id: 'shot-1', order: 1, title: 'QA · Establishing shot', durationSeconds: 1, camera: 'Wide shot; slow push in',
        scene: 'Station platform at dusk', action: 'Lin turns toward the arriving train', prompt: 'Keep the red scarf and character identity.',
        dialogue: 'S1, Mandarin, 0.2–0.8s: 你终于来了。', subtitles: '0.2–0.8s: 你终于来了。',
        characterIds: ['S1'], assetIds: ['reference-1'], status: 'completed', outputs: [image] },
      { id: 'shot-2', order: 2, title: 'QA · Reply shot', durationSeconds: 1, camera: 'Close-up; fixed camera',
        scene: 'Station platform beside the train', action: 'Lin smiles', prompt: 'Maintain the saved character and lighting.',
        dialogue: 'S1, Mandarin, 0.2–0.8s: 我们回家吧。', subtitles: '0.2–0.8s: 我们回家吧。',
        characterIds: ['S1'], assetIds: ['reference-1'], status: completed ? 'completed' : 'running', outputs: completed ? [video] : [] },
    ],
    outputs: completed ? [video, image] : [],
  }
}

/** Seed a small settled chat through the actual Session append and persistence mechanisms. */
async function settleChat(scaffold: WebScaffold, agent: Agent, title: string): Promise<void> {
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `Inspect the controlled QA creation record: ${title}.` }], source: { kind: 'user' },
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
  const images = root.locator('img')
  await expect.poll(() => images.evaluateAll(elements => elements.length > 0 && elements.every(element =>
    element instanceof HTMLImageElement && element.complete && element.naturalWidth === 384)), { timeout: 10_000 }).toBe(true)
  return images.count()
}

/** Restore the official tab from its ordinary guide after the user closes it. */
async function openCreation(page: Page, title: string, sessionId: string): Promise<void> {
  const body = page.locator(`[data-creative-session="${sessionId}"]`)
  if (await body.isVisible()) return
  const expand = page.locator('[data-sidebar-right-expand]')
  if (await expand.isVisible()) await expand.click()
  const tab = page.locator('[data-dockkit-tab]').filter({ hasText: title })
  if (await tab.count() > 0) await tab.first().click()
  else {
    const guide = page.locator('[data-sidebar-right-guide]')
    if (!await guide.isVisible()) await page.locator('[data-dockkit-add-tab]').first().click()
    await page.locator('[data-sidebar-right-guide-entry="creative"]').click()
  }
  await body.waitFor({ state: 'visible' })
}

describe.skipIf(!available)('web e2e: chat creation sidebar', () => {
  it.each(['zh-CN', 'en-US'])('renders and isolates real sidebar behavior in %s', async (locale) => {
    const scaffold = await launchWebScaffold({})
    try {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale, colorScheme: 'dark', reducedMotion: 'reduce' })
        page.setDefaultTimeout(15_000)
        const tripwire = watchConsole(page)
        const evidenceRoot = fileURLToPath(new URL('../../desktop/.desktop-build/qualification/', import.meta.url))
        await mkdir(evidenceRoot, { recursive: true })
        const evidence = await mkdtemp(join(evidenceRoot, `creative-sidebar-${locale}-`))
        const media = await fixtureMedia(evidence)
        const projects = new Map<string, CreativeProjectView[]>()
        const reads: string[] = []
        const mediaReads: string[] = []
        const paidRequests: string[] = []
        let signedIn = true
        let logoutCalls = 0
        const zh = locale === 'zh-CN'
        const labels = zh
          ? { title: '创作', characters: '人物', assets: '素材', shots: '分镜', outputs: '成片', refresh: '刷新创作进度',
            generating: '生成中', complete: '文件已完成', redo: '重做镜头', balance: '余额', logout: '退出登录', signedOut: '登录后查看当前聊天的创作项目' }
          : { title: 'Creation', characters: 'Cast', assets: 'Assets', shots: 'Shots', outputs: 'Outputs', refresh: 'Refresh creation progress',
            generating: 'Generating', complete: 'File completed', redo: 'Redo shot', balance: 'Balance', logout: 'Sign out', signedOut: 'Sign in to view this chat’s creation projects' }
        await page.route('**/credits/api/**', async (route) => {
          const request = route.request()
          const url = new URL(request.url())
          const json = async (payload: unknown): Promise<void> => route.fulfill({ status: 200, json: { ok: true, payload } })
          if (url.pathname === '/credits/api/session' && request.method() === 'GET') {
            await json({ signedIn, creditsPerYuan: 1000, ...signedIn ? { account: { id: accountId, phone: '+8613800000000' } } : {} })
          } else if (url.pathname === '/credits/api/summary') {
            await json({ balance_points: 20000, as_of: new Date().toISOString() })
          } else if (url.pathname === '/credits/api/creative/projects') {
            const sessionId = url.searchParams.get('session_id') ?? ''
            reads.push(sessionId)
            await json({ accountId, projects: projects.get(sessionId) ?? [] })
          } else if (url.pathname === '/credits/api/creative/media') {
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
          } else await route.continue()
        })
        try {
          await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          await page.waitForSelector('[class*="frame"]')
          if (zh) await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
          else await connectFreshWorkspace(page, scaffold.workspaceCwd)
          const agent = scaffold.ctx.agents.list()[0]
          if (agent === undefined) throw new Error('The real workspace did not create its chat Agent')
          const sessionId = String(agent.session.id)
          projects.set(sessionId, [projectFixture(sessionId, join(evidence, 'qa-frame-025.png'), false)])
          await settleChat(scaffold, agent, 'QA · Creative chat')
          const body = page.locator(`[data-creative-session="${sessionId}"]`)
          await body.waitFor({ state: 'visible' })
          await body.getByText('QA · Station reunion', { exact: true }).waitFor()
          await body.getByText(labels.generating, { exact: true }).first().waitFor()
          const firstShot = body.locator('[data-creative-shot="shot-1"]')
          expect(await loadedImages(firstShot)).toBe(1)
          await page.screenshot({ path: join(evidence, 'running-dark-wide.png') })

          await body.getByRole('tab', { name: labels.characters, exact: true }).click()
          await body.getByText('QA · Lin', { exact: true }).waitFor()
          await body.locator('details').last().locator('summary').click()
          await body.getByText('Red scarf and navy coat', { exact: true }).waitFor()
          await body.getByText('Mandarin; gentle voice', { exact: true }).waitFor()
          expect(await loadedImages(body)).toBe(1)
          await page.screenshot({ path: join(evidence, 'characters.png') })
          await body.getByRole('tab', { name: labels.assets, exact: true }).click()
          await body.getByText('QA · Reference frame', { exact: true }).waitFor()
          await body.locator('details').last().locator('summary').click()
          await body.getByText(join(evidence, 'qa-frame-025.png'), { exact: true }).waitFor()
          expect(await loadedImages(body)).toBe(1)
          await page.screenshot({ path: join(evidence, 'assets.png') })
          const beforeAssetDraft = agent.session.snapshotEvents().filter(event => event.type === 'user/message').length
          await body.getByRole('button', { name: zh ? '重构素材' : 'Rework asset', exact: true }).click()
          const assetDialog = page.getByRole('dialog', {
            name: `${zh ? '重构素材' : 'Rework asset'} · QA · Reference frame`, exact: true,
          })
          await assetDialog.getByRole('textbox', { name: zh ? '希望怎样调整这份素材？' : 'How should this material change?', exact: true })
            .fill('Keep the red scarf and use a warmer palette.')
          await assetDialog.getByRole('button', { name: zh ? '写入聊天草稿' : 'Add to chat draft', exact: true }).click()
          const assetDraft = page.locator('[data-composer-input][contenteditable="true"]')
          await expect.poll(() => assetDraft.innerText()).toContain('asset_id=reference-1')
          expect(await assetDraft.innerText()).toContain(`plan_id=cp_qa_${sessionId}`)
          expect(await assetDraft.innerText()).not.toContain('shot_id=')
          expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(beforeAssetDraft)
          expect(paidRequests).toEqual([])
          await page.screenshot({ path: join(evidence, 'asset-rework-draft-only.png') })
          await body.getByRole('tab', { name: labels.shots, exact: true }).click()
          const beforeRefresh = reads.length
          projects.set(sessionId, [projectFixture(sessionId, join(evidence, 'qa-frame-025.png'), true)])
          await expect.poll(() => reads.length, { timeout: 15_000 }).toBeGreaterThan(beforeRefresh)
          await expect.poll(() => body.getByText(labels.generating, { exact: true }).count()).toBe(0)
          await body.locator('[data-creative-shot="shot-2"]').getByText(labels.complete, { exact: true }).waitFor()
          const shotVideo = body.locator('[data-creative-shot="shot-2"] video')
          await expect.poll(() => shotVideo.evaluate(element => element instanceof HTMLVideoElement
            ? element.duration : 0)).toBeCloseTo(1, 1)
          const decodedFrames = await loadedImages(body.locator('[data-creative-shot="shot-2"]'))
          expect(decodedFrames).toBe(2)

          await body.getByRole('tab', { name: labels.outputs, exact: true }).click()
          await body.getByText(zh ? '人声、口型与字幕同步：待核验' : 'Speech, lip sync and subtitle timing: unverified', { exact: true }).waitFor()
          const finalVideo = body.locator('video')
          await finalVideo.evaluate(async (element) => {
            if (!(element instanceof HTMLVideoElement)) throw new Error('Expected the real media element')
            element.muted = true
            await element.play()
          })
          await expect.poll(() => finalVideo.evaluate(element => element instanceof HTMLVideoElement
            ? element.currentTime : 0)).toBeGreaterThan(0)
          await finalVideo.evaluate((element) => { if (element instanceof HTMLVideoElement) element.pause() })
          for (const theme of ['dark', 'light'] as const) {
            await page.emulateMedia({ colorScheme: theme })
            await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(theme === 'dark')
            for (const width of [1280, 760]) {
              await page.setViewportSize({ width, height: 900 })
              await expect.poll(() => body.evaluate((element) => {
                const rect = element.getBoundingClientRect()
                return rect.left >= 0 && rect.right <= window.innerWidth + 1 && rect.width > 200
              })).toBe(true)
              await page.screenshot({ path: join(evidence, `outputs-${theme}-${width}.png`) })
            }
          }
          await page.setViewportSize({ width: 1280, height: 900 })
          await body.getByRole('tab', { name: labels.shots, exact: true }).click()
          const userMessages = agent.session.snapshotEvents().filter(event => event.type === 'user/message').length
          await firstShot.getByRole('button', { name: labels.redo, exact: true }).click()
          const composer = page.locator('[data-composer-input][contenteditable="true"]')
          await expect.poll(() => composer.innerText()).toContain(`plan_id=cp_qa_${sessionId}`)
          expect(await composer.innerText()).toContain('shot_id=shot-1')
          expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(userMessages)
          expect(paidRequests).toEqual([])
          await page.screenshot({ path: join(evidence, 'redo-draft-only.png') })

          const tab = page.locator('[data-dockkit-tab]').filter({ hasText: labels.title }).first()
          await tab.hover()
          await tab.locator('[data-dockkit-tab-close]').click()
          await expect.poll(() => body.isVisible()).toBe(false)
          await openCreation(page, labels.title, sessionId)
          await body.getByText('QA · Station reunion', { exact: true }).waitFor()

          const workspace = scaffold.ctx.workspaceRegistry.list()[0]
          if (workspace === undefined) throw new Error('Workspace registry lost the connected workspace')
          const second = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id })
          const secondAgent = scaffold.ctx.agents.get(second.sessionId)
          if (secondAgent === undefined) throw new Error('Second chat did not create an Agent')
          await settleChat(scaffold, secondAgent, 'QA · Empty chat')
          await page.locator(`[data-row-key="session:${second.sessionId}"]`).click()
          await expect.poll(() => body.isVisible()).toBe(false)
          await openCreation(page, labels.title, second.sessionId)
          const empty = page.locator(`[data-creative-session="${second.sessionId}"]`)
          await empty.getByText(zh ? '创作过程会在这里展开' : 'Your creation takes shape here', { exact: true }).waitFor()
          expect(await empty.getByText('QA · Station reunion', { exact: true }).count()).toBe(0)
          await page.screenshot({ path: join(evidence, 'other-chat-isolated.png') })
          await page.locator(`[data-row-key="session:${sessionId}"]`).click()
          await openCreation(page, labels.title, sessionId)
          await body.getByText('QA · Station reunion', { exact: true }).waitFor()
          await page.getByRole('button', { name: labels.balance, exact: true }).click()
          await page.getByRole('button', { name: labels.logout, exact: true }).click()
          await expect.poll(() => logoutCalls).toBe(1)
          await page.getByRole('button', { name: zh ? '聊天' : 'Chat', exact: true }).click()
          await openCreation(page, labels.title, sessionId)
          await body.getByText(labels.signedOut, { exact: true }).waitFor()
          expect(await body.locator('[data-creative-output]').count()).toBe(0)
          expect(await body.getByText('QA · Station reunion', { exact: true }).count()).toBe(0)
          await page.screenshot({ path: join(evidence, 'signed-out-cleared.png') })
          expect(paidRequests).toEqual([])
          expect(tripwire.pageErrors).toEqual([])
          expect(tripwire.warnings).toEqual([])
          await writeFile(join(evidence, 'result.json'), JSON.stringify({
            passed: true, locale, themes: ['dark', 'light'], widths: [1280, 760], sessionId, secondSessionId: second.sessionId,
            projectsRead: reads, mediaReads, paidRequests, logoutCalls, decodedFrames, videoMetadata: true, videoPlayback: true,
            characterDetails: true, characterReferencePreview: true, materialSource: true, assetOutputPreview: true,
            assetReworkOnlyDraft: true, refreshedToCompleted: true, redoOnlyDraft: true,
            tabReopened: true, chatIsolation: true, signedOutCleared: true,
            host: 'real shipped Web composition', substituted: 'account and creative API responses; local QA color-bar media',
            upstreamGeneration: false, speechLipSyncSubtitlesVerified: false,
            fixtureSha256: Object.fromEntries(Object.entries(media).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])),
          }, null, 2) + '\n')
          console.log(`Creative sidebar evidence: ${evidence}`)
        } catch (error) {
          await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined)
          await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), reads, mediaReads, paidRequests,
            pageErrors: tripwire.pageErrors, warnings: tripwire.warnings }, null, 2) + '\n')
          throw error
        }
      } finally { await browser.close() }
    } finally { await scaffold.close() }
  })
})
