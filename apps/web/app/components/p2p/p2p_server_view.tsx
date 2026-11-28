'use client'
import { PeerActorTag } from '../view_actor'
import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'
import type { P2pApp } from '../../lib/p2p/app/runtime'

import { client } from '../../lib/client/client'
import { useAccount } from '../../lib/client/react'
import { ChannelCanContext, useChannelCan } from '../../lib/place/use_rights'
import { PlaceProvider, useLive, useP2pRoom } from '../../lib/place/react'
import { featureAt, isUnsupported } from '../../lib/place/feature'
import {
  channels as channelsFeature,
  noChannels,
  type ChannelEntry,
} from '../../lib/place/channels'
import { ChannelList } from '../channel_list'
import { VoiceRow } from '../voice_row'
import { IconButton } from '../controls'
import { P2pRoom } from '../../lib/place/place'
import MemberSidebar from '../member_sidebar'

import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Clock,
  Folder as FolderIcon,
  FolderOpen,
  Hash,
  Lock,
  Menu,
  Plus,
  Search,
  UserPlus,
  Users,
  Volume2,
  Waypoints,
} from 'lucide-react'
import { useMask, useStore } from '../../lib/store'
import { allPings } from '../../lib/selectors'
import { P2P_SERVER_INTRO } from '../../lib/home'
import { channelScope, chatKey, serverScope } from '../../lib/p2p/app'
import { displayName } from '../../lib/p2p/contacts'
import { movedText, type P2pMessage } from '../../lib/p2p/dm'
import { P } from '../../lib/p2p/state'
import { serverPings, serverUnread } from '../../lib/p2p/alerts'
import type { MemberView, ServerView } from '../../lib/p2p/server'
import { ownsP2pServer } from '../../lib/p2p/server/types'
import { levelOf, mutedOf } from '../../lib/notify'
import { folderKey, railItems, serverKey, type Folder } from '../../lib/nav_layout'
import { folderStyle } from '../../lib/folder_colors'
import { ctxFor } from '../../lib/actions/ctx'
import { registerAppActions } from '../../lib/actions'
import { menuItems, openActionMenu } from '../../lib/actions/menu'
import { peerServer } from '../../lib/actions/p2p_server'
import type { DropTarget } from '../../lib/drag'
import { AboutLine, ServerIcon } from '../server_about'
import { longPress } from '../context_menu'
import { PingBadge, RailPingBadge, pingLabel } from '../ping_badge'
import { ChannelEnd } from '../typing_indicator'
import { RailVoiceBadge, useP2pVoice } from '../rail_voice_badge'
import { p2pRowTypers } from '../../lib/typing_rows'
import { voiceLabel } from '../../lib/voice_rail'
import { MutedIcon } from '../notify_menu'
import { PinsButton } from '../pins'
import { ThreadsButton } from '../threads'
import { iconBtn, Masked } from '../ui'
import { Row, Stack, Surface } from '../layout'
import { KeyAvatar, P2pBadge } from './p2p_badge'
import { ElsewhereNotice, MovingBanner } from './p2p_home'
import { ServerNotices } from './p2p_server_flows'
import { SYNCING_TEXT, TRANSFERRED_TEXT } from '../../lib/p2p/flows'
import { NoteBar, P2pChatBody, P2pIntro } from './p2p_chat'
import { VoiceDock, VoiceGrid } from '../voice_grid'
import { MemberCard } from './p2p_server_roles'
import { TimedOutBar, usePeerTimeoutEnds } from '../timeout_dialog'
import { hex, memberLooks } from '../../lib/p2p/roles'
import { slowTitle } from '../../lib/slowmode'
import { serversLoading } from '../../lib/p2p/conversations'
import { ChannelListSkeleton, Held, MessageListSkeleton, ServerRailSkeleton } from '../skeletons'
import { time } from '../../lib/platform/time'

// P2P servers in the app: their group at the bottom of the rail (dashed rings, the Waypoints
// badge, folders of their own), and the open server: channels, the channel's messages and the
// member list, laid out like an instance server.

const tile = 'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition-colors'
const idle =
  'bg-surface-container-high text-on-surface hover:bg-primary-container hover:text-on-primary-container'

// ----- Counts -----

export { serverPings, serverUnread }

// Unread channels that show it: muted channels (or a muted server) don't.

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

const dropServer =
  (identity: P2pApp) =>
  (room: string, { zone, index, onto }: DropTarget) => {
    const { p2pRail } = identity

    const folder = strip(onto, P2P_FOLDER)
    const target = strip(onto, P2P_SERVER)
    const into = zone.startsWith('p2p:') ? zone.slice(4) : null
    if (folder !== null) p2pRail.addToFolder(room, folder)
    else if (target !== null) p2pRail.merge(room, target)
    else if (into !== null) p2pRail.moveIntoFolder(room, into, index)
    else p2pRail.move(room, index)
  }

// A P2P channel row's end, with who is typing in the channel (while typing indicators are on),
// leaving out blocked contacts.
function P2pChannelEnd({
  room,
  ch,
  pings,
  unread,
}: {
  room: string
  ch: string
  pings: number
  unread: boolean
}) {
  const { useP2p, memberName } = useP2pApp()!
  const on = useStore(s => s.typingOn)
  const iks = useP2p(s => (on ? (s.serverTyping[`${room}/${ch}`] ?? NO_TYPERS) : NO_TYPERS))
  const contacts = useP2p(s => s.contacts)
  const blocked = useMemo(
    () => new Set(contacts.filter(c => c.state === 'blocked').map(c => c.ik)),
    [contacts]
  )
  const names = useMemo(
    () => p2pRowTypers(iks, blocked, ik => memberName(room, ik)),
    [iks, blocked, memberName, room]
  )
  return <ChannelEnd typers={names} pings={pings} unread={unread} />
}
const NO_TYPERS: string[] = []

// The tile's ring is dashed and a Waypoints badge sits on it: this server lives on its members'
// devices.
function P2pServerTile({ v, folder, at }: { v: ServerView; folder: string | null; at: number }) {
  const identity = useP2pApp()!
  const { p2pServer } = identity

  const acct = useAccount()

  const active = useP2p(s => s.server?.room === v.id)
  const prefs = useStore(s => s.notifyPrefs)
  const pings = serverPings(v, prefs)
  const unread = serverUnread(v, prefs)
  const voice = useP2pVoice([v.id])
  const muted = mutedOf(prefs, serverScope(v.id), acct.time.now())
  const parent = folder === null ? null : zoneOfFolder(folder)
  const own = useP2p(s => ownsP2pServer(v, s.me))
  const mask = useMask(own)
  return (
    <button
      data-p2p-tile
      data-p2p-server={v.id}
      title={`${mask(v.name)}, peer-to-peer${muted ? ', muted' : ''}${pings ? `, ${pingLabel(pings)}` : ''}${voiceLabel(voice)}`}
      aria-label={`${mask(v.name)}, peer-to-peer${voiceLabel(voice)}`}
      aria-current={active ? 'page' : undefined}
      onClick={() => p2pServer.open(v.id)}
      {...longPress(
        (x, y) =>
          openActionMenu(x, y, { kind: 'p2p_server', v, folder, at }, undefined, acct, identity),
        {
          group: 'p2prail',
          key: serverKey(v.id),
          zones: P2P_ZONES,
          onto: key => key !== (parent ? folderKey(folder as string) : null),
          onDrop: target => dropServer(identity)(v.id, target),
        }
      )}
      data-drop-onto={folder === null ? 'Create folder' : undefined}
      className={`${tile} relative border-2 border-dashed text-lg font-semibold ${
        active ? 'border-on-primary bg-primary text-on-primary' : `border-tertiary ${idle}`
      }`}
    >
      <span
        className={`flex h-full w-full items-center justify-center rounded-[inherit] ${muted && !active ? 'opacity-50' : ''}`}
      >
        <ServerIcon
          seed={v.id}
          name={v.name}
          kind={v.about.icon}
          color={hex(v.color)}
          own={own}
          framed={active}
        />
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
      <RailVoiceBadge count={voice} />
    </button>
  )
}

function P2pFolderEntryBody({
  folder,
  list,
  at,
}: {
  folder: Folder
  list: ServerView[]
  at: number
}) {
  const identity = useP2pApp()!
  const { p2pRail } = identity

  const acct = useAccount()

  const prefs = useStore(s => s.notifyPrefs)
  const unread = !folder.open && list.some(v => serverUnread(v, prefs))
  const pings = folder.open ? 0 : list.reduce((n, v) => n + serverPings(v, prefs), 0)
  const voice = useP2pVoice(folder.open ? [] : list.map(v => v.id))
  const streamer = useStore(s => s.streamer)
  const mask = useMask()
  const label =
    folder.name && !streamer ? folder.name : `P2P folder: ${list.map(v => mask(v.name)).join(', ')}`
  const theme = useStore(s => s.theme)
  const style = folderStyle(folder.color, theme) as CSSProperties | undefined
  const header = {
    title: `${streamer ? folder.name || 'Folder' : label}${voiceLabel(voice)}`,
    'aria-expanded': folder.open,
    'data-drop-onto': 'Add to folder',
    'data-p2p-tile': '',
    onClick: () => p2pRail.toggleFolder(folder.id),
    ...longPress(
      (x, y) =>
        openActionMenu(x, y, { kind: 'folder', folder, p2p: true }, undefined, acct, identity),
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
        style={style}
        className={`${tile} folder-tile relative border-2 border-dashed border-tertiary p-1.5`}
      >
        <span className="grid size-8 grid-cols-2 grid-rows-2 gap-1">
          {list.slice(0, 4).map(v => (
            <span
              key={v.id}
              className="folder-mini flex min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-md text-[9px] leading-none font-semibold"
            >
              <ServerIcon seed={v.id} name={v.name} kind={v.about.icon} color={hex(v.color)} />
            </span>
          ))}
        </span>
        <span
          aria-hidden
          className="absolute -right-1 -bottom-1 flex size-4.5 items-center justify-center rounded-full border-2 border-(--rail-cut,var(--color-surface-container-lowest)) bg-(--folder-icon,var(--color-tertiary)) text-(--folder-on-icon,var(--color-on-tertiary))"
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
        <RailVoiceBadge count={voice} />
      </button>
    )
  return (
    <div data-drag-box style={style} className="folder-group w-14 shrink-0 rounded-group">
      <Surface pad="2xs" gap="sm" tone="plain" radius="none" align="center">
        <button
          {...header}
          className={`${tile} text-(--folder-icon,var(--color-tertiary)) hover:bg-(--folder-hover,var(--color-tertiary-container)) hover:text-(--folder-icon,var(--color-on-tertiary-container))`}
        >
          <FolderOpen size={22} />
        </button>
        <Stack
          data-drop-zone={zoneOfFolder(folder.id)}
          data-drop-label="Add to folder"
          gap="sm"
          align="center"
        >
          {list.map(v => (
            <P2pServerTile key={v.id} v={v} folder={folder.id} at={at} />
          ))}
        </Stack>
      </Surface>
    </div>
  )
}

// Create or join a P2P server: the second tile of the rail's P2P frame.
function P2pJoinTileBody() {
  const identity = useP2pApp()!
  const { p2p } = identity

  return (
    <button
      data-p2p-tile
      data-p2p-join
      title="Create or join a P2P server"
      aria-label="Create or join a P2P server"
      onClick={() => p2p.openDialog({ kind: 'server_new' })}
      className={`${tile} bg-surface-container-high text-tertiary hover:bg-tertiary-container hover:text-on-tertiary-container`}
    >
      <Plus size={22} />
    </button>
  )
}

// The P2P servers and folders, last in the rail under a dashed line.
function P2pServerRailBody({ actorLabel }: { actorLabel?: string }) {
  const identity = useP2pApp()!
  const enabled = useP2p(s => s.enabled)
  const servers = useP2p(s => s.servers)
  const layout = useP2p(s => s.layout)
  const loading = useP2p(serversLoading)
  const list = useMemo(
    () => Object.values(servers).sort((a, b) => (a.name < b.name ? -1 : 1)),
    [servers]
  )
  if (!enabled || (!list.length && !loading)) return null
  const items = railItems(list, v => v.id, layout.servers)
  const section = (
    <>
      <div className="my-1 h-px w-8 shrink-0 border-t border-dashed border-tertiary" />
      {actorLabel && (
        <span
          data-peer-section
          title={actorLabel}
          aria-label={actorLabel}
          className="streamer rounded-full outline-2 outline-offset-1 outline-dashed outline-tertiary"
        >
          <KeyAvatar ik={identity.useP2p.getState().ik ?? identity.localId} size={24} />
        </span>
      )}
      <Stack
        data-peer-section
        data-rail="p2p-servers"
        data-drop-zone="p2p"
        data-drop-label="Remove from folder"
        gap="sm"
        align="center"
        place="shrink-0"
      >
        {items.map((item, at) =>
          item.kind === 'server' ? (
            <P2pServerTile key={item.key} v={item.server} folder={null} at={at} />
          ) : (
            <P2pFolderEntry key={item.key} folder={item.folder} list={item.servers} at={at} />
          )
        )}
        {!list.length && <ServerRailSkeleton seed={identity.localId} few />}
      </Stack>
    </>
  )
  return list.length ? section : <Held>{section}</Held>
}

// ----- The open server -----

const useOpen = () => {
  const room = useP2p(s => s.server?.room ?? null)
  const v = useP2p(s => (s.server ? s.servers[s.server.room] : undefined))
  return { room, v }
}

function ServerHead({ v }: { v: ServerView }) {
  const identity = useP2pApp()!
  const { p2p } = identity

  const acct = useAccount()

  const own = useP2p(s => ownsP2pServer(v, s.me))
  const open = (x: number, y: number) =>
    openActionMenu(x, y, { kind: 'p2p_server', v, folder: null, at: 0 }, undefined, acct, identity)
  return (
    <Surface
      pad="md"
      inset="sides"
      gap="sm"
      row
      tone="plain"
      radius="none"
      border="bottom"
      look="h-14"
      place="shrink-0"
    >
      <button
        {...longPress(open)}
        onClick={e => {
          const r = e.currentTarget.getBoundingClientRect()
          open(r.left + 12, r.bottom)
        }}
        className="flex min-w-0 flex-1 flex-col items-start rounded-lg px-1 py-0.5 text-left hover:bg-surface-container"
      >
        <Row as="span" gap="xs" place="w-full">
          <span data-p2p-server-name className="streamer truncate font-medium">
            <Masked text={v.name} own={own} />
          </span>
          <P2pBadge />
        </Row>
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
    </Surface>
  )
}

function P2pServerSidebarBody() {
  const identity = useP2pApp()!
  const { p2pServer, p2p } = identity

  const { room, v } = useOpen()
  const loading = useP2p(serversLoading)
  const prefs = useStore(s => s.notifyPrefs)
  const [adding, setAdding] = useState<string | null>(null)
  const [kind, setKind] = useState<'text' | 'voice'>('text')
  const place = useP2pRoom(room)
  const list = place ? featureAt(channelsFeature, place) : null
  const listed = list && !isUnsupported(list) ? list : null
  const listState = useLive(listed?.state ?? noChannels)
  if (!v || !listed)
    return (
      <aside className="flex h-full w-60 shrink-0 flex-col bg-surface-container-low">
        {room && loading && <ChannelListSkeleton seed={room} header className="min-h-0 flex-1" />}
      </aside>
    )
  const facts = (c: ChannelEntry) => {
    const counts = v.chans[c.key]
    const scope = channelScope(v.id, c.key)
    const muted =
      mutedOf(prefs, scope, time().now()) || mutedOf(prefs, serverScope(v.id), time().now())
    const pings = counts && levelOf(prefs, scope) !== 'nothing' ? counts.pings : 0
    return { scope, muted, pings, unread: !!counts?.unread && !muted }
  }
  const submit = () => {
    const name = (adding ?? '').trim()
    setAdding(null)
    if (!name) return
    void p2pServer.addChannel(v.id, name, kind).then(id => {
      if (id && kind === 'text') void p2pServer.openChannel(id)
    })
  }
  const kindBtn = (k: 'text' | 'voice') => (
    <IconButton
      icon={k === 'text' ? Hash : Volume2}
      label={k === 'text' ? 'Text channel' : 'Voice channel'}
      size="sm"
      shape="square"
      pressed={kind === k}
      onMouseDown={e => e.preventDefault()}
      onClick={() => setKind(k)}
    />
  )
  return (
    <aside
      data-p2p-sidebar
      className="flex h-full w-60 shrink-0 flex-col border-r border-dashed border-tertiary/40 bg-surface-container-low"
    >
      <ServerHead v={v} />
      <Surface pad="lg" inset="bar" tone="plain" radius="none">
        <Row gap="sm" justify="between">
          <span className="text-xs font-medium tracking-wider text-on-surface-variant uppercase">
            Channels
          </span>
          {listState.canManage && (
            <IconButton
              icon={Plus}
              label="Create channel"
              size="sm"
              onClick={() => {
                setKind('text')
                setAdding('')
              }}
            />
          )}
        </Row>
      </Surface>
      <PlaceProvider place={place ?? P2pRoom.open(identity, v.id)}>
        <ChannelList
          channels={listed}
          state={listState}
          look={c => {
            const { muted, unread } = facts(c)
            return { muted, bold: unread }
          }}
          end={c => {
            const { scope, pings, unread } = facts(c)
            return (
              <>
                <MutedIcon scope={scope} />
                <P2pChannelEnd room={v.id} ch={c.key} pings={pings} unread={unread} />
              </>
            )
          }}
          voice={entry => (
            <VoiceRow
              key={entry.key}
              channel={entry}
              own={listState.ownPlace}
              menu={(x, y) => listed.channelMenu(entry.key, x, y)}
            />
          )}
          rowProps={c => ({ 'data-p2p-channel': c.name })}
          categoryProps={category => ({ 'data-p2p-category': category.name })}
          createRow={category =>
            category === null && adding !== null ? (
              <Surface as="span" pad="sm" tone="plain" radius="none">
                <Row as="span" gap="sm">
                  <Row as="span" gap="3xs" place="shrink-0">
                    {kindBtn('text')}
                    {kindBtn('voice')}
                  </Row>
                  <input
                    autoFocus
                    value={adding}
                    maxLength={p2p.limits().server.nameMax}
                    onChange={e => setAdding(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') submit()
                      if (e.key === 'Escape') setAdding(null)
                    }}
                    onBlur={submit}
                    placeholder="channel name"
                    aria-label="New channel name"
                    className="min-w-0 flex-1 rounded-lg border border-primary bg-transparent px-2 py-1.5 text-base outline-none md:text-sm"
                  />
                </Row>
              </Surface>
            ) : null
          }
        />
      </PlaceProvider>
      <VoiceDock />
    </aside>
  )
}

// A member's menu (the settings and tests read its rows).
export const memberMenu = (
  v: ServerView,
  m: MemberView,
  acct = client.shown(),
  identity = acct.identities.viewed() ?? null
) => {
  registerAppActions()
  return menuItems(
    ctxFor(acct.store.getState(), { kind: 'p2p_member', v, m }, 'menu', acct, identity)
  )
}

// A member's menu with their card on top (roles, removable where we may).
export const openMemberMenu = (
  v: ServerView,
  m: MemberView,
  x: number,
  y: number,
  acct = client.shown(),
  identity = acct.identities.viewed() ?? null
) =>
  openActionMenu(
    x,
    y,
    { kind: 'p2p_member', v, m },
    {
      header: <MemberCard room={v.id} ik={m.ik} />,
    },
    acct,
    identity
  )

// The member list of the open room.
function P2pMemberListBody() {
  const identity = useP2pApp()!
  const room = useP2p(s => s.server?.room ?? null)
  if (room === null) return null
  return (
    <PlaceProvider place={P2pRoom.open(identity, room)}>
      <MemberSidebar />
    </PlaceProvider>
  )
}

const ServerIntro = () => (
  <P2pIntro id={P2P_SERVER_INTRO}>
    This server is stored only on its members&apos; devices. Messages reach you while a member who
    has them is online. The instance never sees them and doesn&apos;t filter them.
  </P2pIntro>
)

const NONE: string[] = []

const NO_SEND_TEXT = 'You do not have permission to send messages in this channel.'

// Why this device can't send in a server's channels (in place of the composer), or null, and
// whether it may act on messages there: a timeout leaves deleting and downloads.
export const sendBlockFor =
  (identity: P2pApp) =>
  (
    v: ServerView,
    st: {
      reader: boolean
      elsewhere: boolean
      status: string
      movedAt: number | null
      movingAt: number | null
      // When our timeout here ends, while it runs.
      timedOut: number | null
    },
    // The channel: may we send there?
    channel?: { send: boolean },
    acct = client.shown()
  ): { bar: ReactNode; canAct: boolean } => {
    const { p2pServer } = identity

    const out = v.readOnly
      ? v.readOnly
      : v.upgraded
        ? TRANSFERRED_TEXT
        : v.me === 'ban'
          ? 'You are banned from this server.'
          : v.me === 'leave'
            ? 'You are no longer a member of this server.'
            : v.me !== 'join'
              ? (v.joinWait ?? 'Joining. You can write once a member has let you in.')
              : null
    const away =
      st.reader || st.elsewhere ? (
        <NoteBar>
          <ElsewhereNotice />
        </NoteBar>
      ) : st.status === 'moved' ? (
        <NoteBar>{movedText(st.movedAt)}</NoteBar>
      ) : st.movingAt !== null ? (
        <MovingBanner bar />
      ) : out ? (
        <NoteBar data-p2p-out>
          {v.joinWait && v.me !== 'join' ? <span data-p2p-join-wait>{out}</span> : out}
          {v.upgraded && v.next && (
            <button
              onClick={() => p2pServer.open(v.next as string)}
              className="font-medium text-primary hover:underline"
            >
              Open the new copy
            </button>
          )}
          {v.me !== 'join' && v.me !== 'invite' && v.me !== null && (
            <button
              onClick={() => peerServer.forIdentity(identity).confirmForget(v, acct)}
              className="font-medium text-primary hover:underline"
            >
              Remove from this device
            </button>
          )}
        </NoteBar>
      ) : null
    if (away) return { bar: away, canAct: false }
    const block =
      channel && !channel.send ? (
        <NoteBar data-no-send>
          <Row as="span" gap="sm">
            <Lock size={16} className="shrink-0" />
            <span>{NO_SEND_TEXT}</span>
          </Row>
        </NoteBar>
      ) : v.full ? (
        <NoteBar role="status">This server reached its storage limit on this device.</NoteBar>
      ) : null
    return {
      bar: st.timedOut !== null ? <TimedOutBar ends={st.timedOut} /> : block,
      canAct: block === null,
    }
  }

function P2pChannelPaneBody({
  onMenu,
  onMembers,
  membersOpen,
}: {
  onMenu: () => void
  onMembers: () => void
  membersOpen: boolean
}) {
  const identity = useP2pApp()!
  const { memberName, p2pSearch } = identity

  const acct = useAccount()

  const { room: openRoom, v } = useOpen()
  const loading = useP2p(serversLoading)
  const chat = useP2p(s => (s.chat?.ch ? s.chat : null))
  const openCh = useP2p(s => s.server?.ch ?? null)
  const me = useP2p(s => s.me)
  const reader = useP2p(s => s.reader)
  const elsewhere = useP2p(s => s.elsewhere)
  const status = useP2p(s => s.status)
  const movedAt = useP2p(s => s.movedAt)
  const movingAt = useP2p(s => s.movingAt)
  const searchOpen = useP2p(s => s.panel === 'search')
  const typingIks = useP2p(s => (s.chat?.ch ? (s.serverTyping[chatKey(s.chat)] ?? NONE) : NONE))
  const menuPings = useStore(allPings)
  const voiceCh = v?.channels.find(c => c.id === openCh && c.kind === 'voice')
  const channel = voiceCh ?? v?.channels.find(c => c.id === chat?.ch)
  const room = v?.id ?? ''
  const own = useP2p(s => ownsP2pServer(v, s.me))
  const mask = useMask(own)
  const nameOf = useCallback((ik: string) => memberName(room, ik), [room])
  const members = v?.members
  const roles = v?.roles
  const lookOf = useMemo(
    () => (members && roles ? memberLooks({ members, roles }, mask) : undefined),
    [members, roles, mask]
  )
  const timedOut = usePeerTimeoutEnds(v?.timedOutUntil)
  const held = useChannelCan(useP2pRoom(v?.id ?? null), chat?.ch ?? null)
  const moderator = held.manage && timedOut === null
  const mayDelete = useCallback((p: P2pMessage) => p.sender === me || moderator, [me, moderator])

  if (!v)
    return (
      <main className="flex min-w-0 flex-1 flex-col bg-surface">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-outline-variant px-3 md:px-4">
          <button
            title="Menu"
            aria-label="Menu"
            onClick={onMenu}
            className="rounded-full p-1.5 hover:bg-surface-container-high md:hidden"
          >
            <Menu size={20} />
          </button>
        </header>
        {openRoom && loading && <MessageListSkeleton seed={openRoom} className="min-h-0 flex-1" />}
      </main>
    )

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
      <PeerActorTag header />
      {voiceCh ? (
        <Volume2 size={20} className="shrink-0 text-on-surface-variant" />
      ) : (
        <Hash size={20} className="shrink-0 text-on-surface-variant" />
      )}
      <span className="min-w-0 truncate font-medium">
        <Masked text={channel?.name ?? v.name} own={own} />
      </span>
      {channel?.restrict_view && (
        <span
          title="Private channel"
          aria-label="Private channel"
          role="img"
          className="flex shrink-0 text-on-surface-variant"
        >
          <Lock size={14} />
        </span>
      )}
      {!!channel?.slow && (
        <span
          data-p2p-slow
          title={slowTitle(channel.slow)}
          aria-label={slowTitle(channel.slow)}
          role="img"
          className="flex shrink-0 text-on-surface-variant"
        >
          <Clock size={16} />
        </span>
      )}
      {channel?.topic && (
        <span className="min-w-0 truncate text-sm text-on-surface-variant max-md:hidden">
          <Masked text={channel.topic} />
        </span>
      )}
      <span className={voiceCh ? 'flex' : 'max-sm:hidden'}>
        <P2pBadge />
      </span>
      <Row gap="2xs" place="ml-auto shrink-0">
        {chat && !voiceCh && (
          <PlaceProvider place={P2pRoom.open(identity, room)}>
            <PinsButton />
            <ThreadsButton />
          </PlaceProvider>
        )}
        {!v.readOnly && (
          <button
            title="Search"
            aria-label="Search"
            aria-pressed={searchOpen}
            onClick={() => (searchOpen ? p2pSearch.close() : p2pSearch.open())}
            className={`rounded-full p-1.5 ${searchOpen ? 'bg-secondary-container text-on-secondary-container' : 'hover:bg-surface-container-high'}`}
          >
            <Search size={20} />
          </button>
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
      </Row>
    </header>
  )

  if (voiceCh && !v.readOnly && !v.upgraded && v.me === 'join')
    return (
      <main
        data-p2p-channel-pane
        data-p2p-voice-pane
        className="flex min-w-0 flex-1 flex-col bg-surface"
      >
        {header}
        <VoiceGrid key={`v${v.id}${voiceCh.id}`} p2pRoom={v.id} p2pCh={voiceCh.id} />
      </main>
    )

  if ((reader || elsewhere) && !chat)
    return (
      <main data-p2p-channel-pane className="flex min-w-0 flex-1 flex-col bg-surface">
        {header}
        <Surface pad="lg" tone="plain" radius="none" place="mx-auto max-w-2xl">
          <ElsewhereNotice />
        </Surface>
      </main>
    )

  if (!chat || !channel) {
    const waiting = !v.readOnly && (v.me === null || v.joining)
    return (
      <main data-p2p-channel-pane className="flex min-w-0 flex-1 flex-col bg-surface">
        {header}
        <Surface pad="xl" tone="plain" radius="none" place="flex-1">
          <div className="flex flex-1 flex-col text-center text-on-surface-variant">
            <Stack gap="sm" align="center" justify="center" place="flex-1">
              {v.readOnly ? (
                <>
                  <span data-p2p-readonly className="text-sm">
                    {v.readOnly}
                  </span>
                  <button
                    onClick={() => peerServer.forIdentity(identity).confirmForget(v, acct)}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    Remove from this device
                  </button>
                </>
              ) : waiting ? (
                <>
                  <span data-p2p-joining className="text-lg font-medium text-on-surface">
                    Joining <Masked text={v.name} own={own} />…
                  </span>
                  <span data-p2p-join-wait className="max-w-md text-sm">
                    {v.joinWait ??
                      'Waiting for a member to send the server. Someone who can invite must be online.'}
                  </span>
                  {v.syncing !== null && <span className="text-xs">{SYNCING_TEXT(v.syncing)}</span>}
                </>
              ) : (
                <span>No channel open.</span>
              )}
            </Stack>
          </div>
        </Surface>
      </main>
    )
  }

  const { bar: disabled, canAct } = sendBlockFor(identity)(
    v,
    { reader, elsewhere, status, movedAt, movingAt, timedOut },
    channel,
    acct
  )

  return (
    <ChannelCanContext.Provider value={held}>
      <P2pChatBody
        chat={chat}
        channelTextOnly={channel.text_only}
        header={header}
        above={<ServerNotices v={v} />}
        intro={<ServerIntro />}
        disabled={disabled}
        canAct={canAct}
        timedOut={timedOut !== null}
        lookOf={lookOf}
        title={`#${mask(channel.name)}`}
        placeholder={`Message #${mask(channel.name)}`}
        pendingTip="Waiting for a member to come online"
        peerFull={false}
        gap={v.gap}
        online={others}
        gapOffline="Older messages unavailable until a member who has them is online"
        empty={
          <>
            <span className="text-2xl font-semibold">
              Welcome to #<Masked text={channel.name} own={own} />
            </span>
            <span className="text-sm">
              This is the start of the channel. Messages are stored on members&apos; devices.
            </span>
          </>
        }
        typingNames={typingIks.map(nameOf)}
        mayDelete={mayDelete}
        mayPin={held.pin && timedOut === null}
        forwardSkip={null}
        dataAttr={{ 'data-p2p-channel-pane': '' }}
      />
    </ChannelCanContext.Provider>
  )
}

// Invites from contacts, for the P2P home.
function ServerInviteRowsBody() {
  const identity = useP2pApp()!
  const { p2pServer } = identity

  const invites = useP2p(s => s.serverInvites)
  const contacts = useP2p(s => s.contacts)
  if (!invites.length) return null
  return (
    <Stack as="section" aria-label="P2P server invites" gap="none">
      <Surface pad="md" inset="bar" tone="plain" radius="none">
        <p className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
          P2P server invites ({invites.length})
        </p>
      </Surface>
      <Stack as="ul" gap="sm">
        {invites.map(i => {
          const c = contacts.find(x => x.ik === i.from)
          return (
            <li
              key={i.room}
              data-p2p-server-invite={i.name}
              className="rounded-2xl border border-dashed border-tertiary bg-surface-container"
            >
              <Surface pad="md" tone="plain" radius="none">
                <Row gap="md">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-tertiary font-semibold">
                    <ServerIcon
                      seed={i.room}
                      name={i.name}
                      kind={i.about.icon}
                      color={hex(i.color)}
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="streamer truncate text-sm font-medium">
                      <Masked text={i.name} />
                    </p>
                    <AboutLine text={i.about.text} oneLine />
                    <p className="truncate text-xs text-on-surface-variant">
                      From{' '}
                      <span className="streamer">
                        {c ? <Masked text={displayName(c)} /> : 'a contact'}
                      </span>
                      . Someone in it must be online to let you in.
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
                </Row>
              </Surface>
            </li>
          )
        })}
      </Stack>
    </Stack>
  )
}

export const P2pFolderEntry = withP2pIdentity(P2pFolderEntryBody)
export const P2pJoinTile = withP2pIdentity(P2pJoinTileBody)
export const P2pServerRail = withP2pIdentity(P2pServerRailBody)
export const P2pServerSidebar = withP2pIdentity(P2pServerSidebarBody)
export const P2pMemberList = withP2pIdentity(P2pMemberListBody)
export const P2pChannelPane = withP2pIdentity(P2pChannelPaneBody)
export const ServerInviteRows = withP2pIdentity(ServerInviteRowsBody)
