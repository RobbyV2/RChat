import { describe, expect, test } from 'bun:test'
import { ManualTime } from './helpers/test_clock'
import type { PollReq, ScheduledQuery, ScheduleReq } from '../api'
import type { AccountSession } from '../client/session'
import { hostedTarget, scheduledInitial, scheduledSlice } from '../scheduled_store'
import type { RChatState } from '../store_types'
import type { Message, ScheduledMessage, ScheduledPage, WsEvent } from '../types'

const row = (over: Partial<ScheduledMessage> = {}): ScheduledMessage => ({
  media: null,
  poll: null,
  id: 1,
  scope: 'c3',
  channel_id: 3,
  dm_id: null,
  thread_root_id: null,
  reply_to: null,
  mention_reply: true,
  content: 'later',
  at: 2000,
  next_at: 2000,
  status: 'waiting',
  error: null,
  place: { server: 'club', server_name: 'Club', channel_name: 'general', dm_user: null },
  created_at: 1,
  updated_at: 1,
  ...over,
})

const page = (items: ScheduledMessage[], next: string | null = null): ScheduledPage => ({
  items,
  next,
  waiting: items.length,
  failed: 0,
})

// A slice on a small state of alice's, with an API that answers from `answers`.
const rig = () => {
  const calls: {
    listed: ScheduledQuery[]
    created: ScheduleReq[]
    patched: [number, { resume?: boolean }][]
    uploaded: [string, string | null][]
  } = { listed: [], created: [], patched: [], uploaded: [] }
  const toasts: [string, string | undefined][] = []
  const pages: ScheduledPage[] = []
  let state = {
    me: { username: 'alice' },
    drafts: { c3: 'see you' } as Record<string, string>,
    pending: {},
    instance: null,
    panel: null,
    replying: {
      c3: { message: { id: 42 } as Message, mention: false },
    } as RChatState['replying'],
    ...scheduledInitial(),
  } as unknown as RChatState
  state = {
    ...state,
    setDraft: (key: string, text: string) => {
      state = { ...state, drafts: { ...state.drafts, [key]: text } }
    },
    cancelReply: (key: string) => {
      const { [key]: _gone, ...rest } = state.replying
      state = { ...state, replying: rest }
    },
  } as RChatState
  const api = {
    listScheduled: async (q: ScheduledQuery = {}) => {
      calls.listed.push(q)
      return pages.shift() ?? page([])
    },
    patchScheduled: async (id: number, patch: { resume?: boolean }) => {
      calls.patched.push([id, patch])
      return row({ id, status: patch.resume ? 'waiting' : 'paused' })
    },
    createScheduled: async (req: ScheduleReq) => {
      calls.created.push(req)
      return row({
        id: 9,
        content: req.content,
        at: req.at,
        reply_to: req.reply_to ?? null,
        media: req.media_id
          ? { id: req.media_id, filename: 'cat.png', spoiler: !!req.media_spoiler, alt: null }
          : null,
        poll: req.poll ?? null,
      })
    },
    uploadMedia: async (file: File, place: string | null) => {
      calls.uploaded.push([file.name, place])
      return { id: 'f00d' }
    },
  }
  const acct = {
    api,
    lifetime: { live: <T>(p: Promise<T>) => p, sessionMark: () => 1 },
    time: new ManualTime(1_000_000),
  } as unknown as AccountSession
  const slice = scheduledSlice({
    acct,
    get: () => state,
    set: partial => {
      const p = typeof partial === 'function' ? partial(state) : partial
      state = { ...state, ...p }
    },
    toast: (text, name) => toasts.push([text, name]),
    errorText: e => (e instanceof Error ? e.message : String(e)),
  })
  return {
    slice,
    calls,
    toasts,
    pages,
    get: () => state,
    set: (p: Partial<RChatState>) => {
      state = { ...state, ...p }
    },
  }
}

describe('hosted scheduled messages', () => {
  test('draft keys name their API place', () => {
    expect(hostedTarget('c3')).toEqual({ channel_id: 3 })
    expect(hostedTarget('d4')).toEqual({ dm_id: 4 })
    expect(hostedTarget('t5')).toEqual({ thread_root_id: 5 })
    expect(hostedTarget('room/ch')).toBeNull()
  })

  test('a place loads once, 50 a page with its cursor', async () => {
    const r = rig()
    r.pages.push(page([row({ id: 1 })], 'cur'), page([row({ id: 2 })]))
    await r.slice.actions.loadScheduled('c3')
    await r.slice.actions.loadScheduled('c3')
    expect(r.calls.listed).toEqual([{ scope: 'c3', after: null }])
    await r.slice.actions.loadScheduled('c3', true)
    expect(r.calls.listed[1]).toEqual({ scope: 'c3', after: 'cur' })
    expect(Object.keys(r.get().scheduled.items).sort()).toEqual(['h:1', 'h:2'])
    expect(r.get().scheduled.pages.c3).toBeNull()
    await r.slice.actions.loadScheduled('c3', true)
    expect(r.calls.listed.length).toBe(2)
  })

  test('a file being attached is uploaded for its place and goes with the row', async () => {
    const r = rig()
    const file = new File(['x'], 'cat.png', { type: 'image/png' })
    r.set({
      drafts: { c3: '' },
      replying: {},
      pending: { c3: { file, spoiler: true, mode: 'server', scope: 'c3', alt: ' a cat ' } },
    })
    expect(await r.slice.actions.scheduleDraft('c3', 2_000_000)).toBeNull()
    expect(r.calls.uploaded).toEqual([['cat.png', 'c:3']])
    const { at: _at, reply_to: _reply, mention_reply: _mention, ...sent } = r.calls.created[0]
    expect(sent).toEqual({
      channel_id: 3,
      content: '',
      media_id: 'f00d',
      media_spoiler: true,
      media_alt: 'a cat',
    })
    expect(r.get().pending).toEqual({})
    expect(r.get().scheduled.items['h:9'].files).toEqual(['cat.png'])
  })

  test('a file this device would serve is not scheduled', async () => {
    const r = rig()
    const file = new File(['x'], 'cat.png')
    r.set({ pending: { c3: { file, spoiler: false, mode: 'p2p', scope: 'c3' } } })
    expect(await r.slice.actions.scheduleDraft('c3', 2_000_000)).toBe('Not available here')
    expect(r.calls.uploaded).toEqual([])
    expect(r.calls.created).toEqual([])
  })

  test('a poll is scheduled in its place', async () => {
    const r = rig()
    const poll = { question: 'Lunch?', options: [{ text: 'Yes' }, { text: 'No' }] } as PollReq
    expect(
      await r.slice.actions.schedulePoll({ kind: 'thread', id: 7 }, poll, 2_000_000)
    ).toBeNull()
    expect(r.calls.created[0]).toEqual({ thread_root_id: 7, content: '', poll, at: 2000 })
    expect(r.get().scheduled.items['h:9'].poll).toBe('Lunch?')
    expect(r.toasts.length).toBe(1)
  })

  test('resuming a paused one asks the site and shows it waiting again', async () => {
    const r = rig()
    r.pages.push(page([row({ id: 4, status: 'paused' })]))
    await r.slice.actions.loadScheduled('')
    expect(r.get().scheduled.items['h:4'].state).toBe('paused')
    expect(await r.slice.actions.resumeScheduled('h:4')).toBeNull()
    expect(r.calls.patched).toEqual([[4, { resume: true }]])
    expect(r.get().scheduled.items['h:4'].state).toBe('waiting')
  })

  test('scheduling the draft sends it as written and clears the draft and reply', async () => {
    const r = rig()
    const error = await r.slice.actions.scheduleDraft('c3', 1_120_500, t => t.toUpperCase())
    expect(error).toBeNull()
    expect(r.calls.created).toEqual([
      {
        channel_id: 3,
        content: 'SEE YOU',
        reply_to: 42,
        mention_reply: false,
        at: 1121,
      },
    ])
    expect(r.get().drafts.c3).toBe('')
    expect(r.get().replying.c3).toBeUndefined()
    expect(r.get().scheduled.items['h:9'].body).toBe('SEE YOU')
    expect(r.toasts[0][0].startsWith('Scheduled for ')).toBe(true)
  })

  test("events apply to this account's rows only", () => {
    const r = rig()
    const mine: WsEvent = { type: 'scheduled_updated', username: 'alice', scheduled: row() }
    expect(r.slice.onEvent(mine)).toBe(true)
    expect(r.get().scheduled.items['h:1'].state).toBe('waiting')
    const theirs: WsEvent = {
      type: 'scheduled_removed',
      username: 'bob',
      id: 1,
      sent_message_id: 3,
    }
    expect(r.slice.onEvent(theirs)).toBe(true)
    expect('h:1' in r.get().scheduled.items).toBe(true)
    r.slice.onEvent({ ...theirs, username: 'alice' })
    expect(r.get().scheduled.items).toEqual({})
    expect(r.slice.onEvent({ type: 'resync' } as WsEvent)).toBe(false)
    r.slice.forget()
  })

  test('a failure toasts once, naming the place', () => {
    const r = rig()
    r.slice.onEvent({ type: 'scheduled_updated', username: 'alice', scheduled: row() })
    const failed: WsEvent = {
      type: 'scheduled_updated',
      username: 'alice',
      scheduled: row({ status: 'failed', error: 'Gone', place: null, updated_at: 5 }),
    }
    r.slice.onEvent(failed)
    r.slice.onEvent(failed)
    expect(r.toasts).toEqual([["Couldn't send a scheduled message", '#general']])
    r.slice.forget()
  })
})
