import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesktopOss, verifyDesktopOssPublicObject } from '../scripts/desktop-oss.ts'
import { uploadDesktopOssRelease, uploadDesktopRelease } from '../scripts/desktop-upload-run.ts'
import type { DesktopUploadPlan } from '../scripts/desktop-upload-plan.ts'
import { createDesktopCos } from '../scripts/desktop-cos.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

interface ObjectBytes { bytes: string; cacheControl?: string }
interface State {
  objects: Record<string, ObjectBytes>
  versioning?: string
  failKey?: string
  readFailure?: string
}
interface Command { args: string[]; leaked: boolean }

async function fixture(options: { previousVersion?: string; versioning?: string; failKey?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-oss-release-'))
  roots.push(root)
  const statePath = join(root, 'state.json')
  const callsPath = join(root, 'calls.jsonl')
  const executable = join(root, 'fake-ossutil')
  const binaryKey = 'yunshu-harnes/bin/win-x64/package-1.2.4.exe'
  const feedKey = 'yunshu-harnes/feeds/win-x64/nightly.yml'
  const binary = join(root, 'package-1.2.4.exe')
  const binaryBytes = 'signed fixture binary'
  const newFeed = 'version: 1.2.4\n'
  const previousFeed = options.previousVersion === undefined ? undefined : `version: ${options.previousVersion}\n`
  await writeFile(binary, binaryBytes)
  await writeFile(statePath, JSON.stringify({ ...options, objects: previousFeed === undefined ? {} : {
    [feedKey]: { bytes: Buffer.from(previousFeed).toString('base64') },
  } } satisfies State))
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const statePath = ${JSON.stringify(statePath)}
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, leaked: process.env.TEST_UPLOAD_SECRET !== undefined || process.env.OSS_ACCESS_KEY_ID !== undefined }) + '\\n')
const flag = name => args[args.indexOf(name) + 1]
const fail = code => { process.stderr.write('Error Code: ' + code + '.\\nprivate-fixture-secret\\n'); process.exit(2) }
if (args[0] === 'cat') {
  if (state.readFailure) fail(state.readFailure)
  const key = new URL(args[1]).pathname.slice(1)
  if (!state.objects[key]) fail('NoSuchKey')
  process.stdout.write(Buffer.from(state.objects[key].bytes, 'base64'))
} else if (args[1] === 'get-bucket-versioning') {
  process.stdout.write(JSON.stringify({ '+@xmlns': 'http://doc.oss-cn-hangzhou.aliyuncs.com', ...(state.versioning ? { Status: state.versioning } : {}) }))
} else if (args[1] === 'head-object') {
  if (!state.objects[flag('--key')]) fail('NoSuchKey')
  process.stdout.write('{}')
} else if (args[1] === 'put-object') {
  const key = flag('--key')
  if (state.failKey === key) fail('AccessDenied')
  if (args.includes('--forbid-overwrite=true') && state.objects[key]) fail('FileAlreadyExists')
  state.objects[key] = { bytes: fs.readFileSync(flag('--body').slice(7)).toString('base64'),
    ...(args.includes('--cache-control') ? { cacheControl: flag('--cache-control') } : {}) }
  fs.writeFileSync(statePath, JSON.stringify(state))
  process.stdout.write('{}')
} else if (args[1] === 'delete-object') {
  delete state.objects[flag('--key')]
  fs.writeFileSync(statePath, JSON.stringify(state))
  process.stdout.write('{}')
} else fail('UnexpectedCommand')
`, { mode: 0o700 })
  const settings = { executable, configFile: join(root, 'private-ossutil.ini'), region: 'cn-beijing', namespace: 'yunshu-harnes' }
  const plan: DesktopUploadPlan = {
    provider: 'oss', oss: settings, environment: 'production', target: 'win-x64', version: '1.2.4', bucket: 'yunshu666',
    publicUrl: 'https://alioss.denuoxuankeji.com/yunshu-harnes/feeds/win-x64/', secretIdEnvName: '', secretKeyEnvName: '',
    artifacts: [
      { path: binary, filename: 'package-1.2.4.exe', key: binaryKey, channelMetadata: false, contentType: 'application/octet-stream' },
      { path: join(root, 'nightly.yml'), filename: 'nightly.yml', key: feedKey, channelMetadata: true,
        contentType: 'application/yaml', contents: newFeed },
    ],
  }
  const readState = async (): Promise<State> => JSON.parse(await readFile(statePath, 'utf8')) as State
  const calls = async (): Promise<Command[]> => (await readFile(callsPath, 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as Command)
  const publicRequests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    publicRequests.push(url)
    const object = (await readState()).objects[new URL(url).pathname.slice(1)]
    return new Response(object === undefined ? null : Buffer.from(object.bytes, 'base64'), {
      status: object === undefined ? 404 : 200,
      headers: object?.cacheControl === undefined ? {} : { 'cache-control': object.cacheControl },
    })
  }))
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  return { root, settings, plan, binaryKey, feedKey, binaryBytes, previousFeed, newFeed, statePath, calls, readState,
    publicRequests, records: join(root, 'records'), oss: createDesktopOss(settings) }
}

function businessPuts(commands: Command[]): Command[] {
  return commands.filter(command => command.args[1] === 'put-object'
    && !command.args[command.args.indexOf('--key') + 1]?.includes('/locks/'))
}

describe.skipIf(process.platform === 'win32')('OSS release through an isolated ossutil subprocess', () => {
  it('publishes verified packages before no-store manifests, retains previous bytes and excludes credential material', async () => {
    const f = await fixture({ previousVersion: '1.2.3' })
    vi.stubEnv('TEST_UPLOAD_SECRET', 'private-fixture-secret')
    vi.stubEnv('OSS_ACCESS_KEY_ID', 'private-fixture-secret')
    const directory = await uploadDesktopOssRelease(f.plan, f.oss, f.records)
    const commands = await f.calls()
    const puts = businessPuts(commands)
    const keys = puts.map(command => command.args[command.args.indexOf('--key') + 1]!)
    expect(keys[0]).toBe(f.binaryKey)
    expect(keys[1]).toMatch(/^yunshu-harnes\/history\/win-x64\/production-win-x64-[^/]+\/nightly\.yml$/u)
    expect(keys[2]).toBe(f.feedKey)
    expect(f.publicRequests.map(url => new URL(url).pathname.slice(1))).toEqual(keys)
    expect(puts.map(command => command.args.includes('--forbid-overwrite=true'))).toEqual([true, true, false])
    for (const command of commands) {
      expect(command.leaked).toBe(false)
      expect(command.args).toContain('--ignore-env-var')
      expect(command.args[command.args.indexOf('--retry-times') + 1]).toBe('0')
      expect(command.args[command.args.indexOf('--config-file') + 1]).toBe(f.settings.configFile)
      expect(command.args).not.toContain('--access-key-secret')
    }
    for (const command of puts.slice(1)) expect(command.args[command.args.indexOf('--cache-control') + 1]).toBe('no-store')
    expect(await readFile(join(directory, 'previous-nightly.yml'), 'utf8')).toBe(f.previousFeed)
    const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')) as object
    expect(result).toMatchObject({ success: true, confirmedPuts: 3, verifiedObjects: 3, publicReadback: 'verified' })
    const audit = await Promise.all(['plan.json', 'events.jsonl', 'result.json'].map(name => readFile(join(directory, name), 'utf8')))
    expect(audit.join('')).not.toMatch(/private-fixture-secret|private-ossutil|OSS_ACCESS_KEY_ID|configFile/iu)
    expect((await f.readState()).objects[keys[1]!]!.bytes).toBe(Buffer.from(f.previousFeed!).toString('base64'))
    expect((await f.readState()).objects['yunshu-harnes/locks/win-x64.json']).toBeUndefined()
  })

  it.each(['1.2.4', '1.2.5', 'invalid'])('rejects existing manifest version %s before any artifact write', async (previousVersion) => {
    const f = await fixture({ previousVersion })
    await expect(uploadDesktopOssRelease(f.plan, f.oss, f.records)).rejects.toThrow('stopped at version-preflight')
    expect(businessPuts(await f.calls())).toHaveLength(0)
  })

  it('preflights all package keys and refuses an existing immutable installer', async () => {
    const f = await fixture()
    const state = await f.readState()
    state.objects[f.binaryKey] = { bytes: Buffer.from('older bytes').toString('base64') }
    await writeFile(f.statePath, JSON.stringify(state))
    await expect(uploadDesktopOssRelease(f.plan, f.oss, f.records)).rejects.toThrow('stopped at package-preflight')
    expect(businessPuts(await f.calls())).toHaveLength(0)
  })

  it.each(['Enabled', 'Suspended'])('refuses bucket versioning %s before writing', async (versioning) => {
    const f = await fixture({ versioning })
    await expect(uploadDesktopOssRelease(f.plan, f.oss, f.records)).rejects.toThrow('stopped at bucket-preflight')
    expect(await f.calls()).toHaveLength(1)
  })

  it('stops after one failed PUT without revealing raw ossutil diagnostics', async () => {
    const f = await fixture({ failKey: 'yunshu-harnes/bin/win-x64/package-1.2.4.exe' })
    await expect(uploadDesktopOssRelease(f.plan, f.oss, f.records)).rejects.toThrow('stopped at put')
    expect(businessPuts(await f.calls())).toHaveLength(1)
    const directory = join(f.records, (await readdir(f.records))[0]!)
    expect(await readFile(join(directory, 'result.json'), 'utf8')).not.toContain('private-fixture-secret')
    expect(f.publicRequests).toHaveLength(0)
    expect((await f.readState()).objects['yunshu-harnes/locks/win-x64.json']).toBeDefined()
  })

  it('does not publish manifests when a public package has mismatching bytes', async () => {
    const f = await fixture()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('corrupt package bytes', { status: 200 })))
    await expect(uploadDesktopOssRelease(f.plan, f.oss, f.records)).rejects.toThrow('stopped at public-readback')
    expect(businessPuts(await f.calls())).toHaveLength(1)
  })

  it('does not interpret an authorization failure as a missing manifest', async () => {
    const f = await fixture()
    await writeFile(f.statePath, JSON.stringify({ ...await f.readState(), readFailure: 'AccessDenied' }))
    await expect(uploadDesktopOssRelease(f.plan, f.oss, f.records)).rejects.toThrow('stopped at version-preflight')
    expect(businessPuts(await f.calls())).toHaveLength(0)
  })

  it('keeps a first publication protected against a competing manifest creation', async () => {
    const f = await fixture()
    await uploadDesktopOssRelease(f.plan, f.oss, f.records)
    const puts = businessPuts(await f.calls())
    expect(puts).toHaveLength(2)
    expect(puts.every(command => command.args.includes('--forbid-overwrite=true'))).toBe(true)
  })

  it('holds an atomic target lock across simultaneous runs so a lower release cannot overwrite a newer feed', async () => {
    const f = await fixture({ previousVersion: '1.2.2' })
    const readPublic = globalThis.fetch
    const reachedReadback = Promise.withResolvers<undefined>()
    const allowReadback = Promise.withResolvers<undefined>()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/package-1.2.4.exe')) {
        reachedReadback.resolve(undefined)
        await allowReadback.promise
      }
      return readPublic(url)
    }))
    const higher = uploadDesktopOssRelease(f.plan, f.oss, f.records)
    await reachedReadback.promise
    await expect(uploadDesktopOssRelease({ ...f.plan, version: '1.2.3' }, f.oss, f.records)).rejects.toThrow('stopped at acquire-lock')
    allowReadback.resolve(undefined)
    await higher
    const state = await f.readState()
    expect(Buffer.from(state.objects[f.feedKey]!.bytes, 'base64').toString()).toBe(f.newFeed)
    expect(state.objects['yunshu-harnes/locks/win-x64.json']).toBeUndefined()
    expect(businessPuts(await f.calls()).filter(command => command.args.includes(f.feedKey))).toHaveLength(1)
  })

  it('never deletes a publication lock whose nonce no longer belongs to the current run', async () => {
    const f = await fixture()
    const readPublic = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const response = await readPublic(url)
      if (url.endsWith('/nightly.yml')) {
        const state = await f.readState()
        state.objects['yunshu-harnes/locks/win-x64.json'] = { bytes: Buffer.from('{"nonce":"another-run"}').toString('base64') }
        await writeFile(f.statePath, JSON.stringify(state))
      }
      return response
    }))
    await expect(uploadDesktopOssRelease(f.plan, f.oss, f.records)).rejects.toThrow('stopped at release-lock')
    expect((await f.calls()).some(command => command.args[1] === 'delete-object')).toBe(false)
    expect((await f.readState()).objects['yunshu-harnes/locks/win-x64.json']).toBeDefined()
  })

  it('rejects a plan escaping the namespace and refuses accidental use of the COS uploader', async () => {
    const f = await fixture()
    await expect(uploadDesktopOssRelease({ ...f.plan, artifacts: [{ ...f.plan.artifacts[0]!, key: 'desktop/latest.exe' }] }, f.oss, f.records))
      .rejects.toThrow('namespace')
    await expect(uploadDesktopRelease(f.plan, createDesktopCos({ secretId: 'fixture-id', secretKey: 'fixture-secret' }), f.records))
      .rejects.toThrow('OSS publisher')
  })
})

describe('OSS public byte verification', () => {
  const bytes = 'exact package bytes'
  const expected = { size: Buffer.byteLength(bytes), sha512: createHash('sha512').update(bytes).digest('base64') }

  it('checks the full response and asks for uncached identity bytes without redirects', async () => {
    const request = vi.fn(async () => new Response(bytes))
    vi.stubGlobal('fetch', request)
    await verifyDesktopOssPublicObject('https://public.invalid/package.exe', expected)
    expect(request).toHaveBeenCalledWith('https://public.invalid/package.exe', expect.objectContaining({
      redirect: 'error', cache: 'no-store', headers: { 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' },
    }))
  })

  it.each(['short', 'long', 'digest', 'cache', 'status'])('rejects invalid public %s', async (failure) => {
    const body = failure === 'short' ? bytes.slice(1) : failure === 'long' ? `${bytes}!` : failure === 'digest' ? 'x'.repeat(bytes.length) : bytes
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: failure === 'status' ? 404 : 200 })))
    await expect(verifyDesktopOssPublicObject('https://public.invalid/package.exe', {
      ...expected, noStore: failure === 'cache',
    })).rejects.toThrow('desktop upload: public OSS')
  })
})
