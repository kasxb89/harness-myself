import { Context } from '@deepseek-ai/cordis'
import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import * as HostPlugin from '../src/index.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { plainConfig } from '../../../settings/settings/src/schema.ts'
import {
  DEFAULT_BUSY_ENTER_BEHAVIOR, Config, apply,
} from '@deepseek-ai/dsh-client-ui-conversation'


describe('ui-conversation host', () => {
  it('registers, validates, and disposes the durable conversation preferences', async () => {
    const ctx = new Context()
    const configuration = await liveConfig(ctx, { Config, apply })
    const { fiber } = configuration
    expect(plainConfig(configuration.fiber.config)).toEqual({ busyEnter: DEFAULT_BUSY_ENTER_BEHAVIOR, hiddenViews: [] })
    await configuration.update({ busyEnter: 'steer', hiddenViews: ['trajectory', 'ipollowork-video-studio'] })
    expect(plainConfig(configuration.fiber.config)).toEqual({ busyEnter: 'steer', hiddenViews: ['trajectory', 'ipollowork-video-studio'] })
    await expect(configuration.update({ busyEnter: 'invalid' })).rejects.toThrow()
    await expect(configuration.update({ hiddenViews: [17] })).rejects.toThrow()
    await fiber.dispose()
  })

  it('projects hidden Views from the live profile and publishes configuration updates on the settings wire', async () => {
    const fixture = await configurationFixture({ schema: HostPlugin.Config, apply: HostPlugin.apply, hmr: false })
    await fixture.ctx.fiber.dispose()
    writeFileSync(fixture.profile.patchPath, JSON.stringify([{ insert: [
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      { id: 'ui-conversation', name: 'cordis:probe', config: { hiddenViews: ['trajectory', 'ipollowork-video-studio'] } },
    ] }]))
    const host = await fixture.start()
    await host.loader.await()
    const describe = (): SettingsDescriptor => {
      const namespaces = JSON.parse(JSON.stringify(host.settings.describe({ redactSecrets: true }))) as SettingsDescriptor[]
      const projection = namespaces.find(value => value.ns === 'ui-conversation')
      if (projection === undefined) throw new Error('missing conversation settings projection')
      return projection
    }
    expect(describe()).toMatchObject({
      ns: 'ui-conversation', autoGenerate: false, applies: 'live',
      value: { busyEnter: 'queue', hiddenViews: ['trajectory', 'ipollowork-video-studio'] },
    })
    const projectedSchema = new z(describe().schema as z)
    expect(projectedSchema({ busyEnter: 'queue', hiddenViews: ['trajectory'] })).toEqual({
      busyEnter: 'queue', hiddenViews: ['trajectory'],
    })
    expect(() => { projectedSchema({ busyEnter: 'queue', hiddenViews: [17] }) }).toThrow()
    await host.settings.update('ui-conversation', { hiddenViews: [] })
    expect(describe()).toMatchObject({
      ns: 'ui-conversation', autoGenerate: false, applies: 'live',
      value: { busyEnter: 'queue', hiddenViews: [] },
    })
  }, 20_000)
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(ctx => ctx.plugin(HostPlugin)))
