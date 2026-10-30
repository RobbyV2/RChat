// One P2P node per identity database across tabs. The tab holding the Web Lock runs the node;
// the others wait in line (and take over when that tab closes). "Use here" asks the holder to
// stop its node cleanly, then takes the lock from it.

export interface LockLike {
  request: (
    name: string,
    opts: { signal?: AbortSignal; ifAvailable?: boolean; steal?: boolean },
    cb: (lock: unknown) => Promise<unknown>
  ) => Promise<unknown>
}

export interface ChannelLike {
  postMessage: (msg: unknown) => void
  onmessage: ((e: { data: unknown }) => void) | null
  close: () => void
}

export interface LeaderDeps {
  locks: LockLike | null
  channel: (name: string) => ChannelLike | null
  set: (fn: () => void, ms: number) => unknown
  clear: (h: unknown) => void
}

export interface LeaderHooks {
  // This tab holds the lock now: start the node.
  lead: () => Promise<void>
  // Stop the node (and close the database) before the lock moves on.
  resign: () => Promise<void>
  // Another tab runs the node.
  follow: () => void
}

export const webLeaderDeps = (): LeaderDeps => ({
  locks:
    typeof navigator !== 'undefined' && navigator.locks
      ? (navigator.locks as unknown as LockLike)
      : null,
  channel: name =>
    typeof BroadcastChannel === 'undefined'
      ? null
      : (new BroadcastChannel(name) as unknown as ChannelLike),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: h => clearTimeout(h as ReturnType<typeof setTimeout>),
})

// How long a holder that was asked to let go waits for the asking tab, and how long the asking
// tab waits for a reply before it takes the lock anyway (a frozen tab).
export const HANDOVER_MS = 3000

type State = 'idle' | 'waiting' | 'leading' | 'handing' | 'stopped'

export class TabLeader {
  state: State = 'idle'
  private bc: ChannelLike | null = null
  private release: (() => void) | null = null
  private queued: AbortController | null = null
  private asking: unknown = null
  private handTimer: unknown = null
  private hold = 0

  constructor(
    private name: string,
    private hooks: LeaderHooks,
    private deps: LeaderDeps = webLeaderDeps()
  ) {}

  start() {
    if (this.state !== 'idle') return
    const { locks } = this.deps
    if (!locks) {
      // No Web Locks (very old browsers): run here.
      this.state = 'leading'
      void this.hooks.lead()
      return
    }
    this.bc = this.deps.channel(`${this.name}:leader`)
    if (this.bc) this.bc.onmessage = e => this.onMessage(e.data)
    this.state = 'waiting'
    void locks
      .request(this.name, { ifAvailable: true }, lock => {
        if (lock) return this.held()
        if (this.state === 'waiting') {
          this.hooks.follow()
          this.queue()
        }
        return Promise.resolve()
      })
      .catch(() => void this.lost())
  }

  // This tab wants the node: the holder stops its node, says so, and we take the lock.
  takeOver() {
    if (this.state !== 'waiting' || !this.deps.locks || this.asking !== null) return
    this.asking = this.deps.set(() => this.steal(), HANDOVER_MS)
    if (this.bc) this.bc.postMessage({ t: 'release' })
    else this.steal()
  }

  async stop() {
    const was = this.state
    this.state = 'stopped'
    this.queued?.abort()
    this.queued = null
    if (this.asking !== null) this.deps.clear(this.asking)
    this.asking = null
    if (this.handTimer !== null) this.deps.clear(this.handTimer)
    this.handTimer = null
    this.bc?.close()
    this.bc = null
    if (was === 'leading') await this.hooks.resign()
    this.release?.()
    this.release = null
  }

  private queue() {
    const locks = this.deps.locks
    if (!locks || this.state !== 'waiting') return
    this.queued?.abort()
    const ac = new AbortController()
    this.queued = ac
    let granted = false
    void locks
      .request(this.name, { signal: ac.signal }, () => {
        granted = true
        return this.held()
      })
      .catch(() => {
        // Aborted while waiting, or the lock was taken from us later.
        if (granted) void this.lost()
        else if (this.queued === ac) this.queued = null
      })
  }

  private steal() {
    const locks = this.deps.locks
    if (this.asking !== null) this.deps.clear(this.asking)
    this.asking = null
    if (!locks || this.state !== 'waiting') return
    this.queued?.abort()
    this.queued = null
    void locks.request(this.name, { steal: true }, () => this.held()).catch(() => void this.lost())
  }

  private held(): Promise<void> {
    if (this.state === 'stopped') return Promise.resolve()
    this.queued?.abort()
    this.queued = null
    this.state = 'leading'
    const mine = ++this.hold
    const done = new Promise<void>(resolve => {
      this.release = () => {
        if (this.hold === mine) this.release = null
        resolve()
      }
    })
    void this.hooks.lead()
    return done
  }

  // Our lock was taken (stolen): stop the node if it still runs and wait in line again.
  private async lost() {
    if (this.state === 'stopped') return
    const was = this.state
    this.state = 'waiting'
    this.release = null
    if (this.handTimer !== null) this.deps.clear(this.handTimer)
    this.handTimer = null
    if (was === 'leading') await this.hooks.resign()
    if (this.state !== 'waiting') return
    this.hooks.follow()
    this.queue()
  }

  private async onMessage(data: unknown) {
    const t = typeof data === 'object' && data !== null ? (data as { t?: unknown }).t : null
    if (t === 'release' && this.state === 'leading') {
      this.state = 'handing'
      await this.hooks.resign()
      if (this.state !== 'handing') return
      this.hooks.follow()
      this.bc?.postMessage({ t: 'released' })
      // The asking tab steals the lock now; if it went away, let the line move on.
      this.handTimer = this.deps.set(() => {
        this.handTimer = null
        if (this.state !== 'handing') return
        this.state = 'waiting'
        this.release?.()
        this.release = null
        this.queue()
      }, HANDOVER_MS)
    } else if (t === 'released' && this.asking !== null) this.steal()
  }
}
