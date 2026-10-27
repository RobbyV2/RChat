'use client'

import { useMemo, useRef, useState } from 'react'
import { Hash, Pin, Plus, Volume2 } from 'lucide-react'
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
import { VoiceDock } from './voice_grid'
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
            <div key={c.id}>
              <button
                title="Join voice channel"
                onClick={() => void joinVoice(detail.name, c.id)}
                {...longPress(channelMenu(c))}
                className={`mx-2 flex w-[calc(100%-1rem)] items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm ${
                  view?.kind === 'channel' && view.channelId === c.id
                    ? 'bg-secondary-container text-on-secondary-container'
                    : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
                }`}
              >
                <Volume2 size={16} className="shrink-0" />
                <span className="truncate">{c.name}</span>
              </button>
              {(voiceUsers[c.id] ?? []).map(u => {
                const user = userRefFor(useStore.getState(), u)
                const speaking = voice?.channelId === c.id && rtc.isSpeaking(u)
                return (
                  <div
                    key={u}
                    {...profileTrigger(user, detail.name)}
                    className="mr-2 ml-9 flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-0.5 text-sm text-on-surface-variant outline-offset-[-2px] hover:bg-surface-container hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <span
                      className={`flex shrink-0 rounded-full ${
                        speaking ? 'ring-2 ring-green-500' : ''
                      }`}
                    >
                      <UserAvatar
                        username={user.username}
                        avatarKind={user.avatar_kind}
                        avatarColor={user.avatar_color}
                        size={18}
                      />
                    </span>
                    <span className="streamer truncate">{user.display_name}</span>
                  </div>
                )
              })}
            </div>
          )
        )}
      </div>
      <VoiceDock />
    </aside>
  )
}
