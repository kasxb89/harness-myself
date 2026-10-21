// @vitest-environment jsdom
/** Real command source, trigger controller, and input shell preserve local refusals. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { makeTranslate, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { InputTriggerService } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionInputShell } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/facade.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CommandUiRuntime } from '../src/client/service.ts'
import { en, zh } from '../src/client/locales.ts'

it.each([false, true])('keeps an unclaimed command attachment refusal local across the real pipeline (English: %s)', async (english) => {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const sessionId = 'command-envelope' as SessionId
  await runtime.sessions.add({ id: sessionId })
  const reference = runtime.sessions.retain(sessionId)
  onTestFinished(() => { reference.release() })
  await reference.ready
  const t = makeTranslate(english ? en : zh)
  runtime.ctx.provide('locale', { bind: () => t })
  const execute = vi.fn(async () => ({ ok: true as const, value: undefined }))
  runtime.remote.provideNamespaces({ commands: {
    list: async () => ({ ok: true as const, value: [{ name: 'echo', description: 'echo text' }] }),
    execute,
  } })
  await runtime.ctx.plugin(InputTriggerService).await()
  await runtime.ctx.plugin(CommandUiRuntime).await()
  const controller = runtime.ctx.inputTriggers.sessionOf(reference.binding.ctx)
  const sink = vi.fn(async () => ({ kind: 'success' as const }))
  const serialize = vi.fn(async () => [])
  const release = vi.fn()
  const shell = new SessionInputShell({
    actx: reference.binding.ctx, inputTriggers: () => controller, defaultSink: sink,
    commandAttachments: { serialize, release, unsupportedNotice: token => t('notice.attachmentsUnsupported', { command: token }) },
  })
  onTestFinished(() => { shell.dispose() })
  const attachments = ['image-a', 'file-b'] as DraftAttachmentId[]
  shell.setDraft('/echo')
  shell.addAttachments(attachments)
  shell.submit('queue')
  await vi.waitFor(() => { expect(shell.notices.getSnapshot()?.text).toBe(t('notice.attachmentsUnsupported', { command: 'echo' })) })
  expect(shell.notices.getSnapshot()?.presentation).toBeUndefined()
  expect(shell.snapshot.phase).toBe('plain')
  expect(shell.snapshot.draft).toBe('/echo')
  expect(shell.snapshot.attachmentIds).toEqual(attachments)
  expect(execute).not.toHaveBeenCalled()
  expect(sink).not.toHaveBeenCalled()
  expect(serialize).not.toHaveBeenCalled()
  expect(release).not.toHaveBeenCalled()
})
