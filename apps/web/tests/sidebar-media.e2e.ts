/** Actual video decode, playback and seek through native and optional installed legacy sidebars. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-artifacts-index'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

const fixture = fileURLToPath(new URL('./fixtures/sidebar-media/preview.mp4', import.meta.url))
const overlay = fileURLToPath(new URL('./fixtures/artifact-library/cordis.patch.yml', import.meta.url))
// Optional external-compatibility lane uses an independently downloaded, unmodified official package.
const legacyPackage = process.env.DSH_TEST_LEGACY_SIDEBAR_PACKAGE

/** Verify decoded frames, real time advancement, and seeking; a video element alone is insufficient. */
async function plays(video: Locator): Promise<void> {
  await video.waitFor({ state: 'visible' })
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) =>
    node.readyState >= 2 && node.videoWidth === 320 && node.videoHeight === 180)).toBe(true)
  await video.evaluate(async (node: HTMLVideoElement) => { node.muted = true; await node.play() })
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(0.1)
  await video.evaluate((node: HTMLVideoElement) => { node.pause(); node.currentTime = 2 })
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) =>
    !node.seeking && node.currentTime >= 1.9 && node.currentTime <= 2.1)).toBe(true)
  await video.evaluate(async (node: HTMLVideoElement) => { await node.play() })
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(2.1)
  await video.evaluate((node: HTMLVideoElement) => { node.pause() })
}

/** Open a real closing-turn prose reference without going through an OS application. */
async function openProse(page: Page, name: string): Promise<void> {
  await page.getByText(name, { exact: true }).first().click()
}

for (const legacy of [false, true]) {
  it.skipIf(legacy && legacyPackage === undefined)(
    'plays and seeks saved MP4 from chat through ' + (legacy ? 'official better-sidebar 0.19.1' : 'the native sidebar'),
    async () => {
      const evidenceRoot = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
      await mkdir(evidenceRoot, { recursive: true })
      const evidence = await mkdtemp(join(evidenceRoot, legacy ? 'legacy-sidebar-video-' : 'native-sidebar-video-'))
      if (legacy) {
        if (legacyPackage === undefined) throw new Error('legacy package prerequisite missing')
        const original = await readFile(join(legacyPackage, 'lib/client.js'))
        expect(createHash('sha256').update(original).digest('hex'))
          .toBe('8df8206765abf49a625949631156414bf6964fe56f1266f2b8dc2c9f0e9a0241')
      }
      const cleanup: { scaffold?: () => Promise<void>; browser?: () => Promise<void> } = {}
      onTestFinished(async () => {
        try { await cleanup.browser?.() }
        finally { await cleanup.scaffold?.() }
      })
      const scaffold = await launchWebScaffold({ extraOverlayPath: overlay,
        ...(legacy && legacyPackage !== undefined ? {
          profile: { hmr: false, packages: [{ dir: legacyPackage, enabled: true }] },
        } : {}),
      })
      cleanup.scaffold = () => scaffold.close()
      const browser = await chromium.launch({
        ...(process.env.DSH_TEST_BROWSER_EXECUTABLE === undefined ? {} : {
          executablePath: process.env.DSH_TEST_BROWSER_EXECUTABLE,
        }),
      })
      cleanup.browser = () => browser.close()
      const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1500, height: 1000 } })
      const consoleState = watchConsole(page)
      const streams: { status: number; range: string | null; type: string | null }[] = []
      page.on('response', (response) => {
        if (new URL(response.url()).pathname === '/artifacts/api/raw' && response.request().method() === 'GET') {
          streams.push({ status: response.status(), range: response.headers()['content-range'] ?? null,
            type: response.headers()['content-type'] ?? null })
        }
      })
      try {
        await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        await connectFreshWorkspace(page, scaffold.workspaceCwd)
        const agent = scaffold.ctx.agents.list()[0]
        if (agent === undefined) throw new Error('fixture has no addressed Session')
        const signal = new AbortController().signal
        const bytes = await readFile(fixture)
        const destination = await scaffold.ctx.artifactStorage.capture(signal)
        const managed = await scaffold.ctx.artifactStorage.write({ destination,
          filename: '剧情 预览 #1.mp4', bytes, signal })
        const cwd = agent.session.header.cwd ?? scaffold.workspaceCwd
        const workspaceName = '工作区 片段 #2.mp4'
        await writeFile(join(cwd, workspaceName), bytes)
        agent.session.append('turn/start', { turn: 1 })
        agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'Preview these generated videos.' }], source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        agent.session.append('step/start', { turn: 1, step: 1 })
        agent.session.append('deliverables/presented', { turn: 1, callId: 'media-present' as never,
          files: [{ path: managed.path, description: 'Managed video outside the working directory' },
            { path: workspaceName, description: 'Workspace video' }],
        })
        agent.session.append('assistant/message', { stream: [], turn: 1, step: 1,
          message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
            content: [{ type: 'text', text: 'Ready. [' + 'Saved video' + '](<' + managed.path + '>) and `' + workspaceName + '`.' }],
          }),
        }, { surfaceOp: 'append' })
        agent.session.append('step/end', { turn: 1, step: 1 })
        agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        await scaffold.ctx.sessions.flush(agent.session)
        await page.getByText('Ready.').waitFor()
        const video = page.locator('[data-rightbar-col] video:visible').first()
        const card = page.locator('[data-presented-file]').filter({ hasText: '剧情 预览 #1.mp4' })
        await card.getByRole('button').first().click()
        await plays(video)
        const firstSource = await video.getAttribute('src')
        expect(firstSource).toContain('/artifacts/api/raw?')
        expect(firstSource).not.toContain('/sidebar/file')
        expect(firstSource).not.toContain('workspaceId=')
        const previous = await video.elementHandle()
        await openProse(page, workspaceName)
        await plays(video)
        expect(await previous?.evaluate((node: HTMLVideoElement) => node.paused && !node.hasAttribute('src'))).toBe(true)
        const scoped = new URL(await video.getAttribute('src') ?? '', scaffold.baseUrl)
        expect(scoped.searchParams.get('workspaceId')).not.toBeNull()
        await page.screenshot({ path: join(evidence, 'right-sidebar-playing.png'), animations: 'disabled' })
        expect(streams.some(stream => stream.status === 206 && stream.range?.startsWith('bytes ')
          && stream.type?.startsWith('video/mp4'))).toBe(true)
        expect(consoleState.pageErrors).toEqual([])
        await writeFile(join(evidence, 'playback.json'), JSON.stringify({ legacy, streams,
          managed: managed.path, workspace: join(cwd, workspaceName), decoded: true, played: true, seeked: true,
          pageErrors: consoleState.pageErrors }, null, 2) + '\n')
        console.info('Video preview browser evidence: ' + evidence)
      } catch (error) {
        await saveFailureShot(page, evidence + '/failure')
        throw error
      }
    },
  )
}
