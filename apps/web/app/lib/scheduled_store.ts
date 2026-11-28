import { background } from './api_errors'
import { ownLoad } from './own_loads'
import type { AccountSession } from './client/session'
// The store's hosted scheduled messages: the list the instance keeps for this account, its
// actions and the `scheduled_updated` and `scheduled_removed` events, kept apart from store.ts.

import type { ScheduleReq } from './api'
import type { Cancel } from './clock'
import {
  applyHosted,
  fromHosted,
  hostedKey,
  type ScheduledItem,
  type ScheduledLabel,
  whenText,
} from './scheduled'
import type { RChatState } from './store_types'
import type { ScheduledPage, WsEvent } from './types'

type SetState = (partial: Partial<RChatState> | ((s: RChatState) => Partial<RChatState>)) => void

export interface ScheduledDeps {
  acct: AccountSession
  set: SetState
  get: () => RChatState
  toast: (text: string, name?: string) => void
  errorText: (e: unknown) => string
}

export interface HostedScheduled {
  items: Record<string, ScheduledItem>
  // The pages loaded, by scope ('' for the whole account): the cursor of the next one, null at
  // the end.
  pages: Record<string, string | null>
  // Waiting and failed across the account; null until loaded.
  counts: { waiting: number; failed: number } | null
}

export const scheduledInitial = () => ({
  scheduled: { items: {}, pages: {}, counts: null } as HostedScheduled,
})

// The API place of a hosted draft key: `c<channel>`, `d<dm>` or `t<root>`.
export const hostedTarget = (
  key: string
): Pick<ScheduleReq, 'channel_id' | 'dm_id' | 'thread_root_id'> | null => {
  const m = /^([cdt])(\d+)$/.exec(key)
  if (!m) return null
  const id = Number(m[2])
  return m[1] === 'c' ? { channel_id: id } : m[1] === 'd' ? { dm_id: id } : { thread_root_id: id }
}

const idOf = (key: string) => Number(key.slice(2))

// The place a hosted draft key names in this store, for a toast.
const placeName = (s: RChatState, label: ScheduledLabel | null) => {
  if (!label) return undefined
  if (label.person) return label.person
  return label.channel ? `#${label.channel}` : undefined
}

export const scheduledSlice = (d: ScheduledDeps) => {
  const { acct, set, get } = d
  const api = acct.api
  const { live, sessionMark } = acct.lifetime
  const toasted = new Set<string>()
  let recount: Cancel | null = null

  const mine = (username: string) => get().me?.username === username
  const patch = (fn: (s: HostedScheduled) => HostedScheduled) =>
    set(s => ({ scheduled: fn(s.scheduled) }))

  const take = (page: ScheduledPage, scope: string) =>
    patch(s => ({
      items: {
        ...s.items,
        ...Object.fromEntries(page.items.map(r => [hostedKey(r.id), fromHosted(r)])),
      },
      pages: { ...s.pages, [scope]: page.next },
      counts: scope === '' ? { waiting: page.waiting, failed: page.failed } : s.counts,
    }))

  const loadSummary = async () => {
    const at = sessionMark()
    const load = ownLoad(set, 'scheduled_counts')
    try {
      const page = await live(api.listScheduled({ limit: 1 }))
      if (at !== sessionMark()) return
      patch(s => ({ ...s, counts: { waiting: page.waiting, failed: page.failed } }))
      load.came()
    } catch (e) {
      // The counts stay unknown, and the scheduled messages dialog says so.
      background('loading scheduled counts failed')(e)
      if (at === sessionMark()) load.refused(e)
    }
  }

  const recountSoon = () => {
    if (recount) return
    recount = acct.time.after(250, () => {
      recount = null
      void loadSummary()
    })
  }

  const run = async (call: () => Promise<unknown>): Promise<string | null> => {
    try {
      await live(call())
      return null
    } catch (e) {
      return d.errorText(e)
    }
  }

  const actions = {
    // The scope's first page, or the next one with `more`.
    loadScheduled: async (scope = '', more = false) => {
      const at = sessionMark()
      const pages = get().scheduled.pages
      if (more ? !pages[scope] : scope in pages) return
      const load = ownLoad(set, `scheduled:${scope}`)
      try {
        const page = await live(
          api.listScheduled({ scope: scope || undefined, after: more ? pages[scope] : null })
        )
        if (at !== sessionMark()) return
        take(page, scope)
        load.came()
      } catch (e) {
        background('loading scheduled messages failed')(e)
        if (at === sessionMark()) load.refused(e)
      }
    },
    loadScheduledCounts: () => loadSummary(),
    // Schedules the draft at `key` as written (through `shape`), at `at` (ms): the draft and the
    // reply bar clear.
    scheduleDraft: async (
      key: string,
      at: number,
      shape: (text: string) => string = t => t
    ): Promise<string | null> => {
      const place = hostedTarget(key)
      const s = get()
      const raw = s.drafts[key] ?? ''
      const content = shape(raw)
      const reply = s.replying[key]
      if (!place) return 'Not available here'
      try {
        const row = await live(
          api.createScheduled({
            ...place,
            content,
            reply_to: reply?.message.id,
            mention_reply: reply ? reply.mention : undefined,
            at: Math.ceil(at / 1000),
          })
        )
        patch(h => ({ ...h, items: { ...h.items, [hostedKey(row.id)]: fromHosted(row) } }))
        if ((get().drafts[key] ?? '') === raw) get().setDraft(key, '')
        if (get().replying[key] === reply) get().cancelReply(key)
        d.toast(`Scheduled for ${whenText(at, acct.time.now())}`)
        return null
      } catch (e) {
        return d.errorText(e)
      }
    },
    editScheduled: (key: string, content: string) =>
      run(async () => {
        const row = await api.patchScheduled(idOf(key), { content })
        patch(h => ({ ...h, items: { ...h.items, [key]: keepLabel(h.items[key], row) } }))
      }),
    removeScheduledReply: (key: string) =>
      run(async () => {
        const row = await api.patchScheduled(idOf(key), { remove_reply: true })
        patch(h => ({ ...h, items: { ...h.items, [key]: keepLabel(h.items[key], row) } }))
      }),
    rescheduleScheduled: (key: string, at: number) =>
      run(async () => {
        const row = await api.patchScheduled(idOf(key), { at: Math.ceil(at / 1000) })
        patch(h => ({ ...h, items: { ...h.items, [key]: keepLabel(h.items[key], row) } }))
      }),
    resumeScheduled: (key: string) =>
      run(async () => {
        const row = await api.patchScheduled(idOf(key), { resume: true })
        patch(h => ({ ...h, items: { ...h.items, [key]: keepLabel(h.items[key], row) } }))
        recountSoon()
      }),
    sendScheduledNow: (key: string) =>
      run(async () => {
        await api.sendScheduled(idOf(key))
        dropItem(key)
      }),
    deleteScheduled: (key: string) =>
      run(async () => {
        await api.deleteScheduled(idOf(key))
        dropItem(key)
      }),
  }

  const keepLabel = (was: ScheduledItem | undefined, row: Parameters<typeof fromHosted>[0]) => {
    const item = fromHosted(row)
    return { ...item, label: item.label ?? was?.label ?? null }
  }

  const dropItem = (key: string) =>
    patch(h => {
      if (!(key in h.items)) return h
      const { [key]: _gone, ...items } = h.items
      return { ...h, items }
    })

  const onEvent = (ev: WsEvent): boolean => {
    if (ev.type !== 'scheduled_updated' && ev.type !== 'scheduled_removed') return false
    if (!mine(ev.username)) return true
    const before = get().scheduled.items
    const items = applyHosted(before, ev)
    patch(h => ({ ...h, items }))
    if (ev.type === 'scheduled_updated' && ev.scheduled.status === 'failed') {
      const key = hostedKey(ev.scheduled.id)
      const stamp = `${key}:${ev.scheduled.updated_at}`
      if (before[key]?.state !== 'failed' && !toasted.has(stamp)) {
        toasted.add(stamp)
        d.toast("Couldn't send a scheduled message", placeName(get(), items[key]?.label ?? null))
      }
    }
    recountSoon()
    return true
  }

  // After a resync: the counts again, and each place's page when it is next shown.
  const reload = () => {
    patch(h => ({ ...h, pages: {} }))
    void loadSummary()
  }

  // The recount the ended session asked for is never sent.
  const forget = () => {
    recount?.()
    recount = null
    toasted.clear()
  }

  return { actions, onEvent, loadSummary, reload, forget }
}
