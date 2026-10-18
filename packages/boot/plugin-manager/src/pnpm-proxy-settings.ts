/** Read pnpm 11's effective proxy settings in a child whose environment matches the package operation. */
import { execa } from 'execa'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/** Only these effective network settings leave the isolated reader; auth and diagnostics never do. */
const READ_PROXY_SETTINGS = `
const { getConfig } = await import(process.argv[1]);
const { findWorkspaceDir } = await import(process.argv[3]);
const workspaceDir = await findWorkspaceDir(process.cwd());
const { config } = await getConfig({cliOptions: {dir: process.cwd()}, workspaceDir, packageManager: {name: 'pnpm', version: process.argv[2]}, env: process.env});
process.stdout.write(JSON.stringify({httpProxy: config.httpProxy ?? null, httpsProxy: config.httpsProxy ?? null, noProxy: config.noProxy ?? null}));
`

/**
 * Resolve the original pnpm configuration before injecting the installation's local router.
 * @param dir Profile directory used by the real installation.
 * @param options Actual pnpm executable, launcher arguments, original environment, cancellation and one shared deadline.
 * @returns Original environment overlaid only with effective proxy settings read by pnpm's official reader.
 * @throws {Error} When pnpm is not version 11, configuration exceeds the deadline, or output is invalid.
 * No config values are reported.
 */
export async function readPnpmProxyEnvironment(
  dir: string,
  options: { command: string; args?: readonly string[]; env?: Readonly<Record<string, string>>; signal: AbortSignal; timeoutMs: number },
): Promise<Readonly<Record<string, string>>> {
  const env = { ...scrubbedParentEnv(), ...options.env }
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
  try {
    const version = await execa(options.command, [...options.args ?? [], '--version'], {
      cwd: dir, env, extendEnv: false, stdin: 'ignore', cancelSignal: signal,
      killDescendants: true, killSignal: 'SIGKILL',
    })
    const installed = version.stdout.trim()
    if (!/^11\.\d+\.\d+(?:[-+].*)?$/u.test(installed)) throw new Error('GitHub download routing requires pnpm 11')
    const result = await execa(process.execPath, ['--input-type=module', '-e', READ_PROXY_SETTINGS,
      import.meta.resolve('@pnpm/config.reader'), installed, import.meta.resolve('@pnpm/workspace.root-finder')], {
      cwd: dir, env, extendEnv: false, stdin: 'ignore', cancelSignal: signal,
      killDescendants: true, killSignal: 'SIGKILL',
    })
    const value: unknown = JSON.parse(result.stdout)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid proxy settings')
    const settings = value as Record<string, unknown>
    for (const field of ['httpProxy', 'httpsProxy', 'noProxy']) {
      const setting = settings[field]
      if (setting !== null && typeof setting !== 'string') throw new Error('invalid proxy setting')
    }
    for (const [field, names] of [
      ['httpProxy', ['http_proxy', 'HTTP_PROXY']], ['httpsProxy', ['https_proxy', 'HTTPS_PROXY']], ['noProxy', ['no_proxy', 'NO_PROXY']],
    ] as const) {
      const setting = settings[field]
      if (typeof setting === 'string') for (const name of names) env[name] = setting
    }
    return env
  } catch (error) {
    throw new Error('Cannot read the original pnpm 11 proxy settings; the installation was not started', { cause: error })
  }
}
