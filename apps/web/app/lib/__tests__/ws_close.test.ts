import { afterEach, describe, expect, test } from 'bun:test'
import { CLOSE_TOO_MANY, WS_MESSAGE_MAX, WsClient, mayConnectEarly, reconnectsAfter } from '../ws'

type Fake = {
  readyState: number
  onopen: (() => void) | null
  onclose: ((e: { code: number }) => void) | null
  onerror: (() => void) | null
  onmessage: ((e: { data: string }) => void) | null
  send: (data: string) => void
  close: () => void
}

const sockets: Fake[] = []
const realWs = globalThis.WebSocket
const realFetch = globalThis.fetch

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  readyState = 0
  onopen: Fake['onopen'] = null
  onclose: Fake['onclose'] = null
  onerror: Fake['onerror'] = null
  onmessage: Fake['onmessage'] = null
  constructor() {
    sockets.push(this)
  }
  send() {}
  close() {
    this.readyState = 3
  }
}

const openClient = () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  globalThis.fetch = (async () => new Response('ok')) as unknown as typeof fetch
  const statuses: string[] = []
  const client = new WsClient({ url: () => 'ws://x/api/ws', probe: () => 'http://x/api/health' })
  client.onStatus = s => statuses.push(s)
  client.start('token')
  const ws = sockets[sockets.length - 1]
  ws.readyState = 1
  ws.onopen?.()
  return { client, ws, statuses }
}

afterEach(() => {
  globalThis.WebSocket = realWs
  globalThis.fetch = realFetch
  sockets.length = 0
})

describe('realtime reconnects', () => {
  test('replacing a socket after an event gap ignores late frames from the old socket', () => {
    const { client, ws } = openClient()
    const events: string[] = []
    client.onEvent = ev => events.push(ev.type)
    client.reconnectAfterGap()
    ws.onmessage?.({ data: '{"type":"resync"}' })
    const fresh = sockets.at(-1)!
    fresh.onmessage?.({ data: '{"type":"hello"}' })
    expect(events).toEqual(['hello'])
    client.stop()
  })

  test('wait as long as the instance asks', () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    globalThis.fetch = (async () => new Response('ok')) as unknown as typeof fetch
    const waits: number[] = []
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      waits.push(ms ?? 0)
      return realSetTimeout(() => {}, 0)
    }) as typeof setTimeout
    try {
      const timings = { reconnect_base_ms: 9000, reconnect_cap_ms: 9000, reconnect_floor_ms: 8000 }
      const client = new WsClient({
        url: () => 'ws://x/api/ws',
        probe: () => 'http://x/api/health',
        timings: () => timings,
      })
      client.start('token')
      const ws = sockets[sockets.length - 1]
      ws.readyState = 3
      ws.onclose?.({ code: 1006 })
      expect(waits.some(ms => ms >= 8000 && ms < 9000)).toBe(true)
      client.stop()
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })
})

describe('realtime close codes', () => {
  test('only a connection closed for too many open ones waits to be used again', () => {
    expect(reconnectsAfter(CLOSE_TOO_MANY)).toBe(false)
    expect(reconnectsAfter(4403)).toBe(false)
    expect(reconnectsAfter(4029)).toBe(true)
    expect(reconnectsAfter(1006)).toBe(true)
  })

  test('closed as the oldest of too many: no reconnect until used again', () => {
    const { client, ws, statuses } = openClient()
    ws.readyState = 3
    ws.onclose?.({ code: CLOSE_TOO_MANY })
    expect(statuses).toEqual(['green', 'red'])
    expect(sockets.length).toBe(1)
    expect((client as unknown as { reconnectTimer: unknown }).reconnectTimer).toBeNull()
    client.ensureConnected()
    expect(sockets.length).toBe(2)
    client.stop()
  })

  test('a restricted account waits for a new session start', () => {
    const { client, ws } = openClient()
    let prompted = false
    client.onPasswordChangeRequired = () => {
      prompted = true
    }
    ws.readyState = 3
    ws.onclose?.({ code: 4403 })
    expect(prompted).toBe(true)
    client.ensureConnected()
    expect(sockets.length).toBe(1)
    client.start('token')
    expect(sockets.length).toBe(2)
    client.stop()
  })

  test('user actions skip the backoff only a while after the last failure', () => {
    expect(mayConnectEarly(null, 0, false)).toBe(true)
    expect(mayConnectEarly(1_000, 2_000, false)).toBe(false)
    expect(mayConnectEarly(1_000, 6_000, false)).toBe(true)
    expect(mayConnectEarly(1_000, 60_000, true)).toBe(false)
    const { client, ws } = openClient()
    ws.readyState = 3
    ws.onclose?.({ code: 1006 })
    client.ensureConnected()
    expect(sockets.length).toBe(1)
    client.stop()
  })

  test('closed for too many attempts: no early reconnect, a longer backoff', () => {
    const { client, ws } = openClient()
    ws.readyState = 3
    ws.onclose?.({ code: 4029 })
    client.ensureConnected()
    expect(sockets.length).toBe(1)
    expect((client as unknown as { attempt: number }).attempt >= 3).toBe(true)
    client.stop()
  })

  test('other closes, including too many attempts, back off and retry', () => {
    const { client, ws } = openClient()
    ws.readyState = 3
    ws.onclose?.({ code: 4029 })
    expect((client as unknown as { reconnectTimer: unknown }).reconnectTimer === null).toBe(false)
    client.stop()
  })

  test('a message the server would close the connection for is not sent', () => {
    const { client, ws } = openClient()
    const sent: string[] = []
    ws.send = data => void sent.push(data)
    const ids = (n: number, len: number) =>
      Array.from({ length: n }, (_, i) => `${i}`.padEnd(len, 'x'))
    const err = console.error
    console.error = () => {}
    try {
      expect(client.sendVoice({ type: 'p2p_hosting', peer_id: 'p', ids: ids(256, 32) })).toBe(true)
      expect(client.sendVoice({ type: 'p2p_hosting', peer_id: 'p', ids: ids(2000, 32) })).toBe(
        false
      )
      expect(
        client.sendVoice({
          type: 'p2p_who',
          hosters: [String.fromCodePoint(0x1f600).repeat(17000)],
        })
      ).toBe(false)
    } finally {
      console.error = err
    }
    expect(sent.length).toBe(1)
    expect(sent[0].length < WS_MESSAGE_MAX).toBe(true)
    client.stop()
  })
})
