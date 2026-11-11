// The device's solve queue: one solve at a time, the most urgent first. A solve asks for its
// turn between chunks (`turn.next()`), so a less urgent one yields there and goes on afterwards.
// While the tab is hidden the proactive renewals wait; solves a request or a socket needs run,
// the socket's on one core, so a hidden tab keeps its socket.

export type Priority = 'foreground' | 'socket' | 'form' | 'renew-shown' | 'renew-other'

export const PRIORITIES: readonly Priority[] = [
  'foreground',
  'socket',
  'form',
  'renew-shown',
  'renew-other',
]

export class SolveCancelled extends Error {
  constructor() {
    super('The solve was cancelled')
    this.name = 'SolveCancelled'
  }
}

export interface Turn {
  readonly signal: AbortSignal
  threads(): 'all' | 'one'
  next(): Promise<void>
}

export interface Handle<T> {
  readonly done: Promise<T>
  cancel(): void
}

interface Entry {
  seq: number
  priority: Priority
  key: string | undefined
  // waiting: not started. running: it has the turn. paused: between chunks, without the turn.
  // stopping: cancelled while it had the turn, which it keeps until its work has ended.
  state: 'waiting' | 'running' | 'paused' | 'stopping'
  cancelled: boolean
  begin: () => void
  resume: (() => void) | null
  refuse: ((e: Error) => void) | null
  handle: Handle<unknown>
}

const rank = (p: Priority) => PRIORITIES.indexOf(p)
const held = (p: Priority) => p === 'renew-shown' || p === 'renew-other'

export class SolveQueue {
  private entries: Entry[] = []
  private seq = 0

  constructor(private hidden: () => boolean) {}

  // Queues a solve. With a `key`, an ask for a solve that is already queued or running joins it
  // and raises it to the more urgent of the two priorities.
  add<T>(priority: Priority, run: (turn: Turn) => Promise<T>, key?: string): Handle<T> {
    const same =
      key === undefined ? undefined : this.entries.find(e => e.key === key && !e.cancelled)
    if (same) {
      if (rank(priority) < rank(same.priority)) same.priority = priority
      this.advance()
      return same.handle as Handle<T>
    }
    const abort = new AbortController()
    let resolve!: (value: T) => void
    let reject!: (e: unknown) => void
    const done = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    done.catch(() => {})
    const finish = (settle: () => void) => {
      this.entries = this.entries.filter(e => e !== entry)
      if (!entry.cancelled) settle()
      this.advance()
    }
    const entry: Entry = {
      seq: (this.seq += 1),
      priority,
      key,
      state: 'waiting',
      cancelled: false,
      begin: () => {
        const turn: Turn = {
          signal: abort.signal,
          threads: () => (entry.priority === 'socket' && this.hidden() ? 'one' : 'all'),
          next: () => this.next(entry),
        }
        Promise.resolve()
          .then(() => run(turn))
          .then(
            value => finish(() => resolve(value)),
            (e: unknown) => finish(() => reject(e))
          )
      },
      resume: null,
      refuse: null,
      handle: {
        done,
        cancel: () => {
          if (entry.cancelled || !this.entries.includes(entry)) return
          entry.cancelled = true
          abort.abort()
          reject(new SolveCancelled())
          if (entry.state === 'running') {
            entry.state = 'stopping'
            return
          }
          this.entries = this.entries.filter(e => e !== entry)
          entry.refuse?.(new SolveCancelled())
        },
      },
    }
    this.entries.push(entry)
    this.advance()
    return entry.handle as Handle<T>
  }

  // Call when the tab is shown or hidden.
  visibility(): void {
    this.advance()
  }

  cancelAll(): void {
    for (const entry of [...this.entries]) entry.handle.cancel()
  }

  // The priority of the solve that has the turn.
  running(): Priority | null {
    return this.busy()?.priority ?? null
  }

  // Solves that wait to start or to go on.
  waiting(): number {
    return this.entries.filter(e => e.state === 'waiting' || e.state === 'paused').length
  }

  private busy(): Entry | undefined {
    return this.entries.find(e => e.state === 'running' || e.state === 'stopping')
  }

  // The most urgent entry that may run now, the oldest among equals.
  private best(candidates: Entry[]): Entry | undefined {
    const hidden = this.hidden()
    return candidates
      .filter(e => !(hidden && held(e.priority)))
      .sort((a, b) => rank(a.priority) - rank(b.priority) || a.seq - b.seq)[0]
  }

  private advance(): void {
    if (this.busy()) return
    const next = this.best(this.entries)
    if (!next) return
    const { state, resume } = next
    next.state = 'running'
    next.resume = null
    next.refuse = null
    if (state === 'waiting') next.begin()
    else resume?.()
  }

  private next(entry: Entry): Promise<void> {
    if (entry.cancelled) return Promise.reject(new SolveCancelled())
    const others = this.entries.filter(e => e.state === 'waiting' || e.state === 'paused')
    if (this.best([entry, ...others]) === entry) return Promise.resolve()
    entry.state = 'paused'
    const waited = new Promise<void>((resolve, reject) => {
      entry.resume = resolve
      entry.refuse = reject
    })
    this.advance()
    return waited
  }
}
