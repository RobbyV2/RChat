'use client'
import { useAddingAllowed } from './add_instance'
import { Globe } from 'lucide-react'
import { voiceLabel } from '../lib/voice_rail'
import { RailVoiceBadge, useHostedVoice, useVoiceLists } from './rail_voice_badge'
import { P2pProvider, useP2pApp, useP2p } from '../lib/client/p2p_react'

import type { CSSProperties } from 'react'
import { logoutForLogin } from '../login/account_login'
import { useRouter } from 'next/navigation'
import {
  Eye,
  Folder as FolderIcon,
  FolderOpen,
  House,
  LogOut,
  MessageCircle,
  Play,
  Plus,
  Settings,
  Shield,
} from 'lucide-react'
import {
  folderLabel,
  previewServer,
  type RailServer,
  railServers,
  scopeMuted,
  serverPingCount,
  serverUnread,
  useMask,
  useStore,
} from '../lib/store'
import { AccountProvider, useAccount, useLiveSessions } from '../lib/client/react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ownInstance } from '../lib/instances'
import { client } from '../lib/client/client'
import { railBlocks } from '../lib/client/rail_blocks'
import {
  createSwitcherSource,
  signOutSwitcherAccount,
  type SwitcherRow,
} from '../lib/client/switcher_rows'
import { switchActor, switcherSession } from '../lib/client/switch_actor'
import { ActorAvatar } from './account_tag'
import type { AccountSession } from '../lib/client/session'
import type { P2pApp } from '../lib/p2p/app/runtime'
import { railActivity } from '../lib/client/rail_activity'
import type { RChatState } from '../lib/store_types'
import { openActionMenu } from '../lib/actions/menu'
import { folderKey, railItems, serverKey, type Folder } from '../lib/nav_layout'
import { folderStyle } from '../lib/folder_colors'
import type { DropTarget } from '../lib/drag'
import type { ServerDetail } from '../lib/types'
import { iconKind } from '../lib/server_about'
import { serverIconColor, serverIconKind } from '../lib/selectors'
import { ServerIcon } from './server_about'
import { longPress } from './context_menu'
import { dragScope } from './drag'
import { InstallButton } from './pwa_register'
import { AccountSwitcherTile } from './account_switcher'
import { ThemeToggle } from './status_clock'
import { PaletteButton } from './palette'
import { IconButton } from './controls'
import { Sentinel, useOwnServer } from './ui'
import { ServerRailSkeleton } from './skeletons'
import { RailPingBadge, pingLabel } from './ping_badge'
import { MutedIcon } from './notify_menu'
import { P2pRailTile } from './p2p/p2p_home'
import { P2pJoinTile, P2pServerRail } from './p2p/p2p_server_view'

const tile = 'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition-colors'
const idle =
  'bg-surface-container-high text-on-surface hover:bg-primary-container hover:text-on-primary-container'

const NO_DETAILS: Record<string, ServerDetail> = {}
const SERVER = serverKey('')
const FOLDER = folderKey('')

const strip = (key: string | null, prefix: string) =>
  key?.startsWith(prefix) ? key.slice(prefix.length) : null

const dropServer = (s: RChatState, name: string, { zone, index, onto }: DropTarget) => {
  const folder = strip(onto, FOLDER)
  const target = strip(onto, SERVER)
  const into = strip(zone, FOLDER)
  if (folder !== null) s.addToFolder(name, folder)
  else if (target !== null) s.mergeServers(name, target)
  else if (into !== null) s.moveIntoFolder(name, into, index)
  else s.moveServer(name, index)
}

// A hosted server's icon. `look` is the server as an invite or search shows it; without it
// the icon follows this account's server list.
export function ServerGlyph({
  name,
  displayName,
  look,
  framed = false,
}: {
  name: string
  displayName: string
  look?: { icon_kind?: string | null; banner_color?: string | null }
  framed?: boolean
}) {
  const own = useOwnServer(name)
  const kind = useStore(s => (look ? iconKind(look.icon_kind) : serverIconKind(s, name)))
  const color = useStore(s => (look ? (look.banner_color ?? null) : serverIconColor(s, name)))
  return name === 'rchat' ? (
    <img
      src="/rchat_r.png"
      alt="RChat"
      draggable={false}
      className="h-full w-full object-contain p-1"
    />
  ) : (
    <ServerIcon
      seed={name}
      name={displayName}
      kind={kind}
      color={color}
      own={own}
      framed={framed}
    />
  )
}

function UnreadDot() {
  return (
    <span
      title="Unread messages"
      aria-hidden
      className="absolute -top-1 -right-1 h-3 w-3 rounded-full border-2 border-(--rail-cut,var(--color-surface-container-lowest)) bg-error"
    />
  )
}

function ServerTile({
  server: { name, display_name, creator },
  folder,
  at,
}: {
  server: RailServer
  folder: string | null
  at: number
}) {
  const account = useAccount()
  const me = useStore(s => s.me)
  const p2pOpen = useP2p(s => s.home || s.server !== null)
  const active = useStore(s => s.view?.kind === 'channel' && s.view.server === name) && !p2pOpen
  const unread = useStore(s => serverUnread(s, name))
  const pings = useStore(s => serverPingCount(s, name))
  const voice = useHostedVoice([name])
  const openServer = useStore(s => s.openServer)
  const muted = useStore(s => scopeMuted(s, { kind: 'server', name }))
  const mine = me !== null && creator === me.username
  const mask = useMask(mine)
  const streamer = useStore(s => s.streamer)
  const shown = streamer ? 'Server' : mask(display_name)
  const parent = folder === null ? null : folderKey(folder)
  return (
    <button
      title={`${mine ? `${shown} (Creator)` : shown}${muted ? ', muted' : ''}${pings ? `, ${pingLabel(pings)}` : ''}${voiceLabel(voice)}`}
      onClick={() => {
        if (client.shown() !== account) client.show(account)
        account.identities.viewed()?.p2p.closeHome()
        void openServer(name)
      }}
      {...longPress(
        (x, y) => openActionMenu(x, y, { kind: 'server', server: name, folder, at }, {}, account),
        {
          group: 'rail',
          key: serverKey(name),
          // P2P servers have zones of their own.
          zones: zone => zone !== 'p2p' && !zone.startsWith('p2p:'),
          onto: key => key !== parent,
          onDrop: target => dropServer(account.store.getState(), name, target),
        }
      )}
      data-drop-onto={folder === null ? 'Create folder' : undefined}
      className={`${tile} relative text-lg font-semibold ${active ? 'bg-primary text-on-primary' : idle}`}
    >
      <span
        className={`flex h-full w-full items-center justify-center rounded-[inherit] ${muted && !active ? 'opacity-50' : ''}`}
      >
        <ServerGlyph name={name} displayName={display_name} framed={active} />
      </span>
      <MutedIcon
        scope={{ kind: 'server', name }}
        size={10}
        className="absolute -bottom-1 -left-1 size-5 items-center justify-center rounded-full border-2 border-(--rail-cut,var(--color-surface-container-lowest)) bg-surface-container-highest text-on-surface-variant"
      />
      {mine && (
        <span
          title="Creator"
          className="absolute -right-1 -bottom-0.5 rounded-full bg-tertiary-container px-1.5 text-3xs leading-4 font-bold text-on-tertiary-container"
        >
          C
        </span>
      )}
      {pings > 0 ? <RailPingBadge count={pings} /> : unread && <UnreadDot />}
      <RailVoiceBadge count={voice} />
    </button>
  )
}

// The previewed server (open without joining). It shows only while open and is never saved to
// the layout. A dashed, dimmed tile with an eye badge marks it.
function PreviewTile() {
  const account = useAccount()
  const name = useStore(previewServer)
  const display = useStore(s => (name ? (s.servers[name]?.display_name ?? name) : ''))
  const openServer = useStore(s => s.openServer)
  const mask = useMask(useOwnServer(name))
  const streamer = useStore(s => s.streamer)
  if (!name) return null
  const label = streamer ? 'Previewing a server' : `Previewing ${mask(display)}`
  return (
    <button
      data-preview-tile={name}
      title={label}
      aria-label={label}
      aria-current="page"
      onClick={() => {
        if (client.shown() !== account) client.show(account)
        account.identities.viewed()?.p2p.closeHome()
        void openServer(name)
      }}
      {...longPress((x, y) =>
        openActionMenu(x, y, { kind: 'server', server: name, folder: null, at: -1 }, {}, account)
      )}
      className={`${tile} relative border-2 border-dashed border-primary bg-surface-container-high text-lg font-semibold text-on-surface`}
    >
      <span className="flex h-full w-full items-center justify-center rounded-[inherit] opacity-60">
        <ServerGlyph name={name} displayName={display} />
      </span>
      <span
        aria-hidden
        className="absolute -right-1.5 -bottom-1.5 flex size-5 items-center justify-center rounded-full border-2 border-(--rail-cut,var(--color-surface-container-lowest)) bg-primary text-on-primary"
      >
        <Eye size={11} strokeWidth={2.5} />
      </span>
    </button>
  )
}

function MiniIcon({ server: { name, display_name } }: { server: RailServer }) {
  const p2pOpen = useP2p(s => s.home || s.server !== null)
  const active = useStore(s => s.view?.kind === 'channel' && s.view.server === name) && !p2pOpen
  return (
    <span
      className={`flex min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-md text-3xs leading-none font-semibold ${
        active ? 'bg-primary text-on-primary' : 'folder-mini'
      }`}
    >
      {name === 'rchat' ? (
        <img src="/rchat_r.png" alt="" draggable={false} className="h-full w-full object-contain" />
      ) : (
        <ServerGlyph name={name} displayName={display_name} framed={active} />
      )}
    </span>
  )
}

export function FolderEntry({
  folder,
  servers,
  at,
}: {
  folder: Folder
  servers: RailServer[]
  at: number
}) {
  const account = useAccount()
  const toggleFolder = useStore(s => s.toggleFolder)
  const moveFolder = useStore(s => s.moveFolder)
  const unread = useStore(s => !folder.open && servers.some(x => serverUnread(s, x.name)))
  const pings = useStore(s =>
    folder.open ? 0 : servers.reduce((n, x) => n + serverPingCount(s, x.name), 0)
  )
  const voice = useHostedVoice(folder.open ? [] : servers.map(x => x.name))
  const key = folderKey(folder.id)
  const label = useStore(s => (s.streamer ? folder.name || 'Folder' : folderLabel(s, folder)))
  const theme = useStore(s => s.theme)
  const style = folderStyle(folder.color, theme) as CSSProperties | undefined
  const header = {
    title: `${label}${voiceLabel(voice)}`,
    'aria-expanded': folder.open,
    'data-drop-onto': 'Add to folder',
    onClick: () => toggleFolder(folder.id),
    ...longPress(
      (x, y) =>
        openActionMenu(
          x,
          y,
          {
            kind: 'folder',
            folder: { ...folder, servers: servers.map(x => x.name) },
          },
          {},
          account
        ),
      {
        group: 'rail',
        key,
        zones: zone => zone === 'servers',
        onDrop: ({ index }) => moveFolder(folder.id, index),
      }
    ),
  }
  if (!folder.open) {
    return (
      <button {...header} style={style} className={`${tile} folder-tile relative p-1.5`}>
        <span className="grid size-9 grid-cols-2 grid-rows-2 gap-1">
          {servers.slice(0, 4).map(s => (
            <MiniIcon key={s.name} server={s} />
          ))}
        </span>
        <span
          aria-hidden
          className="folder-badge absolute -right-1 -bottom-1 flex size-4.5 items-center justify-center rounded-full border-2 border-(--rail-cut,var(--color-surface-container-lowest))"
        >
          <FolderIcon size={9} strokeWidth={2.5} />
        </span>
        {pings > 0 ? <RailPingBadge count={pings} /> : unread && <UnreadDot />}
        <RailVoiceBadge count={voice} />
      </button>
    )
  }
  return (
    <div
      data-drag-box
      style={style}
      className="folder-group flex w-14 shrink-0 flex-col items-center rounded-group py-1"
    >
      <button {...header} className={`${tile} folder-icon`}>
        <FolderOpen size={22} />
      </button>
      <div
        data-drop-zone={key}
        data-drop-label="Add to folder"
        className="flex flex-col items-center gap-2 pt-2"
      >
        {servers.map(s => (
          <ServerTile key={s.name} server={s} folder={folder.id} at={at} />
        ))}
      </div>
    </div>
  )
}

// Direct messages: the badge counts the instance's DM and friend pings and the P2P
// conversations' pings, the dot an unread DM in either.
function DmTile({ active, pings, unread }: { active: boolean; pings: number; unread: boolean }) {
  const account = useAccount()
  const openLastDm = useStore(s => s.openLastDm)
  return (
    <button
      data-rail="dms"
      title={pings ? `Direct messages, ${pingLabel(pings)}` : 'Direct messages'}
      aria-label="Direct messages"
      onClick={openLastDm}
      {...longPress((x, y) => openActionMenu(x, y, { kind: 'home' }, {}, account))}
      className={`${tile} relative ${active ? 'bg-primary text-on-primary' : idle}`}
    >
      <MessageCircle size={22} />
      {pings > 0 ? <RailPingBadge count={pings} /> : unread && <UnreadDot />}
    </button>
  )
}

const column = 'flex shrink-0 flex-col items-center gap-2'
function ResumeAccount({ row }: { row: SwitcherRow }) {
  const streamer = useStore(s => s.streamer)
  const label = streamer
    ? 'Show paused account'
    : 'Show ' + row.display + ' on ' + new URL(row.origin).host
  return (
    <button
      title={label}
      aria-label={label}
      className={tile + ' ' + idle}
      onClick={() => void switchActor(row, client.shown())}
    >
      <Play size={18} />
    </button>
  )
}

export function AccountServers({ row }: { row?: SwitcherRow }) {
  const me = useStore(s => s.me)
  const bootError = useStore(s => s.bootError)
  const saved = useStore(s => s.layout.servers)
  const guest = useStore(s => s.guest)
  const guestServers = useStore(s => s.guestServers)
  const guestNames = useStore(s => s.guestNames)
  const servers = useStore(s => (s.me ? NO_DETAILS : s.servers))
  const serversMore = useStore(s => s.serversMore)
  const loadMoreServers = useStore(s => s.loadMoreServers)
  useVoiceLists()
  if (row?.username && !me)
    return row.status === 'Connecting' && !bootError ? (
      <ServerRailSkeleton seed={row.origin + ':' + row.username} />
    ) : (
      <ResumeAccount row={row} />
    )
  const items = railItems(
    railServers({ me, guest, guestServers, guestNames, servers }),
    x => x.name,
    saved
  )

  return (
    <div ref={dragScope} className={column}>
      {me && <PreviewTile />}
      <div
        data-rail="servers"
        data-drop-zone="servers"
        data-drop-label="Remove from folder"
        className="flex shrink-0 flex-col items-center gap-2"
      >
        {items.map((item, at) =>
          item.kind === 'server' ? (
            <ServerTile key={item.key} server={item.server} folder={null} at={at} />
          ) : (
            <FolderEntry key={item.key} folder={item.folder} servers={item.servers} at={at} />
          )
        )}
      </div>
      {me && serversMore && <Sentinel key={me.servers.length} onVisible={loadMoreServers} />}
    </div>
  )
}
type PeerBlock = { account: AccountSession; app: P2pApp; label: string }
function selectPeer({ account, app }: PeerBlock) {
  if (client.shown() !== account) client.show(account)
  if (account.identities.viewed() !== app) account.identities.show(app)
}
function PeerBlockView({ peer, children }: { peer: PeerBlock; children: React.ReactNode }) {
  return (
    <AccountProvider session={peer.account}>
      <P2pProvider identity={peer.app}>
        <div
          ref={dragScope}
          className={column}
          onClickCapture={e => {
            if (!(e.target as HTMLElement).closest('[data-peer-home]')) selectPeer(peer)
          }}
        >
          {children}
        </div>
      </P2pProvider>
    </AccountProvider>
  )
}
export function ServerRail() {
  const canAdd = useAddingAllowed()
  const [source] = useState(createSwitcherSource)
  const rows = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const model = railBlocks(rows.groups, canAdd ? undefined : ownInstance()?.origin)
  const streamer = useStore(s => s.streamer)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const toggle = (key: string) =>
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const identity = useP2pApp()
  const p2pView = identity?.p2p

  const router = useRouter()
  const me = useStore(s => s.me)
  const view = useStore(s => s.view)
  const goHome = useStore(s => s.goHome)
  const openDialog = useStore(s => s.openDialog)
  const openAdmin = useStore(s => s.openAdmin)
  const loginAccount = useAccount()
  const live = useLiveSessions()
  const accounts = useMemo(() => {
    const ordered = model.blocks.flatMap(g => g.accounts.flatMap(r => switcherSession(r) ?? []))
    return model.accountCount || (!canAdd && !loginAccount.conn.isDefault)
      ? ordered
      : [loginAccount]
  }, [rows, live, loginAccount, canAdd])
  const activity = useMemo(() => railActivity(accounts), [accounts])
  const activityRows = useSyncExternalStore(
    activity.subscribe,
    activity.snapshot,
    activity.snapshot
  )
  const peerTiles: { key: string; label: string; live?: PeerBlock; row?: SwitcherRow }[] = []
  const peers: PeerBlock[] = []
  for (const group of model.blocks) {
    for (const parent of group.accounts) {
      if (!parent.username) continue
      const owner = switcherSession(parent)
      const activity = activityRows.find(a => a.account === owner)
      if (activity && !activity.p2pAvailable) continue
      const running = new Map(activity?.peers.map(p => [p.app.localId, p]))
      const saved = group.peers.filter(row => row.username === parent.username)
      const locals = new Set([...saved.map(row => row.local!), ...running.keys()])
      for (const local of locals) {
        const row = saved.find(r => r.local === local)
        const app = running.get(local)
        const label = streamer
          ? 'P2P identity'
          : (app?.name || row?.display || local) +
            ', P2P as ' +
            parent.username +
            ' on ' +
            group.name
        const live = owner && app ? { account: owner, app: app.app, label } : undefined
        if (live) peers.push(live)
        peerTiles.push({
          key: JSON.stringify([group.origin, parent.username, local]),
          label,
          live,
          row,
        })
      }
    }
  }
  const joined = peers.filter(p => p.app.useP2p.getState().enabled)
  const groupedPeers =
    peerTiles.length > 1 ||
    peerTiles.some(p => !p.live) ||
    model.accountCount > 1 ||
    !accounts.includes(loginAccount)
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const rail = scroller.current
    if (
      !rail ||
      !window.matchMedia('(max-width: 767px)').matches ||
      (!model.instanceHeaders && model.accountCount < 2)
    )
      return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        const block = rail.querySelector<HTMLElement>('[data-shown-block="true"]')
        if (block)
          rail.scrollTop += block.getBoundingClientRect().top - rail.getBoundingClientRect().top
      }
    })
    observer.observe(rail)
    return () => observer.disconnect()
  }, [loginAccount, model.accountCount, model.instanceHeaders])
  const p2pHome = useP2p(s => s.home || s.server !== null)
  const p2pBeside = useP2p(s => s.home && s.dmList)
  // Set only while the instance has P2P on for this account.
  const p2pOn = useP2p(s => s.account !== null)
  const p2pEnabled = useP2p(s => s.enabled)
  const atHome = useStore(s => s.home && s.view === null) && !p2pHome

  return (
    <nav className="flex h-full w-18 shrink-0 flex-col bg-surface-container-lowest">
      <div data-rail="instance" className="flex shrink-0 flex-col items-center gap-1.5 pt-2">
        <AccountSwitcherTile />
        <div className="h-px w-8 bg-outline-variant" />
      </div>
      <div
        ref={scroller}
        onClickCapture={e => {
          // Opening a DM, server or folder leaves the P2P home.
          const t = e.target as HTMLElement
          if (
            t.closest('button') &&
            !t.closest('[data-p2p-tile],[data-peer-section],[data-account-section]')
          )
            p2pView?.closeHome()
        }}
        className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto pt-2 pb-2"
      >
        <button
          title="Home"
          aria-label="Home"
          aria-current={atHome ? 'page' : undefined}
          data-home-button
          data-rail="home"
          onClick={goHome}
          className={`${tile} ${atHome ? 'bg-primary text-on-primary' : idle}`}
        >
          <House size={22} />
        </button>
        {me && (
          <DmTile
            pings={activityRows.reduce((sum, row) => sum + row.pings, 0)}
            unread={activityRows.some(row => row.unread)}
            active={view?.kind === 'dm' && (!p2pHome || p2pBeside)}
          />
        )}
        <button
          data-rail="add-server"
          title="Add a server"
          aria-label="Add a server"
          onClick={() => openDialog({ kind: 'add_server' })}
          className={`${tile} bg-primary-container text-on-primary-container shadow-elevation-1 hover:bg-primary hover:text-on-primary`}
        >
          <Plus size={22} />
        </button>
        {canAdd && (
          <button
            type="button"
            title="Add an instance"
            aria-label="Add an instance"
            className={`${tile} ${idle}`}
            onClick={() => openDialog({ kind: 'add_instance' })}
          >
            <Globe size={22} />
          </button>
        )}
        {(groupedPeers ? peerTiles.length > 0 : p2pOn) && (
          <div
            data-rail="p2p"
            className="flex shrink-0 flex-col items-center gap-2 rounded-group border-2 border-dashed border-tertiary/70 p-[3px]"
          >
            {groupedPeers ? (
              <>
                {peerTiles.map(({ key, live, row, label }) =>
                  live ? (
                    <PeerBlockView key={key} peer={live}>
                      <P2pRailTile actorLabel={label} />
                    </PeerBlockView>
                  ) : (
                    row && (
                      <button
                        key={key}
                        data-p2p-tile
                        data-peer-home
                        title={label + ' (paused)'}
                        aria-label={label}
                        aria-pressed={false}
                        className={tile + ' relative ' + idle}
                        onClick={() => void switchActor(row, client.shown())}
                      >
                        <ActorAvatar row={row} size={28} />
                        {row.badge > 0 && <RailPingBadge count={row.badge} />}
                      </button>
                    )
                  )
                )}
                {joined.length === 1 && (
                  <PeerBlockView peer={joined[0]}>
                    <P2pJoinTile />
                  </PeerBlockView>
                )}
                {joined.length > 1 && (
                  <label
                    data-p2p-tile
                    data-p2p-join
                    title="Create or join a P2P server"
                    className={tile + ' relative ' + idle}
                  >
                    <Plus size={22} />
                    <select
                      aria-label="Create or join a P2P server as"
                      value=""
                      className="absolute inset-0 cursor-pointer opacity-0"
                      onChange={e => {
                        const peer = joined.find(
                          p => p.account.renderKey + ':' + p.app.localId === e.target.value
                        )
                        if (peer) {
                          selectPeer(peer)
                          peer.app.p2p.openDialog({ kind: 'server_new' })
                        }
                      }}
                    >
                      <option value="" disabled>
                        As
                      </option>
                      {joined.map(peer => (
                        <option
                          key={peer.account.renderKey + ':' + peer.app.localId}
                          value={peer.account.renderKey + ':' + peer.app.localId}
                        >
                          {peer.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            ) : (
              <>
                <P2pRailTile />
                {p2pEnabled && <P2pJoinTile />}
              </>
            )}
          </div>
        )}
        <div className="my-1 h-px w-8 shrink-0 bg-outline-variant" />
        {model.accountCount > 1 || model.instanceHeaders ? (
          model.blocks.map(group => (
            <div key={group.origin} className={column}>
              {model.instanceHeaders && (
                <button
                  title={streamer ? 'Instance' : group.name + ' (' + group.host + ')'}
                  aria-expanded={!collapsed.has(group.origin)}
                  onClick={() => toggle(group.origin)}
                  className="relative h-5 w-10 rounded bg-surface-container-high text-xs"
                >
                  <span className="streamer">{group.name.slice(0, 1)}</span>
                  {collapsed.has(group.origin) && group.pings > 0 && (
                    <RailPingBadge count={group.pings} />
                  )}
                </button>
              )}
              {!collapsed.has(group.origin) &&
                group.accounts.map(row => {
                  const account = switcherSession(row)
                  const key = JSON.stringify([row.origin, row.username])
                  return (
                    <div
                      key={key}
                      data-account-section
                      data-shown-block={account === loginAccount}
                      className={
                        column + (account === loginAccount ? ' border-l-[3px] border-primary' : '')
                      }
                    >
                      {group.accounts.length > 1 && (
                        <button
                          aria-expanded={!collapsed.has(key)}
                          title={
                            streamer ? 'Account' : (row.username ?? 'Guest') + ' on ' + group.name
                          }
                          className="relative"
                          onClick={() => toggle(key)}
                          {...longPress((x, y) =>
                            openActionMenu(
                              x,
                              y,
                              { kind: 'rail_account', origin: row.origin, username: row.username },
                              {},
                              account &&
                                (account.store.getState().me || account.store.getState().guest)
                                ? account
                                : loginAccount
                            )
                          )}
                        >
                          <ActorAvatar row={row} size={28} />
                          {row.badge > 0 && <RailPingBadge count={row.badge} />}
                        </button>
                      )}
                      {!collapsed.has(key) &&
                        (account ? (
                          <AccountProvider session={account}>
                            <AccountServers row={row} />
                          </AccountProvider>
                        ) : (
                          <ResumeAccount row={row} />
                        ))}
                    </div>
                  )
                })}
            </div>
          ))
        ) : accounts[0] ? (
          <AccountProvider session={accounts[0]}>
            <AccountServers row={model.blocks[0]?.accounts[0]} />
          </AccountProvider>
        ) : model.blocks[0]?.accounts[0] ? (
          <ResumeAccount row={model.blocks[0].accounts[0]} />
        ) : null}
        {groupedPeers
          ? peers.map(peer => (
              <PeerBlockView key={peer.account.renderKey + ':' + peer.app.localId} peer={peer}>
                <P2pServerRail actorLabel={peers.length > 1 ? peer.label : undefined} />
              </PeerBlockView>
            ))
          : p2pOn && <P2pServerRail />}
      </div>
      <div className="flex shrink-0 flex-col items-center gap-2 border-t border-outline-variant pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <PaletteButton rail />
        <ThemeToggle />
        <InstallButton compact />
        <IconButton
          icon={Settings}
          label="Settings"
          size="lg"
          onClick={() => openDialog({ kind: 'settings' })}
        />
        {me?.is_site_admin && (
          <IconButton
            icon={Shield}
            label="Site administration"
            size="lg"
            onClick={() => openAdmin()}
          />
        )}
        <IconButton
          icon={LogOut}
          size="lg"
          tone="danger"
          label={
            me
              ? model.accountCount > 1 && !streamer
                ? 'Log out of ' + me.username + ' on ' + loginAccount.conn.name
                : 'Log out'
              : 'Exit guest mode'
          }
          onClick={() => {
            if (model.accountCount > 1) {
              signOutSwitcherAccount(loginAccount.conn.origin, me?.username ?? null)
              return
            }
            logoutForLogin(loginAccount)
            router.replace('/login')
          }}
        />
      </div>
    </nav>
  )
}
