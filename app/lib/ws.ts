import { backoffDelay, nextAttempt } from './backoff'
import type { VoiceMsg, WsEvent, WsStatus } from './types'

const secure = (protocol: string) => protocol === 'https:' || protocol === 'wss:'

export function wsUrlFrom(
  base: string | undefined,
  loc?: { protocol: string; host: string },
  basePath = '',
  gateway?: string
): string {
  const target = gateway || base
  if (target) {
    const u = new URL(target)
    return `${secure(u.protocol) ? 'wss' : 'ws'}://${u.host}/api/ws`
  }
  const l = loc as { protocol: string; host: string }
  return `${l.protocol === 'https:' ? 'wss' : 'ws'}://${l.host}${basePath}/api/ws`
}

export interface WsEndpoints {
  url: () => string
  probe: () => string
}

export class WsClient {
  private ws: WebSocket | null = null
  private token: string | null = null
  private viewing: string | null = null
  private subs = new Set<string>()
  private grants: Record<string, string> = {}
  private stopped = true
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private openedAt: number | null = null

  onEvent: (ev: WsEvent) => void = () => {}
  onStatus: (status: WsStatus) => void = () => {}
  onPoll: () => void = () => {}

  constructor(private endpoints: WsEndpoints) {}

  retarget(endpoints: WsEndpoints) {
    this.endpoints = endpoints
  }

  start(token: string | null) {
    this.stop()
    this.stopped = false
    this.token = token
    this.connect()
  }

  stop() {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.reconnectTimer = null
    this.connectTimer = null
    this.attempt = 0
    this.openedAt = null
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

  resubscribe() {
    this.sendSubscribe()
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
    const ws = new WebSocket(this.endpoints.url())
    this.ws = ws
    this.connectTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState !== WebSocket.OPEN) ws.close()
    }, 5_000)
    ws.onopen = () => {
      if (this.connectTimer) clearTimeout(this.connectTimer)
      this.connectTimer = null
      this.openedAt = Date.now()
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
    const openFor = this.openedAt === null ? null : Date.now() - this.openedAt
    this.openedAt = null
    this.attempt = nextAttempt(this.attempt, openFor)
    void this.probe()
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null
        this.connect()
      },
      backoffDelay(this.attempt - 1)
    )
  }

  private async probe() {
    const ws = this.ws
    const stale = () => this.stopped || this.ws !== ws || ws?.readyState === WebSocket.OPEN
    try {
      const res = await fetch(this.endpoints.probe())
      if (stale()) return
      if (res.ok) {
        this.onStatus('yellow')
        this.onPoll()
      } else {
        this.onStatus('red')
      }
    } catch {
      if (!stale()) this.onStatus('red')
    }
  }
}
