import type { P2pMessage } from './p2p/dm'
import type { Outgoing } from './store_types'
import { isNotice } from './system_messages'
import type { Message } from './types'
import { isWebhookMessage } from './webhooks'

// Seconds after the previous message during which the same author's next one joins its group.
export const GROUP_WINDOW = 7 * 60

// What grouping needs to know about one row of a message list.
export interface GroupCue {
  // Who posted it: the account, or a hook together with the name and avatar it posted under.
  who: string
  // Unix seconds.
  at: number
  // Shows its own header whatever is above it: a reply, a forwarded card, a failed send.
  head: boolean
  // The row below shows its own header: a system line, a call, a failed send.
  end: boolean
}

// Where a row sits in its group: the first one shows the avatar, name and time.
export interface GroupPlace {
  first: boolean
  last: boolean
}

const dayOf = (seconds: number) => new Date(seconds * 1000).toDateString()

export const continues = (prev: GroupCue | undefined, cur: GroupCue) =>
  prev !== undefined &&
  !prev.end &&
  !cur.head &&
  prev.who === cur.who &&
  Math.abs(cur.at - prev.at) <= GROUP_WINDOW &&
  dayOf(prev.at) === dayOf(cur.at)

// `breaks` holds the rows with a separator above them (the new messages line, a gap).
export function groupPlaces(
  cues: readonly GroupCue[],
  breaks: ReadonlySet<number> = new Set()
): GroupPlace[] {
  const joins = cues.map((cue, i) => i > 0 && !breaks.has(i) && continues(cues[i - 1], cue))
  return cues.map((_, i) => ({ first: !joins[i], last: !joins[i + 1] }))
}

const identity = (m: Message) => {
  const { username, display_name, avatar_kind, avatar_color } = m.author
  return isWebhookMessage(m)
    ? [username, display_name, avatar_kind, avatar_color ?? ''].join('\n')
    : username
}

export const messageCue = (m: Message): GroupCue => {
  const alone = isNotice(m) || m.kind === 'call'
  return {
    who: identity(m),
    at: m.created_at,
    head: alone || !!m.reply_to || !!m.forward,
    end: alone,
  }
}

// A send on its way groups as the sent message will; a failed one stands alone with its status.
export const outgoingCue = (o: Pick<Outgoing, 'msg' | 'status'>): GroupCue => {
  const cue = messageCue(o.msg)
  const failed = o.status === 'failed'
  return { ...cue, head: cue.head || failed, end: cue.end || failed }
}

// The places of a list's messages, then of the sends on their way below them.
export const messagePlaces = (
  messages: readonly Message[],
  breaks?: ReadonlySet<number>,
  outgoing: readonly Pick<Outgoing, 'msg' | 'status'>[] = []
) => groupPlaces([...messages.map(messageCue), ...outgoing.map(outgoingCue)], breaks)

export const p2pCue = (p: P2pMessage): GroupCue => {
  const alone = !!p.system || !!p.call || !!p.removed || !!p.slowHidden || p.failed
  return {
    who: p.sender,
    at: p.ts / 1000,
    head: alone || p.late || !!p.reply || !!p.fwd,
    end: alone,
  }
}
