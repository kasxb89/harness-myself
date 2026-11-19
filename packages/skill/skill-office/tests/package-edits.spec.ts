/** Real bundled-library package edits and deterministic parse/serialization bounds. */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const runtime = process.env.DSH_OFFICE_TEST_RUNTIME
const python = process.env.DSH_OFFICE_TEST_PYTHON ?? (runtime === undefined ? undefined
  : join(runtime, 'dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'))

it.skipIf(python === undefined)('edits actual DOCX/PPTX/XLSX files with bounded XML work and isolated calculation probes', { timeout: 120_000 }, () => {
  const result = spawnSync(python!, ['-B', fileURLToPath(new URL('./package-edits_test.py', import.meta.url))], {
    encoding: 'utf8', timeout: 120_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.signal, result.stderr + result.stdout).toBeNull()
  expect(result.status, result.stderr + result.stdout).toBe(0)
})
