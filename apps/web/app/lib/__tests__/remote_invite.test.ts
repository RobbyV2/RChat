import { describe, expect, test } from 'bun:test'
import { FAIL_TTL, bounded, previewRequested, requestPreview } from '../remote_invite'

describe('remote invite cache', () => {
  test('failures are cached too, so a non-RChat host is not refetched on every mount', async () => {
    let clock = 1_000_000
    const now = () => clock
    const cache = new Map()
    let calls = 0
    const load = () => {
      calls++
      return Promise.reject(new Error('not rchat'))
    }
    await bounded(cache, 'https://discord.com', 300_000, load, now).catch(() => null)
    await bounded(cache, 'https://discord.com', 300_000, load, now).catch(() => null)
    expect(calls).toBe(1)
    clock += FAIL_TTL - 1
    await bounded(cache, 'https://discord.com', 300_000, load, now).catch(() => null)
    expect(calls).toBe(1)
    clock += 2
    await bounded(cache, 'https://discord.com', 300_000, load, now).catch(() => null)
    expect(calls).toBe(2)
  })

  test('successes live for the full ttl and a zero ttl forces a refetch', async () => {
    let clock = 0
    const now = () => clock
    const cache = new Map()
    let calls = 0
    const load = () => Promise.resolve(++calls)
    expect(await bounded(cache, 'k', 1000, load, now)).toBe(1)
    clock = 999
    expect(await bounded(cache, 'k', 1000, load, now)).toBe(1)
    expect(await bounded(cache, 'k', 0, load, now)).toBe(2)
  })

  test('a requested preview stays requested', () => {
    expect(previewRequested('https://b.example\nclub')).toBe(false)
    requestPreview('https://b.example\nclub')
    expect(previewRequested('https://b.example\nclub')).toBe(true)
  })
})
