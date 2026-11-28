import { flush, testClock, type ManualTime } from './helpers/test_clock'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { useStore } from '../store'
import { me, msg, serverDetail, textChannel } from './fixtures'
import { writeJson } from '../api/masks'

let clock: ManualTime
beforeEach(() => {
  clock = testClock()
})

const st = () => useStore.getState()
const realFetch = globalThis.fetch
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown }
let calls: Call[] = []
let open = false
let confirmStatus = 200
let remaining = 900

const asked = {
  error: 'Confirm to open this channel',
  reason: { kind: 'confirm', control: 'staff_view', channel: 7 },
}

const view = { kind: 'channel', server: 's', channelId: 7 } as const

beforeEach(() => {
  calls = []
  open = false
  confirmStatus = 200
  remaining = 900
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({
      url,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    if (url.endsWith('/staff_view')) {
      if (confirmStatus !== 200)
        return new Response(writeJson({ error: 'Wrong password' }), { status: confirmStatus })
      open = true
      return new Response(writeJson({ until: 1, remaining }), { status: 200 })
    }
    if (url.includes('/channels/7') && !open) return new Response(writeJson(asked), { status: 403 })
    return new Response(writeJson([msg(1), msg(2)]), { status: 200 })
  }) as typeof fetch
  useStore.setState({
    me: { ...me('root'), is_site_admin: true },
    token: null,
    guest: false,
    view,
    servers: { s: serverDetail('s', { channels: [1, 7].map(textChannel) }) },
    messages: {},
    older: {},
    newer: {},
    focus: {},
    panel: null,
    invite: null,
    error: null,
    staffAsk: null,
    staffShut: null,
    staffOpen: [],
    pins: null,
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
})

test('a channel that asks for a confirmation raises the question without an error', async () => {
  await st().jumpToPresent('c7')
  expect(st().staffAsk).toBe(7)
  expect(st().staffShut).toBe(view)
  expect(st().error).toBeNull()
  expect(st().messages.c7).toBeUndefined()
})

test('confirming sends the reason, opens the channel and loads it', async () => {
  await st().jumpToPresent('c7')
  await st().confirmStaffView({ password: 'pw' }, ' Report #12 ')
  const sent = calls.find(c => c.url.endsWith('/admin/channels/7/staff_view'))
  expect(sent?.method).toBe('POST')
  expect(sent?.body).toEqual({ reauth: { password: 'pw' } })
  expect(sent?.headers['X-Staff-Reason']).toBe('Report%20%2312')
  expect(st().staffAsk).toBeNull()
  expect(st().staffShut).toBeNull()
  expect(st().staffOpen).toEqual([7])
  await flush()
  expect((st().messages.c7 ?? []).map(m => m.id)).toEqual([1, 2])
})

test('a refused confirmation keeps the question and sends no reason header without a reason', async () => {
  await st().jumpToPresent('c7')
  confirmStatus = 401
  const refused = await st()
    .confirmStaffView({ password: 'no' }, '')
    .then(
      () => null,
      (e: unknown) => e
    )
  expect(refused instanceof Error ? refused.message : null).toBe('Wrong password')
  expect(st().staffAsk).toBe(7)
  const sent = calls.find(c => c.url.endsWith('/staff_view'))
  expect(sent?.headers['X-Staff-Reason']).toBeUndefined()
})

test('after Cancel the same view stays closed without reading, and opening the channel anew asks', async () => {
  await st().jumpToPresent('c7')
  st().closeStaffAsk()
  expect(st().staffAsk).toBeNull()
  expect(st().staffShut).toBe(view)
  const reads = calls.length
  await st().jumpToPresent('c7')
  expect(st().staffAsk).toBeNull()
  expect(calls.length).toBe(reads)
  st().askStaffView(7)
  expect(st().staffAsk).toBe(7)
  st().closeStaffAsk()
  useStore.setState({ view: { kind: 'channel', server: 's', channelId: 7 } })
  await st().jumpToPresent('c7')
  expect(st().staffAsk).toBe(7)
})

test('a refused action anywhere asks for its channel instead of showing an error', async () => {
  useStore.setState({ view: { kind: 'channel', server: 's', channelId: 1 } })
  await st().renameChannel(7, 'renamed')
  expect(calls.some(c => c.method === 'PATCH' && c.url.endsWith('/channels/7'))).toBe(true)
  expect(st().staffAsk).toBe(7)
  expect(st().staffShut).toBeNull()
  expect(st().error).toBeNull()
})

test('a refused pins read asks too', async () => {
  st().openPins()
  await flush()
  expect(calls.some(c => c.url.endsWith('/channels/7/pins'))).toBe(true)
  expect(st().staffAsk).toBe(7)
  expect(st().pins?.failed).toBe(true)
})

test('the view closes when the confirmation runs out', async () => {
  remaining = 0.05
  await st().jumpToPresent('c7')
  await st().confirmStaffView({ password: 'pw' }, '')
  useStore.setState({ panel: { kind: 'thread', root: msg(1, { channel_id: 7 }) } as never })
  expect(st().staffShut).toBeNull()
  await clock.pass(120)
  expect(st().staffShut).toBe(view)
  expect(st().staffOpen).toEqual([])
  expect(st().panel).toBeNull()
  expect(st().staffAsk).toBeNull()
})

test('a confirmation that runs out elsewhere leaves the view as it is', async () => {
  remaining = 0.05
  await st().jumpToPresent('c7')
  await st().confirmStaffView({ password: 'pw' }, '')
  const other = { kind: 'channel', server: 's', channelId: 1 } as const
  useStore.setState({ view: other })
  await clock.pass(120)
  expect(st().staffShut).toBeNull()
  expect(st().staffOpen).toEqual([])
})

test('other refusals stay errors', async () => {
  open = true
  globalThis.fetch = (async () =>
    new Response(writeJson({ error: 'Missing permission' }), {
      status: 403,
    })) as typeof fetch
  await st().jumpToPresent('c7')
  expect(st().staffAsk).toBeNull()
  expect(st().error).toBe('Missing permission')
})
