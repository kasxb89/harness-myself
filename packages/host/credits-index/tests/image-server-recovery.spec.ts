import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { CreativeOperationId } from '../src/creative-store.ts'
import { ImageResultStore, type ImageResultRef } from '../src/image-result-store.ts'
import { imageServerTaskId } from '../src/image-server-task.ts'
import { imageServerArtifactUrl, imageServerResultRecovery, loadImageRecoverySources } from '../src/image-server-recovery.ts'

const model = 'fixture-retained-image'
const plugin = { key: 'codebloom-image', version: '1.0.0', api_version: 1 }
const row = (marker: unknown = plugin) => ({ model_name: model, kind: 'image', parameters: { 'x-task-plugin': marker } })

it('allows a retained server task to recover after its linked local manifest was not published', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'image-source-fallback-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const owner = { accountId: 'one', sessionFingerprint: 'login-one', sessionId: 'chat-one', workspaceRoot: root }
  const store = new ImageResultStore({ directory: join(root, 'results'), current: async () => owner })
  const scope = { owner, operationId: brandString<CreativeOperationId>('op_missing'), backendFingerprint: 'a'.repeat(64) }
  const ref = brandString<ImageResultRef>('ir_' + 'b'.repeat(64))
  const server = imageServerTaskId('task_codebloom_http_fixture')
  if (server === undefined) throw new Error('Expected validated server task')
  await expect(loadImageRecoverySources(() => store.load(scope, ref), undefined))
    .rejects.toMatchObject({ code: 'IMAGE_RESULT_UNAVAILABLE' })
  expect(await loadImageRecoverySources(() => store.load(scope, ref), server)).toEqual({ kind: 'server' })
})

describe('exact retained image declarations', () => {
  it('selects one exact reviewed model without relying on its name', () => {
    expect(imageServerResultRecovery([row()], model)).toBe(true)
    expect(imageServerResultRecovery([row()], 'codebloom-unlisted')).toBe(false)
    expect(imageServerResultRecovery([row(), row()], model)).toBe(false)
    expect(imageServerResultRecovery([row()], '')).toBe(false)
  })
  it.for([undefined, null, [], {}, { ...plugin, key: 'toapis' }, { ...plugin, key: 'ycapi' },
    { ...plugin, version: '1.0.1' }, { ...plugin, api_version: '1' }, { ...plugin, api_version: 2 },
    { ...plugin, retain: true }])('does not opt into another or incomplete declaration %#', (marker) => {
    const entry = marker === undefined ? { model_name: model, kind: 'image', parameters: {} } : row(marker)
    expect(imageServerResultRecovery([entry], model)).toBe(false)
  })
  it('does not borrow an image declaration for another modality or route', () => {
    expect(imageServerResultRecovery([{ ...row(), kind: 'video' }], model)).toBe(false)
    expect(imageServerResultRecovery([{ ...row(), kind: 'video', parameters: {
      'x-task-plugin': plugin, 'x-model-kind': 'image' } }], model)).toBe(false)
    expect(imageServerResultRecovery([{ ...row(), parameters: {
      'x-task-plugin': plugin, 'x-model-kind': 'video' } }], model)).toBe(false)
    expect(imageServerResultRecovery([{ ...row(), route: '/toapis/v1/images/generations' }], model)).toBe(false)
  })
})

describe('original gateway image artifact destinations', () => {
  const base = 'https://gateway.example/harness'
  const id = 'task_codebloom_http_fixture'
  const url = `${base}/v1/tasks/${id}/artifacts/image-1/content?access=synthetic-capability`
  it('keeps the deployment prefix, task, artifact and signed access value', () => {
    expect(imageServerArtifactUrl(base, id, 'image-1', url)).toBe(url)
  })
  it.each([
    'https://other.example/harness/v1/tasks/task_codebloom_http_fixture/artifacts/image-1/content?access=x',
    'https://gateway.example/v1/tasks/task_codebloom_http_fixture/artifacts/image-1/content?access=x',
    'https://gateway.example/harness/v1/tasks/task_other/artifacts/image-1/content?access=x',
    'https://gateway.example/harness/v1/tasks/task_codebloom_http_fixture/artifacts/image-2/content?access=x',
    'https://user:pass@gateway.example/harness/v1/tasks/task_codebloom_http_fixture/artifacts/image-1/content?access=x',
    `${url}#fragment`, `${url}&redirect=elsewhere`, `${url}&access=second`,
    url.replace('?access=synthetic-capability', ''), url.replace('synthetic-capability', ''),
    ` ${url}`, 'data:image/png;base64,AA==',
  ])('rejects an unrelated or unsigned result destination %#', (value) => {
    expect(imageServerArtifactUrl(base, id, 'image-1', value)).toBeUndefined()
  })
  it('rejects task and artifact identifiers that would change the canonical path', () => {
    expect(imageServerArtifactUrl(base, '../task_other', 'image-1', url)).toBeUndefined()
    expect(imageServerArtifactUrl(base, id, '..', url)).toBeUndefined()
    expect(imageServerArtifactUrl(base, id, 'image/other', url)).toBeUndefined()
  })
  it('accepts the published128-character artifact key bound and rejects a longer key', () => {
    const key = 'a'.repeat(128)
    const target = `${base}/v1/tasks/${id}/artifacts/${key}/content?access=synthetic-capability`
    expect(imageServerArtifactUrl(base, id, key, target)).toBe(target)
    expect(imageServerArtifactUrl(base, id, key + 'a', target)).toBeUndefined()
  })
})
