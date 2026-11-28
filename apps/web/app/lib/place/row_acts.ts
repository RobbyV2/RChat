import type { ReactNode } from 'react'
import { actionPress, openActionMenu } from '../actions/menu'
import { peerChat } from '../actions/p2p_chat'
import type { AccountSession } from '../client/session'
import { limitsOf } from '../instance_limits'
import type { MessageKey } from '../media_lightbox'
import { chatKey, threadKey as peerThreadKey } from '../p2p/app'
import { identityScopeKey } from '../p2p/app/host'
import { chatScope, threadScope } from '../p2p/app/store'
import { LIMITS as P2P_LIMITS } from '../p2p/content'
import type { P2pMessage } from '../p2p/dm'
import { time } from '../platform/time'
import { isSelected } from '../selection'
import { threadKey } from '../store'
import { isNotice } from '../system_messages'
import type { Message } from '../types'
import { viewKey } from '../view'
import type { ComposerList } from './composer'
import { defineFeature } from './feature'
import { built, type Live } from './live'
import { messages } from './messages'
import { P2pDm, P2pRoom, type Place } from './place'
import { accountRows, rows, type RowFlags, type RowsState } from './rows'
import { shownOf } from './shown'
import { thread } from './thread'
import { featureAt, isUnsupported } from './feature'

// The edit box of a message being edited in place: its text, and what saves or leaves it.
export interface EditBinding {
  max: number
  text: string
  listKey: string
  focus: number
  getText: () => string
  setText: (text: string) => void
  save: (fine: boolean) => void
  cancel: (fine: boolean) => void
  // The description of the message's image, when it has one.
  alt?: { text: string; set: (text: string) => void }
}

// The edit in progress in a list: the key of the message (as the place writes it) and its box.
export interface RowEdit {
  key: string
  binding: EditBinding
}

// What a list does for its rows, whichever place it is in.
export interface RowActs {
  // Opens the row's menu at a point; `quick` heads it where the reader may react.
  menu: (m: Message, x: number, y: number, quick: ReactNode) => void
  // Shows the message a quote answers: in the list, or in the conversation for a quote in the
  // thread's first message (`root`).
  jump: (id: number, root: boolean) => void
  edit: (m: Message) => void
  reply: (m: Message) => void
  // Puts the row on the forward clipboard.
  forward: (m: Message) => void
  thread: (m: Message) => void
  remove: (m: Message, skipConfirm: boolean) => void
  // Sends a failed message again.
  retry: (m: Message) => void
  // What forwards the message with `key` from the image viewer; null when it is not listed.
  forwardShown: (key: MessageKey) => ((x: number, y: number) => void) | null
  editing: Live<RowEdit | null>
}

export interface RowActsOf {
  at: (list: ComposerList) => RowActs
}

const perList = (make: (list: ComposerList) => RowActs): RowActsOf => {
  const made = new Map<ComposerList, RowActs>()
  return {
    at: list => {
      let known = made.get(list)
      if (!known) {
        known = make(list)
        made.set(list, known)
      }
      return known
    },
  }
}

// The row's flags as they stand now.
const flagsNow = (state: Live<RowsState>, m: Message, root: boolean): RowFlags => {
  const now = state.get()
  return now.of(m, { timedOut: now.until !== null && now.until > time().now(), root })
}

const hosted = (account: AccountSession, flags: (list: ComposerList) => Live<RowsState>) =>
  perList(list => {
    const { store } = account
    const inThread = list === 'thread'
    const root = () => {
      const s = store.getState()
      return inThread && s.panel?.kind === 'thread' ? s.panel.root : null
    }
    const key = (initial = false) => {
      const s = initial ? store.getInitialState() : store.getState()
      if (inThread) return s.panel?.kind === 'thread' ? threadKey(s.panel.root.id) : null
      return s.view ? viewKey(s.view) : null
    }
    const mainKey = (m: Message) =>
      m.channel_id !== null ? `c${m.channel_id}` : m.dm_id !== null ? `d${m.dm_id}` : null
    const at = (run: (key: string) => void) => {
      const k = key()
      if (k !== null) run(k)
    }
    const editing = (initial: boolean) =>
      built(
        () => {
          const s = initial ? store.getInitialState() : store.getState()
          const k = key(initial)
          const e = s.editing !== null && s.editing.key === k ? s.editing : null
          return [
            k,
            e?.id ?? null,
            e?.text ?? '',
            e?.focus ?? 0,
            e?.alt,
            limitsOf(s.instance).message_chars,
          ] as const
        },
        ([k, id, text, focus, alt, max]): RowEdit | null =>
          k === null || id === null
            ? null
            : {
                key: String(id),
                binding: {
                  max,
                  text,
                  listKey: k,
                  focus,
                  getText: () => store.getState().editing?.text ?? '',
                  setText: next => store.getState().setEditText(next),
                  save: fine => void store.getState().saveEdit(fine),
                  cancel: fine => store.getState().cancelEdit(fine),
                  ...(alt === undefined
                    ? {}
                    : { alt: { text: alt, set: next => store.getState().setEditAlt(next) } }),
                },
              }
      )
    return {
      menu: (m, x, y, quick) =>
        at(k => {
          const first = root()?.id === m.id
          const s = store.getState()
          if (!first && s.selection?.scope === k && isSelected(s.selection, m))
            return openActionMenu(
              x,
              y,
              { kind: 'selection', list: k, author: m.author },
              undefined,
              account
            )
          const react = !isNotice(m) && flagsNow(flags(list), m, first).canReact
          openActionMenu(
            x,
            y,
            { kind: 'message', message: m, list: k },
            react ? { header: quick } : undefined,
            account
          )
        }),
      jump: (id, first) => {
        const r = root()
        const k = first && r ? mainKey(r) : key()
        if (k !== null) void store.getState().jumpTo(k, id)
      },
      edit: m => at(k => store.getState().startEdit(k, m)),
      reply: m => at(k => store.getState().startReply(k, m)),
      forward: m => store.getState().copyForward(m),
      thread: m => {
        if (!inThread) void store.getState().openThread(m)
      },
      remove: (m, skipConfirm) => store.menu.confirmDeleteMessage(m.id, skipConfirm),
      retry: () => {},
      forwardShown: id => {
        const k = key()
        const r = root()
        const m =
          k === null
            ? undefined
            : r?.id === id
              ? r
              : store.getState().messages[k]?.find(x => x.id === id)
        return m && k !== null
          ? actionPress('message_forward', { kind: 'message', message: m, list: k }, account)
          : null
      },
      editing: {
        get: editing(false),
        initial: editing(true),
        subscribe: changed => store.subscribe(changed),
      },
    }
  })

const peer = (place: P2pRoom | P2pDm): RowActsOf =>
  perList(list => {
    const { app, room, account } = place
    const { useP2p, p2pDm } = app
    const here =
      place.kind === 'p2pRoom' ? P2pRoom.open(app, room, list) : P2pDm.open(app, room, list)
    const shown = shownOf(here)
    const inThread = list === 'thread'
    const acts = peerChat.forIdentity(app)
    const listed = featureAt(rows, place)
    const flags = (isUnsupported(listed) ? accountRows(account) : listed).at(list)
    type PeerState = ReturnType<typeof useP2p.getState>
    // Where replies and edits of the list go, and the key its scroll position goes by.
    const keys = (s: PeerState) => {
      if (inThread) {
        const t = s.thread !== null && s.thread.room === room ? s.thread : null
        return t === null
          ? null
          : { draft: peerThreadKey(t), scope: identityScopeKey(app.localId, threadScope(t)) }
      }
      const c = s.chat !== null && s.chat.room === room ? s.chat : null
      return c === null
        ? null
        : {
            draft: chatKey(c),
            scope: identityScopeKey(app.localId, chatScope(c.room, c.ch)),
          }
    }
    const ownName = (ik: string) => app.profileName(ik, place.kind === 'p2pRoom' ? room : undefined)
    // The contact a forward from their own conversation skips.
    const forwardSkip = () => {
      if (place.kind !== 'p2pDm' || inThread) return null
      const s = useP2p.getState()
      return (s.chat?.room === room ? s.chat.peer : s.rooms[room]?.peer) ?? null
    }
    const stored = (m: Message) => {
      const now = shown.get()
      const id = now.idOf(m.id)
      return id === null ? undefined : now.message(id)
    }
    const withStored = (m: Message, run: (p: P2pMessage, draft: string) => void) => {
      const p = stored(m)
      const k = keys(useP2p.getState())
      if (p && k) run(p, k.draft)
    }
    const isRoot = (p: P2pMessage) => inThread && useP2p.getState().thread?.root === p.id
    const target = (p: P2pMessage, m: Message, draft: string) =>
      ({
        kind: 'p2p_message',
        p,
        m,
        row: flagsNow(flags, m, isRoot(p)),
        chat: { draftKey: draft, forwardSkip: forwardSkip(), ownName },
      }) as const
    const editing = (initial: boolean) =>
      built(
        () => {
          const s = initial ? useP2p.getInitialState() : useP2p.getState()
          const k = keys(s)
          const e =
            s.editing !== null && k !== null && s.editing.room === k.draft ? s.editing : null
          return [k?.scope ?? null, e?.id ?? null, e?.text ?? '', e?.focus ?? 0, e?.alt] as const
        },
        ([scope, id, text, focus, alt]): RowEdit | null =>
          scope === null || id === null
            ? null
            : {
                key: id,
                binding: {
                  max: P2P_LIMITS.body,
                  text,
                  listKey: scope,
                  focus,
                  getText: () => useP2p.getState().editing?.text ?? '',
                  setText: p2pDm.setEditText,
                  save: fine => void p2pDm.saveEdit(fine),
                  cancel: fine => p2pDm.cancelEdit(fine),
                  ...(alt ? { alt: { text: alt.text, set: p2pDm.setEditAlt } } : {}),
                },
              }
      )
    return {
      menu: (m, x, y, quick) =>
        withStored(m, (p, draft) => {
          if (p.system?.kind === 'pin')
            return openActionMenu(x, y, { kind: 'p2p_pin_line', p, m }, undefined, account, app)
          const t = target(p, m, draft)
          openActionMenu(x, y, t, t.row.canReact ? { header: quick } : undefined, account, app)
        }),
      jump: (n, first) => {
        const id = shown.get().idOf(n)
        if (id === null) return
        if (!inThread) {
          const main = featureAt(messages, place)
          if (!isUnsupported(main)) main.jump(id)
          return
        }
        const open = featureAt(thread, place)
        if (isUnsupported(open)) return
        if (first) open.jumpMain(id)
        else open.jump(id)
      },
      edit: m => withStored(m, (p, draft) => p2pDm.startEdit(draft, p.id)),
      reply: m => withStored(m, (p, draft) => p2pDm.startReply(draft, p.id)),
      forward: m =>
        withStored(m, (p, draft) => acts.copyForP2p(p, m, ownName(p.sender), draft, account)),
      thread: m => withStored(m, p => void app.p2pThread.open(p.id)),
      remove: (m, skipConfirm) =>
        withStored(m, p => acts.confirmDelete(p.id, skipConfirm, account)),
      retry: m => withStored(m, p => void p2pDm.retry(p.id)),
      forwardShown: id => {
        const row = typeof id === 'string' ? shown.get().rows.find(r => r.p.id === id) : undefined
        const k = keys(useP2p.getState())
        return row && k
          ? actionPress('p2p_message_forward', target(row.p, row.m, k.draft), account, app)
          : null
      },
      editing: {
        get: editing(false),
        initial: editing(true),
        subscribe: changed => useP2p.subscribe(changed),
      },
    }
  })

const hostedAt = (place: Place): RowActsOf => {
  const listed = featureAt(rows, place)
  return hosted(place.account, list =>
    (isUnsupported(listed) ? accountRows(place.account) : listed).at(list)
  )
}

// What the lists of a place do for their rows: the menu, the row actions, and the edit in place.
export const rowActs = defineFeature<RowActsOf>('rowActs', {
  hostedServer: hostedAt,
  p2pRoom: peer,
  hostedDm: hostedAt,
  p2pDm: peer,
})

const own = new WeakMap<AccountSession, RowActsOf>()

// The account's own row acts, for a list shown with no place around it.
export const accountRowActs = (account: AccountSession): RowActsOf => {
  let known = own.get(account)
  if (!known) {
    known = hosted(account, list => accountRows(account).at(list))
    own.set(account, known)
  }
  return known
}
