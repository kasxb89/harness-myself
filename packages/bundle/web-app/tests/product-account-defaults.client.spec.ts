/** Actual UI plugin configuration remains in the Client compiler program. */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import * as Account from '@deepseek-ai/dsh-client-ui-settings-account'
import * as Models from '@deepseek-ai/dsh-client-ui-settings-models'
import { ONBOARDING_CONFIG_GLOBAL } from '@deepseek-ai/dsh-client-ui-settings-models/src/onboarding-config.ts'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { load } from 'js-yaml'
import { expect, it, onTestFinished } from 'vitest'

it('omits official account activation and publishes the product automatic-key setting through the Loader', async () => {
  const patches = load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), {
    schema: entryListSchema,
  }) as PatchOptions[]
  const rows = patches.flatMap(patch => patch.insert ?? [])
  const entry = (id: string) => {
    const row = rows.find(candidate => candidate.id === id)
    if (row === undefined) throw new Error(`missing inserted entry: ${id}`)
    return row
  }
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.baseUrl = 'file:///'
  await ctx.plugin(Loader).await()
  ctx.loader.builtins.account = Account
  ctx.loader.builtins.models = Models
  await ctx.loader.root.update([
    { ...entry('ui-settings-account'), name: 'cordis:account' },
    { ...entry('ui-settings-models'), name: 'cordis:models' },
  ])
  await ctx.loader.await()
  expect(ctx.loader.resolve('ui-settings-account').disabled).toBe(true)
  expect(ctx.loader.resolve('ui-settings-account').fiber).toBeUndefined()
  const injections: IndexInjection[] = []
  ctx.emit('webserver/index-inject', injections)
  expect(injections).toEqual([{
    kind: 'global', name: ONBOARDING_CONFIG_GLOBAL, value: { credentialOnboarding: false },
  }])
  await ctx.loader.root.update([])
  const after: IndexInjection[] = []
  ctx.emit('webserver/index-inject', after)
  expect(after).toEqual([])
})
