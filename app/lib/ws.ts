import { getBasePath } from './basePath'
import type { VoiceMsg, WsEvent, WsStatus } from './types'

const apiBase = process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, '')

export function wsUrlFrom(
  base: string | undefined,
  loc?: { protocol: string; host: string },
  basePath = ''
): string {
  if (base) {
    const u = new URL(base)
    return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/api/ws`
  }
  const l = loc as { protocol: string; host: string }
  return `${l.protocol === 'https:' ? 'wss' : 'ws'}://${l.host}${basePath}/api/ws`
}

const wsUrl = () => wsUrlFrom(apiBase, window.location, getBasePath())

const probeUrl = apiBase ? `${apiBase}/api/servers/rchat` : `${getBasePath()}/api/servers/rchat`

class WsClient {
  private ws: WebSocket | null = null
  private token: string | null = null
  private viewing: string | null = null
  private subs = new Set<string>()
  private grants: Record<string, string> = {}
  private stopped = true
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private degradedTimer: ReturnType<typeof setInterval> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null

  onEvent: (ev: WsEvent) => void = () => {}
  onStatus: (status: WsStatus) => void = () => {}
  onPoll: () => void = () => {}

  start(token: string | null) {
    this.stop()
    this.stopped = false
    this.token = token
    this.connect()
  }

  stop() {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.degradedTimer) clearInterval(this.degradedTimer)
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.reconnectTimer = null
    this.degradedTimer = null
    this.connectTimer = null
    const ws = this.ws
    this.ws = null
    ws?.close()
    this.subs.clear()
    this.viewing = null
  }

  ensureConnected() {
    if (this.stopped) return
    const rs = this.ws?.readyState
    if (rs === WebSocket.OPEN || rs === WebSocket.CONNECTING) return
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.connect()
  }

  setViewing(server: string | null) {
    this.viewing = server
    this.send({ type: 'viewing', server })
  }

  setGrants(grants: Record<string, string>) {
    this.grants = grants
  }

  subscribe(servers: string[]) {
    for (const s of servers) this.subs.add(s)
    this.sendSubscribe()
  }

  unsubscribe(server: string) {
    if (this.subs.delete(server)) this.sendSubscribe()
  }

  private sendSubscribe() {
    this.send({ type: 'subscribe', servers: [...this.subs], grants: this.grants })
  }

  sendVoice(msg: VoiceMsg): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  private send(payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload))
  }

  private connect() {
    if (this.stopped) return
    const ws = new WebSocket(wsUrl())
    this.ws = ws
    this.connectTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState !== WebSocket.OPEN) ws.close()
    }, 5_000)
    ws.onopen = () => {
      if (this.connectTimer) clearTimeout(this.connectTimer)
      this.connectTimer = null
      if (this.degradedTimer) clearInterval(this.degradedTimer)
      this.degradedTimer = null
      this.send({ type: 'auth', token: this.token })
      if (this.token) this.send({ type: 'viewing', server: this.viewing })
      if (this.subs.size) this.sendSubscribe()
      this.onStatus('green')
    }
    ws.onmessage = e => {
      try {
        this.onEvent(JSON.parse(e.data as string) as WsEvent)
      } catch (err) {
        console.error('ws parse', err)
      }
    }
    ws.onclose = () => {
      if (this.connectTimer) clearTimeout(this.connectTimer)
      this.connectTimer = null
      if (this.ws !== ws || this.stopped) return
      this.dropped()
    }
    ws.onerror = () => ws.close()
  }

  private dropped() {
    void this.probe()
    if (!this.degradedTimer) {
      this.degradedTimer = setInterval(() => void this.probe(), 10_000)
    }
    this.reconnectTimer = setTimeout(() => this.connect(), 2_000)
  }

  private async probe() {
    try {
      const res = await fetch(probeUrl)
      if (res.ok) {
        this.onStatus('yellow')
        this.onPoll()
      } else {
        this.onStatus('red')
      }
    } catch {
      this.onStatus('red')
    }
  }
}

export const wsClient = new WsClient()
