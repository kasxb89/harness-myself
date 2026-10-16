/** API roots retain reverse-proxy prefixes and cannot address the adjacent production instance. */
import { describe, expect, it } from 'vitest'
import { apiUrl, normalizeApiBaseUrl } from '../src/api-url.ts'

describe('API root validation', () => {
  it.each([
    ['https://8.133.202.230/harness', 'https://8.133.202.230/harness'],
    ['https://8.133.202.230/harness/', 'https://8.133.202.230/harness'],
    ['http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
    ['http://localhost:3000/harness', 'http://localhost:3000/harness'],
    ['http://[::1]:3000/', 'http://[::1]:3000'],
    ['https://relay.example/gateway/harness/', 'https://relay.example/gateway/harness'],
  ])('normalizes %s while retaining its API path', (input, expected) => {
    expect(normalizeApiBaseUrl(input)).toBe(expected)
  })

  it.each([
    'https://8.133.202.230', 'https://8.133.202.230/api', 'https://8.133.202.230/v1',
    'http://8.133.202.230/harness', 'https://8.133.202.230:3010/harness',
    'https://8.133.202.230/harness/v1', 'https://8.133.202.230/harness/../harness',
    'https://8.133.202.230/harness/%2e%2e/harness', 'https://8.133.202.230/%68arness',
    'https://user:secret@8.133.202.230/harness', 'https://8.133.202.230/harness?key=secret',
    'https://@8.133.202.230/harness', 'https://8.133.202.230/harness?', 'https://8.133.202.230/harness#',
    'https://8.133.202.230/harness#fragment', 'https://relay.example/a/../b',
    'https://relay.example/%2froot', 'https://relay.example/%252e%252e', 'https://relay.example/%zz',
    'http://relay.example', 'ftp://relay.example', ' https://relay.example', 'https://relay.example\n',
    'https://relay.example\\root',
    'https:/relay.example', 'https:///relay.example',
  ])('rejects an unsafe root %s', (input) => {
    expect(() => normalizeApiBaseUrl(input)).toThrow()
  })
})

describe('API path composition', () => {
  it('keeps management, inference, and query routes below /harness', () => {
    const base = 'https://8.133.202.230/harness/'
    for (const path of ['/api/status', '/api/user/self', '/api/user/phone/login', '/v1/models', '/v1/chat/completions']) {
      expect(apiUrl(base, path)).toBe('https://8.133.202.230/harness' + path)
    }
    expect(apiUrl(base, '/api/log/self?type=2&p=1&page_size=100')).toBe(
      'https://8.133.202.230/harness/api/log/self?type=2&p=1&page_size=100',
    )
    expect(apiUrl('http://127.0.0.1:3000/harness', '/v1/videos/task%3Afirst')).toBe(
      'http://127.0.0.1:3000/harness/v1/videos/task%3Afirst',
    )
  })

  it.each([
    'https://8.133.202.230/api/status', '//8.133.202.230/api/status', 'api/status',
    '/../api/status', '/api/../../api/status', '/%2e%2e/api/status', '/api/%2E./status',
    '/%252e%252e/api/status', '/api%2fstatus', '/api\\..\\status', '/api/status#fragment', '/api/%zz',
  ])('rejects a route which can escape or obscure the API prefix: %s', (path) => {
    expect(() => apiUrl('https://8.133.202.230/harness', path)).toThrow()
  })
})
