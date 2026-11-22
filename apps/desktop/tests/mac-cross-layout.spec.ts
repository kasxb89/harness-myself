import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { list } from 'tar'
import { macCrossExecutable, writeMacCrossResources, writeMacCrossZip } from '../scripts/mac-cross-layout.ts'

describe('macOS cross-build executable permissions', () => {
  it('retains thin and universal Mach-O binaries and command launchers', () => {
    for (const magic of [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]) {
      const bytes = Buffer.alloc(32)
      bytes.writeUInt32BE(magic)
      expect(macCrossExecutable(bytes)).toBe(true)
    }
    expect(macCrossExecutable(Buffer.from('#!/bin/sh\nexit 0\n'))).toBe(true)
  })

  it('keeps documents, configuration and Windows executables as data', () => {
    for (const value of ['{}', 'MZ this is a PE file', '%PDF sample', '\0asm', 'export const x=1']) {
      expect(macCrossExecutable(Buffer.from(value))).toBe(false)
    }
    expect(macCrossExecutable(Buffer.alloc(0))).toBe(false)
  })

  it('writes executable permissions into both archive formats independently of host mode bits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mac-cross-layout-'))
    try {
      const app = join(root, '云枢.app')
      mkdirSync(app)
      writeFileSync(join(app, 'launch'), '#!/bin/sh\nexit 0\n', { mode: 0o644 })
      writeFileSync(join(app, 'config.json'), '{}', { mode: 0o755 })
      const tar = join(root, 'resources.tar')
      await writeMacCrossResources(app, tar)
      const modes: Record<string, number> = {}
      await list({ file: tar, onReadEntry: (entry) => { modes[entry.path.replace(/^\.\//u, '')] = entry.mode! & 0o777 } })
      expect(modes.launch).toBe(0o755)
      expect(modes['config.json']).toBe(0o644)
      const zip = join(root, 'app.zip')
      await writeMacCrossZip(app, zip)
      const bytes = readFileSync(zip)
      const central: Record<string, number> = {}
      for (let offset = 0; offset + 46 < bytes.length; offset++) {
        if (bytes.readUInt32LE(offset) !== 0x02014b50) continue
        const nameLength = bytes.readUInt16LE(offset + 28)
        const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString()
        central[name] = bytes.readUInt32LE(offset + 38) >>> 16
        offset += 45 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32)
      }
      expect(central['云枢.app/launch']).toBe(0o100755)
      expect(central['云枢.app/config.json']).toBe(0o100644)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('refuses framework links that escape the application', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mac-cross-link-'))
    try {
      const app = join(root, 'App.app')
      mkdirSync(app)
      writeFileSync(join(root, 'outside'), 'private')
      symlinkSync('../outside', join(app, 'escape'))
      await expect(writeMacCrossZip(app, join(root, 'bad.zip'))).rejects.toThrow('escaping link')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
