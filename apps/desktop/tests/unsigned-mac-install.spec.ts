import { createHash } from 'node:crypto'
import { execFile, fork } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { acknowledgeUnsignedMacInstall, prepareUnsignedMacInstall } from '../src/unsigned-mac-install.ts'
import type { UnsignedMacInstallRequest } from '../src/unsigned-mac-install.ts'
import { buildUnsignedMacSwap } from '../scripts/build-unsigned-mac-swap.mjs'
import { unsignedMacInstallHelper } from '../src/unsigned-mac-install-helper.ts'

const execute = promisify(execFile)
const suite = process.platform === 'darwin' ? describe : describe.skip

async function app(directory: string, version: string, identifier: string, marker: string): Promise<string> {
  const target = join(directory, 'Yunshu Update Fixture.app')
  await mkdir(join(target, 'Contents/MacOS'), { recursive: true })
  const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleName</key><string>Yunshu Update Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string></dict></plist>`
  await writeFile(join(target, 'Contents/Info.plist'), plist)
  const source = join(directory, `${version}.c`)
  await writeFile(source, `#include <stdio.h>\n#include <unistd.h>\nint main(int argc,char **argv) { FILE *f=fopen(${JSON.stringify(marker)},"w"); if(!f)return 2; fprintf(f,"${version}"); fclose(f); if(argc>1)sleep(60); return 0; }\n`)
  await execute('/usr/bin/clang', [source, '-o', join(target, 'Contents/MacOS/fixture')], { timeout: 30_000 })
  await buildUnsignedMacSwap(join(target, 'Contents/Resources'), process.arch)
  await execute('/usr/bin/codesign', ['--force', '--sign', '-', target], { timeout: 30_000 })
  return target
}

async function fixture(): Promise<{ directory: string; target: string; marker: string; request: UnsignedMacInstallRequest }> {
  const directory = await mkdtemp(join(tmpdir(), 'yunshu-unsigned-mac-'))
  const marker = join(directory, 'launched.txt')
  const identifier = `com.yunshu.updater.fixture.${Date.now()}`
  const target = await app(join(directory, 'installed'), '1.0.0', identifier, marker)
  const incoming = join(directory, 'incoming')
  await app(incoming, '1.0.1', identifier, marker)
  const dmgPath = join(directory, 'release.dmg')
  await execute('/usr/bin/hdiutil', ['create', '-quiet', '-format', 'UDZO', '-srcfolder', incoming, '-volname', 'YunshuUpdateFixture', dmgPath], { timeout: 60_000 })
  const sha512 = createHash('sha512').update(await readFile(dmgPath)).digest('base64')
  return { directory, marker, target, request: { dmgPath, sha512, version: '1.0.1', currentVersion: '1.0.0',
    executablePath: join(target, 'Contents/MacOS/fixture'), architecture: process.arch, stateDirectory: join(directory, 'state') } }
}

async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000
  while (true) {
    const value = await read()
    if (accepts(value)) return value
    if (Date.now() > deadline) throw new Error('fixture did not reach its observed filesystem state')
    await delay(50)
  }
}

suite('unsigned Mac automatic installation on real macOS files and Launch Services', () => {
  it('builds Intel and native swap helpers and exchanges only the expected same-volume directories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yunshu-native-swap-'))
    try {
      const native = await buildUnsignedMacSwap(join(directory, 'native'), process.arch)
      const intel = await buildUnsignedMacSwap(join(directory, 'intel'), 'x64')
      expect((await execute('/usr/bin/lipo', ['-archs', intel])).stdout.trim()).toBe('x86_64')
      const left = join(directory, 'left.app')
      const right = join(directory, 'right.app')
      await mkdir(left)
      await mkdir(right)
      await writeFile(join(left, 'version'), 'old')
      await writeFile(join(right, 'version'), 'new')
      const leftId = (await execute('/usr/bin/stat', ['-f', '%d:%i', left])).stdout.trim()
      const rightId = (await execute('/usr/bin/stat', ['-f', '%d:%i', right])).stdout.trim()
      await expect(execute(native, [left, right, '0:0', rightId])).rejects.toThrow()
      expect(await readFile(join(left, 'version'), 'utf8')).toBe('old')
      await execute(native, [left, right, leftId, rightId])
      expect(await readFile(join(left, 'version'), 'utf8')).toBe('new')
      expect(await readFile(join(right, 'version'), 'utf8')).toBe('old')
      await execute(native, [left, right, rightId, leftId])
      expect(await readFile(join(left, 'version'), 'utf8')).toBe('old')
      expect(await readFile(join(right, 'version'), 'utf8')).toBe('new')
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 30_000)

  it('waits for the exact old process, promotes an intact ad-hoc app, launches it and preserves the old app and user data', async () => {
    const f = await fixture()
    let owner: ReturnType<typeof fork> | undefined
    try {
      const data = join(f.directory, 'account-data.txt')
      await writeFile(data, 'preserved-account')
      const requestPath = join(f.directory, 'request.json')
      await writeFile(requestPath, JSON.stringify(f.request))
      owner = fork(new URL('./fixtures/unsigned-mac-install.mjs', import.meta.url), [requestPath],
        { execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      let diagnostics = ''
      owner.stderr?.on('data', (chunk) => { diagnostics += String(chunk) })
      const message = await Promise.race([once(owner, 'message'), once(owner, 'exit').then(([code]) => { throw new Error(`fixture owner exited ${code}: ${diagnostics}`) })])
      expect(message).toEqual([{ kind: 'ready' }, undefined])
      expect(await readFile(join(f.target, 'Contents/Info.plist'), 'utf8')).toContain('<string>1.0.0</string>')
      const exit = once(owner, 'exit')
      owner.send('quit')
      expect(await exit).toEqual([0, null])
      const marker = await until(() => readFile(f.marker, 'utf8').catch(() => ''), value => value === '1.0.1')
      expect(marker).toBe('1.0.1')
      await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', f.target])
      const receipt = await acknowledgeUnsignedMacInstall({ stateDirectory: f.request.stateDirectory,
        executablePath: f.request.executablePath, version: '1.0.1' })
      expect(receipt?.status).toBe('succeeded')
      expect(receipt?.previousVersion).toBe('1.0.0')
      expect(receipt).toBeDefined()
      if (receipt === undefined) throw new Error('missing receipt')
      expect(await readFile(join(receipt.backupPath, 'Contents/Info.plist'), 'utf8')).toContain('<string>1.0.0</string>')
      expect(await readFile(data, 'utf8')).toBe('preserved-account')
      await until(() => readFile(join(dirname(receipt.logPath), 'status'), 'utf8'), value => value.trim() === 'succeeded')
      expect(await readFile(receipt.logPath, 'utf8')).toContain('launching')
    } finally {
      if (owner !== undefined && owner.exitCode === null) { owner.kill(); await once(owner, 'exit') }
      await rm(f.directory, { recursive: true, force: true })
    }
  }, 120_000)

  it('rejects a changed checksum and a wrong bundle identity before changing the installed app', async () => {
    const f = await fixture()
    try {
      await expect(prepareUnsignedMacInstall({ ...f.request, sha512: createHash('sha512').update('wrong').digest('base64') })).rejects.toThrow('installer changed')
      const plist = join(f.target, 'Contents/Info.plist')
      await execute('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier com.yunshu.updater.wrong', plist])
      await expect(prepareUnsignedMacInstall(f.request)).rejects.toThrow('identity or version differs')
      expect(await readFile(plist, 'utf8')).toContain('1.0.0')
      expect((await readdir(dirname(f.target))).filter(name => name.startsWith('.Yunshu'))).toEqual([])
      expect(await acknowledgeUnsignedMacInstall({ stateDirectory: f.request.stateDirectory, executablePath: f.request.executablePath, version: '1.0.0' })).toBeUndefined()
    } finally { await rm(f.directory, { recursive: true, force: true }) }
  }, 120_000)

  it('refuses downgrade and altered staging, and disposal removes only unlaunched files', async () => {
    const f = await fixture()
    try {
      await expect(prepareUnsignedMacInstall({ ...f.request, version: '1.0.0' })).rejects.toThrow('must be newer')
      const prepared = await prepareUnsignedMacInstall(f.request)
      const operationId = (await readdir(f.request.stateDirectory)).find(name => name.startsWith('install-'))
      if (operationId === undefined) throw new Error('missing prepared operation')
      await writeFile(join(f.request.stateDirectory, 'pending.json'), JSON.stringify({ operationId }))
      await writeFile(join(f.request.stateDirectory, operationId, 'status'), 'launch-unconfirmed\n')
      await expect(prepareUnsignedMacInstall(f.request)).rejects.toThrow('unresolved outcome')
      await rm(join(f.request.stateDirectory, 'pending.json'))
      await writeFile(join(f.request.stateDirectory, operationId, 'status'), 'prepared\n')
      const staging = (await readdir(dirname(f.target))).find(name => name.startsWith('.Yunshu'))
      if (staging === undefined) throw new Error('missing same-volume stage')
      await writeFile(join(dirname(f.target), staging, 'previous.app/Contents/MacOS/fixture'), 'tampered')
      await expect(prepared.launch()).rejects.toThrow()
      await prepared.dispose()
      expect(await readFile(join(f.target, 'Contents/Info.plist'), 'utf8')).toContain('1.0.0')
      expect((await readdir(dirname(f.target))).filter(name => name.startsWith('.Yunshu'))).toEqual([])
    } finally { await rm(f.directory, { recursive: true, force: true }) }
  }, 120_000)

  it('refuses to replace the app while a different process still runs its exact executable', async () => {
    const f = await fixture()
    let owner: ReturnType<typeof fork> | undefined
    const other = execFile(f.request.executablePath, ['--hold'])
    try {
      await until(() => readFile(f.marker, 'utf8').catch(() => ''), value => value === '1.0.0')
      const requestPath = join(f.directory, 'request.json')
      await writeFile(requestPath, JSON.stringify(f.request))
      owner = fork(new URL('./fixtures/unsigned-mac-install.mjs', import.meta.url), [requestPath],
        { execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      await once(owner, 'message')
      const exited = once(owner, 'exit')
      owner.send('quit')
      expect(await exited).toEqual([0, null])
      const operationId = (JSON.parse(await readFile(join(f.request.stateDirectory, 'pending.json'), 'utf8')) as { operationId: string }).operationId
      await until(() => readFile(join(f.request.stateDirectory, operationId, 'status'), 'utf8'), value => value.trim() === 'target-in-use')
      expect(await readFile(join(f.target, 'Contents/Info.plist'), 'utf8')).toContain('1.0.0')
      expect(other.exitCode).toBeNull()
    } finally {
      if (owner !== undefined && owner.exitCode === null) { owner.kill(); await once(owner, 'exit') }
      if (other.exitCode === null) { other.kill(); await once(other, 'exit') }
      await rm(f.directory, { recursive: true, force: true })
    }
  }, 120_000)

  it('cancels and awaits an owned unlaunched helper before releasing its lock or staging files', async () => {
    const f = await fixture()
    try {
      const prepared = await prepareUnsignedMacInstall(f.request)
      const operationId = (await readdir(f.request.stateDirectory)).find(name => name.startsWith('install-'))
      if (operationId === undefined) throw new Error('missing prepared operation')
      const operation = join(f.request.stateDirectory, operationId)
      const marker = join(operation, 'barrier')
      const staged = (await readdir(dirname(f.target))).find(name => name.startsWith('.Yunshu'))
      if (staged === undefined) throw new Error('missing staged application')
      await writeFile(join(operation, 'install.sh'), '#!/bin/sh\nset -eu\nprintf started > "$8/barrier"\nwhile [ ! -f "$8/cancelled" ]; do /bin/sleep 0.02; done\nprintf cancelling > "$8/barrier"\nwhile [ ! -f "$8/allow-exit" ]; do /bin/sleep 0.02; done\nprintf exited > "$8/barrier"\n')
      const launch = prepared.launch().then(() => undefined, (error: unknown) => error)
      await until(() => readFile(marker, 'utf8').catch(() => ''), value => value === 'started')
      const disposal = prepared.dispose()
      await until(() => readFile(marker, 'utf8'), value => value === 'cancelling')
      await access(join(f.request.stateDirectory, 'handoff.lock'))
      await access(join(dirname(f.target), staged))
      await writeFile(join(operation, 'allow-exit'), 'exit')
      await disposal
      expect(await launch).toBeInstanceOf(Error)
      expect(await readFile(marker, 'utf8')).toBe('exited')
      await expect(access(join(f.request.stateDirectory, 'handoff.lock'))).rejects.toThrow()
      await expect(access(join(dirname(f.target), staged))).rejects.toThrow()
      expect(await readFile(join(f.target, 'Contents/Info.plist'), 'utf8')).toContain('1.0.0')
    } finally { await rm(f.directory, { recursive: true, force: true }) }
  }, 120_000)

  it('retains both intact apps if interrupted immediately after atomic exchange and recovers on the new app startup', async () => {
    const f = await fixture()
    let owner: ReturnType<typeof fork> | undefined
    let helperPid: number | undefined
    try {
      const helperSource = unsignedMacInstallHelper.replace('status launching\nif ! /usr/bin/open',
        () => 'printf "%s" "$$" > "$operation/interruption-ready"\nwhile [ ! -f "$operation/allow-launch" ]; do /bin/sleep 0.02; done\nstatus launching\nif ! /usr/bin/open')
      expect(helperSource).not.toBe(unsignedMacInstallHelper)
      const requestPath = join(f.directory, 'request.json')
      await writeFile(requestPath, JSON.stringify({ ...f.request, helperSource }))
      owner = fork(new URL('./fixtures/unsigned-mac-install.mjs', import.meta.url), [requestPath],
        { execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      await once(owner, 'message')
      const exited = once(owner, 'exit')
      owner.send('quit')
      expect(await exited).toEqual([0, null])
      const operationId = (JSON.parse(await readFile(join(f.request.stateDirectory, 'pending.json'), 'utf8')) as { operationId: string }).operationId
      const operation = join(f.request.stateDirectory, operationId)
      helperPid = Number(await until(() => readFile(join(operation, 'interruption-ready'), 'utf8').catch(() => ''), value => /^[0-9]+$/u.test(value)))
      process.kill(helperPid, 'SIGTERM')
      await until(async () => {
        try { process.kill(helperPid ?? 0, 0); return false }
        catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true; throw error }
      }, value => value)
      helperPid = undefined
      expect((await readFile(join(operation, 'status'), 'utf8')).trim()).toBe('replacing')
      const record = JSON.parse(await readFile(join(operation, 'record.json'), 'utf8')) as { stageDirectory: string }
      const backup = join(record.stageDirectory, 'previous.app')
      expect(await readFile(join(f.target, 'Contents/Info.plist'), 'utf8')).toContain('1.0.1')
      expect(await readFile(join(backup, 'Contents/Info.plist'), 'utf8')).toContain('1.0.0')
      await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', f.target])
      await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', backup])
      await execute('/usr/bin/open', ['-n', f.target])
      await until(() => readFile(f.marker, 'utf8').catch(() => ''), value => value === '1.0.1')
      expect((await acknowledgeUnsignedMacInstall({ stateDirectory: f.request.stateDirectory,
        executablePath: f.request.executablePath, version: '1.0.1' }))?.status).toBe('succeeded')
      expect((await readFile(join(operation, 'status'), 'utf8')).trim()).toBe('succeeded')
    } finally {
      if (owner !== undefined && owner.exitCode === null) { owner.kill(); await once(owner, 'exit') }
      if (helperPid !== undefined) process.kill(helperPid, 'SIGTERM')
      await rm(f.directory, { recursive: true, force: true })
    }
  }, 120_000)

  it('rolls back an actual exchanged app when new-app launch fails and restarts the old app without changing user data', async () => {
    const f = await fixture()
    let owner: ReturnType<typeof fork> | undefined
    let helperPid: number | undefined
    try {
      const data = join(f.directory, 'account-data.txt')
      await writeFile(data, 'preserved-account')
      const helperSource = unsignedMacInstallHelper
        .replace('if ! /usr/bin/open -n "$target"; then', 'if ! /usr/bin/false; then')
        .replace('status ready\ncount=0', () => 'printf "%s" "$$" > "$operation/helper.pid"\nstatus ready\ncount=0')
      expect(helperSource).toContain('if ! /usr/bin/false; then')
      const requestPath = join(f.directory, 'request.json')
      await writeFile(requestPath, JSON.stringify({ ...f.request, helperSource }))
      owner = fork(new URL('./fixtures/unsigned-mac-install.mjs', import.meta.url), [requestPath],
        { execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      const output = { stderr: '' }
      owner.stderr?.on('data', (chunk) => { output.stderr += String(chunk) })
      await Promise.race([once(owner, 'message'), once(owner, 'exit').then(([code]) => {
        throw new Error(`fixture owner exited ${code}: ${output.stderr}`)
      })])
      const operationId = (JSON.parse(await readFile(join(f.request.stateDirectory, 'pending.json'), 'utf8')) as { operationId: string }).operationId
      const operation = join(f.request.stateDirectory, operationId)
      helperPid = Number(await readFile(join(operation, 'helper.pid'), 'utf8'))
      const exited = once(owner, 'exit')
      owner.send('quit')
      expect(await exited).toEqual([0, null])
      await until(() => readFile(join(operation, 'status'), 'utf8'), value => value.trim() === 'rolled-back')
      await until(() => readFile(f.marker, 'utf8').catch(() => ''), value => value === '1.0.0')
      await until(async () => {
        try { process.kill(helperPid ?? 0, 0); return false }
        catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true; throw error }
      }, value => value)
      helperPid = undefined
      const receipt = await acknowledgeUnsignedMacInstall({ stateDirectory: f.request.stateDirectory,
        executablePath: f.request.executablePath, version: '1.0.0' })
      expect(receipt?.status).toBe('rolled-back')
      if (receipt === undefined) throw new Error('missing rollback receipt')
      expect(await readFile(join(f.target, 'Contents/Info.plist'), 'utf8')).toContain('1.0.0')
      expect(await readFile(join(receipt.backupPath, 'Contents/Info.plist'), 'utf8')).toContain('1.0.1')
      expect(await readFile(data, 'utf8')).toBe('preserved-account')
      await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', f.target])
      await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', receipt.backupPath])
      expect(await readFile(receipt.logPath, 'utf8')).toContain('rolled-back')
    } finally {
      if (owner !== undefined && owner.exitCode === null) { owner.kill(); await once(owner, 'exit') }
      if (helperPid !== undefined) {
        process.kill(helperPid, 'SIGTERM')
        await until(async () => {
          try { process.kill(helperPid ?? 0, 0); return false }
          catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true; throw error }
        }, value => value)
      }
      await rm(f.directory, { recursive: true, force: true })
    }
  }, 120_000)
})
