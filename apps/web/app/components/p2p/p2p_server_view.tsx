'use client'

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import {
  Crown,
  Folder as FolderIcon,
  FolderOpen,
  Hash,
  Link2,
  LogOut,
  Menu,
  Plus,
  Settings,
  UserPlus,
  Users,
  Waypoints,
  X,
} from 'lucide-react'
import { useStore, type ContextMenuItem } from '../../lib/store'
import { allPings } from '../../lib/selectors'
import { home, writeLocal } from '../../lib/instances'
import {
  channelScope,
  chatKey,
  memberName,
  p2p,
  p2pDm,
  p2pRail,
  p2pServer,
  serverScope,
  useP2p,
  type P2pState,
} from '../../lib/p2p/app'
import { displayName, shieldOf } from '../../lib/p2p/contacts'
import { movedText, type P2pMessage } from '../../lib/p2p/dm'
import { P } from '../../lib/p2p/state'
import type { MemberView, ServerView } from '../../lib/p2p/server'
import { levelOf, mutedOf, type NotifyPrefs } from '../../lib/notify'
import { folderKey, railItems, serverKey, type Folder } from '../../lib/nav_layout'
import type { DropTarget } from '../../lib/drag'
import { serverInitial } from '../../lib/rules'
import { sharing } from '../../lib/platform'
import { longPress } from '../context_menu'
import { PingBadge, RailPingBadge, pingLabel } from '../ping_badge'
import { MutedIcon, notifyMenuItems } from '../notify_menu'
import { markReadItem } from '../mark_read'
import { PinsButton } from '../pins'
import { iconBtn } from '../ui'
import { ContactShield, KeyAvatar, P2pBadge, PresenceDot } from './p2p_badge'
import { ElsewhereNotice, MovingBanner } from './p2p_home'
import { noteBarCls, P2pChatBody, type Mentionable } from './p2p_chat'

// P2P servers in the app: their group at the bottom of the rail (dashed rings, the Waypoints
// badge, folders of their own), and the open server: channels, the channel's messages and the
// member list, laid out like an instance server.

const tile = 'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition-colors'
const idle =
  'bg-surface-container-high text-on-surface hover:bg-primary-container hover:text-on-primary-container'

// ----- Counts -----

// Pings in a server's channels that badge (channels set to "Nothing" don't).
export const serverPings = (v: ServerView, prefs: NotifyPrefs) =>
  Object.entries(v.chans).reduce(
    (n, [ch, c]) => n + (levelOf(prefs, channelScope(v.id, ch)) === 'nothing' ? 0 : c.pings),
    0
  )

// Unread channels that show it: muted channels (or a muted server) don't.
export const serverUnread = (v: ServerView, prefs: NotifyPrefs, now = Date.now()) =>
  !mutedOf(prefs, serverScope(v.id), now) &&
  Object.entries(v.chans).some(
    ([ch, c]) =>
      c.unread > 0 &&
      v.channels.some(x => x.id === ch) &&
      !mutedOf(prefs, channelScope(v.id, ch), now)
  )

export const allServerPings = (servers: P2pState['servers'], prefs: NotifyPrefs) =>
  Object.values(servers).reduce((n, v) => n + serverPings(v, prefs), 0)

const can = (v: ServerView | undefined, bit: number) =>
  !!v && v.me === 'join' && (v.perms & bit) !== 0

// ----- Rail -----

const P2P_SERVER = serverKey('')
const P2P_FOLDER = folderKey('')

const strip = (key: string | null, prefix: string) =>
  key?.startsWith(prefix) ? key.slice(prefix.length) : null

// Drops only land in P2P zones, so P2P servers never mix with instance ones.
const P2P_ZONES = (zone: string) => zone === 'p2p' || zone.startsWith('p2p:')

const zoneOfFolder = (id: string) => `p2p:${id}`

const dropServer = (room: string, { zone, index, onto }: DropTarget) => {
  const folder = strip(onto, P2P_FOLDER)
  const target = strip(onto, P2P_SERVER)
  const into = zone.startsWith('p2p:') ? zone.slice(4) : null
  if (folder !== null) p2pRail.addToFolder(room, folder)
  else if (target !== null) p2pRail.merge(room, target)
  else if (into !== null) p2pRail.moveIntoFolder(room, into, index)
  else p2pRail.move(room, index)
}

const leaveItem = (v: ServerView): ContextMenuItem => ({
  label: 'Leave Server',
  danger: true,
  icon: LogOut,
  action: () =>
    useStore.getState().askConfirm({
      title: 'Leave Server',
      body: `Leave ${useStore.getState().streamer ? 'this server' : v.name}? Someone who can invite has to let you in again.`,
      confirm: 'Leave',
      action: () => void p2pServer.leave(v.id),
    }),
})

export const serverMenu = (v: ServerView, folder: string | null, at: number): ContextMenuItem[] => {
  const s = useStore.getState()
  const prefs = s.notifyPrefs
  const items: ContextMenuItem[] = []
  const unread = serverUnread(v, prefs) || serverPings(v, prefs) > 0
  items.push(markReadItem(unread ? [v.id] : [], () => p2pServer.markAllRead(v.id)))
  items.push(...notifyMenuItems(serverScope(v.id), 'Server'))
  if (can(v, P.Invite))
    items.push({
      label: 'Invite People',
      icon: UserPlus,
      action: () => p2p.openDialog({ kind: 'server_invite', room: v.id }),
    })
  if (v.me === 'join')
    items.push({
      label: 'Server Settings',
      icon: Settings,
      action: () => p2p.openDialog({ kind: 'server_settings', room: v.id }),
    })
  items.push({
    label: 'Copy Server ID',
    action: () => void sharing().copyText(v.id),
  })
  if (folder !== null)
    items.push({ label: 'Remove from folder', action: () => p2pRail.move(v.id, at + 1) })
  if (v.me === 'join' || v.me === 'invite') items.push(leaveItem(v))
  else
    items.push({
      label: 'Remove from this device',
      danger: true,
      action: () => confirmForget(v),
    })
  return items
}

const confirmForget = (v: ServerView) =>
  useStore.getState().askConfirm({
    title: 'Remove Server',
    body: `Remove ${v.name} and everything of it from this device? You aren't a member any more, so it can't come back.`,
    confirm: 'Remove',
    action: () => void p2pServer.forget(v.id),
  })

// The tile's ring is dashed and a Waypoints badge sits on it: this server lives on its members'
// devices.
function P2pServerTile({ v, folder, at }: { v: ServerView; folder: string | null; at: number }) {
  const active = useP2p(s => s.server?.room === v.id)
  const prefs = useStore(s => s.notifyPrefs)
  const openContextMenu = useStore(s => s.openContextMenu)
  const pings = serverPings(v, prefs)
  const unread = serverUnread(v, prefs)
  const muted = mutedOf(prefs, serverScope(v.id), Date.now())
  const parent = folder === null ? null : zoneOfFolder(folder)
  return (
    <button
      data-p2p-tile
      data-p2p-server={v.id}
      title={`${v.name}, peer-to-peer${muted ? ', muted' : ''}${pings ? `, ${pingLabel(pings)}` : ''}`}
      aria-label={`${v.name}, peer-to-peer`}
      aria-current={active ? 'page' : undefined}
      onClick={() => p2pServer.open(v.id)}
      {...longPress((x, y) => openContextMenu(x, y, serverMenu(v, folder, at)), {
        group: 'p2prail',
        key: serverKey(v.id),
        zones: P2P_ZONES,
        onto: key => key !== (parent ? folderKey(folder as string) : null),
        onDrop: target => dropServer(v.id, target),
      })}
      data-drop-onto={folder === null ? 'Create folder' : undefined}
      className={`${tile} relative border-2 border-dashed text-lg font-semibold ${
        active ? 'border-on-primary bg-primary text-on-primary' : `border-tertiary ${idle}`
      }`}
    >
      <span
        className={`streamer flex h-full w-full items-center justify-center ${muted && !active ? 'opacity-50' : ''}`}
      >
        {serverInitial(v.name)}
      </span>
      <span
        aria-hidden
        className="absolute -right-1 -bottom-1 flex size-4.5 items-center justify-center rounded-full border-2 border-(--rail-cut,var(--color-surface-container-lowest)) bg-tertiary text-on-tertiary"
      >
        <Waypoints size={9} strokeWidth={2.5} />
      </span>
      <MutedIcon
        scope={serverScope(v.id)}
        size={10}
        className="absolute -bottom-1 -left-1 size-5 items-center justify-center rounded-full border-2 border-(--rail-cut,var(--color-surface-container-lowest)) bg-surface-container-highest text-on-surface-variant"
      />
      {pings > 0 ? (
        <RailPingBadge count={pings} />
      ) : (
        unread && (
          <span
            title="Unread messages"
            aria-hidden
            className="absolute -top-1 -right-1 h-3 w-3 rounded-full border-2 border-(--rail-cut,var(--color-surface-container-lowest)) bg-error"
          />
        )
      )}
    </button>
  )
}

function P2pFolderEntry({ folder, list, at }: { folder: Folder; list: ServerView[]; at: number }) {
  const prefs = useStore(s => s.notifyPrefs)
  const openContextMenu = useStore(s => s.openContextMenu)
  const unread = !folder.open && list.some(v => serverUnread(v, prefs))
  const pings = folder.open ? 0 : list.reduce((n, v) => n + serverPings(v, prefs), 0)
  const streamer = useStore(s => s.streamer)
  const label =
    folder.name && !streamer ? folder.name : `P2P folder: ${list.map(v => v.name).join(', ')}`
  const header = {
    title: streamer ? folder.name || 'Folder' : label,
    'aria-expanded': folder.open,
    'data-drop-onto': 'Add to folder',
    'data-p2p-tile': '',
    onClick: () => p2pRail.toggleFolder(folder.id),
    ...longPress(
      (x, y) =>
        openContextMenu(x, y, [
          {
            label: 'Rename folder',
            action: () => p2p.openDialog({ kind: 'p2p_folder', id: folder.id }),
          },
          { label: 'Ungroup', action: () => p2pRail.ungroup(folder.id) },
        ]),
      {
        group: 'p2prail',
        key: folderKey(folder.id),
        zones: zone => zone === 'p2p',
        onDrop: ({ index }) => p2pRail.moveFolder(folder.id, index),
      }
    ),
  }
  if (!folder.open)
    return (
      <button
        {...header}
        className={`${tile} folder-tile relative border-2 border-dashed border-tertiary p-1.5`}
      >
        <span className="grid size-8 grid-cols-2 grid-rows-2 gap-1">
          {list.slice(0, 4).map(v => (
            <span
              key={v.id}
              className="folder-mini streamer flex min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-md text-[9px] leading-none font-semibold"
            >
              {serverInitial(v.name)}
            </span>
          ))}
        </span>
        <span
          aria-hidden
          className="absolute -right-1 -bottom-1 flex size-4.5 items-center justify-center rounded-full border-2 border-(--rail-cut,var(--color-surface-container-lowest)) bg-tertiary text-on-tertiary"
        >
          <FolderIcon size={9} strokeWidth={2.5} />
        </span>
        {pings > 0 ? (
          <RailPingBadge count={pings} />
        ) : (
          unread && (
            <span
              title="Unread messages"
              aria-hidden
              className="absolute -top-1 -right-1 h-3 w-3 rounded-full border-2 border-(--rail-cut,var(--color-surface-container-lowest)) bg-error"
            />
          )
        )}
      </button>
    )
  return (
    <div
      data-drag-box
      className="folder-group flex w-14 shrink-0 flex-col items-center rounded-[20px] py-1"
    >
      <button
        {...header}
        className={`${tile} text-tertiary hover:bg-tertiary-container hover:text-on-tertiary-container`}
      >
        <FolderOpen size={22} />
      </button>
      <div
        data-drop-zone={zoneOfFolder(folder.id)}
        data-drop-label="Add to folder"
        className="flex flex-col items-center gap-2 pt-2"
      >
        {list.map(v => (
          <P2pServerTile key={v.id} v={v} folder={folder.id} at={at} />
        ))}
      </div>
    </div>
  )
}

// The P2P server group of the rail, below a divider.
export function P2pServerRail() {
  const enabled = useP2p(s => s.enabled)
  const servers = useP2p(s => s.servers)
  const layout = useP2p(s => s.layout)
  const invites = useP2p(s => s.serverInvites.length)
  const list = useMemo(
    () => Object.values(servers).sort((a, b) => (a.name < b.name ? -1 : 1)),
    [servers]
  )
  if (!enabled) return null
  const items = railItems(list, v => v.id, layout.servers)
  return (
    <>
      <div className="my-1 h-px w-8 shrink-0 border-t border-dashed border-tertiary" />
      <div
        data-drop-zone="p2p"
        data-drop-label="Remove from folder"
        className="flex shrink-0 flex-col items-center gap-2"
      >
        {items.map((item, at) =>
          item.kind === 'server' ? (
            <P2pServerTile key={item.key} v={item.server} folder={null} at={at} />
          ) : (
            <P2pFolderEntry key={item.key} folder={item.folder} list={item.servers} at={at} />
          )
        )}
      </div>
      <button
        data-p2p-tile
        title={
          invites
            ? `Create or join a P2P server, ${invites} invites`
            : 'Create or join a P2P server'
        }
        aria-label="Create or join a P2P server"
        onClick={() => p2p.openDialog({ kind: 'server_new' })}
        className={`${tile} relative border-2 border-dashed border-tertiary text-tertiary hover:bg-tertiary-container hover:text-on-tertiary-container`}
      >
        <Plus size={22} />
        {invites > 0 && <RailPingBadge count={invites} />}
      </button>
    </>
  )
}

// ----- The open server -----

const useOpen = () => {
  const room = useP2p(s => s.server?.room ?? null)
  const v = useP2p(s => (s.server ? s.servers[s.server.room] : undefined))
  return { room, v }
}

function ServerHead({ v }: { v: ServerView }) {
  const openContextMenu = useStore(s => s.openContextMenu)
  const open = (x: number, y: number) => openContextMenu(x, y, serverMenu(v, null, 0))
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-outline-variant px-3">
      <button
        {...longPress(open)}
        onClick={e => {
          const r = e.currentTarget.getBoundingClientRect()
          open(r.left + 12, r.bottom)
        }}
        className="flex min-w-0 flex-1 flex-col items-start rounded-lg px-1 py-0.5 text-left hover:bg-surface-container"
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <span data-p2p-server-name className="streamer truncate font-medium">
            {v.name}
          </span>
          <P2pBadge />
        </span>
        <span data-p2p-online-count className="truncate text-xs text-on-surface-variant">
          {v.online} of {v.joined} online
        </span>
      </button>
      {can(v, P.Invite) && (
        <button
          title="Invite people"
          aria-label="Invite people"
          onClick={() => p2p.openDialog({ kind: 'server_invite', room: v.id })}
          className={iconBtn}
        >
          <UserPlus size={18} />
        </button>
      )}
    </div>
  )
}

const channelMenu = (v: ServerView, ch: { id: string; name: string }): ContextMenuItem[] => {
  const s = useStore.getState()
  const c = v.chans[ch.id]
  const items: ContextMenuItem[] = [
    markReadItem(c && (c.unread || c.pings) ? [ch.id] : [], () => p2pServer.markRead(v.id, ch.id)),
    ...notifyMenuItems(channelScope(v.id, ch.id), 'Channel'),
  ]
  if (can(v, P.ManageChannels))
    items.push(
      {
        label: 'Edit Channel',
        action: () => p2p.openDialog({ kind: 'server_settings', room: v.id, tab: 'channels' }),
      },
      {
        label: 'Delete Channel',
        danger: true,
        action: () =>
          s.askConfirm({
            title: 'Delete Channel',
            body: `Delete #${ch.name}? Its messages stay on members' devices but can't be opened.`,
            confirm: 'Delete',
            action: () => void p2pServer.removeChannel(v.id, ch.id),
          }),
      }
    )
  items.push({ label: 'Copy Channel ID', action: () => void sharing().copyText(ch.id) })
  return items
}

export function P2pServerSidebar() {
  const { v } = useOpen()
  const active = useP2p(s => s.server?.ch ?? null)
  const prefs = useStore(s => s.notifyPrefs)
  const openContextMenu = useStore(s => s.openContextMenu)
  const [adding, setAdding] = useState<string | null>(null)
  if (!v) return <aside className="flex h-full w-60 shrink-0 flex-col bg-surface-container-low" />
  const texts = v.channels.filter(c => c.kind === 'text')
  const submit = () => {
    const name = (adding ?? '').trim()
    setAdding(null)
    if (name) void p2pServer.addChannel(v.id, name).then(id => id && p2pServer.openChannel(id))
  }
  return (
    <aside
      data-p2p-sidebar
      className="flex h-full w-60 shrink-0 flex-col border-r border-dashed border-tertiary/40 bg-surface-container-low"
    >
      <ServerHead v={v} />
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <span className="text-xs font-medium tracking-wider text-on-surface-variant uppercase">
          Channels
        </span>
        {can(v, P.ManageChannels) && (
          <button
            title="Create channel"
            aria-label="Create channel"
            onClick={() => setAdding('')}
            className="rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
          >
            <Plus size={16} />
          </button>
        )}
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto pb-3">
        {texts.map(c => {
          const counts = v.chans[c.id]
          const scope = channelScope(v.id, c.id)
          const muted =
            mutedOf(prefs, scope, Date.now()) || mutedOf(prefs, serverScope(v.id), Date.now())
          const pings = counts && levelOf(prefs, scope) !== 'nothing' ? counts.pings : 0
          const unread = !!counts?.unread && !muted
          return (
            <button
              key={c.id}
              data-p2p-channel={c.name}
              onClick={() => p2pServer.openChannel(c.id)}
              {...longPress((x, y) => openContextMenu(x, y, channelMenu(v, c)))}
              className={`mx-2 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm ${
                active === c.id
                  ? 'bg-secondary-container text-on-secondary-container'
                  : `hover:bg-surface-container hover:text-on-surface ${unread ? 'font-semibold text-on-surface' : 'text-on-surface-variant'} ${muted ? 'opacity-60' : ''}`
              }`}
            >
              <Hash size={16} className="shrink-0" />
              <span className="truncate">{c.name}</span>
              <MutedIcon scope={scope} />
              {pings > 0 ? (
                <PingBadge count={pings} className="ml-auto" />
              ) : (
                unread && (
                  <span
                    title="Unread"
                    aria-hidden
                    className="ml-auto h-2 w-2 shrink-0 rounded-full bg-error"
                  />
                )
              )}
            </button>
          )
        })}
        {adding !== null && (
          <input
            autoFocus
            value={adding}
            maxLength={100}
            onChange={e => setAdding(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') setAdding(null)
            }}
            onBlur={submit}
            placeholder="channel name"
            aria-label="New channel name"
            className="mx-2 my-0.5 min-w-0 rounded-lg border border-primary bg-transparent px-2 py-1.5 text-base outline-none md:text-sm"
          />
        )}
        {texts.length === 0 && (
          <p className="px-4 py-2 text-sm text-on-surface-variant">
            {v.me === null ? 'Waiting for the server to arrive from a member…' : 'No channels yet.'}
          </p>
        )}
      </nav>
    </aside>
  )
}

const memberMenu = (v: ServerView, m: MemberView): ContextMenuItem[] => {
  const s = useStore.getState()
  const me = useP2p.getState().me
  const items: ContextMenuItem[] = []
  const contact = useP2p.getState().contacts.find(c => c.ik === m.ik)
  if (contact?.state === 'mutual')
    items.push({
      label: 'Message',
      action: () => {
        p2p.openHome()
        void p2pDm.openDm(m.ik)
      },
    })
  if (contact)
    items.push({
      label: 'Contact details',
      action: () => p2p.openDialog({ kind: 'contact', ik: m.ik }),
    })
  const owner = v.owner === me
  if (owner && m.ik !== me && m.m === 'join') {
    items.push({
      label: s.streamer ? 'Kick Member' : `Kick ${m.name}`,
      danger: true,
      action: () =>
        s.askConfirm({
          title: 'Kick Member',
          body: `Kick ${s.streamer ? 'this member' : m.name}? They can come back with a new invite.`,
          confirm: 'Kick',
          action: () => void p2pServer.kick(v.id, m.ik),
        }),
    })
  }
  if (owner && m.ik !== me && m.m !== 'ban')
    items.push({
      label: s.streamer ? 'Ban Member' : `Ban ${m.name}`,
      danger: true,
      action: () =>
        s.askConfirm({
          title: 'Ban Member',
          body: `Ban ${s.streamer ? 'this member' : m.name}? Nothing they post from now on is shown, and they can't come back.`,
          confirm: 'Ban',
          action: () => void p2pServer.ban(v.id, m.ik),
        }),
    })
  items.push({ label: 'Copy Identity Key', action: () => void sharing().copyText(m.ik) })
  return items
}

function MemberRow({ v, m }: { v: ServerView; m: MemberView }) {
  const openContextMenu = useStore(s => s.openContextMenu)
  const contact = useP2p(s => s.contacts.find(c => c.ik === m.ik))
  const me = useP2p(s => s.me)
  return (
    <li>
      <button
        data-p2p-member={m.name}
        {...longPress((x, y) => openContextMenu(x, y, memberMenu(v, m)))}
        onClick={e => {
          const r = e.currentTarget.getBoundingClientRect()
          openContextMenu(r.left + 24, r.bottom, memberMenu(v, m))
        }}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface-container ${m.online || m.ik === me ? '' : 'opacity-60'}`}
      >
        <span className="relative shrink-0">
          <KeyAvatar ik={m.ik} size={32} />
          {m.m === 'join' && (
            <PresenceDot presence={m.online || m.ik === me ? 'online' : 'offline'} />
          )}
        </span>
        <span className="streamer min-w-0 flex-1 truncate text-sm">{m.name}</span>
        {m.owner && (
          <span title="Owner" aria-label="Owner" role="img" className="flex shrink-0 text-tertiary">
            <Crown size={14} />
          </span>
        )}
        {m.ik !== me && (
          <ContactShield kind={contact ? shieldOf(contact) : 'unverified'} size={14} />
        )}
      </button>
    </li>
  )
}

export function P2pMemberList() {
  const { v } = useOpen()
  if (!v) return null
  const joined = v.members.filter(m => m.m === 'join')
  const online = joined.filter(m => m.online).sort((a, b) => a.name.localeCompare(b.name))
  const offline = joined.filter(m => !m.online).sort((a, b) => a.name.localeCompare(b.name))
  const invited = v.members.filter(m => m.m === 'invite')
  const group = (label: string, list: MemberView[]) =>
    list.length > 0 && (
      <section key={label}>
        <p className="px-3 pt-4 pb-1 text-xs font-medium tracking-wider text-on-surface-variant uppercase">
          {label} — {list.length}
        </p>
        <ul className="flex flex-col px-1">
          {list.map(m => (
            <MemberRow key={m.ik} v={v} m={m} />
          ))}
        </ul>
      </section>
    )
  return (
    <aside
      data-p2p-members
      aria-label="Members"
      className="flex h-full w-60 shrink-0 flex-col overflow-y-auto bg-surface-container-low pb-3"
    >
      {group('Online', online)}
      {group('Offline', offline)}
      {group('Invited', invited)}
    </aside>
  )
}

const introKey = (user: string) => `rchat_p2p_server_intro:${user}`

function ServerIntro() {
  const account = useP2p(s => s.account)
  const [hidden, setHidden] = useState(() => {
    if (!account) return true
    try {
      return localStorage.getItem(home.scoped(introKey(account))) === '1'
    } catch {
      return true
    }
  })
  if (hidden) return null
  return (
    <div
      data-p2p-intro
      className="mx-4 mt-3 flex items-start gap-3 rounded-2xl border border-dashed border-tertiary bg-tertiary-container/40 px-4 py-3 text-sm text-on-surface"
    >
      <P2pBadge />
      <p className="min-w-0 flex-1">
        This server is stored only on its members&apos; devices. Messages reach you while a member
        who has them is online. The instance never sees them and doesn&apos;t filter them.
      </p>
      <button
        title="Dismiss"
        aria-label="Dismiss"
        onClick={() => {
          setHidden(true)
          if (account) writeLocal(home.scoped(introKey(account)), '1')
        }}
        className="shrink-0 rounded-full p-1 hover:bg-surface-container-highest"
      >
        <X size={16} />
      </button>
    </div>
  )
}

const NONE: string[] = []

export function P2pChannelPane({
  onMenu,
  onMembers,
  membersOpen,
}: {
  onMenu: () => void
  onMembers: () => void
  membersOpen: boolean
}) {
  const { v } = useOpen()
  const chat = useP2p(s => (s.chat?.ch ? s.chat : null))
  const me = useP2p(s => s.me)
  const reader = useP2p(s => s.reader)
  const elsewhere = useP2p(s => s.elsewhere)
  const status = useP2p(s => s.status)
  const movedAt = useP2p(s => s.movedAt)
  const movingAt = useP2p(s => s.movingAt)
  const pinsOpen = useP2p(s => s.pins !== null && s.pins.room === s.chat?.room)
  const typingIks = useP2p(s => (s.chat?.ch ? (s.serverTyping[chatKey(s.chat)] ?? NONE) : NONE))
  const menuPings = useStore(allPings)
  const channel = v?.channels.find(c => c.id === chat?.ch)
  const room = v?.id ?? ''
  const nameOf = useCallback((ik: string) => memberName(room, ik), [room])
  const members = v?.members
  const people = useMemo<Mentionable[]>(
    () =>
      (members ?? [])
        .filter(m => m.m === 'join')
        .map(m => ({ ik: m.ik, name: m.name, handle: m.name })),
    [members]
  )
  const moderator = can(v, P.ManageMessages)
  const mayDelete = useCallback((p: P2pMessage) => p.sender === me || moderator, [me, moderator])

  if (!v) return <main className="flex min-w-0 flex-1 flex-col bg-surface" />

  const others = v.members.some(m => m.m === 'join' && m.online && m.ik !== me)
  const header = (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-outline-variant px-3 md:px-4">
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
      <Hash size={20} className="shrink-0 text-on-surface-variant" />
      <span className="min-w-0 truncate font-medium">{channel?.name ?? v.name}</span>
      {channel?.topic && (
        <span className="min-w-0 truncate text-sm text-on-surface-variant max-md:hidden">
          {channel.topic}
        </span>
      )}
      <span className="max-sm:hidden">
        <P2pBadge />
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {chat && (
          <PinsButton
            toggle={{
              open: pinsOpen,
              onClick: () => (pinsOpen ? p2pDm.closePins() : void p2pDm.openPins()),
            }}
          />
        )}
        <button
          title={membersOpen ? 'Hide members' : 'Show members'}
          aria-label="Members"
          aria-pressed={membersOpen}
          onClick={onMembers}
          className={`rounded-full p-1.5 ${membersOpen ? 'bg-secondary-container text-on-secondary-container' : 'hover:bg-surface-container-high'}`}
        >
          <Users size={20} />
        </button>
      </div>
    </header>
  )

  if ((reader || elsewhere) && !chat)
    return (
      <main data-p2p-channel-pane className="flex min-w-0 flex-1 flex-col bg-surface">
        {header}
        <div className="mx-auto flex max-w-2xl flex-col p-4">
          <ElsewhereNotice />
        </div>
      </main>
    )

  if (!chat || !channel) {
    const waiting = v.me === null || v.joining
    return (
      <main data-p2p-channel-pane className="flex min-w-0 flex-1 flex-col bg-surface">
        {header}
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-on-surface-variant">
          {waiting ? (
            <>
              <span data-p2p-joining className="text-lg font-medium text-on-surface">
                Joining {v.name}…
              </span>
              <span className="text-sm">
                Waiting for a member to send the server. Someone who can invite must be online.
              </span>
            </>
          ) : (
            <span>No channel open.</span>
          )}
        </div>
      </main>
    )
  }

  const out =
    v.me === 'ban'
      ? 'You are banned from this server.'
      : v.me === 'leave'
        ? 'You are no longer a member of this server.'
        : v.me !== 'join'
          ? 'Joining. You can write once a member has let you in.'
          : null
  const disabled: ReactNode =
    reader || elsewhere ? (
      <div className={noteBarCls}>
        <ElsewhereNotice />
      </div>
    ) : status === 'moved' ? (
      <div className={noteBarCls}>{movedText(movedAt)}</div>
    ) : movingAt !== null ? (
      <MovingBanner className={noteBarCls} />
    ) : out ? (
      <div data-p2p-out className={noteBarCls}>
        {out}
        {v.me !== 'join' && v.me !== 'invite' && v.me !== null && (
          <button
            onClick={() => confirmForget(v)}
            className="font-medium text-primary hover:underline"
          >
            Remove from this device
          </button>
        )}
      </div>
    ) : v.full ? (
      <div className={noteBarCls} role="status">
        This server reached its storage limit on this device.
      </div>
    ) : null

  return (
    <P2pChatBody
      chat={chat}
      header={header}
      intro={<ServerIntro />}
      disabled={disabled}
      canAct={!disabled}
      nameOf={nameOf}
      people={people}
      title={`#${channel.name}`}
      placeholder={`Message #${channel.name}`}
      pendingTip="Waiting for a member to come online"
      peerFull={false}
      gap={v.gap}
      online={others}
      gapOffline="Older messages unavailable until a member who has them is online"
      empty={
        <>
          <span className="text-2xl font-semibold">Welcome to #{channel.name}</span>
          <span className="text-sm">
            This is the start of the channel. Messages are stored on members&apos; devices.
          </span>
        </>
      }
      typingNames={typingIks.map(nameOf)}
      mayDelete={mayDelete}
      mayPin={moderator}
      forwardSkip={null}
      pinsEmpty="This channel doesn't have any pinned messages yet."
      pinsPlace="channel"
      dataAttr={{ 'data-p2p-channel-pane': '' }}
    />
  )
}

// Invites from contacts, for the P2P home.
export function ServerInviteRows() {
  const invites = useP2p(s => s.serverInvites)
  const contacts = useP2p(s => s.contacts)
  if (!invites.length) return null
  return (
    <section aria-label="P2P server invites">
      <p className="px-3 pb-2 text-xs font-medium tracking-wide text-on-surface-variant uppercase">
        P2P server invites ({invites.length})
      </p>
      <ul className="flex flex-col gap-2">
        {invites.map(i => {
          const c = contacts.find(x => x.ik === i.from)
          return (
            <li
              key={i.room}
              data-p2p-server-invite={i.name}
              className="flex items-center gap-3 rounded-2xl border border-dashed border-tertiary bg-surface-container px-3 py-2"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-tertiary font-semibold">
                <span className="streamer">{serverInitial(i.name)}</span>
              </span>
              <div className="min-w-0 flex-1">
                <p className="streamer truncate text-sm font-medium">{i.name}</p>
                <p className="truncate text-xs text-on-surface-variant">
                  From <span className="streamer">{c ? displayName(c) : 'a contact'}</span>. Someone
                  in it must be online to let you in.
                </p>
              </div>
              <button
                onClick={() => void p2pServer.declineInvite(i.room)}
                className="rounded-full px-3 py-1.5 text-sm text-on-surface-variant hover:bg-surface-container-highest"
              >
                Decline
              </button>
              <button
                onClick={() => void p2pServer.acceptInvite(i.room)}
                className="rounded-full bg-primary px-3 py-1.5 text-sm font-medium text-on-primary"
              >
                Join
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export const copyInviteItem = (text: string): ContextMenuItem => ({
  label: 'Copy Invite',
  icon: Link2,
  action: () => void sharing().copyText(text),
})
