/**
 * Optional MCP overlays use the real config parser and local MCP transports,
 * without contacting providers.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as McpClient from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { startHttpMcpFixture } from '../../../packages/mcp/mcp-client/tests/http-fixture.ts'

interface Example {
  file: string
  serverName: string
  url?: string
  secret?: string
  requiredSecret?: boolean
  keyless?: boolean
}

interface InsertedRow {
  id?: string
  name?: string
  config?: Record<string, unknown>
}

const root = resolve(import.meta.dirname, '../../..')
const exampleDir = resolve(root, 'apps/cli/config/examples/mcp-tools')
const baseConfig = resolve(import.meta.dirname, 'fixtures/memory-mcp-base.cordis.yml')
const fixtureServer = resolve(root, 'packages/mcp/mcp-client/tests/fixture-server.ts')
const fixtureToken = 'local-config-fixture-token'
const examples: Example[] = [
  {
    file: 'context7.cordis.yml',
    serverName: 'context7',
    url: 'https://mcp.context7.com/mcp',
    secret: 'CONTEXT7_API_KEY',
    requiredSecret: true,
  },
  {
    file: 'github-readonly.cordis.yml',
    serverName: 'github',
    url: 'https://api.githubcopilot.com/mcp/readonly',
    secret: 'GITHUB_MCP_PAT',
    requiredSecret: true,
  },
  {
    file: 'firecrawl.cordis.yml',
    serverName: 'firecrawl',
    url: 'https://mcp.firecrawl.dev/v2/mcp',
    secret: 'FIRECRAWL_API_KEY',
    keyless: true,
  },
  {
    file: 'tavily.cordis.yml',
    serverName: 'tavily',
    url: 'https://mcp.tavily.com/mcp',
    secret: 'TAVILY_API_KEY',
    requiredSecret: true,
  },
  { file: 'markitdown.cordis.yml', serverName: 'markitdown' },
]

beforeEach(() => {
  for (const example of examples) {
    if (example.secret !== undefined) vi.stubEnv(example.secret, '')
  }
})

afterEach(() => { vi.unstubAllEnvs() })

function readExample(example: Example): { patches: PatchOptions[]; row: InsertedRow } {
  return readOverlay(resolve(exampleDir, example.file))
}

function readOverlay(path: string): { patches: PatchOptions[]; row: InsertedRow } {
  const patches = loadOverlayPatches('common-mcp-config-test', path)
  expect(patches).toHaveLength(1)
  expect(patches[0]?.insert).toHaveLength(1)
  const row = patches[0]!.insert![0]! as InsertedRow
  return { patches, row }
}

function resolvedConfig(row: InsertedRow): McpClient.Config {
  const raw: unknown = interpolate({}, row.config)
  // The callable schema validates the untyped Loader result before it becomes a configuration.
  return McpClient.Config(raw as Parameters<typeof McpClient.Config>[0])
}

async function waitForTool(ctx: Context, name: string): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.tools.schemas().some(schema => schema.name === name)).toBe(true)
  }, { timeout: 10_000, interval: 25 })
}

describe('common MCP example overlays', () => {
  it.each(examples)('parses $file and resolves its declared credential fields', (example) => {
    if (example.secret !== undefined) vi.stubEnv(example.secret, ` ${fixtureToken} `)
    const { row } = readExample(example)
    const config = resolvedConfig(row)

    expect(row.name).toBe('@deepseek-ai/dsh-mcp-client')
    expect(row.id).toMatch(/^tools-/)
    expect(config.serverName).toBe(example.serverName)
    expect(config.failOnStartupError).toBe(false)
    if (config.transport === 'streamable-http') {
      expect(config.url).toBe(example.url)
      expect(new URL(config.url).search).toBe('')
      expect(config.headers).toEqual(example.keyless ? {} : { Authorization: `Bearer ${fixtureToken}` })
    } else {
      expect(config.command).toBe('markitdown-mcp')
      expect(config.args).toEqual([])
      expect(config.env).toEqual({})
      expect(config.cwd).toBe(process.cwd())
      expect(readFileSync(resolve(exampleDir, example.file), 'utf8')).toContain('0.0.1a8')
    }
  })

  it.each(examples.filter(example => example.requiredSecret))('names the missing credential for $file', (example) => {
    const { row } = readExample(example)
    expect(() => { interpolate({}, row.config) }).toThrow(example.secret)
  })

  it('keeps Firecrawl keyless and validates its documented opt-in account header', () => {
    const example = examples.find(example => example.serverName === 'firecrawl')!
    const { row } = readExample(example)
    const config = resolvedConfig(row)
    expect(config.transport).toBe('streamable-http')
    if (config.transport !== 'streamable-http') throw new Error('Firecrawl requires HTTP')
    expect(config.headers).toEqual({})
    vi.stubEnv('FIRECRAWL_API_KEY', fixtureToken)
    const stillKeyless = resolvedConfig(readExample(example).row)
    if (stillKeyless.transport !== 'streamable-http') throw new Error('Firecrawl requires HTTP')
    expect(stillKeyless.headers).toEqual({})

    const guide = readFileSync(resolve(root, 'docs/user/guide/mcp-tools.md'), 'utf8')
    const headers = /```yaml\n(headers:[\s\S]*?)\n```/u.exec(guide)?.[1]
    if (headers === undefined) throw new Error('The Firecrawl guide must provide its supported per-header mapping')
    const accountOverlay = readFileSync(resolve(exampleDir, example.file), 'utf8')
      .replace('        headers: {}', headers.split('\n').map(line => `        ${line}`).join('\n'))
    const directory = mkdtempSync(resolve(tmpdir(), 'dsh-firecrawl-account-config-'))
    try {
      const path = resolve(directory, 'account.cordis.yml')
      writeFileSync(path, accountOverlay)
      const account = readOverlay(path)
      vi.stubEnv('FIRECRAWL_API_KEY', '')
      expect(() => { resolvedConfig(account.row) }).toThrow('FIRECRAWL_API_KEY')
      vi.stubEnv('FIRECRAWL_API_KEY', ` ${fixtureToken} `)
      const authenticated = resolvedConfig(account.row)
      if (authenticated.transport !== 'streamable-http') throw new Error('Firecrawl account requires HTTP')
      expect(authenticated.headers).toEqual({ Authorization: `Bearer ${fixtureToken}` })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('gives each optional connection a distinct insertion id and namespace', () => {
    const rows = examples.map(example => readExample(example).row)
    expect(new Set(rows.map(row => row.id)).size).toBe(examples.length)
    expect(new Set(examples.map(example => example.serverName)).size).toBe(examples.length)
  })

  it.each(examples)('discovers $file tools through a local MCP fixture', async (example) => {
    if (example.secret !== undefined) vi.stubEnv(example.secret, fixtureToken)
    const { patches, row } = readExample(example)
    row.name = 'cordis:memory-test-mcp-client'
    const http = example.url === undefined ? undefined : await startHttpMcpFixture()
    row.config = http === undefined
      ? { ...row.config, command: process.execPath, args: [fixtureServer], cwd: root }
      : { ...row.config, url: http.url }
    let ctx: Context | undefined
    try {
      ctx = await boot('common-mcp-config-test', baseConfig, patches, (host) => {
        ctx = host
        host.loader.builtins['memory-test-system-prompt'] = SystemPrompt
        host.loader.builtins['memory-test-tools'] = ToolRuntime
        host.loader.builtins['memory-test-mcp-client'] = McpClient
      })
      await waitForTool(ctx, `mcp__${example.serverName}__${http === undefined ? 'greet' : 'ping'}`)
      if (http !== undefined) {
        expect(http.authorization.length).toBeGreaterThan(0)
        expect(http.authorization.every(value => value === (example.keyless ? undefined : `Bearer ${fixtureToken}`))).toBe(true)
      }
    } finally {
      try {
        await ctx?.fiber.dispose()
      } finally {
        await http?.close()
      }
    }
  }, 15_000)
})
