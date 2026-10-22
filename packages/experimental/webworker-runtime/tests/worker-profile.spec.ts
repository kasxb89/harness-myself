/** Worker deployment settings preserve the original host composition and Loader capability decisions. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import yaml from 'js-yaml'
import { expect, it, vi } from 'vitest'
import { workerProfileOverlays } from '../src/worker-profile.ts'

const nativeId = 'computer-use-cua-driver-native'
const nativeName = '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native'
const webPatch = fileURLToPath(new URL('../../../bundle/web-app/cordis.patch.yml', import.meta.url))

it('retains the shipped native row for Node/Desktop while the Worker Loader never imports its SDK or publishes its tools', async (test) => {
  const source = readFileSync(webPatch, 'utf8')
  const patches = yaml.load(source, { schema: entryListSchema }) as PatchOptions[]
  const row = patches.flatMap(patch => patch.insert ?? []).find(entry => entry.id === nativeId)
  expect(row).toMatchObject({ id: nativeId, name: nativeName })
  if (row === undefined) throw new Error('Shipped native provider row is missing')
  expect(row.disabled).toBeUndefined()
  const original = structuredClone(row)
  const overlays = workerProfileOverlays([row])
  const warnings = vi.fn()
  const effective = applyEntryPatches([row], overlays, warnings)
  expect(effective).toEqual([{ ...row, disabled: true }])
  expect(row).toEqual(original)
  expect(readFileSync(webPatch, 'utf8')).toBe(source)
  expect(warnings).not.toHaveBeenCalled()

  const ctx = new Context()
  test.onTestFinished(async () => { await ctx.fiber.dispose(); vi.restoreAllMocks() })
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(Loader, {})
  const imports = vi.spyOn(ctx.loader, 'import').mockRejectedValue(new Error('Native SDK import is forbidden in this offline check'))
  await ctx.loader.root.update(effective)
  await ctx.loader.await()
  expect(ctx.loader.resolve(nativeId).disabled).toBe(true)
  expect(imports).not.toHaveBeenCalled()
  const model = await ctx.systemPrompt.assemble()
  expect(model.tools).toEqual([])
  expect(renderPrompt(model)).not.toContain('Cua Driver')
})

it('does not disable a different provider merely because its row id matches', () => {
  const rows = [{ id: nativeId, name: 'different-provider' }]
  expect(workerProfileOverlays(rows)).toEqual([])
})

it('leaves an absent native provider absent and preserves the JSONL settings', () => {
  const row: EntryOptions = { id: 'session-persistence-jsonl', name: 'logs', config: { compression: 'zstd', fsync: true } }
  const rows = [{ id: 'group', name: 'cordis:group', config: [row] }]
  expect(workerProfileOverlays(rows)).toEqual([{ id: 'session-persistence-jsonl', config: { compression: 'none', fsync: true } }])
  expect(row.config).toEqual({ compression: 'zstd', fsync: true })
  expect(workerProfileOverlays([])).toEqual([])
})
