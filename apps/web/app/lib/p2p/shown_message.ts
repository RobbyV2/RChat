import { readFwdSrc } from './content'
import type { P2pMessage } from './dm'
import { plainLine } from '../replies'
import type { CallLog, Message, UserRef } from '../types'

// Shared message components key rows by a number that grows in display order (jumps and the
// unread line rely on it): display time in ms times 1000, plus a counter for ties.
export const numbering = (list: P2pMessage[]) => {
  const num = new Map<string, number>()
  let last = 0
  for (const m of list) {
    const n = Math.max(m.ts * 1000, last + 1)
    num.set(m.id, n)
    last = n
  }
  return num
}

const seconds = (ms: number) => Math.floor(ms / 1000)

// A call row of a P2P conversation as the shared call row reads it: the caller is the sender,
// and only its outcome and length are known.
export const callLogOf = (p: P2pMessage): CallLog | null => {
  const c = p.call
  if (!c) return null
  const end = seconds(p.ts)
  const ended = c.outcome === 'ended'
  return {
    from: p.sender,
    answered_at: ended ? end - (c.dur ?? 0) : null,
    ended_at: end,
    outcome: c.outcome === 'ended' ? 'completed' : c.outcome,
    p2p: true,
    video: c.video,
  }
}

export const asMessage = (
  m: P2pMessage,
  num: number,
  replyNum: number,
  user: (ik: string) => UserRef,
  me: string
): Message => ({
  id: num,
  channel_id: null,
  dm_id: null,
  thread_root_id: null,
  author: user(m.sender),
  content: m.unavailable ? '_Message unavailable_' : m.fwd ? m.fwd.body : m.body,
  created_at: seconds(m.ts),
  reply_count: m.replies ?? 0,
  media: null,
  embeds: [],
  kind: m.system ? m.system.kind : m.call ? 'call' : 'user',
  call: callLogOf(m),
  reactions: m.reactions.map(r => ({
    emoji: r.key,
    count: r.count,
    me: r.me,
    first_at: seconds(r.first),
  })),
  reply_to: m.reply
    ? {
        id: replyNum,
        author: m.reply.sender ? user(m.reply.sender) : null,
        content: m.reply.body === null ? '' : plainLine(m.reply.body),
        has_media: false,
        deleted: m.reply.body === null,
        mention: m.reply.sender === me && m.sender !== me,
      }
    : null,
  edited_at: m.edited !== null ? seconds(m.edited) : null,
  forward: m.fwd
    ? {
        author: {
          username: m.fwd.name,
          display_name: m.fwd.name,
          avatar_kind: 'color',
          avatar_color: null,
        },
        created_at: seconds(m.fwd.ts),
        source_id: 0,
        origin: null,
        dropped: null,
        p2p: readFwdSrc(m.fwd),
      }
    : null,
  pinned_at: m.pinned !== null ? seconds(m.pinned) : null,
})

// The number of a message outside the list that numbers its rows.
export const looseNumber = (m: P2pMessage) => Math.max(1, m.ts * 1000)
