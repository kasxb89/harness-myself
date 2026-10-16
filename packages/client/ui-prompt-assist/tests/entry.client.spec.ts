// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { afterEach, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

const roots: Context[] = []
afterEach(async () => { for (const root of roots.splice(0)) await root.fiber.dispose() })

it('releases the shared factory and dictionaries on unload and permits a fresh registration', async () => {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const start = async () => {
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    return fiber
  }
  const first = await start()
  expect(ctx.slots.snapshot('factory:creation.prompt.assist')).toMatchObject([{ name: 'creation.prompt.assist', scope: 'root' }])
  expect(ctx.locale.bind('prompt-assist')('title')).not.toBe('title')
  await first.dispose()
  expect(ctx.slots.snapshot('factory:creation.prompt.assist')).toEqual([])
  expect(ctx.locale.bind('prompt-assist')('title')).toBe('title')
  await start()
  expect(ctx.slots.snapshot('factory:creation.prompt.assist')).toHaveLength(1)
})
