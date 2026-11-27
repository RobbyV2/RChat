import type { AccountSession } from './client/session'
// The store's poll actions and the `poll_updated` event, kept apart from store.ts.

import type { PollReq } from './api'

import { mergePoll } from './polls'

import type { RChatState } from './store_types'
import type { Message, Poll, WsEvent } from './types'
import type { Cancel } from './clock'

// Where a new poll goes.
export type PollTarget =
  { kind: 'channel'; id: number } | { kind: 'dm'; id: number } | { kind: 'thread'; id: number }

export interface PollsDeps {
  acct: AccountSession
  get: () => RChatState
  act: (fn: () => Promise<void>) => Promise<void>
  // Patches the message wherever the store holds it (lists, thread root).
  patch: (id: number, fn: (m: Message) => Message) => void
  find: (id: number) => Message | undefined
  errorText: (e: unknown) => string
}

// After a vote from another tab the poll is fetched once, this long after the last such vote.
// Live counts of after-vote polls reach voters in their own `poll_updated`, so updates never
// trigger a fetch.
export const POLL_FETCH_MS = 1000

export const pollsSlice = (d: PollsDeps) => {
  const { acct } = d
  const api = acct.api
  const { live, sessionMark } = acct.lifetime
  const { act, patch } = d
  const setPoll = (id: number, poll: Poll) =>
    patch(id, m => (m.kind === 'poll' ? { ...m, poll } : m))
  const waiting = new Map<number, Cancel>()
  const fetchSoon = (id: number) => {
    if (waiting.has(id)) return
    waiting.set(
      id,
      acct.time.after(POLL_FETCH_MS, () => {
        waiting.delete(id)
        const at = sessionMark()
        api.poll(id).then(
          poll => {
            if (at === sessionMark()) setPoll(id, poll)
          },
          () => {}
        )
      })
    )
  }
  const run = (id: number, call: () => Promise<Poll>) =>
    act(async () => setPoll(id, await live(call())))

  const actions = {
    createPoll: async (target: PollTarget, req: PollReq): Promise<string | null> => {
      try {
        const opts = { poll: req }
        if (target.kind === 'channel') await api.sendChannelMessage(target.id, '', opts)
        else if (target.kind === 'dm') await api.sendDmMessage(target.id, '', opts)
        else await api.sendThreadMessage(target.id, '', opts)
        return null
      } catch (e) {
        return d.errorText(e)
      }
    },
    votePoll: (id: number, body: { options?: number[]; value?: number }) =>
      run(id, () => api.vote(id, body)),
    retractVote: (id: number) => run(id, () => api.retractVote(id)),
    addPollOption: async (id: number, text: string, emoji: string | null) => {
      try {
        setPoll(id, await live(api.addPollOption(id, text, emoji)))
        return null
      } catch (e) {
        return d.errorText(e)
      }
    },
    closePoll: (id: number) => run(id, () => api.closePoll(id)),
    reopenPoll: (id: number) => run(id, () => api.reopenPoll(id)),
  }

  const onEvent = (ev: WsEvent): boolean => {
    if (ev.type === 'poll_voted') {
      if (ev.username === d.get().me?.username && d.find(ev.message_id)) fetchSoon(ev.message_id)
      return true
    }
    if (ev.type !== 'poll_updated') return false
    setPoll(ev.message_id, mergePoll(d.find(ev.message_id)?.poll, ev.poll))
    return true
  }

  // The refetches the ended session asked for are never sent.
  const forget = () => {
    for (const timer of waiting.values()) timer?.()
    waiting.clear()
  }

  return { actions, onEvent, forget }
}
