// The menus of P2P conversations, channels and threads: a message, a pin line, the call
// buttons' chevrons, an account badge and the rail's P2P tile.

import {
  ArrowRight,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Forward,
  Hash,
  MessageSquareText,
  MessagesSquare,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Reply,
  Server,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react'
import { fmtSize } from '../bytes'
import { P2P_IP_HINT, ROUTE_LABEL } from '../call_choice'
import type { AccountSession } from '../client/session'
import { sourceAccess } from '../forward_viewing'
import {
  forwardSourceDefault,
  fwdSource,
  p2pSourceNames,
  type ForwardClip,
  type ForwardSource,
} from '../forward'
import { p2pPill } from '../forward_pill'

import { isEventId, readFwdSrc, type Attachment, type Fwd } from '../p2p/content'
import { displayName } from '../p2p/contacts'
import { messageActs, type P2pMessage } from '../p2p/dm'
import { sharing } from '../platform'
import { displayHost, hostOf, manualRelays } from '../relays'
import { plainLine } from '../replies'
import { downloadName } from '../sniff'
import { maskOf } from '../store'
import { messageStampToken } from '../timestamps'
import type { Message } from '../types'
import { hidesIp } from './voice'
import type { Action, ActionCtx, ArgChoice } from './types'
import { identityActions } from './identity'
export const threadAct = (p: P2pMessage, canAct: boolean) =>
  p.system || p.call || p.thread || p.noThread || p.archived
    ? null
    : p.replies
      ? 'View thread'
      : canAct && !p.unavailable
        ? 'Create thread'
        : null

export const peerChat = identityActions(identity => {
  const copy = (text: string) => void sharing().copyText(text)

  const seconds = (ms: number) => Math.floor(ms / 1000)

  // "Create thread" on a message without replies that we may answer, "View thread" once it has
  // some.
  // A message whose body isn't here ("Message unavailable") keeps its thread reachable; one from
  // the copy a server was transferred from has none here.
  const confirmDelete = (id: string, skip = false, acct = identity().owner) => {
    const run = () => void identity().p2pDm.remove(id)
    if (skip) return run()
    const server = !!identity().useP2p.getState().chat?.ch
    acct.store.getState().askConfirm({
      title: 'Delete Message',
      body: server
        ? 'Delete this message? It is removed here now, and on other members’ devices as they sync.'
        : 'Delete this message? It is removed here now, and on the other device the next time you are both online.',
      confirm: 'Delete',
      action: identity().inIdentity(run),
    })
  }

  const ownsSource = (account: AccountSession) => {
    const app = identity()
    return app.isCurrent() && account === app.owner && account.identities.get(app.localId) === app
  }

  const sourceOf = (draftKey: string): ForwardSource => {
    const [room, ch] = draftKey.split('#')[0].split('/')
    const localId = identity().localId
    const slot = localId === 'main' ? {} : { identity: localId }
    return ch ? { kind: 'p2p', room, ch, ...slot } : { kind: 'direct', ...slot }
  }

  // Puts a message on the forward clipboard: Send in another conversation forwards it there (a
  // P2P one directly; an instance one after it says the text will be copied there).
  const copyForP2p = (
    p: P2pMessage,
    m: Message,
    author: string,
    draftKey: string,
    acct = identity().owner
  ) => {
    if (!ownsSource(acct)) return
    const clip: ForwardClip = {
      id: 1 + Math.floor(Math.random() * 2 ** 40),
      author: p.fwd ? (m.forward?.author ?? null) : identity().p2pUser(p.sender, author),
      snippet: plainLine(p.fwd ? p.fwd.body : p.body),
      has_media: !!(p.att?.length || p.fwd?.att?.length),
      created_at: p.fwd ? seconds(p.fwd.ts) : m.created_at,
      body: p.fwd ? p.fwd.body : p.body,
      p2p: true,
      source: sourceOf(draftKey),
      ...(isEventId(p.id) ? { ev: p.id } : {}),
      sent_ts: p.fwd ? p.fwd.ts : p.sentTs,
    }
    acct.store.getState().copyForwardClip(clip)
  }

  // Forwards straight into a P2P conversation with a contact. `author`: the sender's own profile
  // name (profileName), never a display string. A forward of a forward keeps its author, time and
  // text, and names this message and its place as where it's from, by default.
  const forwardTo = async (
    ik: string,
    p: P2pMessage,
    author: string,
    acct: AccountSession,
    draftKey: string
  ) => {
    const source = sourceOf(draftKey)
    const allowed = () =>
      ownsSource(acct) && sourceAccess(acct.store.getState(), source, undefined, acct) === 'open'
    if (!allowed()) return
    const target = await identity().p2pDm.ensureRoom(ik)
    if (!target || !allowed()) return
    const s = acct.store.getState()
    const show =
      forwardSourceDefault({ source }, { kind: 'p2p', room: target, ch: null }, s, s.settings) ??
      false
    const names =
      source.kind === 'p2p'
        ? p2pSourceNames(identity().useP2p.getState().servers[source.room], source.ch)
        : null
    const src = fwdSource(source, names, show)
    const fwd: Fwd = {
      ...(p.fwd
        ? {
            name: p.fwd.name,
            ts: p.fwd.ts,
            body: p.fwd.body,
            ...(p.fwd.att ? { att: p.fwd.att } : {}),
          }
        : {
            name: author,
            ts: p.sentTs,
            body: p.body,
            ...(p.att.length ? { att: p.att } : {}),
          }),
      ...(isEventId(p.id) ? { ev: p.id } : {}),
      ...(src ? { src } : {}),
    }
    if ((await identity().p2pDm.forward(target, fwd)) && allowed()) {
      const c = identity()
        .useP2p.getState()
        .contacts.find(x => x.ik === ik)
      const s = acct.store.getState()
      identity().p2pHost.toast('Forwarded to', c ? maskOf(s)(displayName(c)) : 'contact')
    }
  }

  const startDownload = (att: Attachment, acct = identity().owner) => {
    const run = () => void identity().p2pFiles.download(att)
    if (att.size <= identity().p2p.limits().files.bigFile) return run()
    acct.store.getState().askConfirm({
      title: 'Download a large file',
      body: `This file is ${fmtSize(att.size)}. It is stored on this device and shared with others in this conversation.`,
      confirm: 'Download',
      action: identity().inIdentity(run),
    })
  }

  // What a message's attachment row offers now: save what is here, download what isn't, or cancel
  // a download.
  interface FileRow {
    h: string
    name: string
    verb: string
    icon: LucideIcon
    disabled: boolean
    run(): void
  }

  const fileRow = (att: Attachment, canFetch: boolean, acct = identity().owner): FileRow => {
    const v = identity().useP2p.getState().files[att.h]
    const name = maskOf(acct.store.getState(), false, true)(downloadName(att.name))
    if (v?.state === 'done')
      return {
        h: att.h,
        name,
        verb: 'Save',
        icon: Download,
        disabled: false,
        run: () => void identity().p2pFiles.save(att),
      }
    const busy = v?.state === 'downloading'
    return {
      h: att.h,
      name,
      verb: busy ? 'Cancel download' : 'Download',
      icon: busy ? X : Download,
      disabled: !busy && (!canFetch || !v || v.holders === 0),
      run: () => (busy ? void identity().p2pFiles.cancel(att.h) : startDownload(att, acct)),
    }
  }

  const COPY = 'copy'

  const rowOf = ({ target }: ActionCtx) => (target.kind === 'p2p_message' ? target : null)

  // What may be done with the message: `act` (not read-only, nor from an old copy), `write` (no
  // timeout of ours either), and its acts.
  const actsOf = (ctx: ActionCtx) => {
    const t = rowOf(ctx)
    if (!t) return null
    const act = t.chat.canAct && !t.p.archived
    const write = act && !t.chat.timedOut
    const me = identity().useP2p.getState().me
    return { ...t, act, write, can: messageActs(t.p, write, t.p.sender === me) }
  }

  const filesOf = (ctx: ActionCtx) => {
    const t = rowOf(ctx)
    return t ? (t.p.fwd?.att ?? t.p.att).map(att => fileRow(att, t.chat.canAct, ctx.acct)) : []
  }

  const oneFile = (ctx: ActionCtx) => {
    const files = filesOf(ctx)
    return files.length === 1 ? files[0] : null
  }

  // Where a forwarded copy's original is, as this identity holds it.
  const originOf = (ctx: ActionCtx) => {
    const t = rowOf(ctx)
    if (!t?.p.fwd) return null
    const f = readFwdSrc(t.p.fwd)
    const at = f.ev ? identity().eventPlace(f.ev) : null
    const pill = p2pPill(f, at, identity().useP2p.getState().servers)
    return at && f.ev ? { ev: f.ev, at, pill } : null
  }

  const forwardChoices = (ctx: ActionCtx): ArgChoice[] => {
    const t = rowOf(ctx)
    if (!t) return []
    const mask = maskOf(ctx.s)
    return [
      ...identity()
        .useP2p.getState()
        .contacts.filter(c => c.state === 'mutual' && c.ik !== t.chat.forwardSkip)
        .map(c => ({ value: c.ik, label: mask(displayName(c)), name: true })),
      { value: COPY, label: 'Copy for forwarding', icon: Copy },
    ]
  }

  // A message's row, or a pin line's.
  const shownOf = ({ target }: ActionCtx) =>
    target.kind === 'p2p_message' || target.kind === 'p2p_pin_line' ? target : null

  const pinLineOf = ({ target }: ActionCtx) => (target.kind === 'p2p_pin_line' ? target : null)

  const onMessage = { scope: 'p2p', targets: ['p2p_message'] } as const
  const onShown = { scope: 'p2p', targets: ['p2p_message', 'p2p_pin_line'] } as const
  const onPinLine = { scope: 'p2p', targets: ['p2p_pin_line'] } as const

  const messageActions: Action[] = [
    {
      id: 'p2p_message_reply',
      title: 'Reply',
      icon: Reply,
      ...onMessage,
      order: 100,
      available: ctx => !!actsOf(ctx)?.can.reply,
      run: ctx => {
        const t = rowOf(ctx)
        if (t) identity().p2pDm.startReply(t.chat.draftKey, t.p.id)
      },
    },
    {
      id: 'p2p_message_edit',
      title: 'Edit Message',
      icon: Pencil,
      ...onMessage,
      order: 110,
      available: ctx => !!actsOf(ctx)?.can.edit,
      run: ctx => {
        const t = rowOf(ctx)
        if (t) identity().p2pDm.startEdit(t.chat.draftKey, t.p.id)
      },
    },
    {
      id: 'p2p_message_forward',
      title: 'Forward',
      icon: Forward,
      ...onMessage,
      order: 120,
      args: [{ kind: 'choice', name: 'to', prompt: 'Forward to', choices: forwardChoices }],
      available: ctx => !!actsOf(ctx)?.can.forward,
      run: (ctx, { to }) => {
        const t = rowOf(ctx)
        if (!t) return
        const author = t.chat.ownName(t.p.sender)
        if (to === COPY) copyForP2p(t.p, t.m, author, t.chat.draftKey, ctx.acct)
        else void forwardTo(to, t.p, author, ctx.acct, t.chat.draftKey)
      },
    },
    {
      id: 'p2p_message_open_original',
      title: 'Open original message',
      icon: ExternalLink,
      ...onMessage,
      order: 125,
      available: ctx => {
        const pill = originOf(ctx)?.pill
        return pill?.kind === 'open' || (pill?.kind === 'dm' && pill.open)
      },
      run: ctx => {
        const o = originOf(ctx)
        if (o) void identity().p2pOpenAt(o.at.room, o.at.ch, o.ev)
      },
    },
    {
      id: 'p2p_message_open_source_room',
      title: 'Open server',
      icon: Server,
      ...onMessage,
      order: 126,
      available: ctx => originOf(ctx)?.pill.kind === 'open',
      run: ctx => {
        const o = originOf(ctx)
        if (o?.pill.kind === 'open') void identity().p2pServer.open(o.at.room)
      },
    },
    {
      id: 'p2p_message_thread',
      title: 'Open thread',
      label: ctx => {
        const t = actsOf(ctx)
        return (t && threadAct(t.p, t.write && t.chat.can.threads)) ?? 'Open thread'
      },
      icon: MessageSquareText,
      ...onMessage,
      order: 130,
      available: ctx => {
        const t = actsOf(ctx)
        return !!t && t.chat.threads && threadAct(t.p, t.write && t.chat.can.threads) !== null
      },
      run: ctx => {
        const t = rowOf(ctx)
        if (t) void identity().p2pThread.open(t.p.id)
      },
    },
    {
      id: 'p2p_message_pin',
      title: 'Pin Message',
      icon: Pin,
      ...onMessage,
      order: 300,
      available: ctx => {
        const t = actsOf(ctx)
        return !!t && t.write && t.chat.mayPin && !t.p.thread && t.p.pinned === null
      },
      run: ctx => {
        const t = rowOf(ctx)
        if (t) void identity().p2pDm.pin(t.p.id, true)
      },
    },
    {
      id: 'p2p_message_unpin',
      title: 'Unpin Message',
      icon: PinOff,
      ...onMessage,
      order: 300,
      available: ctx => {
        const t = actsOf(ctx)
        return !!t && t.write && t.chat.mayPin && !t.p.thread && t.p.pinned !== null
      },
      run: ctx => {
        const t = rowOf(ctx)
        if (t) void identity().p2pDm.pin(t.p.id, false)
      },
    },
    {
      id: 'p2p_message_delete',
      title: 'Delete Message',
      icon: Trash2,
      danger: true,
      ...onMessage,
      order: 510,
      available: ctx => {
        const t = actsOf(ctx)
        return !!t && t.act && t.chat.mayDelete(t.p)
      },
      run: ctx => {
        const t = rowOf(ctx)
        if (t) confirmDelete(t.p.id, undefined, ctx.acct)
      },
    },
    {
      // One attachment: "Save attachment", "Download attachment" or "Cancel download attachment".
      id: 'p2p_message_file',
      title: 'Attachment',
      label: ctx => `${oneFile(ctx)?.verb ?? 'Download'} attachment`,
      subtitle: ctx => oneFile(ctx)?.name,
      icon: Download,
      iconFor: ctx => oneFile(ctx)?.icon ?? Download,
      ...onMessage,
      order: 600,
      disabled: ctx => oneFile(ctx)?.disabled ?? true,
      available: ctx => oneFile(ctx) !== null,
      run: ctx => {
        const f = oneFile(ctx)
        if (f && !f.disabled) f.run()
      },
    },
    {
      id: 'p2p_message_files',
      title: 'Attachments',
      icon: Download,
      ...onMessage,
      order: 600,
      args: [
        {
          kind: 'choice',
          name: 'file',
          prompt: 'Attachment',
          choices: ctx =>
            filesOf(ctx).map(f => ({
              value: f.h,
              label: f.name,
              subtitle: f.verb,
              icon: f.icon,
              disabled: f.disabled,
            })),
        },
      ],
      disabled: ctx => filesOf(ctx).every(f => f.disabled),
      available: ctx => filesOf(ctx).length > 1,
      run: (ctx, { file }) => {
        const f = filesOf(ctx).find(x => x.h === file)
        if (f && !f.disabled) f.run()
      },
    },
    {
      id: 'p2p_message_copy_text',
      title: 'Copy Text',
      icon: Copy,
      ...onMessage,
      order: 800,
      available: ctx => !!actsOf(ctx)?.can.copy,
      run: ctx => {
        const t = rowOf(ctx)
        if (t) copy(t.p.fwd ? t.p.fwd.body : t.p.body)
      },
    },
    {
      id: 'p2p_message_copy_timestamp',
      title: 'Copy Timestamp',
      icon: Clock,
      ...onShown,
      order: 810,
      available: ctx => shownOf(ctx) !== null,
      run: ctx => {
        const t = shownOf(ctx)
        if (t) copy(messageStampToken(t.m.created_at))
      },
    },
    {
      id: 'p2p_message_copy_id',
      title: 'Copy Message ID',
      icon: Hash,
      ...onShown,
      order: 820,
      available: ctx => shownOf(ctx) !== null,
      run: ctx => {
        const t = shownOf(ctx)
        if (t) copy(t.p.id)
      },
    },
  ]

  const pinLineActions: Action[] = [
    {
      id: 'p2p_pin_jump',
      title: 'Jump to Message',
      icon: ArrowRight,
      ...onPinLine,
      order: 100,
      available: ctx => !!pinLineOf(ctx)?.p.system?.target,
      run: ctx => {
        const target = pinLineOf(ctx)?.p.system?.target
        if (target) void identity().p2pDm.jumpTo(target)
      },
    },
    {
      id: 'p2p_pin_list',
      title: 'Pinned Messages',
      icon: Pin,
      ...onPinLine,
      order: 110,
      available: ctx => pinLineOf(ctx) !== null,
      run: () => void identity().p2pDm.openPins(),
    },
  ]

  const callOf = ({ target }: ActionCtx) => (target.kind === 'p2p_call' ? target : null)

  const onCall = { scope: 'p2p', targets: ['p2p_call'] } as const

  // A call with a contact is always direct; a relay of the user's own serves this call only.
  const callActions: Action[] = [
    {
      id: 'p2p_call_direct',
      title: 'Call direct (P2P)',
      label: () => ROUTE_LABEL.p2p,
      ...onCall,
      order: 100,
      radio: true,
      wrap: true,
      subtitle: ({ s }) => (hidesIp(s) ? undefined : P2P_IP_HINT),
      checked: () => true,
      available: ctx => callOf(ctx) !== null,
      run: ctx => {
        const t = callOf(ctx)
        if (t) void identity().p2pCall.start(t.peer, t.video)
      },
    },
    {
      id: 'p2p_call_relay',
      title: 'Call direct through a relay',
      ...onCall,
      order: 120,
      available: ctx => callOf(ctx) !== null,
      expand: ({ s }) =>
        manualRelays(s.relayPrefs).map(r => ({
          key: r.url,
          label: `Direct through ${displayHost(hostOf(r.url) ?? r.url)}`,
          wrap: true,
          args: { relay: r.url },
        })),
      run: (ctx, { relay }) => {
        const t = callOf(ctx)
        if (t && relay) void identity().p2pCall.start(t.peer, t.video, relay)
      },
    },
  ]

  const badgeOf = ({ target }: ActionCtx) => (target.kind === 'p2p_badge' ? target : null)

  const onBadge = { scope: 'p2p', targets: ['p2p_badge'] } as const

  const badgeActions: Action[] = [
    {
      id: 'p2p_badge_recheck',
      title: 'Check again',
      icon: RefreshCw,
      ...onBadge,
      order: 100,
      available: ctx => !!badgeOf(ctx)?.stale,
      run: ctx => {
        const t = badgeOf(ctx)
        if (t) identity().p2pBadge.recheck(t.ik)
      },
    },
    {
      id: 'p2p_badge_copy',
      title: 'Copy account',
      icon: Copy,
      ...onBadge,
      order: 110,
      available: ctx => {
        const t = badgeOf(ctx)
        return !!t && !t.stale && !!t.sub
      },
      run: ctx => {
        const sub = badgeOf(ctx)?.sub
        if (sub) copy(sub)
      },
    },
  ]

  // The palette's Threads list of the open P2P conversation or server channel.
  const placeActions: Action[] = [
    {
      id: 'p2p_threads',
      title: 'Show threads',
      icon: MessagesSquare,
      scope: 'p2p',
      keywords: ['thread', 'replies'],
      available: () => {
        const st = identity().useP2p.getState()
        return !!st.chat && (st.server !== null ? !!st.chat.ch : st.home)
      },
      run: () => identity().p2pDm.openThreads(),
    },
  ]

  const p2pChatActions: Action[] = [
    ...messageActions,
    ...pinLineActions,
    ...callActions,
    ...badgeActions,
    ...placeActions,
  ]

  return { actions: p2pChatActions, threadAct, confirmDelete, copyForP2p, forwardTo, startDownload }
})
export const p2pChatActions = peerChat.actions
