'use client'

import { useState, type MouseEvent } from 'react'
import { Hash, Plus, Settings, Volume2 } from 'lucide-react'
import { myPerms, serverAdminPerms, userRefFor, useStore } from '../lib/store'
import { rtc } from '../lib/rtc'
import { Perm, hasPerm, type Channel, type ChannelKind } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { VoiceDock } from './voice_grid'

type Editing = { mode: 'create'; kind: ChannelKind } | { mode: 'rename'; id: number }

const base = 'flex h-full w-60 shrink-0 flex-col bg-surface-container-low'

export function ChannelSidebar() {
  const view = useStore(s => s.view)
  const perms = useStore(s => (s.view?.kind === 'channel' ? myPerms(s, s.view.server) : 0))
  const panelPerms = useStore(s =>
    s.view?.kind === 'channel' ? serverAdminPerms(s, s.view.server) : 0
  )
  const servers = useStore(s => s.servers)
  const dms = useStore(s => s.dms)
  const openChannel = useStore(s => s.openChannel)
  const openDialog = useStore(s => s.openDialog)
  const openContextMenu = useStore(s => s.openContextMenu)
  const createChannel = useStore(s => s.createChannel)
  const renameChannel = useStore(s => s.renameChannel)
  const deleteChannel = useStore(s => s.deleteChannel)
  const joinVoice = useStore(s => s.joinVoice)
  const voiceUsers = useStore(s => s.voiceUsers)
  const voice = useStore(s => s.voice)
  useStore(s => s.rtcTick)
  useStore(s => s.members)
  useStore(s => s.me)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [name, setName] = useState('')

  if (view?.kind === 'dm') {
    const dm = dms.find(d => d.id === view.dmId)
    return (
      <aside className={base}>
        <header className="flex h-14 items-center gap-2 border-b border-outline-variant px-4">
          {dm && (
            <>
              <UserAvatar
                username={dm.other.username}
                avatarKind={dm.other.avatar_kind}
                avatarColor={dm.other.avatar_color}
                size={28}
              />
              <span className="streamer truncate font-medium">{dm.other.display_name}</span>
              {dm.is_self && (
                <span className="shrink-0 rounded-full bg-secondary-container px-2 py-0.5 text-xs text-on-secondary-container">
                  yourself
                </span>
              )}
            </>
          )}
        </header>
        <p className="px-4 py-3 text-xs text-on-surface-variant">
          {dm?.is_self ? 'Your personal space. Only you can see these messages.' : 'Direct message'}
        </p>
        <div className="mt-auto">
          <VoiceDock />
        </div>
      </aside>
    )
  }

  const detail = view ? servers[view.server] : undefined
  if (!detail) return <aside className={base} />
  const canManage = hasPerm(perms, Perm.ManageChannels)

  const startEdit = (next: Editing, initial: string) => {
    setEditing(next)
    setName(initial)
  }

  const submit = () => {
    const trimmed = name.trim()
    const current = editing
    setEditing(null)
    setName('')
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

  const channelMenu = (c: Channel) => (e: MouseEvent<HTMLButtonElement>) => {
    if (!canManage) return
    e.preventDefault()
    openContextMenu(e.clientX, e.clientY, [
      {
        label: 'Rename Channel',
        action: () => startEdit({ mode: 'rename', id: c.id }, c.name),
      },
      ...(detail.channels.length > 1
        ? [
            {
              label: 'Delete Channel',
              danger: true,
              action: () => void deleteChannel(c.id),
            },
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
        if (e.key === 'Enter') submit()
        if (e.key === 'Escape') setEditing(null)
      }}
      onBlur={submit}
      placeholder="channel name"
      className="mx-2 my-0.5 rounded-lg border border-primary bg-transparent px-2 py-1.5 text-sm outline-none"
    />
  )

  return (
    <aside className={base}>
      <header className="flex h-14 items-center justify-between border-b border-outline-variant px-4">
        {detail.name === 'rchat' ? (
          <img src="/rchat_logo.png" alt="RChat" className="h-8 w-auto" />
        ) : (
          <span className="streamer truncate font-medium">{detail.display_name}</span>
        )}
        {panelPerms !== 0 && (
          <button
            title="Server settings"
            onClick={() => openDialog({ kind: 'server_settings', server: detail.name })}
            className="shrink-0 rounded-full p-1.5 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
          >
            <Settings size={18} />
          </button>
        )}
      </header>
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
              onContextMenu={channelMenu(c)}
              className={`mx-2 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm ${
                view?.kind === 'channel' && view.channelId === c.id
                  ? 'bg-secondary-container text-on-secondary-container'
                  : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
              }`}
            >
              <Hash size={16} className="shrink-0" />
              <span className="truncate">{c.name}</span>
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
                onContextMenu={channelMenu(c)}
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
                    className="ml-9 flex items-center gap-1.5 px-2 py-0.5 text-sm text-on-surface-variant"
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
