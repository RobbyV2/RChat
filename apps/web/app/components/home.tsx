'use client'
import { Covered } from './covered'
import { Name, NameSelect } from './name'
import { handleName, instanceAddress, instanceName, personCalled } from '../lib/names'
import { asAccount, identityPerson } from '../lib/people'
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
import { Button, IconButton, ListRow, LinkButton } from './controls'
import { Masked, fieldCls, useOwnServer } from './ui'
import { RowsSkeleton } from './skeletons'
import { Row, Stack, Surface, Inset, Grid } from './layout'
import { type P2pState } from '../lib/p2p/app'
import type { P2pDialog } from '../lib/p2p/app/store'
import { cardRows, homeCard, onlineText, p2pEntry, type CardState } from '../lib/p2p/home_card'
import { p2pUnread, type P2pUnreadRow } from '../lib/p2p/alerts'
import { displayName } from '../lib/p2p/contacts'
import { ownsP2pServer } from '../lib/p2p/server/types'
import { placesOf } from '../lib/p2p/palette_source'
import { mutedOf, levelOf } from '../lib/notify'
import { ServerIcon } from './server_about'
import { hex } from '../lib/p2p/roles'
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
import { holder } from '../lib/stable_key'
import { time } from '../lib/platform/time'
import { homeActionLook } from '../lib/controls'
import { homeP2pActionLook } from '../lib/controls'

function showOwner(account: AccountSession, peer?: P2pApp | null) {
  if (client.shown() !== account) client.show(account)
  if (peer && account.identities.viewed() !== peer) account.identities.show(peer)
}

// A line of a card, inset like the card's heading.
function Line({ children }: { children: ReactNode }) {
  return (
    <Surface tone="plain" radius="none" pad="sm" inset="bar">
      {children}
    </Surface>
  )
}

// A card's controls under its text, inset like its heading.
function Controls({ children }: { children: ReactNode }) {
  return (
    <Surface tone="plain" radius="none" pad="sm" align="start">
      {children}
    </Surface>
  )
}

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
    <section
      aria-labelledby={id}
      className={`min-w-0 rounded-3xl bg-surface-container-low ${className}`}
    >
      <Surface tone="plain" radius="none" pad="lg" gap="2xs">
        <Line>
          <Row gap="sm">
            <span className="text-on-surface-variant">{icon}</span>
            <h2 id={id} className="font-medium text-on-surface">
              {title}
            </h2>
            <Row as="span" gap="none" place="ml-auto">
              {action}
            </Row>
          </Row>
        </Line>
        {children}
      </Surface>
    </section>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <Surface tone="plain" radius="none" pad="md">
      <p className="text-sm text-on-surface-variant">{children}</p>
    </Surface>
  )
}

// A pinned DM's end: typing dots before its ping count, else its unread mark.
function DmEnd({ id, unread, pings }: { id: number; unread: boolean; pings: number }) {
  const typers = useHostedTypers([`d${id}`], null)
  if (!typers.length) return <UnreadMark unread={unread} pings={pings} />
  return (
    <Row as="span" gap="xs" place="ml-auto shrink-0">
      <TypingEllipsis names={typers} />
      <PingBadge count={pings} />
    </Row>
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
  const [hour] = useState(() => new Date(time().now()).getHours())
  return (
    <Surface tone="plain" radius="none" pad="2xs" gap="2xs">
      <h1 className="text-2xl font-semibold text-on-surface sm:text-3xl">
        {streamer || !me ? (
          'Welcome back'
        ) : (
          <>
            {greeting(hour)}, <Name of={personCalled(me.display_name, null, true)} />
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
    </Surface>
  )
}

function Tips() {
  const acct = useAccount()
  const prefs = useHome(s => s.prefs)
  const tips = shownTips(prefs)
  if (!tips.length) return null
  return (
    <Stack as="ul" gap="sm" aria-label="Tips">
      {tips.map(t => (
        <li
          key={t.id}
          data-tip={t.id}
          className="rounded-2xl bg-tertiary-container text-sm text-on-tertiary-container"
        >
          <Surface tone="plain" radius="none" pad="lg" inset="bar">
            <Row gap="md">
              <Lightbulb size={16} className="shrink-0" />
              <span className="min-w-0 flex-1">{t.text}</span>
              <IconButton
                icon={X}
                label="Dismiss tip"
                tone="inherit"
                size="sm"
                onClick={() => acct.home.hideTip(t.id)}
              />
            </Row>
          </Surface>
        </li>
      ))}
    </Stack>
  )
}

const actionCls = homeActionLook

const p2pActionCls = homeP2pActionLook

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
    <Stack as="section" gap="sm" aria-label="Quick actions">
      {as}
      <Grid cols={palette && !p2pOn ? { base: 2, lg: 4 } : { base: 2, lg: 3 }} gap="sm">
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
            <Inset
              as="kbd"
              pad="xs"
              inset="sides"
              look="rounded-md border border-outline-variant font-sans text-xs text-on-surface-variant"
              place="ml-auto shrink-0 max-sm:hidden"
            >
              {paletteShortcut(isMac())}
            </Inset>
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
      </Grid>
      {asking && problem && (
        <p role="alert">
          {problem.error}{' '}
          {canAdd && problem.host && (
            <LinkButton onClick={() => openDialog({ kind: 'add_instance', origin: problem.host })}>
              Add <Name of={instanceAddress(problem.host)} />
            </LinkButton>
          )}
        </p>
      )}
      {asking && (
        <Row
          as="form"
          gap="sm"
          align="stretch"
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
          <Button type="submit" variant="filled" size="md" disabled={!name.trim()}>
            Message
          </Button>
        </Row>
      )}
    </Stack>
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
    <ListRow
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
      leading={glyph}
      streamer
      label={
        <span className={unread || pings ? 'font-semibold' : undefined}>
          <Masked text={label} own={own} />
        </span>
      }
      description={
        <Row as="span" gap="xs">
          <Covered what="place" look="truncate">
            {where}
          </Covered>
          {p2p && <P2pBadge />}
        </Row>
      }
      trailing={<UnreadMark unread={unread} pings={pings} />}
    />
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
          <UserAvatar person={asAccount(dm.other, 'dm')} size={32} />
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
  const unread = !!counts?.unread && !mutedOf(prefs, scope, acct.time.now())
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
          <KeyAvatar person={identityPerson(peer.ik, 'contact')} size={32} />
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
    const hold = holder<string[]>()
    const snapshot = () =>
      hold(
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
        ...peerPlaces,
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
        <Stack gap="none">
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
        </Stack>
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
    <Row
      gap="2xs"
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
    >
      <ListRow
        onClick={navigate}
        leading={glyph}
        label={
          <Row as="span" gap="xs">
            <Covered what="names" on={streamer} look="truncate font-semibold">
              {name}
            </Covered>
            {p2p && <P2pBadge />}
          </Row>
        }
        description={detail}
        trailing={<PingBadge count={pings} className="ml-auto" />}
        place="flex-1"
      />
      <IconButton icon={CheckCheck} label={markLabel} tooltip="Mark as read" onClick={mark} />
    </Row>
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
          <span className="flex h-full w-full rounded-inherit text-on-surface">
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
    () => p2pUnread({ servers, rooms, contacts }, prefs, time().now()),
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
          <span className="flex h-full w-full rounded-inherit text-on-surface">
            <ServerIcon
              seed={v.id}
              name={v.name}
              kind={v.about.icon}
              color={hex(v.color)}
              own={own}
            />
          </span>
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
          <IconButton
            icon={CheckCheck}
            label="Mark all as read"
            onClick={() => askMarkAllRead(p2pMarkAll?.())}
          />
        )
      }
    >
      {!ready && !any ? (
        <RowsSkeleton rows={2} label="Loading unread messages" />
      ) : !any ? (
        <Empty>Nothing unread.</Empty>
      ) : (
        <Stack gap="none">
          {dms && <DmUnreadRow pings={summary.dms.pings} />}
          {p2pDms && <P2pDmUnreadRow pings={p2pRows.dms.pings} />}
          {rows}
          {servers.length > UNREAD_SHOWN && (
            <Button onClick={() => setAll(a => !a)} place="self-start">
              {all ? 'Show less' : `Show ${servers.length - UNREAD_SHOWN} more`}
            </Button>
          )}
        </Stack>
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
    <ListRow
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
      leading={<UserAvatar person={asAccount(dm.other, 'dm')} size={32} />}
      streamer
      label={
        <span className={unread || pings ? 'font-semibold' : undefined}>
          <Masked text={dm.other.display_name} own={dm.is_self} />
        </span>
      }
      description={
        dm.is_self ? 'Notes to yourself' : <Name of={handleName(dm.other.username)} before="@" />
      }
      trailing={<DmEnd id={dm.id} unread={unread} pings={pings} />}
    />
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
      className="min-w-0 rounded-3xl border-2 border-dashed border-tertiary/70 bg-surface-container-low"
    >
      <Surface tone="plain" radius="none" pad="lg" gap="2xs">
        <Line>
          <Row gap="sm">
            <Waypoints size={18} className="shrink-0 text-tertiary" />
            <h2 id={heading} className="min-w-0 truncate font-medium text-on-surface">
              {actor ? <AccountTag row={actor.row} name={actor.instance} /> : 'Peer-to-peer'}
            </h2>
            <P2pBadge />
            <Button onClick={() => p2p?.openHome()} place="ml-auto shrink-0">
              Open
            </Button>
          </Row>
        </Line>
        {card.state === 'off' ? (
          <>
            <Line>
              <p className="text-sm text-on-surface-variant">
                P2P is off. Turn it on to message contacts directly, device to device.
              </p>
            </Line>
            {error && (
              <Line>
                <p role="alert" className="text-sm text-error">
                  <LabelText text={error} />
                </p>
              </Line>
            )}
            <Controls>
              <Button
                variant="filled"
                size="md"
                onClick={() => p2p?.openDialog({ kind: 'enable' })}
              >
                Turn on P2P
              </Button>
            </Controls>
          </>
        ) : card.state === 'elsewhere' ? (
          <ElsewhereNotice />
        ) : (
          <>
            <Line>
              <p
                data-p2p-home-status={card.state}
                className="text-sm break-words text-on-surface-variant"
              >
                <span className="font-medium text-on-surface">
                  <LabelText text={card.status} />
                </span>
                {card.state === 'online' && ` \u00b7 ${onlineText(card.online)}`}
              </p>
            </Line>
            {card.note && (
              <Line>
                <p data-p2p-home-note className="text-sm break-words text-on-surface-variant">
                  {card.note}
                </p>
              </Line>
            )}
            {cardRows(card).map(row => {
              const Icon = P2P_ROW_ICONS[row.id]
              return (
                <ListRow
                  key={row.id}
                  data-p2p-home-row={row.id}
                  onClick={() => p2p?.openHome()}
                  leading={
                    <PlaceGlyph p2p>
                      <Icon size={16} className="text-on-surface" />
                    </PlaceGlyph>
                  }
                  label={<span className="font-semibold">{row.text}</span>}
                />
              )
            })}
            {card.top.length > 0 && (
              <Line>
                <Row as="ul" aria-label="Online contacts" gap="sm" align="stretch" wrap>
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
                          <KeyAvatar person={identityPerson(c.ik, 'contact')} />
                          <PresenceDot presence="online" />
                        </button>
                      </li>
                    )
                  })}
                </Row>
              </Line>
            )}
            {card.state !== 'starting' && (
              <Controls>
                <Row gap="sm" align="stretch" wrap>
                  <Button
                    icon={UserPlus}
                    data-peer-code
                    onClick={() =>
                      identity && openPeerLink(acct, { kind: 'contact' }, identity, client.shown())
                    }
                  >
                    Add contact
                  </Button>
                  <Button
                    icon={QrCode}
                    onClick={() => p2p?.openDialog({ kind: 'add', tab: 'mine' })}
                  >
                    Show my code
                  </Button>
                  <Button
                    icon={Waypoints}
                    data-peer-code
                    onClick={() =>
                      identity && openPeerLink(acct, { kind: 'invite' }, identity, client.shown())
                    }
                  >
                    Join P2P server
                  </Button>
                </Row>
              </Controls>
            )}
          </>
        )}
      </Surface>
    </section>
  )
}

function GetStarted({ className = '' }: { className?: string }) {
  const openDialog = useStore(s => s.openDialog)
  const openFriends = useStore(s => s.openFriends)
  return (
    <Card title="Get started" icon={<House size={18} />} className={className}>
      <Line>
        <p className="text-sm text-on-surface-variant">
          Join a server to start chatting, or add a friend to message them.
        </p>
      </Line>
      <Controls>
        <Row gap="sm" align="stretch" wrap>
          <Button
            variant="filled"
            size="md"
            onClick={() => openDialog({ kind: 'add_server', tab: 'join' })}
          >
            Join a server
          </Button>
          <Button size="md" onClick={() => openDialog({ kind: 'add_server', tab: 'create' })}>
            Create a server
          </Button>
          <Button size="md" onClick={() => openFriends('add')}>
            Add a friend
          </Button>
        </Row>
      </Controls>
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
    <Stack gap="lg">
      <Surface tone="plain" radius="none" pad="2xs" gap="2xs">
        <h1 className="text-2xl font-semibold text-on-surface sm:text-3xl">Welcome</h1>
        <p className="text-sm text-on-surface-variant">{line}</p>
      </Surface>
      <Grid cols={{ base: 1, md: 2 }} gap="lg">
        <Card title="Browse servers" icon={<Compass size={18} />}>
          <Line>
            <p className="text-sm text-on-surface-variant">
              Enter a server name to open it. The name is the invite code.
            </p>
          </Line>
          <Controls>
            <Button
              variant="filled"
              size="md"
              onClick={() => openDialog({ kind: 'add_server', tab: 'join' })}
            >
              Find a server
            </Button>
          </Controls>
        </Card>
        <Card title={signup ? 'Create an account' : 'Log in'} icon={<LogIn size={18} />}>
          <Line>
            <p className="text-sm text-on-surface-variant">
              {signup ? 'Sign up' : 'Log in'} to {benefits}
            </p>
          </Line>
          <Controls>
            <Button
              variant="filled"
              size="md"
              onClick={() => {
                if (!client.show(loginAccount, 'none')) return
                logoutForLogin(loginAccount)
                router.replace(signup ? '/login?mode=register' : '/login')
              }}
            >
              {signup ? 'Sign up' : 'Log in'}
            </Button>
          </Controls>
        </Card>
      </Grid>
    </Stack>
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
      <Name of={instanceName(actor.instance)} look="text-xs" />
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
    <Row aria-label="Account" gap="2xs" align="stretch" wrap place="max-w-full">
      {accounts.map(actor => (
        <Surface
          key={actor.key}
          type="button"
          aria-pressed={actor === active}
          onClick={() => onPick(actor.key)}
          as="button"
          row
          pad="sm"
          inset="chip"
          gap="2xs"
          tone="plain"
          radius="full"
          look="outline-offset-2 hover-idle:bg-on-surface/8 focus-visible:outline-2 focus-visible:outline-primary pressed:bg-secondary-container pointer-coarse:min-h-11"
        >
          <HomeActorLabel actor={actor} />
        </Surface>
      ))}
    </Row>
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
      <h3>
        <Surface as="span" tone="plain" radius="none" pad="sm" inset="bar">
          <Row as="span" gap="2xs">
            <HomeActorLabel actor={actor} />
            <IconButton
              icon={CheckCheck}
              label="Mark all as read"
              size="sm"
              place="ml-auto"
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
            />
          </Row>
        </Surface>
      </h3>
      {(direct.pings > 0 || direct.unread) &&
        (actor.peer ? (
          <P2pDmUnreadRow pings={direct.pings} />
        ) : (
          <DmUnreadRow pings={direct.pings} />
        ))}
      {all ? servers : servers.slice(0, UNREAD_SHOWN)}
      {servers.length > UNREAD_SHOWN && (
        <Button onClick={() => setAll(!all)}>{all ? 'Show less' : 'Show more'}</Button>
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
    <Surface
      as="label"
      row
      pad="md"
      inset="chip"
      gap="sm"
      tone="base"
      radius="full"
      fit
      text="sm"
      place="inline-flex"
    >
      As <ActorAvatar row={actor.row} size={20} />
      <NameSelect
        aria-label="As"
        className="bg-transparent"
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
      </NameSelect>
    </Surface>
  )
  const total = accounts.reduce((n, a) => n + a.account.counts.value(), 0)
  return (
    <Stack gap="lg">
      <Greeting total={total} accounts={accounts.length} />
      <Row gap="sm" align="stretch" aria-label="Accounts" place="overflow-x-auto">
        {actors.map(a => (
          <Surface
            as="button"
            type="button"
            key={a.key}
            aria-pressed={a.row.active}
            onClick={() => void switchActor(a.row, shown)}
            pad="sm"
            gap="2xs"
            tone="low"
            radius="lg"
            look="text-left outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary pressed:bg-secondary-container"
            place="shrink-0"
          >
            <Row as="span" gap="2xs">
              <HomeActorLabel actor={a} />
            </Row>
            <span className="text-xs">
              {a.row.status} {a.row.badge > 0 && <PingBadge count={a.row.badge} />}
            </span>
          </Surface>
        ))}
        {canAdd && (
          <Button onClick={() => shown.store.getState().openDialog({ kind: 'add_instance' })}>
            Add an instance
          </Button>
        )}
      </Row>
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
      <Grid cols={{ base: 1, lg: 2 }} gap="lg" align="start">
        <Card title="Unread" icon={<Bell size={18} />}>
          <Stack gap="2xs">
            {actors.map(a => (
              <ActorScope key={a.key} actor={a}>
                <GroupUnread actor={a} />
              </ActorScope>
            ))}
            <Inset as="p" pad="sm" text="sm" ink="muted" look="only:flex" place="hidden">
              Nothing unread.
            </Inset>
          </Stack>
        </Card>
        <Stack gap="md">
          {identities.map(a => (
            <ActorScope key={a.key} actor={a}>
              {identities.length < 3 ? (
                <P2pCard actor={a} />
              ) : (
                <Surface
                  pad="sm"
                  tone="plain"
                  radius="lg"
                  look="border border-dashed border-tertiary"
                >
                  <details>
                    <summary className="cursor-pointer">
                      <Row as="span" gap="2xs" place="inline-flex">
                        <HomeActorLabel actor={a} />
                      </Row>
                    </summary>
                    <P2pCard actor={a} />
                  </details>
                </Surface>
              )}
            </ActorScope>
          ))}
        </Stack>
        <AccountCard accounts={accounts} kind="recent" />
        <AccountCard accounts={accounts} kind="inbox" />
        <AccountCard accounts={accounts} kind="pinned" />
        <Card title="Friends" icon={<Users size={18} />} className="lg:col-span-2">
          <FriendsSection max={5} />
        </Card>
      </Grid>
    </Stack>
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
    <Stack gap="lg">
      <Greeting />
      <Tips />
      <QuickActions />
      {p2pOn ? (
        <>
          {fresh && <GetStarted />}
          <Grid cols={{ base: 1, lg: 2 }} gap="lg" align="start">
            <div className="split-column lg:order-2">
              {showUnread && <UnreadSummary />}
              <P2pCard />
            </div>
            <div className="split-column">
              {!fresh && <JumpBackIn recents={recents} />}
              {inbox}
              {!fresh && <PinnedDms />}
              {friends}
            </div>
          </Grid>
        </>
      ) : (
        <Grid cols={{ base: 1, lg: 2 }} gap="lg">
          {fresh ? <GetStarted className="lg:col-span-2" /> : <JumpBackIn recents={recents} />}
          {showUnread && <UnreadSummary />}
          {inbox}
          {!fresh && <PinnedDms />}
          {friends}
        </Grid>
      )}
    </Stack>
  )
}

// Home: shown when no channel or DM is open.
export function HomePage({ onMenu }: { onMenu: () => void }) {
  const guest = useStore(s => s.guest)
  const signedIn = useStore(s => s.me !== null)
  const menuPings = useStore(allPings)
  return (
    <main data-home className="relative flex h-full min-w-0 flex-1 flex-col bg-surface">
      <Inset
        as="header"
        row
        pad="lg"
        inset="sides"
        gap="md"
        border="bottom"
        look="h-14"
        place="shrink-0"
      >
        <IconButton
          icon={Menu}
          label="Menu"
          tooltip={menuPings ? `Menu, ${pingLabel(menuPings)}` : undefined}
          onClick={onMenu}
          place="md:hidden"
        >
          <PingBadge
            count={menuPings}
            className="absolute -top-1 -right-1.5 border-2 border-surface"
          />
        </IconButton>
        <Row as="span" gap="sm">
          <House size={18} className="text-on-surface-variant" />
          <span className="font-medium">Home</span>
        </Row>
        <ViewActorTag header />
        <Row gap="sm" place="ml-auto shrink-0">
          <StatusClock />
          {signedIn && !guest && <InboxButton />}
          <PaletteButton />
        </Row>
      </Inset>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Inset pad="lg" safe place="mx-auto w-full max-w-5xl">
          <HomeContent member={signedIn && !guest} />
        </Inset>
      </div>
    </main>
  )
}
