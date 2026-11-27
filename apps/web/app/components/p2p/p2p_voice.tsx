'use client'
import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'

import { Lock, Volume2 } from 'lucide-react'
import { useStore } from '../../lib/store'
import { voiceStatus } from '../../lib/voice_status'
import { VoiceStatusIcons } from '../voice_status'

import type { MemberView, ServerView } from '../../lib/p2p/server'
import type { VoiceUser } from '../../lib/p2p/voice'
import { longPress } from '../context_menu'
import { Masked } from '../ui'
import { LiveBadge } from '../voice_grid'
import { MemberAvatar } from './p2p_badge'

import { useAccount } from '../../lib/client/react'
import { useChannelPerms } from '../../lib/client/use_channel_perms'
import { NO_CONNECT } from '../../lib/timeouts'

// Voice channels of a P2P server in its sidebar: the row joins (and opens the stage), and who is
// in the channel shows under it with identicons, as in instance servers.

const NONE: VoiceUser[] = []

function VoiceMember({
  v,
  u,
  inRoom,
  menu,
}: {
  v: ServerView
  u: VoiceUser
  inRoom: boolean
  menu: (m: MemberView) => (x: number, y: number) => void
}) {
  const identity = useP2pApp()!
  const { callRtc } = identity

  useStore(s => s.rtcTick)
  const selfAudio = useStore(s => s.selfAudio)
  const me = useP2p(s => s.me)
  const myName = useP2p(s => s.name)
  const m = v.members.find(x => x.ik === u.ik)
  const self = u.ik === me
  const name = m?.name ?? (self ? myName : 'Member')
  const peer = inRoom && !self ? callRtc.peer(u.ik) : undefined
  const speaking = inRoom && callRtc.isSpeaking(u.ik)
  const silenced = u.silenced === true
  const status = voiceStatus({
    self: self && inRoom,
    selfAudio: silenced ? { ...selfAudio, muted: true } : selfAudio,
    live: peer ? { muted: peer.muted || silenced } : null,
    roster: { muted: u.muted || silenced, deafened: u.deafened },
    forced: null,
  })
  const live = inRoom && (self ? callRtc.sharing : (peer?.screenOn ?? false))
  const open = m ? menu(m) : null
  return (
    <div
      data-p2p-voice-member={name}
      {...(open ? longPress(open) : {})}
      onClick={e => {
        if (!open) return
        const r = e.currentTarget.getBoundingClientRect()
        open(r.left + 24, r.bottom)
      }}
      className="mr-2 ml-7 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm text-on-surface-variant hover:bg-surface-container hover:text-on-surface active:bg-surface-container-high"
    >
      <span
        data-speaking={speaking || undefined}
        className={`flex shrink-0 rounded-full transition-shadow ${
          speaking ? 'ring-2 ring-status-green ring-offset-1 ring-offset-surface-container-low' : ''
        }`}
      >
        <MemberAvatar members={v.members} ik={u.ik} size={22} />
      </span>
      <span className={`streamer min-w-0 flex-1 truncate ${speaking ? 'text-on-surface' : ''}`}>
        <Masked text={name} own={self} />
      </span>
      {live && (
        <LiveBadge size="sm" title={self ? "You're sharing your screen" : 'Sharing their screen'} />
      )}
      <VoiceStatusIcons status={status} self={self} size={14} variant="row" />
    </div>
  )
}

function P2pVoiceRowBody({
  v,
  c,
  active,
  menu,
  memberMenu,
}: {
  v: ServerView
  c: { id: string; name: string; restrict_view?: true }
  active: boolean
  menu: (x: number, y: number) => void
  memberMenu: (m: MemberView) => (x: number, y: number) => void
}) {
  const identity = useP2pApp()!
  const { peerTarget, p2pServer, p2pVoice } = identity

  const here = useP2p(s => s.voice?.room === v.id && s.voice.ch === c.id)
  const instance = useStore(s => s.voice !== null || s.call !== null)
  const connected = here && !instance
  const { useViewing, canView } = useAccount().viewing
  useViewing(s => s.revision)
  const closed = useP2p(s => {
    const target = peerTarget(s, v.id, c.id)
    return !!target && !canView(target)
  })
  const users = (!closed && v.voice[c.id]) || NONE
  const count = users.length
  const can = useChannelPerms({ p2pRoom: v.id, ch: c.id })
  const locked = !connected && !can.connect
  return (
    <div className="flex flex-col rounded-lg">
      <button
        data-p2p-voice-channel={c.name}
        title={locked ? NO_CONNECT : connected ? 'Open voice channel' : 'Join voice channel'}
        aria-label={`${connected ? 'Open' : 'Join'} voice channel ${c.name}${
          count ? `, ${count} connected` : ''
        }${locked ? `. ${NO_CONNECT}` : ''}`}
        aria-disabled={locked || undefined}
        onClick={() => {
          if (connected) void p2pServer.openChannel(c.id)
          else if (!locked) void p2pVoice.join(v.id, c.id)
        }}
        {...longPress(menu)}
        className={`mx-2 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm outline-offset-[-2px] transition-colors focus-visible:outline-2 focus-visible:outline-primary active:scale-[0.98] ${
          active
            ? 'bg-secondary-container text-on-secondary-container'
            : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
        }`}
      >
        <Volume2 size={16} className={`shrink-0 ${connected ? 'text-status-green' : ''}`} />
        <span className="truncate">
          <Masked text={c.name} />
        </span>
        {c.restrict_view && (
          <span
            title="Private channel"
            aria-label="Private channel"
            role="img"
            className="flex shrink-0"
          >
            <Lock size={12} />
          </span>
        )}
        {count > 0 && (
          <span
            title={`${count} in voice`}
            className="ml-auto shrink-0 rounded-full bg-surface-container-highest px-1.5 text-2xs leading-4 font-medium text-on-surface-variant tabular-nums"
          >
            {count}
          </span>
        )}
      </button>
      {users.map(u => (
        <VoiceMember key={u.ik} v={v} u={u} inRoom={connected} menu={memberMenu} />
      ))}
    </div>
  )
}

export const P2pVoiceRow = withP2pIdentity(P2pVoiceRowBody)
