'use client'

import { HeadphoneOff, Lock, MicOff, Volume2 } from 'lucide-react'
import { useStore } from '../../lib/store'
import { callRtc, p2pServer, p2pVoice, useP2p } from '../../lib/p2p/app'
import type { MemberView, ServerView } from '../../lib/p2p/server'
import type { VoiceUser } from '../../lib/p2p/voice'
import { longPress } from '../context_menu'
import { Masked } from '../ui'
import { LiveBadge } from '../voice_grid'
import { KeyAvatar } from './p2p_badge'

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
  useStore(s => s.rtcTick)
  const selfAudio = useStore(s => s.selfAudio)
  const me = useP2p(s => s.me)
  const myName = useP2p(s => s.name)
  const m = v.members.find(x => x.ik === u.ik)
  const self = u.ik === me
  const name = m?.name ?? (self ? myName : 'Member')
  const peer = inRoom && !self ? callRtc.peer(u.ik) : undefined
  const speaking = inRoom && callRtc.isSpeaking(u.ik)
  const muted = inRoom && (self ? selfAudio.muted : (peer?.muted ?? false))
  const deafened = inRoom && self && selfAudio.deafened
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
        <KeyAvatar ik={u.ik} size={22} />
      </span>
      <span className={`streamer min-w-0 flex-1 truncate ${speaking ? 'text-on-surface' : ''}`}>
        <Masked text={name} />
      </span>
      {live && (
        <LiveBadge size="sm" title={self ? "You're sharing your screen" : 'Sharing their screen'} />
      )}
      {muted && !deafened && (
        <span title="Muted" aria-label="Muted" role="img" className="flex shrink-0 text-mute-fg">
          <MicOff size={14} />
        </span>
      )}
      {deafened && (
        <span
          title="Deafened"
          aria-label="Deafened"
          role="img"
          className="flex shrink-0 text-mute-fg"
        >
          <HeadphoneOff size={14} />
        </span>
      )}
    </div>
  )
}

export function P2pVoiceRow({
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
  const here = useP2p(s => s.voice?.room === v.id && s.voice.ch === c.id)
  const instance = useStore(s => s.voice !== null || s.call !== null)
  const connected = here && !instance
  const users = v.voice[c.id] ?? NONE
  const count = users.length
  return (
    <div className="flex flex-col rounded-lg">
      <button
        data-p2p-voice-channel={c.name}
        title={connected ? 'Open voice channel' : 'Join voice channel'}
        aria-label={`${connected ? 'Open' : 'Join'} voice channel ${c.name}${
          count ? `, ${count} connected` : ''
        }`}
        onClick={() => {
          p2pServer.openChannel(c.id)
          if (!connected) void p2pVoice.join(v.id, c.id)
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
            className="ml-auto shrink-0 rounded-full bg-surface-container-highest px-1.5 text-[11px] leading-4 font-medium text-on-surface-variant tabular-nums"
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
