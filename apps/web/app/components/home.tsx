'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  Bell,
  CheckCheck,
  Command,
  Compass,
  ExternalLink,
  Hash,
  House,
  Lightbulb,
  LogIn,
  Menu,
  MessageCircle,
  Pin,
  PinOff,
  Plus,
  Trash2,
  Users,
  Volume2,
  X,
} from 'lucide-react'
import {
  allPings,
  scopeMarkTargets,
  scopePingCount,
  scopeUnread,
  serversMarkTargets,
  useMask,
  useStore,
  type ContextMenuItem,
} from '../lib/store'
import {
  INBOX_SHOWN,
  PINNED_SHOWN,
  RECENTS_SHOWN,
  greeting,
  isNewAccount,
  recentKey,
  shownTips,
  type Recent,
} from '../lib/home'
import { forgetRecent, hideTip, parseSummary, unreadSummaryKey, useHome } from '../lib/home_store'
import { isMac, paletteShortcut, usePalette } from '../lib/palette'
import { dmSections } from '../lib/nav_layout'
import { enterKey } from '../lib/keys'
import type { DmSummary } from '../lib/types'
import { longPress } from './context_menu'
import { dragScope, useDrag } from './drag'
import { InboxButton, InboxPreview } from './inbox'
import { FriendsSection } from './friends'
import { PingBadge, pingLabel } from './ping_badge'
import { ServerGlyph } from './server_rail'
import StatusClock from './status_clock'
import { UserAvatar } from './user_avatar'
import { Masked, SkeletonRows, fieldCls, filledBtn, textBtn } from './ui'
import { markReadItem } from './mark_read'

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

function Greeting() {
  const me = useStore(s => s.me)
  const streamer = useStore(s => s.streamer)
  const pings = useStore(allPings)
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
              <Masked text={me.display_name} />
            </span>
          </>
        )}
      </h1>
      <p className="text-sm text-on-surface-variant">
        {pings > 0 ? `You have ${pingLabel(pings)}.` : "You're all caught up."}
      </p>
    </div>
  )
}

function Tips() {
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
            onClick={() => hideTip(t.id)}
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

function QuickActions() {
  const openDialog = useStore(s => s.openDialog)
  const startDm = useStore(s => s.startDm)
  const palette = usePalette(s => s.open)
  const [asking, setAsking] = useState(false)
  const [name, setName] = useState('')
  const submit = () => {
    const target = name.trim().replace(/^@/, '').toLowerCase()
    if (!target) return
    setAsking(false)
    setName('')
    void startDm(target)
  }
  return (
    <section aria-label="Quick actions" className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <button
          type="button"
          onClick={() => openDialog({ kind: 'add_server', tab: 'create' })}
          className={actionCls}
        >
          <Plus size={18} className="shrink-0 text-primary" />
          <span className="min-w-0 leading-tight">Create server</span>
        </button>
        <button
          type="button"
          onClick={() => openDialog({ kind: 'add_server', tab: 'join' })}
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
          <button type="button" onClick={palette} className={actionCls}>
            <Command size={18} className="shrink-0 text-primary" />
            <span className="min-w-0 leading-tight">Command palette</span>
            <kbd className="ml-auto shrink-0 rounded-md border border-outline-variant px-1.5 font-sans text-xs text-on-surface-variant">
              {paletteShortcut(isMac())}
            </kbd>
          </button>
        )}
      </div>
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
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') setAsking(false)
              else if (enterKey(e)) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder="username"
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

function RecentRow({ recent }: { recent: Recent }) {
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
  const openContextMenu = useStore(s => s.openContextMenu)
  const markScopesRead = useStore(s => s.markScopesRead)
  const mask = useMask()
  const open = () => {
    const s = useStore.getState()
    if (recent.kind === 'dm') void s.openDm(recent.dmId)
    else void s.openServer(recent.server, recent.channelId)
  }
  const streamer = useStore(s => s.streamer)
  const label =
    recent.kind === 'dm' ? (dm?.other.display_name ?? '') : (channel?.name ?? recent.channel ?? '')
  const items = (): ContextMenuItem[] => [
    { label: 'Open', icon: ExternalLink, action: open },
    markReadItem(scopeMarkTargets(useStore.getState(), key), () => void markScopesRead([key])),
    { label: 'Remove from Jump back in', icon: Trash2, action: () => forgetRecent(key) },
  ]
  return (
    <button
      type="button"
      data-recent={key}
      onClick={open}
      title={
        streamer
          ? recent.kind === 'dm'
            ? 'Direct message'
            : 'Channel'
          : recent.kind === 'dm'
            ? mask(label)
            : `${mask(label)}, ${mask(serverName)}`
      }
      {...longPress((x, y) => openContextMenu(x, y, items()))}
      className={rowCls}
    >
      {recent.kind === 'dm' && dm ? (
        <UserAvatar
          username={dm.other.username}
          avatarKind={dm.other.avatar_kind}
          avatarColor={dm.other.avatar_color}
          size={32}
        />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-surface-container-highest text-on-surface-variant">
          {channel?.kind === 'voice' ? <Volume2 size={16} /> : <Hash size={16} />}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={`streamer truncate text-sm ${unread || pings ? 'font-semibold text-on-surface' : 'text-on-surface'}`}
        >
          <Masked text={label} />
        </span>
        <span className="streamer truncate text-xs text-on-surface-variant">
          {recent.kind === 'dm' ? (
            dm?.is_self ? (
              'Notes to yourself'
            ) : (
              'Direct message'
            )
          ) : (
            <Masked text={serverName} />
          )}
        </span>
      </span>
      <UnreadMark unread={unread} pings={pings} />
    </button>
  )
}

function JumpBackIn({ recents }: { recents: Recent[] }) {
  const joined = useStore(s => s.me?.servers)
  const serversMore = useStore(s => s.serversMore)
  const dms = useStore(s => s.dms)
  const shown = useMemo(() => {
    const names = new Set((joined ?? []).map(x => x.name))
    const dmIds = new Set(dms.map(d => d.id))
    return recents
      .filter(r =>
        r.kind === 'dm' ? dmIds.has(r.dmId) : names.has(r.server) || (serversMore && !!r.channel)
      )
      .slice(0, RECENTS_SHOWN)
  }, [recents, joined, serversMore, dms])
  return (
    <Card title="Jump back in" icon={<House size={18} />}>
      {shown.length === 0 ? (
        <Empty>Channels and DMs you open show up here.</Empty>
      ) : (
        <div className="flex flex-col">
          {shown.map(r => (
            <RecentRow key={recentKey(r)} recent={r} />
          ))}
        </div>
      )}
    </Card>
  )
}

function ServerUnreadRow({
  name,
  pings,
  channels,
}: {
  name: string
  pings: number
  channels: number
}) {
  const display = useStore(
    s =>
      s.me?.servers.find(x => x.name === name)?.display_name ??
      s.servers[name]?.display_name ??
      name
  )
  const openServer = useStore(s => s.openServer)
  const markServerRead = useStore(s => s.markServerRead)
  const openContextMenu = useStore(s => s.openContextMenu)
  const mask = useMask()
  const shown = mask(display)
  const detail =
    channels > 0
      ? `${channels} unread ${channels === 1 ? 'channel' : 'channels'}`
      : pingLabel(pings)
  return (
    <div
      data-unread-server={name}
      {...longPress((x, y) =>
        openContextMenu(x, y, [
          { label: 'Open', icon: ExternalLink, action: () => void openServer(name) },
          markReadItem(
            serversMarkTargets(useStore.getState(), [name]),
            () => void markServerRead(name)
          ),
        ])
      )}
      className="flex min-w-0 items-center gap-1 rounded-xl hover:bg-surface-container-high"
    >
      <button
        type="button"
        onClick={() => void openServer(name)}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-container-highest text-sm font-semibold text-on-surface">
          <ServerGlyph name={name} displayName={display} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="streamer truncate text-sm font-semibold text-on-surface">{shown}</span>
          <span className="truncate text-xs text-on-surface-variant">{detail}</span>
        </span>
        <PingBadge count={pings} className="ml-auto" />
      </button>
      <button
        type="button"
        title="Mark as read"
        aria-label={`Mark ${shown} as read`}
        onClick={() => void markServerRead(name)}
        className="shrink-0 rounded-full p-2 text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface"
      >
        <CheckCheck size={18} />
      </button>
    </div>
  )
}

function DmUnreadRow({ pings }: { pings: number }) {
  const markDmsRead = useStore(s => s.markDmsRead)
  const openLastDm = useStore(s => s.openLastDm)
  return (
    <div
      data-unread-server="dms"
      className="flex min-w-0 items-center gap-1 rounded-xl hover:bg-surface-container-high"
    >
      <button
        type="button"
        onClick={openLastDm}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-surface-container-highest text-on-surface">
          <MessageCircle size={16} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold text-on-surface">Direct messages</span>
          <span className="truncate text-xs text-on-surface-variant">
            {pings > 0 ? pingLabel(pings) : 'Unread messages'}
          </span>
        </span>
        <PingBadge count={pings} className="ml-auto" />
      </button>
      <button
        type="button"
        title="Mark as read"
        aria-label="Mark direct messages as read"
        onClick={() => void markDmsRead()}
        className="shrink-0 rounded-full p-2 text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface"
      >
        <CheckCheck size={18} />
      </button>
    </div>
  )
}

const UNREAD_SHOWN = 6

function UnreadSummary() {
  const ready = useStore(s => s.readsReady)
  const key = useStore(unreadSummaryKey)
  const askMarkAllRead = useStore(s => s.askMarkAllRead)
  const [all, setAll] = useState(false)
  const summary = useMemo(() => parseSummary(key), [key])
  const dms = summary.dms.unread || summary.dms.pings > 0
  const rows = all ? summary.servers : summary.servers.slice(0, UNREAD_SHOWN)
  const any = dms || summary.servers.length > 0
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
            onClick={askMarkAllRead}
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
          {rows.map(r => (
            <ServerUnreadRow key={r.name} {...r} />
          ))}
          {summary.servers.length > UNREAD_SHOWN && (
            <button
              type="button"
              onClick={() => setAll(a => !a)}
              className={`${textBtn} self-start`}
            >
              {all ? 'Show less' : `Show ${summary.servers.length - UNREAD_SHOWN} more`}
            </button>
          )}
        </div>
      )}
    </Card>
  )
}

function PinnedDmRow({ dm }: { dm: DmSummary }) {
  const key = `d${dm.id}`
  const unread = useStore(s => scopeUnread(s, key))
  const pings = useStore(s => scopePingCount(s, key))
  const openDm = useStore(s => s.openDm)
  const unpinDm = useStore(s => s.unpinDm)
  const placeDm = useStore(s => s.placeDm)
  const markScopesRead = useStore(s => s.markScopesRead)
  const openContextMenu = useStore(s => s.openContextMenu)
  const streamer = useStore(s => s.streamer)
  const mask = useMask()
  return (
    <button
      type="button"
      data-pinned-dm={dm.id}
      title={streamer ? 'Direct message' : mask(dm.other.display_name)}
      onClick={() => void openDm(dm.id)}
      {...longPress(
        (x, y) =>
          openContextMenu(x, y, [
            { label: 'Open', icon: ExternalLink, action: () => void openDm(dm.id) },
            markReadItem(
              scopeMarkTargets(useStore.getState(), key),
              () => void markScopesRead([key])
            ),
            { label: 'Unpin DM', icon: PinOff, action: () => unpinDm(dm.id) },
          ]),
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
          <Masked text={dm.other.display_name} />
        </span>
        <span className="streamer truncate text-xs text-on-surface-variant">
          {dm.is_self ? 'Notes to yourself' : `@${dm.other.username}`}
        </span>
      </span>
      <UnreadMark unread={unread} pings={pings} />
    </button>
  )
}

function PinnedDms() {
  const dms = useStore(s => s.dms)
  const layout = useStore(s => s.layout)
  const dragging = useDrag(s => s.group === 'home_dm')
  const pinned = useMemo(() => dmSections(dms, layout).pinned.slice(0, PINNED_SHOWN), [dms, layout])
  return (
    <Card title="Pinned DMs" icon={<Pin size={18} />}>
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

function GetStarted() {
  const openDialog = useStore(s => s.openDialog)
  const openFriends = useStore(s => s.openFriends)
  return (
    <Card title="Get started" icon={<House size={18} />} className="lg:col-span-2">
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
  const logout = useStore(s => s.logout)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 px-1">
        <h1 className="text-2xl font-semibold text-on-surface sm:text-3xl">Welcome</h1>
        <p className="text-sm text-on-surface-variant">
          You&apos;re browsing as a guest. You can read servers but not post.
        </p>
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
        <Card title="Create an account" icon={<LogIn size={18} />}>
          <p className="px-2 text-sm text-on-surface-variant">
            Sign up to send messages, add friends and get notified when someone mentions you.
          </p>
          <button
            type="button"
            onClick={() => {
              logout()
              router.replace('/login?mode=register')
            }}
            className={`${filledBtn} mx-2 mt-2 self-start`}
          >
            Sign up
          </button>
        </Card>
      </div>
    </div>
  )
}

function MemberHome() {
  const recents = useHome(s => s.prefs.recents)
  const otherDms = useStore(s => s.dms.filter(d => !d.is_self).length)
  const servers = useStore(s => s.me?.servers.length ?? 0)
  const fresh = isNewAccount(recents.length, otherDms, servers)
  return (
    <div className="flex flex-col gap-4">
      <Greeting />
      <Tips />
      <QuickActions />
      <div className="grid gap-4 lg:grid-cols-2">
        {fresh ? <GetStarted /> : <JumpBackIn recents={recents} />}
        {!fresh && <UnreadSummary />}
        <Card title="Inbox" icon={<Bell size={18} />}>
          <InboxPreview max={INBOX_SHOWN} />
        </Card>
        {!fresh && <PinnedDms />}
        <Card title="Friends" icon={<Users size={18} />}>
          <FriendsSection max={5} />
        </Card>
      </div>
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
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-outline-variant px-4">
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
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <StatusClock />
          {signedIn && !guest && <InboxButton />}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6">
          {signedIn && !guest ? <MemberHome /> : <GuestHome />}
        </div>
      </div>
    </main>
  )
}
