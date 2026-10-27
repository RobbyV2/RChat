'use client'

import { useMemo, useRef, useState } from 'react'
import { HeadphoneOff, Hash, MicOff, Pin, Plus, Volume2 } from 'lucide-react'
import { myPerms, serverAdminPerms, userRefFor, useStore } from '../lib/store'
import { dmSections } from '../lib/nav_layout'
import { canDeleteChannel } from '../lib/rules'
import { enterKey } from '../lib/keys'
import { rtc } from '../lib/rtc'
import { Perm, hasPerm, type Channel, type ChannelKind, type DmSummary } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { ServerHeader } from './server_header'
import { longPress } from './context_menu'
import { dragScope, useDrag } from './drag'
import { profileTrigger } from './profile_card'
import { LiveBadge, VoiceDock } from './voice_grid'
import { Sentinel } from './server_settings'
import { useAuthorMembers } from './message_pane'

type Editing = { mode: 'create'; kind: ChannelKind } | { mode: 'rename'; id: number }

const base = 'flex h-full w-60 shrink-0 flex-col bg-surface-container-low'

function DmRow({
  dm,
  pinned,
  active,
  unread,
}: {
  dm: DmSummary
  pinned: boolean
  active: boolean
  unread: boolean
}) {
  const openDm = useStore(s => s.openDm)
  const openContextMenu = useStore(s => s.openContextMenu)
  const pinDm = useStore(s => s.pinDm)
  const unpinDm = useStore(s => s.unpinDm)
  const placeDm = useStore(s => s.placeDm)
  const { id, other, is_self } = dm
  return (
    <button
      onClick={() => void openDm(id)}
      {...longPress(
        (x, y) =>
          openContextMenu(x, y, [
            pinned
              ? { label: 'Unpin DM', action: () => unpinDm(id) }
              : { label: 'Pin DM', action: () => pinDm(id) },
            {
              label: 'Copy DM ID',
              action: () => void navigator.clipboard.writeText(String(id)),
            },
            {
              label: 'Copy User ID',
              action: () => void navigator.clipboard.writeText(other.username),
            },
          ]),
        {
          group: 'dm',
          key: String(id),
          onDrop: ({ zone, index }) => placeDm(id, zone === 'pinned' ? 'pinned' : 'recent', index),
        }
      )}
      className={`mx-2 flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
        active
          ? 'bg-secondary-container text-on-secondary-container'
          : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
      }`}
    >
      <UserAvatar
        username={other.username}
        avatarKind={other.avatar_kind}
        avatarColor={other.avatar_color}
        size={28}
      />
      <span className="streamer truncate">{other.display_name}</span>
      {unread && (
        <span title="Unread" aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-error" />
      )}
      {is_self && (
        <span className="ml-auto shrink-0 rounded-full bg-secondary-container px-2 py-0.5 text-xs text-on-secondary-container">
          you
        </span>
      )}
    </button>
  )
}

function VoiceChannelRow({
  channel,
  active,
  connected,
  count,
  onJoin,
  menu,
}: {
  channel: Channel
  active: boolean
  connected: boolean
  count: number
  onJoin: () => void
  menu: (x: number, y: number) => void
}) {
  return (
    <button
      title={connected ? 'Open voice channel' : 'Join voice channel'}
      aria-label={`${connected ? 'Open' : 'Join'} voice channel ${channel.name}${
        count ? `, ${count} connected` : ''
      }`}
      onClick={onJoin}
      {...longPress(menu)}
      className={`group mx-2 flex w-[calc(100%-1rem)] items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm outline-offset-[-2px] transition-colors focus-visible:outline-2 focus-visible:outline-primary active:scale-[0.98] ${
        active
          ? 'bg-secondary-container text-on-secondary-container'
          : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
      }`}
    >
      <Volume2 size={16} className={`shrink-0 ${connected ? 'text-status-green' : ''}`} />
      <span className="truncate">{channel.name}</span>
      {count > 0 && (
        <span
          title={`${count} in voice`}
          className="ml-auto shrink-0 rounded-full bg-surface-container-highest px-1.5 text-[11px] leading-4 font-medium text-on-surface-variant tabular-nums"
        >
          {count}
        </span>
      )}
    </button>
  )
}

function VoiceMemberRow({
  username,
  server,
  inRoom,
}: {
  username: string
  server: string
  inRoom: boolean
}) {
  const me = useStore(s => s.me)
  const selfAudio = useStore(s => s.selfAudio)
  useStore(s => s.rtcTick)
  const user = userRefFor(useStore.getState(), username)
  const self = me?.username === username
  const speaking = inRoom && rtc.isSpeaking(username)
  const muted = inRoom && (self ? selfAudio.muted : (rtc.peer(username)?.muted ?? false))
  const deafened = inRoom && self && selfAudio.deafened
  const live = inRoom && (self ? rtc.sharing : (rtc.peer(username)?.screenOn ?? false))
  return (
    <div
      {...profileTrigger(user, server)}
      className="mr-2 ml-7 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm text-on-surface-variant outline-offset-[-2px] hover:bg-surface-container hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary active:bg-surface-container-high"
    >
      <span
        className={`flex shrink-0 rounded-full transition-shadow ${
          speaking ? 'ring-2 ring-status-green ring-offset-1 ring-offset-surface-container-low' : ''
        }`}
      >
        <UserAvatar
          username={user.username}
          avatarKind={user.avatar_kind}
          avatarColor={user.avatar_color}
          size={22}
        />
      </span>
      <span className={`streamer min-w-0 flex-1 truncate ${speaking ? 'text-on-surface' : ''}`}>
        {user.display_name}
      </span>
      {live && (
        <LiveBadge size="sm" title={self ? "You're sharing your screen" : 'Sharing their screen'} />
      )}
      {muted && !deafened && (
        <span title="Muted" className="flex shrink-0 text-mute-fg">
          <MicOff size={14} />
        </span>
      )}
      {deafened && (
        <span title="Deafened" className="flex shrink-0 text-mute-fg">
          <HeadphoneOff size={14} />
        </span>
      )}
    </div>
  )
}

export function ChannelSidebar() {
  const view = useStore(s => s.view)
  const perms = useStore(s => (s.view?.kind === 'channel' ? myPerms(s, s.view.server) : 0))
  const panelPerms = useStore(s =>
    s.view?.kind === 'channel' ? serverAdminPerms(s, s.view.server) : 0
  )
  const servers = useStore(s => s.servers)
  const dms = useStore(s => s.dms)
  const layout = useStore(s => s.layout)
  const dmsMore = useStore(s => s.dmsMore)
  const loadMoreDms = useStore(s => s.loadMoreDms)
  const startDm = useStore(s => s.startDm)
  const dmDrag = useDrag(s => s.group === 'dm')
  const dragKey = useDrag(s => s.key)
  const dropZone = useDrag(s => s.zone)
  const { pinned, recent } = useMemo(() => dmSections(dms, layout), [dms, layout])
  const openChannel = useStore(s => s.openChannel)
  const openDialog = useStore(s => s.openDialog)
  const openContextMenu = useStore(s => s.openContextMenu)
  const createChannel = useStore(s => s.createChannel)
  const renameChannel = useStore(s => s.renameChannel)
  const deleteChannel = useStore(s => s.deleteChannel)
  const askConfirm = useStore(s => s.askConfirm)
  const joinVoice = useStore(s => s.joinVoice)
  const voiceUsers = useStore(s => s.voiceUsers)
  const voice = useStore(s => s.voice)
  const reads = useStore(s => s.reads)
  const unread = (scope: string) => {
    const r = reads[scope]
    return !!r && r.latest > r.lastRead
  }
  useStore(s => s.rtcTick)
  useStore(s => s.members)
  useStore(s => s.memberInfo)
  useStore(s => s.me)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [name, setName] = useState('')
  const [dmInput, setDmInput] = useState<string | null>(null)
  const settled = useRef(false)
  const voiceServer = view?.kind === 'channel' ? view.server : null
  const voiceKey = useStore(s => {
    const channels = voiceServer ? s.servers[voiceServer]?.channels : undefined
    if (!channels) return ''
    const names = channels.flatMap(c => (c.kind === 'voice' ? (s.voiceUsers[c.id] ?? []) : []))
    return [...new Set(names)].sort().join('\n')
  })
  useAuthorMembers(voiceServer, voiceKey)

  if (view?.kind === 'dm') {
    const submitDm = () => {
      const target = (dmInput ?? '').trim().toLowerCase()
      setDmInput(null)
      if (settled.current) return
      settled.current = true
      if (target) void startDm(target)
    }
    const pinZone = dmDrag && pinned.length === 0
    const pinning = dropZone === 'pinned' && !pinned.some(d => String(d.id) === dragKey)
    const row = (dm: DmSummary, isPinned: boolean) => (
      <DmRow
        key={dm.id}
        dm={dm}
        pinned={isPinned}
        active={view.dmId === dm.id}
        unread={unread(`d${dm.id}`)}
      />
    )
    return (
      <aside className={base}>
        <div ref={dragScope} className="flex flex-1 flex-col overflow-y-auto pb-3">
          {pinned.length > 0 && (
            <div
              data-drop-zone="pinned"
              data-drop-label="Pin"
              className={`flex shrink-0 flex-col pb-1 transition-colors ${
                pinning ? 'bg-primary-container/40' : ''
              }`}
            >
              <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-surface-container-low px-4 pt-3 pb-1 text-xs font-medium tracking-wider text-on-surface-variant uppercase">
                <Pin size={12} className="shrink-0" />
                Pinned
              </div>
              {pinned.map(dm => row(dm, true))}
            </div>
          )}
          <div
            data-drop-zone={pinZone ? 'pinned' : undefined}
            data-drop-label={pinZone ? 'Pin' : undefined}
            className="sticky top-0 z-10 shrink-0 bg-surface-container-low"
          >
            {pinZone ? (
              <div
                className={`mx-2 my-1 flex h-8 items-center justify-center gap-1.5 rounded-lg border-2 border-dashed text-xs font-medium transition-colors ${
                  dropZone === 'pinned'
                    ? 'border-primary bg-primary-container text-on-primary-container'
                    : 'border-outline text-on-surface-variant'
                }`}
              >
                <Pin size={14} className="shrink-0" />
                Drop here to pin
              </div>
            ) : (
              <div className="flex items-center justify-between px-4 pt-3 pb-1">
                <span className="text-xs font-medium tracking-wider text-on-surface-variant uppercase">
                  Direct Messages
                </span>
                <button
                  title="New direct message"
                  onClick={() => {
                    settled.current = false
                    setDmInput('')
                  }}
                  className="rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                >
                  <Plus size={16} />
                </button>
              </div>
            )}
          </div>
          {dmInput !== null && (
            <input
              autoFocus
              value={dmInput}
              onChange={e => setDmInput(e.target.value)}
              onKeyDown={e => {
                if (enterKey(e)) submitDm()
                if (e.key === 'Escape') {
                  settled.current = true
                  setDmInput(null)
                }
              }}
              onBlur={submitDm}
              placeholder="username"
              className="mx-2 my-0.5 shrink-0 rounded-lg border border-primary bg-transparent px-2 py-1.5 text-base outline-none md:text-sm"
            />
          )}
          <div data-drop-zone="recent" data-drop-label="Unpin" className="flex shrink-0 flex-col">
            {recent.map(dm => row(dm, false))}
            {dmsMore && <Sentinel key={dms.length} onVisible={loadMoreDms} />}
          </div>
        </div>
        <VoiceDock />
      </aside>
    )
  }

  const detail = view ? servers[view.server] : undefined
  if (!detail) return <aside className={base} />
  const canManage = hasPerm(perms, Perm.ManageChannels)

  const startEdit = (next: Editing, initial: string) => {
    settled.current = false
    setEditing(next)
    setName(initial)
  }

  const submit = () => {
    const trimmed = name.trim()
    const current = editing
    setEditing(null)
    setName('')
    if (settled.current) return
    settled.current = true
    if (!trimmed || !current) return
    switch (current.mode) {
      case 'create':
        void createChannel(detail.name, trimmed, current.kind)
        return
      case 'rename':
        void renameChannel(current.id, trimmed)
        return
    }
  }

  const textChannels = detail.channels.filter(c => c.kind === 'text')
  const voiceChannels = detail.channels.filter(c => c.kind === 'voice')

  const channelMenu = (c: Channel) => (x: number, y: number) => {
    openContextMenu(x, y, [
      {
        label: 'Copy Channel ID',
        action: () => void navigator.clipboard.writeText(String(c.id)),
      },
      ...(canManage
        ? [
            {
              label: 'Rename Channel',
              action: () => startEdit({ mode: 'rename', id: c.id }, c.name),
            },
            ...(canDeleteChannel(detail.channels, c)
              ? [
                  {
                    label: 'Delete Channel',
                    danger: true,
                    action: () =>
                      askConfirm({
                        title: 'Delete Channel',
                        body:
                          c.kind === 'text'
                            ? `Delete #${c.name}? Its messages are deleted for everyone.`
                            : `Delete the voice channel ${c.name}?`,
                        confirm: 'Delete',
                        action: () => void deleteChannel(c.id),
                      }),
                  },
                ]
              : []),
          ]
        : []),
    ])
  }

  const editInput = (
    <input
      autoFocus
      value={name}
      onChange={e => setName(e.target.value)}
      onKeyDown={e => {
        if (enterKey(e)) submit()
        if (e.key === 'Escape') {
          settled.current = true
          setEditing(null)
        }
      }}
      onBlur={submit}
      placeholder="channel name"
      className="mx-2 my-0.5 rounded-lg border border-primary bg-transparent px-2 py-1.5 text-base outline-none md:text-sm"
    />
  )

  return (
    <aside className={base}>
      <ServerHeader
        server={detail.name}
        displayName={detail.display_name}
        bannerColor={detail.banner_color}
        nameColor={detail.name_color}
        onSettings={
          panelPerms !== 0
            ? () => openDialog({ kind: 'server_settings', server: detail.name })
            : undefined
        }
      />
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <span className="text-xs font-medium tracking-wider text-on-surface-variant uppercase">
          Channels
        </span>
        {canManage && (
          <button
            title="Create channel"
            onClick={() => startEdit({ mode: 'create', kind: 'text' }, '')}
            className="rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
          >
            <Plus size={16} />
          </button>
        )}
      </div>
      <div className="flex flex-1 flex-col overflow-y-auto pb-3">
        {textChannels.map(c =>
          editing?.mode === 'rename' && editing.id === c.id ? (
            <span key={c.id} className="flex">
              {editInput}
            </span>
          ) : (
            <button
              key={c.id}
              onClick={() => void openChannel(detail.name, c.id)}
              {...longPress(channelMenu(c))}
              className={`mx-2 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm ${
                view?.kind === 'channel' && view.channelId === c.id
                  ? 'bg-secondary-container text-on-secondary-container'
                  : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
              }`}
            >
              <Hash size={16} className="shrink-0" />
              <span className="truncate">{c.name}</span>
              {unread(`c${c.id}`) && (
                <span
                  title="Unread"
                  aria-hidden
                  className="ml-auto h-2 w-2 shrink-0 rounded-full bg-error"
                />
              )}
            </button>
          )
        )}
        {editing?.mode === 'create' && (
          <span className="flex items-center">
            <span className="flex shrink-0 gap-0.5 pl-2">
              <button
                title="Text channel"
                onMouseDown={e => e.preventDefault()}
                onClick={() => setEditing({ mode: 'create', kind: 'text' })}
                className={`rounded-lg p-1.5 ${
                  editing.kind === 'text'
                    ? 'bg-secondary-container text-on-secondary-container'
                    : 'text-on-surface-variant hover:bg-surface-container'
                }`}
              >
                <Hash size={14} />
              </button>
              <button
                title="Voice channel"
                onMouseDown={e => e.preventDefault()}
                onClick={() => setEditing({ mode: 'create', kind: 'voice' })}
                className={`rounded-lg p-1.5 ${
                  editing.kind === 'voice'
                    ? 'bg-secondary-container text-on-secondary-container'
                    : 'text-on-surface-variant hover:bg-surface-container'
                }`}
              >
                <Volume2 size={14} />
              </button>
            </span>
            {editInput}
          </span>
        )}
        {voiceChannels.length > 0 && (
          <p className="px-4 pt-4 pb-1 text-xs font-medium tracking-wider text-on-surface-variant uppercase">
            Voice
          </p>
        )}
        {voiceChannels.map(c =>
          editing?.mode === 'rename' && editing.id === c.id ? (
            <span key={c.id} className="flex">
              {editInput}
            </span>
          ) : (
            <div key={c.id} className="flex flex-col">
              <VoiceChannelRow
                channel={c}
                active={view?.kind === 'channel' && view.channelId === c.id}
                connected={voice?.channelId === c.id}
                count={(voiceUsers[c.id] ?? []).length}
                onJoin={() => void joinVoice(detail.name, c.id)}
                menu={channelMenu(c)}
              />
              {(voiceUsers[c.id] ?? []).map(u => (
                <VoiceMemberRow
                  key={u}
                  username={u}
                  server={detail.name}
                  inRoom={voice?.channelId === c.id}
                />
              ))}
            </div>
          )
        )}
      </div>
      <VoiceDock />
    </aside>
  )
}
