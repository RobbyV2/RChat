'use client'
import { openPeerLink } from '../lib/client/peer_links'
import { ViewActorTag } from './view_actor'
import { P2pProvider, useP2pApp, useP2p } from '../lib/client/p2p_react'
import type { P2pApp } from '../lib/p2p/app/runtime'

import { AccountProvider, useAccount, useLiveSessions } from '../lib/client/react'

import { useMemo, useState, useId, useSyncExternalStore, type ReactNode } from 'react'
import { logoutForLogin } from '../login/account_login'
import { useRouter } from 'next/navigation'
import {
  Bell,
  CheckCheck,
  Command,
  Compass,
  Hash,
  House,
  Lightbulb,
  LogIn,
  Menu,
  MessageCircle,
  Pin,
  Plus,
  QrCode,
  UserPlus,
  Users,
  Volume2,
  Waypoints,
  X,
} from 'lucide-react'
import {
  allPings,
  dmsMarkTargets,
  scopeMarkTargets,
  scopePingCount,
  scopeUnread,
  serversMarkTargets,
  useMask,
  useStore,
} from '../lib/store'
import {
  INBOX_SHOWN,
  PINNED_SHOWN,
  RECENTS_SHOWN,
  greeting,
  isNewAccount,
  recentKey,
  recentShown,
  shownTips,
  type Recent,
} from '../lib/home'
import { parseSummary, useHome } from '../lib/home_store'
import { isMac, paletteShortcut, usePalette } from '../lib/palette'
import { openActionMenu } from '../lib/actions/menu'
import type { Target } from '../lib/actions/types'
import { dmSections } from '../lib/nav_layout'
import { passwordSignup } from '../lib/features'
import { accountBenefits, guestHomeLine } from '../lib/guest_chat'
import { enterKey } from '../lib/keys'
import type { DmSummary } from '../lib/types'
import { longPress } from './context_menu'
import { dragScope, useDrag } from './drag'
import { InboxButton, InboxPreview, useInboxCount } from './inbox'
import { PaletteButton } from './palette'
import { FriendsSection } from './friends'
import { PingBadge, pingLabel } from './ping_badge'
import { TypingEllipsis, useHostedTypers } from './typing_indicator'
import { ServerGlyph } from './server_rail'
import StatusClock from './status_clock'
import { UserAvatar } from './user_avatar'
import { Masked, SkeletonRows, fieldCls, filledBtn, textBtn, useOwnServer } from './ui'
import { type P2pState } from '../lib/p2p/app'
import type { P2pDialog } from '../lib/p2p/app/store'
import { cardRows, homeCard, onlineText, p2pEntry, type CardState } from '../lib/p2p/home_card'
import { p2pUnread, type P2pUnreadRow } from '../lib/p2p/alerts'
import { displayName } from '../lib/p2p/contacts'
import { ownsP2pServer } from '../lib/p2p/server/types'
import { placesOf } from '../lib/p2p/palette_source'
import { mutedOf, levelOf } from '../lib/notify'
import { serverInitial } from '../lib/rules'
import { KeyAvatar, P2pBadge, PresenceDot } from './p2p/p2p_badge'
import { ElsewhereNotice } from './p2p/p2p_home'
import { LabelText, useInstanceLabel } from './instance_badge'

import { client } from '../lib/client/client'
import { ownInstance } from '../lib/instances'
import { createSwitcherSource } from '../lib/client/switcher_rows'
import { switchActor, switcherSession } from '../lib/client/switch_actor'
import { routeName } from '../lib/client/route_name'
import { homeActors, type HomeActor } from '../lib/client/home_actors'
import type { AccountSession } from '../lib/client/session'
import { useAddingAllowed } from './add_instance'
import { AccountTag, ActorAvatar } from './account_tag'

function showOwner(account: AccountSession, peer?: P2pApp | null) {
  if (client.shown() !== account) client.show(account)
  if (peer && account.identities.viewed() !== peer) account.identities.show(peer)
}

const card = 'flex min-w-0 flex-col gap-1 rounded-3xl bg-surface-container-low p-4'

const rowCls =
  'group flex w-full min-w-0 items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-primary'

function Card({
  title,
  icon,
  action,
  children,
  className = '',
}: {
  title: string
  icon: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  const id = `home-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`
  return (
    <section aria-labelledby={id} className={`${card} ${className}`}>
      <div className="flex min-h-9 items-center gap-2 px-2">
        <span className="text-on-surface-variant">{icon}</span>
        <h2 id={id} className="font-medium text-on-surface">
          {title}
        </h2>
        <span className="ml-auto flex items-center">{action}</span>
      </div>
      {children}
    </section>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-2 py-3 text-sm text-on-surface-variant">{children}</p>
}

// A pinned DM's end: typing dots before its ping count, else its unread mark.
function DmEnd({ id, unread, pings }: { id: number; unread: boolean; pings: number }) {
  const typers = useHostedTypers([`d${id}`], null)
  if (!typers.length) return <UnreadMark unread={unread} pings={pings} />
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5">
      <TypingEllipsis names={typers} />
      <PingBadge count={pings} />
    </span>
  )
}

function UnreadMark({ unread, pings }: { unread: boolean; pings: number }) {
  if (pings > 0) return <PingBadge count={pings} className="ml-auto" />
  if (!unread) return null
  return (
    <span
      title="Unread"
      aria-label="Unread"
      role="img"
      className="ml-auto size-2 shrink-0 rounded-full bg-error"
    />
  )
}

function Greeting({ total, accounts = 1 }: { total?: number; accounts?: number } = {}) {
  const me = useStore(s => s.me)
  const streamer = useStore(s => s.streamer)
  const pings = useInboxCount()
  const [hour] = useState(() => new Date().getHours())
  return (
    <div className="flex flex-col gap-1 px-1">
      <h1 className="text-2xl font-semibold text-on-surface sm:text-3xl">
        {streamer || !me ? (
          'Welcome back'
        ) : (
          <>
            {greeting(hour)},{' '}
            <span className="streamer">
              <Masked text={me.display_name} own />
            </span>
          </>
        )}
      </h1>
      <p className="text-sm text-on-surface-variant">
        {accounts > 1
          ? `You have ${pingLabel(total ?? pings)} across ${accounts} accounts.`
          : (total ?? pings) > 0
            ? `You have ${pingLabel(total ?? pings)}.`
            : "You're all caught up."}
      </p>
    </div>
  )
}

function Tips() {
  const acct = useAccount()
  const prefs = useHome(s => s.prefs)
  const tips = shownTips(prefs)
  if (!tips.length) return null
  return (
    <ul aria-label="Tips" className="flex flex-col gap-2">
      {tips.map(t => (
        <li
          key={t.id}
          data-tip={t.id}
          className="flex items-center gap-3 rounded-2xl bg-tertiary-container py-2 pr-2 pl-4 text-sm text-on-tertiary-container"
        >
          <Lightbulb size={16} className="shrink-0" />
          <span className="min-w-0 flex-1">{t.text}</span>
          <button
            type="button"
            title="Dismiss tip"
            aria-label="Dismiss tip"
            onClick={() => acct.home.hideTip(t.id)}
            className="shrink-0 rounded-full p-1.5 hover:bg-on-tertiary-container/10"
          >
            <X size={16} />
          </button>
        </li>
      ))}
    </ul>
  )
}

const actionCls =
  'flex min-w-0 items-center gap-3 rounded-2xl bg-surface-container-low px-4 py-3 text-left text-sm font-medium text-on-surface hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-primary'

const p2pActionCls =
  'flex min-w-0 items-center gap-3 rounded-2xl border-2 border-dashed border-tertiary/70 bg-surface-container-low px-[calc(1rem-2px)] py-[calc(0.75rem-2px)] text-left text-sm font-medium text-on-surface hover:bg-tertiary-container hover:text-on-tertiary-container focus-visible:outline-2 focus-visible:outline-primary'

const useP2pCard = () => {
  const enabled = useP2p(s => s.enabled)
  const loading = useP2p(s => s.loading)
  const status = useP2p(s => s.status)
  const paused = useP2p(s => s.paused)
  const elsewhere = useP2p(s => s.elsewhere)
  const contacts = useP2p(s => s.contacts)
  const presence = useP2p(s => s.presence)
  const serverInvites = useP2p(s => s.serverInvites.length)
  const coOwnerAsks = useP2p(s => s.coOwnerAsks.length)
  const transferAsks = useP2p(s => s.transferAsks.length)
  const error = useP2p(s => s.error)
  const { label } = useInstanceLabel()
  return useMemo(
    () =>
      homeCard({
        enabled,
        loading,
        status,
        paused,
        elsewhere,
        contacts,
        presence,
        serverInvites,
        coOwnerAsks,
        transferAsks,
        label,
        error,
      }),
    [
      enabled,
      loading,
      status,
      paused,
      elsewhere,
      contacts,
      presence,
      serverInvites,
      coOwnerAsks,
      transferAsks,
      label,
      error,
    ]
  )
}

const p2pAct = (identity: P2pApp) => (state: CardState, dialog: P2pDialog) => {
  const { p2p } = identity

  const entry = p2pEntry(state)
  if (entry === 'home') p2p.openHome()
  else p2p.openDialog(entry === 'enable' ? { kind: 'enable' } : dialog)
}

function QuickActions({
  as,
  accounts,
  actor,
}: { as?: ReactNode; accounts?: HomeActor[]; actor?: P2pApp | null } = {}) {
  const identity = useP2pApp()

  const acct = useAccount()
  const openDialog = useStore(s => s.openDialog)
  const canAdd = useAddingAllowed()
  const palette = usePalette(s => s.open)
  const p2pOn = useStore(s => s.settings.p2p)
  const p2pState = useP2pCard().state
  const [asking, setAsking] = useState(false)
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<{ error: string; host?: string } | null>(null)
  const openCode = (kind: 'invite' | 'contact') => {
    const anyEnabled = [acct, ...client.live()].some(account =>
      account.identities.list().some(app => app.useP2p.getState().enabled)
    )
    if (anyEnabled) openPeerLink(acct, { kind }, actor ?? null, client.shown())
    else if (identity) {
      showOwner(acct, identity)
      p2pAct(identity)(
        p2pState,
        kind === 'invite' ? { kind: 'server_new', tab: 'join' } : { kind: 'add' }
      )
    }
  }
  const submit = () => {
    const target = name.trim().replace(/^@/, '')
    if (!target) return
    const candidates = accounts ? accounts.filter(a => a.row.username).map(a => a.account) : [acct]
    const routed = routeName(
      target,
      acct,
      candidates.map(account => ({
        account,
        host: account.conn.host,
        lastShown: client.accounts.lastShown(account),
      }))
    )
    if (!routed.account) {
      setProblem(routed)
      return
    }
    setProblem(null)
    setAsking(false)
    setName('')
    showOwner(routed.account)
    void routed.account.store.getState().startDm(routed.name)
  }
  return (
    <section aria-label="Quick actions" className="flex flex-col gap-2">
      {as}
      <div
        className={`grid grid-cols-2 gap-2 ${palette && !p2pOn ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}
      >
        <button
          type="button"
          onClick={() => {
            showOwner(acct)
            openDialog({ kind: 'add_server', tab: 'create' })
          }}
          className={actionCls}
        >
          <Plus size={18} className="shrink-0 text-primary" />
          <span className="min-w-0 leading-tight">Create server</span>
        </button>
        <button
          type="button"
          onClick={() => {
            showOwner(acct)
            openDialog({ kind: 'add_server', tab: 'join' })
          }}
          className={actionCls}
        >
          <Compass size={18} className="shrink-0 text-primary" />
          <span className="min-w-0 leading-tight">Join server</span>
        </button>
        <button
          type="button"
          aria-expanded={asking}
          onClick={() => setAsking(a => !a)}
          className={actionCls}
        >
          <MessageCircle size={18} className="shrink-0 text-primary" />
          <span className="min-w-0 leading-tight">Message someone</span>
        </button>
        {palette && (
          <button
            type="button"
            onClick={() => {
              showOwner(acct)
              palette(acct)
            }}
            className={actionCls}
          >
            <Command size={18} className="shrink-0 text-primary" />
            <span className="min-w-0 leading-tight">Command palette</span>
            <kbd className="ml-auto shrink-0 rounded-md border border-outline-variant px-1.5 font-sans text-xs text-on-surface-variant max-sm:hidden">
              {paletteShortcut(isMac())}
            </kbd>
          </button>
        )}
        {p2pOn && (
          <>
            <button
              type="button"
              data-p2p-action="contact"
              onClick={() => openCode('contact')}
              className={p2pActionCls}
            >
              <UserPlus size={18} className="shrink-0 text-tertiary" />
              <span className="min-w-0 leading-tight">Add P2P contact</span>
            </button>
            <button
              type="button"
              data-p2p-action="join"
              onClick={() => openCode('invite')}
              className={p2pActionCls}
            >
              <Waypoints size={18} className="shrink-0 text-tertiary" />
              <span className="min-w-0 leading-tight">Join P2P server</span>
            </button>
          </>
        )}
      </div>
      {asking && problem && (
        <p role="alert">
          {problem.error}{' '}
          {canAdd && problem.host && (
            <button
              type="button"
              className={textBtn}
              onClick={() => openDialog({ kind: 'add_instance', origin: problem.host })}
            >
              Add {problem.host}
            </button>
          )}
        </p>
      )}
      {asking && (
        <form
          className="flex gap-2"
          onSubmit={e => {
            e.preventDefault()
            submit()
          }}
        >
          <input
            autoFocus
            aria-label="Username"
            value={name}
            onChange={e => {
              setName(e.target.value)
              setProblem(null)
            }}
            onKeyDown={e => {
              if (e.key === 'Escape') setAsking(false)
              else if (enterKey(e)) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder="username or username@host"
            className={fieldCls}
          />
          <button type="submit" disabled={!name.trim()} className={filledBtn}>
            Message
          </button>
        </form>
      )}
    </section>
  )
}

// A box for a place's icon; P2P places get a dashed outline.
function PlaceGlyph({ p2p = false, children }: { p2p?: boolean; children: ReactNode }) {
  return (
    <span
      className={`flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-container-highest text-sm font-semibold text-on-surface-variant ${p2p ? 'border border-dashed border-tertiary' : ''}`}
    >
      {children}
    </span>
  )
}

// What a card's menu marks read and forgets.
type CardMenu = Pick<Extract<Target, { kind: 'card' }>, 'read' | 'markRead' | 'forget'>

// One Jump back in row, instance or P2P.
function RecentItem({
  id,
  title,
  glyph,
  label,
  own = false,
  where,
  p2p = false,
  unread,
  pings,
  open,
  card,
}: {
  id: string
  title: string
  glyph: ReactNode
  label: string
  own?: boolean
  where: ReactNode
  p2p?: boolean
  unread: boolean
  pings: number
  open: () => void
  card: () => CardMenu
}) {
  const acct = useAccount()
  const identity = useP2pApp()
  const navigate = () => {
    showOwner(acct, p2p ? identity : null)
    open()
  }

  return (
    <button
      type="button"
      data-recent={id}
      onClick={navigate}
      title={title}
      {...longPress((x, y) =>
        openActionMenu(
          x,
          y,
          { kind: 'card', key: id, open: navigate, ...card() },
          undefined,
          acct,
          p2p ? identity : undefined
        )
      )}
      className={rowCls}
    >
      {glyph}
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={`streamer truncate text-sm ${unread || pings ? 'font-semibold text-on-surface' : 'text-on-surface'}`}
        >
          <Masked text={label} own={own} />
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-on-surface-variant">
          <span className="streamer truncate">{where}</span>
          {p2p && <P2pBadge />}
        </span>
      </span>
      <UnreadMark unread={unread} pings={pings} />
    </button>
  )
}

function RecentRow({ recent }: { recent: Exclude<Recent, { kind: 'p2p' }> }) {
  const acct = useAccount()
  const key = recentKey(recent)
  const dm = useStore(s =>
    recent.kind === 'dm' ? s.dms.find(d => d.id === recent.dmId) : undefined
  )
  const channel = useStore(s =>
    recent.kind === 'channel'
      ? s.servers[recent.server]?.channels.find(c => c.id === recent.channelId)
      : undefined
  )
  const serverName = useStore(s =>
    recent.kind === 'channel'
      ? (s.me?.servers.find(x => x.name === recent.server)?.display_name ??
        s.servers[recent.server]?.display_name ??
        recent.serverName ??
        recent.server)
      : ''
  )
  const unread = useStore(s => scopeUnread(s, key))
  const pings = useStore(s => scopePingCount(s, key))
  const markScopesRead = useStore(s => s.markScopesRead)
  const streamer = useStore(s => s.streamer)
  const ownServer = useOwnServer(recent.kind === 'channel' ? recent.server : null)
  const own = recent.kind === 'dm' ? dm?.is_self === true : ownServer
  const mask = useMask(own)
  const open = () => {
    const s = acct.store.getState()
    if (recent.kind === 'dm') void s.openDm(recent.dmId)
    else void s.openServer(recent.server, recent.channelId)
  }
  const label =
    recent.kind === 'dm' ? (dm?.other.display_name ?? '') : (channel?.name ?? recent.channel ?? '')
  return (
    <RecentItem
      id={key}
      title={
        streamer
          ? recent.kind === 'dm'
            ? 'Direct message'
            : 'Channel'
          : recent.kind === 'dm'
            ? mask(label)
            : `${mask(label)}, ${mask(serverName)}`
      }
      glyph={
        recent.kind === 'dm' && dm ? (
          <UserAvatar
            username={dm.other.username}
            avatarKind={dm.other.avatar_kind}
            avatarColor={dm.other.avatar_color}
            size={32}
          />
        ) : (
          <PlaceGlyph>
            {channel?.kind === 'voice' ? <Volume2 size={16} /> : <Hash size={16} />}
          </PlaceGlyph>
        )
      }
      label={label}
      own={own}
      where={
        recent.kind === 'dm' ? (
          dm?.is_self ? (
            'Notes to yourself'
          ) : (
            'Direct message'
          )
        ) : (
          <Masked text={serverName} own={own} />
        )
      }
      unread={unread}
      pings={pings}
      open={open}
      card={() => ({
        read: scopeMarkTargets(acct.store.getState(), key),
        markRead: () => void markScopesRead([key]),
        forget: acct.lifetime.inSession(() => acct.home.forgetRecent(key)),
      })}
    />
  )
}

// A P2P conversation or channel visited: names, counts and actions come from P2P.
function P2pRecentRow({ recent }: { recent: Extract<Recent, { kind: 'p2p' }> }) {
  const identity = useP2pApp()
  const p2pServer = identity?.p2pServer
  const p2p = identity?.p2p
  const p2pDm = identity?.p2pDm

  const acct = useAccount()
  const key = recentKey(recent)
  const { room, ch } = recent
  const peer = useP2p(s =>
    ch === null ? s.contacts.find(c => c.ik === s.rooms[room]?.peer) : null
  )
  const server = useP2p(s => (ch === null ? undefined : s.servers[room]))
  const counts = useP2p(s => (ch === null ? s.rooms[room] : s.servers[room]?.chans[ch]))
  const prefs = useStore(s => s.notifyPrefs)
  const streamer = useStore(s => s.streamer)
  const own = useP2p(s => ch !== null && ownsP2pServer(s.servers[room], s.me))
  const mask = useMask(own)
  const scope =
    ch === null ? ({ kind: 'p2p', room } as const) : ({ kind: 'p2pc', room, ch } as const)
  const pings = counts && levelOf(prefs, scope) !== 'nothing' ? counts.pings : 0
  const unread = !!counts?.unread && !mutedOf(prefs, scope, Date.now())
  const label =
    ch === null
      ? peer
        ? displayName(peer)
        : ''
      : (server?.channels.find(c => c.id === ch)?.name ?? '')
  const open = () => {
    if (ch !== null) return p2pServer?.open(room, ch)
    if (!peer) return
    p2p?.openHome()
    void p2pDm?.openDm(peer.ik)
  }
  return (
    <RecentItem
      id={key}
      title={
        streamer
          ? ch === null
            ? 'P2P direct message'
            : 'Channel'
          : ch === null
            ? mask(label)
            : `${mask(label)}, ${mask(server?.name ?? '')}`
      }
      glyph={
        ch === null && peer ? (
          <KeyAvatar ik={peer.ik} size={32} />
        ) : (
          <PlaceGlyph p2p>
            <Hash size={16} />
          </PlaceGlyph>
        )
      }
      label={label}
      own={own}
      where={ch === null ? 'P2P direct message' : <Masked text={server?.name ?? ''} own={own} />}
      p2p={ch !== null}
      unread={unread}
      pings={pings}
      open={open}
      card={() => ({
        read: unread || pings ? [key] : [],
        markRead: () => p2pDm?.markRead(ch === null ? room : `${room}/${ch}`),
        forget: acct.lifetime.inSession(() => acct.home.forgetRecent(key)),
      })}
    />
  )
}

const p2pPlaceKeys = (st: Pick<P2pState, 'rooms' | 'servers' | 'contacts'>, local?: string) =>
  new Set(placesOf(st).map(p => recentKey({ kind: 'p2p', room: p.room, ch: p.ch, at: 0, local })))

function JumpBackIn({ recents, action }: { recents: Recent[]; action?: ReactNode }) {
  const account = useAccount()
  const source = useMemo(() => {
    const snapshot = () =>
      JSON.stringify(
        account.identities
          .list()
          .flatMap(app => Array.from(p2pPlaceKeys(app.useP2p.getState(), app.localId)))
      )
    const subscribe = (notify: () => void) => {
      let stops: (() => void)[] = []
      const bind = () => {
        stops.forEach(stop => stop())
        stops = account.identities.list().map(app => app.useP2p.subscribe(notify))
        notify()
      }
      const off = account.identities.subscribe(bind)
      bind()
      return () => {
        off()
        stops.forEach(stop => stop())
      }
    }
    return { snapshot, subscribe }
  }, [account])
  const peerPlaces = useSyncExternalStore(source.subscribe, source.snapshot, source.snapshot)
  const joined = useStore(s => s.me?.servers)
  const serversMore = useStore(s => s.serversMore)
  const dms = useStore(s => s.dms)
  const details = useStore(s => s.servers)
  const viewed = useP2pApp()
  const p2pRooms = useP2p(s => s.rooms)
  const p2pServers = useP2p(s => s.servers)
  const contacts = useP2p(s => s.contacts)
  const shown = useMemo(() => {
    const at = {
      servers: new Set((joined ?? []).map(x => x.name)),
      serversMore,
      dmIds: new Set(dms.map(d => d.id)),
      channels: Object.fromEntries(
        Object.entries(details).map(([name, d]) => [name, d.channels.map(c => c.id)])
      ),
      p2p: new Set<string>([
        ...p2pPlaceKeys({ rooms: p2pRooms, servers: p2pServers, contacts }, viewed?.localId),
        ...JSON.parse(peerPlaces),
      ]),
    }
    return recents.filter(r => recentShown(r, at)).slice(0, RECENTS_SHOWN)
  }, [
    recents,
    joined,
    serversMore,
    dms,
    details,
    p2pRooms,
    p2pServers,
    contacts,
    viewed,
    peerPlaces,
  ])
  return (
    <Card title="Jump back in" action={action} icon={<House size={18} />}>
      {shown.length === 0 ? (
        <Empty>Channels and DMs you open show up here.</Empty>
      ) : (
        <div className="flex flex-col">
          {shown.map(r =>
            r.kind === 'p2p' ? (
              <P2pProvider
                key={recentKey(r)}
                identity={account.identities.get(r.local ?? 'main') ?? null}
              >
                <P2pRecentRow recent={r} />
              </P2pProvider>
            ) : (
              <RecentRow key={recentKey(r)} recent={r} />
            )
          )}
        </div>
      )}
    </Card>
  )
}

// One Unread row, instance or P2P: a place, what is unread there, open and mark as read.
function UnreadRow({
  id,
  glyph,
  name,
  streamer = false,
  p2p = false,
  detail,
  pings,
  open,
  mark,
  markLabel,
  card,
}: {
  id: string
  glyph: ReactNode
  name: ReactNode
  streamer?: boolean
  p2p?: boolean
  detail: string
  pings: number
  open: () => void
  mark: () => void
  markLabel: string
  card: () => CardMenu
}) {
  const acct = useAccount()
  const identity = useP2pApp()
  const navigate = () => {
    showOwner(acct, p2p ? identity : null)
    open()
  }

  return (
    <div
      data-unread-server={id}
      {...longPress((x, y) =>
        openActionMenu(
          x,
          y,
          { kind: 'card', key: id, open: navigate, ...card() },
          undefined,
          acct,
          p2p ? identity : undefined
        )
      )}
      className="flex min-w-0 items-center gap-1 rounded-xl hover:bg-surface-container-high"
    >
      <button
        type="button"
        onClick={navigate}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-primary"
      >
        {glyph}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={`truncate text-sm font-semibold text-on-surface ${streamer ? 'streamer' : ''}`}
            >
              {name}
            </span>
            {p2p && <P2pBadge />}
          </span>
          <span className="truncate text-xs text-on-surface-variant">{detail}</span>
        </span>
        <PingBadge count={pings} className="ml-auto" />
      </button>
      <button
        type="button"
        title="Mark as read"
        aria-label={markLabel}
        onClick={mark}
        className="shrink-0 rounded-full p-2 text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface"
      >
        <CheckCheck size={18} />
      </button>
    </div>
  )
}

const serverDetail = (channels: number, pings: number) =>
  channels > 0 ? `${channels} unread ${channels === 1 ? 'channel' : 'channels'}` : pingLabel(pings)

function ServerUnreadRow({
  name,
  pings,
  channels,
}: {
  name: string
  pings: number
  channels: number
}) {
  const account = useAccount()
  const display = useStore(
    s =>
      s.me?.servers.find(x => x.name === name)?.display_name ??
      s.servers[name]?.display_name ??
      name
  )
  const openServer = useStore(s => s.openServer)
  const markServerRead = useStore(s => s.markServerRead)
  const own = useOwnServer(name)
  const shown = useMask(own)(display)
  return (
    <UnreadRow
      id={name}
      glyph={
        <PlaceGlyph>
          <span className="text-on-surface">
            <ServerGlyph name={name} displayName={display} />
          </span>
        </PlaceGlyph>
      }
      name={<Masked text={display} own={own} />}
      streamer
      detail={serverDetail(channels, pings)}
      pings={pings}
      open={() => void openServer(name)}
      mark={() => void markServerRead(name)}
      markLabel={`Mark ${shown} as read`}
      card={() => ({
        read: serversMarkTargets(account.store.getState(), [name]),
        markRead: () => void markServerRead(name),
      })}
    />
  )
}

function DmUnreadRow({ pings }: { pings: number }) {
  const account = useAccount()
  const markDmsRead = useStore(s => s.markDmsRead)
  const openLastDm = useStore(s => s.openLastDm)
  return (
    <UnreadRow
      id="dms"
      glyph={
        <PlaceGlyph>
          <MessageCircle size={16} className="text-on-surface" />
        </PlaceGlyph>
      }
      name="Direct messages"
      detail={pings > 0 ? pingLabel(pings) : 'Unread messages'}
      pings={pings}
      open={openLastDm}
      mark={() => void markDmsRead()}
      markLabel="Mark direct messages as read"
      card={() => ({
        read: dmsMarkTargets(account.store.getState()),
        markRead: () => void markDmsRead(),
      })}
    />
  )
}

const useP2pUnread = () => {
  const servers = useP2p(s => s.servers)
  const rooms = useP2p(s => s.rooms)
  const contacts = useP2p(s => s.contacts)
  const prefs = useStore(s => s.notifyPrefs)
  return useMemo(
    () => p2pUnread({ servers, rooms, contacts }, prefs, Date.now()),
    [servers, rooms, contacts, prefs]
  )
}

function P2pServerUnreadRow({ v, pings, channels }: P2pUnreadRow) {
  const identity = useP2pApp()

  const p2pServer = identity?.p2pServer

  const own = useP2p(s => ownsP2pServer(v, s.me))
  const shown = useMask(own)(v.name)
  return (
    <UnreadRow
      id={`p2p:${v.id}`}
      glyph={
        <PlaceGlyph p2p>
          <span className="streamer text-on-surface">{serverInitial(shown)}</span>
        </PlaceGlyph>
      }
      name={<Masked text={v.name} own={own} />}
      streamer
      p2p
      detail={serverDetail(channels, pings)}
      pings={pings}
      open={() => p2pServer?.open(v.id)}
      mark={() => p2pServer?.markAllRead(v.id)}
      markLabel={`Mark ${shown} as read`}
      card={() => ({ read: [v.id], markRead: () => p2pServer?.markAllRead(v.id) })}
    />
  )
}

function P2pDmUnreadRow({ pings }: { pings: number }) {
  const identity = useP2pApp()
  const p2p = identity?.p2p
  const p2pDm = identity?.p2pDm

  return (
    <UnreadRow
      id="p2p_dms"
      glyph={
        <PlaceGlyph p2p>
          <MessageCircle size={16} className="text-on-surface" />
        </PlaceGlyph>
      }
      name="P2P direct messages"
      p2p
      detail={pings > 0 ? pingLabel(pings) : 'Unread messages'}
      pings={pings}
      open={() => p2p?.openHome()}
      mark={() => p2pDm?.markAllRead()}
      markLabel="Mark P2P direct messages as read"
      card={() => ({ read: ['p2p_dms'], markRead: () => p2pDm?.markAllRead() })}
    />
  )
}

const UNREAD_SHOWN = 6

function UnreadSummary() {
  const identity = useP2pApp()
  const p2pMarkAll = identity?.p2pMarkAll

  const acct = useAccount()
  const ready = useStore(s => s.readsReady)
  const key = useStore(acct.home.unreadSummaryKey)
  const askMarkAllRead = useStore(s => s.askMarkAllRead)
  const [all, setAll] = useState(false)
  const summary = useMemo(() => parseSummary(key), [key])
  const p2pRows = useP2pUnread()
  const dms = summary.dms.unread || summary.dms.pings > 0
  const p2pDms = p2pRows.dms.unread || p2pRows.dms.pings > 0
  const servers = [
    ...summary.servers.map(r => <ServerUnreadRow key={r.name} {...r} />),
    ...p2pRows.servers.map(r => <P2pServerUnreadRow key={`p2p:${r.v.id}`} {...r} />),
  ]
  const rows = all ? servers : servers.slice(0, UNREAD_SHOWN)
  const any = dms || p2pDms || servers.length > 0
  return (
    <Card
      title="Unread"
      icon={<Bell size={18} />}
      action={
        any && (
          <button
            type="button"
            title="Mark all as read"
            aria-label="Mark all as read"
            onClick={() => askMarkAllRead(p2pMarkAll?.())}
            className="rounded-full p-1.5 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
          >
            <CheckCheck size={18} />
          </button>
        )
      }
    >
      {!ready && !any ? (
        <SkeletonRows rows={2} label="Loading unread messages" />
      ) : !any ? (
        <Empty>Nothing unread.</Empty>
      ) : (
        <div className="flex flex-col">
          {dms && <DmUnreadRow pings={summary.dms.pings} />}
          {p2pDms && <P2pDmUnreadRow pings={p2pRows.dms.pings} />}
          {rows}
          {servers.length > UNREAD_SHOWN && (
            <button
              type="button"
              onClick={() => setAll(a => !a)}
              className={`${textBtn} self-start`}
            >
              {all ? 'Show less' : `Show ${servers.length - UNREAD_SHOWN} more`}
            </button>
          )}
        </div>
      )}
    </Card>
  )
}

function PinnedDmRow({ dm }: { dm: DmSummary }) {
  const acct = useAccount()

  const key = `d${dm.id}`
  const unread = useStore(s => scopeUnread(s, key))
  const pings = useStore(s => scopePingCount(s, key))
  const openDm = useStore(s => s.openDm)
  const placeDm = useStore(s => s.placeDm)
  const streamer = useStore(s => s.streamer)
  const mask = useMask(dm.is_self)
  return (
    <button
      type="button"
      data-pinned-dm={dm.id}
      title={streamer ? 'Direct message' : mask(dm.other.display_name)}
      onClick={() => {
        showOwner(acct)
        void openDm(dm.id)
      }}
      {...longPress(
        (x, y) => openActionMenu(x, y, { kind: 'dm', dm, where: 'home' }, undefined, acct),
        {
          group: 'home_dm',
          key: String(dm.id),
          zones: zone => zone === 'home_pinned',
          onDrop: ({ index }) => placeDm(dm.id, 'pinned', index),
        }
      )}
      className={rowCls}
    >
      <UserAvatar
        username={dm.other.username}
        avatarKind={dm.other.avatar_kind}
        avatarColor={dm.other.avatar_color}
        size={32}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={`streamer truncate text-sm text-on-surface ${unread || pings ? 'font-semibold' : ''}`}
        >
          <Masked text={dm.other.display_name} own={dm.is_self} />
        </span>
        <span className="streamer truncate text-xs text-on-surface-variant">
          {dm.is_self ? 'Notes to yourself' : `@${dm.other.username}`}
        </span>
      </span>
      <DmEnd id={dm.id} unread={unread} pings={pings} />
    </button>
  )
}

function PinnedDms({ action }: { action?: ReactNode } = {}) {
  const dms = useStore(s => s.dms)
  const layout = useStore(s => s.layout)
  const dragging = useDrag(s => s.group === 'home_dm')
  const pinned = useMemo(() => dmSections(dms, layout).pinned.slice(0, PINNED_SHOWN), [dms, layout])
  return (
    <Card title="Pinned DMs" action={action} icon={<Pin size={18} />}>
      {pinned.length === 0 ? (
        <Empty>Pin a DM from its menu to keep it here.</Empty>
      ) : (
        <div ref={dragScope}>
          <div
            data-drop-zone="home_pinned"
            className={`flex flex-col rounded-xl ${dragging ? 'bg-primary-container/30' : ''}`}
          >
            {pinned.map(dm => (
              <PinnedDmRow key={dm.id} dm={dm} />
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}

const P2P_ROW_ICONS = { requests: MessageCircle, invites: Compass, asks: Users } as const

function P2pCard({ actor }: { actor?: HomeActor } = {}) {
  const unique = useId()
  const heading = actor ? unique : 'home-p2p'
  const identity = useP2pApp()
  const p2p = identity?.p2p
  const p2pDm = identity?.p2pDm

  const acct = useAccount()

  const card = useP2pCard()
  const error = useP2p(s => s.error)
  const me = useP2p(s => s.me)
  const streamer = useStore(s => s.streamer)
  const mask = useMask()
  return (
    <section
      data-p2p-home
      aria-labelledby={heading}
      onClickCapture={
        actor
          ? e => {
              const button = (e.target as HTMLElement).closest('button')
              if (button && !button.hasAttribute('data-peer-code'))
                showOwner(actor.account, actor.peer)
            }
          : undefined
      }
      className="flex min-w-0 flex-col gap-1 rounded-3xl border-2 border-dashed border-tertiary/70 bg-surface-container-low p-[calc(1rem-2px)]"
    >
      <div className="flex min-h-9 min-w-0 items-center gap-2 px-2">
        <Waypoints size={18} className="shrink-0 text-tertiary" />
        <h2 id={heading} className="min-w-0 truncate font-medium text-on-surface">
          {actor ? <AccountTag row={actor.row} name={actor.instance} /> : 'Peer-to-peer'}
        </h2>
        <P2pBadge />
        <button
          type="button"
          onClick={() => p2p?.openHome()}
          className={`${textBtn} ml-auto shrink-0`}
        >
          Open
        </button>
      </div>
      {card.state === 'off' ? (
        <>
          <p className="px-2 text-sm text-on-surface-variant">
            P2P is off. Turn it on to message contacts directly, device to device.
          </p>
          {error && (
            <p role="alert" className="px-2 text-sm text-error">
              <LabelText text={error} />
            </p>
          )}
          <button
            type="button"
            onClick={() => p2p?.openDialog({ kind: 'enable' })}
            className={`${filledBtn} mx-2 mt-2 self-start`}
          >
            Turn on P2P
          </button>
        </>
      ) : card.state === 'elsewhere' ? (
        <ElsewhereNotice />
      ) : (
        <>
          <p
            data-p2p-home-status={card.state}
            className="px-2 text-sm break-words text-on-surface-variant"
          >
            <span className="font-medium text-on-surface">
              <LabelText text={card.status} />
            </span>
            {card.state === 'online' && ` \u00b7 ${onlineText(card.online)}`}
          </p>
          {card.note && (
            <p data-p2p-home-note className="px-2 text-sm break-words text-on-surface-variant">
              {card.note}
            </p>
          )}
          {cardRows(card).map(row => {
            const Icon = P2P_ROW_ICONS[row.id]
            return (
              <button
                key={row.id}
                type="button"
                data-p2p-home-row={row.id}
                onClick={() => p2p?.openHome()}
                className={rowCls}
              >
                <PlaceGlyph p2p>
                  <Icon size={16} className="text-on-surface" />
                </PlaceGlyph>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-on-surface">
                  {row.text}
                </span>
              </button>
            )
          })}
          {card.top.length > 0 && (
            <ul aria-label="Online contacts" className="flex flex-wrap gap-2 px-2 py-1">
              {card.top.map(c => {
                const label = streamer ? 'Message contact' : `Message ${mask(displayName(c))}`
                return (
                  <li key={c.ik} className="flex">
                    <button
                      type="button"
                      data-p2p-home-contact={c.ik}
                      title={label}
                      aria-label={label}
                      onClick={() => void p2pDm?.openDm(c.ik)}
                      {...longPress((x, y) =>
                        openActionMenu(x, y, { kind: 'p2p_contact', c, me }, {}, acct, identity)
                      )}
                      className="relative flex rounded-full focus-visible:outline-2 focus-visible:outline-primary"
                    >
                      <KeyAvatar ik={c.ik} />
                      <PresenceDot presence="online" />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {card.state !== 'starting' && (
            <div className="flex flex-wrap gap-2 px-2 pt-2">
              <button
                type="button"
                data-peer-code
                onClick={() =>
                  identity && openPeerLink(acct, { kind: 'contact' }, identity, client.shown())
                }
                className={`${textBtn} flex items-center gap-1.5`}
              >
                <UserPlus size={16} />
                Add contact
              </button>
              <button
                type="button"
                onClick={() => p2p?.openDialog({ kind: 'add', tab: 'mine' })}
                className={`${textBtn} flex items-center gap-1.5`}
              >
                <QrCode size={16} />
                Show my code
              </button>
              <button
                type="button"
                data-peer-code
                onClick={() =>
                  identity && openPeerLink(acct, { kind: 'invite' }, identity, client.shown())
                }
                className={`${textBtn} flex items-center gap-1.5`}
              >
                <Waypoints size={16} />
                Join P2P server
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function GetStarted({ className = '' }: { className?: string }) {
  const openDialog = useStore(s => s.openDialog)
  const openFriends = useStore(s => s.openFriends)
  return (
    <Card title="Get started" icon={<House size={18} />} className={className}>
      <p className="px-2 text-sm text-on-surface-variant">
        Join a server to start chatting, or add a friend to message them.
      </p>
      <div className="flex flex-wrap gap-2 px-2 pt-2">
        <button
          type="button"
          onClick={() => openDialog({ kind: 'add_server', tab: 'join' })}
          className={filledBtn}
        >
          Join a server
        </button>
        <button
          type="button"
          onClick={() => openDialog({ kind: 'add_server', tab: 'create' })}
          className={textBtn}
        >
          Create a server
        </button>
        <button type="button" onClick={() => openFriends('add')} className={textBtn}>
          Add a friend
        </button>
      </div>
    </Card>
  )
}

function GuestHome() {
  const router = useRouter()
  const openDialog = useStore(s => s.openDialog)
  const loginAccount = useAccount()
  const signup = useStore(s => passwordSignup(s.settings))
  const line = useStore(s => guestHomeLine(s.settings))
  const benefits = useStore(s => accountBenefits(s.settings))
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 px-1">
        <h1 className="text-2xl font-semibold text-on-surface sm:text-3xl">Welcome</h1>
        <p className="text-sm text-on-surface-variant">{line}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Browse servers" icon={<Compass size={18} />}>
          <p className="px-2 text-sm text-on-surface-variant">
            Enter a server name to open it. The name is the invite code.
          </p>
          <button
            type="button"
            onClick={() => openDialog({ kind: 'add_server', tab: 'join' })}
            className={`${filledBtn} mx-2 mt-2 self-start`}
          >
            Find a server
          </button>
        </Card>
        <Card title={signup ? 'Create an account' : 'Log in'} icon={<LogIn size={18} />}>
          <p className="px-2 text-sm text-on-surface-variant">
            {signup ? 'Sign up' : 'Log in'} to {benefits}
          </p>
          <button
            type="button"
            onClick={() => {
              if (!client.show(loginAccount, 'none')) return
              logoutForLogin(loginAccount)
              router.replace(signup ? '/login?mode=register' : '/login')
            }}
            className={`${filledBtn} mx-2 mt-2 self-start`}
          >
            {signup ? 'Sign up' : 'Log in'}
          </button>
        </Card>
      </div>
    </div>
  )
}

function ActorScope({ actor, children }: { actor: HomeActor; children: ReactNode }) {
  return (
    <AccountProvider session={actor.account}>
      <P2pProvider identity={actor.peer ?? actor.account.identities.viewed() ?? null}>
        {children}
      </P2pProvider>
    </AccountProvider>
  )
}
function HomeActorLabel({ actor }: { actor: HomeActor }) {
  return (
    <>
      <AccountTag row={actor.row} name={actor.instance} />
      <span className="streamer text-xs">
        <Masked text={actor.instance} />
      </span>
    </>
  )
}
function ActorChips({
  accounts,
  active,
  onPick,
}: {
  accounts: HomeActor[]
  active: HomeActor
  onPick: (key: string) => void
}) {
  if (accounts.length < 2) return null
  return (
    <div aria-label="Account" className="flex max-w-full flex-wrap gap-1">
      {accounts.map(actor => (
        <button
          key={actor.key}
          type="button"
          aria-pressed={actor === active}
          onClick={() => onPick(actor.key)}
          className="flex items-center gap-1 rounded-full px-2 py-1 aria-pressed:bg-secondary-container"
        >
          <HomeActorLabel actor={actor} />
        </button>
      ))}
    </div>
  )
}
function GroupUnread({ actor }: { actor: HomeActor }) {
  const key = useStore(actor.account.home.unreadSummaryKey)
  const summary = useMemo(() => parseSummary(key), [key])
  const peerRows = useP2pUnread()
  const [all, setAll] = useState(false)
  const direct = actor.peer ? peerRows.dms : summary.dms
  const servers = actor.peer
    ? peerRows.servers.map(r => <P2pServerUnreadRow key={r.v.id} {...r} />)
    : summary.servers.map(r => <ServerUnreadRow key={r.name} {...r} />)
  if (!direct.pings && !direct.unread && !servers.length) return null
  return (
    <section data-home-unread-owner={actor.key}>
      <h3 className="flex items-center gap-1 px-2 py-1">
        <HomeActorLabel actor={actor} />
        <button
          type="button"
          className="ml-auto rounded-full p-1.5"
          aria-label="Mark all as read"
          title="Mark all as read"
          onClick={() => {
            const state = actor.account.store.getState()
            if (!actor.peer) state.askMarkAllRead()
            else {
              const extra = actor.peer.p2pMarkAll()
              if (extra.pending)
                state.askConfirm({
                  title: 'Mark all as read?',
                  body: 'Mark this identity’s unread messages as read.',
                  confirm: 'Mark read',
                  action: extra.mark,
                })
            }
          }}
        >
          <CheckCheck size={16} />
        </button>
      </h3>
      {(direct.pings > 0 || direct.unread) &&
        (actor.peer ? (
          <P2pDmUnreadRow pings={direct.pings} />
        ) : (
          <DmUnreadRow pings={direct.pings} />
        ))}
      {all ? servers : servers.slice(0, UNREAD_SHOWN)}
      {servers.length > UNREAD_SHOWN && (
        <button type="button" className={textBtn} onClick={() => setAll(!all)}>
          {all ? 'Show less' : 'Show more'}
        </button>
      )}
    </section>
  )
}
function AccountHistory({ action }: { action: ReactNode }) {
  const recents = useHome(s => s.prefs.recents)
  return <JumpBackIn recents={recents} action={action} />
}
function AccountCard({
  accounts,
  kind,
}: {
  accounts: HomeActor[]
  kind: 'recent' | 'inbox' | 'pinned'
}) {
  const [chosen, setChosen] = useState('')
  const actor = accounts.find(a => a.key === chosen) ?? accounts[0]
  const choices = <ActorChips accounts={accounts} active={actor} onPick={setChosen} />
  return (
    <ActorScope key={actor.key} actor={actor}>
      {kind === 'recent' ? (
        <AccountHistory action={choices} />
      ) : kind === 'pinned' ? (
        <PinnedDms action={choices} />
      ) : (
        <Card title="Inbox" icon={<Bell size={18} />} action={choices}>
          <InboxPreview max={INBOX_SHOWN} beforeOpen={() => showOwner(actor.account)} />
        </Card>
      )}
    </ActorScope>
  )
}
function MultiHome({ actors }: { actors: HomeActor[] }) {
  const shown = useAccount()
  const canAdd = useAddingAllowed()
  const streamer = useStore(s => s.streamer)
  const accounts = actors
    .filter(a => !a.peer)
    .sort((a, b) => Number(b.account === shown) - Number(a.account === shown))
  const identities = actors.filter(a => a.peer)
  const [chosen, setChosen] = useState('')
  const actor = actors.find(a => a.key === chosen) ?? actors.find(a => a.row.active) ?? accounts[0]
  const peers = actor.account.identities
  const quickIdentity = () =>
    actor.peer ?? peers.list().find(app => app.useP2p.getState().enabled) ?? peers.get() ?? null
  const identity = useSyncExternalStore(peers.subscribe, quickIdentity, quickIdentity)
  const picker = (
    <label className="inline-flex w-fit items-center gap-2 rounded-full bg-surface-container px-3 py-1 text-sm">
      As <ActorAvatar row={actor.row} size={20} />
      <select
        aria-label="As"
        className="streamer bg-transparent"
        value={actor.key}
        onChange={e => setChosen(e.target.value)}
      >
        {actors.map(a => (
          <option value={a.key} key={a.key}>
            {streamer
              ? a.peer
                ? 'P2P identity'
                : 'Account'
              : (a.peer
                  ? a.row.display + ' · P2P · ' + a.row.username
                  : (a.row.username ?? 'Guest')) +
                ' on ' +
                a.instance}
          </option>
        ))}
      </select>
    </label>
  )
  const total = accounts.reduce((n, a) => n + a.account.counts.value(), 0)
  return (
    <div className="flex flex-col gap-4">
      <Greeting total={total} accounts={accounts.length} />
      <div aria-label="Accounts" className="flex gap-2 overflow-x-auto">
        {actors.map(a => (
          <button
            type="button"
            key={a.key}
            aria-pressed={a.row.active}
            onClick={() => void switchActor(a.row, shown)}
            className="flex shrink-0 flex-col gap-1 rounded-xl bg-surface-container-low p-2 text-left aria-pressed:bg-secondary-container"
          >
            <span className="flex items-center gap-1">
              <HomeActorLabel actor={a} />
            </span>
            <span className="text-xs">
              {a.row.status} {a.row.badge > 0 && <PingBadge count={a.row.badge} />}
            </span>
          </button>
        ))}
        {canAdd && (
          <button
            className={textBtn}
            onClick={() => shown.store.getState().openDialog({ kind: 'add_instance' })}
          >
            Add an instance
          </button>
        )}
      </div>
      <AccountProvider session={actor.account} key={actor.key}>
        {actor.row.username ? (
          <P2pProvider identity={identity}>
            <QuickActions as={picker} accounts={accounts} actor={actor.peer} />
          </P2pProvider>
        ) : (
          <>
            {picker}
            <GuestHome />
          </>
        )}
      </AccountProvider>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
        <Card title="Unread" icon={<Bell size={18} />}>
          <div className="flex flex-col gap-1">
            {actors.map(a => (
              <ActorScope key={a.key} actor={a}>
                <GroupUnread actor={a} />
              </ActorScope>
            ))}
            <p className="hidden px-2 py-3 text-sm text-on-surface-variant only:block">
              Nothing unread.
            </p>
          </div>
        </Card>
        <div className="flex flex-col gap-3">
          {identities.map(a => (
            <ActorScope key={a.key} actor={a}>
              {identities.length < 3 ? (
                <P2pCard actor={a} />
              ) : (
                <details className="rounded-xl border border-dashed border-tertiary p-2">
                  <summary className="cursor-pointer">
                    <span className="inline-flex items-center gap-1">
                      <HomeActorLabel actor={a} />
                    </span>
                  </summary>
                  <P2pCard actor={a} />
                </details>
              )}
            </ActorScope>
          ))}
        </div>
        <AccountCard accounts={accounts} kind="recent" />
        <AccountCard accounts={accounts} kind="inbox" />
        <AccountCard accounts={accounts} kind="pinned" />
        <Card title="Friends" icon={<Users size={18} />} className="lg:col-span-2">
          <FriendsSection max={5} />
        </Card>
      </div>
    </div>
  )
}
function HomeContent({ member }: { member: boolean }) {
  const [source] = useState(createSwitcherSource)
  const model = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  useLiveSessions()
  const allowed = useAddingAllowed()
  const actors = homeActors(
    model.groups,
    allowed ? undefined : ownInstance()?.origin,
    switcherSession
  )
  if (actors.length > 1 && (member || actors.some(a => a.row.active)))
    return <MultiHome actors={actors} />
  return member ? <MemberHome /> : <GuestHome />
}

function MemberHome() {
  const acct = useAccount()
  const recents = useHome(s => s.prefs.recents)
  const otherDms = useStore(s => s.dms.filter(d => !d.is_self).length)
  const servers = useStore(s => s.me?.servers.length ?? 0)
  const p2pRows = useP2pUnread()
  const unread =
    useStore(s => {
      const { dms, servers } = parseSummary(acct.home.unreadSummaryKey(s))
      return dms.unread || dms.pings > 0 || servers.length > 0
    }) ||
    p2pRows.dms.unread ||
    p2pRows.dms.pings > 0 ||
    p2pRows.servers.length > 0
  const p2pOn = useStore(s => s.settings.p2p)
  const fresh = isNewAccount(recents.length, otherDms, servers)
  const showUnread = !fresh || unread
  const inbox = (
    <Card title="Inbox" icon={<Bell size={18} />}>
      <InboxPreview max={INBOX_SHOWN} />
    </Card>
  )
  const friends = (
    <Card title="Friends" icon={<Users size={18} />}>
      <FriendsSection max={5} />
    </Card>
  )
  return (
    <div className="flex flex-col gap-4">
      <Greeting />
      <Tips />
      <QuickActions />
      {p2pOn ? (
        <>
          {fresh && <GetStarted />}
          <div className="flex flex-col gap-4 lg:grid lg:grid-cols-2 lg:items-start">
            <div className="contents lg:order-2 lg:flex lg:min-w-0 lg:flex-col lg:gap-4">
              {showUnread && <UnreadSummary />}
              <P2pCard />
            </div>
            <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-4">
              {!fresh && <JumpBackIn recents={recents} />}
              {inbox}
              {!fresh && <PinnedDms />}
              {friends}
            </div>
          </div>
        </>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {fresh ? <GetStarted className="lg:col-span-2" /> : <JumpBackIn recents={recents} />}
          {showUnread && <UnreadSummary />}
          {inbox}
          {!fresh && <PinnedDms />}
          {friends}
        </div>
      )}
    </div>
  )
}

// Home: shown when no channel or DM is open.
export function HomePage({ onMenu }: { onMenu: () => void }) {
  const guest = useStore(s => s.guest)
  const signedIn = useStore(s => s.me !== null)
  const menuPings = useStore(allPings)
  return (
    <main data-home className="relative flex h-full min-w-0 flex-1 flex-col bg-surface">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-outline-variant px-4 max-[360px]:has-[[data-view-actor]]:gap-1 max-[360px]:has-[[data-view-actor]]:px-2">
        <button
          title={menuPings ? `Menu, ${pingLabel(menuPings)}` : 'Menu'}
          aria-label="Menu"
          onClick={onMenu}
          className="relative rounded-full p-1.5 hover:bg-surface-container-high md:hidden"
        >
          <Menu size={20} />
          <PingBadge
            count={menuPings}
            className="absolute -top-1 -right-1.5 border-2 border-surface"
          />
        </button>
        <span className="flex items-center gap-2 font-medium">
          <House size={18} className="text-on-surface-variant" />
          Home
        </span>
        <ViewActorTag header />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <StatusClock />
          {signedIn && !guest && <InboxButton />}
          <PaletteButton />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6">
          <HomeContent member={signedIn && !guest} />
        </div>
      </div>
    </main>
  )
}
