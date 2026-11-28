import { describe, expect, test } from 'bun:test'
import { ApiClient } from '../api'
import { readJson, writeJson } from '../api/masks'
import { stableKey } from '../stable_key'

describe('permission masks at the API boundary', () => {
  test('a body read from the API holds its masks as bigints, at any depth', () => {
    const body = readJson(
      '{"perms":34359738368,"my_perms":4,"everyone_perms":0,"roles":[{"id":7,"perms":1073741824}],' +
        '"rule":{"allow":536870912,"deny":2,"subject":"r:7"},"count":3,"position":2}'
    )
    expect(body).toEqual({
      perms: 34359738368n,
      my_perms: 4n,
      everyone_perms: 0n,
      roles: [{ id: 7, perms: 1073741824n }],
      rule: { allow: 536870912n, deny: 2n, subject: 'r:7' },
      count: 3,
      position: 2,
    })
  })

  test('a mask field that is not a whole number stays as sent', () => {
    expect(readJson('{"perms":"all","allow":null,"deny":1.5}')).toEqual({
      perms: 'all',
      allow: null,
      deny: 1.5,
    })
  })

  test('a written body carries masks as numbers', () => {
    expect(writeJson({ perms: 34359738368n, mask: 36238783487n, rule: { allow: 2n } })).toBe(
      '{"perms":34359738368,"mask":36238783487,"rule":{"allow":2}}'
    )
  })

  test('the client reads and writes through them', async () => {
    const sent: string[] = []
    const client = new ApiClient('https://chat.example/api/v1')
    const fetching = globalThis.fetch
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(String(init?.body))
      return new Response('{"everyone_perms":34359738372}', {
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const answer = await client.req<{ everyone_perms: bigint }>('PATCH', '/servers/a/everyone', {
        perms: 34359738372n,
      })
      expect(answer.everyone_perms).toBe(34359738372n)
      expect(sent).toEqual(['{"perms":34359738372}'])
    } finally {
      globalThis.fetch = fetching
    }
  })

  test('a memo key tells masks apart', () => {
    expect(stableKey({ allow: 4n })).toBe('{"allow":"4n"}')
    expect(stableKey([1n])).not.toBe(stableKey([2n]))
  })
})
