import { expect, it } from 'vitest'
import { resolveDesktopPolicyEnvironment } from '../scripts/desktop-policy-environment.mjs'
import { validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { resolveDesktopPolicyConfig } from '../src/mandatory-update-policy.ts'

const origins = { DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://test.example.com',
  DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://prod.example.com' }
const auth = { DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }) }

it.each(['test', 'production'] as const)('selects the %s policy and authentication together', (deployment) => {
  const policy = resolveDesktopPolicyEnvironment({ ...origins, ...(deployment === 'test' ? auth : {}), DSH_DESKTOP_AUTO_UPDATE_ENV: deployment })
  const origin = deployment === 'test' ? origins.DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN : origins.DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN
  expect(policy).toBeDefined()
  if (policy === undefined) throw new Error('Configured COS mandatory-update policy was omitted')
  expect(policy).toEqual({ origin, allowedPageOrigins: [origin],
    ...(deployment === 'test' ? { allowedAuthOrigins: ['https://login.example.com'] } : {}),
    authentication: deployment === 'test' ? 'feishu-test' : 'anonymous' })
  expect(resolveDesktopPolicyConfig(policy)).toMatchObject(policy)
})

it('requires only the selected origin, defaults to test, and accepts explicit page restrictions', () => {
  const policy = resolveDesktopPolicyEnvironment({
    DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: origins.DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN,
    DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'],
      allowedPageOrigins: ['https://download.example.com'], intervalMs: 5000 }) })
  expect(policy).toMatchObject({ authentication: 'feishu-test', intervalMs: 5000, allowedPageOrigins: ['https://download.example.com'] })
  expect(() => resolveDesktopPolicyEnvironment({ ...origins, DSH_DESKTOP_AUTO_UPDATE_ENV: 'prod' })).toThrow('production')
})

it.each([undefined, '', 'http://test.example.com', 'https://user:secret@test.example.com',
  'https://test.example.com/api', 'https://test.example.com/?secret=value'])('rejects invalid selected origin %s', (origin) => {
  expect(() => resolveDesktopPolicyEnvironment({ ...auth, DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: origin })).toThrow('HTTPS origin')
  expect(() => resolveDesktopPolicyEnvironment({ ...auth, DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: origin })).not.toThrow('secret=value')
})

it.each(['{', 'null', '[]', '{"origin":"https://old.example.com"}', '{"authentication":"anonymous"}',
  '{"allowedPageOrigins":[]}', '{"allowedPageOrigins":["http://example.com"]}'])('rejects invalid or conflicting shared options %s', (options) => {
  expect(() => resolveDesktopPolicyEnvironment({ ...origins, DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: options })).toThrow()
})

it.each([undefined, '[]', '["http://login.example.com"]', '["https://login.example.com/path"]',
  '["https://user:secret@login.example.com"]'])('rejects missing or invalid test login origins %s', (value) => {
  const settings = value === undefined ? {} : { allowedAuthOrigins: JSON.parse(value) as unknown }
  expect(() => resolveDesktopPolicyEnvironment({ ...origins, DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify(settings) })).toThrow()
})

it('rejects login origins in production', () => {
  expect(() => resolveDesktopPolicyEnvironment({ ...origins, ...auth, DSH_DESKTOP_AUTO_UPDATE_ENV: 'production' }))
    .toThrow('must not configure allowedAuthOrigins')
})

it('omits only an explicitly disabled OSS mandatory service', () => {
  expect(resolveDesktopPolicyEnvironment({ DSH_DESKTOP_UPLOAD_PROVIDER: 'oss', DSH_DESKTOP_MANDATORY_UPDATE_ENABLED: 'false' }))
    .toBeUndefined()
  expect(() => resolveDesktopPolicyEnvironment({ DSH_DESKTOP_UPLOAD_PROVIDER: 'oss' }))
    .toThrow('DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN')
  expect(() => resolveDesktopPolicyEnvironment({ DSH_DESKTOP_UPLOAD_PROVIDER: 'oss', DSH_DESKTOP_MANDATORY_UPDATE_ENABLED: 'true' }))
    .toThrow('DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN')
  expect(() => resolveDesktopPolicyEnvironment({ DSH_DESKTOP_UPLOAD_PROVIDER: 'cos', DSH_DESKTOP_MANDATORY_UPDATE_ENABLED: 'false' }))
    .toThrow('UPLOAD_PROVIDER=oss')
  expect(() => resolveDesktopPolicyEnvironment({ DSH_DESKTOP_MANDATORY_UPDATE_ENABLED: 'false' }))
    .toThrow('UPLOAD_PROVIDER=oss')
})

it.each(['', '0', 'no', 'disabled'])('rejects an invalid mandatory-update enable flag %j', (enabled) => {
  expect(() => resolveDesktopPolicyEnvironment({ DSH_DESKTOP_UPLOAD_PROVIDER: 'oss', DSH_DESKTOP_MANDATORY_UPDATE_ENABLED: enabled }))
    .toThrow('must be true or false')
})

it.each([{ unsigned: true }, { prepareOnly: true }, {}])('requires policy for signed COS preparation and releases in %j', (options) => {
  for (const platform of ['win32', 'darwin'] as const) {
    if (options.unsigned) {
      expect(() => { validateDesktopPackageEnvironment({ DSH_DESKTOP_APP_ID: 'com.example.test' }, { platform, arch: 'x64' }, options) })
        .not.toThrow()
      continue
    }
    expect(() => { validateDesktopPackageEnvironment({ DSH_DESKTOP_APP_ID: 'com.example.test' }, { platform, arch: 'x64' }, options) })
      .toThrow('DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN')
  }
})
