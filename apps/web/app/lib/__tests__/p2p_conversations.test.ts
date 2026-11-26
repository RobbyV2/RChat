import { describe, expect, test } from 'bun:test'
import type { Contact } from '../p2p/contacts'
import { addsContacts, conversations, p2pDmSection, serversLoading } from '../p2p/conversations'

const contact = (ik: string, over: Partial<Contact> = {}) =>
  ({
    ik,
    name: ik,
    petname: null,
    state: 'mutual',
    ignored: false,
    added: 1,
    ...over,
  }) as Contact

const last =
  (times: Record<string, number>) =>
  (ik: string): number =>
    times[ik] ?? 0

describe('conversations', () => {
  test('newest conversation first, then by name', () => {
    const list = [contact('dana'), contact('ben'), contact('cleo'), contact('ada')]
    const order = conversations(list, last({ cleo: 30, ada: 10, dana: 30 }))
    expect(order.map(c => c.ik)).toEqual(['cleo', 'dana', 'ada', 'ben'])
  })

  test('the name shown decides ties: a petname wins over the claimed name', () => {
    const list = [contact('k1', { name: 'Zed' }), contact('k2', { name: 'Amy', petname: 'Yan' })]
    expect(conversations(list, last({})).map(c => c.ik)).toEqual(['k2', 'k1'])
  })

  test('only mutual contacts that are not ignored', () => {
    const list = [
      contact('a'),
      contact('b', { state: 'incoming' }),
      contact('c', { state: 'outgoing' }),
      contact('d', { state: 'blocked' }),
      contact('e', { ignored: true }),
    ]
    expect(conversations(list, last({ b: 9, c: 9, d: 9, e: 9 })).map(c => c.ik)).toEqual(['a'])
  })
})

describe('the P2P part of the DM list', () => {
  const base = {
    account: 'alice',
    enabled: true,
    contacts: [contact('ann'), contact('bo', { state: 'incoming' })],
    lastTs: last({ ann: 5 }),
  }

  test('hidden while P2P is off for the account or not turned on', () => {
    expect(p2pDmSection({ ...base, account: null })).toBeNull()
    expect(p2pDmSection({ ...base, enabled: false })).toBeNull()
  })

  test('lists the conversations and counts the message requests', () => {
    const section = p2pDmSection(base)
    expect(section?.rows.map(c => c.ik)).toEqual(['ann'])
    expect(section?.requests).toBe(1)
  })

  test('no requests row without requests: ignored ones do not count', () => {
    const section = p2pDmSection({
      ...base,
      contacts: [contact('ann'), contact('bo', { state: 'incoming', ignored: true })],
    })
    expect(section?.requests).toBe(0)
  })

  test('shown with no contacts yet, so Add contact stays reachable', () => {
    expect(p2pDmSection({ ...base, contacts: [] })).toEqual({ rows: [], requests: 0 })
  })
})

describe('addsContacts', () => {
  test('only in the tab that runs P2P, once it started', () => {
    const on = { enabled: true, loading: false, elsewhere: false }
    expect(addsContacts(on)).toBe(true)
    expect(addsContacts({ ...on, enabled: false })).toBe(false)
    expect(addsContacts({ ...on, loading: true })).toBe(false)
    expect(addsContacts({ ...on, elsewhere: true })).toBe(false)
  })
})

describe('serversLoading', () => {
  const starting = {
    enabled: true,
    loading: true,
    countsLoaded: null,
    elsewhere: false,
    error: null,
  }

  test('while P2P starts, and after until the stored servers are listed', () => {
    expect(serversLoading(starting)).toBe(true)
    expect(serversLoading({ ...starting, loading: false })).toBe(true)
    expect(serversLoading({ ...starting, loading: false, countsLoaded: {} })).toBe(false)
  })

  test('not while P2P is off, runs in another tab, or failed', () => {
    expect(serversLoading({ ...starting, enabled: false })).toBe(false)
    expect(serversLoading({ ...starting, loading: false, elsewhere: true })).toBe(false)
    expect(serversLoading({ ...starting, loading: false, error: 'Storage is full' })).toBe(false)
    expect(serversLoading({ ...starting, error: 'Storage is full' })).toBe(false)
  })
})
