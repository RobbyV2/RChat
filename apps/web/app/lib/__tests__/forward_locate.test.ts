import { flush } from './helpers/test_clock'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  LOOKUPS_MAX,
  NONE_TTL_MS,
  forgetLocated,
  locateFailed,
  locateOnce,
  locatedNow,
} from '../forward_locate'
import type { ServerDetail } from '../types'
import { me, serverDetail } from './fixtures'
import { testAccount } from './test_account'
import { writeJson } from '../api/masks'

const realFetch = globalThis.fetch
let asked: string[] = []
let answer: () => Response

const place =
  (server: string, channel_id: number, shown: object | null = null) =>
  () =>
    new Response(writeJson({ server, channel_id, dm_id: null, thread_root_id: null, shown }), {
      status: 200,
    })
const notFound = () => new Response(writeJson({ error: 'Not found' }), { status: 404 })

beforeEach(() => {
  asked = []
  answer = notFound
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(new URL(String(input)).pathname)
    return answer()
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const general = {
  id: 1,
  name: 'general',
  kind: 'text' as const,
  slowmode_seconds: 0,
  category_id: null,
  my_perms: null,
  topic: null,
}
const member = (...names: string[]) =>
  me('alice', {
    servers: names.map(name => ({
      name,
      display_name: name,
      creator: null,
      is_admin: false,
      banner_color: null,
      icon_image: null,
      icon_kind: 'identicon' as const,
      name_color: null,
      profiles_mode: 'all' as const,
      timed_out_remaining: null,
      timed_out_until: null,
    })),
  })

const account = () => {
  const acct = testAccount('alice')
  acct.store.setState({
    me: member('club'),
    servers: { club: serverDetail('club', { channels: [general] }) },
  })
  return acct
}

describe('located originals', () => {
  test('one lookup answers every view of the copy, with what a shown source names', async () => {
    const acct = account()
    answer = place('club', 1, { server: 'Club', channel: 'general' })
    expect(locatedNow(acct, 40)).toBeUndefined()
    await Promise.all([locateOnce(acct, 40), locateOnce(acct, 40)])
    await locateOnce(acct, 40)
    expect(asked).toEqual(['/api/messages/40/location'])
    expect(locatedNow(acct, 40)).toEqual({
      kind: 'channel',
      server: 'club',
      id: 1,
      shown: { server: 'Club', channel: 'general' },
    })
  })

  test('renamed servers or a changed count ask nothing again; a renamed source asks again', async () => {
    const acct = account()
    answer = place('club', 1)
    await locateOnce(acct, 40)
    const s = acct.store.getState()
    acct.store.setState({
      me: member('club'),
      servers: { club: { ...s.servers.club, online_count: 3 } },
    })
    expect(locatedNow(acct, 40)?.kind).toBe('channel')
    await locateOnce(acct, 40)
    expect(asked.length).toBe(1)
    acct.store.setState({
      servers: { club: { ...acct.store.getState().servers.club, display_name: 'Book Club' } },
    })
    expect(locatedNow(acct, 40)).toBeUndefined()
    await locateOnce(acct, 40)
    expect(asked.length).toBe(2)
  })

  test('nowhere you can read holds for a minute, so access gained shows', async () => {
    const acct = account()
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      await locateOnce(acct, 41)
      now += NONE_TTL_MS
      expect(locatedNow(acct, 41)).toEqual({ kind: 'none' })
      now += 1
      expect(locatedNow(acct, 41)).toBeUndefined()
      answer = place('club', 1)
      await locateOnce(acct, 41)
      expect(locatedNow(acct, 41)?.kind).toBe('channel')
      expect(asked.length).toBe(2)
    } finally {
      Date.now = realNow
    }
  })

  test('a lookup begun under other servers is not reused', async () => {
    const acct = account()
    const gates: (() => void)[] = []
    answer = () =>
      new Promise<void>(r => gates.push(r)).then(() => place('club', 1)()) as unknown as Response
    const first = locateOnce(acct, 42)
    acct.store.setState({ me: member('club', 'vault') })
    const second = locateOnce(acct, 42)
    await flush()
    for (const open of gates) open()
    await Promise.all([first, second])
    expect(locatedNow(acct, 42)?.kind).toBe('channel')
    expect(asked.length).toBe(2)
  })

  test('answers are capped, the oldest going first', async () => {
    const acct = account()
    answer = place('club', 1)
    for (let id = 1; id <= LOOKUPS_MAX + 1; id++) await locateOnce(acct, id)
    expect(locatedNow(acct, 1)).toBeUndefined()
    expect(locatedNow(acct, 2)?.kind).toBe('channel')
    expect(locatedNow(acct, LOOKUPS_MAX + 1)?.kind).toBe('channel')
  })

  test('losing access: a reload of the server asks again', async () => {
    const acct = account()
    answer = place('club', 1)
    await locateOnce(acct, 40)
    const reloaded: ServerDetail = serverDetail('club', { channels: [] })
    acct.store.setState({ servers: { club: reloaded } })
    expect(locatedNow(acct, 40)).toBeUndefined()
    answer = notFound
    await locateOnce(acct, 40)
    expect(asked.length).toBe(2)
    expect(locatedNow(acct, 40)).toEqual({ kind: 'none' })
  })

  test('gaining access: joining a server asks again', async () => {
    const acct = account()
    await locateOnce(acct, 41)
    expect(locatedNow(acct, 41)).toEqual({ kind: 'none' })
    acct.store.setState({ me: member('club', 'vault') })
    expect(locatedNow(acct, 41)).toBeUndefined()
    answer = place('vault', 9)
    await locateOnce(acct, 41)
    expect(asked.length).toBe(2)
    expect(locatedNow(acct, 41)?.kind).toBe('channel')
  })

  test('a deleted original or channel takes its answers along', async () => {
    const acct = account()
    answer = place('club', 1)
    await Promise.all([locateOnce(acct, 40), locateOnce(acct, 42)])
    const scoped = { server: 'club', channel_id: 1, dm_id: null, dm_users: null }
    forgetLocated(acct, { type: 'message_deleted', id: 40, thread_root_id: null, ...scoped })
    expect(locatedNow(acct, 40)).toBeUndefined()
    expect(locatedNow(acct, 42)?.kind).toBe('channel')
    acct.store.getState().applyWsEvent({ type: 'channel_deleted', server: 'club', channel_id: 1 })
    expect(locatedNow(acct, 42)).toBeUndefined()
  })

  test('another error is asked again next time', async () => {
    const acct = account()
    answer = () => new Response('oops', { status: 500 })
    await locateOnce(acct, 40)
    expect(locatedNow(acct, 40)).toBeUndefined()
    expect(locateFailed(acct, 40)).toBe(true)
    answer = place('club', 1)
    await locateOnce(acct, 40)
    expect(asked.length).toBe(2)
    expect(locatedNow(acct, 40)?.kind).toBe('channel')
  })
})
