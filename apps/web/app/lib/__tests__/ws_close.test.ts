import { afterEach, describe, expect, test } from 'bun:test'
import { CLOSE_TOO_MANY, WsClient, reconnectsAfter } from '../ws'

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

describe('realtime close codes', () => {
  test('only a connection closed for too many open ones waits to be used again', () => {
    expect(reconnectsAfter(CLOSE_TOO_MANY)).toBe(false)
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

  test('other closes, including too many attempts, back off and retry', () => {
    const { client, ws } = openClient()
    ws.readyState = 3
    ws.onclose?.({ code: 4029 })
    expect((client as unknown as { reconnectTimer: unknown }).reconnectTimer === null).toBe(false)
    client.stop()
  })
})
