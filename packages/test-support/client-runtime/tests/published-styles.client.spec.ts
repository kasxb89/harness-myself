// @vitest-environment jsdom
/** Published CSS survives concurrent clients and rolls back failed startup without changing page styles. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPublishedStyleLease, type PublishedStyleLease } from '../src/assembly/published-styles.ts'

const leases: PublishedStyleLease[] = []
const nodes: Node[] = []

function lease(): PublishedStyleLease {
  const value = createPublishedStyleLease()
  leases.push(value)
  return value
}

function style(packageName?: string): HTMLStyleElement {
  const element = document.createElement('style')
  if (packageName !== undefined) element.setAttribute('data-plugin', packageName)
  document.head.append(element)
  nodes.push(element)
  return element
}

function marker(): Comment {
  const node = document.createComment('style position')
  document.head.append(node)
  nodes.push(node)
  return node
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const value of leases.splice(0)) value.release()
  for (const node of nodes.splice(0)) node.parentNode?.removeChild(node)
})

describe('published style leases', () => {
  it('removes styles from completed factories when a later startup factory fails', () => {
    const client = lease()
    const completed = client.capture('first', () => style('first'))
    const failure = new Error('later factory failed')
    let partial: HTMLStyleElement | undefined
    expect(() => client.capture('second', () => {
      partial = style('second')
      throw failure
    })).toThrow(failure)
    expect(completed.isConnected).toBe(true)
    expect(partial?.isConnected).toBe(true)
    client.release()
    expect(completed.isConnected).toBe(false)
    expect(partial?.isConnected).toBe(false)
  })

  it('keeps pre-existing tagged and untagged styles and ignores untagged insertions', () => {
    const prior = style('published')
    const untagged = style()
    const other = style('other')
    const client = lease()
    let ordinary: HTMLStyleElement | undefined
    const owned = client.capture('published', () => {
      untagged.setAttribute('data-plugin', 'published')
      ordinary = style()
      return style('published')
    })
    client.release()
    expect(owned.isConnected).toBe(false)
    for (const element of [prior, untagged, other, ordinary]) expect(element?.isConnected).toBe(true)
  })

  it.each(['creator', 'consumer'] as const)('keeps a shared style until the last release, with %s releasing first', (first) => {
    const creator = lease()
    const consumer = lease()
    const element = creator.capture('published', () => style('published'))
    const reuse = (): HTMLStyleElement => element
    expect(creator.capture('published', reuse)).toBe(element)
    expect(consumer.capture('published', reuse)).toBe(element)
    const order = first === 'creator' ? [creator, consumer] : [consumer, creator]
    order[0]!.release()
    expect(element.isConnected).toBe(true)
    order[0]!.release()
    expect(element.isConnected).toBe(true)
    order[1]!.release()
    expect(element.isConnected).toBe(false)
  })

  it.each(['creator', 'consumer'] as const)('restores shared CSS removed by plugin teardown, with %s stopping first', (first) => {
    const creator = lease()
    const consumer = lease()
    const before = marker()
    const one = creator.capture('published', () => style('published'))
    const between = marker()
    const two = consumer.capture('published', () => style('published'))
    const after = marker()
    const original = [...document.head.childNodes]
    const order = first === 'creator' ? [creator, consumer] : [consumer, creator]
    for (const element of document.querySelectorAll('style[data-plugin="published"]')) element.remove()
    order[0]!.release()
    expect(one.isConnected).toBe(true)
    if (first === 'creator') {
      expect(two.isConnected).toBe(true)
      expect([...document.head.childNodes]).toEqual(original)
    } else {
      expect(two.isConnected).toBe(false)
      expect([...document.head.childNodes]).toEqual(original.filter(node => node !== two))
    }
    expect(before.nextSibling).toBe(one)
    expect(one.nextSibling).toBe(between)
    for (const element of document.querySelectorAll('style[data-plugin="published"]')) element.remove()
    order[1]!.release()
    expect(one.isConnected).toBe(false)
    expect(two.isConnected).toBe(false)
    expect(before.nextSibling).toBe(between)
    expect(between.nextSibling).toBe(after)
  })

  it('restores a page-owned style at its original position after the last client stops', () => {
    const before = marker()
    const prior = style('published')
    const after = marker()
    const client = lease()
    const owned = client.capture('published', () => style('published'))
    prior.remove()
    owned.remove()
    client.release()
    expect(prior.parentNode).toBe(document.head)
    expect(before.nextSibling).toBe(prior)
    expect(prior.nextSibling).toBe(after)
    expect(owned.isConnected).toBe(false)
  })

  it('restores consecutive shared styles without changing their order', () => {
    const creator = lease()
    const one = creator.capture('published', () => style('published'))
    const two = creator.capture('published', () => style('published'))
    const after = marker()
    const consumer = lease()
    consumer.capture('published', () => undefined)
    one.remove()
    two.remove()
    creator.release()
    expect(one.nextSibling).toBe(two)
    expect(two.nextSibling).toBe(after)
    consumer.release()
    expect(one.isConnected).toBe(false)
    expect(two.isConnected).toBe(false)
  })

  it('restores consecutive page-owned styles within their original parent', () => {
    const parent = document.createElement('section')
    document.body.append(parent)
    nodes.push(parent)
    const one = style('published')
    const two = style('published')
    const after = document.createTextNode('unrelated page content')
    parent.append(one, two, after)
    const client = lease()
    client.capture('published', () => undefined)
    one.remove()
    two.remove()
    client.release()
    expect([...parent.childNodes]).toEqual([one, two, after])
    expect(one.isConnected).toBe(true)
    expect(two.isConnected).toBe(true)
  })

  it('restores a retained style when its neighbors were removed without restoring unrelated content', () => {
    const parent = document.createElement('section')
    document.body.append(parent)
    nodes.push(parent)
    const prior = style('published')
    const neighbor = document.createElement('span')
    parent.append(prior, neighbor)
    const client = lease()
    client.capture('published', () => undefined)
    prior.remove()
    neighbor.remove()
    client.release()
    expect([...parent.childNodes]).toEqual([prior])
    expect(neighbor.isConnected).toBe(false)
  })

  it('captures nested dependencies and cleans styles when release occurs inside a factory', () => {
    const client = lease()
    let first: HTMLStyleElement | undefined
    let last: HTMLStyleElement | undefined
    const value = client.capture('outer', () => {
      first = client.capture('dependency', () => style('dependency'))
      client.release()
      last = style('outer')
      return 42
    })
    expect(value).toBe(42)
    expect(first?.isConnected).toBe(false)
    expect(last?.isConnected).toBe(false)
    client.release()
  })

  it('rejects factories after release without running them', () => {
    const client = lease()
    client.release()
    const factory = vi.fn(() => style('published'))
    expect(() => client.capture('published', factory)).toThrow('lease is released')
    expect(factory).not.toHaveBeenCalled()
    client.release()
  })

  it('returns results and propagates failures without a document', () => {
    vi.stubGlobal('document', undefined)
    const client = lease()
    const result = { exports: 'published' }
    expect(client.capture('published', () => result)).toBe(result)
    const failure = new Error('factory failed without DOM')
    expect(() => client.capture('published', () => { throw failure })).toThrow(failure)
    client.release()
    expect(() => client.capture('published', () => result)).toThrow('lease is released')
  })
})
