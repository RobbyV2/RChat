import { endsText } from '../durations'
import type { MemberView, ServerView } from './server/types'

// A timed ban ends with an ordinary signed unban, written by the device of an online member
// allowed to lift it: the banner's at once, any other after a random wait, so one of them writes
// it and the rest find the ban already lifted.

export const UNBAN_WAIT_MAX = 600_000
// Timers longer than this are set again when they fire (timer delays are 32-bit).
const TIMER_MAX = 86_400_000

type Banned = MemberView & { banUntil: number }

export const timedBan = (m: MemberView): m is Banned => m.m === 'ban' && m.banUntil !== undefined

// How long this device waits past a ban's end before lifting it.
export const unbanWait = (mine: boolean, random: () => number = Math.random) =>
  mine ? 0 : Math.floor(random() * UNBAN_WAIT_MAX)

// The bans of `v` that ended and that this device may lift.
export const dueUnbans = (v: Pick<ServerView, 'members'>, now: number): Banned[] =>
  v.members.filter(timedBan).filter(m => m.unban && m.banUntil <= now)

// What the member list says of a timed ban.
export const banStateText = (m: MemberView, now: number, locale?: string): string | null =>
  !timedBan(m)
    ? null
    : m.banUntil > now
      ? `Ban ends ${endsText(m.banUntil, now, locale)}`
      : "Waiting for a moderator's device"

export interface BanExpiryEnv {
  now: () => number
  random: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (t: unknown) => void
  // The current view of a room, or null when it is gone.
  view: (room: string) => Pick<ServerView, 'members'> | null
  unban: (room: string, ik: string) => void
}

// Lifts the timed bans this device may lift when they end, once per end.
export class BanExpiry {
  private timers = new Map<string, { until: number; timer: unknown }>()
  // The bans this device wrote the unban of, by the end they had, until they leave the view or
  // get another end.
  private lifted = new Map<string, number>()

  constructor(private env: BanExpiryEnv) {}

  // Sets a timer for each timed ban of the rooms this device may lift, and drops the timers of
  // bans that are gone or changed.
  sync(rooms: Record<string, Pick<ServerView, 'members'>>) {
    const live = new Set<string>()
    for (const [room, v] of Object.entries(rooms))
      for (const m of v.members) {
        if (!timedBan(m) || !m.unban) continue
        const key = `${room}\u0001${m.ik}`
        live.add(key)
        if (this.lifted.get(key) === m.banUntil) continue
        this.lifted.delete(key)
        if (this.timers.get(key)?.until === m.banUntil) continue
        this.drop(key)
        const at = m.banUntil + unbanWait(m.banMine === true, this.env.random)
        this.arm(key, room, m.ik, m.banUntil, at)
      }
    for (const key of [...this.timers.keys()]) if (!live.has(key)) this.drop(key)
    for (const key of [...this.lifted.keys()]) if (!live.has(key)) this.lifted.delete(key)
  }

  stop() {
    for (const key of [...this.timers.keys()]) this.drop(key)
    this.lifted.clear()
  }

  get pending() {
    return this.timers.size
  }

  private arm(key: string, room: string, ik: string, until: number, at: number) {
    const ms = Math.min(Math.max(0, at - this.env.now()), TIMER_MAX)
    const timer = this.env.setTimer(() => {
      this.timers.delete(key)
      if (this.env.now() < at) return this.arm(key, room, ik, until, at)
      const v = this.env.view(room)
      const due = v && dueUnbans(v, this.env.now()).some(m => m.ik === ik && m.banUntil === until)
      if (!due) return
      this.lifted.set(key, until)
      this.env.unban(room, ik)
    }, ms)
    this.timers.set(key, { until, timer })
  }

  private drop(key: string) {
    const t = this.timers.get(key)
    if (!t) return
    this.env.clearTimer(t.timer)
    this.timers.delete(key)
  }
}
