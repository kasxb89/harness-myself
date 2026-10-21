import { describe, expect, it } from 'vitest'
import { appPath } from '../src/app-path.ts'

describe('application public paths', () => {
  it.each(['https://host.invalid/', 'https://host.invalid/index.html'])('retains root routes under %s', (base) => {
    expect(appPath('/credits/api/session', base)).toBe('/credits/api/session')
  })

  it.each(['https://host.invalid/mount/', 'https://host.invalid/mount/index.html'])('retains the mount under %s', (base) => {
    expect(appPath('/credits/api/summary?scope=a%2Fb#details', base)).toBe('/mount/credits/api/summary?scope=a%2Fb#details')
    expect(appPath('/artifacts/api/raw?path=%2Fworkspace%2Fcat.png', base)).toBe('/mount/artifacts/api/raw?path=%2Fworkspace%2Fcat.png')
    expect(appPath('/credits/api/creation/assets/cover%2Freal', base)).toBe('/mount/credits/api/creation/assets/cover%2Freal')
  })

  it.each(['https://other.invalid/credits/api/session', '/https://other.invalid/path', '//other.invalid/path', 'credits/api/session',
    '/credits/../session', '/credits/%2e%2e/session', '/credits/.%2E/session', '/credits/%2F../session',
    '/credits\\session', '/credits/%5c/session', '/credits/%', '/credits/api/session\n'])('rejects an external or noncanonical path: %s', (path) => {
    expect(() => appPath(path, 'https://host.invalid/mount/')).toThrow(TypeError)
  })
})
