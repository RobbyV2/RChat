'use client'

import { useRouter } from 'next/navigation'
import {
  Eye,
  Folder as FolderIcon,
  FolderOpen,
  House,
  LogOut,
  MessageCircle,
  Plus,
  Settings,
  Shield,
} from 'lucide-react'
import {
  dmPingCount,
  dmsUnread,
  folderLabel,
  myPerms,
  previewServer,
  type RailServer,
  railServers,
  scopeMuted,
  serverPingCount,
  serversMarkTargets,
  serverUnread,
  useMask,
  useStore,
} from '../lib/store'
import { folderKey, railItems, serverKey, type Folder } from '../lib/nav_layout'
import type { DropTarget } from '../lib/drag'
import { Perm, hasPerm, type ServerDetail } from '../lib/types'
import { serverInitial } from '../lib/rules'
import { inviteUrl } from '../lib/invite'
import { longPress } from './context_menu'
import { dragScope } from './drag'
import { InstallButton } from './pwa_register'
import { RailInstance } from './instance_badge'
import { ThemeToggle } from './status_clock'
import { PaletteButton } from './palette'
import { Sentinel, iconBtn } from './ui'
import { RailPingBadge, pingLabel } from './ping_badge'
import { MutedIcon, folderNotifyItems, notifyMenuItems } from './notify_menu'
import { markAllReadItem, markReadItem } from './mark_read'
import { P2pRailTile } from './p2p/p2p_home'
import { P2pServerRail } from './p2p/p2p_server_view'
import { p2p as p2pView, useP2p } from '../lib/p2p/app'

const tile = 'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition-colors'
const idle =
  'bg-surface-container-high text-on-surface hover:bg-primary-container hover:text-on-primary-container'

const NO_DETAILS: Record<string, ServerDetail> = {}
const SERVER = serverKey('')
const FOLDER = folderKey('')

const strip = (key: string | null, prefix: string) =>
  key?.startsWith(prefix) ? key.slice(prefix.length) : null

const dropServer = (name: string, { zone, index, onto }: DropTarget) => {
  const s = useStore.getState()
  const folder = strip(onto, FOLDER)
  const target = strip(onto, SERVER)
  const into = strip(zone, FOLDER)
  if (folder !== null) s.addToFolder(name, folder)
  else if (target !== null) s.mergeServers(name, target)
  else if (into !== null) s.moveIntoFolder(name, into, index)
  else s.moveServer(name, index)
}

export function ServerGlyph({ name, displayName }: { name: string; displayName: string }) {
  const mask = useMask()
  return name === 'rchat' ? (
    <img
      src="/rchat_r.png"
      alt="RChat"
      draggable={false}
      className="h-full w-full object-contain p-1"
    />
  ) : (
    <span className="streamer">{serverInitial(mask(displayName))}</span>
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
  const me = useStore(s => s.me)
  const p2pOpen = useP2p(s => s.home || s.server !== null)
  const active = useStore(s => s.view?.kind === 'channel' && s.view.server === name) && !p2pOpen
  const unread = useStore(s => serverUnread(s, name))
  const pings = useStore(s => serverPingCount(s, name))
  const openServer = useStore(s => s.openServer)
  const openContextMenu = useStore(s => s.openContextMenu)
  const leaveServer = useStore(s => s.leaveServer)
  const askConfirm = useStore(s => s.askConfirm)
  const moveServer = useStore(s => s.moveServer)
  const markServerRead = useStore(s => s.markServerRead)
  const openDialog = useStore(s => s.openDialog)
  const muted = useStore(s => scopeMuted(s, { kind: 'server', name }))
  const mine = me !== null && creator === me.username
  const mask = useMask()
  const streamer = useStore(s => s.streamer)
  const shown = streamer ? 'Server' : mask(display_name)
  const parent = folder === null ? null : folderKey(folder)
  return (
    <button
      title={`${mine ? `${shown} (Creator)` : shown}${muted ? ', muted' : ''}${pings ? `, ${pingLabel(pings)}` : ''}`}
      onClick={() => void openServer(name)}
      {...longPress(
        (x, y) =>
          openContextMenu(x, y, [
            ...(me
              ? [
                  markReadItem(
                    serversMarkTargets(useStore.getState(), [name]),
                    () => void markServerRead(name)
                  ),
                ]
              : []),
            ...notifyMenuItems({ kind: 'server', name }, 'Server'),
            ...(me && hasPerm(myPerms(useStore.getState(), name), Perm.ManageChannels)
              ? [
                  {
                    label: 'Create category',
                    action: () => openDialog({ kind: 'category', server: name }),
                  },
                ]
              : []),
            {
              label: 'Copy invite link',
              action: () => void navigator.clipboard.writeText(inviteUrl(name)),
            },
            {
              label: 'Copy Server ID',
              action: () => void navigator.clipboard.writeText(name),
            },
            ...(folder === null
              ? []
              : [{ label: 'Remove from folder', action: () => moveServer(name, at + 1) }]),
            ...(name === 'rchat'
              ? []
              : [
                  {
                    label: 'Leave Server',
                    danger: true,
                    action: () =>
                      askConfirm({
                        title: 'Leave Server',
                        body: 'Leave this server? You can join it again later.',
                        confirm: 'Leave',
                        action: () => void leaveServer(name),
                      }),
                  },
                ]),
          ]),
        {
          group: 'rail',
          key: serverKey(name),
          // P2P servers have zones of their own.
          zones: zone => zone !== 'p2p' && !zone.startsWith('p2p:'),
          onto: key => key !== parent,
          onDrop: target => dropServer(name, target),
        }
      )}
      data-drop-onto={folder === null ? 'Create folder' : undefined}
      className={`${tile} relative text-lg font-semibold ${active ? 'bg-primary text-on-primary' : idle}`}
    >
      <span
        className={`flex h-full w-full items-center justify-center ${muted && !active ? 'opacity-50' : ''}`}
      >
        <ServerGlyph name={name} displayName={display_name} />
      </span>
      <MutedIcon
        scope={{ kind: 'server', name }}
        size={10}
        className="absolute -bottom-1 -left-1 size-5 items-center justify-center rounded-full border-2 border-(--rail-cut,var(--color-surface-container-lowest)) bg-surface-container-highest text-on-surface-variant"
      />
      {mine && (
        <span
          title="Creator"
          className="absolute -right-1 -bottom-0.5 rounded-full bg-tertiary-container px-1.5 text-[9px] leading-4 font-bold text-on-tertiary-container"
        >
          C
        </span>
      )}
      {pings > 0 ? <RailPingBadge count={pings} /> : unread && <UnreadDot />}
    </button>
  )
}

// The previewed server (open without joining). It shows only while open and is never saved to
// the layout. A dashed, dimmed tile with an eye badge marks it.
function PreviewTile() {
  const name = useStore(previewServer)
  const display = useStore(s => (name ? (s.servers[name]?.display_name ?? name) : ''))
  const openServer = useStore(s => s.openServer)
  const joinPreview = useStore(s => s.joinPreview)
  const openContextMenu = useStore(s => s.openContextMenu)
  const mask = useMask()
  const streamer = useStore(s => s.streamer)
  if (!name) return null
  const label = streamer ? 'Previewing a server' : `Previewing ${mask(display)}`
  return (
    <button
      data-preview-tile={name}
      title={label}
      aria-label={label}
      aria-current="page"
      onClick={() => void openServer(name)}
      {...longPress((x, y) =>
        openContextMenu(x, y, [
          {
            label: 'Join Server',
            action: () => void joinPreview(name),
          },
          {
            label: 'Copy Server ID',
            action: () => void navigator.clipboard.writeText(name),
          },
        ])
      )}
      className={`${tile} relative border-2 border-dashed border-primary bg-surface-container-high text-lg font-semibold text-on-surface`}
    >
      <span className="flex h-full w-full items-center justify-center opacity-60">
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
  const mask = useMask()
  return (
    <span
      className={`flex min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-md text-[9px] leading-none font-semibold ${
        active ? 'bg-primary text-on-primary' : 'folder-mini'
      }`}
    >
      {name === 'rchat' ? (
        <img src="/rchat_r.png" alt="" draggable={false} className="h-full w-full object-contain" />
      ) : (
        <span className="streamer">{serverInitial(mask(display_name))}</span>
      )}
    </span>
  )
}

function FolderEntry({
  folder,
  servers,
  at,
}: {
  folder: Folder
  servers: RailServer[]
  at: number
}) {
  const toggleFolder = useStore(s => s.toggleFolder)
  const moveFolder = useStore(s => s.moveFolder)
  const ungroupFolder = useStore(s => s.ungroupFolder)
  const openDialog = useStore(s => s.openDialog)
  const openContextMenu = useStore(s => s.openContextMenu)
  const markServersRead = useStore(s => s.markServersRead)
  const unread = useStore(s => !folder.open && servers.some(x => serverUnread(s, x.name)))
  const pings = useStore(s =>
    folder.open ? 0 : servers.reduce((n, x) => n + serverPingCount(s, x.name), 0)
  )
  const key = folderKey(folder.id)
  const label = useStore(s => (s.streamer ? folder.name || 'Folder' : folderLabel(s, folder)))
  const header = {
    title: label,
    'aria-expanded': folder.open,
    'data-drop-onto': 'Add to folder',
    onClick: () => toggleFolder(folder.id),
    ...longPress(
      (x, y) =>
        openContextMenu(x, y, [
          ...(useStore.getState().me
            ? [
                markReadItem(
                  serversMarkTargets(
                    useStore.getState(),
                    servers.map(x => x.name)
                  ),
                  () => void markServersRead(servers.map(x => x.name))
                ),
              ]
            : []),
          ...folderNotifyItems(servers.map(x => x.name)),
          {
            label: 'Rename folder',
            action: () => openDialog({ kind: 'rename_folder', id: folder.id }),
          },
          { label: 'Ungroup', action: () => ungroupFolder(folder.id) },
        ]),
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
      <button {...header} className={`${tile} folder-tile relative p-1.5`}>
        <span className="grid size-9 grid-cols-2 grid-rows-2 gap-1">
          {servers.slice(0, 4).map(s => (
            <MiniIcon key={s.name} server={s} />
          ))}
        </span>
        <span
          aria-hidden
          className="absolute -right-1 -bottom-1 flex size-4.5 items-center justify-center rounded-full border-2 border-(--rail-cut,var(--color-surface-container-lowest)) bg-primary text-on-primary"
        >
          <FolderIcon size={9} strokeWidth={2.5} />
        </span>
        {pings > 0 ? <RailPingBadge count={pings} /> : unread && <UnreadDot />}
      </button>
    )
  }
  return (
    <div
      data-drag-box
      className="folder-group flex w-14 shrink-0 flex-col items-center rounded-[20px] py-1"
    >
      <button
        {...header}
        className={`${tile} text-primary hover:bg-primary-container hover:text-on-primary-container`}
      >
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

export function ServerRail() {
  const router = useRouter()
  const me = useStore(s => s.me)
  const guestServers = useStore(s => s.guestServers)
  const guestNames = useStore(s => s.guestNames)
  const servers = useStore(s => (s.me ? NO_DETAILS : s.servers))
  const view = useStore(s => s.view)
  const dmUnread = useStore(dmsUnread)
  const dmPings = useStore(dmPingCount)
  const openLastDm = useStore(s => s.openLastDm)
  const goHome = useStore(s => s.goHome)
  const openContextMenu = useStore(s => s.openContextMenu)
  const serversMore = useStore(s => s.serversMore)
  const loadMoreServers = useStore(s => s.loadMoreServers)
  const openDialog = useStore(s => s.openDialog)
  const logout = useStore(s => s.logout)
  const saved = useStore(s => s.layout.servers)
  const p2pHome = useP2p(s => s.home || s.server !== null)
  // Set only while the instance has P2P on for this account.
  const p2pOn = useP2p(s => s.account !== null)
  const atHome = useStore(s => s.home && s.view === null) && !p2pHome

  const items = railItems(
    railServers({ me, guestServers, guestNames, servers }),
    x => x.name,
    saved
  )

  return (
    <nav className="flex h-full w-18 shrink-0 flex-col bg-surface-container-lowest">
      <div className="flex shrink-0 flex-col items-center gap-1.5 pt-2">
        <RailInstance />
        <div className="h-px w-8 bg-outline-variant" />
      </div>
      <div
        ref={dragScope}
        onClickCapture={e => {
          // Opening a DM, server or folder leaves the P2P home.
          const t = e.target as HTMLElement
          if (t.closest('button') && !t.closest('[data-p2p-tile]')) p2pView.closeHome()
        }}
        className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto pt-2 pb-2"
      >
        <button
          title="Home"
          aria-label="Home"
          aria-current={atHome ? 'page' : undefined}
          data-home-button
          onClick={goHome}
          className={`${tile} ${atHome ? 'bg-primary text-on-primary' : idle}`}
        >
          <House size={22} />
        </button>
        {me && (
          <button
            title={dmPings ? `Direct messages, ${pingLabel(dmPings)}` : 'Direct messages'}
            aria-label="Direct messages"
            onClick={openLastDm}
            {...longPress((x, y) => openContextMenu(x, y, [markAllReadItem()]))}
            className={`${tile} relative ${view?.kind === 'dm' && !p2pHome ? 'bg-primary text-on-primary' : idle}`}
          >
            <MessageCircle size={22} />
            {dmPings > 0 ? <RailPingBadge count={dmPings} /> : dmUnread && <UnreadDot />}
          </button>
        )}
        {p2pOn && <P2pRailTile />}
        {me && <div className="my-1 h-px w-8 shrink-0 bg-outline-variant" />}
        {me && <PreviewTile />}
        <div
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
        <button
          title="Add a server"
          onClick={() => openDialog({ kind: 'add_server' })}
          className={`${tile} bg-primary-container text-on-primary-container shadow-elevation-1 hover:bg-primary hover:text-on-primary`}
        >
          <Plus size={22} />
        </button>
        {p2pOn && <P2pServerRail />}
      </div>
      <div className="flex shrink-0 flex-col items-center gap-2 border-t border-outline-variant pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <PaletteButton className={iconBtn} />
        <ThemeToggle />
        <InstallButton compact />
        <button
          title="Settings"
          onClick={() => openDialog({ kind: 'settings' })}
          className={iconBtn}
        >
          <Settings size={20} />
        </button>
        {me?.is_site_admin && (
          <button
            title="Site administration"
            onClick={() => openDialog({ kind: 'admin_panel' })}
            className={iconBtn}
          >
            <Shield size={20} />
          </button>
        )}
        <button
          title={me ? 'Log out' : 'Exit guest mode'}
          onClick={() => {
            logout()
            router.replace('/login')
          }}
          className="rounded-full p-2 text-on-surface-variant hover:bg-surface-container-high hover:text-error"
        >
          <LogOut size={20} />
        </button>
      </div>
    </nav>
  )
}
