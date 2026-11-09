// Messages and DMs: the loaded windows with their tails and heads, live appends, quotes and
// edits, pins, link cards, the outbox, embeds, P2P availability and the DM list.

import { ApiError, type PageOpts, type SendOpts } from '../api'
import {
  type PendingUpload,
  type UploadMode,
  attachModes,
  p2pIdTaken,
  startMode,
} from '../attachments'
import { accountPrompt } from '../features'
import { type ForwardClip, canForward, clipOf, forwardPending } from '../forward'
import { dropGroupMessage } from '../group_pings'
import { limitsOf, tooLargeText } from '../instance_limits'
import { api, home, writeLocal } from '../instances'
import { staleInvites } from '../invite'
import {
  type OlderState,
  type Page,
  appendUnique,
  bumpFront,
  createPager,
  keyed,
  windowEdges,
} from '../lists'
import { mentionsUser } from '../mentions'
import { type Layout, noteSelfPin, unpinDm as unpinIn } from '../nav_layout'
import type { AlertInput } from '../notices'
import { messageAlert, scopeOfKey } from '../notify'
import { newP2pId, p2p } from '../p2p'
import { unlinkPin, withPinnedAt, withoutPin } from '../pins'
import { mergePoll } from '../polls'
import { canAddEmoji, emojiBase, reacted, reactorKey, withReaction } from '../reactions'
import { relayBook } from '../relays'
import {
  type Replying,
  editedQuote,
  fetchedQuote,
  fillQuote,
  parseReplyMention,
  quoteDeleted,
  quoteEdited,
  quoteOf,
  repliesToMe,
  replyMentionKey,
  replyMentionValue,
  sendReply,
} from '../replies'
import { charCount } from '../rules'
import { nameWithUsername } from '../display_name'
import { SEARCH_PAGE, SEARCH_TRIES, addSearchPage, searchParams } from '../search'
import { type Sed, applySed, lastEditable } from '../sed'
import { myPerms, scopeRule } from '../selectors'
import { hashBlob } from '../sha256'
import { slowExempt, slowWait } from '../slowmode'
import type { Focus, Outgoing, OutgoingStatus, RChatState } from '../store_types'
import { isSystem, systemText } from '../system_messages'
import type {
  BlockedUser,
  DmSummary,
  EditStub,
  Embed,
  Me,
  Message,
  MessageLocation,
  ReplyRef,
  SearchResult,
  UserRef,
  WsEvent,
} from '../types'
import { type Nav, type View, threadKey, viewKey } from '../view'
import {
  WINDOW_MAX,
  createLru,
  findById,
  indexOfId,
  mergeSorted,
  patchById,
  trimWindow,
} from '../window'
import {
  type GetState,
  type Handlers,
  LIST_MAX,
  PAGE,
  type SetState,
  pageVisible,
  settled,
} from './ctx'

export interface MessagesDeps {
  act: (fn: () => Promise<void>) => Promise<void>
  alertUser: (alert: AlertInput) => void
  banCheck: (e: unknown, server: string | null | undefined) => unknown
  clearAnchor: (key: string) => void
  clearView: (nav?: Nav) => void
  confirmDeleteMessage: (id: number, now?: boolean) => void
  epochs: Record<string, number>
  fail: (e: unknown) => void
  groupAlert: (m: Message, server: string) => boolean
  lateAnchor: Set<string>
  noteBlocked: (b: BlockedUser) => void
  noteTyper: (scope: string, username: string, name: string, on: boolean) => void
  noteUnblocked: (name: string) => void
  openChannelAt: (
    server: string,
    channelId: number,
    threadRootId: number | null,
    id: number,
    nav?: Nav
  ) => Promise<void>
  persistGuestServers: (list: string[]) => void
  pinSelf: () => void
  readsHub: { more: () => boolean }
  sameUser: (username: string) => boolean
  saveForward: (clip: ForwardClip | null) => void
  saveLayout: (next: Layout) => void
  selfDmId: () => number | undefined
  toast: (text: string, name?: string) => void
}

const byId = (a: Message, b: Message) => a.id - b.id
export const dmKey = (d: DmSummary) => d.id
export const isSelfDm = (d: DmSummary) => d.is_self

const merge = mergeSorted<Message>

// Ids of optimistic messages, far above any real id.
export const OPT_BASE = 1e15
let optSeq = 0
const nextTempId = () => OPT_BASE + ++optSeq
const draining = new Set<string>()

const pendingEmbeds = new Map<number, Embed[]>()
const reactorCache = new Map<string, Promise<UserRef[]>>()
const reactionQueue = new Map<string, Promise<void>>()
const REACTOR_CACHE = 200
const PENDING_EMBEDS_MAX = 256
const VIEW_CACHE = 8
const DETACH_AT = WINDOW_MAX * 2
const rememberEmbeds = (id: number, embeds: Embed[]) => {
  pendingEmbeds.delete(id)
  pendingEmbeds.set(id, embeds)
  if (pendingEmbeds.size > PENDING_EMBEDS_MAX)
    pendingEmbeds.delete(pendingEmbeds.keys().next().value as number)
}
export const applyEmbeds = (list: Message[]) =>
  pendingEmbeds.size === 0
    ? list
    : list.map(m => {
        const e = pendingEmbeds.get(m.id)
        return e && e !== m.embeds ? { ...m, embeds: e } : m
      })

const mapLists = (
  messages: Record<string, Message[]>,
  fn: (list: Message[], key: string) => Message[]
) => {
  let out: Record<string, Message[]> | null = null
  for (const [key, list] of Object.entries(messages)) {
    const next = fn(list, key)
    if (next === list) continue
    out ??= { ...messages }
    out[key] = next
  }
  return out ?? messages
}

// The lists with message `id` patched by `fn`.
export const patchMessages = (
  s: RChatState,
  id: number,
  fn: (m: Message) => Message
): Partial<RChatState> => {
  const messages = mapLists(s.messages, list => patchById(list, id, fn))
  return messages === s.messages ? {} : { messages }
}

// A newer copy of a message replaces the shown one and keeps its reactions and poll votes.
export const updatedRow =
  (next: Message) =>
  (x: Message): Message => ({
    ...next,
    reactions: x.reactions,
    poll: next.poll && x.poll ? mergePoll(x.poll, next.poll) : next.poll,
  })

// A list without message `id`; with `rootOf`, its thread root counts one reply less.
const dropRow = (id: number, rootOf: number | null) => (list: Message[]) => {
  const i = indexOfId(list, id)
  const cut = unlinkPin(
    quoteDeleted(i === -1 ? list : [...list.slice(0, i), ...list.slice(i + 1)], id),
    id
  )
  return rootOf === null
    ? cut
    : patchById(cut, rootOf, m => ({
        ...m,
        reply_count: Math.max(0, m.reply_count - 1),
      }))
}

// The lists, open thread, replies and edit without message `id`.
export const dropDeletedIn = (
  s: RChatState,
  id: number,
  rootOf: number | null
): Partial<RChatState> => {
  const drop = dropRow(id, rootOf)
  const kept = { ...s.messages }
  delete kept[threadKey(id)]
  const messages = mapLists(kept, drop)
  const panel =
    s.panel?.kind === 'thread' && s.panel.root.id === id
      ? null
      : s.panel?.kind === 'thread' && s.panel.root.id === rootOf
        ? {
            ...s.panel,
            root: {
              ...s.panel.root,
              reply_count: Math.max(0, s.panel.root.reply_count - 1),
            },
          }
        : s.panel
  const replying = Object.fromEntries(
    Object.entries(s.replying).filter(([key, r]) => r.message.id !== id && key !== threadKey(id))
  )
  return {
    messages,
    panel:
      panel?.kind === 'thread' && panel.root.reply_to?.id === id
        ? { ...panel, root: quoteDeleted([panel.root], id)[0] }
        : panel,
    ...(Object.keys(replying).length === Object.keys(s.replying).length ? {} : { replying }),
    ...(s.editing && (s.editing.id === id || s.editing.key === threadKey(id))
      ? { editing: null }
      : {}),
  }
}

export const messagesSlice = (set: SetState, get: GetState, deps: MessagesDeps) => {
  const {
    act,
    alertUser,
    banCheck,
    clearAnchor,
    clearView,
    confirmDeleteMessage,
    epochs,
    fail,
    groupAlert,
    lateAnchor,
    noteBlocked,
    noteTyper,
    noteUnblocked,
    openChannelAt,
    persistGuestServers,
    pinSelf,
    readsHub,
    sameUser,
    saveForward,
    saveLayout,
    selfDmId,
    toast,
  } = deps

  const dmPager = createPager<DmSummary>({
    read: () => get().dms,
    write: (dms, dmsMore) => {
      set({ dms, dmsMore })
      pinSelf()
    },
    fetchPage: api.listDms,
    keyOf: dmKey,
    page: PAGE,
  })

  let dmGen = 0
  // DMs this account closed that a lookup by id returned, so their settings are kept.
  const closedDms = new Map<number, DmSummary>()

  const historyGen = new Map<string, number>()
  let historySeq = 0
  const newHistory = (key: string) => historyGen.set(key, ++historySeq)

  const askP2p = (msgs: Message[]) => {
    const known = get().p2pAvailability
    const hosters = [
      ...new Set(
        msgs.flatMap(m =>
          m.media?.kind === 'p2p' &&
          m.media.hoster !== null &&
          !Object.hasOwn(known, m.media.hoster)
            ? [m.media.hoster]
            : []
        )
      ),
    ]
    if (hosters.length) home.ws.sendVoice({ type: 'p2p_who', hosters })
  }

  const forgetPending = (keep: (key: string, upload: PendingUpload) => boolean) =>
    set(s => {
      const entries = Object.entries(s.pending)
      const kept = entries.filter(([key, upload]) => keep(key, upload))
      return kept.length === entries.length ? {} : { pending: Object.fromEntries(kept) }
    })

  // An edit in a channel that is gone for good can never be saved; an evicted view keeps it.
  const dropEditIn = (scopes: Set<string>) => {
    const ed = get().editing
    const channel = ed && findMessage(ed.id)?.channel_id
    if (ed && (scopes.has(ed.key) || (channel && scopes.has(`c${channel}`)))) set({ editing: null })
  }

  const messageKey = (channel_id: number | null, dm_id: number | null) => {
    if (channel_id !== null) return `c${channel_id}`
    if (dm_id !== null) return `d${dm_id}`
    return null
  }

  const TAIL_MAX = 200
  const tails = new Map<string, Message[]>()
  const holdTail = (key: string, m: Message) =>
    tails.set(key, merge(tails.get(key) ?? [], [m]).slice(-TAIL_MAX))
  const takeTail = (key: string, after: number) => {
    const held = tails.get(key) ?? []
    tails.delete(key)
    return held.filter(m => m.id > after)
  }
  const heads = new Map<string, number>()
  const loadingHead = (key: string) => (heads.get(key) ?? 0) > 0
  const holding = (key: string) => detached(key) || loadingHead(key)
  const headLoad = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    heads.set(key, (heads.get(key) ?? 0) + 1)
    if (get().messages[key]?.length) set(s => ({ stale: { ...s.stale, [key]: true } }))
    try {
      return await run()
    } catch (e) {
      if (heads.get(key) === 1) {
        const caught = detached(key) ? [] : takeTail(key, 0)
        set(s => ({
          messages:
            caught.length && s.messages[key]
              ? { ...s.messages, [key]: applyEmbeds(merge(s.messages[key], caught)) }
              : s.messages,
          stale: keyed(s.stale, key, null),
        }))
      }
      throw e
    } finally {
      const left = (heads.get(key) ?? 1) - 1
      if (left > 0) heads.set(key, left)
      else heads.delete(key)
    }
  }
  const mapTails = (fn: (list: Message[]) => Message[]) => {
    for (const [key, list] of tails) {
      const next = fn(list)
      if (next !== list) tails.set(key, next)
    }
  }

  const patchMessage = (id: number, fn: (m: Message) => Message) => {
    const patch = (list: Message[]) => patchById(list, id, fn)
    mapTails(patch)
    set(s => patchMessages(s, id, fn))
  }

  const findMessage = (id: number) => {
    const { messages, panel } = get()
    for (const list of Object.values(messages)) {
      const m = findById(list, id)
      if (m) return m
    }
    return panel?.kind === 'thread' && panel.root.id === id ? panel.root : undefined
  }

  const patchReactions = (id: number, fn: (m: Message) => Message) => {
    patchMessage(id, fn)
    set(s =>
      s.panel?.kind === 'thread' && s.panel.root.id === id
        ? { panel: { ...s.panel, root: fn(s.panel.root) } }
        : {}
    )
  }

  const forgetReactors = (key: string) => void reactorCache.delete(key)

  // The pins window reads through the gated list, so it only shows what the viewer may read.
  let pinsGen = 0
  const loadPins = (key: string) => {
    pinsGen += 1
    const gen = pinsGen
    const id = Number(key.slice(1))
    const current = () => gen === pinsGen && get().pins?.key === key
    ;(key[0] === 'd' ? api.dmPins(id) : api.channelPins(id)).then(
      list => {
        if (!current()) return
        askP2p(list)
        set({ pins: { key, list, failed: false } })
      },
      () => {
        if (current()) set(s => (s.pins ? { pins: { ...s.pins, failed: true } } : {}))
      }
    )
  }

  const setPinned = (id: number, at: number | null) => {
    patchReactions(id, m => withPinnedAt(m, at))
    if (at === null)
      set(s =>
        s.pins?.list && s.pins.list.some(m => m.id === id)
          ? { pins: { ...s.pins, list: withoutPin(s.pins.list, id) } }
          : {}
      )
  }

  const refreshPins = (id: number) => {
    const pins = get().pins
    if (pins?.list?.some(m => m.id === id)) loadPins(pins.key)
  }

  const quotes = new Map<number, ReplyRef>()
  const quoteReads = new Set<number>()
  let quoteGen = 0

  const held = (id: number) =>
    findMessage(id) ?? [...tails.values()].map(list => findById(list, id)).find(Boolean)

  // A message or its attachment went away: stop serving our file and drop downloaded copies,
  // whether or not the message is loaded here.
  const unhost = (id: number) => {
    const media = held(id)?.media
    const me = get().me?.username
    if (media?.kind === 'p2p' && me !== undefined && media.hoster === me) p2p.removeFile(media.id)
    p2p.forgetMessage(id)
  }

  const readQuote = (m: Message) => {
    const ref = m.reply_to
    if (!ref?.partial || quoteReads.has(m.id) || !held(m.id)) return
    quoteReads.add(m.id)
    const gen = quoteGen
    const page = { around: m.id, limit: 1 }
    const read =
      m.thread_root_id !== null
        ? api.threadMessages(m.thread_root_id, page)
        : m.channel_id !== null
          ? api.channelMessages(m.channel_id, page)
          : m.dm_id !== null
            ? api.dmMessages(m.dm_id, page)
            : null
    if (!read) return
    read
      .then(list => {
        if (gen !== quoteGen) return
        const quote = fetchedQuote(list, m.id, ref)
        quotes.set(m.id, quote)
        patchReactions(m.id, x => (x.reply_to?.partial ? { ...x, reply_to: quote } : x))
      })
      .catch(() => {})
      .finally(() => {
        if (gen === quoteGen) quoteReads.delete(m.id)
      })
  }

  const withQuote = (m: Message): Message => {
    if (!m.reply_to?.partial) return m
    const own = findMessage(m.id)?.reply_to
    const known = own && !own.partial ? own : quotes.get(m.id)
    return fillQuote(m, known, findMessage(m.reply_to.id)) ?? m
  }

  // Does anything shown quote message `id` (a reply's quote we may refresh)?
  const quoted = (id: number) => {
    const quotes_ = (list: Message[]) =>
      list.some(m => m.reply_to?.id === id && !m.reply_to.deleted)
    const { messages, panel } = get()
    return (
      Object.values(messages).some(quotes_) ||
      [...tails.values()].some(quotes_) ||
      [...quotes.values()].some(q => q.id === id && !q.deleted) ||
      (panel?.kind === 'thread' && panel.root.reply_to?.id === id)
    )
  }

  // An edit in a server channel arrives as a stub without content: whoever shows the message
  // (or a quote of it) re-reads it through the list, which applies the read-history rules.
  const rereads = new Map<number, boolean>()
  const rereadEdited = (ev: EditStub) => {
    const { id, channel_id } = ev
    const root = ev.thread_root_id ?? null
    if (!held(id) && !quoted(id)) return
    if (rereads.has(id)) {
      rereads.set(id, true)
      return
    }
    rereads.set(id, false)
    const gen = quoteGen
    const page = { around: id, limit: 1 }
    const read =
      root !== null ? api.threadMessages(root, page) : api.channelMessages(channel_id, page)
    read
      .then(list => {
        if (gen !== quoteGen) return
        const m = list.find(x => x.id === id)
        if (m) applyUpdated(m)
      })
      .catch(() => {})
      .finally(() => {
        if (gen !== quoteGen) return
        const again = rereads.get(id)
        rereads.delete(id)
        if (again) rereadEdited(ev)
      })
  }

  // A newer copy of a message (an edit, a call log update): replaces the shown one but keeps
  // its reactions, and quotes of it take the new text.
  const applyUpdated = (m: Message) => {
    const next = withQuote(m)
    patchReactions(next.id, updatedRow(next))
    readQuote(next)
    for (const [id, q] of quotes) {
      const e = editedQuote(q, next)
      if (e !== q) quotes.set(id, e)
    }
    mapTails(list => quoteEdited(list, next))
    set(s => {
      const messages = mapLists(s.messages, list => quoteEdited(list, next))
      const root = s.panel?.kind === 'thread' ? s.panel.root : null
      const rootQuote = root?.reply_to ? editedQuote(root.reply_to, next) : undefined
      const replying = Object.entries(s.replying).some(([, r]) => r.message.id === next.id)
        ? Object.fromEntries(
            Object.entries(s.replying).map(([k, r]) => [
              k,
              r.message.id === next.id
                ? { ...r, message: { ...next, reactions: r.message.reactions } }
                : r,
            ])
          )
        : s.replying
      return {
        ...(messages === s.messages ? {} : { messages }),
        ...(root && rootQuote !== root.reply_to
          ? { panel: { kind: 'thread' as const, root: { ...root, reply_to: rootQuote } } }
          : {}),
        ...(replying === s.replying ? {} : { replying }),
      }
    })
  }

  // The message Up and `s/` edit from the composer of `key`: your newest one there.
  const editTarget = (key: string) => {
    const { messages, panel, me } = get()
    const root =
      panel?.kind === 'thread' && threadKey(panel.root.id) === key
        ? (findMessage(panel.root.id) ?? panel.root)
        : null
    return lastEditable(messages[key] ?? [], me?.username, root)
  }

  // A message still showing its attachment (not removed or expired) may have no text.
  const attached = (m: Message) => !!m.media && !m.media.removed

  // Resolves with the sent message once the outgoing `tempId` is delivered, or `null` when it
  // fails or is cancelled.
  const sentWaiters = new Map<number, ((m: Message | null) => void)[]>()
  const settleSent = (tempId: number, m: Message | null) => {
    const waiting = sentWaiters.get(tempId)
    sentWaiters.delete(tempId)
    for (const w of waiting ?? []) w(m)
  }
  const sentAs = (tempId: number) =>
    new Promise<Message | null>(resolve => {
      sentWaiters.set(tempId, [...(sentWaiters.get(tempId) ?? []), resolve])
    })

  const sedOn = async (m: Message, sed: Sed) => {
    const next = applySed(m.content, sed)
    if (next === null) {
      fail(new Error('No match in your last message'))
      return false
    }
    if (next === m.content) return true
    if (!next.trim() && !attached(m)) {
      confirmDeleteMessage(m.id)
      return true
    }
    try {
      applyUpdated(await api.editMessage(m.id, next))
      return true
    } catch (e) {
      fail(e)
      return false
    }
  }

  const liveKey = (key: string) => {
    const { view, panel } = get()
    return (
      (view !== null && viewKey(view) === key) ||
      (panel?.kind === 'thread' && threadKey(panel.root.id) === key)
    )
  }

  const views = createLru<string>(VIEW_CACHE, liveKey)

  const forgetViews = (keys: string[]) => {
    if (!keys.length) return
    for (const key of keys) {
      tails.delete(key)
      heads.delete(key)
      historyGen.delete(key)
      lateAnchor.delete(key)
      views.delete(key)
    }
    const without = <T>(map: Record<string, T>) => {
      if (!keys.some(k => k in map)) return map
      const next = { ...map }
      for (const k of keys) delete next[k]
      return next
    }
    set(s => ({
      messages: without(s.messages),
      older: without(s.older),
      newer: without(s.newer),
      stale: without(s.stale),
      focus: without(s.focus),
      unreadAnchor: without(s.unreadAnchor),
      atBottom: without(s.atBottom),
    }))
  }

  const touchView = (key: string) => forgetViews(views.touch(key))

  const appendLive = (key: string, msgs: Message[], create = false): Partial<RChatState> | null => {
    const s = get()
    const cur = s.messages[key]
    if (!cur && !(create && liveKey(key))) return {}
    const merged = merge(cur ?? [], applyEmbeds(msgs))
    const bottom = liveKey(key) && s.atBottom[key] === true
    if (!bottom && merged.length > DETACH_AT) return null
    const bounded =
      bottom && !s.older[key]?.loading
        ? trimWindow(merged, 'newest')
        : { list: merged, trimmed: false }
    if (bounded.trimmed) newHistory(key)
    const anchor = s.unreadAnchor[key]
    const cut = bounded.trimmed && anchor > 0 && anchor < (bounded.list[0]?.id ?? 0)
    return {
      messages: { ...s.messages, [key]: bounded.list },
      ...(bounded.trimmed ? { older: { ...s.older, [key]: { more: true, loading: false } } } : {}),
      ...(cut ? { unreadAnchor: { ...s.unreadAnchor, [key]: 0 } } : {}),
    }
  }

  const holdLive = (key: string, msgs: Message[]): Partial<RChatState> => {
    for (const m of msgs) holdTail(key, m)
    return { newer: { ...get().newer, [key]: { more: true, loading: false } } }
  }

  const withoutEmbed = (embeds: Embed[], ord: number, banner: boolean) =>
    banner
      ? embeds.map(e => (e.ord === ord ? { ...e, banner_removed: true } : e))
      : embeds.filter(e => e.ord !== ord)

  // A message is gone (deleted alone or in a bulk delete): drops it from every list, the open
  // thread, replies and edits.
  // `counted` is false when the caller already removed it and the event still follows.
  const dropDeleted = (
    id: number,
    threadRootId: number | null,
    server: string | null,
    counted = true
  ) => {
    dropLinkCards(id)
    set(s => {
      const groupPings = dropGroupMessage(s.groupPings, id)
      return groupPings === s.groupPings ? {} : { groupPings }
    })
    if (server !== null) staleInvites(server)
    const rootOf = counted ? threadRootId : null
    unhost(id)
    setPinned(id, null)
    const drop = dropRow(id, rootOf)
    tails.delete(threadKey(id))
    views.delete(threadKey(id))
    mapTails(drop)
    forgetPending(key => key !== threadKey(id))
    set(s => dropDeletedIn(s, id, rootOf))
  }

  const queueMessage = (
    view: View,
    me: Me,
    content: string,
    pending: PendingUpload | null,
    p2pExpiresIn: number | null,
    reply: Replying | null = null
  ) => {
    home.ws.ensureConnected()
    const tempId = nextTempId()
    enqueue({
      tempId,
      key: viewKey(view),
      status: 'queued',
      pending,
      p2pExpiresIn,
      msg: {
        id: tempId,
        channel_id: view.kind === 'channel' ? view.channelId : null,
        dm_id: view.kind === 'dm' ? view.dmId : null,
        thread_root_id: null,
        author: me,
        content,
        created_at: Math.floor(Date.now() / 1000),
        reply_count: 0,
        media: null,
        embeds: [],
        kind: 'user',
        call: null,
        reply_to: reply ? quoteOf(reply, me.username) : null,
      },
      send: opts =>
        view.kind === 'channel'
          ? api.sendChannelMessage(view.channelId, content, { ...opts, ...sendReply(reply) })
          : api.sendDmMessage(view.dmId, content, { ...opts, ...sendReply(reply) }),
    })
  }

  const moveDmUp = (id: number) => {
    set(s => {
      const dm = s.dms.find(d => d.id === id)
      return dm ? { dms: bumpFront(s.dms, dm, dmKey, isSelfDm) } : {}
    })
    pinSelf()
  }

  // Takes a closed DM out of the list and its pin, and leaves it if it is open here.
  const hideDm = (id: number) => {
    const dm = get().dms.find(d => d.id === id)
    if (dm) closedDms.set(id, { ...dm, closed: true })
    const layout = get().layout
    if (layout.dmPinned.includes(id)) saveLayout(noteSelfPin(unpinIn(layout, id), selfDmId(), id))
    dmGen += 1
    const reload = dmPager.removed()
    set(s => ({ dms: s.dms.filter(d => d.id !== id) }))
    if (reload) void get().loadMoreDms()
    const { view, dms } = get()
    if (view?.kind !== 'dm' || view.dmId !== id) return
    const next = dms.find(d => d.is_self) ?? dms[0]
    if (next) void get().openDm(next.id, 'replace')
    else clearView()
  }

  const reopenDm = async (id: number) => {
    const closed = closedDms.get(id)
    const me = get().me
    if (!closed || !me) return
    const dm = await api.openDm(closed.other.username)
    if (!sameUser(me.username)) return
    closedDms.delete(id)
    set(s => ({ dms: bumpFront(s.dms, dm, dmKey, isSelfDm) }))
    pinSelf()
  }

  const bumpDm = (id: number) => {
    if (get().dms.some(d => d.id === id)) moveDmUp(id)
    else
      void get()
        .ensureDms([id])
        .then(() => moveDmUp(id))
        .catch(() => {})
  }

  const setOlder = (key: string, state: OlderState) =>
    set(s => ({ older: { ...s.older, [key]: state } }))

  const fetchPage = async (key: string, page: PageOpts): Promise<Message[]> => {
    const id = Number(key.slice(1))
    try {
      switch (key[0]) {
        case 'c':
          return await api.channelMessages(id, page)
        case 'd':
          return await api.dmMessages(id, page)
        default:
          return await api.threadMessages(id, page)
      }
    } catch (e) {
      const { servers, view } = get()
      const server =
        key[0] === 'c'
          ? Object.values(servers).find(d => d.channels.some(c => c.id === id))?.name
          : key[0] === 'd'
            ? null
            : view?.kind === 'channel'
              ? view.server
              : null
      throw banCheck(e, server)
    }
  }

  const detached = (key: string) => get().newer[key]?.more === true

  const loadOlderFor = async (key: string) => {
    const cur = get().older[key]
    if (cur?.loading || cur?.more === false) return
    const first = (get().messages[key] ?? [])[0]
    if (!first) return
    if (!historyGen.has(key)) newHistory(key)
    const gen = historyGen.get(key)
    const current = () => historyGen.get(key) === gen
    setOlder(key, { more: true, loading: true })
    let older: Message[]
    try {
      older = await fetchPage(key, { before: first.id })
    } catch (e) {
      if (!current()) return
      setOlder(key, { more: true, loading: false })
      throw e
    }
    if (!current()) return
    const bounded = trimWindow(merge(get().messages[key] ?? [], applyEmbeds(older)), 'oldest')
    if (bounded.trimmed) {
      newHistory(key)
      tails.delete(key)
    }
    set(s => ({
      messages: { ...s.messages, [key]: bounded.list },
      older: { ...s.older, [key]: { more: older.length === PAGE, loading: false } },
      ...(bounded.trimmed ? { newer: { ...s.newer, [key]: { more: true, loading: false } } } : {}),
    }))
    askP2p(older)
  }

  const loadNewerFor = async (key: string) => {
    const cur = get().newer[key]
    if (!cur?.more || cur.loading) return
    const list = get().messages[key] ?? []
    const last = list[list.length - 1]
    if (!last) return
    if (!historyGen.has(key)) newHistory(key)
    const gen = historyGen.get(key)
    const current = () => historyGen.get(key) === gen
    set(s => ({ newer: { ...s.newer, [key]: { more: true, loading: true } } }))
    let newer: Message[]
    try {
      newer = await fetchPage(key, { after: last.id })
    } catch (e) {
      if (!current()) return
      set(s => ({ newer: { ...s.newer, [key]: { more: true, loading: false } } }))
      throw e
    }
    if (!current()) return
    const more = newer.length === PAGE
    const caught = more ? [] : takeTail(key, Math.max(last.id, ...newer.map(m => m.id)))
    const bounded = trimWindow(
      merge(get().messages[key] ?? [], applyEmbeds([...newer, ...caught])),
      'newest'
    )
    if (bounded.trimmed) newHistory(key)
    set(s => ({
      messages: { ...s.messages, [key]: bounded.list },
      newer: keyed(s.newer, key, more ? { more: true, loading: false } : null),
      ...(bounded.trimmed ? { older: { ...s.older, [key]: { more: true, loading: false } } } : {}),
    }))
    askP2p(newer)
  }

  const firstPage = (key: string, msgs: Message[], focus?: Focus) => {
    newHistory(key)
    touchView(key)
    const sorted = [...msgs].sort(byId)
    const caught = takeTail(key, (sorted[0]?.id ?? 1) - 1)
    set(s => ({
      messages: { ...s.messages, [key]: applyEmbeds(merge(caught, sorted)) },
      older: { ...s.older, [key]: { more: msgs.length === PAGE, loading: false } },
      newer: keyed(s.newer, key, null),
      stale: keyed(s.stale, key, null),
      ...(focus ? { focus: { ...s.focus, [key]: focus } } : {}),
    }))
  }

  const windowPage = (
    key: string,
    msgs: Message[],
    at: number,
    focus: (sorted: Message[]) => Focus | null
  ) => {
    newHistory(key)
    touchView(key)
    const sorted = [...msgs].sort(byId)
    const edges = windowEdges(
      sorted.map(m => m.id),
      at,
      PAGE
    )
    const caught = edges.newer ? [] : takeTail(key, (sorted[0]?.id ?? 1) - 1)
    if (edges.newer) {
      const last = sorted.at(-1)?.id ?? 0
      const held = (tails.get(key) ?? []).filter(m => m.id > last)
      if (held.length) tails.set(key, held)
      else tails.delete(key)
    }
    set(s => ({
      messages: { ...s.messages, [key]: applyEmbeds(merge(caught, sorted)) },
      older: { ...s.older, [key]: { more: edges.older, loading: false } },
      newer: keyed(s.newer, key, edges.newer ? { more: true, loading: false } : null),
      stale: keyed(s.stale, key, null),
      focus: keyed(s.focus, key, focus(sorted)),
    }))
  }

  const loadAround = async (
    key: string,
    at: number,
    focus: (sorted: Message[]) => Focus | null = () => ({ id: at, flash: true })
  ) => {
    const msgs = await headLoad(key, () => fetchPage(key, { around: at, limit: PAGE }))
    windowPage(key, msgs, at, focus)
    askP2p(msgs)
  }

  const LINK_CARDS_MAX = 500
  const LINK_BATCH_MAX = 50
  const LINK_BATCH_DELAY = 50
  const LINK_BATCH_FLIGHTS = 2
  const linkOrder = new Set<number>()
  const linkQueue = new Set<number>()
  const linkLoads = new Set<number>()
  let linkTimer: ReturnType<typeof setTimeout> | null = null
  let linkFlights = 0
  let linkGen = 0

  const keepLinkCards = (cards: [number, MessageLocation | null][]) => {
    if (!cards.length) return
    set(s => {
      const next = { ...s.linkCards }
      for (const [id, card] of cards) {
        linkOrder.delete(id)
        linkOrder.add(id)
        next[id] = card
      }
      for (const old of linkOrder) {
        if (linkOrder.size <= LINK_CARDS_MAX) break
        linkOrder.delete(old)
        delete next[old]
      }
      return { linkCards: next }
    })
  }

  const keepLinkCard = (id: number, card: MessageLocation | null) => keepLinkCards([[id, card]])

  const reauthorLinkCards = (u: UserRef) =>
    set(s => {
      const hit = Object.entries(s.linkCards).filter(
        ([, card]) => card?.author.username === u.username
      )
      if (!hit.length) return {}
      const next = { ...s.linkCards }
      for (const [id, card] of hit) if (card) next[Number(id)] = { ...card, author: u }
      return { linkCards: next }
    })

  const dropLinkCards = (id?: number) => {
    linkGen += 1
    if (id === undefined) linkOrder.clear()
    else linkOrder.delete(id)
    set(s => {
      if (id === undefined) return Object.keys(s.linkCards).length ? { linkCards: {} } : {}
      if (!(id in s.linkCards)) return {}
      const { [id]: _, ...rest } = s.linkCards
      return { linkCards: rest }
    })
  }

  const queueLinkCards = () => {
    if (linkTimer === null && linkQueue.size && linkFlights < LINK_BATCH_FLIGHTS)
      linkTimer = setTimeout(flushLinkCards, LINK_BATCH_DELAY)
  }

  // Visible message links resolve in batches of up to 50, at most two batches at a time.
  const flushLinkCards = () => {
    linkTimer = null
    while (linkQueue.size && linkFlights < LINK_BATCH_FLIGHTS) {
      const ids = [...linkQueue].slice(0, LINK_BATCH_MAX)
      for (const id of ids) linkQueue.delete(id)
      linkFlights += 1
      const gen = linkGen
      void api
        .messageLocations(ids)
        .then(
          found => found,
          e => (refused(e) ? [] : undefined)
        )
        .then(found => {
          linkFlights -= 1
          for (const id of ids) linkLoads.delete(id)
          if (gen !== linkGen) for (const id of ids) get().resolveLinkCard(id)
          else if (found) {
            const byId = new Map(found.map(card => [card.id, card]))
            keepLinkCards(ids.map(id => [id, byId.get(id) ?? null]))
          }
          queueLinkCards()
        })
    }
  }

  const refused = (e: unknown) =>
    e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429

  // Where a message is, through the same gate as reading it; null for every refusal.
  const locateMessage = async (id: number) => {
    try {
      const loc = await api.messageLocation(id)
      keepLinkCard(id, loc)
      return loc
    } catch (e) {
      if (!refused(e)) throw e
      keepLinkCard(id, null)
      return null
    }
  }

  const openMessageAt = async (id: number, nav: Nav) => {
    const loc = await locateMessage(id)
    if (!loc) return false
    if (loc.dm_id !== null) {
      const v = get().view
      if (v?.kind === 'dm' && v.dmId === loc.dm_id) await get().jumpTo(`d${loc.dm_id}`, id)
      else await get().openDm(loc.dm_id, nav, id)
      return true
    }
    const { server, channel_id } = loc
    if (server === null || channel_id === null) return false
    const { guest, guestServers } = get()
    if (guest && !guestServers.includes(server)) {
      persistGuestServers([...guestServers, server])
      home.ws.subscribe([server])
    }
    await openChannelAt(server, channel_id, loc.thread_root_id, id, nav)
    return true
  }

  // Hashes of files being attached, started when the file is picked (see buildSendOpts).
  const attachHashes = new WeakMap<File, Promise<string>>()
  const hashOf = (file: File) => {
    let hash = attachHashes.get(file)
    if (!hash) {
      hash = hashBlob(file)
      attachHashes.set(file, hash)
    }
    return hash
  }

  const p2pExpiry = (expiresIn: number | null | undefined) =>
    expiresIn == null ? null : Math.floor(Date.now() / 1000) + expiresIn

  const buildSendOpts = async (
    pending: PendingUpload | null,
    p2pExpiresIn: number | null | undefined
  ): Promise<{ opts: SendOpts; p2pId: string | null }> => {
    if (!pending) return { opts: {}, p2pId: null }
    const { file, spoiler, mode } = pending
    if (mode === 'p2p') {
      const relay = pending.relay ?? relayBook.prefs.choice
      await relayBook.check(relay)
      const id = newP2pId()
      const sha256 = await hashOf(file)
      await p2p.stage(id, file, p2pExpiry(p2pExpiresIn), sha256, relay)
      return {
        opts: {
          media_spoiler: spoiler,
          p2p: {
            filename: file.name,
            size: file.size,
            mime: (file.type || 'application/octet-stream').slice(0, 255),
            sha256,
            p2p_id: id,
            expires_in_seconds: p2pExpiresIn ?? undefined,
          },
        },
        p2pId: id,
      }
    }
    const max = limitsOf(get().instance).upload_bytes
    if (file.size > max) throw new Error(tooLargeText(max))
    const uploaded = await api.uploadMedia(file)
    return { opts: { media_id: uploaded.id, media_spoiler: spoiler }, p2pId: null }
  }

  const patchOutgoing = (key: string, tempId: number, status: OutgoingStatus) =>
    set(s => {
      const list = s.outbox[key]
      if (!list) return {}
      return {
        outbox: {
          ...s.outbox,
          [key]: list.map(o => (o.tempId === tempId ? { ...o, status } : o)),
        },
      }
    })

  const dropOutgoing = (map: Record<string, Outgoing[]>, key: string, tempId: number) => {
    const next = (map[key] ?? []).filter(o => o.tempId !== tempId)
    const outbox = { ...map }
    if (next.length) outbox[key] = next
    else delete outbox[key]
    return outbox
  }

  const drain = async (key: string) => {
    if (draining.has(key)) return
    draining.add(key)
    try {
      for (;;) {
        const head = (get().outbox[key] ?? [])[0]
        if (!head || head.status === 'failed') break
        patchOutgoing(key, head.tempId, 'sending')
        let real: Message
        try {
          const built = await buildSendOpts(head.pending, head.p2pExpiresIn)
          const { opts } = built
          let { p2pId } = built
          try {
            try {
              real = await head.send(opts)
            } catch (e) {
              if (p2pId === null || !p2pIdTaken(e) || !head.pending || !opts.p2p) throw e
              // Someone posted our P2P id first: keep the file under a fresh one and try once more.
              p2p.removeFile(p2pId)
              const id: string = newP2pId()
              p2pId = id
              await p2p.stage(
                id,
                head.pending.file,
                p2pExpiry(head.p2pExpiresIn),
                opts.p2p.sha256,
                head.pending.relay ?? relayBook.prefs.choice
              )
              real = await head.send({ ...opts, p2p: { ...opts.p2p, p2p_id: id } })
            }
          } catch (e) {
            if (p2pId !== null) p2p.removeFile(p2pId)
            throw e
          }
          if (p2pId !== null) p2p.posted(p2pId, real.id)
        } catch (e) {
          patchOutgoing(key, head.tempId, 'failed')
          settleSent(head.tempId, null)
          const wait = e instanceof ApiError && e.status === 429 ? slowWait(e.message) : null
          if (wait !== null) noteSlow(head.msg.channel_id, wait)
          fail(e)
          break
        }
        if (holding(key)) holdTail(key, real)
        const next = holding(key) ? {} : (appendLive(key, [real], true) ?? holdLive(key, [real]))
        set(s => ({ outbox: dropOutgoing(s.outbox, key, head.tempId), ...next }))
        settleSent(head.tempId, real)
        noteSlow(real.channel_id, null)
        if (key[0] !== 't') get().markRead(key, real.id)
      }
    } finally {
      draining.delete(key)
    }
  }

  const noteSlow = (channelId: number | null, wait: number | null) => {
    if (channelId === null) return
    const s = get()
    const detail = Object.values(s.servers).find(d => d.channels.some(c => c.id === channelId))
    const seconds = detail?.channels.find(c => c.id === channelId)?.slowmode_seconds ?? 0
    if (wait === null && (!detail || seconds <= 0 || slowExempt(myPerms(s, detail.name)))) return
    const until = Date.now() + (wait ?? seconds) * 1000
    set(st => ({ slowUntil: { ...st.slowUntil, [channelId]: until } }))
  }

  const enqueue = (o: Outgoing) => {
    set(s => ({ outbox: { ...s.outbox, [o.key]: [...(s.outbox[o.key] ?? []), o] } }))
    void drain(o.key)
  }

  const onReaction = (ev: Extract<WsEvent, { type: 'reaction_added' | 'reaction_removed' }>) => {
    const mine = get().me?.username === ev.username
    const key = reactorKey(ev.message_id, ev.emoji)
    const added = ev.type === 'reaction_added'
    const at = Math.floor(Date.now() / 1000)
    forgetReactors(key)
    patchReactions(ev.message_id, m => {
      if (!mine || !reactionQueue.has(key) || ev.count === undefined)
        return withReaction(m, ev.emoji, added, mine, at, ev.count)
      const local = reacted(m, ev.emoji)
      const count = ev.count - (added ? 1 : 0) + (local ? 1 : 0)
      return withReaction(m, ev.emoji, local, true, at, count)
    })
  }

  const forget = () => {
    dmPager.reset(null)
    historyGen.clear()
    tails.clear()
    views.clear()
    reactorCache.clear()
    quotes.clear()
    quoteReads.clear()
    rereads.clear()
    for (const id of [...sentWaiters.keys()]) settleSent(id, null)
    quoteGen += 1
    linkLoads.clear()
    linkGen += 1
  }

  const actions: Pick<
    RChatState,
    | 'setDraft'
    | 'startDm'
    | 'messageUser'
    | 'loadMoreDms'
    | 'ensureDms'
    | 'closeDm'
    | 'sendMessage'
    | 'startReply'
    | 'cancelReply'
    | 'copyForward'
    | 'clearForward'
    | 'copyForwardClip'
    | 'alertFrom'
    | 'openPins'
    | 'closePins'
    | 'pinMessage'
    | 'openPinned'
    | 'unpinMessage'
    | 'sendForward'
    | 'openForward'
    | 'openMessage'
    | 'resolveLinkCard'
    | 'startEdit'
    | 'setEditText'
    | 'cancelEdit'
    | 'saveEdit'
    | 'editLast'
    | 'sedEdit'
    | 'toggleReplyMention'
    | 'setAtBottom'
    | 'retryOutgoing'
    | 'cancelOutgoing'
    | 'loadOlder'
    | 'loadNewer'
    | 'jumpTo'
    | 'jumpToUnread'
    | 'jumpToPresent'
    | 'dismissUnread'
    | 'clearFocus'
    | 'openResult'
    | 'openPing'
    | 'uploadFile'
    | 'toggleSpoiler'
    | 'toggleUploadMode'
    | 'loadOlderThread'
    | 'loadNewerThread'
    | 'sendThreadMessage'
    | 'searchRun'
    | 'deleteMessage'
    | 'deleteMedia'
    | 'deleteEmbed'
    | 'toggleReaction'
    | 'loadReactors'
  > = {
    setDraft: (key, text) => set(s => ({ drafts: keyed(s.drafts, key, text || null) })),

    startDm: username =>
      act(async () => {
        const dm = await api.openDm(username)
        set(s => ({ dms: bumpFront(s.dms, dm, dmKey, isSelfDm) }))
        pinSelf()
        await get().openDm(dm.id)
      }),

    messageUser: (username, content) =>
      act(async () => {
        const { me, settings } = get()
        if (!me) throw new Error(`${accountPrompt(settings)} to send messages`)
        const dm = await api.openDm(username)
        if (!sameUser(me.username)) return
        set(s => ({ dms: bumpFront(s.dms, dm, dmKey, isSelfDm) }))
        pinSelf()
        await get().openDm(dm.id)
        const author = get().me
        if (content.trim() && author?.username === me.username)
          queueMessage({ kind: 'dm', dmId: dm.id }, author, content, null, null)
      }),

    loadMoreDms: () =>
      act(async () => {
        if (get().me && get().dmsMore) await dmPager.load()
      }),

    ensureDms: async ids => {
      const me = get().me
      if (!me) return
      const have = new Set(get().dms.map(d => d.id))
      const missing = [...new Set(ids)].filter(id => Number.isSafeInteger(id) && !have.has(id))
      for (let i = 0; i < missing.length; i += LIST_MAX) {
        const batch = missing.slice(i, i + LIST_MAX)
        const found = await settled(
          () => dmGen,
          () => api.dmsById(batch)
        )
        if (!sameUser(me.username)) return
        for (const d of found) {
          if (d.closed) closedDms.set(d.id, d)
          else closedDms.delete(d.id)
        }
        set(s => ({
          dms: appendUnique(
            s.dms,
            found.filter(d => !d.closed),
            dmKey
          ),
        }))
        pinSelf()
      }
    },

    closeDm: id =>
      act(async () => {
        const me = get().me
        if (!me) return
        hideDm(id)
        try {
          await api.closeDm(id)
        } catch (e) {
          if (!sameUser(me.username)) return
          closedDms.delete(id)
          await get()
            .ensureDms([id])
            .catch(() => {})
          throw e
        }
      }),

    sendMessage: (content, p2pExpiresIn, p2pRelay) => {
      const { view, me } = get()
      if (!view || !me) return
      const key = viewKey(view)
      const held = get().pending[key] ?? null
      const pending = held && p2pRelay !== undefined ? { ...held, relay: p2pRelay } : held
      if (!content.trim() && !pending) return
      const reply = get().replying[key] ?? null
      set(s => ({ pending: keyed(s.pending, key, null), replying: keyed(s.replying, key, null) }))
      clearAnchor(key)
      if (detached(key)) void get().jumpToPresent(key)
      queueMessage(view, me, content, pending, p2pExpiresIn ?? null, reply)
    },

    startReply: (key, m) => {
      const username = get().me?.username
      if (!username) return
      let mention = true
      try {
        mention = parseReplyMention(localStorage.getItem(home.scoped(replyMentionKey(username))))
      } catch {
        mention = true
      }
      set(s => ({
        replying: { ...s.replying, [key]: { message: m, mention } },
        composerFocus: { key, n: (s.composerFocus?.n ?? 0) + 1 },
      }))
    },

    cancelReply: key => set(s => ({ replying: keyed(s.replying, key, null) })),

    copyForward: m => {
      const { me, guest } = get()
      if (!me || guest || !canForward(m)) return
      saveForward(clipOf(m))
      toast('Message copied for forwarding')
    },

    clearForward: () => saveForward(null),

    copyForwardClip: clip => {
      const { me, guest } = get()
      if (!me || guest) return
      saveForward(clip)
      toast('Message copied for forwarding')
    },

    alertFrom: alert => alertUser(alert),

    openPins: () => {
      const { view } = get()
      if (!view) return
      const key = viewKey(view)
      set({ pins: { key, list: null, failed: false }, contextMenu: null })
      loadPins(key)
    },

    closePins: () => set(s => (s.pins ? { pins: null } : {})),

    pinMessage: id =>
      act(async () => {
        await api.pinMessage(id)
        patchReactions(id, m => (m.pinned_at ? m : withPinnedAt(m, Math.floor(Date.now() / 1000))))
      }),

    openPinned: (key, id) =>
      act(async () => {
        if (!(get().messages[key] ?? []).some(m => m.id === id)) {
          const probe = await fetchPage(key, { around: id, limit: 1 })
          if (probe[0]?.id !== id) {
            toast("You can't open this message")
            return
          }
        }
        await get().jumpTo(key, id)
      }),

    unpinMessage: id =>
      act(async () => {
        await api.unpinMessage(id)
        setPinned(id, null)
      }),

    sendForward: key => {
      const { me, guest, forwardClip: clip } = get()
      if (!me || guest || !clip || forwardPending(get().outbox[key], clip.id)) return
      // From a P2P conversation: the instance has no original to point at, so this posts a copy
      // of the text (the forward bar asked first).
      if (clip.p2p) {
        const body = clip.body ?? clip.snippet
        const view = get().view
        if (key[0] === 't') get().sendThreadMessage(body)
        else if (view && viewKey(view) === key) queueMessage(view, me, body, null, null, null)
        else return
        saveForward(null)
        return
      }
      const id = Number(key.slice(1))
      const kind = key[0]
      if (!Number.isSafeInteger(id) || !'cdt'.includes(kind)) return
      const s = get()
      const target =
        kind === 'c'
          ? {
              text: `Forwarded to #${
                Object.values(s.servers)
                  .flatMap(d => d.channels)
                  .find(c => c.id === id)?.name ?? 'channel'
              }`,
            }
          : kind === 'd'
            ? {
                text: 'Forwarded to',
                name: s.dms.find(d => d.id === id)?.other.display_name ?? 'direct message',
              }
            : { text: 'Forwarded to the thread' }
      home.ws.ensureConnected()
      if (kind !== 't') clearAnchor(key)
      if (detached(key)) void get().jumpToPresent(key)
      const tempId = nextTempId()
      const opts = { forward_of: clip.id }
      enqueue({
        tempId,
        key,
        status: 'queued',
        pending: null,
        p2pExpiresIn: null,
        msg: {
          id: tempId,
          channel_id: kind === 'c' ? id : null,
          dm_id: kind === 'd' ? id : null,
          thread_root_id: kind === 't' ? id : null,
          author: me,
          content: clip.snippet,
          created_at: Math.floor(Date.now() / 1000),
          reply_count: 0,
          media: null,
          embeds: [],
          kind: 'user',
          call: null,
          reply_to: null,
          forward: {
            author: clip.author,
            created_at: clip.created_at,
            source_id: clip.id,
            origin: null,
            dropped: null,
          },
        },
        send: () =>
          kind === 'c'
            ? api.sendChannelMessage(id, '', opts)
            : kind === 'd'
              ? api.sendDmMessage(id, '', opts)
              : api.sendThreadMessage(id, '', opts),
      })
      void sentAs(tempId).then(sent => {
        if (!sent) return
        if (get().forwardClip?.id === clip.id) saveForward(null)
        toast(target.text, target.name)
      })
    },

    openForward: m => {
      const fwd = m.forward
      return fwd ? get().openMessage(fwd.source_id) : Promise.resolve()
    },

    openMessage: (id, nav = 'push') =>
      act(async () => {
        if (!(await openMessageAt(id, nav))) toast("You can't open this message")
      }),

    resolveLinkCard: id => {
      if (id in get().linkCards || linkLoads.has(id)) return
      linkLoads.add(id)
      linkQueue.add(id)
      queueLinkCards()
    },

    startEdit: (key, m) => {
      const { me, guest } = get()
      if (guest || !me || m.author.username !== me.username || m.kind !== 'user' || m.forward)
        return
      set({ editing: { key, id: m.id, text: m.content } })
    },

    setEditText: text => set(s => (s.editing ? { editing: { ...s.editing, text } } : {})),

    cancelEdit: refocus => {
      const ed = get().editing
      if (!ed) return
      set(s => ({
        editing: null,
        ...(refocus ? { composerFocus: { key: ed.key, n: (s.composerFocus?.n ?? 0) + 1 } } : {}),
      }))
    },

    saveEdit: refocus => {
      const ed = get().editing
      if (!ed) return
      const m = findMessage(ed.id)
      if (!m) {
        set({ editing: null })
        fail(new Error('This message is no longer here'))
        return
      }
      const text = ed.text
      if (!text.trim() && !attached(m)) {
        confirmDeleteMessage(m.id)
        return
      }
      if (charCount(text) > limitsOf(get().instance).message_chars) return
      get().cancelEdit(refocus)
      if (text === m.content) return
      const edited_at = Math.floor(Date.now() / 1000)
      patchReactions(m.id, x => ({ ...x, content: text, edited_at }))
      api
        .editMessage(m.id, text)
        .then(saved => {
          if (findMessage(m.id)?.content === text) applyUpdated(saved)
        })
        .catch(e => {
          patchReactions(m.id, x =>
            x.content === text ? { ...x, content: m.content, edited_at: m.edited_at } : x
          )
          fail(e)
        })
    },

    editLast: key => {
      const ed = get().editing
      if (ed && liveKey(ed.key)) {
        set({ editing: { ...ed, focus: (ed.focus ?? 0) + 1 } })
        return true
      }
      if (ed && ed.text !== findMessage(ed.id)?.content) {
        fail(new Error('Finish your other edit first'))
        return true
      }
      const m = editTarget(key)
      if (!m) return false
      get().startEdit(key, m)
      return get().editing?.id === m.id
    },

    sedEdit: async (key, sed) => {
      const sending = (get().outbox[key] ?? []).at(-1)
      if (sending) {
        if (sending.status === 'failed') {
          fail(new Error('Your last message was not sent'))
          return false
        }
        if (applySed(sending.msg.content, sed) === null) {
          fail(new Error('No match in your last message'))
          return false
        }
        const sent = await sentAs(sending.tempId)
        if (!sent) {
          fail(new Error('Your last message was not sent'))
          return false
        }
        return sedOn(sent, sed)
      }
      const m = editTarget(key)
      if (!m) {
        fail(new Error('You have no message here to edit'))
        return false
      }
      return sedOn(m, sed)
    },

    toggleReplyMention: key => {
      const cur = get().replying[key]
      const username = get().me?.username
      if (!cur || !username) return
      const mention = !cur.mention
      set(s => ({ replying: { ...s.replying, [key]: { ...cur, mention } } }))
      writeLocal(home.scoped(replyMentionKey(username)), replyMentionValue(mention))
    },

    setAtBottom: (key, v) =>
      set(s => (s.atBottom[key] === v ? {} : { atBottom: { ...s.atBottom, [key]: v } })),

    retryOutgoing: (key, tempId) => {
      patchOutgoing(key, tempId, 'queued')
      void drain(key)
    },

    cancelOutgoing: (key, tempId) => {
      set(s => ({ outbox: dropOutgoing(s.outbox, key, tempId) }))
      settleSent(tempId, null)
      void drain(key)
    },

    loadOlder: () =>
      act(async () => {
        const { view } = get()
        if (view) await loadOlderFor(viewKey(view))
      }),

    loadNewer: () =>
      act(async () => {
        const { view } = get()
        if (view) await loadNewerFor(viewKey(view))
      }),

    jumpTo: (key, id, flash = true) =>
      act(async () => {
        if (key === threadKey(id) || (get().messages[key] ?? []).some(m => m.id === id)) {
          set(s => ({ focus: { ...s.focus, [key]: { id, flash } } }))
          return
        }
        await loadAround(key, id, () => ({ id, flash }))
      }),

    jumpToUnread: () =>
      act(async () => {
        const { view } = get()
        if (!view) return
        const key = viewKey(view)
        const anchor = get().unreadAnchor[key] ?? 0
        if (anchor <= 0) return
        await loadAround(key, anchor, sorted => ({
          id: sorted.find(m => m.id > anchor)?.id ?? anchor,
          flash: false,
        }))
      }),

    jumpToPresent: key =>
      act(async () => {
        const msgs = await headLoad(key, () => fetchPage(key, {}))
        firstPage(key, msgs, { id: null, flash: false })
        askP2p(msgs)
      }),

    dismissUnread: key => {
      clearAnchor(key)
      const s = get()
      const latest = Math.max(s.reads[key]?.latest ?? 0, s.messages[key]?.at(-1)?.id ?? 0)
      if (latest > 0) s.markRead(key, latest)
    },

    clearFocus: key => set(s => (s.focus[key] ? { focus: keyed(s.focus, key, null) } : {})),

    openResult: result =>
      act(async () => {
        const { message, server } = result
        const { channel_id, thread_root_id, id } = message
        if (channel_id === null) return
        await openChannelAt(server, channel_id, thread_root_id, id)
      }),

    openPing: ping =>
      act(async () => {
        const id = Number(ping.scope.slice(1))
        if (ping.scope[0] === 'c') {
          if (ping.server !== null)
            await openChannelAt(ping.server, id, ping.thread_root_id, ping.message_id)
          return
        }
        const v = get().view
        if (v?.kind === 'dm' && v.dmId === id) await get().jumpTo(ping.scope, ping.message_id)
        else await get().openDm(id, 'push', ping.message_id)
      }),

    uploadFile: (key, file) => {
      const max = limitsOf(get().instance).upload_bytes
      const mode = file ? startMode(get().settings, file.size, max) : null
      if (file && mode === null) return
      if (file && mode === 'server' && file.size > max) {
        fail(new Error(tooLargeText(max)))
        return
      }
      if (file && get().settings.p2p_attachments) void hashOf(file).catch(() => {})
      const { panel } = get()
      const root = panel?.kind === 'thread' && threadKey(panel.root.id) === key ? panel.root : null
      const scope = root && root.channel_id !== null ? `c${root.channel_id}` : key
      const pending: PendingUpload | null =
        file && mode ? { file, spoiler: false, mode, scope } : null
      set(s => ({ pending: keyed(s.pending, key, pending) }))
    },

    toggleSpoiler: key =>
      set(s => {
        const cur = s.pending[key]
        return cur ? { pending: { ...s.pending, [key]: { ...cur, spoiler: !cur.spoiler } } } : {}
      }),

    toggleUploadMode: key =>
      set(s => {
        const cur = s.pending[key]
        if (!cur) return {}
        const mode: UploadMode = cur.mode === 'server' ? 'p2p' : 'server'
        if (!attachModes(s.settings).includes(mode)) return {}
        if (mode === 'server' && cur.file.size > limitsOf(s.instance).upload_bytes) return {}
        if (mode === 'p2p') void hashOf(cur.file).catch(() => {})
        return { pending: { ...s.pending, [key]: { ...cur, mode } } }
      }),

    loadOlderThread: () =>
      act(async () => {
        const { panel } = get()
        if (panel?.kind === 'thread') await loadOlderFor(threadKey(panel.root.id))
      }),

    loadNewerThread: () =>
      act(async () => {
        const { panel } = get()
        if (panel?.kind === 'thread') await loadNewerFor(threadKey(panel.root.id))
      }),

    sendThreadMessage: (content, p2pExpiresIn, p2pRelay) => {
      const { panel, me } = get()
      if (panel?.kind !== 'thread' || !me) return
      const rootId = panel.root.id
      const key = threadKey(rootId)
      const held = get().pending[key] ?? null
      const pending = held && p2pRelay !== undefined ? { ...held, relay: p2pRelay } : held
      if (!content.trim() && !pending) return
      const tempId = nextTempId()
      const reply = get().replying[key] ?? null
      set(s => ({ pending: keyed(s.pending, key, null), replying: keyed(s.replying, key, null) }))
      if (detached(key)) void get().jumpToPresent(key)
      enqueue({
        tempId,
        key,
        status: 'queued',
        pending,
        p2pExpiresIn: p2pExpiresIn ?? null,
        msg: {
          id: tempId,
          channel_id: null,
          dm_id: null,
          thread_root_id: rootId,
          author: me,
          content,
          created_at: Math.floor(Date.now() / 1000),
          reply_count: 0,
          media: null,
          embeds: [],
          kind: 'user',
          call: null,
          reply_to: reply ? quoteOf(reply, me.username) : null,
        },
        send: opts => api.sendThreadMessage(rootId, content, { ...opts, ...sendReply(reply) }),
      })
    },

    searchRun: (args, reset) =>
      act(async () => {
        const cur = get().search
        if (!reset && (cur.loading || !cur.hasMore)) return
        if (reset) epochs.search = (epochs.search ?? 0) + 1
        const epoch = epochs.search ?? 0
        let results = reset ? [] : cur.results
        let cursor = reset ? null : (cur.cursor ?? null)
        set({ search: { results, hasMore: true, loading: true, cursor } })
        const { guest, guestServers } = get()
        const start = results.length
        for (let tries = 0; ; tries += 1) {
          let page: Page<SearchResult>
          try {
            page = await api.search(searchParams(args, cursor, guest ? guestServers : null))
          } catch (e) {
            if ((epochs.search ?? 0) === epoch)
              set({ search: { results, hasMore: true, loading: false, cursor } })
            throw e
          }
          if ((epochs.search ?? 0) !== epoch) return
          const next = addSearchPage(results, page.items, page.next)
          results = next.results
          cursor = page.next
          const done =
            !next.hasMore || results.length - start >= SEARCH_PAGE || tries + 1 >= SEARCH_TRIES
          set({ search: { ...next, loading: !done, cursor } })
          if (done) return
        }
      }),

    deleteMessage: id =>
      act(async () => {
        await api.deleteMessage(id)
        unhost(id)
        setPinned(id, null)
        const drop = (list: Message[]) => {
          const i = indexOfId(list, id)
          return unlinkPin(i === -1 ? list : [...list.slice(0, i), ...list.slice(i + 1)], id)
        }
        mapTails(drop)
        set(s => ({
          messages: mapLists(s.messages, drop),
          ...(s.editing?.id === id ? { editing: null } : {}),
        }))
      }),

    deleteMedia: messageId =>
      act(async () => {
        await api.deleteMedia(messageId)
        unhost(messageId)
        patchMessage(messageId, m =>
          m.media ? { ...m, media: { ...m.media, removed: true, removed_by_author: true } } : m
        )
      }),

    deleteEmbed: (messageId, ord, banner) =>
      act(async () => {
        await api.deleteEmbed(messageId, ord, banner)
        patchMessage(messageId, m => ({ ...m, embeds: withoutEmbed(m.embeds, ord, banner) }))
      }),

    toggleReaction: (m, emoji, note = true) => {
      const { me, guest } = get()
      if (!me || guest) return
      const cur = findMessage(m.id) ?? m
      const adding = !reacted(cur, emoji)
      if (adding && !canAddEmoji(cur, emoji)) return
      const key = reactorKey(m.id, emoji)
      const apply = (added: boolean) => {
        forgetReactors(key)
        patchReactions(m.id, x =>
          withReaction(x, emoji, added, true, Math.floor(Date.now() / 1000))
        )
      }
      apply(adding)
      if (adding && note) get().noteEmoji(emojiBase(get().emoji, emoji), emoji)
      const prev = reactionQueue.get(key) ?? Promise.resolve()
      const next = prev.then(async () => {
        try {
          if (adding) await api.addReaction(m.id, emoji)
          else await api.removeReaction(m.id, emoji)
        } catch (e) {
          apply(!adding)
          fail(e)
        }
      })
      reactionQueue.set(key, next)
      void next.then(() => {
        if (reactionQueue.get(key) === next) reactionQueue.delete(key)
      })
    },

    loadReactors: (messageId, emoji) => {
      const key = reactorKey(messageId, emoji)
      const known = reactorCache.get(key)
      if (known) return known
      const req = api.reactors(messageId, emoji).catch(e => {
        if (reactorCache.get(key) === req) reactorCache.delete(key)
        throw e
      })
      reactorCache.set(key, req)
      if (reactorCache.size > REACTOR_CACHE) {
        const oldest = reactorCache.keys().next().value
        if (oldest !== undefined) reactorCache.delete(oldest)
      }
      return req
    },
  }

  const handlers = {
    message: ev => {
      const m = withQuote(ev.message)
      const rootId = m.thread_root_id
      if (rootId !== null) {
        const tkey = threadKey(rootId)
        const ckey = m.channel_id !== null ? `c${m.channel_id}` : null
        const bump = (list: Message[]) =>
          patchById(list, rootId, r => ({ ...r, reply_count: r.reply_count + 1 }))
        const held = ckey ? tails.get(ckey) : undefined
        if (ckey && held) tails.set(ckey, bump(held))
        const live = liveKey(tkey)
        if (live && holding(tkey)) holdTail(tkey, m)
        const thread = live && !holding(tkey) ? (appendLive(tkey, [m]) ?? holdLive(tkey, [m])) : {}
        set(s => {
          const messages = { ...s.messages, ...thread.messages }
          if (ckey && messages[ckey]) messages[ckey] = bump(messages[ckey])
          return {
            ...thread,
            messages,
            panel:
              s.panel?.kind === 'thread' && s.panel.root.id === rootId
                ? {
                    ...s.panel,
                    root: { ...s.panel.root, reply_count: s.panel.root.reply_count + 1 },
                  }
                : s.panel,
          }
        })
      } else {
        const key = messageKey(ev.channel_id, ev.dm_id)
        if (key && liveKey(key)) {
          if (holding(key)) holdTail(key, m)
          else set(appendLive(key, [m]) ?? holdLive(key, [m]))
        }
      }
      askP2p([m])
      readQuote(m)
      const typedIn = rootId !== null ? threadKey(rootId) : messageKey(ev.channel_id, ev.dm_id)
      if (typedIn) noteTyper(typedIn, m.author.username, '', false)
      if (ev.dm_id !== null && get().me) bumpDm(ev.dm_id)
      if (m.kind === 'call') return
      if (rootId === null) {
        const scope = messageKey(m.channel_id, m.dm_id)
        if (scope) {
          const meNow = get().me
          const mine = meNow?.username === m.author.username
          const viewNow = get().view
          const viewingScope = viewNow ? viewKey(viewNow) : null
          set(s => {
            const prev = s.reads[scope] ?? {
              lastRead: mine ? m.id : readsHub.more() ? 0 : m.id - 1,
              latest: 0,
            }
            return {
              reads: {
                ...s.reads,
                [scope]: {
                  ...prev,
                  latest: Math.max(prev.latest, m.id),
                  server: ev.server ?? prev.server,
                },
              },
            }
          })
          if (mine || (scope === viewingScope && get().atBottom[scope] && pageVisible()))
            get().markRead(scope, m.id)
        }
      }
      if (rootId === null && ev.server !== null && groupAlert(m, ev.server)) return
      const { me, view } = get()
      if (!me || m.author.username === me.username || (rootId !== null && m.dm_id === null)) return
      if (get().blocked[m.author.username]) return
      const scope = messageKey(m.channel_id, m.dm_id)
      const target = scope ? scopeOfKey(scope, ev.server ?? null) : null
      if (!scope || !target) return
      const toMe =
        repliesToMe(m, me.username) || (m.reply_to?.partial === true && m.reply_to.mention)
      if (!m.forward && (mentionsUser(m.content, me.username) || toMe)) return
      const watched =
        view !== null &&
        viewKey(view) === scope &&
        get().atBottom[scope] === true &&
        !detached(scope) &&
        pageVisible()
      if (!messageAlert(scopeRule(get(), target), watched)) return
      const { dm_id, channel_id } = ev
      const host = ev.server !== null ? get().servers[ev.server] : undefined
      const channel =
        channel_id !== null ? (host?.channels.find(c => c.id === channel_id)?.name ?? null) : null
      alertUser({
        key: scope,
        actor: m.author,
        action: '',
        body:
          m.kind === 'pin'
            ? 'Pinned a message'
            : isSystem(m)
              ? systemText(m)
              : m.content || (m.media?.spoiler ? '' : m.media?.filename) || 'Attachment',
        server: dm_id === null ? (host?.display_name ?? null) : null,
        channel,
        dm: dm_id !== null,
        message: true,
        name: nameWithUsername(m.author),
        generic: 'New message',
        go: () => {
          if (dm_id !== null) void get().openDm(dm_id, 'push', m.id)
          else if (ev.server !== null && channel_id !== null)
            void get().openChannel(ev.server, channel_id, 'push', m.id)
        },
      })
    },
    message_updated: ev => {
      dropLinkCards(ev.stub ? ev.id : ev.message.id)
      if (ev.stub) rereadEdited(ev)
      else applyUpdated(ev.message)
      refreshPins(ev.stub ? ev.id : ev.message.id)
    },
    message_pinned: ev => {
      setPinned(ev.message_id, ev.pinned_at)
      const key = messageKey(ev.channel_id, ev.dm_id)
      if (key && get().pins?.key === key) loadPins(key)
    },
    message_unpinned: ev => {
      setPinned(ev.message_id, null)
    },
    reaction_added: onReaction,
    reaction_removed: onReaction,
    message_deleted: ev => {
      dropDeleted(ev.id, ev.thread_root_id, ev.server)
    },
    messages_deleted: ev => {
      for (const id of ev.ids) dropDeleted(id, ev.thread_root_id, ev.server)
    },
    media_removed: ev => {
      unhost(ev.message_id)
      patchMessage(ev.message_id, m =>
        m.media
          ? {
              ...m,
              media: { ...m.media, removed: true, removed_by_author: ev.removed_by_author },
            }
          : m
      )
    },
    embeds_resolved: ev => {
      rememberEmbeds(ev.message_id, ev.embeds)
      patchMessage(ev.message_id, m => ({ ...m, embeds: ev.embeds }))
    },
    embeds_removed: ev => {
      const cur = pendingEmbeds.get(ev.message_id)
      if (cur) rememberEmbeds(ev.message_id, withoutEmbed(cur, ev.ord, ev.banner))
      patchMessage(ev.message_id, m => ({
        ...m,
        embeds: withoutEmbed(m.embeds, ev.ord, ev.banner),
      }))
    },
    dm_created: ev => {
      const { me } = get()
      if (me && ev.dm_users.includes(me.username)) bumpDm(ev.dm_id)
    },
    dm_closed: ev => {
      if (get().me?.username === ev.username) hideDm(ev.dm_id)
    },
    dm_reopened: ev => {
      if (get().me?.username !== ev.username) return
      closedDms.delete(ev.dm_id)
      bumpDm(ev.dm_id)
    },
    user_blocked: ev => {
      if (get().me?.username === ev.username) noteBlocked(ev.blocked)
    },
    user_unblocked: ev => {
      if (get().me?.username === ev.username) noteUnblocked(ev.blocked)
    },
    p2p_availability: ev => {
      const { hoster, ids, online } = ev
      set(s => ({
        p2pAvailability: { ...s.p2pAvailability, [hoster]: { ids, online } },
      }))
    },
    p2p_peer: ev => {
      p2p.granted(ev)
    },
    p2p_hosted: ev => {
      if (typeof ev.key === 'string' && typeof ev.peer_id === 'string')
        p2p.setServeKey(ev.key, ev.peer_id, ev.now ?? null)
      void p2p.reconcile(ev.live, ev.checked)
    },
  } satisfies Handlers

  return {
    handlers,
    actions,
    askP2p,
    closedDms,
    detached,
    dmPager,
    dropDeleted,
    dropEditIn,
    dropLinkCards,
    fetchPage,
    findMessage,
    firstPage,
    forgetPending,
    forgetViews,
    headLoad,
    historyGen,
    liveKey,
    loadAround,
    loadPins,
    loadingHead,
    mapTails,
    newHistory,
    openMessageAt,
    patchReactions,
    reauthorLinkCards,
    reopenDm,
    tails,
    views,
    mapLists,
    bumpDmGen: () => {
      dmGen += 1
    },
    forget,
  }
}
