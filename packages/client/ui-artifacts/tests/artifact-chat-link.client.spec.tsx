// @vitest-environment jsdom
/** Exact-source affordance and cancellation at file selection changes. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ArtifactChatLink } from '../src/client/ArtifactChatLink.tsx'
import { zh } from '../src/client/locales.ts'
import type { ArtifactEntry, ArtifactsInjected } from '../src/client/ArtifactsPage.tsx'

afterEach(cleanup)
const entry: ArtifactEntry = { path: '/out/result.mp4', name: 'result.mp4', kind: 'video', size: 42, mtimeMs: 10 }
const t: ArtifactsInjected['t'] = key => zh[key as keyof typeof zh]

it('offers a real chat action only after the Host provides an explicit matching source', async () => {
  const readOrigin = vi.fn<ArtifactsInjected['readOrigin']>(async () => ({ ok: true, value: { sessionId: 'source' as SessionId, turn: 1 } }))
  const returnToChat = vi.fn<ArtifactsInjected['returnToChat']>(async () => ({ ok: true, value: null }))
  render(<ArtifactChatLink entry={entry} readOrigin={readOrigin} returnToChat={returnToChat} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: '回到聊天' }))
  expect(returnToChat).toHaveBeenCalledWith(entry)
})

it('shows unavailable for older or unrelated files and offers retry for source read failures', async () => {
  const readOrigin = vi.fn<ArtifactsInjected['readOrigin']>(async () => ({ ok: false, code: 'ARTIFACT_ORIGIN_UNAVAILABLE' }))
  const returnToChat = vi.fn<ArtifactsInjected['returnToChat']>(async () => ({ ok: true, value: null }))
  render(<ArtifactChatLink entry={entry} readOrigin={readOrigin} returnToChat={returnToChat} t={t} />)
  expect(await screen.findByRole('status')).toHaveProperty('textContent', '无法读取来源聊天重试')
  readOrigin.mockResolvedValueOnce({ ok: true, value: null })
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByText('来源聊天不可用')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '回到聊天' })).toBeNull()
  expect(returnToChat).not.toHaveBeenCalled()
})
